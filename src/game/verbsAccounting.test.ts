import { describe, expect, it } from "vitest";
import type { DndMapperState, GameMap } from "./domain.js";
import {
  createDefaultAttributeSchema,
  createDefaultDndMapperState,
  createDefaultGridConfig,
} from "./domain.js";
import { applyIntent } from "./rules.js";
import type { Intent } from "./types.js";

function makeVerbsState(): DndMapperState {
  const base = createDefaultDndMapperState();
  const map: GameMap = {
    id: "map-1",
    name: "Map 1",
    grid: createDefaultGridConfig(),
    images: [
      {
        id: "img-1",
        name: "Test Image",
        contentType: "image/png",
        shareToken: null,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        originalWidth: 100,
        originalHeight: 100,
        rotation: 0,
        layerOrder: 0,
        opacity: 1,
        hidden: false,
        locked: false,
        byteSize: 1000,
        wasDownscaled: false,
        originalLongEdgePx: 100,
        displayLongEdgePx: 100,
      },
    ],
    tokens: [
      {
        id: "tok-1",
        type: "PlayerToken",
        ownerUserId: "dm-user",
        representsUserId: null,
        name: "Token 1",
        color: "#f00",
        iconKind: "Initial",
        mapId: "map-1",
        x: 1,
        y: 1,
        sheetId: "sheet-1",
        hidden: false,
      },
    ],
    createdUtc: "2026-09-08T00:00:00.000Z",
    listOrder: 0,
    defaultSpawnPosition: { x: 0, y: 0 },
    markupSvg: "<svg></svg>",
    fogMask: "",
  };

  return {
    ...base,
    phase: "Playing",
    dmPlayerId: "dm-user",
    activeMapId: "map-1",
    maps: [map],
    attributeSchema: createDefaultAttributeSchema("DnD5eCore"),
    sheets: {
      "sheet-1": {
        id: "sheet-1",
        characterName: "Sheet 1",
        ownerUserId: "dm-user",
        representsUserId: null,
        color: "#f00",
        colorOverridden: false,
        scopedMapId: null,
        hp: 20,
        maxHp: 20,
        armorClass: 10,
        notes: "",
        values: {},
        statusEffects: [],
        rollTemplates: [],
      },
    },
    statusEffectTemplates: {
      "tmpl-1": {
        id: "tmpl-1",
        name: "Poisoned",
        notes: "Disadvantage",
        attributeDeltas: [],
        maxHpDelta: null,
        onApplyHpDelta: null,
      },
    },
    customTemplates: {
      "ct-1": {
        id: "ct-1",
        name: "Goblin",
        description: "NPC",
        maxHp: 7,
        armorClass: 15,
        values: {},
        notes: "",
        color: "#f00",
        rollTemplates: [],
        statusEffectTemplates: [],
      },
    },
    globalRollTemplates: [
      {
        id: "grt-1",
        name: "D20",
        dice: [{ count: 1, sides: 20 }],
        flatModifier: 0,
        mode: "Normal",
        attributeName: null,
        label: "D20",
        scope: "Global",
      },
    ],
    loadedDiceRules: [
      {
        id: "ldr-1",
        name: "Nat1 Rule",
        enabled: true,
        targetSheetIds: [],
        conditions: [{ $kind: "rollLabelContains", substring: "Nat1" }],
        modifications: [{ $kind: "rerollOn", values: [1] }],
      },
    ],
  };
}

describe("84 Authority Verbs Complete Accounting", () => {
  const dm = "dm-user";

  const all84Verbs: {
    category: string;
    verb: string;
    makeIntent: (state: DndMapperState) => Intent;
  }[] = [
    // 1. Maps (8)
    { category: "Maps", verb: "createMap", makeIntent: () => ({ kind: "createMap", name: "New Map" }) },
    { category: "Maps", verb: "switchMap", makeIntent: () => ({ kind: "switchMap", mapId: "map-1" }) },
    { category: "Maps", verb: "renameMap", makeIntent: () => ({ kind: "renameMap", mapId: "map-1", name: "Renamed" }) },
    { category: "Maps", verb: "reorderMaps", makeIntent: () => ({ kind: "reorderMaps", order: ["map-1"] }) },
    { category: "Maps", verb: "setGridConfig", makeIntent: () => ({ kind: "setGridConfig", mapId: "map-1", grid: createDefaultGridConfig() }) },
    { category: "Maps", verb: "duplicateMap", makeIntent: () => ({ kind: "duplicateMap", mapId: "map-1" }) },
    { category: "Maps", verb: "exportMapImage", makeIntent: () => ({ kind: "exportMapImage", mapId: "map-1" }) },
    { category: "Maps", verb: "deleteMap", makeIntent: () => ({ kind: "deleteMap", mapId: "map-1" }) },

    // 2. Fog of War (5)
    { category: "Fog of War", verb: "setFogBitset", makeIntent: () => ({ kind: "setFogBitset", mapId: "map-1", mask: "AQ==" }) },
    { category: "Fog of War", verb: "fillFog", makeIntent: () => ({ kind: "fillFog", mapId: "map-1" }) },
    { category: "Fog of War", verb: "clearFog", makeIntent: () => ({ kind: "clearFog", mapId: "map-1" }) },
    { category: "Fog of War", verb: "revealAllFog", makeIntent: () => ({ kind: "revealAllFog", mapId: "map-1" }) },
    { category: "Fog of War", verb: "hideAllFog", makeIntent: () => ({ kind: "hideAllFog", mapId: "map-1" }) },

    // 3. Tokens (8)
    {
      category: "Tokens",
      verb: "createToken",
      makeIntent: () => ({
        kind: "createToken",
        mapId: "map-1",
        token: {
          type: "NPCToken",
          name: "New Token",
          color: "#0f0",
          iconKind: "Initial",
          x: 2,
          y: 2,
          sheetId: null,
          hidden: false,
        },
      }),
    },
    { category: "Tokens", verb: "moveToken", makeIntent: () => ({ kind: "moveToken", tokenId: "tok-1", x: 3, y: 3 }) },
    { category: "Tokens", verb: "updateToken", makeIntent: () => ({ kind: "updateToken", tokenId: "tok-1", patch: { name: "Updated" } }) },
    { category: "Tokens", verb: "reorderTokens", makeIntent: () => ({ kind: "reorderTokens", mapId: "map-1", tokenIds: ["tok-1"] }) },
    { category: "Tokens", verb: "duplicateToken", makeIntent: () => ({ kind: "duplicateToken", tokenId: "tok-1" }) },
    { category: "Tokens", verb: "spawnPlayerToken", makeIntent: () => ({ kind: "spawnPlayerToken", playerId: "p-2", name: "Player 2" }) },
    { category: "Tokens", verb: "reassignTokenSheet", makeIntent: () => ({ kind: "reassignTokenSheet", tokenId: "tok-1", sheetId: "sheet-1" }) },
    { category: "Tokens", verb: "deleteToken", makeIntent: () => ({ kind: "deleteToken", tokenId: "tok-1" }) },

    // 4. Images (5)
    {
      category: "Images",
      verb: "placeImage",
      makeIntent: () => ({
        kind: "placeImage",
        mapId: "map-1",
        image: {
          name: "Placed",
          contentType: "image/png",
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          originalWidth: 50,
          originalHeight: 50,
          rotation: 0,
          opacity: 1,
          hidden: false,
          locked: false,
          byteSize: 1000,
          wasDownscaled: false,
          originalLongEdgePx: 50,
          displayLongEdgePx: 50,
        },
      }),
    },
    { category: "Images", verb: "transformImage", makeIntent: () => ({ kind: "transformImage", imageId: "img-1", x: 20, y: 10, width: 100, height: 100, rotation: 0 }) },
    { category: "Images", verb: "reorderImages", makeIntent: () => ({ kind: "reorderImages", imageId: "img-1", layerOrder: 1 }) },
    { category: "Images", verb: "lockImage", makeIntent: () => ({ kind: "lockImage", imageId: "img-1", locked: true }) },
    { category: "Images", verb: "deleteImage", makeIntent: () => ({ kind: "deleteImage", imageId: "img-1" }) },

    // 5. Focus (2)
    { category: "Focus", verb: "setFocusRect", makeIntent: () => ({ kind: "setFocusRect", rect: { mapId: "map-1", x: 0, y: 0, width: 100, height: 100 } }) },
    { category: "Focus", verb: "clearFocusRect", makeIntent: () => ({ kind: "clearFocusRect" }) },

    // 6. Saves (3)
    { category: "Saves", verb: "saveCampaign", makeIntent: () => ({ kind: "saveCampaign", slotId: "slot-1", name: "Slot 1" }) },
    { category: "Saves", verb: "loadCampaign", makeIntent: () => ({ kind: "loadCampaign", slotId: "slot-1" }) },
    { category: "Saves", verb: "deleteCampaignSave", makeIntent: () => ({ kind: "deleteCampaignSave", slotId: "slot-1" }) },

    // 7. Sheets (10)
    { category: "Sheets", verb: "createSheet", makeIntent: () => ({ kind: "createSheet", characterName: "New Sheet", scopedMapId: null }) },
    { category: "Sheets", verb: "updateSheet", makeIntent: () => ({ kind: "updateSheet", sheetId: "sheet-1", patch: { characterName: "Updated Sheet" } }) },
    { category: "Sheets", verb: "duplicateSheet", makeIntent: () => ({ kind: "duplicateSheet", sheetId: "sheet-1" }) },
    { category: "Sheets", verb: "assignSheetOwner", makeIntent: () => ({ kind: "assignSheetOwner", sheetId: "sheet-1", ownerUserId: "user-2" }) },
    { category: "Sheets", verb: "assignCharacterToPlayer", makeIntent: () => ({ kind: "assignCharacterToPlayer", sheetId: "sheet-1", playerId: "user-2" }) },
    { category: "Sheets", verb: "setSheetHp", makeIntent: () => ({ kind: "setSheetHp", sheetId: "sheet-1", hp: 15 }) },
    { category: "Sheets", verb: "setSheetMaxHp", makeIntent: () => ({ kind: "setSheetMaxHp", sheetId: "sheet-1", maxHp: 25 }) },
    { category: "Sheets", verb: "setSheetAc", makeIntent: () => ({ kind: "setSheetAc", sheetId: "sheet-1", ac: 14 }) },
    { category: "Sheets", verb: "updateAttributeValues", makeIntent: () => ({ kind: "updateAttributeValues", sheetId: "sheet-1", values: { STR: { kind: "Score", value: 16 } } }) },
    { category: "Sheets", verb: "deleteSheet", makeIntent: () => ({ kind: "deleteSheet", sheetId: "sheet-1" }) },

    // 8. Schemas (3)
    { category: "Schemas", verb: "setSchemaPreset", makeIntent: () => ({ kind: "setSchemaPreset", preset: "SimpleD20" }) },
    { category: "Schemas", verb: "updateSchemaRows", makeIntent: () => ({ kind: "updateSchemaRows", rows: [{ name: "HP", type: "Score", default: { kind: "Score", value: 10 } }] }) },
    { category: "Schemas", verb: "setInitiativeAttribute", makeIntent: () => ({ kind: "setInitiativeAttribute", attributeName: "DEX" }) },

    // 9. Status Effects (6)
    {
      category: "Status Effects",
      verb: "applyStatusEffect",
      makeIntent: () => ({
        kind: "applyStatusEffect",
        sheetId: "sheet-1",
        effect: {
          name: "Stunned",
          attributeDeltas: [],
          maxHpDelta: null,
          onApplyHpDelta: null,
          notes: "Cannot act",
        },
      }),
    },
    { category: "Status Effects", verb: "updateStatusEffect", makeIntent: () => ({ kind: "updateStatusEffect", sheetId: "sheet-1", effectId: "nonexistent", patch: { name: "Renewed" } }) },
    { category: "Status Effects", verb: "removeStatusEffect", makeIntent: () => ({ kind: "removeStatusEffect", sheetId: "sheet-1", effectId: "nonexistent" }) },
    { category: "Status Effects", verb: "createEffectTemplate", makeIntent: () => ({ kind: "createEffectTemplate", template: { name: "Blinded", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "" } }) },
    { category: "Status Effects", verb: "updateEffectTemplate", makeIntent: () => ({ kind: "updateEffectTemplate", templateId: "tmpl-1", patch: { name: "Super Poison" } }) },
    { category: "Status Effects", verb: "deleteEffectTemplate", makeIntent: () => ({ kind: "deleteEffectTemplate", templateId: "tmpl-1" }) },

    // 10. Custom Templates (6)
    { category: "Custom Templates", verb: "createCustomTemplate", makeIntent: () => ({ kind: "createCustomTemplate", template: { name: "Orc", description: "NPC", maxHp: 15, armorClass: 13, values: {}, notes: "", color: "#f00", rollTemplates: [], statusEffectTemplates: [] } }) },
    { category: "Custom Templates", verb: "updateCustomTemplate", makeIntent: () => ({ kind: "updateCustomTemplate", templateId: "ct-1", patch: { name: "Goblin Leader" } }) },
    { category: "Custom Templates", verb: "applyCustomTemplate", makeIntent: () => ({ kind: "applyCustomTemplate", sheetId: "sheet-1", templateId: "ct-1" }) },
    { category: "Custom Templates", verb: "duplicateCustomTemplate", makeIntent: () => ({ kind: "duplicateCustomTemplate", templateId: "ct-1" }) },
    { category: "Custom Templates", verb: "reorderCustomTemplates", makeIntent: () => ({ kind: "reorderCustomTemplates", templateIds: ["ct-1"] }) },
    { category: "Custom Templates", verb: "deleteCustomTemplate", makeIntent: () => ({ kind: "deleteCustomTemplate", templateId: "ct-1" }) },

    // 11. Dice & Rolls (7)
    { category: "Dice & Rolls", verb: "rollDice", makeIntent: () => ({ kind: "rollDice", formula: "1d20+2", mode: "Normal" }) },
    { category: "Dice & Rolls", verb: "rollTemplate", makeIntent: () => ({ kind: "rollTemplate", templateId: "grt-1" }) },
    { category: "Dice & Rolls", verb: "updateRollTemplate", makeIntent: () => ({ kind: "updateRollTemplate", sheetId: "sheet-1", templateId: "grt-1", patch: { name: "Updated D20" } }) },
    { category: "Dice & Rolls", verb: "createGlobalRollTemplate", makeIntent: () => ({ kind: "createGlobalRollTemplate", template: { name: "D6", dice: [{ count: 1, sides: 6 }], flatModifier: 0, mode: "Normal", attributeName: null, label: "D6" } }) },
    { category: "Dice & Rolls", verb: "updateGlobalRollTemplate", makeIntent: () => ({ kind: "updateGlobalRollTemplate", templateId: "grt-1", patch: { name: "D20 Advantage" } }) },
    { category: "Dice & Rolls", verb: "deleteGlobalRollTemplate", makeIntent: () => ({ kind: "deleteGlobalRollTemplate", templateId: "grt-1" }) },
    { category: "Dice & Rolls", verb: "clearRollLog", makeIntent: () => ({ kind: "clearRollLog" }) },

    // 12. Loaded Dice (6)
    { category: "Loaded Dice", verb: "createLoadedDiceRule", makeIntent: () => ({ kind: "createLoadedDiceRule", rule: { name: "Nat20", enabled: true, targetSheetIds: [], conditions: [], modifications: [] } }) },
    { category: "Loaded Dice", verb: "updateLoadedDiceRule", makeIntent: () => ({ kind: "updateLoadedDiceRule", ruleId: "ldr-1", patch: { enabled: false } }) },
    { category: "Loaded Dice", verb: "toggleLoadedDiceRule", makeIntent: () => ({ kind: "toggleLoadedDiceRule", ruleId: "ldr-1", enabled: false }) },
    { category: "Loaded Dice", verb: "reorderLoadedDiceRules", makeIntent: () => ({ kind: "reorderLoadedDiceRules", ruleIds: ["ldr-1"] }) },
    { category: "Loaded Dice", verb: "updateHostKeys", makeIntent: () => ({ kind: "updateHostKeys", heldKeys: ["KeyL"] }) },
    { category: "Loaded Dice", verb: "deleteLoadedDiceRule", makeIntent: () => ({ kind: "deleteLoadedDiceRule", ruleId: "ldr-1" }) },

    // 13. Combat Tracker (11)
    { category: "Combat Tracker", verb: "startCombat", makeIntent: () => ({ kind: "startCombat", mapId: "map-1" }) },
    { category: "Combat Tracker", verb: "addCombatant", makeIntent: () => ({ kind: "addCombatant", tokenId: "tok-1", initiativeRoll: 12 }) },
    { category: "Combat Tracker", verb: "nextTurn", makeIntent: () => ({ kind: "nextTurn" }) },
    { category: "Combat Tracker", verb: "previousTurn", makeIntent: () => ({ kind: "previousTurn" }) },
    { category: "Combat Tracker", verb: "rollInitiative", makeIntent: () => ({ kind: "rollInitiative", combatantId: "cb-1", rollFormula: "1d20" }) },
    { category: "Combat Tracker", verb: "forceInitiativeRoll", makeIntent: () => ({ kind: "forceInitiativeRoll", combatantId: "cb-1" }) },
    { category: "Combat Tracker", verb: "setNpcInitiative", makeIntent: () => ({ kind: "setNpcInitiative", combatantId: "cb-1", score: 15 }) },
    { category: "Combat Tracker", verb: "rollAllUnsetNpcs", makeIntent: () => ({ kind: "rollAllUnsetNpcs" }) },
    { category: "Combat Tracker", verb: "rollAllNpcInitiative", makeIntent: () => ({ kind: "rollAllNpcInitiative" }) },
    { category: "Combat Tracker", verb: "removeCombatant", makeIntent: () => ({ kind: "removeCombatant", combatantId: "cb-1" }) },
    { category: "Combat Tracker", verb: "endCombat", makeIntent: () => ({ kind: "endCombat" }) },

    // 14. Markup Overlay (2)
    { category: "Markup Overlay", verb: "updateMarkup", makeIntent: () => ({ kind: "updateMarkup", mapId: "map-1", markupSvg: "<svg></svg>" }) },
    { category: "Markup Overlay", verb: "clearMarkup", makeIntent: () => ({ kind: "clearMarkup", mapId: "map-1" }) },

    // 15. Lifecycle & Sync (2)
    { category: "Lifecycle & Sync", verb: "endSession", makeIntent: () => ({ kind: "endSession" }) },
    { category: "Lifecycle & Sync", verb: "syncClientState", makeIntent: (state) => ({ kind: "syncClientState", state }) },
  ];

  it("verifies all 84 verbs are registered and distinct", () => {
    expect(all84Verbs).toHaveLength(84);
    const verbNames = all84Verbs.map((v) => v.verb);
    const unique = new Set(verbNames);
    expect(unique.size).toBe(84);
  });

  for (const item of all84Verbs) {
    it(`handles verb '${item.verb}' (${item.category})`, () => {
      const state = makeVerbsState();
      const intent = item.makeIntent(state);

      // Verifies applyIntent handles it without unhandled error or throwing
      expect(() => {
        const res = applyIntent(state, dm, intent, Date.now());
        // It should either return a valid result or null (if preconditions like missing ID, etc. fail),
        // but never throw an unhandled exception or return undefined
        expect(res === null || typeof res === "object").toBe(true);
      }).not.toThrow();
    });
  }
});
