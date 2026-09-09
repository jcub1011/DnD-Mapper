import { describe, expect, it } from "vitest";
import {
  getModifier,
  isFullMap,
  resolveAttributeContribution,
  resolveAttributeValue,
  resolveEffectiveMaxHp,
  type CharacterSheet,
  type CustomTemplate,
  type DndMapperState,
  type StatusEffect,
} from "./domain";
import { applyIntent, createState } from "./rules";

const ROSTER = [
  { id: "dm-1", displayName: "Dungeon Master" },
  { id: "player-1", displayName: "Alice" },
];

function setupMatch(): DndMapperState {
  const state = createState(ROSTER);
  // DM creates initial map
  const res = applyIntent(state, "dm-1", { kind: "createMap", name: "Dungeon Level 1" }, 1000);
  return res!.state;
}

describe("Character Sheet Domain & Rules (Phase 6)", () => {
  describe("getModifier", () => {
    it("accurately computes Math.floor((score - 10) / 2) for odd and even scores", () => {
      expect(getModifier({ kind: "Score", value: 10 })).toBe(0);
      expect(getModifier({ kind: "Score", value: 11 })).toBe(0);
      expect(getModifier({ kind: "Score", value: 12 })).toBe(1);
      expect(getModifier({ kind: "Score", value: 13 })).toBe(1);
      expect(getModifier({ kind: "Score", value: 9 })).toBe(-1);
      expect(getModifier({ kind: "Score", value: 8 })).toBe(-1);
      expect(getModifier({ kind: "Score", value: 20 })).toBe(5);
      expect(getModifier({ kind: "Score", value: 1 })).toBe(-5);
      // Modifier returns its own value
      expect(getModifier({ kind: "Modifier", value: 3 })).toBe(3);
      // Text returns 0
      expect(getModifier({ kind: "Text", value: "Heroic" })).toBe(0);
    });
  });

  describe("resolveEffectiveMaxHp", () => {
    it("returns null if sheet maxHp is null", () => {
      const sheet: CharacterSheet = {
        id: "sheet-1",
        ownerUserId: null,
        representsUserId: null,
        characterName: "Fighter",
        values: {},
        notes: "",
        hp: null,
        maxHp: null,
        armorClass: null,
        color: "#f00",
        scopedMapId: null,
        statusEffects: [],
        rollTemplates: [],
      };
      expect(resolveEffectiveMaxHp(sheet)).toBeNull();
    });

    it("applies positive and negative status effect deltas to baseMaxHp", () => {
      const effect1: StatusEffect = {
        id: "eff-1",
        name: "Aid",
        attributeDeltas: [],
        maxHpDelta: 5,
        onApplyHpDelta: null,
        notes: "",
        appliedUtc: "2026-09-09T00:00:00Z",
      };
      const effect2: StatusEffect = {
        id: "eff-2",
        name: "Drain",
        attributeDeltas: [],
        maxHpDelta: -8,
        onApplyHpDelta: null,
        notes: "",
        appliedUtc: "2026-09-09T00:00:00Z",
      };

      const sheet: CharacterSheet = {
        id: "sheet-1",
        ownerUserId: null,
        representsUserId: null,
        characterName: "Fighter",
        values: {},
        notes: "",
        hp: 20,
        maxHp: 20,
        armorClass: 15,
        color: "#f00",
        scopedMapId: null,
        statusEffects: [effect1, effect2],
        rollTemplates: [],
      };

      // 20 + 5 - 8 = 17
      expect(resolveEffectiveMaxHp(sheet)).toBe(17);
    });
  });

  describe("resolveAttributeContribution", () => {
    it("accumulates attribute deltas from active status effects and computes effective modifier", () => {
      const effect: StatusEffect = {
        id: "eff-str",
        name: "Gauntlets of Ogre Power",
        attributeDeltas: [{ attributeName: "Strength", delta: 4 }],
        maxHpDelta: null,
        onApplyHpDelta: null,
        notes: "",
        appliedUtc: "2026-09-09T00:00:00Z",
      };

      const sheet: CharacterSheet = {
        id: "sheet-1",
        ownerUserId: null,
        representsUserId: null,
        characterName: "Barbarian",
        values: { Strength: { kind: "Score", value: 14 } },
        notes: "",
        hp: 30,
        maxHp: 30,
        armorClass: 14,
        color: "#f00",
        scopedMapId: null,
        statusEffects: [effect],
        rollTemplates: [],
      };

      const result = resolveAttributeContribution(sheet, "Strength", { kind: "Score", value: 14 });
      expect(result.effectiveValue).toEqual({ kind: "Score", value: 18 });
      expect(result.effectiveModifier).toBe(4); // (18 - 10) / 2 = 4
      expect(result.valueBreakdown).toEqual([
        { source: "Strength", delta: 14 },
        { source: "Gauntlets of Ogre Power", delta: 4 },
      ]);
    });
  });

  describe("createSheet Intent", () => {
    it("initializes default schema values, null HP/AC, and empty status effects", () => {
      const state = setupMatch();
      const res = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "Valeros" },
        1000,
      );
      expect(res).not.toBeNull();
      const sheet = Object.values(res!.state.sheets).find((s) => s.characterName === "Valeros");
      expect(sheet).toBeDefined();
      expect(sheet!.characterName).toBe("Valeros");
      expect(sheet!.hp).toBeNull();
      expect(sheet!.maxHp).toBeNull();
      expect(sheet!.armorClass).toBeNull();
      expect(sheet!.statusEffects).toEqual([]);
      // Default schema is DnD5eCore (6 abilities default to 10)
      expect(sheet!.values["Strength"]).toEqual({ kind: "Score", value: 10 });
      expect(sheet!.values["Dexterity"]).toEqual({ kind: "Score", value: 10 });
      expect(res!.patch).toEqual({ kind: "sheet", sheet: sheet! });
    });
  });

  describe("updateAttributeValues Intent", () => {
    it("updates scores and preserves schema structure", () => {
      let state = setupMatch();
      const createRes = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "Valeros" },
        1000,
      );
      state = createRes!.state;
      const sheetId = Object.keys(state.sheets)[0];

      const updateRes = applyIntent(
        state,
        "dm-1",
        {
          kind: "updateAttributeValues",
          sheetId,
          values: {
            Strength: { kind: "Score", value: 16 },
            Dexterity: { kind: "Score", value: 14 },
          },
        },
        1001,
      );

      expect(updateRes).not.toBeNull();
      const updatedSheet = updateRes!.state.sheets[sheetId];
      expect(updatedSheet.values["Strength"]).toEqual({ kind: "Score", value: 16 });
      expect(updatedSheet.values["Dexterity"]).toEqual({ kind: "Score", value: 14 });
      expect(resolveAttributeValue(updatedSheet, "Strength")).toEqual({ kind: "Score", value: 16 });
    });
  });

  describe("onApplyHpDelta Semantics", () => {
    it("adjusts current HP upon applying status effect and is not reversed upon removal", () => {
      let state = setupMatch();
      const createRes = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "Fighter" },
        1000,
      );
      state = createRes!.state;
      const sheetId = Object.keys(state.sheets)[0];

      // Set HP to 25 / 30
      state = applyIntent(state, "dm-1", { kind: "setSheetMaxHp", sheetId, maxHp: 30 }, 1001)!.state;
      state = applyIntent(state, "dm-1", { kind: "setSheetHp", sheetId, hp: 25 }, 1002)!.state;
      expect(state.sheets[sheetId].hp).toBe(25);

      // Apply effect with onApplyHpDelta = -6 (e.g. initial venom damage)
      const applyRes = applyIntent(
        state,
        "dm-1",
        {
          kind: "applyStatusEffect",
          sheetId,
          effect: {
            name: "Venom Strike",
            attributeDeltas: [],
            maxHpDelta: null,
            onApplyHpDelta: -6,
            notes: "Takes 6 immediate poison damage",
          },
        },
        1003,
      );

      expect(applyRes).not.toBeNull();
      state = applyRes!.state;
      // Current HP is 25 - 6 = 19
      expect(state.sheets[sheetId].hp).toBe(19);
      const effectId = state.sheets[sheetId].statusEffects[0].id;

      // Remove the effect
      const removeRes = applyIntent(
        state,
        "dm-1",
        { kind: "removeStatusEffect", sheetId, effectId },
        1004,
      );

      expect(removeRes).not.toBeNull();
      state = removeRes!.state;
      // onApplyHpDelta is one-time and NOT reversed on removal!
      expect(state.sheets[sheetId].hp).toBe(19);
      expect(state.sheets[sheetId].statusEffects).toHaveLength(0);
    });

    it("clamps HP to effectiveMaxHp when maxHp is reduced", () => {
      let state = setupMatch();
      const createRes = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "Hero" },
        1000,
      );
      state = createRes!.state;
      const sheetId = Object.keys(state.sheets)[0];

      state = applyIntent(state, "dm-1", { kind: "setSheetMaxHp", sheetId, maxHp: 20 }, 1001)!.state;
      state = applyIntent(state, "dm-1", { kind: "setSheetHp", sheetId, hp: 20 }, 1002)!.state;

      // Apply status effect reducing maxHpDelta by -5 (effective max becomes 15)
      state = applyIntent(
        state,
        "dm-1",
        {
          kind: "applyStatusEffect",
          sheetId,
          effect: {
            name: "Curse of Frailty",
            attributeDeltas: [],
            maxHpDelta: -5,
            onApplyHpDelta: null,
            notes: "",
          },
        },
        1003,
      )!.state;

      // Current HP must be clamped to effectiveMaxHp (15)
      expect(state.sheets[sheetId].hp).toBe(15);
    });
  });

  describe("duplicateSheet Intent", () => {
    it("generates fresh GUIDs and clones attribute values cleanly", () => {
      let state = setupMatch();
      state = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "Original" },
        1000,
      )!.state;
      const sheetId = Object.keys(state.sheets)[0];
      state = applyIntent(state, "dm-1", { kind: "setSheetMaxHp", sheetId, maxHp: 40 }, 1001)!.state;
      state = applyIntent(state, "dm-1", { kind: "setSheetHp", sheetId, hp: 35 }, 1002)!.state;

      const dupRes = applyIntent(state, "dm-1", { kind: "duplicateSheet", sheetId }, 1003);
      expect(dupRes).not.toBeNull();
      state = dupRes!.state;

      const sheetIds = Object.keys(state.sheets);
      expect(sheetIds).toHaveLength(2);
      const duplicateId = sheetIds.find((id) => id !== sheetId)!;
      const duplicate = state.sheets[duplicateId];

      expect(duplicate.id).not.toBe(sheetId);
      expect(duplicate.characterName).toBe("Original (copy)");
      expect(duplicate.maxHp).toBe(40);
      expect(duplicate.hp).toBe(35);
      expect(duplicate.values).toEqual(state.sheets[sheetId].values);
    });
  });

  describe("deleteSheet Intent", () => {
    it("removes sheet and unlinks any tokens referencing sheetId", () => {
      let state = setupMatch();
      const mapId = state.activeMapId!;
      // Create sheet
      state = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "To Delete" },
        1000,
      )!.state;
      const sheetId = Object.keys(state.sheets)[0];

      // Spawn token linked to sheet
      state = applyIntent(
        state,
        "dm-1",
        {
          kind: "spawnToken",
          mapId,
          token: {
            type: "PlayerToken",
            name: "Linked Token",
            color: "#4a90e2",
            iconKind: "Initial",
            mapId,
            x: 2,
            y: 2,
            sheetId,
            hidden: false,
          },
        },
        1001,
      )!.state;

      const activeMap = state.maps.filter(isFullMap).find((m) => m.id === mapId)!;
      const token = activeMap.tokens.find((t) => t.sheetId === sheetId);
      expect(token).toBeDefined();

      // Delete sheet
      const delRes = applyIntent(state, "dm-1", { kind: "deleteSheet", sheetId }, 1002);
      expect(delRes).not.toBeNull();
      state = delRes!.state;

      expect(state.sheets[sheetId]).toBeUndefined();
      const updatedMap = state.maps.filter(isFullMap).find((m) => m.id === mapId)!;
      const unlinkedToken = updatedMap.tokens.find((t) => t.id === token!.id);
      expect(unlinkedToken).toBeDefined();
      expect(unlinkedToken!.sheetId).toBeNull();
    });
  });

  describe("Custom Templates (Presets)", () => {
    it("supports creating, updating, applying, duplicating, and deleting custom character templates", () => {
      let state = setupMatch();

      // 1. Create custom template
      const createRes = applyIntent(
        state,
        "dm-1",
        {
          kind: "createCustomTemplate",
          template: {
            name: "Goblin Archer",
            description: "Low-level minion with shortbow",
            values: {
              Dexterity: { kind: "Score", value: 14 },
              Strength: { kind: "Score", value: 8 },
            },
            maxHp: 7,
            armorClass: 13,
            color: "#2ecc71",
            notes: "Nimble escape: disengage or hide as bonus action.",
            statusEffectTemplates: [],
            rollTemplates: [],
          },
        },
        1000,
      );

      expect(createRes).not.toBeNull();
      state = createRes!.state;
      const templateId = Object.keys(state.customTemplates)[0];
      const template = state.customTemplates[templateId];
      expect(template.name).toBe("Goblin Archer");

      // 2. Update custom template
      state = applyIntent(
        state,
        "dm-1",
        {
          kind: "updateCustomTemplate",
          templateId,
          patch: { armorClass: 14 },
        },
        1001,
      )!.state;
      expect((state.customTemplates[templateId] as CustomTemplate).armorClass).toBe(14);

      // 3. Apply custom template to spawn a sheet
      const applyRes = applyIntent(
        state,
        "dm-1",
        {
          kind: "applyCustomTemplate",
          templateId,
          characterName: "Goblin Scout 1",
        },
        1002,
      );
      expect(applyRes).not.toBeNull();
      state = applyRes!.state;
      const sheet = Object.values(state.sheets).find((s) => s.characterName === "Goblin Scout 1")!;
      expect(sheet).toBeDefined();
      expect(sheet.maxHp).toBe(7);
      expect(sheet.hp).toBe(7);
      expect(sheet.armorClass).toBe(14);
      expect(sheet.color).toBe("#2ecc71");
      expect(sheet.notes).toBe("Nimble escape: disengage or hide as bonus action.");

      // 4. Duplicate custom template
      state = applyIntent(state, "dm-1", { kind: "duplicateCustomTemplate", templateId }, 1003)!.state;
      expect(Object.keys(state.customTemplates)).toHaveLength(2);

      // 5. Delete custom template
      state = applyIntent(state, "dm-1", { kind: "deleteCustomTemplate", templateId }, 1004)!.state;
      expect(state.customTemplates[templateId]).toBeUndefined();
    });
  });
});
