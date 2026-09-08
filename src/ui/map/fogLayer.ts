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

export class FogLayer {
  private tex: Phaser.Textures.CanvasTexture | null = null;
  private fogImage: Phaser.GameObjects.Image | null = null;
  private previewGfx: Phaser.GameObjects.Graphics;

  private cachedImageData: ImageData | null = null;
  private prevMask: FogMaskBytes | null = null;
  private currentRawMask: FogMaskB64 = "";

  private widthCells = 0;
  private heightCells = 0;
  private isDm = false;

  // Optimistic painting state
  public readonly strokeCells = new Set<number>();
  private isPainting = false;

  constructor(private readonly scene: Phaser.Scene) {
    this.previewGfx = this.scene.add.graphics();
    this.previewGfx.setDepth(DEPTH.FOG + 1);
  }

  setDm(isDm: boolean): void {
    this.isDm = isDm;
    if (this.fogImage) {
      this.fogImage.setAlpha(this.isDm ? 0.45 : 1.0);
    }
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
    this.fogImage.setAlpha(this.isDm ? 0.45 : 1.0);

    // Reapply mask if present
    if (this.currentRawMask) {
      this.updateMask(this.currentRawMask);
    }
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
  }

  // ── Optimistic Fog Brush Painting ──────────────────────────────────────────

  startStroke(): void {
    this.isPainting = true;
    this.strokeCells.clear();
    this.previewGfx.clear();
  }

  addBrushCells(centerCx: number, centerCy: number, radius: number): void {
    if (!this.isPainting || this.widthCells <= 0 || this.heightCells <= 0) return;

    // Brush radius 1 = 1x1 cell
    // Brush radius 2 = 3x3 square (9 cells)
    // Brush radius 3 = 5x5 rounded circle (21 cells)
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
        if (cx >= 0 && cx < this.widthCells && cy >= 0 && cy < this.heightCells) {
          this.strokeCells.add(cy * this.widthCells + cx);
        }
      }
    }
  }

  redrawPreview(fogged: boolean): void {
    this.previewGfx.clear();
    if (this.strokeCells.size === 0) return;

    // Paint: #000 @ 0.45; Erase: #e89055 @ 0.35
    const fillColor = fogged ? 0x000000 : 0xe89055;
    const fillAlpha = fogged ? 0.45 : 0.35;

    this.previewGfx.fillStyle(fillColor, fillAlpha);

    for (const cellIdx of this.strokeCells) {
      const cx = cellIdx % this.widthCells;
      const cy = Math.floor(cellIdx / this.widthCells);
      this.previewGfx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
    }
  }

  endStroke(): number[] {
    this.isPainting = false;
    const result = Array.from(this.strokeCells);
    this.strokeCells.clear();
    this.previewGfx.clear();
    return result;
  }

  cancelStroke(): void {
    this.isPainting = false;
    this.strokeCells.clear();
    this.previewGfx.clear();
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
    if (this.fogImage) this.fogImage.destroy();
    if (this.tex) this.tex.destroy();
  }
}
