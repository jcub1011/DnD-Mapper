import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type {
  CharacterSheet,
  CombatState,
  Token,
} from "../../game/domain.js";
import { GameElement } from "../app/GameElement.js";
import { diceAnimationTracker } from "../dice/diceAnimationTracker.js";

@customElement("dndm-initiative-banner")
export class DndmInitiativeBanner extends GameElement {
  @property({ attribute: false })
  combat: CombatState | null = null;

  @property({ type: String })
  currentUserId: string | null = null;

  @property({ type: Boolean })
  isDm = false;

  @property({ attribute: false })
  tokens: readonly Token[] = [];

  @property({ attribute: false })
  sheets: Readonly<Record<string, CharacterSheet>> = {};

  @property({ attribute: false })
  onRollInitiative?: (combatantId: string) => void;

  @property({ attribute: false })
  onFocusToken?: (tokenId: string) => void;

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

  override render(): TemplateResult {
    if (!this.combat) {
      return html`${nothing}`;
    }

    const { phase, roundNumber, currentTurnIndex, turnOrder } = this.combat;

    if (phase === "WaitingForRolls") {
      // Check if current user has an unrolled combatant
      const myUnrolled = turnOrder.find(
        (c) =>
          c.ownerUserId !== null &&
          c.ownerUserId === this.currentUserId &&
          c.initiativeRoll === null,
      );

      if (myUnrolled) {
        return html`
          <div class="dndm-initiative-banner dndm-initiative-banner--my-turn">
            <span><strong>Roll Initiative!</strong> (${myUnrolled.name})</span>
            <button
              type="button"
              class="dndm-btn dndm-btn--small dndm-btn--primary"
              @click=${() => this.onRollInitiative?.(myUnrolled.id)}
            >
              Roll
            </button>
          </div>
        `;
      }

      // Waiting for others
      return html`
        <div class="dndm-initiative-banner">
          <span>⚔️ Waiting for initiative rolls…</span>
        </div>
      `;
    }

    if (phase === "Active") {
      if (turnOrder.length === 0) return html`${nothing}`;

      const activeCombatant = turnOrder[currentTurnIndex];
      if (!activeCombatant) return html`${nothing}`;

      const isMyTurn =
        activeCombatant.ownerUserId !== null &&
        activeCombatant.ownerUserId === this.currentUserId;

      const nextCombatant = turnOrder[(currentTurnIndex + 1) % turnOrder.length];

      return html`
        <div
          class="dndm-initiative-banner ${isMyTurn ? "dndm-initiative-banner--my-turn" : ""}"
          @click=${() => this.onFocusToken?.(activeCombatant.tokenId)}
          style="cursor: pointer;"
          title="Click to center on active combatant"
        >
          <span>
            ${isMyTurn
              ? html`<strong>YOUR TURN!</strong> (Round ${roundNumber})`
              : html`<strong>${activeCombatant.name}'s Turn</strong> (Round ${roundNumber})`}
          </span>

          ${nextCombatant && turnOrder.length > 1
            ? html`<span class="dndm-initiative-banner-next">Up Next: ${nextCombatant.name}</span>`
            : nothing}
        </div>
      `;
    }

    return html`${nothing}`;
  }
}
