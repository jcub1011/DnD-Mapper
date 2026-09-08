import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameMap, Token } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import { eyeIcon, glyphIcon, trashIcon } from "../icons";
import "../modals/dndm-confirm";
import "../shared/dndm-rail-menu";

@customElement("dndm-token-panel")
export class DndmTokenPanel extends GameElement {
  @property({ attribute: false })
  activeMap: GameMap | null = null;

  @property({ attribute: false })
  onCenterOnToken?: (x: number, y: number) => void;

  @property({ attribute: false })
  onToggleIcon?: (tokenId: string, iconKind: "Initial" | "Solid") => void;

  @property({ attribute: false })
  onToggleHidden?: (tokenId: string, hidden: boolean) => void;

  @property({ attribute: false })
  onDeleteToken?: (tokenId: string) => void;

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

  override render(): TemplateResult {
    const tokens = this.activeMap?.tokens ?? [];

    return html`
      <section class="dndm-panel dndm-tokenp">
        <header class="dndm-panel-header">
          <span>Tokens</span>
        </header>
        <div class="dndm-panel-body">
          ${!this.activeMap
            ? html`<div class="dndm-panel-empty">No active map.</div>`
            : tokens.length === 0
              ? html`<div class="dndm-panel-empty">No tokens on this map.</div>`
              : tokens.map((t) => {
                  const isPlayer = t.type === "PlayerToken";
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
                      <span class="dndm-tokenp-name">${t.name}</span>
                      <span class="dndm-tokenp-tag">${isPlayer ? "Player" : "NPC"}</span>
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
                            class="dndm-btn dndm-btn--small dndm-btn--icon dndm-btn--danger"
                            type="button"
                            title="Delete token"
                            ?disabled=${isPlayer}
                            @click=${(e: Event) => this.handleDeleteRequest(t, e)}
                          >
                            ${trashIcon()}
                          </button>
                        `}
                      ></dndm-rail-menu>
                    </div>
                  `;
                })}
        </div>
      </section>

      <dndm-confirm
        ?isOpen=${this.pendingDeleteToken !== null}
        modalTitle="Delete token?"
        message=${`This removes "${this.pendingDeleteToken?.name}" from the map.`}
        confirmText="Delete"
        .onConfirm=${() => this.confirmDelete()}
        .onCancel=${() => {
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
