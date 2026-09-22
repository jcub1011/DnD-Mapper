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
import { seedColorForName } from "./color";
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
        colorOverridden: false,
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
        colorOverridden: false,
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
        colorOverridden: false,
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
      // Color is seeded from the sheet name until manually overridden.
      expect(sheet!.colorOverridden).toBe(false);
      expect(sheet!.color).toBe(seedColorForName("Valeros"));
      // N:1 binding: sheets are created tokenless — no token spawns alongside.
      if (res!.patch?.kind !== "sheet") throw new Error("expected sheet patch");
      const map = res!.state.maps.filter(isFullMap).find((m) => m.id === res!.state.activeMapId)!;
      expect(map.tokens.filter((t) => t.sheetId === sheet!.id)).toHaveLength(0);
    });

    it("places a token for the sheet via spawnToken with its sheetId", () => {
      let state = setupMatch();
      const mapId = state.activeMapId!;
      state = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "Valeros" },
        1000,
      )!.state;
      const sheetId = Object.keys(state.sheets)[0];
      state = applyIntent(
        state,
        "dm-1",
        {
          kind: "spawnToken",
          mapId,
          token: {
            type: "NPCToken",
            name: "ignored",
            color: "#000000",
            iconKind: "Initial",
            x: 3,
            y: 3,
            sheetId,
            hidden: false,
          },
        },
        1001,
      )!.state;
      const token = state.maps
        .filter(isFullMap)
        .find((m) => m.id === mapId)!
        .tokens.find((t) => t.sheetId === sheetId)!;
      // The placed token inherits the sheet's identity.
      expect(token.name).toBe("Valeros");
      expect(token.color).toBe(state.sheets[sheetId].color);
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
    function placeToken(
      state: DndMapperState,
      mapId: string,
      sheetId: string,
      x = 2,
      y = 2,
    ): DndMapperState {
      return applyIntent(
        state,
        "dm-1",
        {
          kind: "spawnToken",
          mapId,
          token: {
            type: "NPCToken",
            name: "x",
            color: "#000000",
            iconKind: "Initial",
            x,
            y,
            sheetId,
            hidden: false,
          },
        },
        1001,
      )!.state;
    }

    it("removes sheet and deletes ALL of its tokens across maps (N:1 binding)", () => {
      let state = setupMatch();
      const mapId = state.activeMapId!;
      // Create sheet, then place two tokens for it on two maps.
      state = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "To Delete" },
        1000,
      )!.state;
      const sheetId = Object.keys(state.sheets)[0];
      state = placeToken(state, mapId, sheetId, 2, 2);
      state = applyIntent(state, "dm-1", { kind: "createMap", name: "Second" }, 1002)!.state;
      const secondMapId = state.maps.filter(isFullMap).find((m) => m.name === "Second")!.id;
      state = placeToken(state, secondMapId, sheetId, 4, 4);

      for (const id of [mapId, secondMapId]) {
        const m = state.maps.filter(isFullMap).find((m) => m.id === id)!;
        expect(m.tokens.filter((t) => t.sheetId === sheetId)).toHaveLength(1);
      }

      // Delete sheet
      const delRes = applyIntent(state, "dm-1", { kind: "deleteSheet", sheetId }, 1003);
      expect(delRes).not.toBeNull();
      state = delRes!.state;

      expect(state.sheets[sheetId]).toBeUndefined();
      for (const id of [mapId, secondMapId]) {
        const m = state.maps.filter(isFullMap).find((m) => m.id === id)!;
        expect(m.tokens.filter((t) => t.sheetId === sheetId)).toHaveLength(0);
      }
    });

    it("keeps the sheet when one of its tokens is deleted", () => {
      let state = setupMatch();
      const mapId = state.activeMapId!;
      state = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "Survivor" },
        1000,
      )!.state;
      const sheetId = Object.keys(state.sheets)[0];
      state = placeToken(state, mapId, sheetId, 2, 2);
      state = placeToken(state, mapId, sheetId, 5, 5);
      const tokens = state.maps
        .filter(isFullMap)
        .find((m) => m.id === mapId)!
        .tokens.filter((t) => t.sheetId === sheetId);
      expect(tokens).toHaveLength(2);

      const delRes = applyIntent(
        state,
        "dm-1",
        { kind: "deleteToken", tokenId: tokens[0].id },
        1002,
      );
      expect(delRes).not.toBeNull();
      state = delRes!.state;

      // The sheet and the sibling token survive.
      expect(state.sheets[sheetId]).toBeDefined();
      const remaining = state.maps
        .filter(isFullMap)
        .find((m) => m.id === mapId)!
        .tokens.filter((t) => t.sheetId === sheetId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(tokens[1].id);
    });
  });

  describe("Token ↔ Sheet N:1 Binding", () => {
    function setupPaired(characterName = "Aria"): {
      state: DndMapperState;
      sheetId: string;
      tokenId: string;
      mapId: string;
    } {
      let state = setupMatch();
      const mapId = state.activeMapId!;
      state = applyIntent(state, "dm-1", { kind: "createSheet", characterName }, 1000)!.state;
      const sheetId = Object.keys(state.sheets)[0];
      state = applyIntent(
        state,
        "dm-1",
        {
          kind: "spawnToken",
          mapId,
          token: {
            type: "NPCToken",
            name: "x",
            color: "#000000",
            iconKind: "Initial",
            x: 2,
            y: 2,
            sheetId,
            hidden: false,
          },
        },
        1001,
      )!.state;
      const token = state.maps
        .filter(isFullMap)
        .find((m) => m.id === mapId)!
        .tokens.find((t) => t.sheetId === sheetId)!;
      return { state, sheetId, tokenId: token.id, mapId };
    }

    function boundToken(state: DndMapperState, mapId: string, sheetId: string) {
      return state.maps
        .filter(isFullMap)
        .find((m) => m.id === mapId)!
        .tokens.find((t) => t.sheetId === sheetId)!;
    }

    function boundTokens(state: DndMapperState, sheetId: string) {
      return state.maps
        .filter(isFullMap)
        .flatMap((m) => m.tokens)
        .filter((t) => t.sheetId === sheetId);
    }

    function placeToken(
      state: DndMapperState,
      mapId: string,
      sheetId: string,
      x = 6,
      y = 6,
    ): DndMapperState {
      return applyIntent(
        state,
        "dm-1",
        {
          kind: "spawnToken",
          mapId,
          token: {
            type: "NPCToken",
            name: "x",
            color: "#000000",
            iconKind: "Initial",
            x,
            y,
            sheetId,
            hidden: false,
          },
        },
        1001,
      )!.state;
    }

    it("seeds the sheet color from the sheet name; placed tokens inherit it", () => {
      const { state, sheetId, mapId } = setupPaired("Aria");
      const sheet = state.sheets[sheetId];
      expect(sheet.colorOverridden).toBe(false);
      expect(sheet.color).toBe(seedColorForName("Aria"));
      expect(boundToken(state, mapId, sheetId).color).toBe(sheet.color);
    });

    it("propagates sheet rename to ALL tokens and reseeds color while not overridden", () => {
      const bindingSetup = setupPaired("Aria");
      const { sheetId, mapId } = bindingSetup;
      let state = placeToken(bindingSetup.state, mapId, sheetId, 7, 7);
      expect(boundTokens(state, sheetId)).toHaveLength(2);
      state = applyIntent(
        state,
        "dm-1",
        { kind: "updateSheet", sheetId, patch: { characterName: "Borin" } },
        1002,
      )!.state;

      const sheet = state.sheets[sheetId];
      expect(sheet.characterName).toBe("Borin");
      expect(sheet.colorOverridden).toBe(false);
      expect(sheet.color).toBe(seedColorForName("Borin"));
      for (const token of boundTokens(state, sheetId)) {
        expect(token.name).toBe("Borin");
        expect(token.color).toBe(sheet.color);
      }
    });

    it("freezes the color on explicit pick; later renames keep the manual color", () => {
      const bindingSetup = setupPaired("Aria");
      const { sheetId, mapId } = bindingSetup;
      let state = bindingSetup.state;
      state = applyIntent(
        state,
        "dm-1",
        { kind: "updateSheet", sheetId, patch: { color: "#112233" } },
        1001,
      )!.state;
      expect(state.sheets[sheetId].colorOverridden).toBe(true);

      state = applyIntent(
        state,
        "dm-1",
        { kind: "updateSheet", sheetId, patch: { characterName: "Borin" } },
        1002,
      )!.state;
      const sheet = state.sheets[sheetId];
      expect(sheet.characterName).toBe("Borin");
      expect(sheet.color).toBe("#112233");
      const token = boundToken(state, mapId, sheetId);
      expect(token.name).toBe("Borin");
      expect(token.color).toBe("#112233");
    });

    it("mirrors token name/color edits onto the sheet and all sibling tokens", () => {
      const bindingSetup = setupPaired("Aria");
      const { sheetId, mapId, tokenId } = bindingSetup;
      let state = placeToken(bindingSetup.state, mapId, sheetId, 7, 7);
      state = applyIntent(
        state,
        "dm-1",
        { kind: "updateToken", tokenId, patch: { name: "Aria the Bold", color: "#445566" } },
        1002,
      )!.state;

      const sheet = state.sheets[sheetId];
      expect(sheet.characterName).toBe("Aria the Bold");
      expect(sheet.color).toBe("#445566");
      expect(sheet.colorOverridden).toBe(true);
      for (const token of boundTokens(state, sheetId)) {
        expect(token.name).toBe("Aria the Bold");
        expect(token.color).toBe("#445566");
      }
    });

    it("assigning the sheet cascades ownership to ALL of its tokens", () => {
      const bindingSetup = setupPaired("Aria");
      const { sheetId, mapId } = bindingSetup;
      let state = placeToken(bindingSetup.state, mapId, sheetId, 7, 7);

      // Assign the sheet → every token follows (and becomes a player token).
      state = applyIntent(
        state,
        "dm-1",
        { kind: "assignCharacterToPlayer", sheetId, playerId: "player-1" },
        1002,
      )!.state;
      expect(state.sheets[sheetId].ownerUserId).toBe("player-1");
      for (const token of boundTokens(state, sheetId)) {
        expect(token.ownerUserId).toBe("player-1");
        expect(token.type).toBe("PlayerToken");
      }
    });

    it("reassigning one token re-links ONLY that token to the target sheet", () => {
      const bindingSetup = setupPaired("Aria");
      const { sheetId, mapId } = bindingSetup;
      let state = placeToken(bindingSetup.state, mapId, sheetId, 7, 7);
      // Aria's sheet owns two tokens; give both to player-1 via the sheet.
      state = applyIntent(
        state,
        "dm-1",
        { kind: "assignCharacterToPlayer", sheetId, playerId: "player-1" },
        1002,
      )!.state;
      // Create Bob's sheet (player-2 owns it via DM assign).
      state = applyIntent(state, "dm-1", { kind: "createSheet", characterName: "Bob" }, 1003)!.state;
      const bobSheetId = Object.keys(state.sheets).find((id) => id !== sheetId)!;
      state = applyIntent(
        state,
        "dm-1",
        { kind: "assignCharacterToPlayer", sheetId: bobSheetId, playerId: "player-2" },
        1004,
      )!.state;

      const ariaTokens = boundTokens(state, sheetId);
      expect(ariaTokens).toHaveLength(2);
      // Move exactly one of Aria's tokens to Bob's sheet.
      state = applyIntent(
        state,
        "dm-1",
        { kind: "reassignTokenSheet", tokenId: ariaTokens[0].id, sheetId: bobSheetId },
        1005,
      )!.state;

      const moved = state.maps
        .filter(isFullMap)
        .find((m) => m.id === mapId)!
        .tokens.find((t) => t.id === ariaTokens[0].id)!;
      expect(moved.sheetId).toBe(bobSheetId);
      expect(moved.ownerUserId).toBe("player-2");
      expect(moved.type).toBe("PlayerToken");
      expect(moved.name).toBe("Bob");
      // The sibling stays on Aria's sheet, untouched.
      const stayed = state.maps
        .filter(isFullMap)
        .find((m) => m.id === mapId)!
        .tokens.find((t) => t.id === ariaTokens[1].id)!;
      expect(stayed.sheetId).toBe(sheetId);
      expect(stayed.ownerUserId).toBe("player-1");
      expect(stayed.name).toBe("Aria");
      // Neither sheet changed owners.
      expect(state.sheets[sheetId].ownerUserId).toBe("player-1");
      expect(state.sheets[bobSheetId].ownerUserId).toBe("player-2");
    });

    it("unassigning one token keeps the sheet and siblings intact", () => {
      const bindingSetup = setupPaired("Aria");
      const { sheetId, mapId } = bindingSetup;
      let state = placeToken(bindingSetup.state, mapId, sheetId, 7, 7);
      state = applyIntent(
        state,
        "dm-1",
        { kind: "assignCharacterToPlayer", sheetId, playerId: "player-1" },
        1002,
      )!.state;
      const ariaTokens = boundTokens(state, sheetId);
      state = applyIntent(
        state,
        "dm-1",
        { kind: "reassignTokenSheet", tokenId: ariaTokens[0].id, sheetId: null },
        1003,
      )!.state;
      const unassigned = state.maps
        .filter(isFullMap)
        .find((m) => m.id === mapId)!
        .tokens.find((t) => t.id === ariaTokens[0].id)!;
      expect(unassigned.ownerUserId).toBeNull();
      expect(unassigned.type).toBe("NPCToken");
      expect(unassigned.sheetId).toBeNull();
      expect(unassigned.representsUserId).toBeNull();
      // Sheet and sibling untouched.
      expect(state.sheets[sheetId].ownerUserId).toBe("player-1");
      const sibling = state.maps
        .filter(isFullMap)
        .find((m) => m.id === mapId)!
        .tokens.find((t) => t.id === ariaTokens[1].id)!;
      expect(sibling.ownerUserId).toBe("player-1");
      expect(sibling.type).toBe("PlayerToken");
    });

    it("rejects reassigning to an unknown sheet", () => {
      const { state, tokenId } = setupPaired("Aria");
      const res = applyIntent(
        state,
        "dm-1",
        { kind: "reassignTokenSheet", tokenId, sheetId: "sheet-missing" },
        1002,
      );
      expect(res).toBeNull();
    });

    it("duplicateSheet clones the sheet without spawning a token", () => {
      const bindingSetup = setupPaired("Aria");
      const { sheetId, mapId } = bindingSetup;
      let state = bindingSetup.state;
      state = applyIntent(state, "dm-1", { kind: "duplicateSheet", sheetId }, 1002)!.state;

      const ids = Object.keys(state.sheets);
      expect(ids).toHaveLength(2);
      const cloneId = ids.find((id) => id !== sheetId)!;
      expect(state.sheets[cloneId].characterName).toBe("Aria (copy)");
      // No token for the clone; original pair untouched.
      expect(boundTokens(state, cloneId)).toHaveLength(0);
      expect(boundToken(state, mapId, sheetId).name).toBe("Aria");
    });

    it("duplicateToken clones the token for the SAME sheet", () => {
      const bindingSetup = setupPaired("Aria");
      const { sheetId, mapId, tokenId } = bindingSetup;
      let state = bindingSetup.state;
      state = applyIntent(state, "dm-1", { kind: "duplicateToken", tokenId }, 1002)!.state;

      // No new sheet — the clone shares Aria's sheet.
      expect(Object.keys(state.sheets)).toHaveLength(1);
      const tokens = boundTokens(state, sheetId);
      expect(tokens).toHaveLength(2);
      const clone = tokens.find((t) => t.id !== tokenId)!;
      expect(clone.name).toBe("Aria");
      expect(clone.color).toBe(state.sheets[sheetId].color);
      expect(clone.x).not.toBe(boundToken(state, mapId, sheetId).x);
    });

    it("spawnToken without a sheet creates the counterpart sheet", () => {
      let state = setupMatch();
      const mapId = state.activeMapId!;
      state = applyIntent(
        state,
        "dm-1",
        {
          kind: "spawnToken",
          mapId,
          token: {
            type: "NPCToken",
            name: "Goblin",
            color: "#00ff00",
            iconKind: "Initial",
            x: 2,
            y: 2,
            sheetId: null,
            hidden: false,
          },
        },
        1000,
      )!.state;

      const sheetId = Object.keys(state.sheets)[0];
      const sheet = state.sheets[sheetId];
      expect(sheet.characterName).toBe("Goblin");
      expect(sheet.color).toBe("#00ff00");
      expect(sheet.colorOverridden).toBe(true);
      expect(boundToken(state, mapId, sheetId).name).toBe("Goblin");
    });

    it("createSheet with an explicit color marks the pair overridden", () => {
      let state = setupMatch();
      state = applyIntent(
        state,
        "dm-1",
        { kind: "createSheet", characterName: "Mira", color: "#abcdef" },
        1000,
      )!.state;
      const sheet = Object.values(state.sheets)[0];
      expect(sheet.color).toBe("#abcdef");
      expect(sheet.colorOverridden).toBe(true);
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
