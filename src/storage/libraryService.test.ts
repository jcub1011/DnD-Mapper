import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterSheet, DndMapperState, GameMap } from "../game/domain.js";
import { deleteDatabase } from "./db.js";
import { captureFingerprint, isFingerprintEqual, LibraryService } from "./libraryService.js";
import { AUTO_SLOT_ID } from "./schema.js";

function createMockState(): DndMapperState {
  const map1: GameMap = {
    id: "map-1",
    name: "Dungeon",
    grid: {
      widthCells: 20,
      heightCells: 20,
      cellPixels: 50,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#333",
    },
    images: [],
    tokens: [
      {
        id: "tok-1",
        type: "PlayerToken",
        ownerUserId: "u1",
        representsUserId: null,
        name: "Fighter",
        color: "#ff0000",
        iconKind: "Initial",
        mapId: "map-1",
        x: 5.5,
        y: 5.5,
        sheetId: "sheet-1",
        hidden: false,
      },
    ],
    createdUtc: "2026-01-01T00:00:00.000Z",
    listOrder: 0,
    defaultSpawnPosition: { x: 5.5, y: 5.5 },
    markupSvg: null,
    fogMask: "",
  };

  const sheet1: CharacterSheet = {
    id: "sheet-1",
    ownerUserId: "u1",
    representsUserId: null,
    characterName: "Valeros",
    values: {},
    notes: "A brave warrior.",
    hp: 20,
    maxHp: 20,
    armorClass: 16,
    color: "#ff0000",
    scopedMapId: null,
    statusEffects: [],
    rollTemplates: [],
  };

  return {
    phase: "Playing",
    settings: {
      tokenMovement: "OwnerOrHost",
      sheetEditByOthers: "HostOnly",
      rollsVisibleToPlayers: true,
      playersCanCreateNPCs: false,
      hpTrackingEnabled: true,
      playersCanSeeOtherSheets: true,
      loadedDiceEnabled: false,
      loadedDiceRuleVisibility: "Hidden",
      loadedDicePlayerIndicator: "None",
    },
    attributeSchema: { preset: "DnD5eCore", rows: [] },
    maps: [map1],
    activeMapId: "map-1",
    sheets: { "sheet-1": sheet1 },
    customTemplates: {},
    statusEffectTemplates: {},
    rollLog: [],
    globalRollTemplates: [],
    activeSchemaTemplateId: null,
    initiativeAttributeName: null,
    activeCombat: null,
    pendingCenterRequest: null,
    focusRect: null,
    loadedDiceRules: [],
    hostHeldKeys: [],
    dmPlayerId: null,
  };
}

describe("LibraryService and Sharded Persistence", () => {
  let service: LibraryService;

  beforeEach(async () => {
    await deleteDatabase();
    service = new LibraryService(30);
    await service.attach();
  });

  afterEach(async () => {
    await service.detach();
    await deleteDatabase();
  });

  describe("PersistedFingerprint", () => {
    it("short-circuits when only non-persisted fields like rollLog or phase change", () => {
      const state1 = createMockState();
      const fp1 = captureFingerprint(state1);

      // Mutate only non-persisted fields (rollLog, activeCombat, phase)
      const state2: DndMapperState = {
        ...state1,
        phase: "Lobby",
        rollLog: [
          {
            id: "roll-1",
            rollerUserId: "u1",
            forcedByUserId: null,
            rolls: [{ sides: 20, value: 18 }],
            total: 18,
            mode: "Normal",
            flatModifier: 0,
            attributeModifier: 0,
            label: "d20",
            timestampUtc: new Date().toISOString(),
            formula: "1d20",
            modifierBreakdown: "",
            tokenId: null,
            appliedRules: [],
          },
        ],
      };
      const fp2 = captureFingerprint(state2);

      expect(isFingerprintEqual(fp1, fp2)).toBe(true);
    });

    it("detects changes in persisted fields like maps or sheets", () => {
      const state1 = createMockState();
      const fp1 = captureFingerprint(state1);

      const state2: DndMapperState = {
        ...state1,
        maps: [
          {
            ...state1.maps[0],
            name: "Updated Dungeon",
          },
        ],
      };
      const fp2 = captureFingerprint(state2);

      expect(isFingerprintEqual(fp1, fp2)).toBe(false);
    });
  });

  describe("Debounced Auto-Save & Sharding", () => {
    it("debounces saves and sets isSaving flag", async () => {
      const state = createMockState();
      const onSavingChanged = vi.fn();
      service.onSavingChanged = onSavingChanged;

      service.onStateChanged(state);
      expect(service.isSaving).toBe(true);
      expect(onSavingChanged).toHaveBeenCalledWith(true);

      // Wait for debounce timer (30ms) to fire and flush to complete
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(service.isSaving).toBe(false);
      expect(onSavingChanged).toHaveBeenLastCalledWith(false);

      // Verify auto-save slot was written
      const loaded = await service.loadSlot(AUTO_SLOT_ID);
      expect(loaded).not.toBeNull();
      expect(loaded!.maps.length).toBe(1);
      expect(loaded!.maps[0].name).toBe("Dungeon");
    });

    it("writes shards separately and skips clean shards on subsequent flushes", async () => {
      const state = createMockState();
      await service.flushAutoSave(state);

      // Modify only map token position
      const map0 = state.maps[0] as GameMap;
      const updatedMap: GameMap = {
        ...map0,
        tokens: [
          {
            ...map0.tokens[0],
            x: 7.5,
            y: 8.5,
          },
        ],
      };
      const state2: DndMapperState = {
        ...state,
        maps: [updatedMap],
      };

      await service.flushAutoSave(state2);

      const loaded = await service.loadSlot(AUTO_SLOT_ID);
      expect(loaded).not.toBeNull();
      expect((loaded!.maps[0] as GameMap).tokens[0].x).toBe(7.5);
      expect((loaded!.maps[0] as GameMap).tokens[0].y).toBe(8.5);
      expect(loaded!.sheets["sheet-1"].characterName).toBe("Valeros");
    });

    it("cleans up stale shards when maps are deleted", async () => {
      const state = createMockState();
      const map0 = state.maps[0] as GameMap;
      const map2: GameMap = {
        ...map0,
        id: "map-2",
        name: "Tower",
      };
      const stateWithTwoMaps: DndMapperState = {
        ...state,
        maps: [map0, map2],
      };

      await service.flushAutoSave(stateWithTwoMaps);
      let loaded = await service.loadSlot(AUTO_SLOT_ID);
      expect(loaded!.maps.length).toBe(2);

      // Now remove map-2
      await service.flushAutoSave(state);
      loaded = await service.loadSlot(AUTO_SLOT_ID);
      expect(loaded!.maps.length).toBe(1);
      expect(loaded!.maps[0].id).toBe("map-1");
    });
  });

  describe("Slot CRUD Operations", () => {
    it("saves and loads manual slots without mutating auto-save slot", async () => {
      const state = createMockState();
      await service.saveSlot("manual-slot-1", "My Campaign", state);

      const slots = await service.listSlots();
      expect(slots.length).toBe(2); // Auto Save + Manual
      expect(slots.some((s) => s.id === "manual-slot-1" && s.name === "My Campaign")).toBe(true);

      const loaded = await service.loadSlot("manual-slot-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.maps[0].name).toBe("Dungeon");
      expect(loaded!.sheets["sheet-1"].characterName).toBe("Valeros");
    });

    it("renames manual slots and prevents renaming auto-save slot", async () => {
      const state = createMockState();
      await service.saveSlot("slot-a", "Old Name", state);

      const renamed = await service.renameSlot("slot-a", "New Name");
      expect(renamed).toBe(true);

      const slots = await service.listSlots();
      expect(slots.find((s) => s.id === "slot-a")?.name).toBe("New Name");

      await expect(service.renameSlot(AUTO_SLOT_ID, "Hacked")).rejects.toThrow();
    });

    it("deletes manual slots and their shards, preventing auto-save deletion", async () => {
      const state = createMockState();
      await service.saveSlot("slot-to-delete", "Disposable", state);

      const deleted = await service.deleteSlot("slot-to-delete");
      expect(deleted).toBe(true);

      const loaded = await service.loadSlot("slot-to-delete");
      expect(loaded).toBeNull();

      await expect(service.deleteSlot(AUTO_SLOT_ID)).rejects.toThrow();
    });
  });

  describe("Image / Blob Storage", () => {
    it("stores, retrieves, lists, and calculates bytes used for images", async () => {
      const imageBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const blob = new Blob([imageBytes], { type: "image/png" });

      await service.putImage("img-1", blob);
      const retrieved = await service.getImage("img-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.size).toBe(5);

      const imageIds = await service.listImageIds();
      expect(imageIds).toContain("img-1");

      const bytesUsed = await service.getBytesUsed();
      expect(bytesUsed).toBe(5);

      await service.deleteImage("img-1");
      expect(await service.getImage("img-1")).toBeNull();
      expect(await service.getBytesUsed()).toBe(0);
    });
  });

  describe("Auto-attach on demand", () => {
    it("automatically opens IndexedDB and succeeds when operations are called without explicit attach()", async () => {
      const unattachedService = new LibraryService(30);
      const state = createMockState();

      // saveSlot without calling attach() first
      await unattachedService.saveSlot("auto-attach-slot", "Auto Attached", state);

      const slots = await unattachedService.listSlots();
      expect(slots.some((s) => s.id === "auto-attach-slot" && s.name === "Auto Attached")).toBe(true);

      const loaded = await unattachedService.loadSlot("auto-attach-slot");
      expect(loaded).not.toBeNull();
      expect(loaded!.maps[0].name).toBe("Dungeon");

      await unattachedService.detach();
    });
  });
});
