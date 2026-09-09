/*
 * Pure dice helpers: parsing, formatting, validation, and built-in roll templates.
 *
 * Rules:
 *   1. Allowed sides: {4, 6, 8, 10, 12, 20, 100}.
 *   2. Max 20 dice per roll.
 *   3. Strict JSON compatibility; pure TypeScript with no DOM or Node globals.
 */

import {
  ALLOWED_DICE_SIDES,
  MAX_DICE_PER_ROLL,
  resolveAttributeContribution,
  type CharacterSheet,
  type DiceTerm,
  type DieRoll,
  type RollMode,
  type RollResult,
  type RollTemplate,
} from "./domain.js";
import { generateGuid, timestampToIsoUtc } from "./maps.js";

/** Checks if a number of sides is one of the allowed dice types. */
export function isValidDiceSide(sides: number): boolean {
  for (let i = 0; i < ALLOWED_DICE_SIDES.length; i++) {
    if (ALLOWED_DICE_SIDES[i] === sides) return true;
  }
  return false;
}

export interface DiceValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

/**
 * Validates an array of dice terms against domain invariants:
 * - Each term must have count >= 1.
 * - Each term must have allowed sides (4, 6, 8, 10, 12, 20, 100).
 * - Total dice count across all terms must not exceed MAX_DICE_PER_ROLL (20).
 */
export function validateDiceTerms(terms: readonly DiceTerm[]): DiceValidationResult {
  let totalDice = 0;

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (!Number.isInteger(term.count) || term.count < 1) {
      return { valid: false, error: `Dice count must be a positive integer, got ${term.count}.` };
    }
    if (!isValidDiceSide(term.sides)) {
      return {
        valid: false,
        error: `Invalid dice sides: d${term.sides}. Allowed sides: ${ALLOWED_DICE_SIDES.join(", ")}.`,
      };
    }
    totalDice += term.count;
  }

  if (totalDice > MAX_DICE_PER_ROLL) {
    return {
      valid: false,
      error: `Total dice count (${totalDice}) exceeds maximum allowed (${MAX_DICE_PER_ROLL}).`,
    };
  }

  return { valid: true };
}

export interface ParsedDiceFormula {
  readonly dice: readonly DiceTerm[];
  readonly flatModifier: number;
}

/**
 * Parses a standard dice notation formula string (e.g. "1d20+5", "2d6-1", "d8", "3d6 + 2d8 + 4").
 * Returns null if the formula is malformed, uses invalid dice sides, or exceeds max dice.
 */
export function parseDiceNotation(formula: string): ParsedDiceFormula | null {
  if (!formula || typeof formula !== "string") return null;

  const cleaned = formula.replace(/\s+/g, "");
  if (cleaned.length === 0) return null;

  // Match sequences of tokens: ([+-]?)(?:(\d*)d(\d+)|(\d+))
  const tokenRegex = /([+-]?)(?:(?:(\d*)d(\d+))|(\d+))/gi;
  let match: RegExpExecArray | null;
  let consumedLength = 0;

  const dice: DiceTerm[] = [];
  let flatModifier = 0;

  while ((match = tokenRegex.exec(cleaned)) !== null) {
    if (match.index !== consumedLength) {
      // Skipped unrecognized characters between tokens
      return null;
    }
    consumedLength += match[0].length;

    const sign = match[1] === "-" ? -1 : 1;
    const countStr = match[2];
    const sidesStr = match[3];
    const flatStr = match[4];

    if (sidesStr !== undefined) {
      // Dice term (e.g. "2d6", "d20", "-1d4")
      if (sign < 0) {
        // Negative dice counts (e.g. "-1d6") are not allowed in domain rules
        return null;
      }
      const count = countStr === "" || countStr === undefined ? 1 : parseInt(countStr, 10);
      const sides = parseInt(sidesStr, 10);

      if (!isValidDiceSide(sides) || count < 1) {
        return null;
      }
      dice.push({ count, sides });
    } else if (flatStr !== undefined) {
      // Flat modifier (e.g. "+5", "-2")
      const val = parseInt(flatStr, 10);
      flatModifier += sign * val;
    }
  }

  // Must have consumed the entire string and found at least one term
  if (consumedLength !== cleaned.length || (dice.length === 0 && flatModifier === 0)) {
    return null;
  }

  const validation = validateDiceTerms(dice);
  if (!validation.valid) {
    return null;
  }

  return { dice, flatModifier };
}

/**
 * Formats dice terms and flat modifier into a standard dice formula string.
 * Example: [{ count: 2, sides: 6 }], 4 -> "2d6+4"
 * Example: [{ count: 1, sides: 20 }], -2 -> "1d20-2"
 * Example: [], 5 -> "+5"
 */
export function formatDiceFormula(dice: readonly DiceTerm[], flatModifier = 0): string {
  const parts: string[] = [];

  for (let i = 0; i < dice.length; i++) {
    const term = dice[i];
    parts.push(`${term.count}d${term.sides}`);
  }

  let formula = parts.join("+");

  if (flatModifier > 0) {
    formula = formula.length > 0 ? `${formula}+${flatModifier}` : `+${flatModifier}`;
  } else if (flatModifier < 0) {
    formula = formula.length > 0 ? `${formula}${flatModifier}` : `${flatModifier}`;
  }

  return formula;
}

// ── Built-in Roll Templates ───────────────────────────────────────────────────

export const BUILTIN_ROLL_TEMPLATE_IDS = {
  D4: "d0000000-0000-0000-0000-000000000101",
  D6: "d0000000-0000-0000-0000-000000000102",
  D8: "d0000000-0000-0000-0000-000000000103",
  D10: "d0000000-0000-0000-0000-000000000104",
  D12: "d0000000-0000-0000-0000-000000000105",
  D20: "d0000000-0000-0000-0000-000000000106",
  D20_ADVANTAGE: "d0000000-0000-0000-0000-000000000107",
  D20_DISADVANTAGE: "d0000000-0000-0000-0000-000000000108",
  D100: "d0000000-0000-0000-0000-000000000109",
} as const;

export const BUILTIN_ROLL_TEMPLATES: readonly RollTemplate[] = [
  {
    id: BUILTIN_ROLL_TEMPLATE_IDS.D4,
    name: "d4",
    dice: [{ count: 1, sides: 4 }],
    flatModifier: 0,
    mode: "Normal",
    attributeName: null,
    label: "d4",
  },
  {
    id: BUILTIN_ROLL_TEMPLATE_IDS.D6,
    name: "d6",
    dice: [{ count: 1, sides: 6 }],
    flatModifier: 0,
    mode: "Normal",
    attributeName: null,
    label: "d6",
  },
  {
    id: BUILTIN_ROLL_TEMPLATE_IDS.D8,
    name: "d8",
    dice: [{ count: 1, sides: 8 }],
    flatModifier: 0,
    mode: "Normal",
    attributeName: null,
    label: "d8",
  },
  {
    id: BUILTIN_ROLL_TEMPLATE_IDS.D10,
    name: "d10",
    dice: [{ count: 1, sides: 10 }],
    flatModifier: 0,
    mode: "Normal",
    attributeName: null,
    label: "d10",
  },
  {
    id: BUILTIN_ROLL_TEMPLATE_IDS.D12,
    name: "d12",
    dice: [{ count: 1, sides: 12 }],
    flatModifier: 0,
    mode: "Normal",
    attributeName: null,
    label: "d12",
  },
  {
    id: BUILTIN_ROLL_TEMPLATE_IDS.D20,
    name: "d20",
    dice: [{ count: 1, sides: 20 }],
    flatModifier: 0,
    mode: "Normal",
    attributeName: null,
    label: "d20",
  },
  {
    id: BUILTIN_ROLL_TEMPLATE_IDS.D20_ADVANTAGE,
    name: "d20 (Advantage)",
    dice: [{ count: 1, sides: 20 }],
    flatModifier: 0,
    mode: "Advantage",
    attributeName: null,
    label: "d20 (Advantage)",
  },
  {
    id: BUILTIN_ROLL_TEMPLATE_IDS.D20_DISADVANTAGE,
    name: "d20 (Disadvantage)",
    dice: [{ count: 1, sides: 20 }],
    flatModifier: 0,
    mode: "Disadvantage",
    attributeName: null,
    label: "d20 (Disadvantage)",
  },
  {
    id: BUILTIN_ROLL_TEMPLATE_IDS.D100,
    name: "d100",
    dice: [{ count: 1, sides: 100 }],
    flatModifier: 0,
    mode: "Normal",
    attributeName: null,
    label: "d100",
  },
];

// ── Dice Notation Builder for 3D Physics (DiceBox) ───────────────────────────

/**
 * Translates a RollResult into the dice-box-threejs forced-result notation (e.g. "2d6+1d8@4,3,6")
 * so each client can run an independent physics simulation that still lands on the authoritative
 * server-side result.
 * Modifiers are pure math and absent — only the visual dice belong here.
 * d100 is expanded into a percentile pair (tens die 00-90 + units die 0-9).
 */
export function buildDiceNotation(roll: RollResult): string {
  if (!roll.rolls || roll.rolls.length === 0) return "";

  const sidesGroups: Array<{ sides: number; count: number }> = [];
  const results: number[] = [];
  let lastSides: number | null = null;
  let runCount = 0;

  const flushRun = () => {
    if (lastSides !== null && runCount > 0) {
      sidesGroups.push({ sides: lastSides, count: runCount });
    }
    runCount = 0;
    lastSides = null;
  };

  const addDie = (sides: number, result: number) => {
    results.push(result);
    if (lastSides === sides) {
      runCount++;
    } else {
      flushRun();
      lastSides = sides;
      runCount = 1;
    }
  };

  for (const die of roll.rolls) {
    if (die.sides === 100) {
      const tens = die.value === 100 ? 0 : Math.floor(die.value / 10) * 10;
      const units = die.value === 100 ? 0 : die.value % 10;
      addDie(100, tens);
      addDie(10, units);
    } else {
      addDie(die.sides, die.value);
    }
  }
  flushRun();

  const groupStr = sidesGroups.map((g) => `${g.count}d${g.sides}`).join("+");
  const resultStr = results.join(",");
  return `${groupStr}@${resultStr}`;
}

// ── Natural Roll Checks ───────────────────────────────────────────────────────

/** True if the roll was a single d20 (or adv/dis d20) and the kept die was a 20. */
export function isNatural20(roll: RollResult): boolean {
  const kept = roll.rolls.filter((r) => !r.discarded);
  return kept.length === 1 && kept[0].sides === 20 && kept[0].value === 20;
}

/** True if the roll was a single d20 (or adv/dis d20) and the kept die was a 1. */
export function isNatural1(roll: RollResult): boolean {
  const kept = roll.rolls.filter((r) => !r.discarded);
  return kept.length === 1 && kept[0].sides === 20 && kept[0].value === 1;
}

// ── Visibility Filtering ──────────────────────────────────────────────────────

/**
 * Hides non-player rolls when `rollsVisibleToPlayers` is false.
 * DM sees all rolls. When false, players only see their own rolls.
 */
export function filterVisibleRolls(
  log: readonly RollResult[],
  viewerUserId: string | null,
  isHost: boolean,
  rollsVisibleToPlayers: boolean,
): readonly RollResult[] {
  if (isHost || rollsVisibleToPlayers) return log;
  if (!viewerUserId) return [];
  return log.filter((r) => r.rollerUserId === viewerUserId);
}

// ── Authority Roll Execution ──────────────────────────────────────────────────

export interface ExecuteRollOptions {
  readonly nowMs?: number;
  readonly label?: string;
  readonly tokenId?: string | null;
  readonly sheetId?: string | null;
  readonly attributeName?: string | null;
  readonly sheets?: Readonly<Record<string, CharacterSheet>>;
  readonly rng?: () => number;
  readonly forcedByUserId?: string | null;
  readonly id?: string;
  readonly flatModifierOverride?: number;
}

/**
 * Pure authority function that executes a deterministic roll:
 * 1. Parses and validates dice terms.
 * 2. Rolls dice with pseudo-random algorithm.
 * 3. Applies Advantage / Disadvantage (for single die rolls).
 * 4. Resolves sheet attribute modifiers and status effect contributions.
 * 5. Assembles modifierBreakdown and returns immutable RollResult.
 */
export function executeRoll(
  formulaOrDice: string | readonly DiceTerm[],
  mode: RollMode,
  rollerUserId: string,
  options: ExecuteRollOptions = {},
): RollResult | null {
  let dice: readonly DiceTerm[];
  let flatModifier = options.flatModifierOverride ?? 0;

  if (typeof formulaOrDice === "string") {
    const parsed = parseDiceNotation(formulaOrDice);
    if (!parsed) return null;
    dice = parsed.dice;
    if (options.flatModifierOverride === undefined) {
      flatModifier = parsed.flatModifier;
    }
  } else {
    dice = formulaOrDice;
  }

  const validation = validateDiceTerms(dice);
  if (!validation.valid || dice.length === 0) return null;

  const rng = options.rng ?? Math.random;

  // Mode coercion: Advantage / Disadvantage only applies if rolling exactly 1d{N}
  const isSingleDie = dice.length === 1 && dice[0].count === 1;
  const effectiveMode = !isSingleDie && mode !== "Normal" ? "Normal" : mode;

  const rolls: DieRoll[] = [];
  for (const term of dice) {
    for (let i = 0; i < term.count; i++) {
      const val = Math.floor(rng() * term.sides) + 1;
      rolls.push({ sides: term.sides, value: val, discarded: false });
    }
  }

  if (effectiveMode !== "Normal") {
    const sides = dice[0].sides;
    const secondVal = Math.floor(rng() * sides) + 1;
    rolls.push({ sides, value: secondVal, discarded: false });

    const firstResult = rolls[0].value;
    const secondResult = rolls[1].value;
    const firstIsKept =
      effectiveMode === "Advantage" ? firstResult >= secondResult : firstResult <= secondResult;
    rolls[firstIsKept ? 1 : 0] = { ...rolls[firstIsKept ? 1 : 0], discarded: true };
  }

  // Attribute modifier resolution
  let attributeModifier = 0;
  let breakdown = "";
  const sheet = options.sheetId && options.sheets ? options.sheets[options.sheetId] : null;

  if (sheet && options.attributeName) {
    const baseAttr = sheet.values[options.attributeName];
    if (baseAttr) {
      const contribution = resolveAttributeContribution(sheet, options.attributeName, baseAttr);
      attributeModifier = contribution.effectiveModifier;

      const valueParts: string[] = [String(baseAttr.kind !== "Text" ? baseAttr.value : 0)];
      for (let i = 1; i < contribution.valueBreakdown.length; i++) {
        const entry = contribution.valueBreakdown[i];
        const sign = entry.delta >= 0 ? "+" : "-";
        valueParts.push(`${sign} ${Math.abs(entry.delta)} (${entry.source})`);
      }

      const keptSum = rolls.filter((r) => !r.discarded).reduce((s, r) => s + r.value, 0);
      const scoringTail =
        baseAttr.kind === "Score"
          ? ` = ${contribution.effectiveValue.value} -> mod ${attributeModifier >= 0 ? "+" : ""}${attributeModifier}`
          : ` = mod ${attributeModifier >= 0 ? "+" : ""}${attributeModifier}`;

      const dicePieces: string[] = [
        `[${keptSum}]`,
        `${attributeModifier >= 0 ? "+" : "-"} ${Math.abs(attributeModifier)} (${options.attributeName})`,
      ];
      if (flatModifier !== 0) {
        dicePieces.push(`${flatModifier >= 0 ? "+" : "-"} ${Math.abs(flatModifier)}`);
      }

      const totalVal = keptSum + flatModifier + attributeModifier;
      breakdown = `${options.attributeName}: ${valueParts.join(" ")}${scoringTail}; ${dicePieces.join(" ")} = ${totalVal}`;
    }
  }

  const keptDiceSum = rolls.filter((r) => !r.discarded).reduce((s, r) => s + r.value, 0);
  const total = keptDiceSum + flatModifier + attributeModifier;

  if (!breakdown) {
    const parts = [`[${keptDiceSum}]`];
    if (attributeModifier !== 0) {
      parts.push(`${attributeModifier >= 0 ? "+" : "-"} ${Math.abs(attributeModifier)}`);
    }
    if (flatModifier !== 0) {
      parts.push(`${flatModifier >= 0 ? "+" : "-"} ${Math.abs(flatModifier)}`);
    }
    breakdown = parts.length > 1 ? `${parts.join(" ")} = ${total}` : `[${keptDiceSum}] = ${total}`;
  }

  const formula = formatDiceFormula(dice, flatModifier);
  const id = options.id ?? generateGuid();
  const timestampUtc = timestampToIsoUtc(options.nowMs ?? 0);

  return {
    id,
    rollerUserId,
    forcedByUserId: options.forcedByUserId ?? null,
    rolls,
    originalDice: [...dice],
    originalAttributeRef:
      options.sheetId !== undefined && options.sheetId !== null
        ? { sheetId: options.sheetId, attributeName: options.attributeName ?? null }
        : null,
    total,
    mode: effectiveMode,
    flatModifier,
    attributeModifier,
    label: options.label ?? (options.attributeName ? `${options.attributeName} Check` : "Roll"),
    timestampUtc,
    formula,
    modifierBreakdown: breakdown,
    tokenId: options.tokenId ?? null,
    appliedRules: [],
  };
}

