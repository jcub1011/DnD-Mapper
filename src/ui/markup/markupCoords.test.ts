// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import Phaser from "phaser";
import { CELL } from "../map/viewport";
import {
  cellPointToScreenPoint,
  projectCellPointsToScreen,
} from "./dndm-markup-overlay";

describe("markup coordinate mapping (CELL-consistent)", () => {
  it("CELL matches the committed Phaser render scale", () => {
    // MarkupLayer renders cell -> world as cell * CELL; capture and preview
    // must use the same constant or strokes shift/scale on commit.
    expect(CELL).toBe(64);
  });

  it("projects cell points to screen pixels at zoom 1, zero scroll", () => {
    const pt = cellPointToScreenPoint(
      { x: 5, y: 3 },
      { scrollX: 0, scrollY: 0, zoom: 1, width: 800, height: 600 },
      { left: 0, top: 0 },
      { left: 0, top: 0 },
    );
    expect(pt.x).toBeCloseTo(5 * CELL, 6);
    expect(pt.y).toBeCloseTo(3 * CELL, 6);
  });

  it("applies scroll, zoom, and the zoom-about-midpoint term", () => {
    // screen = (world - scroll) * zoom + (size / 2) * (1 - zoom)
    const pt = cellPointToScreenPoint(
      { x: 10, y: 8 },
      { scrollX: 100, scrollY: 50, zoom: 2, width: 800, height: 600 },
      { left: 0, top: 0 },
      { left: 0, top: 0 },
    );
    expect(pt.x).toBeCloseTo((10 * CELL - 100) * 2 + 400 * (1 - 2), 6);
    expect(pt.y).toBeCloseTo((8 * CELL - 50) * 2 + 300 * (1 - 2), 6);
  });

  it("accounts for canvas-to-surface rect offset", () => {
    const pt = cellPointToScreenPoint(
      { x: 1, y: 1 },
      { scrollX: 0, scrollY: 0, zoom: 1, width: 800, height: 600 },
      { left: 10, top: 20 },
      { left: 4, top: 8 },
    );
    expect(pt.x).toBeCloseTo(1 * CELL + 6, 6);
    expect(pt.y).toBeCloseTo(1 * CELL + 12, 6);
  });

  it.each([0.25, 0.5, 1.0, 2.0, 4.0])(
    "agrees with the real Phaser camera at zoom %s",
    (zoom) => {
      const cam = new Phaser.Cameras.Scene2D.Camera(0, 0, 960, 600);
      cam.scrollX = 320;
      cam.scrollY = 160;
      cam.setZoom(zoom);
      cam.preRender();

      for (const cell of [
        { x: 12.5, y: 7.25 },
        { x: 0, y: 0 },
        { x: 30, y: 20 },
      ]) {
        const screen = cellPointToScreenPoint(
          cell,
          {
            scrollX: cam.scrollX,
            scrollY: cam.scrollY,
            zoom: cam.zoom,
            width: cam.width,
            height: cam.height,
          },
          { left: 0, top: 0 },
          { left: 0, top: 0 },
        );
        // Ground truth: Phaser's own matrix inverse must land back on the
        // world point the preview was projected from.
        const world = cam.getWorldPoint(screen.x, screen.y);
        expect(world.x).toBeCloseTo(cell.x * CELL, 3);
        expect(world.y).toBeCloseTo(cell.y * CELL, 3);
      }
    },
  );

  it("projects a whole stroke point-for-point", () => {
    const cells = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    const out = projectCellPointsToScreen(
      cells,
      { scrollX: 0, scrollY: 0, zoom: 0.5, width: 800, height: 600 },
      { left: 0, top: 0 },
      { left: 0, top: 0 },
    );
    expect(out).toHaveLength(2);
    expect(out[1].x).toBeCloseTo(CELL * 0.5 + 400 * 0.5, 6);
    expect(out[1].y).toBeCloseTo(CELL * 0.5 + 300 * 0.5, 6);
  });
});
