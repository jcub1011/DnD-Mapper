import { describe, expect, it } from "vitest";
import {
  GM_TARGET_ID,
  type DieRoll,
  type LoadedDiceCondition,
  type LoadedDiceContext,
  type LoadedDiceRule,
} from "./domain.js";
import {
  applyModifications,
  evaluateCondition,
  isRuleApplicable,
  processLoadedDice,
} from "./loadedDice.js";

const DEFAULT_CTX: LoadedDiceContext = {
  roll: {
    sides: 20,
    mode: "Normal",
    label: "Attack Roll",
    sheetId: "sheet-1",
    rollerUserId: "user-1",
  },
  activeMapId: "map-1",
  isCombatActive: true,
  hostHeldKeys: ["SPACE", "H"],
};

describe("Loaded Dice Condition Evaluation", () => {
  it("handles currentMap condition", () => {
    const matchCond: LoadedDiceCondition = { $kind: "currentMap", mapId: "map-1" };
    const mismatchCond: LoadedDiceCondition = { $kind: "currentMap", mapId: "map-2" };

    expect(evaluateCondition(matchCond, DEFAULT_CTX)).toBe(true);
    expect(evaluateCondition(mismatchCond, DEFAULT_CTX)).toBe(false);
  });

  it("handles diceTypeRolled condition", () => {
    const d20Cond: LoadedDiceCondition = { $kind: "diceTypeRolled", sides: 20 };
    const d6Cond: LoadedDiceCondition = { $kind: "diceTypeRolled", sides: 6 };

    expect(evaluateCondition(d20Cond, DEFAULT_CTX)).toBe(true);
    expect(evaluateCondition(d6Cond, DEFAULT_CTX)).toBe(false);
  });

  it("handles rollerIs condition for character sheets and GM unlinked rolls", () => {
    const sheetCond: LoadedDiceCondition = { $kind: "rollerIs", sheetId: "sheet-1" };
    const otherCond: LoadedDiceCondition = { $kind: "rollerIs", sheetId: "sheet-2" };
    const gmCond: LoadedDiceCondition = { $kind: "rollerIs", sheetId: GM_TARGET_ID };

    expect(evaluateCondition(sheetCond, DEFAULT_CTX)).toBe(true);
    expect(evaluateCondition(otherCond, DEFAULT_CTX)).toBe(false);
    expect(evaluateCondition(gmCond, DEFAULT_CTX)).toBe(false);

    const gmCtx: LoadedDiceContext = {
      ...DEFAULT_CTX,
      roll: { ...DEFAULT_CTX.roll, sheetId: null },
    };
    expect(evaluateCondition(gmCond, gmCtx)).toBe(true);
    expect(evaluateCondition(sheetCond, gmCtx)).toBe(false);
  });

  it("handles rollModeIs condition", () => {
    const normalCond: LoadedDiceCondition = { $kind: "rollModeIs", mode: "Normal" };
    const advCond: LoadedDiceCondition = { $kind: "rollModeIs", mode: "Advantage" };

    expect(evaluateCondition(normalCond, DEFAULT_CTX)).toBe(true);
    expect(evaluateCondition(advCond, DEFAULT_CTX)).toBe(false);
  });

  it("handles combatActive condition", () => {
    const cond: LoadedDiceCondition = { $kind: "combatActive" };

    expect(evaluateCondition(cond, DEFAULT_CTX)).toBe(true);
    expect(evaluateCondition(cond, { ...DEFAULT_CTX, isCombatActive: false })).toBe(false);
  });

  it("handles rollLabelContains condition (case-insensitive)", () => {
    const attackCond: LoadedDiceCondition = {
      $kind: "rollLabelContains",
      substring: "attack",
    };
    const saveCond: LoadedDiceCondition = {
      $kind: "rollLabelContains",
      substring: "saving",
    };

    expect(evaluateCondition(attackCond, DEFAULT_CTX)).toBe(true);
    expect(evaluateCondition(saveCond, DEFAULT_CTX)).toBe(false);
  });

  it("handles hostKeyHeld condition (case-insensitive and normalized)", () => {
    const spaceCond: LoadedDiceCondition = { $kind: "hostKeyHeld", key: "space" };
    const hCond: LoadedDiceCondition = { $kind: "hostKeyHeld", key: "H" };
    const shiftCond: LoadedDiceCondition = { $kind: "hostKeyHeld", key: "SHIFT" };

    expect(evaluateCondition(spaceCond, DEFAULT_CTX)).toBe(true);
    expect(evaluateCondition(hCond, DEFAULT_CTX)).toBe(true);
    expect(evaluateCondition(shiftCond, DEFAULT_CTX)).toBe(false);
  });

  it("handles compound allOf, anyOf, and not conditions", () => {
    const allMatch: LoadedDiceCondition = {
      $kind: "allOf",
      conditions: [
        { $kind: "diceTypeRolled", sides: 20 },
        { $kind: "combatActive" },
        { $kind: "hostKeyHeld", key: "SPACE" },
      ],
    };
    expect(evaluateCondition(allMatch, DEFAULT_CTX)).toBe(true);

    const allPartialMismatch: LoadedDiceCondition = {
      $kind: "allOf",
      conditions: [
        { $kind: "diceTypeRolled", sides: 20 },
        { $kind: "hostKeyHeld", key: "ALT" },
      ],
    };
    expect(evaluateCondition(allPartialMismatch, DEFAULT_CTX)).toBe(false);

    const anyMatch: LoadedDiceCondition = {
      $kind: "anyOf",
      conditions: [
        { $kind: "diceTypeRolled", sides: 6 },
        { $kind: "hostKeyHeld", key: "SPACE" },
      ],
    };
    expect(evaluateCondition(anyMatch, DEFAULT_CTX)).toBe(true);

    const anyNone: LoadedDiceCondition = {
      $kind: "anyOf",
      conditions: [
        { $kind: "diceTypeRolled", sides: 6 },
        { $kind: "hostKeyHeld", key: "Z" },
      ],
    };
    expect(evaluateCondition(anyNone, DEFAULT_CTX)).toBe(false);

    const notCond: LoadedDiceCondition = {
      $kind: "not",
      condition: { $kind: "diceTypeRolled", sides: 6 },
    };
    expect(evaluateCondition(notCond, DEFAULT_CTX)).toBe(true);
  });
});

describe("Loaded Dice Rule Applicability & Scoping", () => {
  it("respects enabled flag", () => {
    const rule: LoadedDiceRule = {
      id: "rule-1",
      name: "Force 20",
      enabled: false,
      targetSheetIds: [],
      conditions: [],
      modifications: [{ $kind: "setResult", value: 20 }],
    };
    expect(isRuleApplicable(rule, DEFAULT_CTX)).toBe(false);
  });

  it("applies to all sheets when targetSheetIds is empty", () => {
    const rule: LoadedDiceRule = {
      id: "rule-1",
      name: "Universal Floor",
      enabled: true,
      targetSheetIds: [],
      conditions: [],
      modifications: [{ $kind: "clampMin", min: 10 }],
    };
    expect(isRuleApplicable(rule, DEFAULT_CTX)).toBe(true);
  });

  it("targets specific sheets and GM unlinked rolls", () => {
    const sheetRule: LoadedDiceRule = {
      id: "rule-1",
      name: "Player 1 Boost",
      enabled: true,
      targetSheetIds: ["sheet-1"],
      conditions: [],
      modifications: [{ $kind: "setResult", value: 18 }],
    };
    const sheet2Rule: LoadedDiceRule = {
      id: "rule-2",
      name: "Player 2 Boost",
      enabled: true,
      targetSheetIds: ["sheet-2"],
      conditions: [],
      modifications: [{ $kind: "setResult", value: 18 }],
    };
    const gmRule: LoadedDiceRule = {
      id: "rule-3",
      name: "GM Tamper",
      enabled: true,
      targetSheetIds: [GM_TARGET_ID],
      conditions: [],
      modifications: [{ $kind: "setResult", value: 18 }],
    };

    expect(isRuleApplicable(sheetRule, DEFAULT_CTX)).toBe(true);
    expect(isRuleApplicable(sheet2Rule, DEFAULT_CTX)).toBe(false);
    expect(isRuleApplicable(gmRule, DEFAULT_CTX)).toBe(false);

    const gmCtx: LoadedDiceContext = {
      ...DEFAULT_CTX,
      roll: { ...DEFAULT_CTX.roll, sheetId: null },
    };
    expect(isRuleApplicable(gmRule, gmCtx)).toBe(true);
    expect(isRuleApplicable(sheetRule, gmCtx)).toBe(false);
  });
});

describe("Loaded Dice Modification Pipeline", () => {
  it("setResult forces total and respects clamping to [1, sides]", () => {
    const dice: DieRoll[] = [{ sides: 20, value: 5 }];
    const res = applyModifications(dice, [{ $kind: "setResult", value: 20 }]);
    expect(res.rolls[0].value).toBe(20);
    expect(res.modified).toBe(true);

    // Over-max clamped to 20
    const overRes = applyModifications(dice, [{ $kind: "setResult", value: 99 }]);
    expect(overRes.rolls[0].value).toBe(20);

    // Sub-1 clamped to 1
    const underRes = applyModifications(dice, [{ $kind: "setResult", value: -5 }]);
    expect(underRes.rolls[0].value).toBe(1);
  });

  it("clampMin and clampMax bound face values correctly", () => {
    const lowRoll: DieRoll[] = [{ sides: 20, value: 3 }];
    const minRes = applyModifications(lowRoll, [{ $kind: "clampMin", min: 10 }]);
    expect(minRes.rolls[0].value).toBe(10);

    const highRoll: DieRoll[] = [{ sides: 20, value: 18 }];
    const maxRes = applyModifications(highRoll, [{ $kind: "clampMax", max: 12 }]);
    expect(maxRes.rolls[0].value).toBe(12);

    // Inside range untouched
    const midRoll: DieRoll[] = [{ sides: 20, value: 11 }];
    const boundRes = applyModifications(midRoll, [
      { $kind: "clampMin", min: 5 },
      { $kind: "clampMax", max: 15 },
    ]);
    expect(boundRes.rolls[0].value).toBe(11);
    expect(boundRes.modified).toBe(false);
  });

  it("biasLower rolls extra dice and takes lowest", () => {
    const roll: DieRoll[] = [{ sides: 20, value: 15 }];
    // Fake rng returns sequence: 0.1 -> 3, 0.4 -> 9
    const values = [0.1, 0.4];
    let idx = 0;
    const fakeRng = () => values[idx++] ?? 0.5;

    const res = applyModifications(
      roll,
      [{ $kind: "biasLower", rerollCount: 2 }],
      fakeRng,
    );
    // min(15, 3, 9) = 3
    expect(res.rolls[0].value).toBe(3);
  });

  it("biasHigher rolls extra dice and takes highest", () => {
    const roll: DieRoll[] = [{ sides: 20, value: 8 }];
    // Fake rng returns sequence: 0.85 -> 18, 0.5 -> 11
    const values = [0.85, 0.5];
    let idx = 0;
    const fakeRng = () => values[idx++] ?? 0.5;

    const res = applyModifications(
      roll,
      [{ $kind: "biasHigher", rerollCount: 2 }],
      fakeRng,
    );
    // max(8, 18, 11) = 18
    expect(res.rolls[0].value).toBe(18);
  });

  it("rerollOn rerolls when matching trigger and preserves non-trigger rolls", () => {
    const nat1: DieRoll[] = [{ sides: 20, value: 1 }];
    // rng returns 0.95 -> 20
    const res = applyModifications(
      nat1,
      [{ $kind: "rerollOn", values: [1] }],
      () => 0.95,
    );
    expect(res.rolls[0].value).toBe(20);

    const nat10: DieRoll[] = [{ sides: 20, value: 10 }];
    const res10 = applyModifications(
      nat10,
      [{ $kind: "rerollOn", values: [1] }],
      () => 0.95,
    );
    expect(res10.rolls[0].value).toBe(10);
    expect(res10.modified).toBe(false);
  });

  it("executes multiple rules in priority order and records stamps", () => {
    const rolls: DieRoll[] = [{ sides: 20, value: 5 }];

    const rules: LoadedDiceRule[] = [
      {
        id: "rule-floor",
        name: "Floor at 10",
        enabled: true,
        targetSheetIds: [],
        conditions: [],
        modifications: [{ $kind: "clampMin", min: 10 }],
      },
      {
        id: "rule-space",
        name: "Spacebar Force 18",
        enabled: true,
        targetSheetIds: [],
        conditions: [{ $kind: "hostKeyHeld", key: "SPACE" }],
        modifications: [{ $kind: "setResult", value: 18 }],
      },
    ];

    const result = processLoadedDice(rolls, rules, DEFAULT_CTX);

    expect(result.rolls[0].value).toBe(18);
    expect(result.appliedRules).toHaveLength(2);
    expect(result.appliedRules[0].ruleId).toBe("rule-floor");
    expect(result.appliedRules[0].modificationType).toBe("clampMin");
    expect(result.appliedRules[1].ruleId).toBe("rule-space");
    expect(result.appliedRules[1].modificationType).toBe("setResult");
  });
});
