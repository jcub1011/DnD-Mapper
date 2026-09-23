/*
 * Roll Result Ticker for Display / Projector Mode.
 *
 * Renders a floating stack of recent rolls in the bottom-right corner.
 * Shows up to 10 latest rolls, filtered by player visibility settings.
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";
import type { RollResult, Token } from "../../game/domain";
import { isNatural1, isNatural20 } from "../../game/dice";

@customElement("dndm-display-roll-ticker")
export class DndmDisplayRollTicker extends GameElement {
  @property({ attribute: false })
  rolls: readonly RollResult[] = [];

  @property({ attribute: false })
  tokens: readonly Token[] = [];

  @property({ type: Boolean })
  isDm = false;

  @property({ type: String })
  currentUserId: string | null = null;

  @property({ type: Boolean })
  rollsVisibleToPlayers = true;

  override render(): TemplateResult {
    const visibleRolls = this.rolls
      .filter((r) => {
        if (this.isDm) return true;
        if (this.rollsVisibleToPlayers) return true;
        return r.rollerUserId === this.currentUserId;
      })
      .slice(-10);

    if (visibleRolls.length === 0) {
      return html`${nothing}`;
    }

    return html`
      <div class="dndm-display-roll-ticker" role="log" aria-label="Recent rolls">
        ${visibleRolls.map((roll) => {
          const token = roll.tokenId ? this.tokens.find((t) => t.id === roll.tokenId) : null;
          const rollerName = token ? token.name : roll.rollerUserId || "Player";

          let critClass = "";
          if (isNatural20(roll)) {
            critClass = "crit-success";
          } else if (isNatural1(roll)) {
            critClass = "crit-failure";
          }

          return html`
            <div class="dndm-display-roll-card">
              <div class="dndm-display-roll-header">
                <span class="dndm-display-roll-roller">${rollerName}</span>
                <span class="dndm-display-roll-formula">${roll.formula}</span>
              </div>
              <div class="dndm-display-roll-body">
                <span class="dndm-display-roll-label">${roll.label || "Check"}</span>
                <span class="dndm-display-roll-total ${critClass}">${roll.total}</span>
              </div>
            </div>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-display-roll-ticker": DndmDisplayRollTicker;
  }
}
