// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import Phaser from "phaser";
import { applyViewport, CELL } from "./viewport";

describe("Grid clamping and line count calculations", () => {
  /**
   * Helper computing the number of grid lines drawn for a given camera and map size.
   * Matches the exact algorithm in MapScene.redrawGrid().
   */
  function countGridLines(
    cam: Phaser.Cameras.Scene2D.Camera,
    widthCells: number,
    heightCells: number,
    cellPixels = CELL,
  ): { vertical: number; horizontal: number; total: number } {
    cam.preRender();
    const view = cam.worldView;

    const x0 = Math.max(0, Math.floor(view.x / cellPixels));
    const x1 = Math.min(widthCells, Math.ceil(view.right / cellPixels));
    const y0 = Math.max(0, Math.floor(view.y / cellPixels));
    const y1 = Math.min(heightCells, Math.ceil(view.bottom / cellPixels));

    if (x1 < x0 || y1 < y0) {
      return { vertical: 0, horizontal: 0, total: 0 };
    }

    const vertical = x1 - x0 + 1;
    const horizontal = y1 - y0 + 1;
    return { vertical, horizontal, total: vertical + horizontal };
  }

  it("at zoom 0.01 draws <= widthCells + heightCells + 2 lines (clamped to map, not camera)", () => {
    const cam = new Phaser.Cameras.Scene2D.Camera(0, 0, 1920, 1080);
    const widthCells = 30;
    const heightCells = 20;

    // Zoom out to 0.01 centered on the map
    applyViewport(cam, 0, 0, 0.01, CELL);

    const { vertical, horizontal, total } = countGridLines(cam, widthCells, heightCells, CELL);

    // Max theoretical lines for a clamped grid is (widthCells + 1) + (heightCells + 1)
    const maxBound = widthCells + heightCells + 2;
    expect(total).toBeLessThanOrEqual(maxBound);
    expect(vertical).toBe(widthCells + 1); // 31 vertical lines (0 through 30)
    expect(horizontal).toBe(heightCells + 1); // 21 horizontal lines (0 through 20)
    expect(total).toBe(52);
  });

  it("draws 0 lines when camera is scrolled completely off the map", () => {
    const cam = new Phaser.Cameras.Scene2D.Camera(0, 0, 1920, 1080);
    const widthCells = 30;
    const heightCells = 20;

    // Pan camera 500 cells away from map
    applyViewport(cam, 500, 500, 1.0, CELL);

    const { total } = countGridLines(cam, widthCells, heightCells, CELL);
    expect(total).toBe(0);
  });

  it("draws only visible subset of lines at high zoom", () => {
    const cam = new Phaser.Cameras.Scene2D.Camera(0, 0, 1920, 1080);
    const widthCells = 200;
    const heightCells = 200;

    // At zoom 10, visible width is 1920 / 10 = 192 world px = 3 cells!
    applyViewport(cam, 50, 50, 10.0, CELL);

    const { vertical, horizontal, total } = countGridLines(cam, widthCells, heightCells, CELL);
    expect(vertical).toBeLessThan(10);
    expect(horizontal).toBeLessThan(10);
    expect(total).toBeLessThan(20);
  });
});
