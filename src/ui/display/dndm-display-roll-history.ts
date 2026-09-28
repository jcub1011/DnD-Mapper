/*
 * Roll history panel for the projector popout.
 *
 * A full-height left panel listing the roll log newest first, with large text
 * that stays readable over a screen share. Rolls still tumbling in the 3D dice
 * overlay are held back so the total never spoils the animation. The popout
 * only mounts it while displayableRolls() is non-empty.
 */

import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { DndMapperState, RollResult } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import { diceAnimationTracker } from "../dice/diceAnimationTracker";
import { renderRollLogEntry } from "../dice/rollLogEntry";

/** Rolls the projector may show right now, newest first. */
export function displayableRolls(state: DndMapperState | null): RollResult[] {
  // The pushed state is already the player projection; this is a second
  // line of defense matching the other roll lists.
  if (!state?.settings.rollsVisibleToPlayers) return [];
  return (state.rollLog ?? []).filter((r) => !diceAnimationTracker.isAnimating(r.id)).reverse();
}

@customElement("dndm-display-roll-history")
export class DndmDisplayRollHistory extends GameElement {
  @property({ attribute: false })
  state: DndMapperState | null = null;

  /** Panel width in px — the popout also insets the map framing by this much. */
  @property({ type: Number })
  widthPx = 0;

  private unsubscribeTracker: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeTracker = diceAnimationTracker.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeTracker?.();
    this.unsubscribeTracker = null;
  }

  override render(): TemplateResult {
    const state = this.state;
    return html`
      <aside
        class="dndm-display-rolls"
        style="width: ${this.widthPx}px"
        role="log"
        aria-label="Roll history"
      >
        <h2 class="dndm-display-rolls__title">Rolls</h2>
        <div class="dndm-display-rolls__list">
          ${displayableRolls(state).map((r) =>
            renderRollLogEntry(r, { state, isDm: false, currentUserId: null }),
          )}
        </div>
      </aside>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-display-roll-history": DndmDisplayRollHistory;
  }
}
