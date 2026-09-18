import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { isNatural1, isNatural20 } from "../../game/dice.js";
import type { DndMapperState, RollMode, RollResult } from "../../game/domain.js";
import { GameElement } from "../app/GameElement.js";
import "./dndm-modal.js";

@customElement("dndm-roll-history")
export class DndmRollHistory extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ attribute: false })
  state!: DndMapperState;

  @property({ type: Boolean })
  isDm = false;

  @property({ type: String })
  currentUserId: string | null = null;

  @property({ attribute: false })
  onReRoll?: (roll: RollResult, modeOverride?: RollMode) => void;

  @property({ attribute: false })
  onClose?: () => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @state() private searchQuery = "";
  @state() private filterMode: "all" | "mine" = "all";

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;
    if (e.key === "Escape") {
      this.handleClose();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleKeyDown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.handleKeyDown);
  }

  private handleClose = (): void => {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.onClose?.();
    this.onCancel?.();
  };

  private get visibleRolls(): readonly RollResult[] {
    const log = this.state?.rollLog ?? [];
    const visible =
      this.isDm || this.state?.settings?.rollsVisibleToPlayers
        ? log
        : log.filter((r) => r.rollerUserId === this.currentUserId);

    let filtered = visible;
    if (this.filterMode === "mine") {
      filtered = filtered.filter((r) => r.rollerUserId === this.currentUserId);
    }

    const query = this.searchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((r) => {
        const rollerName = this.getRollerName(r).toLowerCase();
        const formula = r.formula.toLowerCase();
        const label = (r.label || "").toLowerCase();
        return rollerName.includes(query) || formula.includes(query) || label.includes(query);
      });
    }

    return filtered;
  }

  private getRollerName(roll: RollResult): string {
    if (roll.tokenId) {
      for (const map of this.state?.maps ?? []) {
        if ("tokens" in map) {
          const token = map.tokens.find((t) => t.id === roll.tokenId);
          if (token) return token.name;
        }
      }
    }

    if (this.state?.dmPlayerId === roll.rollerUserId) {
      return "DM";
    }

    for (const sheet of Object.values(this.state?.sheets ?? {})) {
      if (sheet.ownerUserId === roll.rollerUserId) {
        return sheet.characterName || "Player";
      }
    }

    return "Player";
  }

  private handleReRoll(roll: RollResult, e: MouseEvent): void {
    let mode: RollMode = roll.mode;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      mode = "Advantage";
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      mode = "Disadvantage";
    }

    this.onReRoll?.(roll, mode);
  }

  private formatMod(mod: number): string {
    return mod >= 0 ? `+${mod}` : `${mod}`;
  }

  override render(): TemplateResult | typeof nothing {
    const rolls = this.visibleRolls;
    const totalCount = (this.state?.rollLog ?? []).length;

    return html`
      <dndm-modal
        class="dndm-roll-history-modal"
        cardClass="dndm-roll-history-modal"
        .isOpen=${this.isOpen}
        .modalTitle=${"Roll History"}
        @close=${this.handleClose}
        .body=${html`
          <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <div
              class="dndm-roll-history-search"
              style="display: flex; gap: 0.5rem; align-items: center;"
            >
              <input
                type="text"
                class="dndm-input"
                style="flex: 1;"
                placeholder="Search by roller, formula, or label..."
                .value=${this.searchQuery}
                @input=${(e: InputEvent) => {
                  this.searchQuery = (e.target as HTMLInputElement).value;
                }}
              />
              <div style="display: flex; gap: 0.25rem;">
                <button
                  class="dndm-btn dndm-btn--small ${this.filterMode === "all" ? "dndm-btn--primary" : "dndm-btn--ghost"}"
                  type="button"
                  @click=${() => {
                    this.filterMode = "all";
                  }}
                >
                  All
                </button>
                <button
                  class="dndm-btn dndm-btn--small ${this.filterMode === "mine" ? "dndm-btn--primary" : "dndm-btn--ghost"}"
                  type="button"
                  @click=${() => {
                    this.filterMode = "mine";
                  }}
                >
                  Mine
                </button>
              </div>
            </div>

            <div style="font-size: 0.8rem; color: var(--dndm-text-dim);">
              Showing ${rolls.length} of ${totalCount} recorded rolls
            </div>

            <div class="dndm-roll-history-list">
              ${
                rolls.length === 0
                  ? html`<div class="dndm-panel-empty" style="text-align: center; padding: 2rem 0;">
                      No rolls found matching your criteria.
                    </div>`
                  : html` ${[...rolls].reverse().map((r) => this.renderEntry(r))} `
              }
            </div>
          </div>
        `}
        .footer=${html`
          <button class="dndm-btn dndm-btn--ghost" type="button" @click=${this.handleClose}>
            Close
          </button>
        `}
      ></dndm-modal>
    `;
  }

  private renderEntry(r: RollResult): TemplateResult {
    const isNat20 = isNatural20(r);
    const isNat1 = isNatural1(r);
    const rollerName = this.getRollerName(r);
    const canReRoll = r.rollerUserId === this.currentUserId;

    return html`
      <article
        class="dndm-rolllog-entry ${isNat20 ? "dndm-rolllog-entry--nat20" : ""} ${isNat1 ? "dndm-rolllog-entry--nat1" : ""}"
      >
        <header class="dndm-rolllog-meta">
          <span class="dndm-rolllog-roller">${rollerName}</span>
          <span class="dndm-rolllog-formula">${r.formula}</span>
          <span class="dndm-rolllog-label">${r.label}</span>
          ${
            r.mode !== "Normal"
              ? html`<span class="dndm-rolllog-mode"
                  >${r.mode === "Advantage" ? "ADV" : "DIS"}</span
                >`
              : nothing
          }
          <time class="dndm-rolllog-time" title=${r.timestampUtc}>
            ${r.timestampUtc.slice(11, 19)}
          </time>
          ${
            canReRoll
              ? html`
                  <button
                    class="dndm-rolllog-reroll"
                    type="button"
                    title="Re-roll (Shift: Adv, Ctrl: Dis)"
                    @click=${(e: MouseEvent) => this.handleReRoll(r, e)}
                  >
                    ↻
                  </button>
                `
              : nothing
          }
        </header>

        <div class="dndm-rolllog-dice">
          <span class="dndm-rolllog-total"><strong>${r.total}</strong></span>
          <div class="dndm-rolllog-dice-detail">
            ${r.rolls.map(
              (d) => html`
                <span
                  class="dndm-die ${d.discarded ? "dndm-die--discarded" : ""}"
                  title="d${d.sides}: ${d.value}${d.discarded ? " (discarded)" : ""}"
                >
                  ${d.value}
                </span>
              `,
            )}
            ${
              r.flatModifier !== 0 || r.attributeModifier !== 0
                ? html`
                    <span class="dndm-rolllog-mod">
                      ${this.formatMod(r.flatModifier + r.attributeModifier)}
                    </span>
                  `
                : nothing
            }
          </div>
        </div>

        ${
          r.modifierBreakdown
            ? html`<div class="dndm-rolllog-breakdown">${r.modifierBreakdown}</div>`
            : nothing
        }
      </article>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-roll-history": DndmRollHistory;
  }
}
