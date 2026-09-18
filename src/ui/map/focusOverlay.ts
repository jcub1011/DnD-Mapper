/*
 * Focus rectangle overlay for the DM focus box tool in Phaser MapScene.
 * Renders at DEPTH.FOCUS_RULER (5000).
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import type { FocusRect } from "../../game/domain";

export class FocusOverlay {
  private readonly authoritativeGfx: Phaser.GameObjects.Graphics;
  private readonly previewGfx: Phaser.GameObjects.Graphics;

  private currentFocus: FocusRect | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private dragCurrent: { x: number; y: number } | null = null;

  constructor(private readonly scene: Phaser.Scene) {
    this.authoritativeGfx = this.scene.add.graphics();
    this.authoritativeGfx.setDepth(DEPTH.FOCUS_RULER);

    this.previewGfx = this.scene.add.graphics();
    this.previewGfx.setDepth(DEPTH.FOCUS_RULER + 1);
  }

  setFocusRect(rect: FocusRect | null): void {
    this.currentFocus = rect;
    this.redrawAuthoritative();
  }

  startDrag(cellX: number, cellY: number): void {
    this.dragStart = { x: cellX, y: cellY };
    this.dragCurrent = { x: cellX, y: cellY };
    this.redrawPreview(true);
  }

  updateDrag(cellX: number, cellY: number, snapToGrid = true): void {
    if (!this.dragStart) return;
    this.dragCurrent = { x: cellX, y: cellY };
    this.redrawPreview(snapToGrid);
  }

  endDrag(mapId: string, snapToGrid = true): FocusRect | null {
    if (!this.dragStart || !this.dragCurrent) {
      this.cancelDrag();
      return null;
    }

    const rect = this.calculateRect(mapId, snapToGrid);
    this.cancelDrag();

    if (rect && rect.width > 0.1 && rect.height > 0.1) {
      return rect;
    }
    return null;
  }

  cancelDrag(): void {
    this.dragStart = null;
    this.dragCurrent = null;
    this.previewGfx.clear();
  }

  private calculateRect(
    mapId: string,
    snapToGrid: boolean,
  ): { mapId: string; x: number; y: number; width: number; height: number } | null {
    if (!this.dragStart || !this.dragCurrent) return null;

    let x0 = Math.min(this.dragStart.x, this.dragCurrent.x);
    let x1 = Math.max(this.dragStart.x, this.dragCurrent.x);
    let y0 = Math.min(this.dragStart.y, this.dragCurrent.y);
    let y1 = Math.max(this.dragStart.y, this.dragCurrent.y);

    if (snapToGrid) {
      x0 = Math.floor(x0);
      x1 = Math.ceil(x1);
      y0 = Math.floor(y0);
      y1 = Math.ceil(y1);
    }

    const width = Math.max(0, x1 - x0);
    const height = Math.max(0, y1 - y0);

    return { mapId, x: x0, y: y0, width, height };
  }

  redraw(): void {
    this.redrawAuthoritative();
    if (this.dragStart && this.dragCurrent) {
      this.redrawPreview(true);
    }
  }

  private redrawAuthoritative(): void {
    this.authoritativeGfx.clear();
    if (!this.currentFocus) return;

    const cam = this.scene.cameras.main;
    const invZoom = 1 / cam.zoom;
    const r = this.currentFocus;

    const wx = r.x * CELL;
    const wy = r.y * CELL;
    const ww = r.width * CELL;
    const wh = r.height * CELL;

    this.authoritativeGfx.fillStyle(0xe89055, 0.08);
    this.authoritativeGfx.fillRect(wx, wy, ww, wh);

    this.authoritativeGfx.lineStyle(2 * invZoom, 0xe89055, 0.85);
    this.authoritativeGfx.strokeRect(wx, wy, ww, wh);
  }

  private redrawPreview(snapToGrid: boolean): void {
    this.previewGfx.clear();
    const rect = this.calculateRect("preview", snapToGrid);
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    const cam = this.scene.cameras.main;
    const invZoom = 1 / cam.zoom;

    const wx = rect.x * CELL;
    const wy = rect.y * CELL;
    const ww = rect.width * CELL;
    const wh = rect.height * CELL;

    this.previewGfx.fillStyle(0xe89055, 0.15);
    this.previewGfx.fillRect(wx, wy, ww, wh);

    this.previewGfx.lineStyle(2 * invZoom, 0xe89055, 1.0);
    this.previewGfx.strokeRect(wx, wy, ww, wh);
  }

  destroy(): void {
    this.authoritativeGfx.destroy();
    this.previewGfx.destroy();
  }
}
