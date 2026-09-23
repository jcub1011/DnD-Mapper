import { describe, expect, it } from "vitest";
import {
  fallbackColorForHash,
  getContrastRatio,
  getReadableTextColor,
  getRelativeLuminance,
  parseHexColor,
  resolveDiceColor,
  seedColorForName,
  stringHashCode,
  HOST_GOLD,
} from "./color.js";
import {
  createDefaultDndMapperState,
  type CharacterSheet,
  type DndMapperState,
} from "./domain.js";

describe("color contrast helpers", () => {
  describe("parseHexColor", () => {
    it("parses 3-digit hex", () => {
      expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
      expect(parseHexColor("#000")).toEqual({ r: 0, g: 0, b: 0 });
      expect(parseHexColor("#f00")).toEqual({ r: 255, g: 0, b: 0 });
    });

    it("parses 6-digit hex", () => {
      expect(parseHexColor("#123456")).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
      expect(parseHexColor("ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    });

    it("parses 8-digit hex (ignoring alpha channel for rgb)", () => {
      expect(parseHexColor("#123456ff")).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
    });

    it("rejects invalid hex strings", () => {
      expect(parseHexColor("")).toBeNull();
      expect(parseHexColor("blue")).toBeNull();
      expect(parseHexColor("#12")).toBeNull();
      expect(parseHexColor("#12345")).toBeNull();
      expect(parseHexColor("#gggggg")).toBeNull();
    });
  });

  describe("getRelativeLuminance", () => {
    it("returns 0 for pure black", () => {
      expect(getRelativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 4);
    });

    it("returns 1 for pure white", () => {
      expect(getRelativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 4);
    });
  });

  describe("getContrastRatio", () => {
    it("calculates 21:1 for black and white", () => {
      const ratio = getContrastRatio("#000000", "#ffffff");
      expect(ratio).toBeCloseTo(21.0, 1);
    });

    it("calculates 1:1 for identical colors", () => {
      const ratio = getContrastRatio("#3b82f6", "#3b82f6");
      expect(ratio).toBeCloseTo(1.0, 1);
    });
  });

  describe("getReadableTextColor", () => {
    it("selects white text on dark token colors", () => {
      expect(getReadableTextColor("#000000")).toBe("#ffffff");
      expect(getReadableTextColor("#1e1e1e")).toBe("#ffffff");
      expect(getReadableTextColor("#1e3a8a")).toBe("#ffffff"); // dark blue
      expect(getReadableTextColor("#831843")).toBe("#ffffff"); // dark pink/purple
      expect(getReadableTextColor("#14532d")).toBe("#ffffff"); // dark green
    });

    it("selects black text on light token colors", () => {
      expect(getReadableTextColor("#ffffff")).toBe("#000000");
      expect(getReadableTextColor("#fef08a")).toBe("#000000"); // yellow
      expect(getReadableTextColor("#bbf7d0")).toBe("#000000"); // light green
      expect(getReadableTextColor("#e0e7ff")).toBe("#000000"); // light indigo
    });

    it("falls back to black text on invalid input", () => {
      expect(getReadableTextColor("")).toBe("#000000");
    });
  });

  describe("seedColorForName", () => {
    it("is deterministic and trims/case-folds the name", () => {
      expect(seedColorForName("Aria")).toBe(seedColorForName("Aria"));
      expect(seedColorForName("  ARIA  ")).toBe(seedColorForName("aria"));
    });

    it("differs across names", () => {
      expect(seedColorForName("Aria")).not.toBe(seedColorForName("Borin"));
    });
  });

  describe("resolveDiceColor", () => {
    function makeSheet(id: string, ownerUserId: string | null, color: string): CharacterSheet {
      return {
        id,
        ownerUserId,
        representsUserId: null,
        characterName: "Hero",
        values: {},
        notes: "",
        hp: null,
        maxHp: null,
        armorClass: null,
        color,
        colorOverridden: true,
        scopedMapId: null,
        statusEffects: [],
        rollTemplates: [],
      };
    }

    function stateWithSheets(sheets: readonly CharacterSheet[]): DndMapperState {
      return {
        ...createDefaultDndMapperState("dm-1"),
        sheets: Object.fromEntries(sheets.map((s) => [s.id, s])),
      };
    }

    it("returns gold for the DM", () => {
      const state = stateWithSheets([]);
      expect(resolveDiceColor(state, "dm-1", [])).toBe(HOST_GOLD);
    });

    it("uses the color of the roller's associated character sheet", () => {
      const state = stateWithSheets([makeSheet("sheet-1", "player-1", "#123456")]);
      expect(resolveDiceColor(state, "player-1", [])).toBe("#123456");
    });

    it("falls back to the player display-name hash when unassigned", () => {
      const state = stateWithSheets([]);
      const roster = [{ id: "player-9", displayName: "Zelda" }];
      expect(resolveDiceColor(state, "player-9", roster)).toBe(
        fallbackColorForHash(stringHashCode("Zelda")),
      );
    });

    it("falls back to the user-id hash when the roster name is unknown", () => {
      const state = stateWithSheets([]);
      expect(resolveDiceColor(state, "player-9", [])).toBe(
        fallbackColorForHash(stringHashCode("player-9")),
      );
    });
  });
});
