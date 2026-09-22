import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameMap, Token } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import { eyeIcon, glyphIcon, trashIcon } from "../icons";
import "../modals/dndm-confirm";
import "../shared/dndm-rail-menu";
import "./dndm-collapsible-panel";

@customElement("dndm-token-panel")
export class DndmTokenPanel extends GameElement {
  @property({ attribute: false })
  activeMap: GameMap | null = null;

  @property({ type: Boolean })
  isDm = false;

  @property({ attribute: false })
  roster: readonly { id: string; name: string }[] = [];

  @property({ type: String })
  dmPlayerId: string | null = null;

  @property({ attribute: false })
  onCenterOnToken?: (x: number, y: number) => void;

  @property({ attribute: false })
  onToggleIcon?: (tokenId: string, iconKind: "Initial" | "Solid") => void;

  @property({ attribute: false })
  onToggleHidden?: (tokenId: string, hidden: boolean) => void;

  @property({ attribute: false })
  onDeleteToken?: (tokenId: string) => void;

  @property({ attribute: false })
  onReassignOwner?: (tokenId: string, newOwnerUserId: string | null) => void;

  @state() private pendingDeleteToken: Token | null = null;

  private handleDoubleClick(t: Token): void {
    this.dispatchEvent(
      new CustomEvent<{ x: number; y: number }>("center-token", {
        bubbles: true,
        composed: true,
        detail: { x: t.x, y: t.y },
      }),
    );
    this.onCenterOnToken?.(t.x, t.y);
  }

  private toggleIcon(t: Token, e: Event): void {
    e.stopPropagation();
    const nextKind = t.iconKind === "Initial" ? "Solid" : "Initial";
    this.dispatchEvent(
      new CustomEvent<{ tokenId: string; iconKind: "Initial" | "Solid" }>("toggle-icon", {
        bubbles: true,
        composed: true,
        detail: { tokenId: t.id, iconKind: nextKind },
      }),
    );
    this.onToggleIcon?.(t.id, nextKind);
  }

  private toggleHidden(t: Token, e: Event): void {
    e.stopPropagation();
    const nextHidden = !t.hidden;
    this.dispatchEvent(
      new CustomEvent<{ tokenId: string; hidden: boolean }>("toggle-token-hidden", {
        bubbles: true,
        composed: true,
        detail: { tokenId: t.id, hidden: nextHidden },
      }),
    );
    this.onToggleHidden?.(t.id, nextHidden);
  }

  private handleDeleteRequest(t: Token, e: Event): void {
    e.stopPropagation();
    this.pendingDeleteToken = t;
  }

  private confirmDelete(): void {
    if (!this.pendingDeleteToken) return;
    const id = this.pendingDeleteToken.id;
    this.pendingDeleteToken = null;
    this.dispatchEvent(
      new CustomEvent<string>("delete-token", {
        bubbles: true,
        composed: true,
        detail: id,
      }),
    );
    this.onDeleteToken?.(id);
  }

  private handleReassignOwner(tokenId: string, newOwnerUserId: string | null): void {
    this.dispatchEvent(
      new CustomEvent<{ tokenId: string; newOwnerUserId: string | null }>("reassign-token-owner", {
        bubbles: true,
        composed: true,
        detail: { tokenId, newOwnerUserId },
      }),
    );
    this.onReassignOwner?.(tokenId, newOwnerUserId);
  }

  override render(): TemplateResult {
    const tokens = this.activeMap?.tokens ?? [];
    // The host is not a player, so it is never an assignable owner. Name
    // lookups below intentionally keep the full roster for legacy tokens.
    const assignableRoster =
      this.dmPlayerId === null ? this.roster : this.roster.filter((p) => p.id !== this.dmPlayerId);

    return html`
      <dndm-collapsible-panel
        panelTitle="Tokens"
        panelClass="dndm-tokenp"
        .content=${!this.activeMap
          ? html`<div class="dndm-panel-empty">No active map.</div>`
          : tokens.length === 0
            ? html`<div class="dndm-panel-empty">No tokens on this map.</div>`
            : tokens.map((t) => {
                const isPlayer = t.type === "PlayerToken";
                const repPlayer = t.representsUserId ? this.roster.find((p) => p.id === t.representsUserId) : null;
                const repName = repPlayer ? repPlayer.name : t.representsUserId;
                return html`
                  <div
                    class="dndm-tokenp-row"
                    title="Double-click to center the canvas on this token"
                    @dblclick=${() => this.handleDoubleClick(t)}
                  >
                    <span
                      class="dndm-tokenp-dot"
                      style="background: ${t.color};"
                      aria-hidden="true"
                    ></span>
                    <div style="flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column;">
                      <span class="dndm-tokenp-name">${t.name}</span>
                      ${t.representsUserId
                        ? html`<span
                            class="dndm-tokenp-subtitle"
                            style="font-size: 0.72rem; color: var(--dndm-text-muted); font-style: italic;"
                          >
                            (originally played by ${repName})
                          </span>`
                        : nothing}
                    </div>
                    <span class="dndm-tokenp-tag">${isPlayer ? "Player" : "NPC"}</span>
                    ${this.isDm && t.ownerUserId === null
                      ? html`
                          <select
                            class="dndm-select dndm-select--small"
                            style="font-size: 0.75rem; padding: 1px 4px; max-width: 90px;"
                            title="Assign Owner"
                            @click=${(e: Event) => e.stopPropagation()}
                            @change=${(e: Event) => {
                              e.stopPropagation();
                              const val = (e.target as HTMLSelectElement).value;
                              this.handleReassignOwner(t.id, val || null);
                            }}
                          >
                            <option value="">Assign...</option>
                            ${assignableRoster.map(
                              (p) => html`<option value=${p.id}>${p.name}</option>`,
                            )}
                          </select>
                        `
                      : nothing}
                    <dndm-rail-menu
                      menuTitle="Token actions"
                      .actions=${() => html`
                        <button
                          class="dndm-btn dndm-btn--small dndm-btn--icon"
                          type="button"
                          title=${t.iconKind === "Initial"
                            ? "Initial shown — click for solid circle"
                            : "Solid circle — click to show initial"}
                          @click=${(e: Event) => this.toggleIcon(t, e)}
                        >
                          ${glyphIcon(t.iconKind === "Initial")}
                        </button>
                        <button
                          class="dndm-btn dndm-btn--small dndm-btn--icon"
                          type="button"
                          title=${t.hidden ? "Hidden — click to reveal" : "Visible — click to hide"}
                          @click=${(e: Event) => this.toggleHidden(t, e)}
                        >
                          ${eyeIcon(!t.hidden)}
                        </button>
                        <button
                          class="dndm-btn dndm-btn--icon dndm-btn--small dndm-btn--danger"
                          type="button"
                          title="Delete token from map"
                          @click=${(e: Event) => this.handleDeleteRequest(t, e)}
                        >
                          ${trashIcon()}
                        </button>
                      `}
                    ></dndm-rail-menu>
                  </div>
                `;
              })}
      ></dndm-collapsible-panel>

      <dndm-confirm
        ?isOpen=${this.pendingDeleteToken !== null}
        modalTitle="Delete token?"
        message=${`This removes "${this.pendingDeleteToken?.name}" from the map. Its linked character sheet will also be deleted.`}
        confirmText="Delete"
        .onConfirm=${() => this.confirmDelete()}
        .onCancel=${() => {
          this.pendingDeleteToken = null;
        }}
        .onClose=${() => {
          this.pendingDeleteToken = null;
        }}
        @cancel=${() => {
          this.pendingDeleteToken = null;
        }}
        @close=${() => {
          this.pendingDeleteToken = null;
        }}
      ></dndm-confirm>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-token-panel": DndmTokenPanel;
  }
}
