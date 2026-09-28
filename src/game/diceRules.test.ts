import { describe, expect, it } from "vitest";
import { BUILTIN_ROLL_TEMPLATE_IDS } from "./dice.js";
import type { DndMapperState, RollTemplate } from "./domain.js";
import { applyIntent, createState } from "./rules.js";

const ROSTER = [
  { id: "dm-1", displayName: "Dungeon Master" },
  { id: "player-1", displayName: "Alice" },
  { id: "player-2", displayName: "Bob" },
];

function setupMatch(): DndMapperState {
  const state = createState(ROSTER);
  // Start session so phase is Playing
  const res = applyIntent(state, "dm-1", { kind: "startSession" }, 1000);
  return res!.state;
}

describe("Dice and Roll Log Rules Engine", () => {
  it("executes rollDice intent and appends to rollLog", () => {
    let state = setupMatch();
    const res = applyIntent(
      state,
      "player-1",
      {
        kind: "rollDice",
        formula: "1d20 + 2",
        mode: "Normal",
        label: "Initiative",
      },
      2000,
    );

    expect(res).not.toBeNull();
    expect(res!.patch).not.toBeNull();
    expect(res!.patch!.kind).toBe("roll");
    state = res!.state;

    expect(state.rollLog).toHaveLength(1);
    const roll = state.rollLog[0];
    expect(roll.rollerUserId).toBe("player-1");
    expect(roll.formula).toBe("1d20+2");
    expect(roll.label).toBe("Initiative");
    expect(roll.total).toBeGreaterThanOrEqual(3);
    expect(roll.total).toBeLessThanOrEqual(22);
  });

  it("enforces strict 50-roll FIFO cap in rollLog", () => {
    let state = setupMatch();

    // Roll 55 times
    for (let i = 0; i < 55; i++) {
      const res = applyIntent(
        state,
        "player-1",
        {
          kind: "rollDice",
          formula: "1d20",
          mode: "Normal",
          label: `Roll #${i}`,
        },
        2000 + i * 10,
      );
      expect(res).not.toBeNull();
      state = res!.state;
    }

    expect(state.rollLog).toHaveLength(50);
    // Oldest 5 rolls (0..4) were evicted; oldest remaining should be Roll #5
    expect(state.rollLog[0].label).toBe("Roll #5");
    // Latest roll should be Roll #54
    expect(state.rollLog[49].label).toBe("Roll #54");
  });

  it("allows DM to clear roll log, but rejects non-DM players", () => {
    let state = setupMatch();

    // Add a roll
    const rollRes = applyIntent(
      state,
      "player-1",
      {
        kind: "rollDice",
        formula: "1d20",
        mode: "Normal",
      },
      2000,
    );
    state = rollRes!.state;
    expect(state.rollLog).toHaveLength(1);

    // Non-DM player attempts to clear -> rejected
    const playerClear = applyIntent(state, "player-1", { kind: "clearRollLog" }, 2100);
    expect(playerClear).toBeNull();
    expect(state.rollLog).toHaveLength(1);

    // DM clears -> succeeds
    const dmClear = applyIntent(state, "dm-1", { kind: "clearRollLog" }, 2200);
    expect(dmClear).not.toBeNull();
    expect(dmClear!.patch).not.toBeNull();
    expect(dmClear!.patch!.kind).toBe("rollLogCleared");
    expect(dmClear!.state.rollLog).toHaveLength(0);
  });

  it("executes rollTemplate intent with built-in template", () => {
    let state = setupMatch();

    const res = applyIntent(
      state,
      "player-1",
      {
        kind: "rollTemplate",
        templateId: BUILTIN_ROLL_TEMPLATE_IDS.D20,
        modeOverride: "Advantage",
      },
      2000,
    );

    expect(res).not.toBeNull();
    expect(res!.patch!.kind).toBe("roll");
    state = res!.state;
    expect(state.rollLog).toHaveLength(1);
    const roll = state.rollLog[0];
    expect(roll.mode).toBe("Advantage");
    expect(roll.formula).toBe("1d20");
  });

  it("manages global roll templates (DM only)", () => {
    let state = setupMatch();

    const newTemplate: Omit<RollTemplate, "id" | "scope"> = {
      name: "Dragon Breath",
      dice: [{ count: 8, sides: 6 }],
      flatModifier: 0,
      mode: "Normal",
      attributeName: null,
      label: "Fire Damage",
    };

    // Player cannot create global template
    const playerCreate = applyIntent(
      state,
      "player-1",
      {
        kind: "createGlobalRollTemplate",
        template: newTemplate,
      },
      2000,
    );
    expect(playerCreate).toBeNull();

    // DM creates global template
    const dmCreate = applyIntent(
      state,
      "dm-1",
      {
        kind: "createGlobalRollTemplate",
        template: newTemplate,
      },
      2000,
    );
    expect(dmCreate).not.toBeNull();
    expect(dmCreate!.patch!.kind).toBe("globalRollTemplates");
    state = dmCreate!.state;
    expect(state.globalRollTemplates).toHaveLength(1);
    const createdId = state.globalRollTemplates[0].id;
    expect(state.globalRollTemplates[0].name).toBe("Dragon Breath");
    expect(state.globalRollTemplates[0].scope).toBe("Global");

    // DM updates global template
    const dmUpdate = applyIntent(
      state,
      "dm-1",
      {
        kind: "updateGlobalRollTemplate",
        templateId: createdId,
        patch: { name: "Ancient Dragon Breath", flatModifier: 10 },
      },
      2100,
    );
    expect(dmUpdate).not.toBeNull();
    state = dmUpdate!.state;
    expect(state.globalRollTemplates[0].name).toBe("Ancient Dragon Breath");
    expect(state.globalRollTemplates[0].flatModifier).toBe(10);

    // DM deletes global template
    const dmDelete = applyIntent(
      state,
      "dm-1",
      {
        kind: "deleteGlobalRollTemplate",
        templateId: createdId,
      },
      2200,
    );
    expect(dmDelete).not.toBeNull();
    state = dmDelete!.state;
    expect(state.globalRollTemplates).toHaveLength(0);
  });

  it("manages sheet roll templates", () => {
    let state = setupMatch();

    // Allow owners to edit sheets
    const settingsRes = applyIntent(
      state,
      "dm-1",
      {
        kind: "updateSettings",
        patch: { sheetEditByOthers: "OwnersAndHost" },
      },
      1500,
    );
    state = settingsRes!.state;

    // Create a sheet for player-1
    const createSheetRes = applyIntent(
      state,
      "dm-1",
      {
        kind: "createSheet",
        characterName: "Ranger",
      },
      2000,
    );
    state = createSheetRes!.state;
    const sheetId = Object.keys(state.sheets)[0];

    // Assign sheet to player-1
    const assignRes = applyIntent(
      state,
      "dm-1",
      {
        kind: "assignSheetOwner",
        sheetId,
        ownerUserId: "player-1",
      },
      2050,
    );
    state = assignRes!.state;

    const sheetTemplate: Omit<RollTemplate, "id" | "scope"> = {
      name: "Longbow Attack",
      dice: [{ count: 1, sides: 20 }],
      flatModifier: 2,
      mode: "Normal",
      attributeName: null,
      label: "Pierce",
    };

    // Player-1 creates sheet template
    const createRes = applyIntent(
      state,
      "player-1",
      {
        kind: "createRollTemplate",
        sheetId,
        template: sheetTemplate,
      },
      2100,
    );
    expect(createRes).not.toBeNull();
    state = createRes!.state;
    expect(state.sheets[sheetId].rollTemplates).toHaveLength(1);
    const tmplId = state.sheets[sheetId].rollTemplates[0].id;
    expect(state.sheets[sheetId].rollTemplates[0].name).toBe("Longbow Attack");
    expect(state.sheets[sheetId].rollTemplates[0].scope).toBe("Sheet");

    // Player-1 updates sheet template
    const updateRes = applyIntent(
      state,
      "player-1",
      {
        kind: "updateRollTemplate",
        sheetId,
        templateId: tmplId,
        patch: { flatModifier: 4 },
      },
      2200,
    );
    expect(updateRes).not.toBeNull();
    state = updateRes!.state;
    expect(state.sheets[sheetId].rollTemplates[0].flatModifier).toBe(4);

    // Player-2 (not owner, not DM) cannot delete template
    const player2Delete = applyIntent(
      state,
      "player-2",
      {
        kind: "deleteRollTemplate",
        sheetId,
        templateId: tmplId,
      },
      2300,
    );
    expect(player2Delete).toBeNull();

    // Player-1 deletes template
    const deleteRes = applyIntent(
      state,
      "player-1",
      {
        kind: "deleteRollTemplate",
        sheetId,
        templateId: tmplId,
      },
      2400,
    );
    expect(deleteRes).not.toBeNull();
    state = deleteRes!.state;
    expect(state.sheets[sheetId].rollTemplates).toHaveLength(0);
  });

  describe("Loaded Dice Rules Engine", () => {
    it("allows DM to manage loaded dice rules and rejects non-DM players", () => {
      let state = setupMatch();

      const newRule = {
        name: "Force Natural 20",
        enabled: true,
        targetSheetIds: [],
        conditions: [{ $kind: "hostKeyHeld" as const, key: "SPACE" }],
        modifications: [{ $kind: "setResult" as const, value: 20 }],
      };

      // Non-DM cannot create rule
      const playerCreate = applyIntent(
        state,
        "player-1",
        { kind: "createLoadedDiceRule", rule: newRule },
        3000,
      );
      expect(playerCreate).toBeNull();

      // DM creates rule
      const dmCreate = applyIntent(
        state,
        "dm-1",
        { kind: "createLoadedDiceRule", rule: newRule },
        3000,
      );
      expect(dmCreate).not.toBeNull();
      expect(dmCreate!.patch!.kind).toBe("loadedDiceRules");
      state = dmCreate!.state;
      expect(state.loadedDiceRules).toHaveLength(1);
      const ruleId = state.loadedDiceRules[0].id;
      expect(state.loadedDiceRules[0].name).toBe("Force Natural 20");

      // Non-DM cannot update rule
      const playerUpdate = applyIntent(
        state,
        "player-1",
        { kind: "updateLoadedDiceRule", ruleId, patch: { name: "Hacked" } },
        3100,
      );
      expect(playerUpdate).toBeNull();

      // DM updates rule
      const dmUpdate = applyIntent(
        state,
        "dm-1",
        { kind: "updateLoadedDiceRule", ruleId, patch: { name: "Divine 20" } },
        3100,
      );
      expect(dmUpdate).not.toBeNull();
      state = dmUpdate!.state;
      expect(state.loadedDiceRules[0].name).toBe("Divine 20");

      // DM toggles rule
      const dmToggle = applyIntent(
        state,
        "dm-1",
        { kind: "toggleLoadedDiceRule", ruleId, enabled: false },
        3200,
      );
      expect(dmToggle).not.toBeNull();
      state = dmToggle!.state;
      expect(state.loadedDiceRules[0].enabled).toBe(false);

      // DM reorders rules
      const rule2 = {
        name: "Floor at 5",
        enabled: true,
        targetSheetIds: [],
        conditions: [],
        modifications: [{ $kind: "clampMin" as const, min: 5 }],
      };
      const dmCreate2 = applyIntent(
        state,
        "dm-1",
        { kind: "createLoadedDiceRule", rule: rule2 },
        3300,
      );
      state = dmCreate2!.state;
      expect(state.loadedDiceRules).toHaveLength(2);
      const rule2Id = state.loadedDiceRules[1].id;

      const dmReorder = applyIntent(
        state,
        "dm-1",
        { kind: "reorderLoadedDiceRules", ruleIds: [rule2Id, ruleId] },
        3400,
      );
      expect(dmReorder).not.toBeNull();
      state = dmReorder!.state;
      expect(state.loadedDiceRules[0].id).toBe(rule2Id);
      expect(state.loadedDiceRules[1].id).toBe(ruleId);

      // DM deletes rule
      const dmDelete = applyIntent(
        state,
        "dm-1",
        { kind: "deleteLoadedDiceRule", ruleId },
        3500,
      );
      expect(dmDelete).not.toBeNull();
      state = dmDelete!.state;
      expect(state.loadedDiceRules).toHaveLength(1);
      expect(state.loadedDiceRules[0].id).toBe(rule2Id);
    });

    it("allows DM to stream host keys and rejects non-DM players", () => {
      let state = setupMatch();

      // Non-DM cannot stream host keys
      const playerStream = applyIntent(
        state,
        "player-1",
        { kind: "updateHostKeys", heldKeys: ["SPACE"] },
        3000,
      );
      expect(playerStream).toBeNull();
      expect(state.hostHeldKeys).toHaveLength(0);

      // DM streams host keys
      const dmStream = applyIntent(
        state,
        "dm-1",
        { kind: "updateHostKeys", heldKeys: ["space", "h"] },
        3000,
      );
      expect(dmStream).not.toBeNull();
      expect(dmStream!.patch!.kind).toBe("hostKeys");
      state = dmStream!.state;
      expect(state.hostHeldKeys).toEqual(["SPACE", "H"]);

      // DM releases keys
      const dmRelease = applyIntent(
        state,
        "dm-1",
        { kind: "updateHostKeys", heldKeys: [] },
        3100,
      );
      expect(dmRelease).not.toBeNull();
      expect(dmRelease!.state.hostHeldKeys).toEqual([]);
    });

    it("applies active loaded dice rules during roll execution", () => {
      let state = setupMatch();

      // Enable loaded dice in settings
      const settingsRes = applyIntent(
        state,
        "dm-1",
        { kind: "updateSettings", patch: { loadedDiceEnabled: true } },
        3000,
      );
      state = settingsRes!.state;

      // Create rule: Spacebar forces d20 to 20
      const createRuleRes = applyIntent(
        state,
        "dm-1",
        {
          kind: "createLoadedDiceRule",
          rule: {
            name: "Spacebar Force 20",
            enabled: true,
            targetSheetIds: [],
            conditions: [
              { $kind: "diceTypeRolled", sides: 20 },
              { $kind: "hostKeyHeld", key: "SPACE" },
            ],
            modifications: [{ $kind: "setResult", value: 20 }],
          },
        },
        3100,
      );
      state = createRuleRes!.state;

      // Roll WITHOUT Space held -> normal roll (could be anything 1..20)
      const rollNormalRes = applyIntent(
        state,
        "player-1",
        { kind: "rollDice", formula: "1d20", mode: "Normal" },
        3200,
      );
      state = rollNormalRes!.state;
      expect(state.rollLog[0].appliedRules).toHaveLength(0);

      // DM presses Spacebar
      const keyRes = applyIntent(
        state,
        "dm-1",
        { kind: "updateHostKeys", heldKeys: ["SPACE"] },
        3300,
      );
      state = keyRes!.state;

      // Player rolls 1d20 while DM holds Spacebar -> forced to 20!
      const rollTamperedRes = applyIntent(
        state,
        "player-1",
        { kind: "rollDice", formula: "1d20+2", mode: "Normal" },
        3400,
      );
      expect(rollTamperedRes).not.toBeNull();
      state = rollTamperedRes!.state;

      const tamperedRoll = state.rollLog[state.rollLog.length - 1];
      expect(tamperedRoll.total).toBe(22); // 20 + 2
      expect(tamperedRoll.rolls[0].value).toBe(20);
      expect(tamperedRoll.appliedRules).toHaveLength(1);
      const stamp = tamperedRoll.appliedRules[0] as { ruleName: string; modificationType: string };
      expect(stamp.ruleName).toBe("Spacebar Force 20");
      expect(stamp.modificationType).toBe("setResult");
    });

    it("respects target sheet scoping on rolls", () => {
      let state = setupMatch();

      // Enable loaded dice
      state = applyIntent(
        state,
        "dm-1",
        { kind: "updateSettings", patch: { loadedDiceEnabled: true } },
        3000,
      )!.state;

      // Create sheet
      state = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "Fighter" },
        3100,
      )!.state;
      const sheetId = Object.keys(state.sheets)[0];

      // Create rule targeted specifically at sheetId: setResult 18
      state = applyIntent(
        state,
        "dm-1",
        {
          kind: "createLoadedDiceRule",
          rule: {
            name: "Fighter Bless",
            enabled: true,
            targetSheetIds: [sheetId],
            conditions: [],
            modifications: [{ $kind: "setResult", value: 18 }],
          },
        },
        3200,
      )!.state;

      // Roll with sheetId -> should be modified
      state = applyIntent(
        state,
        "player-1",
        { kind: "rollDice", formula: "1d20", mode: "Normal", sheetId },
        3300,
      )!.state;
      const sheetRoll = state.rollLog[state.rollLog.length - 1];
      expect(sheetRoll.total).toBe(18);
      expect(sheetRoll.appliedRules).toHaveLength(1);

      // Roll without sheetId (unlinked) -> should NOT be modified
      state = applyIntent(
        state,
        "player-1",
        { kind: "rollDice", formula: "1d20", mode: "Normal" },
        3400,
      )!.state;
      const unlinkedRoll = state.rollLog[state.rollLog.length - 1];
      expect(unlinkedRoll.appliedRules).toHaveLength(0);
    });
  });
});
