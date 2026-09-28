import { describe, expect, it } from "vitest";
import {
  filterDisplayImages,
  filterDisplayTokens,
  resolveDisplayFraming,
} from "./displayProjection";
import type { GridConfig, MapImage, Token } from "../../game/domain";
import { encodeFog, setCellFogged } from "../../game/fog";

const GRID: GridConfig = {
  widthCells: 10,
  heightCells: 10,
  cellPixels: 50,
  showGridLines: true,
  snapToGrid: true,
  lineColor: "#222",
};

describe("Display Projection Rules (Phase 10)", () => {
  describe("filterDisplayTokens", () => {
    const TOKENS: Token[] = [
      {
        id: "tok-revealed",
        name: "Revealed Token",
        type: "PlayerToken",
        ownerUserId: "p1",
        representsUserId: null,
        color: "#27ae60",
        iconKind: "Initial",
        mapId: "map1",
        x: 1.5,
        y: 1.5,
        sheetId: null,
        hidden: false,
      },
      {
        id: "tok-fogged",
        name: "Fogged Token",
        type: "NPCToken",
        ownerUserId: null,
        representsUserId: null,
        color: "#c0392b",
        iconKind: "Initial",
        mapId: "map1",
        x: 5.5,
        y: 5.5,
        sheetId: null,
        hidden: false,
      },
      {
        id: "tok-hidden",
        name: "Hidden Token",
        type: "NPCToken",
        ownerUserId: null,
        representsUserId: null,
        color: "#888888",
        iconKind: "Initial",
        mapId: "map1",
        x: 1.5,
        y: 2.5,
        sheetId: null,
        hidden: true,
      },
    ];

    it("filters out hidden tokens and tokens standing on fogged cells", () => {
      // Cell (5, 5) is fogged; cell (1, 1) and (1, 2) are revealed
      let mask = new Uint8Array(13); // 100 bits
      mask = setCellFogged(mask, GRID, 5, 5, true);
      const fogB64 = encodeFog(mask);

      const visible = filterDisplayTokens(TOKENS, fogB64, GRID);
      expect(visible.map((t) => t.id)).toEqual(["tok-revealed"]);
    });

    it("keeps all non-hidden tokens when fog is entirely revealed (empty mask)", () => {
      const visible = filterDisplayTokens(TOKENS, "", GRID);
      expect(visible.map((t) => t.id)).toEqual(["tok-revealed", "tok-fogged"]);
    });
  });

  describe("filterDisplayImages", () => {
    const IMAGES: MapImage[] = [
      {
        id: "img-revealed",
        name: "Visible Layer",
        contentType: "image/png",
        shareToken: null,
        x: 0,
        y: 0,
        width: 3,
        height: 3,
        originalWidth: 150,
        originalHeight: 150,
        rotation: 0,
        opacity: 1,
        layerOrder: 0,
        locked: false,
        hidden: false,
        byteSize: 100,
        wasDownscaled: false,
        originalLongEdgePx: 150,
        displayLongEdgePx: 150,
      },
      {
        id: "img-shrouded",
        name: "Shrouded Dungeon Room",
        contentType: "image/png",
        shareToken: null,
        x: 6,
        y: 6,
        width: 2,
        height: 2,
        originalWidth: 100,
        originalHeight: 100,
        rotation: 0,
        opacity: 1,
        layerOrder: 1,
        locked: false,
        hidden: false,
        byteSize: 100,
        wasDownscaled: false,
        originalLongEdgePx: 100,
        displayLongEdgePx: 100,
      },
      {
        id: "img-hidden",
        name: "Secret Layer",
        contentType: "image/png",
        shareToken: null,
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        originalWidth: 100,
        originalHeight: 100,
        rotation: 0,
        opacity: 1,
        layerOrder: 2,
        locked: false,
        hidden: true,
      } as unknown as MapImage,
    ];

    it("filters out hidden images and images completely shrouded by fog", () => {
      // Shroud cells (6,6), (6,7), (7,6), (7,7)
      let mask = new Uint8Array(13);
      mask = setCellFogged(mask, GRID, 6, 6, true);
      mask = setCellFogged(mask, GRID, 6, 7, true);
      mask = setCellFogged(mask, GRID, 7, 6, true);
      mask = setCellFogged(mask, GRID, 7, 7, true);
      const fogB64 = encodeFog(mask);

      const visible = filterDisplayImages(IMAGES, fogB64, GRID);
      expect(visible.map((i) => i.id)).toEqual(["img-revealed"]);
    });

    it("keeps image if at least one of its covered cells is revealed", () => {
      // Shroud only part of the room: (6,6) is fogged, but (7,7) is revealed
      let mask = new Uint8Array(13);
      mask = setCellFogged(mask, GRID, 6, 6, true);
      const fogB64 = encodeFog(mask);

      const visible = filterDisplayImages(IMAGES, fogB64, GRID);
      expect(visible.map((i) => i.id)).toEqual(["img-revealed", "img-shrouded"]);
    });
  });

  describe("resolveDisplayFraming", () => {
    it("calculates camera center and zoom for a focus rectangle accurately", () => {
      // Focus box at x: 2, y: 3, width: 4, height: 2 in cells
      // screen: 1920 x 1080 px
      // cellPixels: 50 px -> worldW = 200 px, worldH = 100 px
      const result = resolveDisplayFraming(
        { x: 2, y: 3, width: 4, height: 2 },
        1920,
        1080,
        50,
      );

      // Center: (2 + 2) * 50 = 200, (3 + 1) * 50 = 200
      expect(result.centerX).toBe(200);
      expect(result.centerY).toBe(200);

      // fitZoom: min(1920 / 200 = 9.6, 1080 / 100 = 10.8) -> 9.6
      expect(result.zoom).toBeCloseTo(9.6, 2);
    });

    it("clamps zoom level between 0.01 and 10.0", () => {
      // Huge area
      const minClamp = resolveDisplayFraming(
        { x: 0, y: 0, width: 100000, height: 100000 },
        1920,
        1080,
        50,
      );
      expect(minClamp.zoom).toBe(0.01);

      // Tiny area
      const maxClamp = resolveDisplayFraming(
        { x: 0, y: 0, width: 0.1, height: 0.1 },
        1920,
        1080,
        50,
      );
      expect(maxClamp.zoom).toBe(10.0);
    });
  });
});
