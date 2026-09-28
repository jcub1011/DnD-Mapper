import { describe, expect, it } from "vitest";
import {
  ALLOWED_DICE_SIDES,
  createDefaultAttributeSchema,
  createDefaultGridConfig,
  createDefaultSettings,
  createDefaultDndMapperState,
  DEFAULT_GRID_CONFIG,
  DEFAULT_SETTINGS,
  FEET_PER_SQUARE,
  FOG_BRUSH_RADIUS_MAX,
  FOG_BRUSH_RADIUS_MIN,
  getAttributeModifier,
  getMapImageDisplayName,
  getModifier,
  MAX_DICE_PER_ROLL,
  MAX_ROLL_LOG,
  MAX_TEXTURE_SIZE,
  MIN_IMAGE_DIMENSION,
  TOKEN_OWNER_HALO_RADIUS,
  TOKEN_RADIUS,
  TOKEN_STACK_CHIP_RADIUS,
  toMapSummary,
  ZOOM_MAX,
  ZOOM_MIN,
  type GameMap,
  type MapImage,
} from "./domain.js";

describe("domain models and invariants", () => {
  describe("GridConfig", () => {
    it("provides correct defaults per 03-domain-model", () => {
      expect(DEFAULT_GRID_CONFIG.widthCells).toBe(30);
      expect(DEFAULT_GRID_CONFIG.heightCells).toBe(20);
      expect(DEFAULT_GRID_CONFIG.cellPixels).toBe(50);
      expect(DEFAULT_GRID_CONFIG.showGridLines).toBe(true);
      expect(DEFAULT_GRID_CONFIG.snapToGrid).toBe(true);
      expect(DEFAULT_GRID_CONFIG.lineColor).toBe("#222");
    });

    it("creates grid configs with overrides", () => {
      const grid = createDefaultGridConfig({ widthCells: 50, snapToGrid: false });
      expect(grid.widthCells).toBe(50);
      expect(grid.heightCells).toBe(20);
      expect(grid.snapToGrid).toBe(false);
    });
  });

  describe("MapImage derived display name", () => {
    it("returns name when provided", () => {
      const img: Pick<MapImage, "name" | "layerOrder"> = { name: "Dungeon Map", layerOrder: 2 };
      expect(getMapImageDisplayName(img)).toBe("Dungeon Map");
    });

    it("falls back to Layer #{layerOrder} when name is empty or whitespace", () => {
      expect(getMapImageDisplayName({ name: "", layerOrder: 3 })).toBe("Layer #3");
      expect(getMapImageDisplayName({ name: "   ", layerOrder: 0 })).toBe("Layer #0");
    });
  });

  describe("toMapSummary", () => {
    it("extracts minimal metadata bounded summary", () => {
      const map: GameMap = {
        id: "map-1",
        name: "Cavern",
        grid: DEFAULT_GRID_CONFIG,
        images: [],
        tokens: [],
        createdUtc: "2026-09-08T00:00:00Z",
        listOrder: 1,
        defaultSpawnPosition: { x: 5, y: 5 },
        markupSvg: null,
        fogMask: "",
      };

      const summary = toMapSummary(map);
      expect(summary).toEqual({
        id: "map-1",
        name: "Cavern",
        listOrder: 1,
        widthCells: 30,
        heightCells: 20,
      });
      // Bounded: contains no tokens, images, or fog
      expect("tokens" in summary).toBe(false);
      expect("images" in summary).toBe(false);
      expect("fogMask" in summary).toBe(false);
    });
  });

  describe("AttributeValue getModifier", () => {
    it("calculates D&D 5e modifier for scores floor((score - 10) / 2)", () => {
      expect(getModifier({ kind: "Score", value: 10 })).toBe(0);
      expect(getModifier({ kind: "Score", value: 11 })).toBe(0);
      expect(getModifier({ kind: "Score", value: 12 })).toBe(1);
      expect(getModifier({ kind: "Score", value: 18 })).toBe(4);
      expect(getModifier({ kind: "Score", value: 20 })).toBe(5);
      expect(getModifier({ kind: "Score", value: 9 })).toBe(-1);
      expect(getModifier({ kind: "Score", value: 8 })).toBe(-1);
      expect(getModifier({ kind: "Score", value: 7 })).toBe(-2);
      expect(getModifier({ kind: "Score", value: 1 })).toBe(-5);
    });

    it("returns flat value for Modifier kind", () => {
      expect(getModifier({ kind: "Modifier", value: 3 })).toBe(3);
      expect(getModifier({ kind: "Modifier", value: -2 })).toBe(-2);
    });

    it("returns 0 for Text kind", () => {
      expect(getModifier({ kind: "Text", value: "Neutral Good" })).toBe(0);
    });

    it("getAttributeModifier alias behaves identically", () => {
      expect(getAttributeModifier({ kind: "Score", value: 14 })).toBe(2);
      expect(getAttributeModifier).toBe(getModifier);
    });
  });

  describe("createDefaultAttributeSchema", () => {
    it("creates DnD5eCore schema with 6 ability scores", () => {
      const schema = createDefaultAttributeSchema("DnD5eCore");
      expect(schema.preset).toBe("DnD5eCore");
      expect(schema.rows).toHaveLength(6);
      expect(schema.rows.map((r) => r.name)).toEqual([
        "Strength",
        "Dexterity",
        "Constitution",
        "Intelligence",
        "Wisdom",
        "Charisma",
      ]);
      expect(schema.rows.every((r) => r.type === "Score")).toBe(true);
    });

    it("creates DnD5ePlusCommonSkills schema with core scores + 5 skills", () => {
      const schema = createDefaultAttributeSchema("DnD5ePlusCommonSkills");
      expect(schema.rows).toHaveLength(11);
      expect(schema.rows.slice(6).map((r) => r.name)).toEqual([
        "Athletics",
        "Stealth",
        "Perception",
        "Persuasion",
        "Investigation",
      ]);
    });

    it("creates SimpleD20 schema with a single modifier", () => {
      const schema = createDefaultAttributeSchema("SimpleD20");
      expect(schema.rows).toHaveLength(1);
      expect(schema.rows[0].name).toBe("Modifier");
      expect(schema.rows[0].type).toBe("Modifier");
    });
  });

  describe("DndMapperSettings & State", () => {
    it("provides default settings matching legacy permissions", () => {
      expect(DEFAULT_SETTINGS.tokenMovement).toBe("OwnerOrHost");
      expect(DEFAULT_SETTINGS.sheetEditByOthers).toBe("HostOnly");
      expect(DEFAULT_SETTINGS.rollsVisibleToPlayers).toBe(true);
      expect(DEFAULT_SETTINGS.playersCanCreateNPCs).toBe(false);
      expect(DEFAULT_SETTINGS.hpTrackingEnabled).toBe(true);
      expect(DEFAULT_SETTINGS.playersCanSeeOtherSheets).toBe(false);
      expect(DEFAULT_SETTINGS.loadedDiceEnabled).toBe(false);
    });

    it("creates default settings with overrides", () => {
      const settings = createDefaultSettings({ tokenMovement: "Anyone", hpTrackingEnabled: false });
      expect(settings.tokenMovement).toBe("Anyone");
      expect(settings.hpTrackingEnabled).toBe(false);
      expect(settings.rollsVisibleToPlayers).toBe(true);
    });

    it("creates initial default state with dmPlayerId", () => {
      const state = createDefaultDndMapperState("host-user-123");
      expect(state.phase).toBe("Lobby");
      expect(state.dmPlayerId).toBe("host-user-123");
      expect(state.maps).toEqual([]);
      expect(state.activeMapId).toBeNull();
      expect(state.sheets).toEqual({});
      expect(state.rollLog).toEqual([]);
    });
  });

  describe("Invariants to assert", () => {
    it("matches all documented invariant constants", () => {
      expect(ZOOM_MIN).toBe(0.01);
      expect(ZOOM_MAX).toBe(10.0);
      expect(FOG_BRUSH_RADIUS_MIN).toBe(1);
      expect(FOG_BRUSH_RADIUS_MAX).toBe(3);
      expect(TOKEN_RADIUS).toBe(0.45);
      expect(TOKEN_OWNER_HALO_RADIUS).toBe(0.55);
      expect(TOKEN_STACK_CHIP_RADIUS).toBe(0.4);
      expect(MIN_IMAGE_DIMENSION).toBe(0.1);
      expect(FEET_PER_SQUARE).toBe(5.0);
      expect(MAX_ROLL_LOG).toBe(50);
      expect(ALLOWED_DICE_SIDES).toEqual([4, 6, 8, 10, 12, 20, 100]);
      expect(MAX_DICE_PER_ROLL).toBe(20);
      expect(MAX_TEXTURE_SIZE).toBe(8192);
    });
  });
});
