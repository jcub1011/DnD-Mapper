/*
 * Fog of war layer in Phaser MapScene.
 * Renders fog using a CanvasTexture at 1 texel per cell with NEAREST filtering at DEPTH.FOG (3000).
 * Supports XOR diffing of fog bitmasks and optimistic stroke previews for DM brush painting.
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import type { GridConfig } from "../../game/domain";
import { decodeFog, type FogMaskB64, type FogMaskBytes } from "../../game/fog";

/** DM-only fog perimeter color (matches owner halos / stack badges). */
export const FOG_BORDER_COLOR = 0xe89055;

/**
 * DM fog opacity. The DM sees fog translucently (players and the projector
 * see it fully opaque at 1.0); 0.65 keeps fogged regions clearly readable as
 * fogged while leaving the map beneath legible enough to run the game.
 */
export const DM_FOG_ALPHA = 0.65;

/**
 * Computes the brush footprint cell indices for a center cell and brush
 * radius, clamped to the grid. Shared by drag strokes and hover previews so
 * both show exactly the cells that will be painted.
 *   radius 1 = 1x1 cell
 *   radius 2 = 3x3 square (9 cells)
 *   radius 3 = 5x5 rounded circle (21 cells)
 */
export function brushFootprint(
  centerCx: number,
  centerCy: number,
  radius: number,
  widthCells: number,
  heightCells: number,
): number[] {
  const cells: number[] = [];
  const r = Math.max(0, radius - 1);

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (r === 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) > 1) continue;
      } else if (r === 2) {
        if (dx * dx + dy * dy > 5) continue;
      }
      const cx = centerCx + dx;
      const cy = centerCy + dy;
      if (cx >= 0 && cx < widthCells && cy >= 0 && cy < heightCells) {
        cells.push(cy * widthCells + cx);
      }
    }
  }
  return cells;
}

/** One unit-length border segment in cell units: from (x1,y1) to (x2,y2). */
export interface FogBorderEdge {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * Traces the perimeter of the fogged region: for every fogged cell, each of
 * its four edges whose neighbor is revealed or out of bounds becomes a
 * border segment. Pure (no Phaser) so it is unit-testable.
 */
export function computeFogPerimeter(
  mask: FogMaskBytes,
  widthCells: number,
  heightCells: number,
): FogBorderEdge[] {
  const edges: FogBorderEdge[] = [];
  if (widthCells <= 0 || heightCells <= 0 || !mask || mask.length === 0) return edges;

  const foggedAt = (cx: number, cy: number): boolean => {
    if (cx < 0 || cy < 0 || cx >= widthCells || cy >= heightCells) return false;
    const bit = cy * widthCells + cx;
    const byte = bit >> 3;
    if (byte >= mask.length) return false;
    return (mask[byte] & (1 << (bit & 7))) !== 0;
  };

  for (let cy = 0; cy < heightCells; cy++) {
    for (let cx = 0; cx < widthCells; cx++) {
      if (!foggedAt(cx, cy)) continue;
      // Top / bottom / left / right edges facing revealed-or-void neighbors.
      if (!foggedAt(cx, cy - 1)) edges.push({ x1: cx, y1: cy, x2: cx + 1, y2: cy });
      if (!foggedAt(cx, cy + 1))
        edges.push({ x1: cx, y1: cy + 1, x2: cx + 1, y2: cy + 1 });
      if (!foggedAt(cx - 1, cy)) edges.push({ x1: cx, y1: cy, x2: cx, y2: cy + 1 });
      if (!foggedAt(cx + 1, cy))
        edges.push({ x1: cx + 1, y1: cy, x2: cx + 1, y2: cy + 1 });
    }
  }
  return edges;
}

export class FogLayer {
  private tex: Phaser.Textures.CanvasTexture | null = null;
  private fogImage: Phaser.GameObjects.Image | null = null;
  private previewGfx: Phaser.GameObjects.Graphics;
  private hoverGfx: Phaser.GameObjects.Graphics;
  private borderGfx: Phaser.GameObjects.Graphics;

  private cachedImageData: ImageData | null = null;
  private prevMask: FogMaskBytes | null = null;
  private currentRawMask: FogMaskB64 = "";
  private decodedMask: FogMaskBytes = new Uint8Array(0);

  private widthCells = 0;
  private heightCells = 0;
  private isDm = false;
  private isPitchBlack = false;
  private fogToolActive = false;

  // Optimistic painting state
  public readonly strokeCells = new Set<number>();
  private isPainting = false;
  // Last brush center, for interpolating fast strokes (see addBrushCells).
  private lastBrushCell: { cx: number; cy: number } | null = null;

  constructor(private readonly scene: Phaser.Scene) {
    this.previewGfx = this.scene.add.graphics();
    this.previewGfx.setDepth(DEPTH.FOG + 1);
    this.hoverGfx = this.scene.add.graphics();
    this.hoverGfx.setDepth(DEPTH.FOG + 1);
    this.borderGfx = this.scene.add.graphics();
    this.borderGfx.setDepth(DEPTH.FOG + 2);
  }

  /** Effective fog image opacity for the current viewer. */
  private fogAlpha(): number {
    return this.isPitchBlack ? 1.0 : this.isDm ? DM_FOG_ALPHA : 1.0;
  }

  setPitchBlack(pitchBlack: boolean): void {
    this.isPitchBlack = pitchBlack;
    if (this.fogImage) {
      this.fogImage.setAlpha(this.fogAlpha());
    }
  }

  setDm(isDm: boolean): void {
    this.isDm = isDm;
    if (this.fogImage) {
      this.fogImage.setAlpha(this.fogAlpha());
    }
    this.redrawBorder();
  }

  /**
   * Whether a fog brush (paint or erase) is currently armed. The DM's orange
   * fog perimeter renders only while a fog brush is armed, and hides as soon
   * as the tool is deselected.
   */
  setFogToolActive(active: boolean): void {
    if (this.fogToolActive === active) return;
    this.fogToolActive = active;
    this.redrawBorder();
  }

  /**
   * Sets up or resizes the fog canvas texture for the current grid dimensions.
   */
  setupGrid(grid: GridConfig): void {
    const { widthCells, heightCells } = grid;
    if (this.widthCells === widthCells && this.heightCells === heightCells && this.tex) {
      return;
    }

    this.widthCells = widthCells;
    this.heightCells = heightCells;
    this.prevMask = null;

    // Clean up previous texture/image
    if (this.fogImage) {
      this.fogImage.destroy();
      this.fogImage = null;
    }
    if (this.tex) {
      this.tex.destroy();
      this.tex = null;
    }

    const texKey = `fog_texture_${Date.now()}`;
    this.tex = this.scene.textures.createCanvas(texKey, widthCells, heightCells);
    if (!this.tex) return;

    this.tex.setFilter(Phaser.Textures.FilterMode.NEAREST);

    const ctx = this.tex.getContext();
    try {
      this.cachedImageData = ctx ? ctx.createImageData(widthCells, heightCells) : null;
    } catch {
      this.cachedImageData = null;
    }
    if (
      !this.cachedImageData ||
      !this.cachedImageData.data ||
      this.cachedImageData.data.length !== widthCells * heightCells * 4
    ) {
      this.cachedImageData = {
        width: widthCells,
        height: heightCells,
        data: new Uint8ClampedArray(widthCells * heightCells * 4),
        colorSpace: "srgb",
      } as ImageData;
    }

    this.fogImage = this.scene.add.image(0, 0, texKey);
    this.fogImage.setOrigin(0, 0);
    this.fogImage.setDisplaySize(widthCells * CELL, heightCells * CELL);
    this.fogImage.setDepth(DEPTH.FOG);
    this.fogImage.setAlpha(this.fogAlpha());

    // Reapply mask — always, including the empty (all-revealed) mask, so a
    // resized grid never resurrects stale fog and "clear fog" stays cleared.
    this.updateMask(this.currentRawMask);
  }

  /**
   * Updates fog from a base64 mask using XOR diffing against previous mask bytes.
   */
  updateMask(maskB64: FogMaskB64): void {
    this.currentRawMask = maskB64;
    if (!this.tex || !this.cachedImageData || this.widthCells <= 0 || this.heightCells <= 0) {
      return;
    }

    const newMask = decodeFog(maskB64);
    this.decodedMask = newMask;
    const totalCells = this.widthCells * this.heightCells;
    const imgData = this.cachedImageData;
    const data = imgData.data;

    if (!this.prevMask || this.prevMask.length !== newMask.length) {
      // Full repaint
      for (let i = 0; i < totalCells; i++) {
        const byteIdx = i >> 3;
        const fogged = byteIdx < newMask.length && (newMask[byteIdx] & (1 << (i & 7))) !== 0;
        const offset = i * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        data[offset + 3] = fogged ? 255 : 0;
      }
    } else {
      // XOR diff update
      const len = Math.min(this.prevMask.length, newMask.length);
      for (let byteIdx = 0; byteIdx < len; byteIdx++) {
        const diff = this.prevMask[byteIdx] ^ newMask[byteIdx];
        if (diff === 0) continue;

        for (let b = 0; b < 8; b++) {
          if ((diff & (1 << b)) === 0) continue;
          const cellIdx = (byteIdx << 3) | b;
          if (cellIdx >= totalCells) break;

          const fogged = (newMask[byteIdx] & (1 << b)) !== 0;
          data[cellIdx * 4 + 3] = fogged ? 255 : 0;
        }
      }
    }

    // Save copy of current mask for next diff
    this.prevMask = new Uint8Array(newMask);

    const ctx = this.tex.getContext();
    if (ctx && typeof ctx.putImageData === "function") {
      ctx.putImageData(imgData, 0, 0);
    }
    try {
      this.tex.refresh();
    } catch {
      // Headless test runner without WebGL renderer
    }

    this.redrawBorder();
  }

  /**
   * Redraws the DM-only orange perimeter around the fogged region. Visible
   * only while a fog brush (paint or erase) is armed; hidden for players,
   * when the tool is deselected, and when no fog is painted.
   */
  private redrawBorder(): void {
    this.borderGfx.clear();
    if (!this.isDm || !this.fogToolActive) return;
    if (this.widthCells <= 0 || this.heightCells <= 0) return;

    const edges = computeFogPerimeter(this.decodedMask, this.widthCells, this.heightCells);
    if (edges.length === 0) return;

    this.borderGfx.lineStyle(3, FOG_BORDER_COLOR, 1.0);
    for (const e of edges) {
      this.borderGfx.lineBetween(e.x1 * CELL, e.y1 * CELL, e.x2 * CELL, e.y2 * CELL);
    }
  }

  // ── Optimistic Fog Brush Painting ──────────────────────────────────────────

  startStroke(): void {
    this.isPainting = true;
    this.strokeCells.clear();
    this.lastBrushCell = null;
    this.previewGfx.clear();
    this.clearHover();
  }

  /**
   * Accumulates the brush footprint into the stroke. Fast drags paint in
   * discrete per-frame jumps, so the segment from the previous brush center
   * to this one is interpolated cell-by-cell — otherwise fast strokes leave
   * gaps. Applies to both paint and erase (the stroke commits with one
   * `fogged` flag, so the accumulated set is mode-agnostic).
   */
  addBrushCells(centerCx: number, centerCy: number, radius: number): void {
    if (!this.isPainting || this.widthCells <= 0 || this.heightCells <= 0) return;

    const prev = this.lastBrushCell;
    if (prev !== null && (prev.cx !== centerCx || prev.cy !== centerCy)) {
      // Walk the longest axis so every cell the brush passed over is covered.
      const steps = Math.max(Math.abs(centerCx - prev.cx), Math.abs(centerCy - prev.cy));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const ix = Math.round(prev.cx + (centerCx - prev.cx) * t);
        const iy = Math.round(prev.cy + (centerCy - prev.cy) * t);
        this.addFootprint(ix, iy, radius);
      }
    }

    this.addFootprint(centerCx, centerCy, radius);
    this.lastBrushCell = { cx: centerCx, cy: centerCy };
  }

  private addFootprint(centerCx: number, centerCy: number, radius: number): void {
    for (const cell of brushFootprint(
      centerCx,
      centerCy,
      radius,
      this.widthCells,
      this.heightCells,
    )) {
      this.strokeCells.add(cell);
    }
  }

  /**
   * Hover preview: shows exactly the cells the brush would paint/erase at the
   * hovered cell, before the pointer goes down. Paint previews dark (what fog
   * will cover); erase previews orange (what will be revealed).
   */
  showHover(centerCx: number, centerCy: number, radius: number, fogged: boolean): void {
    this.hoverGfx.clear();
    if (this.isPainting || this.widthCells <= 0 || this.heightCells <= 0) return;

    const cells = brushFootprint(centerCx, centerCy, radius, this.widthCells, this.heightCells);
    if (cells.length === 0) return;

    // Paint: translucent dark; Erase: translucent orange outline-style fill.
    const fillColor = fogged ? 0x000000 : FOG_BORDER_COLOR;
    this.hoverGfx.fillStyle(fillColor, 0.3);
    this.hoverGfx.lineStyle(1.5, fogged ? 0xffffff : FOG_BORDER_COLOR, 0.9);

    for (const cellIdx of cells) {
      const cx = cellIdx % this.widthCells;
      const cy = Math.floor(cellIdx / this.widthCells);
      this.hoverGfx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
      this.hoverGfx.strokeRect(cx * CELL, cy * CELL, CELL, CELL);
    }
  }

  clearHover(): void {
    this.hoverGfx.clear();
  }

  redrawPreview(fogged: boolean): void {
    this.previewGfx.clear();
    if (this.strokeCells.size === 0) return;

    // Paint preview matches the DM fog opacity; Erase is an orange tint.
    const fillColor = fogged ? 0x000000 : 0xe89055;
    const fillAlpha = fogged ? DM_FOG_ALPHA : 0.35;

    this.previewGfx.fillStyle(fillColor, fillAlpha);

    for (const cellIdx of this.strokeCells) {
      const cx = cellIdx % this.widthCells;
      const cy = Math.floor(cellIdx / this.widthCells);
      this.previewGfx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
    }
  }

  endStroke(): number[] {
    this.isPainting = false;
    this.lastBrushCell = null;
    const result = Array.from(this.strokeCells);
    this.strokeCells.clear();
    this.previewGfx.clear();
    return result;
  }

  cancelStroke(): void {
    this.isPainting = false;
    this.lastBrushCell = null;
    this.strokeCells.clear();
    this.previewGfx.clear();
    this.clearHover();
  }

  /** Handle WebGL context recovery */
  onContextRestored(): void {
    if (this.widthCells > 0 && this.heightCells > 0) {
      const savedMask = this.currentRawMask;
      this.prevMask = null;
      this.setupGrid({
        widthCells: this.widthCells,
        heightCells: this.heightCells,
        cellPixels: CELL,
        showGridLines: true,
        snapToGrid: true,
        lineColor: "#222",
      });
      if (savedMask) {
        this.updateMask(savedMask);
      }
    }
  }

  destroy(): void {
    this.cancelStroke();
    this.previewGfx.destroy();
    this.hoverGfx.destroy();
    this.borderGfx.destroy();
    if (this.fogImage) this.fogImage.destroy();
    if (this.tex) this.tex.destroy();
  }
}
