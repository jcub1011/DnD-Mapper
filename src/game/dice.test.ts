import { describe, expect, it } from "vitest";
import {
  buildDiceNotation,
  executeRoll,
  filterVisibleRolls,
  formatDiceFormula,
  isNatural1,
  isNatural20,
  parseDiceNotation,
} from "./dice.js";
import type { CharacterSheet, DndMapperState, RollResult } from "./domain.js";
import { createDefaultDndMapperState } from "./domain.js";

describe("parseDiceNotation & formatDiceFormula", () => {
  it("parses single die notations", () => {
    const parsed = parseDiceNotation("1d20");
    expect(parsed).toEqual({
      dice: [{ count: 1, sides: 20 }],
      flatModifier: 0,
    });
    expect(formatDiceFormula(parsed!.dice, parsed!.flatModifier)).toBe("1d20");
  });

  it("parses multiple dice terms with positive flat modifier", () => {
    const parsed = parseDiceNotation("2d6 + 1d4 + 5");
    expect(parsed).toEqual({
      dice: [
        { count: 2, sides: 6 },
        { count: 1, sides: 4 },
      ],
      flatModifier: 5,
    });
    expect(formatDiceFormula(parsed!.dice, parsed!.flatModifier)).toBe("2d6+1d4+5");
  });

  it("parses negative flat modifier", () => {
    const parsed = parseDiceNotation("1d12 - 3");
    expect(parsed).toEqual({
      dice: [{ count: 1, sides: 12 }],
      flatModifier: -3,
    });
    expect(formatDiceFormula(parsed!.dice, parsed!.flatModifier)).toBe("1d12-3");
  });

  it("returns null for invalid formulas", () => {
    expect(parseDiceNotation("abc")).toBeNull();
    expect(parseDiceNotation("")).toBeNull();
    expect(parseDiceNotation("0d6")).toBeNull();
    expect(parseDiceNotation("1d0")).toBeNull();
  });
});

describe("buildDiceNotation", () => {
  it("generates single @ notation for single die", () => {
    const roll: RollResult = {
      id: "r1",
      rollerUserId: "u1",
      forcedByUserId: null,
      rolls: [{ sides: 20, value: 17 }],
      total: 17,
      mode: "Normal",
      flatModifier: 0,
      attributeModifier: 0,
      label: "Check",
      timestampUtc: "2026-09-09T12:00:00.000Z",
      formula: "1d20",
      modifierBreakdown: "",
      tokenId: null,
      appliedRules: [],
    };

    expect(buildDiceNotation(roll)).toBe("1d20@17");
  });

  it("generates comma-separated forced values for multiple dice of same type", () => {
    const roll: RollResult = {
      id: "r2",
      rollerUserId: "u1",
      forcedByUserId: null,
      rolls: [
        { sides: 6, value: 4 },
        { sides: 6, value: 5 },
      ],
      total: 9,
      mode: "Normal",
      flatModifier: 0,
      attributeModifier: 0,
      label: "Sneak Attack",
      timestampUtc: "2026-09-09T12:00:00.000Z",
      formula: "2d6",
      modifierBreakdown: "",
      tokenId: null,
      appliedRules: [],
    };

    expect(buildDiceNotation(roll)).toBe("2d6@4,5");
  });

  it("decomposes d100 into tens and units percentile pair", () => {
    const roll: RollResult = {
      id: "r3",
      rollerUserId: "u1",
      forcedByUserId: null,
      rolls: [{ sides: 100, value: 47 }],
      total: 47,
      mode: "Normal",
      flatModifier: 0,
      attributeModifier: 0,
      label: "Wild Magic",
      timestampUtc: "2026-09-09T12:00:00.000Z",
      formula: "1d100",
      modifierBreakdown: "",
      tokenId: null,
      appliedRules: [],
    };

    expect(buildDiceNotation(roll)).toBe("1d100+1d10@40,7");
  });

  it("decomposes d100 value 100 as 00 and 0", () => {
    const roll: RollResult = {
      id: "r4",
      rollerUserId: "u1",
      forcedByUserId: null,
      rolls: [{ sides: 100, value: 100 }],
      total: 100,
      mode: "Normal",
      flatModifier: 0,
      attributeModifier: 0,
      label: "Divine Intervention",
      timestampUtc: "2026-09-09T12:00:00.000Z",
      formula: "1d100",
      modifierBreakdown: "",
      tokenId: null,
      appliedRules: [],
    };

    expect(buildDiceNotation(roll)).toBe("1d100+1d10@0,0");
  });
});

describe("isNatural20 & isNatural1", () => {
  it("identifies a normal Natural 20", () => {
    const roll: RollResult = {
      id: "r1",
      rollerUserId: "u1",
      forcedByUserId: null,
      rolls: [{ sides: 20, value: 20 }],
      total: 25,
      mode: "Normal",
      flatModifier: 5,
      attributeModifier: 0,
      label: "Attack",
      timestampUtc: "2026-09-09T12:00:00.000Z",
      formula: "1d20+5",
      modifierBreakdown: "",
      tokenId: null,
      appliedRules: [],
    };

    expect(isNatural20(roll)).toBe(true);
    expect(isNatural1(roll)).toBe(false);
  });

  it("identifies a normal Natural 1", () => {
    const roll: RollResult = {
      id: "r2",
      rollerUserId: "u1",
      forcedByUserId: null,
      rolls: [{ sides: 20, value: 1 }],
      total: 6,
      mode: "Normal",
      flatModifier: 5,
      attributeModifier: 0,
      label: "Attack",
      timestampUtc: "2026-09-09T12:00:00.000Z",
      formula: "1d20+5",
      modifierBreakdown: "",
      tokenId: null,
      appliedRules: [],
    };

    expect(isNatural20(roll)).toBe(false);
    expect(isNatural1(roll)).toBe(true);
  });

  it("ignores discarded dice in advantage rolls", () => {
    // In Advantage, 1 was discarded, 20 was kept
    const rollAdv: RollResult = {
      id: "r3",
      rollerUserId: "u1",
      forcedByUserId: null,
      rolls: [
        { sides: 20, value: 1, discarded: true },
        { sides: 20, value: 20, discarded: false },
      ],
      total: 20,
      mode: "Advantage",
      flatModifier: 0,
      attributeModifier: 0,
      label: "Attack (Adv)",
      timestampUtc: "2026-09-09T12:00:00.000Z",
      formula: "1d20",
      modifierBreakdown: "",
      tokenId: null,
      appliedRules: [],
    };

    expect(isNatural20(rollAdv)).toBe(true);
    expect(isNatural1(rollAdv)).toBe(false);
  });

  it("recognizes natural 1 kept in disadvantage rolls", () => {
    // In Disadvantage, 20 was discarded, 1 was kept
    const rollDis: RollResult = {
      id: "r4",
      rollerUserId: "u1",
      forcedByUserId: null,
      rolls: [
        { sides: 20, value: 20, discarded: true },
        { sides: 20, value: 1, discarded: false },
      ],
      total: 1,
      mode: "Disadvantage",
      flatModifier: 0,
      attributeModifier: 0,
      label: "Attack (Dis)",
      timestampUtc: "2026-09-09T12:00:00.000Z",
      formula: "1d20",
      modifierBreakdown: "",
      tokenId: null,
      appliedRules: [],
    };

    expect(isNatural20(rollDis)).toBe(false);
    expect(isNatural1(rollDis)).toBe(true);
  });
});

describe("filterVisibleRolls", () => {
  const rollDm: RollResult = {
    id: "r-dm",
    rollerUserId: "dm-1",
    forcedByUserId: null,
    rolls: [{ sides: 20, value: 10 }],
    total: 10,
    mode: "Normal",
    flatModifier: 0,
    attributeModifier: 0,
    label: "Secret Trap",
    timestampUtc: "2026-09-09T12:00:00.000Z",
    formula: "1d20",
    modifierBreakdown: "",
    tokenId: null,
    appliedRules: [],
  };

  const rollP1: RollResult = {
    id: "r-p1",
    rollerUserId: "player-1",
    forcedByUserId: null,
    rolls: [{ sides: 20, value: 15 }],
    total: 15,
    mode: "Normal",
    flatModifier: 0,
    attributeModifier: 0,
    label: "Perception",
    timestampUtc: "2026-09-09T12:00:00.000Z",
    formula: "1d20",
    modifierBreakdown: "",
    tokenId: null,
    appliedRules: [],
  };

  it("returns all rolls when rollsVisibleToPlayers is true", () => {
    const visible = filterVisibleRolls([rollDm, rollP1], "player-1", false, true);
    expect(visible).toHaveLength(2);
  });

  it("returns all rolls to the DM even when rollsVisibleToPlayers is false", () => {
    const visible = filterVisibleRolls([rollDm, rollP1], "dm-1", true, false);
    expect(visible).toHaveLength(2);
  });

  it("filters out other players and DM rolls when rollsVisibleToPlayers is false", () => {
    const visible = filterVisibleRolls([rollDm, rollP1], "player-1", false, false);
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe("r-p1");
  });
});

describe("executeRoll", () => {
  const state: DndMapperState = {
    ...createDefaultDndMapperState(),
    sheets: {
      "sheet-1": {
        id: "sheet-1",
        ownerUserId: "player-1",
        representsUserId: "player-1",
        characterName: "Rogue",
        values: {
          DEX: { kind: "Score", value: 16 },
        },
        notes: "",
        hp: 20,
        maxHp: 20,
        armorClass: 14,
        color: "#123456",
        scopedMapId: null,
        statusEffects: [],
        rollTemplates: [],
      } as unknown as CharacterSheet,
    },
  };

  it("resolves a normal roll with formula, timestamp, and breakdown", () => {
    const res = executeRoll("1d20 + 3", "Normal", "player-1", {
      nowMs: 1788970000000,
      label: "Stealth",
      sheets: state.sheets,
    });

    expect(res).not.toBeNull();
    expect(res!.rollerUserId).toBe("player-1");
    expect(res!.formula).toBe("1d20+3");
    expect(res!.rolls).toHaveLength(1);
    expect(res!.rolls[0].sides).toBe(20);
    expect(res!.rolls[0].discarded).toBe(false);
    expect(res!.total).toBe(res!.rolls[0].value + 3);
    expect(res!.label).toBe("Stealth");
    expect(res!.timestampUtc).toBe(new Date(1788970000000).toISOString());
  });

  it("resolves advantage rolls on d20 by rolling 2 dice and discarding lower", () => {
    const res = executeRoll("1d20", "Advantage", "player-1", {
      nowMs: 1788970000000,
      sheets: state.sheets,
    });

    expect(res).not.toBeNull();
    expect(res!.rolls).toHaveLength(2);
    const kept = res!.rolls.filter((d) => !d.discarded);
    const discarded = res!.rolls.filter((d) => d.discarded);
    expect(kept).toHaveLength(1);
    expect(discarded).toHaveLength(1);
    expect(kept[0].value).toBeGreaterThanOrEqual(discarded[0].value);
    expect(res!.total).toBe(kept[0].value);
  });

  it("resolves disadvantage rolls on d20 by rolling 2 dice and discarding higher", () => {
    const res = executeRoll("1d20", "Disadvantage", "player-1", {
      nowMs: 1788970000000,
      sheets: state.sheets,
    });

    expect(res).not.toBeNull();
    expect(res!.rolls).toHaveLength(2);
    const kept = res!.rolls.filter((d) => !d.discarded);
    const discarded = res!.rolls.filter((d) => d.discarded);
    expect(kept).toHaveLength(1);
    expect(discarded).toHaveLength(1);
    expect(kept[0].value).toBeLessThanOrEqual(discarded[0].value);
    expect(res!.total).toBe(kept[0].value);
  });

  it("resolves attribute modifier from character sheet", () => {
    const res = executeRoll("1d20", "Normal", "player-1", {
      nowMs: 1788970000000,
      sheetId: "sheet-1",
      attributeName: "DEX",
      sheets: state.sheets,
    });

    expect(res).not.toBeNull();
    // DEX 16 has 5e modifier (16 - 10) / 2 = +3
    expect(res!.attributeModifier).toBe(3);
    expect(res!.total).toBe(res!.rolls[0].value + 3);
    expect(res!.modifierBreakdown).toContain("DEX");
  });
});
