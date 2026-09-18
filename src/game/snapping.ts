/*
 * Snapping helpers.
 *
 * Rules:
 *   1. Tokens snap to cell CENTRES (x.5, y.5) and are ALWAYS clamped to map bounds:
 *        - snapping ON:  round to nearest centre, clamp to [0.5, widthCells - 0.5]
 *        - snapping OFF: raw coordinates, clamp to [0, widthCells]
 *   2. Images snap to whole-cell CORNERS (x, y) and are NEVER clamped (they may sit off-map):
 *        - snapping ON:  round to nearest integer cell
 *        - snapping OFF: raw coordinates untouched
 */

import type { GridConfig } from "./domain.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Snaps a token's position to cell centres and clamps to the grid.
 */
export function snapToken(
  x: number,
  y: number,
  grid: GridConfig,
): { readonly x: number; readonly y: number } {
  if (!grid.snapToGrid) {
    return {
      x: clamp(x, 0, grid.widthCells),
      y: clamp(y, 0, grid.heightCells),
    };
  }

  const sx = Math.round(x - 0.5) + 0.5;
  const sy = Math.round(y - 0.5) + 0.5;

  return {
    x: clamp(sx, 0.5, Math.max(0.5, grid.widthCells - 0.5)),
    y: clamp(sy, 0.5, Math.max(0.5, grid.heightCells - 0.5)),
  };
}

/**
 * Snaps a corner-anchored position (e.g. MapImage) to whole-cell coordinates.
 * Images are deliberately NOT clamped to the grid — they may hang off the map edge.
 */
export function snapCorner(
  x: number,
  y: number,
  grid: GridConfig,
): { readonly x: number; readonly y: number } {
  if (!grid.snapToGrid) return { x, y };
  return { x: Math.round(x), y: Math.round(y) };
}

export interface ImageResizeResult {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Computes snapped image bounding box during a 4-corner resize.
 */
export function snapImageResize(
  anchorX: number,
  anchorY: number,
  dragX: number,
  dragY: number,
  grid: GridConfig,
  lockAspectRatio = false,
  aspectRatio = 1.0,
  minDimension = 0.1,
): ImageResizeResult {
  const snappedDrag = snapCorner(dragX, dragY, grid);

  let rawWidth = Math.abs(snappedDrag.x - anchorX);
  let rawHeight = Math.abs(snappedDrag.y - anchorY);

  if (lockAspectRatio && aspectRatio > 0) {
    const fromWidth = rawWidth / aspectRatio;
    const fromHeight = rawHeight * aspectRatio;
    if (rawWidth > rawHeight * aspectRatio) {
      rawHeight = Math.max(minDimension, fromWidth);
    } else {
      rawWidth = Math.max(minDimension, fromHeight);
    }
  }

  const width = Math.max(minDimension, rawWidth);
  const height = Math.max(minDimension, rawHeight);

  const x = snappedDrag.x < anchorX ? anchorX - width : anchorX;
  const y = snappedDrag.y < anchorY ? anchorY - height : anchorY;

  return { x, y, width, height };
}
