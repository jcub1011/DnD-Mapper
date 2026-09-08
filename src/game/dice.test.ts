import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROLL_TEMPLATE_IDS,
  BUILTIN_ROLL_TEMPLATES,
  formatDiceFormula,
  isValidDiceSide,
  parseDiceNotation,
  validateDiceTerms,
} from "./dice.js";

describe("dice helpers", () => {
  describe("isValidDiceSide", () => {
    it("allows standard D&D dice {4, 6, 8, 10, 12, 20, 100}", () => {
      expect(isValidDiceSide(4)).toBe(true);
      expect(isValidDiceSide(6)).toBe(true);
      expect(isValidDiceSide(8)).toBe(true);
      expect(isValidDiceSide(10)).toBe(true);
      expect(isValidDiceSide(12)).toBe(true);
      expect(isValidDiceSide(20)).toBe(true);
      expect(isValidDiceSide(100)).toBe(true);
    });

    it("rejects non-standard dice sides", () => {
      expect(isValidDiceSide(2)).toBe(false);
      expect(isValidDiceSide(3)).toBe(false);
      expect(isValidDiceSide(5)).toBe(false);
      expect(isValidDiceSide(7)).toBe(false);
      expect(isValidDiceSide(30)).toBe(false);
      expect(isValidDiceSide(0)).toBe(false);
      expect(isValidDiceSide(-6)).toBe(false);
    });
  });

  describe("validateDiceTerms", () => {
    it("validates compliant terms", () => {
      const result = validateDiceTerms([
        { count: 2, sides: 6 },
        { count: 1, sides: 20 },
      ]);
      expect(result.valid).toBe(true);
    });

    it("rejects terms with count < 1", () => {
      const result = validateDiceTerms([{ count: 0, sides: 6 }]);
      expect(result.valid).toBe(false);
    });

    it("rejects non-standard sides", () => {
      const result = validateDiceTerms([{ count: 1, sides: 7 }]);
      expect(result.valid).toBe(false);
    });

    it("rejects rolls with more than 20 total dice", () => {
      const result = validateDiceTerms([{ count: 21, sides: 6 }]);
      expect(result.valid).toBe(false);

      const splitResult = validateDiceTerms([
        { count: 10, sides: 6 },
        { count: 11, sides: 6 },
      ]);
      expect(splitResult.valid).toBe(false);
    });
  });

  describe("parseDiceNotation", () => {
    it("parses single term with positive modifier", () => {
      const parsed = parseDiceNotation("1d20+5");
      expect(parsed).toEqual({
        dice: [{ count: 1, sides: 20 }],
        flatModifier: 5,
      });
    });

    it("parses single term with negative modifier and whitespace", () => {
      const parsed = parseDiceNotation("2d6 - 1");
      expect(parsed).toEqual({
        dice: [{ count: 2, sides: 6 }],
        flatModifier: -1,
      });
    });

    it("parses shorthand die notation without count (e.g. d8, d20)", () => {
      const parsed = parseDiceNotation("d8");
      expect(parsed).toEqual({
        dice: [{ count: 1, sides: 8 }],
        flatModifier: 0,
      });
    });

    it("parses multi-dice expressions", () => {
      const parsed = parseDiceNotation("3d6 + 2d8 + 4");
      expect(parsed).toEqual({
        dice: [
          { count: 3, sides: 6 },
          { count: 2, sides: 8 },
        ],
        flatModifier: 4,
      });
    });

    it("parses flat modifier only", () => {
      const parsed = parseDiceNotation("+3");
      expect(parsed).toEqual({
        dice: [],
        flatModifier: 3,
      });
    });

    it("rejects malformed or invalid notation", () => {
      expect(parseDiceNotation("")).toBeNull();
      expect(parseDiceNotation("abc")).toBeNull();
      expect(parseDiceNotation("1d7")).toBeNull(); // invalid sides
      expect(parseDiceNotation("-2d6")).toBeNull(); // negative dice count
      expect(parseDiceNotation("25d6")).toBeNull(); // exceeds 20 dice
      expect(parseDiceNotation("1d20 + foo")).toBeNull();
    });
  });

  describe("formatDiceFormula", () => {
    it("formats dice and positive modifier", () => {
      expect(formatDiceFormula([{ count: 2, sides: 6 }], 4)).toBe("2d6+4");
    });

    it("formats dice and negative modifier", () => {
      expect(formatDiceFormula([{ count: 1, sides: 20 }], -2)).toBe("1d20-2");
    });

    it("formats dice without modifier", () => {
      expect(formatDiceFormula([{ count: 1, sides: 8 }], 0)).toBe("1d8");
    });

    it("formats multi-term dice", () => {
      expect(
        formatDiceFormula(
          [
            { count: 1, sides: 20 },
            { count: 1, sides: 4 },
          ],
          2,
        ),
      ).toBe("1d20+1d4+2");
    });
  });

  describe("BUILTIN_ROLL_TEMPLATES", () => {
    it("defines all 9 built-ins with deterministic GUIDs", () => {
      expect(BUILTIN_ROLL_TEMPLATES).toHaveLength(9);
      expect(BUILTIN_ROLL_TEMPLATE_IDS.D4).toBe("d0000000-0000-0000-0000-000000000101");
      expect(BUILTIN_ROLL_TEMPLATE_IDS.D6).toBe("d0000000-0000-0000-0000-000000000102");
      expect(BUILTIN_ROLL_TEMPLATE_IDS.D8).toBe("d0000000-0000-0000-0000-000000000103");
      expect(BUILTIN_ROLL_TEMPLATE_IDS.D10).toBe("d0000000-0000-0000-0000-000000000104");
      expect(BUILTIN_ROLL_TEMPLATE_IDS.D12).toBe("d0000000-0000-0000-0000-000000000105");
      expect(BUILTIN_ROLL_TEMPLATE_IDS.D20).toBe("d0000000-0000-0000-0000-000000000106");
      expect(BUILTIN_ROLL_TEMPLATE_IDS.D20_ADVANTAGE).toBe("d0000000-0000-0000-0000-000000000107");
      expect(BUILTIN_ROLL_TEMPLATE_IDS.D20_DISADVANTAGE).toBe(
        "d0000000-0000-0000-0000-000000000108",
      );
      expect(BUILTIN_ROLL_TEMPLATE_IDS.D100).toBe("d0000000-0000-0000-0000-000000000109");

      for (const t of BUILTIN_ROLL_TEMPLATES) {
        expect(t.id).toMatch(/^d0000000-0000-0000-0000-00000000010[1-9]$/);
      }
    });

    it("has expected roll modes for Advantage and Disadvantage templates", () => {
      const adv = BUILTIN_ROLL_TEMPLATES.find(
        (t) => t.id === BUILTIN_ROLL_TEMPLATE_IDS.D20_ADVANTAGE,
      );
      const dis = BUILTIN_ROLL_TEMPLATES.find(
        (t) => t.id === BUILTIN_ROLL_TEMPLATE_IDS.D20_DISADVANTAGE,
      );
      expect(adv?.mode).toBe("Advantage");
      expect(dis?.mode).toBe("Disadvantage");
    });
  });
});
