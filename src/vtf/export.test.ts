import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { CharacterSheet, DndMapperState, GameMap } from "../game/domain.js";
import { createDefaultDndMapperState, createDefaultGridConfig } from "../game/domain.js";
import { encodeFog } from "../game/fog.js";
import { LibraryService } from "../storage/libraryService.js";
import { exportCampaignSlot, exportVtf, formatVtfFileName } from "./export.js";
import { importVtf } from "./import.js";
import type {
  DndMapperGlobalVendor,
  DndMapperSceneVendor,
  VtfEntity,
  VtfExtensionPayload,
  VtfGlobalState,
  VtfManifest,
  VtfScene,
} from "./types.js";
import { openZip } from "./unzip.js";

function makeRichTestState(): { state: DndMapperState; imageBlobs: Map<string, Blob> } {
  const base = createDefaultDndMapperState();

  const fogGrid = new Uint8Array(20 * 15);
  // Fog out first 10 cells
  for (let i = 0; i < 10; i++) fogGrid[i] = 1;
  const fogMask = encodeFog(fogGrid);

  const img1Id = "img-alpha-111";
  const img2Id = "img-beta-222";
  const imageBlobs = new Map<string, Blob>([
    [img1Id, new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" })],
    [img2Id, new Blob([new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70])], { type: "image/jpeg" })],
  ]);

  const map1: GameMap = {
    id: "map-01",
    name: "Dungeon Level 1",
    grid: {
      ...createDefaultGridConfig(),
      cellPixels: 50,
      widthCells: 20,
      heightCells: 15,
      lineColor: "rgba(255, 0, 0, 0.5)",
      showGridLines: true,
    },
    images: [
      {
        id: img1Id,
        name: "Floorplan",
        x: 100,
        y: 150,
        width: 800,
        height: 600,
        originalWidth: 800,
        originalHeight: 600,
        rotation: 0,
        layerOrder: 1,
        opacity: 1,
        hidden: false,
        locked: true,
        byteSize: 10000,
        wasDownscaled: false,
        originalLongEdgePx: 800,
        displayLongEdgePx: 800,
        contentType: "image/png",
        shareToken: null,
      },
    ],
    tokens: [
      {
        id: "tok-p1",
        type: "PlayerToken",
        ownerUserId: "user-alice",
        representsUserId: null,
        name: "Alice the Rogue",
        color: "#3498db",
        iconKind: "Initial",
        mapId: "map-01",
        x: 3.5,
        y: 4.5,
        sheetId: "sheet-alice",
        hidden: false,
      },
      {
        id: "tok-npc1",
        type: "NPCToken",
        ownerUserId: null,
        representsUserId: "user-bob",
        name: "Bob (Former Paladin)",
        color: "#e74c3c",
        iconKind: "Solid",
        mapId: "map-01",
        x: 7.0,
        y: 8.0,
        sheetId: "sheet-bob",
        hidden: true,
      },
    ],
    createdUtc: "2026-09-08T12:00:00.000Z",
    listOrder: 0,
    defaultSpawnPosition: { x: 3, y: 3 },
    markupSvg: null,
    fogMask,
  };

  const map2: GameMap = {
    id: "map-02",
    name: "Forest Clearing",
    grid: {
      ...createDefaultGridConfig(),
      cellPixels: 64,
      widthCells: 15,
      heightCells: 12,
    },
    images: [
      {
        id: img2Id,
        name: "Trees Overlay",
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        originalWidth: 400,
        originalHeight: 400,
        rotation: 45,
        layerOrder: 2,
        opacity: 0.8,
        hidden: false,
        locked: false,
        byteSize: 5000,
        wasDownscaled: false,
        originalLongEdgePx: 400,
        displayLongEdgePx: 400,
        contentType: "image/jpeg",
        shareToken: null,
      },
    ],
    tokens: [],
    createdUtc: "2026-09-08T13:00:00.000Z",
    listOrder: 1,
    defaultSpawnPosition: null,
    markupSvg: null,
    fogMask: "",
  };

  const sheetAlice: CharacterSheet = {
    id: "sheet-alice",
    characterName: "Alice the Rogue",
    ownerUserId: "user-alice",
    representsUserId: null,
    color: "#3498db",
    colorOverridden: true,
    scopedMapId: "map-01",
    hp: 24,
    maxHp: 28,
    armorClass: 15,
    notes: "# Alice\nExpert lockpicker",
    values: {
      STR: { kind: "Score", value: 10 },
      DEX: { kind: "Score", value: 18 },
      CON: { kind: "Score", value: 14 },
      INT: { kind: "Score", value: 12 },
      WIS: { kind: "Score", value: 13 },
      CHA: { kind: "Score", value: 8 },
    },
    statusEffects: [
      {
        id: "eff-1",
        name: "Haste",
        appliedUtc: "2026-09-08T12:30:00.000Z",
        attributeDeltas: [],
        maxHpDelta: null,
        onApplyHpDelta: null,
        notes: "+2 AC and double speed",
      },
    ],
    rollTemplates: [],
  };

  const sheetBob: CharacterSheet = {
    id: "sheet-bob",
    characterName: "Bob the Fallen",
    ownerUserId: null,
    representsUserId: "user-bob",
    color: "#e74c3c",
    colorOverridden: true,
    scopedMapId: null,
    hp: 45,
    maxHp: 50,
    armorClass: 18,
    notes: "Abandoned player character, now an NPC.",
    values: {
      STR: { kind: "Score", value: 16 },
      DEX: { kind: "Score", value: 10 },
      CON: { kind: "Score", value: 16 },
      INT: { kind: "Score", value: 10 },
      WIS: { kind: "Score", value: 14 },
      CHA: { kind: "Score", value: 14 },
    },
    statusEffects: [],
    rollTemplates: [],
  };

  const state: DndMapperState = {
    ...base,
    phase: "Playing",
    activeMapId: "map-01",
    maps: [map1, map2],
    sheets: {
      "sheet-alice": sheetAlice,
      "sheet-bob": sheetBob,
    },
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
    activeCombat: {
      phase: "Active",
      roundNumber: 2,
      currentTurnIndex: 0,
      turnOrder: [
        {
          id: "cb-1",
          tokenId: "tok-p1",
          name: "Alice the Rogue",
          initiativeRoll: 19,
          isForceRolled: false,
          pendingInitiative: null,
          ownerUserId: "user-alice",
        },
      ],
    },
  };

  return { state, imageBlobs };
}

describe("formatVtfFileName", () => {
  it("sanitizes spaces and special characters and appends timestamp", () => {
    const fixedDate = new Date(2026, 8, 11, 14, 30, 0); // Sept 11, 2026 14:30
    const name = formatVtfFileName("Lost Mine of Phandelver! (Act II)", fixedDate);
    expect(name).toBe("Lost_Mine_of_Phandelver_Act_II_20260911_1430.vtf");
  });

  it("handles empty or all-special title by falling back to Campaign", () => {
    const fixedDate = new Date(2026, 0, 1, 9, 5, 0);
    const name = formatVtfFileName("???", fixedDate);
    expect(name).toBe("Campaign_20260101_0905.vtf");
  });
});

describe("exportVtf ZIP Structure", () => {
  it("packages all required VTF v1.0.0 entries", async () => {
    const { state, imageBlobs } = makeRichTestState();

    const zipBlob = await exportVtf(state, {
      slotTitle: "Test Campaign",
      getImageBlob: async (id) => imageBlobs.get(id) ?? null,
    });

    expect(zipBlob.type).toBe("application/zip");
    expect(zipBlob.size).toBeGreaterThan(0);

    const zip = await openZip(zipBlob);
    const entryNames = zip.entries.map((e) => e.name);

    // 1. Manifest
    expect(entryNames).toContain("manifest.json");
    const manifestEntry = zip.getEntry("manifest.json");
    expect(manifestEntry).toBeDefined();
    const manifest = await zip.readJson<VtfManifest>(manifestEntry!);
    expect(manifest).not.toBeNull();
    expect(manifest!.vtfVersion).toBe("1.0.0");
    expect(manifest!.campaign.title).toBe("Test Campaign");
    expect(manifest!.system.core).toBe("dnd5e");
    expect(manifest!.dependencies[0].name).toBe("knockbox_dnd_mapper");

    // 2. Global State
    expect(entryNames).toContain("global_state.json");
    const globalEntry = zip.getEntry("global_state.json");
    const globalState = await zip.readJson<VtfGlobalState>(globalEntry!);
    expect(globalState).not.toBeNull();
    const dndmGlobal = globalState!.vendorData?.knockbox_dnd_mapper as DndMapperGlobalVendor;
    expect(dndmGlobal.loadedDiceRules).toHaveLength(1);

    // 3. Scenes
    expect(entryNames).toContain("scenes/map-01.json");
    expect(entryNames).toContain("scenes/map-02.json");
    const sceneEntry = zip.getEntry("scenes/map-01.json");
    const sceneDoc = await zip.readJson<VtfScene>(sceneEntry!);
    expect(sceneDoc).not.toBeNull();
    expect(sceneDoc!.sceneId).toBe("map-01");
    const dndmScene = sceneDoc!.vendorData?.knockbox_dnd_mapper as DndMapperSceneVendor;
    expect(dndmScene.name).toBe("Dungeon Level 1");
    expect(sceneDoc!.entityInstances).toHaveLength(2);
    expect(sceneDoc!.layers).toHaveLength(1);

    // 4. Entities (Sheets)
    expect(entryNames).toContain("entities/sheet_sheet-alice.json");
    expect(entryNames).toContain("entities/sheet_sheet-bob.json");
    const sheetEntry = zip.getEntry("entities/sheet_sheet-alice.json");
    const sheetDoc = await zip.readJson<VtfEntity>(sheetEntry!);
    expect(sheetDoc).not.toBeNull();
    expect(sheetDoc!.name).toBe("Alice the Rogue");
    const dndmSheet = sheetDoc!.vendorData?.knockbox_dnd_mapper as CharacterSheet;
    expect(dndmSheet.hp).toBe(24);

    // 5. Assets (Images)
    expect(entryNames).toContain("assets/images/img-alpha-111.png");
    expect(entryNames).toContain("assets/images/img-beta-222.jpg");

    // 6. Extensions
    expect(entryNames).toContain("extensions/knockbox_dnd_mapper.json");
    const extEntry = zip.getEntry("extensions/knockbox_dnd_mapper.json");
    const extDoc = await zip.readJson<VtfExtensionPayload>(extEntry!);
    expect(extDoc).not.toBeNull();
    expect(extDoc!.activeCombat?.roundNumber).toBe(2);
    expect(extDoc!.phase).toBe("Playing");
  });
});

describe("100% Round-Trip Fidelity with importVtf", () => {
  it("exports state and imports back with exact fidelity", async () => {
    const libService = new LibraryService();
    await libService.attach();

    const { state, imageBlobs } = makeRichTestState();

    // Pre-populate libraryService with images
    for (const [id, blob] of imageBlobs) {
      await libService.putImage(id, blob);
    }

    // Export to VTF
    const zipBlob = await exportVtf(state, {
      slotTitle: "Round Trip Realm",
      getImageBlob: (id) => libService.getImage(id),
    });

    // Import from VTF
    const imported = await importVtf(zipBlob);

    // Verify Title
    expect(imported.slotTitle).toBe("Round Trip Realm");

    // Verify Maps
    expect(imported.maps).toHaveLength(2);
    const m1 = imported.maps.find((m) => m.id === "map-01") as GameMap;
    expect(m1).toBeDefined();
    expect(m1.name).toBe("Dungeon Level 1");
    expect(m1.grid.cellPixels).toBe(50);
    expect(m1.fogMask).toBe((state.maps[0] as GameMap).fogMask);
    expect(m1.defaultSpawnPosition).toEqual({ x: 3, y: 3 });

    // Verify Tokens on map-01
    expect(m1.tokens).toHaveLength(2);
    const tokAlice = m1.tokens.find((t) => t.name === "Alice the Rogue");
    expect(tokAlice).toBeDefined();
    expect(tokAlice!.type).toBe("PlayerToken");
    expect(tokAlice!.ownerUserId).toBe("user-alice");
    expect(tokAlice!.sheetId).toBe("sheet-alice");

    const tokBob = m1.tokens.find((t) => t.name === "Bob (Former Paladin)");
    expect(tokBob).toBeDefined();
    expect(tokBob!.type).toBe("NPCToken");
    expect(tokBob!.representsUserId).toBe("user-bob");
    expect(tokBob!.hidden).toBe(true);

    // Verify Map 2
    const m2 = imported.maps.find((m) => m.id === "map-02") as GameMap;
    expect(m2).toBeDefined();
    expect(m2.grid.cellPixels).toBe(64);

    // Verify Sheets
    expect(imported.sheets).toHaveLength(2);
    const sAlice = imported.sheets.find((s) => s.id === "sheet-alice");
    expect(sAlice).toBeDefined();
    expect(sAlice!.characterName).toBe("Alice the Rogue");
    expect(sAlice!.hp).toBe(24);
    expect(sAlice!.armorClass).toBe(15);
    expect(sAlice!.values["DEX"]).toEqual({ kind: "Score", value: 18 });
    expect(sAlice!.statusEffects).toHaveLength(1);
    expect(sAlice!.statusEffects[0].name).toBe("Haste");

    const sBob = imported.sheets.find((s) => s.id === "sheet-bob");
    expect(sBob).toBeDefined();
    expect(sBob!.representsUserId).toBe("user-bob");
    expect(sBob!.ownerUserId).toBeNull();
    expect(sBob!.notes).toContain("Abandoned player character");

    // Verify Loaded Dice Rules
    expect(imported.state.loadedDiceRules).toHaveLength(1);
    expect(imported.state.loadedDiceRules[0].name).toBe("Nat1 Rule");

    // Verify Combat State
    expect(imported.extension.activeCombat?.roundNumber).toBe(2);
    expect(imported.extension.phase).toBe("Playing");

    // Verify Images
    expect(imported.images.size).toBe(2);
    for (const [, asset] of imported.images) {
      expect(asset.blob.size).toBeGreaterThan(0);
    }

    await libService.detach();
  });
});

describe("exportCampaignSlot", () => {
  it("exports a saved slot from LibraryService", async () => {
    const libService = new LibraryService();
    await libService.attach();

    const { state } = makeRichTestState();
    await libService.saveSlot("slot-01", "Epic Campaign", state);

    const { blob, fileName } = await exportCampaignSlot(libService, "slot-01");
    expect(blob.size).toBeGreaterThan(0);
    expect(fileName).toMatch(/^Epic_Campaign_\d{8}_\d{4}\.vtf$/);

    const zip = await openZip(blob);
    expect(zip.entries.map((e) => e.name)).toContain("manifest.json");

    await libService.detach();
  });
});
