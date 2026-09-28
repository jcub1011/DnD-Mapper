import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { isFullMap, type FocusRect, type GameMap } from "../../game/domain";
import type { DiceColorRosterEntry } from "../../game/color";
import { getReadableTextColor, resolveDiceColor, resolveDiceColorForToken } from "../../game/color";
import { resolveActiveTurnTokenId } from "../../game/combat";
import type { MatchState } from "../../game/types";
import { createLogger } from "../../log";
import { GameElement } from "../app/GameElement";
import { diceAnimationTracker } from "../dice/diceAnimationTracker";
import { diceOverlay } from "../dice/diceOverlay";
import { fx } from "../fx/fx";
import { rollLogIcon } from "../icons";
import type { MapScene } from "../map/MapScene";
import { filterDisplayImages, filterDisplayTokens } from "./displayProjection";
import {
  DISPLAY_CHANNEL,
  DISPLAY_HEARTBEAT_MS,
  ProxyAssetSource,
  asDisplayMessage,
  type DisplayPopupMessage,
} from "./displayPopout";
import {
  loadDisplaySettings,
  saveDisplaySettings,
  type DisplayFraming,
  type DisplaySettings,
} from "./displaySettings";
import { displayableRolls } from "./dndm-display-roll-history";

const log = createLogger("display");

type Status = "waiting" | "live" | "no-opener" | "disconnected";

/** Pointer distance (px) from the bottom edge that reveals the settings bar. */
const BAR_REVEAL_PX = 96;
/** Pointer distance (px) from the top-left corner that reveals the roll toggle. */
const CORNER_REVEAL_PX = 120;
/** Roll history panel width (px), capped to a share of narrow windows. */
const ROLL_PANEL_PX = 440;
const ROLL_PANEL_MAX_FRACTION = 0.4;

/**
 * Projector display popout window view (`?view=display`).
 *
 * Boots with the Phaser map but no network (see main.ts) and renders the
 * active map as the DM's window pushes it: player projection only, pitch-black
 * fog, auto-framed to the DM's focus rect (or the whole map). The only chrome
 * is a hover-revealed settings bar (bottom) and roll-history toggle (top-left),
 * both local to this window. View-only — nothing here sends intents.
 */
@customElement("dndm-display-popout-view")
export class DndmDisplayPopoutView extends GameElement {
  @state() private match: MatchState | null = null;
  @state() private status: Status = "waiting";
  @state() private settings: DisplaySettings = loadDisplaySettings();
  @state() private revealBar = false;
  @state() private revealCorner = false;
  @state() private viewportWidth = window.innerWidth;

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
  private unsubscribeTracker: (() => void) | null = null;

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
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("mouseout", this.onMouseOut);
    this.unsubscribeTracker = diceAnimationTracker.subscribe(this.onRollsSettled);
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
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("mouseout", this.onMouseOut);
    this.unsubscribeTracker?.();
    this.unsubscribeTracker = null;
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
    this.viewportWidth = window.innerWidth;
    requestAnimationFrame(() => {
      this.applyViewSettings();
      this.applyFraming(0);
    });
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const bar =
      e.clientY >= window.innerHeight - BAR_REVEAL_PX || !!target?.closest(".dndm-display-bar");
    const corner =
      (e.clientX <= CORNER_REVEAL_PX && e.clientY <= CORNER_REVEAL_PX) ||
      !!target?.closest(".dndm-display-corner");
    if (bar !== this.revealBar) this.revealBar = bar;
    if (corner !== this.revealCorner) this.revealCorner = corner;
  };

  /** A roll settling can reveal the roll panel, which re-frames the map. */
  private readonly onRollsSettled = (): void => {
    this.requestUpdate();
    this.applyViewSettings();
    this.applyFraming(400);
  };

  /** A null relatedTarget means the pointer left the window entirely. */
  private readonly onMouseOut = (e: MouseEvent): void => {
    if (e.relatedTarget) return;
    this.revealBar = false;
    this.revealCorner = false;
  };

  private updateSettings(patch: Partial<DisplaySettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveDisplaySettings(this.settings);
    this.applyViewSettings();
    this.applyFraming(400);
  }

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
    map.setViewOnly(true);
    map.setViewerUserId(null);
    map.setAssetSource(this.assets);
    if (this.match) this.applyToMap(this.match);
    else this.applyViewSettings();
  }

  private activeMap(state: MatchState): GameMap | null {
    if (!state.activeMapId) return null;
    const found = state.maps.find((m) => m.id === state.activeMapId);
    return found && isFullMap(found) ? found : null;
  }

  /** The DM's focus rect, if it belongs to the active map. */
  private focusFor(state: MatchState, active: GameMap): FocusRect | null {
    return state.focusRect?.mapId === active.id ? state.focusRect : null;
  }

  /** Width the roll history panel takes from the left edge (0 when closed or empty). */
  private rollPanelWidth(): number {
    if (!this.settings.showRollHistory || displayableRolls(this.match).length === 0) return 0;
    return Math.round(Math.min(ROLL_PANEL_PX, this.viewportWidth * ROLL_PANEL_MAX_FRACTION));
  }

  /** Push the window-local settings that live on the MapScene. */
  private applyViewSettings(): void {
    const map = this.wiredMap;
    if (!map) return;
    const state = this.match;
    const active = state ? this.activeMap(state) : null;
    const focus = state && active ? this.focusFor(state, active) : null;
    // Frame into the area right of the roll panel so it never covers the focus box.
    map.setRailInsets(this.rollPanelWidth(), 0);
    map.setGridSuppressed(!this.settings.showGrid);
    map.setOutsideMask(this.settings.hideOutsideFocus ? focus : null);
    // The DM's focus box drives the camera; manual navigation would fight it.
    map.setNavigationLocked(focus !== null);
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
    this.applyViewSettings();
    this.applyFraming(400);
  }

  /** Fit the DM's focus rect, else the whole map — only when the target moves. */
  private applyFraming(duration: number): void {
    const map = this.wiredMap;
    const state = this.match;
    const active = state ? this.activeMap(state) : null;
    if (!map || !state || !active) return;
    const focus = this.focusFor(state, active);
    const box = focus ?? {
      x: 0,
      y: 0,
      width: active.grid.widthCells,
      height: active.grid.heightCells,
    };
    const mode = this.settings.framing;
    const inset = this.rollPanelWidth();
    const key = `${active.id}:${box.x},${box.y},${box.width},${box.height}:${mode}:${inset}`;
    if (key === this.frameKey) return;
    this.frameKey = key;
    map.frameBox(box, duration, mode);
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

  private renderFramingButton(mode: DisplayFraming, label: string, title: string): TemplateResult {
    return html`<button
      type="button"
      class=${this.settings.framing === mode ? "active" : ""}
      title=${title}
      @click=${() => this.updateSettings({ framing: mode })}
    >
      ${label}
    </button>`;
  }

  private renderToggle(
    key: "hideOutsideFocus" | "showWithoutFocus" | "showGrid",
    label: string,
    title: string,
    disabled = false,
  ): TemplateResult {
    return html`<label class="dndm-toggle ${disabled ? "is-disabled" : ""}" title=${title}>
      <input
        type="checkbox"
        data-setting=${key}
        ?checked=${this.settings[key]}
        ?disabled=${disabled}
        @change=${(e: Event) =>
          this.updateSettings({ [key]: (e.target as HTMLInputElement).checked })}
      />
      <span class="dndm-toggle-track"></span>
      <span>${label}</span>
    </label>`;
  }

  private renderSettingsBar(hasFocus: boolean): TemplateResult {
    return html`<div
      class="dndm-display-bar ${this.revealBar ? "is-visible" : ""}"
      role="toolbar"
      aria-label="Projector settings"
    >
      ${this.renderToggle(
        "hideOutsideFocus",
        hasFocus ? "Hide outside focus box" : "Hide outside focus box (needs a focus box)",
        "Black out everything outside the DM's focus box",
        !hasFocus,
      )}
      ${this.renderToggle(
        "showWithoutFocus",
        "Show map without focus box",
        "When off, the screen stays black until the DM sets a focus box",
      )}
      <div class="dndm-pillgroup" role="group" aria-label="Framing">
        ${this.renderFramingButton("fit", "Fit", "Show the whole focus box (or map)")}
        ${this.renderFramingButton("fill", "Fill", "Fill the window, cropping the focus box (or map)")}
      </div>
      ${this.renderToggle("showGrid", "Show grid", "Show grid lines on this display")}
    </div>`;
  }

  private renderCorner(): TemplateResult {
    const shown = this.settings.showRollHistory;
    return html`<div class="dndm-display-corner ${this.revealCorner ? "is-visible" : ""}">
      <button
        type="button"
        class="dndm-btn"
        aria-pressed=${shown ? "true" : "false"}
        title=${shown ? "Hide roll history" : "Show roll history"}
        @click=${() => this.updateSettings({ showRollHistory: !shown })}
      >
        ${rollLogIcon()} ${shown ? "Hide rolls" : "Show rolls"}
      </button>
    </div>`;
  }

  override render(): TemplateResult {
    const state = this.match;
    const active = state ? this.activeMap(state) : null;
    const focus = state && active ? this.focusFor(state, active) : null;
    const status = this.statusText();
    const blank = active !== null && focus === null && !this.settings.showWithoutFocus;
    const panelWidth = this.rollPanelWidth();
    return html`
      <div class="dndm-display-view" style="--dndm-rail-pad-left: ${panelWidth}px">
        ${blank ? html`<div class="dndm-display-blank">No focus box set...</div>` : nothing}
        <div class="dndm-dice-canvas-overlay" id="dndm-dice-overlay"></div>
        ${status ? html`<div class="dndm-display-status">${status}</div>` : nothing}
        ${
          panelWidth > 0
            ? html`<dndm-display-roll-history
                .state=${state}
                .widthPx=${panelWidth}
              ></dndm-display-roll-history>`
            : nothing
        }
        ${this.renderCorner()} ${this.renderSettingsBar(focus !== null)}
      </div>
    `;
  }
}
