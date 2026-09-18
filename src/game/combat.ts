/*
 * Combat and initiative domain helpers.
 *
 * Rules:
 *   1. Pure functions only — no ambient I/O, no DOM, no Node globals.
 *   2. Strict sorting: initiative descending, players before NPCs, alphabetical name.
 *   3. Shared between authority module and client view.
 */

import {
  getModifier,
  resolveAttributeValue,
  type CharacterSheet,
  type CombatantEntry,
  type CombatState,
} from "./domain.js";

/**
 * Pure turn order sorting function matching legacy Blazor TurnOrderSorter.cs:11-15:
 * 1. Primary: Descending by initiativeRoll (null rolls sink to bottom via -Infinity).
 * 2. Secondary (Tie-breaker): Players before NPCs (ownerUserId !== null ? 0 : 1).
 * 3. Tertiary (Tie-breaker): Alphabetical by Name (accent-sensitive).
 */
export function compareCombatants(a: CombatantEntry, b: CombatantEntry): number {
  const rollA = a.initiativeRoll ?? Number.NEGATIVE_INFINITY;
  const rollB = b.initiativeRoll ?? Number.NEGATIVE_INFINITY;
  if (rollA !== rollB) {
    return rollB - rollA;
  }

  const isPlayerA = a.ownerUserId !== null ? 0 : 1;
  const isPlayerB = b.ownerUserId !== null ? 0 : 1;
  if (isPlayerA !== isPlayerB) {
    return isPlayerA - isPlayerB;
  }

  return a.name.localeCompare(b.name, undefined, { sensitivity: "accent" });
}

/**
 * Returns a new array sorted by the canonical combat turn order rules.
 */
export function sortTurnOrder(entries: readonly CombatantEntry[]): CombatantEntry[] {
  return [...entries].sort(compareCombatants);
}

/**
 * Finds the index in a sorted turn order where newEntry should be inserted
 * to preserve canonical sort order.
 */
export function findInsertionIndex(
  turnOrder: readonly CombatantEntry[],
  newEntry: CombatantEntry,
): number {
  for (let i = 0; i < turnOrder.length; i++) {
    if (compareCombatants(newEntry, turnOrder[i]) < 0) {
      return i;
    }
  }
  return turnOrder.length;
}

/**
 * Returns true if there is at least one combatant and every combatant has completed their roll.
 */
export function isAllRollsComplete(turnOrder: readonly CombatantEntry[]): boolean {
  return turnOrder.length > 0 && turnOrder.every((c) => c.initiativeRoll !== null);
}

/**
 * Advances combat to the next turn, incrementing roundNumber when wrapping past the end.
 */
export function advanceTurn(combat: CombatState): CombatState {
  if (combat.turnOrder.length === 0) return combat;
  const nextTurnIndex = (combat.currentTurnIndex + 1) % combat.turnOrder.length;
  const nextRoundNumber = nextTurnIndex === 0 ? combat.roundNumber + 1 : combat.roundNumber;
  return {
    ...combat,
    currentTurnIndex: nextTurnIndex,
    roundNumber: nextRoundNumber,
  };
}

/**
 * Reverses combat to the previous turn, decrementing roundNumber (clamped to min 1)
 * when wrapping backwards from turn 0.
 */
export function reverseTurn(combat: CombatState): CombatState {
  if (combat.turnOrder.length === 0) return combat;
  const nextRoundNumber =
    combat.currentTurnIndex === 0
      ? Math.max(combat.roundNumber - 1, 1)
      : combat.roundNumber;
  const nextTurnIndex =
    (combat.currentTurnIndex - 1 + combat.turnOrder.length) % combat.turnOrder.length;
  return {
    ...combat,
    currentTurnIndex: nextTurnIndex,
    roundNumber: nextRoundNumber,
  };
}

/**
 * Derives the active turn token ID from combat state.
 * Returns null if combat is not active or no token is at current turn index.
 */
export function resolveActiveTurnTokenId(combat: CombatState | null): string | null {
  if (!combat || combat.phase !== "Active") return null;
  return combat.turnOrder[combat.currentTurnIndex]?.tokenId ?? null;
}

/**
 * Extracts the initiative modifier from a CharacterSheet based on the schema's
 * initiativeAttributeName (defaulting to "Dexterity").
 */
export function getInitiativeModifier(
  sheet: CharacterSheet | null | undefined,
  initiativeAttributeName: string | null,
): number {
  if (!sheet) return 0;
  const attrName = initiativeAttributeName || "Dexterity";
  const val = resolveAttributeValue(sheet, attrName);
  return getModifier(val);
}
