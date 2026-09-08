/*
 * Camera viewport and coordinate mapping functions.
 *
 * Coordinates:
 *  - Cells: Grid cell coordinates (tokens centered at x.5, y.5; images at x, y).
 *  - World Units: Pixels in Phaser world space at CELL scale.
 *
 * The camera midpoint correction in applyViewport() is NOT optional:
 * Phaser zooms cameras about their midpoint (width/2, height/2), whereas legacy
 * panX, panY represent the world cell coordinate at the stage's top-left.
 * The correction term cancels the midpoint offset so that world cell (panX, panY)
 * consistently sits at the viewport's top-left at any zoom level.
 */

import Phaser from "phaser";

/** Fixed world cell size in Phaser world pixels, decoupling scene geometry from synced grid metadata. */
export const CELL = 64;

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 10.0;
export const WHEEL_FACTOR = 1.1;
export const TOOLBAR_FACTOR = 1.25;

export interface ViewportState {
  panX: number;
  panY: number;
  zoom: number;
}

/**
 * Apply legacy top-left pan and zoom to a Phaser 2D Camera with the midpoint correction.
 *
 * Camera midpoint zoom formula:
 *   worldView.x = scrollX + (cam.width / 2) * (1 - 1 / cam.zoom)
 * Solving for scrollX to place world coordinate (panX * cellPixels) at worldView.x:
 *   scrollX = panX * cellPixels - (cam.width / 2) * (1 - 1 / cam.zoom)
 */
export function applyViewport(
  cam: Phaser.Cameras.Scene2D.Camera,
  panX: number,
  panY: number,
  zoom: number,
  cellPixels = CELL,
): void {
  cam.setZoom(Phaser.Math.Clamp(zoom, MIN_ZOOM, MAX_ZOOM));
  cam.scrollX = panX * cellPixels - (cam.width / 2) * (1 - 1 / cam.zoom);
  cam.scrollY = panY * cellPixels - (cam.height / 2) * (1 - 1 / cam.zoom);
}

/**
 * Read the visible top-left world cell coordinate and zoom back out of the camera.
 */
export function readViewport(
  cam: Phaser.Cameras.Scene2D.Camera,
  cellPixels = CELL,
): ViewportState {
  return {
    panX: cam.worldView.x / cellPixels,
    panY: cam.worldView.y / cellPixels,
    zoom: cam.zoom,
  };
}

/**
 * Zoom about a specific screen anchor point (e.g. mouse cursor or rail-aware center)
 * so that the world point under (sx, sy) does not move on screen.
 */
export function zoomAtAnchor(
  cam: Phaser.Cameras.Scene2D.Camera,
  factor: number,
  sx: number,
  sy: number,
): void {
  cam.preRender();
  const before = cam.getWorldPoint(sx, sy);
  cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM));
  cam.preRender();
  const after = cam.getWorldPoint(sx, sy);
  cam.scrollX += before.x - after.x;
  cam.scrollY += before.y - after.y;
  cam.preRender();
}
