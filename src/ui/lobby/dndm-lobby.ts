import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { KBPlayer } from "../../../addons/knockbox/knockbox-phaser";
import { DEFAULT_SETTINGS, type DndMapperSettings } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import "../modals/dndm-permissions";

@customElement("dndm-lobby")
export class DndmLobby extends GameElement {
  @property({ type: Boolean })
  isDm = false;

  @property({ type: Boolean })
  isOwner = false;

  @property({ attribute: false })
  roster: readonly KBPlayer[] = [];

  @property({ type: String })
  localPlayerId = "";

  @property({ type: String })
  dmPlayerId: string | null = null;

  @property({ attribute: false })
  settings: DndMapperSettings = DEFAULT_SETTINGS;

  @property({ type: Boolean })
  lobbyOpen = true;

  @property({ attribute: false })
  onStartSession?: () => void;

  @property({ attribute: false })
  onKickPlayer?: (playerId: string) => void;

  @property({ attribute: false })
  onToggleLobbyOpen?: () => void;

  @property({ attribute: false })
  onUpdateSettings?: (patch: Partial<DndMapperSettings>) => void;

  private handleKick(player: KBPlayer): void {
    if (!this.isOwner || player.id === this.localPlayerId) return;
    this.dispatchEvent(
      new CustomEvent<string>("kick-player", {
        bubbles: true,
        composed: true,
        detail: player.id,
      }),
    );
    this.onKickPlayer?.(player.id);
  }

  private handleStart(): void {
    this.dispatchEvent(new CustomEvent("start-session", { bubbles: true, composed: true }));
    this.onStartSession?.();
  }

  override render(): TemplateResult {
    return html`
      <div class="dndm-lobby-view">
        ${this.isDm
          ? html`
              <dndm-permissions
                .embedded=${true}
                .settings=${this.settings}
                .isDm=${this.isDm}
                .onUpdateSettings=${this.onUpdateSettings}
              ></dndm-permissions>
            `
          : nothing}

        <div class="card">
          <h4>Players (${this.roster.length})</h4>
          <div class="player-list">
            ${this.roster.map((p) => {
              const isMe = p.id === this.localPlayerId;
              const isDmPlayer = p.id === this.dmPlayerId;
              const canKick = this.isOwner && !isMe;

              if (canKick) {
                return html`
                  <button
                    type="button"
                    class="player-chip"
                    title="Click to kick player"
                    @click=${() => this.handleKick(p)}
                  >
                    ${p.displayName}${isDmPlayer ? " (DM)" : ""}${isMe ? " (You)" : ""}
                  </button>
                `;
              }

              return html`
                <span class="player-chip">
                  ${p.displayName}${isDmPlayer ? " (DM)" : ""}${isMe ? " (You)" : ""}
                </span>
              `;
            })}
            ${this.roster.length === 0
              ? html`<span class="dndm-text-muted">Waiting for players to join…</span>`
              : nothing}
          </div>

          <div style="margin-top: 1.25rem; display: flex; gap: 0.6rem; align-items: center;">
            ${this.isDm
              ? html`
                  <button
                    class="dndm-btn dndm-btn--primary"
                    type="button"
                    @click=${this.handleStart}
                  >
                    Start Session
                  </button>
                `
              : html`<span class="dndm-text-muted">Waiting for DM to start session…</span>`}
            ${this.isOwner
              ? html`
                  <button
                    class="dndm-btn dndm-btn--ghost"
                    type="button"
                    @click=${() => this.onToggleLobbyOpen?.()}
                  >
                    ${this.lobbyOpen ? "Close lobby" : "Open lobby"}
                  </button>
                `
              : nothing}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-lobby": DndmLobby;
  }
}
