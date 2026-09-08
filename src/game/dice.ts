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
  type DiceTerm,
  type RollTemplate,
} from "./domain.js";

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
