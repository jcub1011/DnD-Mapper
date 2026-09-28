/*
 * Shared roll log entry markup (the `.dndm-rolllog-entry` card), used by the
 * Roll History modal and the projector's roll history panel so both apply the
 * same roller naming and Loaded Dice visibility rules.
 */

import { html, nothing, type TemplateResult } from "lit";
import { isNatural1, isNatural20 } from "../../game/dice.js";
import type { DndMapperState, RollResult } from "../../game/domain.js";

export interface RollLogEntryContext {
  state: DndMapperState | null | undefined;
  isDm: boolean;
  currentUserId: string | null;
  /** Omit to render without a re-roll button (e.g. the view-only projector). */
  onReRoll?: (roll: RollResult, e: MouseEvent) => void;
}

/** Display name for a roll's roller: token, then DM, then sheet character. */
export function rollerNameFor(state: DndMapperState | null | undefined, roll: RollResult): string {
  if (roll.tokenId) {
    for (const map of state?.maps ?? []) {
      if ("tokens" in map) {
        const token = map.tokens.find((t) => t.id === roll.tokenId);
        if (token) return token.name;
      }
    }
  }

  if (state?.dmPlayerId === roll.rollerUserId) {
    return "DM";
  }

  for (const sheet of Object.values(state?.sheets ?? {})) {
    if (sheet.ownerUserId === roll.rollerUserId) {
      return sheet.characterName || "Player";
    }
  }

  return "Player";
}

function formatMod(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

export function renderRollLogEntry(r: RollResult, ctx: RollLogEntryContext): TemplateResult {
  const { state, isDm, currentUserId, onReRoll } = ctx;
  const isNat20 = isNatural20(r);
  const isNat1 = isNatural1(r);
  const rollerName = rollerNameFor(state, r);
  const canReRoll = onReRoll !== undefined && r.rollerUserId === currentUserId;

  const hasAppliedRules = Boolean(r.appliedRules && r.appliedRules.length > 0);
  const visibility = state?.settings?.loadedDiceRuleVisibility ?? "Hidden";
  const showRuleStamps = isDm || visibility === "VisibleToAll" || visibility === "AllPlayers";
  const indicator = state?.settings?.loadedDicePlayerIndicator ?? "None";
  const showSubtleCue = hasAppliedRules && (indicator === "Subtle" || indicator === "RedDotInLog");
  const showObviousCue = hasAppliedRules && indicator === "Obvious";

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
            ? html`<span class="dndm-rolllog-mode">${r.mode === "Advantage" ? "ADV" : "DIS"}</span>`
            : nothing
        }
        ${
          hasAppliedRules && (showSubtleCue || (isDm && indicator === "None"))
            ? html`<span class="dndm-rolllog-cue--subtle" title="Roll modified by Loaded Dice"
                >●</span
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
                  @click=${(e: MouseEvent) => onReRoll(r, e)}
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
                    ${formatMod(r.flatModifier + r.attributeModifier)}
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
      ${
        hasAppliedRules && showRuleStamps
          ? html`
              <div
                class="dndm-rolllog-stamps"
                style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px;"
              >
                ${r.appliedRules.map((stamp) => {
                const name = typeof stamp === "string" ? stamp : stamp.ruleName;
                const type = typeof stamp === "object" ? ` (${stamp.modificationType})` : "";
                return html`
                  <span class="dndm-rolllog-tampered-badge" title="Loaded Dice: ${name}${type}">
                    ⚡ ${name}
                  </span>
                `;
              })}
              </div>
            `
          : nothing
      }
      ${
        showObviousCue
          ? html`<div class="dndm-rolllog-cue--obvious">⚡ Tampered by a divine hand</div>`
          : nothing
      }
    </article>
  `;
}
