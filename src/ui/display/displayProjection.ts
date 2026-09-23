/*
 * Display Projection rules for Theater / Projector Mode.
 *
 * Implements:
 *   - Complete exclusion of hidden tokens and hidden images
 *   - Fog culling of tokens on fogged cells
 *   - Fog culling of images completely shrouded by fog
 *   - Focus rectangle framing bounds resolution
 */

import type { GridConfig, MapImage, Token } from "../../game/domain";
import { decodeFog, isFogged } from "../../game/fog";

export interface FramingResult {
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

export interface FramingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Filters out hidden tokens and tokens positioned on fogged cells.
 */
export function filterDisplayTokens(
  tokens: readonly Token[],
  fogMaskB64: string,
  grid: GridConfig,
): Token[] {
  const maskBytes = decodeFog(fogMaskB64);

  return tokens.filter((tok) => {
    if (tok.hidden) return false;

    const cellX = Math.floor(tok.x);
    const cellY = Math.floor(tok.y);

    // If standing on a fogged cell, exclude
    if (isFogged(maskBytes, grid, cellX, cellY)) {
      return false;
    }

    return true;
  });
}

/**
 * Filters out hidden images and images completely shrouded by fog.
 */
export function filterDisplayImages(
  images: readonly MapImage[],
  fogMaskB64: string,
  grid: GridConfig,
): MapImage[] {
  if (!fogMaskB64 || fogMaskB64.length === 0) {
    return images.filter((img) => !img.hidden);
  }

  const maskBytes = decodeFog(fogMaskB64);

  return images.filter((img) => {
    if (img.hidden) return false;

    const x0 = Math.max(0, Math.floor(img.x));
    const y0 = Math.max(0, Math.floor(img.y));
    const x1 = Math.min(grid.widthCells - 1, Math.floor(img.x + img.width - 0.001));
    const y1 = Math.min(grid.heightCells - 1, Math.floor(img.y + img.height - 0.001));

    if (x0 > x1 || y0 > y1) {
      // Outside grid
      return false;
    }

    let allFogged = true;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (!isFogged(maskBytes, grid, cx, cy)) {
          allFogged = false;
          break;
        }
      }
      if (!allFogged) break;
    }

    // Cull if completely shrouded by fog
    return !allFogged;
  });
}

/**
 * Calculates camera center coordinates and zoom level to frame a focus box or map bounds.
 */
export function resolveDisplayFraming(
  box: FramingBox,
  screenWidth: number,
  screenHeight: number,
  cellPixels = 50,
): FramingResult {
  const centerX = (box.x + box.width / 2) * cellPixels;
  const centerY = (box.y + box.height / 2) * cellPixels;

  const worldW = Math.max(box.width * cellPixels, 1);
  const worldH = Math.max(box.height * cellPixels, 1);

  // Exact fit or padding
  const fitZoom = Math.min(screenWidth / worldW, screenHeight / worldH);
  const clampedZoom = Math.max(0.01, Math.min(10.0, fitZoom));

  return {
    centerX,
    centerY,
    zoom: clampedZoom,
  };
}
