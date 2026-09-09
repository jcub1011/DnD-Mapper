import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { isNatural1, isNatural20 } from "../../game/dice.js";
import type { DndMapperState, RollMode, RollResult } from "../../game/domain.js";
import { GameElement } from "../app/GameElement.js";
import { diceAnimationTracker } from "../dice/diceAnimationTracker.js";

@customElement("dndm-roll-log")
export class DndmRollLog extends GameElement {
  @property({ attribute: false })
  state!: DndMapperState;

  @property({ type: Boolean })
  isDm = false;

  @property({ type: String })
  currentUserId: string | null = null;

  @property({ attribute: false })
  onClearLog?: () => void;

  @property({ attribute: false })
  onReRoll?: (roll: RollResult, modeOverride?: RollMode) => void;

  @property({ attribute: false })
  onOpenHistory?: () => void;

  private unsubscribeTracker: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeTracker = diceAnimationTracker.subscribe(() => {
      this.requestUpdate();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeTracker?.();
    this.unsubscribeTracker = null;
  }

  private get visibleRolls(): readonly RollResult[] {
    const log = this.state.rollLog ?? [];
    const visible = this.isDm || this.state.settings.rollsVisibleToPlayers
      ? log
      : log.filter((r) => r.rollerUserId === this.currentUserId);

    // Spoiler gating: rolls currently tumbling in 3D are hidden until settled
    return visible.filter((r) => !diceAnimationTracker.isAnimating(r.id));
  }

  private getRollerName(roll: RollResult): string {
    if (roll.tokenId) {
      for (const map of this.state.maps) {
        if ("tokens" in map) {
          const token = map.tokens.find((t) => t.id === roll.tokenId);
          if (token) return token.name;
        }
      }
    }

    if (this.state.dmPlayerId === roll.rollerUserId) {
      return "DM";
    }

    for (const sheet of Object.values(this.state.sheets)) {
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

  override render(): TemplateResult {
    const rolls = this.visibleRolls;

    return html`
      <section class="dndm-panel dndm-rolllog">
        <header class="dndm-panel-header dndm-rolllog-header">
          <span>Roll Log (${rolls.length})</span>
          <div class="dndm-rolllog-actions">
            ${this.isDm
              ? html`
                  <button
                    class="dndm-btn dndm-btn--small dndm-btn--danger"
                    type="button"
                    title="Clear roll log for all players"
                    @click=${() => this.onClearLog?.()}
                  >
                    Clear
                  </button>
                `
              : nothing}
            <button
              class="dndm-btn dndm-btn--small dndm-btn--ghost"
              type="button"
              title="See complete roll history"
              @click=${() => this.onOpenHistory?.()}
            >
              All
            </button>
          </div>
        </header>

        <div class="dndm-panel-body">
          ${rolls.length === 0
            ? html`<div class="dndm-panel-empty">No rolls recorded yet.</div>`
            : html`
                <div class="dndm-rolllog-entries">
                  ${[...rolls].reverse().map((r) => this.renderEntry(r))}
                </div>
              `}
        </div>
      </section>
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
          ${r.mode !== "Normal"
            ? html`<span class="dndm-rolllog-mode">${r.mode === "Advantage" ? "ADV" : "DIS"}</span>`
            : nothing}
          <time class="dndm-rolllog-time" title=${r.timestampUtc}>
            ${r.timestampUtc.slice(11, 19)}
          </time>
          ${canReRoll
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
            : nothing}
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
            ${r.flatModifier !== 0 || r.attributeModifier !== 0
              ? html`
                  <span class="dndm-rolllog-mod">
                    ${this.formatMod(r.flatModifier + r.attributeModifier)}
                  </span>
                `
              : nothing}
          </div>
        </div>

        ${r.modifierBreakdown
          ? html`<div class="dndm-rolllog-breakdown">${r.modifierBreakdown}</div>`
          : nothing}
      </article>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-roll-log": DndmRollLog;
  }
}
