// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import Phaser from "phaser";
import { applyViewport, readViewport, zoomAtAnchor, CELL } from "./viewport";

describe("Viewport and camera midpoint correction", () => {
  /** Helper creating a mock or real Phaser Camera with a defined viewport size. */
  function createTestCamera(width = 1920, height = 1080): Phaser.Cameras.Scene2D.Camera {
    const cam = new Phaser.Cameras.Scene2D.Camera(0, 0, width, height);
    return cam;
  }

  it("places world cell (panX, panY) at viewport top-left at zoom 1, 4, and 10", () => {
    const cam = createTestCamera(1920, 1080);
    const panX = 12.5;
    const panY = 8.0;

    for (const zoom of [1, 4, 10]) {
      applyViewport(cam, panX, panY, zoom, CELL);

      // Camera preRender computes worldView from scrollX and midpoint zoom
      cam.preRender();

      const calculatedPanX = cam.worldView.x / CELL;
      const calculatedPanY = cam.worldView.y / CELL;

      expect(cam.zoom).toBe(zoom);
      expect(calculatedPanX).toBeCloseTo(panX, 5);
      expect(calculatedPanY).toBeCloseTo(panY, 5);
    }
  });

  it("fails the top-left assertion if naive scrollX assignment without midpoint correction were used", () => {
    const cam = createTestCamera(1920, 1080);
    const panX = 10;
    const zoom = 4;

    // Naive assignment without midpoint correction
    cam.setZoom(zoom);
    cam.scrollX = panX * CELL;
    cam.preRender();

    // At zoom 4, w = 1920, midpoint offset is (1920 / 2) * (1 - 1/4) = 960 * 0.75 = 720 px
    // In cells: 720 / 64 = 11.25 cells error!
    const naivePanX = cam.worldView.x / CELL;
    expect(naivePanX).not.toBeCloseTo(panX, 1);
    expect(naivePanX - panX).toBeCloseTo(720 / CELL, 4);
  });

  it("inverts applyViewport via readViewport symmetrically", () => {
    const cam = createTestCamera(1280, 720);
    const panX = -5.5;
    const panY = 22.25;
    const zoom = 2.5;

    applyViewport(cam, panX, panY, zoom, CELL);
    cam.preRender();

    const result = readViewport(cam, CELL);
    expect(result.panX).toBeCloseTo(panX, 5);
    expect(result.panY).toBeCloseTo(panY, 5);
    expect(result.zoom).toBe(zoom);
  });

  it("anchors cursor during zoomAtAnchor so world point under cursor does not move", () => {
    const cam = createTestCamera(1920, 1080);
    applyViewport(cam, 10, 10, 1.0, CELL);
    cam.preRender();

    const cursorScreenX = 400;
    const cursorScreenY = 300;

    const worldBefore = cam.getWorldPoint(cursorScreenX, cursorScreenY);

    // Zoom in by 1.5x at cursor
    zoomAtAnchor(cam, 1.5, cursorScreenX, cursorScreenY);
    cam.preRender();

    const worldAfter = cam.getWorldPoint(cursorScreenX, cursorScreenY);

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 3);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 3);
  });
});
