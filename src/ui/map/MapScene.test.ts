// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import { MapScene } from "./MapScene";
import { brushFootprint, computeFogPerimeter, FogLayer } from "./fogLayer";
import { RulerOverlay } from "./rulerOverlay";
import { FocusOverlay } from "./focusOverlay";
import type { GridConfig, MapImage, Token } from "../../game/domain";
import { encodeFog, fillFog, setCellFogged } from "../../game/fog";

function createTestGame(scene: Phaser.Scene): Promise<Phaser.Game> {
  return new Promise<Phaser.Game>((resolve) => {
    new Phaser.Game({
      type: Phaser.HEADLESS,
      width: 1920,
      height: 1080,
      scene: [scene],
      callbacks: {
        postBoot: (bootedGame) => {
          // Patch Phaser 4.2.1 headless bug where TextureManager.stamp is undefined on destroy
          const tm = bootedGame.textures as unknown as { stamp?: { destroy: () => void } };
          if (tm && !tm.stamp) {
            tm.stamp = { destroy: () => {} };
          }
          resolve(bootedGame);
        },
      },
    });
  });
}

describe("MapScene Rendering and Interactions (05 — Rendering)", () => {
  let game: Phaser.Game;
  let scene: MapScene;

  beforeEach(async () => {
    scene = new MapScene();
    game = await createTestGame(scene);
  });

  afterEach(() => {
    try {
      game.destroy(true, false);
    } catch {
      // Phaser headless teardown in happy-dom mock environment
    }
  });

  it("initializes depth bands and viewport correctly", () => {
    expect(DEPTH.BACKGROUND).toBe(0);
    expect(DEPTH.IMAGES).toBe(1);
    expect(DEPTH.GRID).toBe(1000);
    expect(DEPTH.MARKUP).toBe(2000);
    expect(DEPTH.FOG).toBe(3000);
    expect(DEPTH.TOKENS).toBe(4000);
    expect(DEPTH.FOCUS_RULER).toBe(5000);
    expect(DEPTH.SELECTION).toBe(6000);

    const cam = scene.cameras.main;
    expect(cam.zoom).toBe(1.0);
    expect(cam.scrollX).toBeCloseTo(0, 1);
  });

  it("assigns rank-normalized depths to images avoiding arbitrary layerOrder collisions", () => {
    const images: MapImage[] = [
      {
        id: "img1",
        name: "Background",
        contentType: "image/png",
        shareToken: null,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        originalWidth: 640,
        originalHeight: 640,
        rotation: 0,
        opacity: 1,
        layerOrder: 1500, // Dangerous: > 1000 would draw over grid if not normalized!
        locked: false,
        hidden: false,
        byteSize: 1000,
        wasDownscaled: false,
        originalLongEdgePx: 640,
        displayLongEdgePx: 640,
      },
      {
        id: "img2",
        name: "Overlay",
        contentType: "image/png",
        shareToken: null,
        x: 2,
        y: 2,
        width: 5,
        height: 5,
        originalWidth: 320,
        originalHeight: 320,
        rotation: 45,
        opacity: 0.8,
        layerOrder: -50, // Negative layerOrder
        locked: false,
        hidden: false,
        byteSize: 500,
        wasDownscaled: false,
        originalLongEdgePx: 320,
        displayLongEdgePx: 320,
      },
      {
        id: "img3",
        name: "Mid",
        contentType: "image/png",
        shareToken: null,
        x: 4,
        y: 4,
        width: 4,
        height: 4,
        originalWidth: 256,
        originalHeight: 256,
        rotation: 0,
        opacity: 1,
        layerOrder: 5,
        locked: false,
        hidden: false,
        byteSize: 400,
        wasDownscaled: false,
        originalLongEdgePx: 256,
        displayLongEdgePx: 256,
      },
    ];

    scene.updateImages(images);

    // Sorted order by layerOrder: img2 (-50) -> rank 0, img3 (5) -> rank 1, img1 (1500) -> rank 2
    // All depths must be in [DEPTH.IMAGES, DEPTH.GRID - 1] = [1, 999]
    const sprite1 = (
      scene as unknown as { imageLayer: { sprites: Map<string, Phaser.GameObjects.Image> } }
    ).imageLayer.sprites.get("img1")!;
    const sprite2 = (
      scene as unknown as { imageLayer: { sprites: Map<string, Phaser.GameObjects.Image> } }
    ).imageLayer.sprites.get("img2")!;
    const sprite3 = (
      scene as unknown as { imageLayer: { sprites: Map<string, Phaser.GameObjects.Image> } }
    ).imageLayer.sprites.get("img3")!;

    expect(sprite2.depth).toBe(DEPTH.IMAGES + 0); // 1
    expect(sprite3.depth).toBe(DEPTH.IMAGES + 1); // 2
    expect(sprite1.depth).toBe(DEPTH.IMAGES + 2); // 3

    expect(sprite1.depth).toBeLessThan(DEPTH.GRID);
    expect(sprite2.depth).toBeGreaterThanOrEqual(DEPTH.IMAGES);
  });

  it("calculates image center position and rotation origin matching legacy Canvas2D translation", () => {
    const img: MapImage = {
      id: "rot_test",
      name: "Rotated Map Piece",
      contentType: "image/png",
      shareToken: null,
      x: 10,
      y: 8,
      width: 6,
      height: 4,
      originalWidth: 384,
      originalHeight: 256,
      rotation: 90, // Degrees
      opacity: 0.9,
      layerOrder: 1,
      locked: false,
      hidden: false,
      byteSize: 1000,
      wasDownscaled: false,
      originalLongEdgePx: 384,
      displayLongEdgePx: 384,
    };

    scene.updateImages([img]);

    const sprite = (
      scene as unknown as { imageLayer: { sprites: Map<string, Phaser.GameObjects.Image> } }
    ).imageLayer.sprites.get("rot_test")!;

    // Origin must be center (0.5, 0.5)
    expect(sprite.originX).toBe(0.5);
    expect(sprite.originY).toBe(0.5);

    // Position must be at center: (x + width/2) * CELL, (y + height/2) * CELL
    const expectedCenterX = (10 + 6 / 2) * CELL; // 13 * 64 = 832
    const expectedCenterY = (8 + 4 / 2) * CELL; // 10 * 64 = 640

    expect(sprite.x).toBe(expectedCenterX);
    expect(sprite.y).toBe(expectedCenterY);
    expect(sprite.angle).toBe(90);
    expect(sprite.displayWidth).toBe(6 * CELL);
    expect(sprite.displayHeight).toBe(4 * CELL);
  });

  it("creates token containers with readable labels, halos, and stack detection", () => {
    const tokens: Token[] = [
      {
        id: "tok1",
        type: "PlayerToken",
        ownerUserId: "user_a",
        representsUserId: null,
        name: "Aragorn",
        color: "#1a1a1a", // dark -> readable label text is white
        iconKind: "Initial",
        mapId: "map1",
        x: 5.5,
        y: 4.5,
        sheetId: null,
        hidden: false,
      },
      {
        id: "tok2",
        type: "PlayerToken",
        ownerUserId: null,
        representsUserId: null,
        name: "Legolas",
        color: "#ffffff", // light -> readable label text is black
        iconKind: "Initial",
        mapId: "map1",
        x: 5.5,
        y: 4.5, // Co-located with tok1 -> stack of 2!
        sheetId: null,
        hidden: false,
      },
    ];

    scene.updateTokens(tokens);

    const tokenContainers = (
      scene as unknown as {
        tokenLayer: { tokenContainers: Map<string, Phaser.GameObjects.Container> };
      }
    ).tokenLayer.tokenContainers;

    const c1 = tokenContainers.get("tok1")!;
    const c2 = tokenContainers.get("tok2")!;

    expect(c1).toBeDefined();
    expect(c2).toBeDefined();

    expect(c1.x).toBe(5.5 * CELL);
    expect(c1.y).toBe(4.5 * CELL);

    // tok1 is on top and visible; tok2 is stacked behind until expanded
    expect(c1.visible).toBe(true);
    expect(c2.visible).toBe(false);
  });

  it("manages tool mode state transitions and Space-to-pan override", () => {
    expect(scene.effectiveMode).toBe("none");

    scene.setToolMode("fog");
    expect(scene.effectiveMode).toBe("fog");

    scene.setToolMode("ruler");
    expect(scene.effectiveMode).toBe("ruler");

    // Simulate holding Space: overrides any active tool to "none" for panning
    (scene as unknown as { spaceHeld: boolean }).spaceHeld = true;
    expect(scene.effectiveMode).toBe("none");

    // Releasing Space restores tool
    (scene as unknown as { spaceHeld: boolean }).spaceHeld = false;
    expect(scene.effectiveMode).toBe("ruler");
  });

  it("centers and resets viewport properly", () => {
    const cam = scene.cameras.main;

    scene.centerOn(15, 10);
    expect(cam.midPoint.x).toBeCloseTo(15 * CELL, 1);
    expect(cam.midPoint.y).toBeCloseTo(10 * CELL, 1);

    scene.zoomIn();
    expect(cam.zoom).toBeGreaterThan(1.0);

    scene.resetView();
    expect(cam.zoom).toBe(1.0);
  });

  it("centers on the visible center between rails", () => {
    const cam = scene.cameras.main;
    scene.resetView();
    scene.setRailInsets(300, 100);

    scene.centerOn(15, 10);

    // The token must land under the visible-center anchor (1060, 540),
    // not under the physical canvas midpoint (960, 540).
    const anchorX = (cam.width + scene.railLeft - scene.railRight) / 2;
    const anchorY = cam.height / 2;
    const wp = cam.getWorldPoint(anchorX, anchorY);
    expect(wp.x).toBeCloseTo(15 * CELL, 1);
    expect(wp.y).toBeCloseTo(10 * CELL, 1);
  });

  it("zooms cursor-anchored for DOM overlay surfaces", () => {
    const cam = scene.cameras.main;
    scene.resetView();
    cam.preRender();

    const sx = 400;
    const sy = 300;
    const before = cam.getWorldPoint(sx, sy);

    scene.zoomAtScreenPoint(2.0, sx, sy);
    expect(cam.zoom).toBeCloseTo(2.0, 4);

    // The world point under the cursor must not move.
    const after = cam.getWorldPoint(sx, sy);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  it("pans by screen-pixel deltas for DOM overlay gestures", () => {
    const cam = scene.cameras.main;
    scene.resetView();
    cam.setZoom(2.0);
    cam.preRender();

    const sx = 100;
    const sy = 200;
    const before = cam.getWorldPoint(sx, sy);

    scene.panByScreenDelta(100, 50);

    // The content follows the drag: the old world point now sits one delta away.
    const after = cam.getWorldPoint(sx + 100, sy + 50);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  it("gates token dragging by move policy and keeps stacked tops click-only", () => {
    const tokens: Token[] = [
      {
        id: "solo",
        type: "PlayerToken",
        ownerUserId: "u1",
        representsUserId: null,
        name: "Solo",
        color: "#fff",
        iconKind: "Initial",
        mapId: "map1",
        x: 2.5,
        y: 2.5,
        sheetId: null,
        hidden: false,
      },
      {
        id: "stack-top",
        type: "PlayerToken",
        ownerUserId: "u1",
        representsUserId: null,
        name: "Top",
        color: "#fff",
        iconKind: "Initial",
        mapId: "map1",
        x: 5.5,
        y: 4.5,
        sheetId: null,
        hidden: false,
      },
      {
        id: "stack-behind",
        type: "PlayerToken",
        ownerUserId: "u1",
        representsUserId: null,
        name: "Behind",
        color: "#fff",
        iconKind: "Initial",
        mapId: "map1",
        x: 5.5,
        y: 4.5,
        sheetId: null,
        hidden: false,
      },
    ];
    scene.updateTokens(tokens);

    const tokenContainers = (
      scene as unknown as {
        tokenLayer: { tokenContainers: Map<string, Phaser.GameObjects.Container> };
      }
    ).tokenLayer.tokenContainers;

    const solo = tokenContainers.get("solo")!;
    const top = tokenContainers.get("stack-top")!;
    const behind = tokenContainers.get("stack-behind")!;

    // Default policy allows everything: single is draggable, stack top is
    // click-only (moves via popover chips), behind is hidden.
    expect((solo.input as unknown as { draggable: boolean }).draggable).toBe(true);
    expect((top.input as unknown as { draggable: boolean }).draggable).toBe(false);
    expect(behind.visible).toBe(false);

    // Deny-all policy: even the single token becomes click-only.
    scene.setTokenMovePolicy(() => false);
    expect((solo.input as unknown as { draggable: boolean }).draggable).toBe(false);

    // Re-allow: draggable again.
    scene.setTokenMovePolicy(() => true);
    expect((solo.input as unknown as { draggable: boolean }).draggable).toBe(true);
  });

  it("trusts host projection for hiding; ghosts hidden tokens for the DM", () => {
    const tokens: Token[] = [
      {
        id: "hidden-top",
        type: "PlayerToken",
        ownerUserId: "u1",
        representsUserId: null,
        name: "Hidden",
        color: "#fff",
        iconKind: "Initial",
        mapId: "map1",
        x: 5.5,
        y: 4.5,
        sheetId: null,
        hidden: true,
      },
      {
        id: "visible-under",
        type: "PlayerToken",
        ownerUserId: "u1",
        representsUserId: null,
        name: "Seen",
        color: "#fff",
        iconKind: "Initial",
        mapId: "map1",
        x: 5.5,
        y: 4.5,
        sheetId: null,
        hidden: false,
      },
    ];

    // Hiding is owned by host projection: guests never receive hidden tokens,
    // so the layer renders whatever it is given without client-side filtering.
    scene.setDm(false);
    scene.updateTokens(tokens);

    const tokenContainers = (
      scene as unknown as {
        tokenLayer: { tokenContainers: Map<string, Phaser.GameObjects.Container> };
      }
    ).tokenLayer.tokenContainers;

    expect(tokenContainers.get("hidden-top")!.visible).toBe(true);
    expect(tokenContainers.get("visible-under")!.visible).toBe(false);

    // The DM renders the full truth with hidden tokens ghosted.
    scene.setDm(true);
    scene.updateTokens(tokens);
    expect(tokenContainers.get("hidden-top")!.visible).toBe(true);
  });

  it("conceals tokens on fogged cells from non-owners but shows them to owner and DM", () => {
    const grid: GridConfig = {
      widthCells: 30,
      heightCells: 20,
      cellPixels: CELL,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    };
    scene.updateGrid(grid);

    // Cells (5, 4) and (6, 4) are fogged; (10, 10) stays revealed.
    let mask = setCellFogged(new Uint8Array(0), grid, 5, 4, true);
    mask = setCellFogged(mask, grid, 6, 4, true);
    const tokens: Token[] = [
      {
        id: "foreign-fogged",
        type: "NPCToken",
        ownerUserId: null,
        representsUserId: null,
        name: "Goblin",
        color: "#0f0",
        iconKind: "Initial",
        mapId: "map1",
        x: 5.5,
        y: 4.5,
        sheetId: null,
        hidden: false,
      },
      {
        id: "owned-fogged",
        type: "PlayerToken",
        ownerUserId: "u1",
        representsUserId: null,
        name: "Hero",
        color: "#00f",
        iconKind: "Initial",
        mapId: "map1",
        x: 6.5,
        y: 4.5,
        sheetId: null,
        hidden: false,
      },
      {
        id: "foreign-revealed",
        type: "NPCToken",
        ownerUserId: null,
        representsUserId: null,
        name: "Shopkeep",
        color: "#ff0",
        iconKind: "Initial",
        mapId: "map1",
        x: 10.5,
        y: 10.5,
        sheetId: null,
        hidden: false,
      },
    ];

    scene.setDm(false);
    scene.setViewerUserId("u1");
    scene.updateFog(encodeFog(mask));
    scene.updateTokens(tokens);

    const tokenContainers = (
      scene as unknown as {
        tokenLayer: { tokenContainers: Map<string, Phaser.GameObjects.Container> };
      }
    ).tokenLayer.tokenContainers;

    // NPC on fog with no owner: hidden from the player.
    expect(tokenContainers.get("foreign-fogged")!.visible).toBe(false);
    // Owner still sees their own token standing in fog.
    expect(tokenContainers.get("owned-fogged")!.visible).toBe(true);
    // Tokens on revealed cells stay visible to everyone.
    expect(tokenContainers.get("foreign-revealed")!.visible).toBe(true);

    // The DM sees everything, including the fog-concealed NPC.
    scene.setDm(true);
    scene.updateTokens(tokens);
    expect(tokenContainers.get("foreign-fogged")!.visible).toBe(true);
    expect(tokenContainers.get("owned-fogged")!.visible).toBe(true);

    // Clearing the fog reveals the concealed token to the player again.
    scene.setDm(false);
    scene.updateFog("");
    expect(tokenContainers.get("foreign-fogged")!.visible).toBe(true);
  });

  it("anchors zoom to the visible center between rails", () => {
    const cam = scene.cameras.main;
    scene.resetView();

    // Set asymmetrical rail insets: left rail 300px, right rail 100px
    scene.setRailInsets(300, 100);
    expect(scene.railLeft).toBe(300);
    expect(scene.railRight).toBe(100);

    // Visible canvas interval is [300, 1920 - 100] = [300, 1820]. Center is 1060.
    // Formula: (1920 + 300 - 100) / 2 = 1060.
    const expectedAnchorX = (cam.width + scene.railLeft - scene.railRight) / 2;
    expect(expectedAnchorX).toBe(1060);
    const expectedAnchorY = cam.height / 2;

    const worldBefore = cam.getWorldPoint(expectedAnchorX, expectedAnchorY);

    scene.zoomIn();

    // Invariant: screen anchor point maps to the exact same world coordinate before and after zoom
    const worldAfter = cam.getWorldPoint(expectedAnchorX, expectedAnchorY);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 1);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 1);

    scene.zoomOut();

    const worldAfterZoomOut = cam.getWorldPoint(expectedAnchorX, expectedAnchorY);
    expect(worldAfterZoomOut.x).toBeCloseTo(worldBefore.x, 1);
    expect(worldAfterZoomOut.y).toBeCloseTo(worldBefore.y, 1);
  });

  it("updates active turn token halo and pans camera to world coordinates", () => {
    const tokens: Token[] = [
      {
        id: "tok-1",
        type: "PlayerToken",
        name: "Valeros",
        color: "#f00",
        iconKind: "Initial",
        mapId: "map-1",
        x: 2.5,
        y: 2.5,
        sheetId: null,
        hidden: false,
        ownerUserId: "u1",
        representsUserId: null,
      },
    ];
    scene.updateTokens(tokens);
    scene.setActiveTurnTokenId("tok-1");
    expect(() => scene.setActiveTurnTokenId("tok-1")).not.toThrow();
    expect(() => scene.panToWorld(100, 200)).not.toThrow();
  });
});

describe("FogLayer Diffing and Brush Math", () => {
  let game: Phaser.Game;
  let scene: Phaser.Scene;
  let fogLayer: FogLayer;

  beforeEach(async () => {
    scene = new Phaser.Scene("TestFog");
    game = await createTestGame(scene);
    fogLayer = new FogLayer(scene);
  });

  afterEach(() => {
    fogLayer.destroy();
    try {
      game.destroy(true, false);
    } catch {
      // Phaser headless teardown in happy-dom mock environment
    }
  });

  it("accumulates correct brush cells for radii 1, 2, and 3", () => {
    const grid: GridConfig = {
      widthCells: 30,
      heightCells: 20,
      cellPixels: CELL,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    };
    fogLayer.setupGrid(grid);

    // Radius 1: exactly 1 cell
    fogLayer.startStroke();
    fogLayer.addBrushCells(5, 5, 1);
    expect(fogLayer.strokeCells.size).toBe(1);
    expect(fogLayer.strokeCells.has(5 * 30 + 5)).toBe(true);
    fogLayer.endStroke();

    // Radius 2: 3x3 block = 9 cells
    fogLayer.startStroke();
    fogLayer.addBrushCells(5, 5, 2);
    expect(fogLayer.strokeCells.size).toBe(9);
    fogLayer.endStroke();

    // Radius 3: 5x5 rounded circle = 21 cells
    fogLayer.startStroke();
    fogLayer.addBrushCells(5, 5, 3);
    expect(fogLayer.strokeCells.size).toBe(21);
    fogLayer.endStroke();

    // Boundary clamping at map corner (0, 0)
    fogLayer.startStroke();
    fogLayer.addBrushCells(0, 0, 2);
    // At corner (0,0), radius 2 checks dx in [-1, 1], dy in [-1, 1], only (0,0), (1,0), (0,1), (1,1) valid = 4 cells
    expect(fogLayer.strokeCells.size).toBe(4);
    fogLayer.endStroke();
  });

  it("clears the fog texture when the mask is emptied (clear-fog regression)", () => {
    const grid: GridConfig = {
      widthCells: 8,
      heightCells: 8,
      cellPixels: CELL,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    };
    fogLayer.setupGrid(grid);

    // Fill every cell, then clear: no texel may stay opaque.
    fogLayer.updateMask(encodeFog(fillFog(grid)));
    const data = (fogLayer as unknown as { cachedImageData: ImageData }).cachedImageData.data;
    expect(data[0 * 4 + 3]).toBe(255);
    expect(data[63 * 4 + 3]).toBe(255);

    fogLayer.updateMask("");
    for (let i = 0; i < 64; i++) {
      expect(data[i * 4 + 3]).toBe(0);
    }
  });

  it("computes brush footprints shared by strokes and hover previews", () => {
    expect(brushFootprint(5, 5, 1, 30, 20)).toEqual([5 * 30 + 5]);
    expect(brushFootprint(5, 5, 2, 30, 20)).toHaveLength(9);
    expect(brushFootprint(5, 5, 3, 30, 20)).toHaveLength(21);
    // Corner clamping matches the legacy stroke behavior (4 cells).
    expect(brushFootprint(0, 0, 2, 30, 20)).toHaveLength(4);
  });

  it("interpolates fast strokes so no gaps remain between frames", () => {
    const grid: GridConfig = {
      widthCells: 30,
      heightCells: 20,
      cellPixels: CELL,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    };
    fogLayer.setupGrid(grid);

    // Fast horizontal jump: every cell between the frames is covered.
    fogLayer.startStroke();
    fogLayer.addBrushCells(0, 0, 1);
    fogLayer.addBrushCells(5, 0, 1);
    const horizontal = fogLayer.endStroke();
    for (let x = 0; x <= 5; x++) {
      expect(horizontal).toContain(x);
    }

    // Fast diagonal jump likewise leaves no gaps.
    fogLayer.startStroke();
    fogLayer.addBrushCells(0, 0, 1);
    fogLayer.addBrushCells(3, 3, 1);
    const diagonal = fogLayer.endStroke();
    for (let i = 0; i <= 3; i++) {
      expect(diagonal).toContain(i * 30 + i);
    }

    // Interpolation accumulates into the same stroke set (mode-agnostic,
    // so paint and erase strokes both benefit).
    fogLayer.startStroke();
    fogLayer.addBrushCells(10, 10, 2);
    fogLayer.addBrushCells(12, 10, 2);
    const wide = fogLayer.endStroke();
    expect(wide).toContain(10 * 30 + 11); // cell (11, 10) bridged
  });

  it("traces the fog perimeter: empty, single cell, shared edges, full map", () => {
    // Empty mask → no border.
    expect(computeFogPerimeter(new Uint8Array(0), 4, 4)).toEqual([]);

    // Single fogged cell → its 4 edges.
    const grid4: GridConfig = {
      widthCells: 4,
      heightCells: 4,
      cellPixels: CELL,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    };
    let mask = setCellFogged(new Uint8Array(0), grid4, 1, 1, true);
    expect(computeFogPerimeter(mask, 4, 4)).toHaveLength(4);

    // Two adjacent cells share an edge → 6 segments, not 8.
    mask = setCellFogged(mask, grid4, 2, 1, true);
    expect(computeFogPerimeter(mask, 4, 4)).toHaveLength(6);

    // Full map → just the outer rectangle (perimeter of the grid).
    const full = computeFogPerimeter(fillFog(grid4), 4, 4);
    expect(full).toHaveLength(16);
    for (const e of full) {
      const onOuter =
        e.y1 === 0 || e.y1 === 4 || e.x1 === 0 || e.x1 === 4;
      expect(onOuter).toBe(true);
    }
  });

  it("updates fog mask with XOR diffing", () => {
    const grid: GridConfig = {
      widthCells: 16,
      heightCells: 16,
      cellPixels: CELL,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    };
    fogLayer.setupGrid(grid);

    const maskBytes1 = new Uint8Array(32); // 256 bits = 32 bytes
    maskBytes1[0] = 0b00000001; // cell 0 is fogged
    const b64_1 = encodeFog(maskBytes1);

    fogLayer.updateMask(b64_1);

    const data = (fogLayer as unknown as { cachedImageData: ImageData }).cachedImageData.data;
    expect(data[0 * 4 + 3]).toBe(255); // cell 0 fogged
    expect(data[1 * 4 + 3]).toBe(0); // cell 1 clear

    // Diff update: reveal cell 0, fog cell 1
    const maskBytes2 = new Uint8Array(32);
    maskBytes2[0] = 0b00000010; // cell 1 is fogged
    const b64_2 = encodeFog(maskBytes2);

    fogLayer.updateMask(b64_2);
    expect(data[0 * 4 + 3]).toBe(0); // cell 0 now clear
    expect(data[1 * 4 + 3]).toBe(255); // cell 1 now fogged
  });
});

describe("RulerOverlay and FocusOverlay Math", () => {
  let game: Phaser.Game;
  let scene: Phaser.Scene;

  beforeEach(async () => {
    scene = new Phaser.Scene("TestOverlays");
    game = await createTestGame(scene);
  });

  afterEach(() => {
    try {
      game.destroy(true, false);
    } catch {
      // Phaser headless teardown in happy-dom mock environment
    }
  });

  it("handles ruler measurement points and clear", () => {
    const ruler = new RulerOverlay(scene);

    expect(ruler.isActive).toBe(false);
    ruler.setPointA(2, 3);
    expect(ruler.isActive).toBe(true);
    expect(ruler.pointA).toEqual({ x: 2, y: 3 });

    ruler.setPointB(6, 6);
    expect(ruler.pointB).toEqual({ x: 6, y: 6 });

    ruler.clear();
    expect(ruler.isActive).toBe(false);
    expect(ruler.pointA).toBeNull();
    expect(ruler.pointB).toBeNull();

    ruler.destroy();
  });

  it("calculates focus rect with and without grid snapping", () => {
    const focus = new FocusOverlay(scene);

    focus.startDrag(2.2, 3.8);
    focus.updateDrag(7.1, 8.4, true);

    const snapped = focus.endDrag("map1", true);
    expect(snapped).toEqual({
      mapId: "map1",
      x: 2, // floor(2.2)
      y: 3, // floor(3.8)
      width: 6, // ceil(7.1) - 2 = 8 - 2 = 6
      height: 6, // ceil(8.4) - 3 = 9 - 3 = 6
    });

    // Without snapping
    focus.startDrag(2.2, 3.8);
    focus.updateDrag(7.2, 8.8, false);

    const unsnapped = focus.endDrag("map1", false);
    expect(unsnapped!.x).toBeCloseTo(2.2, 4);
    expect(unsnapped!.y).toBeCloseTo(3.8, 4);
    expect(unsnapped!.width).toBeCloseTo(5.0, 4);
    expect(unsnapped!.height).toBeCloseTo(5.0, 4);

    focus.destroy();
  });
});
