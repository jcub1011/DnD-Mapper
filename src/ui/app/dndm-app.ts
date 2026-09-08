/*
 * Root application shell for D&D Mapper. A pure VIEW over the replicated match
 * state: it renders what the authority published and turns clicks into intents.
 * It never computes game state — that lives in src/authority/, which the server runs.
 *
 * The controller is built by main.ts (synchronously, right after the Phaser game
 * and its KnockBox plugin exist) and handed in, so there is no boot-ordering race
 * between the plugin firing `ready` and this element subscribing.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { KBPlayer } from "../../../addons/knockbox/knockbox-phaser";
import { createDefaultDndMapperState } from "../../game/domain";
import type { MatchState } from "../../game/types";
import { createLogger } from "../../log";
import type { GameController } from "../../net/controller";
import type { LaunchMode } from "../../net/launch";
import { GameElement } from "./GameElement";

const log = createLogger("app");

/** Largest dt we feed the presentation loop (guards against tab-backgrounding spikes). */
const MAX_DT = 1 / 20;

const EMPTY: MatchState = createDefaultDndMapperState();

@customElement("dndm-app")
export class DndmApp extends GameElement {
  /** Set by main.ts before the element does anything meaningful. */
  launchMode: LaunchMode = "solo";

  private controller?: GameController;
  private rafId = 0;
  private lastTs = 0;

  @state() private match: Readonly<MatchState> = EMPTY;
  @state() private roster: readonly KBPlayer[] = [];
  @state() private isOwner = false;
  @state() private lobbyOpen = true;

  /** Attach the controller main.ts built. Safe to call once. */
  attach(controller: GameController): void {
    this.controller = controller;
    this.match = controller.view.state;
    this.isOwner = controller.isOwner;

    this.listen(controller.events, "changed", ({ state }) => {
      this.onStateChanged(state);
    });
    this.listen(controller.events, "roster", ({ players, isOwner }) => {
      this.roster = players;
      this.isOwner = isOwner;
    });

    this.lastTs = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
    log.info(`controller attached (launch=${this.launchMode})`);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.rafId);
    this.controller?.destroy();
  }

  private onStateChanged(state: Readonly<MatchState>): void {
    this.match = state;
  }

  /*
   * The presentation loop. It does NOT advance the simulation — the server owns
   * the sim clock (an authority module opts into one by exporting `tick`). This is
   * where per-frame FX and interpolation between authoritative snapshots go.
   */
  private readonly frame = (ts: number): void => {
    const dt = Math.min((ts - this.lastTs) / 1000, MAX_DT);
    this.lastTs = ts;
    this.advancePresentation(dt);
    this.rafId = requestAnimationFrame(this.frame);
  };

  /**
   * Per-frame PRESENTATION hook.
   */
  private advancePresentation(_dt: number): void {}

  private send(intent: Parameters<GameController["sendIntent"]>[0]): void {
    this.controller?.sendIntent(intent);
  }

  /** Owner-only control. Note it gates on isOwner, NEVER on isHost — in server
   *  mode isHost is false for everyone, including the lobby creator. */
  private toggleLobby(): void {
    this.lobbyOpen = !this.lobbyOpen;
    this.controller?.setLobbyOpen(this.lobbyOpen);
  }

  override render(): TemplateResult {
    const { phase, maps, activeMapId, dmPlayerId } = this.match;
    const me = this.controller?.playerId ?? "";
    const activeMap = maps.find((m) => m.id === activeMapId);
    const isDm = Boolean(me && dmPlayerId === me);

    return html`
      <main class="dndm-shell">
        <h1>D&D Mapper</h1>
        <p class="dndm-sub">
          launch: <strong>${this.launchMode}</strong> · phase: ${phase} · ${this.roster.length}
          player${this.roster.length === 1 ? "" : "s"}
          ${isDm ? html` · <strong>DM</strong>` : nothing}
          ${this.isOwner && !isDm ? html` · <strong>Owner</strong>` : nothing}
        </p>

        <p class="dndm-sub">
          Active Map: <strong>${activeMap?.name ?? "None"}</strong> (${maps.length} total)
        </p>

        <ul class="dndm-scores">
          ${this.roster.map(
            (p) => html`
              <li class=${p.id === me ? "is-me" : ""}>
                ${p.displayName}${p.id === me ? " (you)" : ""}${p.id === dmPlayerId ? " [DM]" : ""}
              </li>
            `,
          )}
          ${this.roster.length === 0 ? html`<li>waiting for players…</li>` : nothing}
        </ul>

        ${
          isDm && maps.length === 0
            ? html`<button @click=${() => this.send({ kind: "createMap", name: "First Map" })}>
                Create First Map
              </button>`
            : nothing
        }
        ${
          this.isOwner
            ? html`
                <p>
                  <button @click=${() => this.toggleLobby()}>
                    ${this.lobbyOpen ? "Close lobby" : "Open lobby"}
                  </button>
                </p>
              `
            : nothing
        }
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-app": DndmApp;
  }
}
