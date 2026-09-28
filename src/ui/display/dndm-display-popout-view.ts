import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { isFullMap, type GameMap } from "../../game/domain";
import type { DiceColorRosterEntry } from "../../game/color";
import { getReadableTextColor, resolveDiceColor, resolveDiceColorForToken } from "../../game/color";
import { resolveActiveTurnTokenId } from "../../game/combat";
import type { MatchState } from "../../game/types";
import { createLogger } from "../../log";
import { GameElement } from "../app/GameElement";
import { diceOverlay } from "../dice/diceOverlay";
import { fx } from "../fx/fx";
import type { MapScene } from "../map/MapScene";
import { filterDisplayImages, filterDisplayTokens } from "./displayProjection";
import {
  DISPLAY_CHANNEL,
  DISPLAY_HEARTBEAT_MS,
  ProxyAssetSource,
  asDisplayMessage,
  type DisplayPopupMessage,
} from "./displayPopout";
import "./dndm-display-roll-ticker";

const log = createLogger("display");

type Status = "waiting" | "live" | "no-opener" | "disconnected";

/**
 * Projector display popout window view (`?view=display`).
 *
 * Boots with the Phaser map but no network (see main.ts) and renders the
 * active map as the DM's window pushes it: player projection only, pitch-black
 * fog, no UI chrome, auto-framed to the DM's focus rect (or the whole map).
 * View-only — nothing here sends intents.
 */
@customElement("dndm-display-popout-view")
export class DndmDisplayPopoutView extends GameElement {
  @state() private match: MatchState | null = null;
  @state() private status: Status = "waiting";

  private roster: readonly DiceColorRosterEntry[] = [];
  private readonly assets = new ProxyAssetSource((imageId) =>
    this.post({ channel: DISPLAY_CHANNEL, type: "display-asset-request", imageId }),
  );
  private wiredMap: MapScene | null = null;
  private appliedMapId: string | null = null;
  private frameKey: string | null = null;
  private seenRollIds: Set<string> | null = null;
  private heartbeatId: number | null = null;
  private rafId = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    try {
      document.title = "D&D Mapper — Projector";
    } catch {
      // Non-DOM test host — title is cosmetic.
    }
    window.addEventListener("message", this.onMessage);
    window.addEventListener("beforeunload", this.onBeforeUnload);
    window.addEventListener("resize", this.onResize);
    if (!window.opener) {
      this.status = "no-opener";
      return;
    }
    this.post({ channel: DISPLAY_CHANNEL, type: "display-join", hasState: this.match !== null });
    this.heartbeatId = window.setInterval(this.heartbeat, DISPLAY_HEARTBEAT_MS);
    this.rafId = requestAnimationFrame(this.frame);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    window.removeEventListener("resize", this.onResize);
    if (this.heartbeatId !== null) window.clearInterval(this.heartbeatId);
    this.heartbeatId = null;
    cancelAnimationFrame(this.rafId);
    this.assets.dispose();
    diceOverlay.detach();
  }

  override updated(changed: Map<string, unknown>): void {
    super.updated(changed);
    const overlayEl = this.querySelector("#dndm-dice-overlay") as HTMLElement | null;
    if (overlayEl && overlayEl !== diceOverlay.getContainer()) {
      void diceOverlay.attach(overlayEl);
    }
  }

  private get opener(): Window | null {
    return (window.opener as Window | null) ?? null;
  }

  private post(msg: DisplayPopupMessage): void {
    const opener = this.opener;
    if (!opener || opener.closed) return;
    try {
      opener.postMessage(msg, window.location.origin);
    } catch {
      // Opener torn down mid-post — the heartbeat reports it.
    }
  }

  /** Re-join every beat: a DM window that reloaded adopts us again. */
  private readonly heartbeat = (): void => {
    const opener = this.opener;
    if (!opener || opener.closed) {
      this.status = "disconnected";
      return;
    }
    this.post({ channel: DISPLAY_CHANNEL, type: "display-join", hasState: this.match !== null });
  };

  private readonly onBeforeUnload = (): void => {
    this.post({ channel: DISPLAY_CHANNEL, type: "display-leave" });
  };

  private readonly onResize = (): void => {
    // Phaser resizes the canvas on its own; re-fit once it has.
    this.frameKey = null;
    requestAnimationFrame(() => this.applyFraming(0));
  };

  /** Phaser boots asynchronously — wire the MapScene once it exists. */
  private readonly frame = (): void => {
    this.rafId = requestAnimationFrame(this.frame);
    this.wireMap();
  };

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin) return;
    if (event.source !== this.opener) return;
    const msg = asDisplayMessage(event.data);
    if (!msg) return;
    if (msg.type === "display-state") {
      this.roster = msg.roster;
      this.status = "live";
      this.applyState(msg.state);
    } else if (msg.type === "display-asset") {
      this.assets.receive(msg.imageId, msg.blob);
    }
  };

  private wireMap(): void {
    const map = fx.map();
    if (!map || map === this.wiredMap) return;
    this.wiredMap = map;
    this.appliedMapId = null;
    this.frameKey = null;
    map.setDm(false);
    map.setProjectorMode(true);
    map.setTokenMovePolicy(() => false);
    map.setRailInsets(0, 0);
    map.setViewerUserId(null);
    map.setAssetSource(this.assets);
    if (this.match) this.applyToMap(this.match);
  }

  private activeMap(state: MatchState): GameMap | null {
    if (!state.activeMapId) return null;
    const found = state.maps.find((m) => m.id === state.activeMapId);
    return found && isFullMap(found) ? found : null;
  }

  private applyState(state: MatchState): void {
    this.match = state;
    this.wireMap();
    this.applyToMap(state);
    this.animateNewRolls(state);
  }

  private applyToMap(state: MatchState): void {
    const map = this.wiredMap;
    const active = this.activeMap(state);
    if (!map || !active) return;

    // The pushed state is already the player projection; the display filters
    // add fog culling for images and are a second line of defense.
    const tokens = filterDisplayTokens(active.tokens, active.fogMask, active.grid);
    const images = filterDisplayImages(active.images, active.fogMask, active.grid);
    if (this.appliedMapId !== active.id) {
      this.appliedMapId = active.id;
      this.frameKey = null;
      map.setMap({ ...active, tokens, images }, false, this.assets);
    } else {
      map.updateGrid(active.grid);
      map.updateTokens(tokens);
      map.updateImages(images);
      // Always apply — an empty mask is a real state (all revealed).
      map.updateFog(active.fogMask ?? "");
      map.updateMarkup(active.markupSvg ?? null);
    }
    map.updateSheets(state.sheets);
    map.setActiveTurnTokenId(resolveActiveTurnTokenId(state.activeCombat));
    this.applyFraming(400);
  }

  /** Fit the DM's focus rect, else the whole map — only when the target moves. */
  private applyFraming(duration: number): void {
    const map = this.wiredMap;
    const state = this.match;
    const active = state ? this.activeMap(state) : null;
    if (!map || !state || !active) return;
    const focus = state.focusRect?.mapId === active.id ? state.focusRect : null;
    const box = focus ?? {
      x: 0,
      y: 0,
      width: active.grid.widthCells,
      height: active.grid.heightCells,
    };
    const key = `${active.id}:${box.x},${box.y},${box.width},${box.height}`;
    if (key === this.frameKey) return;
    this.frameKey = key;
    map.frameBox(box, duration);
  }

  private animateNewRolls(state: MatchState): void {
    const rolls = state.rollLog ?? [];
    // First state: history is already settled — only animate what comes after.
    if (!this.seenRollIds) {
      this.seenRollIds = new Set(rolls.map((r) => r.id));
      return;
    }
    for (const roll of rolls) {
      if (this.seenRollIds.has(roll.id)) continue;
      this.seenRollIds.add(roll.id);
      const diceColor = roll.tokenId
        ? resolveDiceColorForToken(state, roll.tokenId)
        : resolveDiceColor(state, roll.rollerUserId, this.roster);
      diceOverlay.roll(roll, diceColor, getReadableTextColor(diceColor)).catch((err) => {
        log.warn("Dice roll animation error:", err);
      });
    }
    if (this.seenRollIds.size > 200) {
      this.seenRollIds = new Set(rolls.map((r) => r.id));
    }
  }

  private statusText(): string | null {
    switch (this.status) {
      case "no-opener":
        return "Open the projector from the DM's window (Session → Popout).";
      case "disconnected":
        return "The DM window was closed. You can close this window.";
      case "waiting":
        return "Waiting for the DM window…";
      case "live":
        return this.match && !this.activeMap(this.match) ? "No map is open." : null;
    }
  }

  override render(): TemplateResult {
    const state = this.match;
    const active = state ? this.activeMap(state) : null;
    const status = this.statusText();
    return html`
      <div class="dndm-display-view">
        <div class="dndm-dice-canvas-overlay" id="dndm-dice-overlay"></div>
        ${status ? html`<div class="dndm-display-status">${status}</div>` : nothing}
        ${
          state
            ? html`<dndm-display-roll-ticker
                .rolls=${state.rollLog ?? []}
                .tokens=${active?.tokens ?? []}
                .isDm=${false}
                .currentUserId=${null}
                .rollsVisibleToPlayers=${state.settings.rollsVisibleToPlayers}
              ></dndm-display-roll-ticker>`
            : nothing
        }
      </div>
    `;
  }
}
