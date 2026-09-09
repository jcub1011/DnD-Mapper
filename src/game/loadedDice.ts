/*
 * Pure authority processor for Loaded Dice.
 *
 * Rules:
 *   1. Pure, deterministic condition evaluation and modification pipeline.
 *   2. Strict JSON only; no DOM or Node globals.
 *   3. Shared between client and server authority sandbox.
 */

import {
  GM_TARGET_ID,
  type DieRoll,
  type LoadedDiceCondition,
  type LoadedDiceContext,
  type LoadedDiceModification,
  type LoadedDiceRule,
  type LoadedDiceRuleStamp,
} from "./domain.js";

/**
 * Pure deterministic condition evaluation for a single LoadedDiceCondition against the context.
 */
export function evaluateCondition(cond: LoadedDiceCondition, ctx: LoadedDiceContext): boolean {
  switch (cond.$kind) {
    case "currentMap":
      return ctx.activeMapId === cond.mapId;

    case "diceTypeRolled":
      return ctx.roll.sides === cond.sides;

    case "rollerIs":
      return (
        ctx.roll.sheetId === cond.sheetId ||
        (ctx.roll.sheetId === null && cond.sheetId === GM_TARGET_ID)
      );

    case "rollModeIs":
      return ctx.roll.mode === cond.mode;

    case "combatActive":
      return ctx.isCombatActive;

    case "rollLabelContains":
      return ctx.roll.label.toLowerCase().includes(cond.substring.toLowerCase());

    case "hostKeyHeld": {
      const targetKey = cond.key.toUpperCase();
      return ctx.hostHeldKeys.some((k) => k.toUpperCase() === targetKey);
    }

    case "allOf":
      return cond.conditions.every((c) => evaluateCondition(c, ctx));

    case "anyOf":
      return cond.conditions.some((c) => evaluateCondition(c, ctx));

    case "not":
      return !evaluateCondition(cond.condition, ctx);
  }
}

/**
 * Checks if a rule is applicable to the current roll context:
 * 1. Rule must be enabled.
 * 2. If targetSheetIds is specified, the roll's sheetId (or GM_TARGET_ID if unlinked) must match.
 * 3. All conditions defined in the rule must evaluate to true.
 */
export function isRuleApplicable(rule: LoadedDiceRule, ctx: LoadedDiceContext): boolean {
  if (!rule.enabled) {
    return false;
  }

  // Target sheet scoping (empty targetSheetIds matches all sheets / unlinked GM)
  if (rule.targetSheetIds && rule.targetSheetIds.length > 0) {
    if (ctx.roll.sheetId === null) {
      if (!rule.targetSheetIds.includes(GM_TARGET_ID)) {
        return false;
      }
    } else {
      if (!rule.targetSheetIds.includes(ctx.roll.sheetId)) {
        return false;
      }
    }
  }

  // All conditions must evaluate to true
  if (rule.conditions && rule.conditions.length > 0) {
    return rule.conditions.every((c) => evaluateCondition(c, ctx));
  }

  return true;
}

export interface ModificationResult {
  readonly rolls: readonly DieRoll[];
  readonly modified: boolean;
}

/**
 * Applies a sequence of modifications to a collection of die rolls.
 * Modifications are applied sequentially to die values:
 * - setResult(value): Overrides die face value to target value (clamped to [1, sides]).
 * - clampMax(max): Caps face value at min(face, max), bounded to [1, sides].
 * - clampMin(min): Floors face value at max(face, min), bounded to [1, sides].
 * - biasLower(rerollCount): Rolls additional dice equal to rerollCount, takes lowest.
 * - biasHigher(rerollCount): Rolls additional dice equal to rerollCount, takes highest.
 * - rerollOn(values): If natural roll is in values, rerolls the die once.
 */
export function applyModifications(
  rolls: readonly DieRoll[],
  modifications: readonly LoadedDiceModification[],
  rng: () => number = Math.random,
): ModificationResult {
  if (modifications.length === 0 || rolls.length === 0) {
    return { rolls, modified: false };
  }

  let modified = false;
  const nextRolls: DieRoll[] = rolls.map((die) => {
    let val = die.value;
    const sides = die.sides;

    for (let i = 0; i < modifications.length; i++) {
      const mod = modifications[i];
      switch (mod.$kind) {
        case "setResult": {
          val = Math.max(1, Math.min(sides, mod.value));
          break;
        }

        case "clampMax": {
          val = Math.min(val, mod.max);
          val = Math.max(1, Math.min(sides, val));
          break;
        }

        case "clampMin": {
          val = Math.max(val, mod.min);
          val = Math.max(1, Math.min(sides, val));
          break;
        }

        case "biasLower": {
          for (let r = 0; r < mod.rerollCount; r++) {
            const extra = Math.floor(rng() * sides) + 1;
            val = Math.min(val, extra);
          }
          break;
        }

        case "biasHigher": {
          for (let r = 0; r < mod.rerollCount; r++) {
            const extra = Math.floor(rng() * sides) + 1;
            val = Math.max(val, extra);
          }
          break;
        }

        case "rerollOn": {
          if (mod.values.includes(val)) {
            val = Math.floor(rng() * sides) + 1;
          }
          break;
        }
      }
    }

    if (val !== die.value) {
      modified = true;
      return { ...die, value: val };
    }
    return die;
  });

  return { rolls: nextRolls, modified };
}

export interface ProcessLoadedDiceResult {
  readonly rolls: readonly DieRoll[];
  readonly appliedRules: readonly LoadedDiceRuleStamp[];
}

/**
 * Runs the Loaded Dice pipeline over an array of die rolls in priority order.
 * Whenever an applicable rule executes modifications, a LoadedDiceRuleStamp is recorded.
 */
export function processLoadedDice(
  rolls: readonly DieRoll[],
  rules: readonly LoadedDiceRule[],
  ctx: LoadedDiceContext,
  rng: () => number = Math.random,
): ProcessLoadedDiceResult {
  if (!rules || rules.length === 0 || rolls.length === 0) {
    return { rolls, appliedRules: [] };
  }

  let currentRolls: readonly DieRoll[] = [...rolls];
  const appliedRules: LoadedDiceRuleStamp[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!isRuleApplicable(rule, ctx)) {
      continue;
    }

    if (!rule.modifications || rule.modifications.length === 0) {
      continue;
    }

    const { rolls: modifiedRolls } = applyModifications(
      currentRolls,
      rule.modifications,
      rng,
    );
    currentRolls = modifiedRolls;

    appliedRules.push({
      ruleId: rule.id,
      ruleName: rule.name,
      modificationType: rule.modifications.map((m) => m.$kind).join(", "),
    });
  }

  return { rolls: currentRolls, appliedRules };
}
