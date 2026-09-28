/*
 * Focus rectangle overlay for the DM focus box tool in Phaser MapScene.
 * Renders at DEPTH.FOCUS_RULER (5000).
 *
 * While the focus tool is active the existing box is editable: drag inside it
 * to move, drag a corner handle to resize (image-style modifiers), or drag
 * anywhere else to draw a replacement. Handles are hit-tested geometrically
 * from the scene's pointer handlers rather than being interactive objects.
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import type { FocusRect, GridConfig } from "../../game/domain";
import { snapCorner, snapImageResize } from "../../game/snapping";
import {
  CORNER_BASE_DEG,
  CORNER_HANDLE_SIZE,
  CORNER_IDS,
  HANDLE_HIT_SIZE,
  HANDLE_HOVER_COLOR,
  HANDLE_HOVER_SCALE,
  HANDLE_STROKE_COLOR,
  HANDLE_STROKE_WIDTH,
  OUTLINE_WIDTH,
  RESIZE_HINT,
  SELECTION_COLOR,
  resizeCursorForAngle,
  type CornerId,
} from "./selectionChrome";

type Pt = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

export type FocusHit = CornerId | "body";

type FocusGesture =
  | { kind: "draw"; start: Pt; current: Pt }
  | { kind: "move"; origin: FocusRect; grab: Pt; current: Pt }
  | { kind: "resize"; origin: FocusRect; corner: CornerId; current: Pt };

const EPSILON = 1e-6;

function cornerPoint(r: Box, corner: CornerId): Pt {
  return {
    x: corner === "ne" || corner === "se" ? r.x + r.width : r.x,
    y: corner === "sw" || corner === "se" ? r.y + r.height : r.y,
  };
}

const OPPOSITE: Record<CornerId, CornerId> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };

export class FocusOverlay {
  private readonly authoritativeGfx: Phaser.GameObjects.Graphics;
  private readonly previewGfx: Phaser.GameObjects.Graphics;

  private currentFocus: FocusRect | null = null;
  private gesture: FocusGesture | null = null;
  // Modifiers from the latest gesture update, so camera redraws mid-gesture
  // keep the preview the user is seeing.
  private lastSnap = true;
  private lastFreeAspect = false;

  private editable = false;
  private activeMapId: string | null = null;
  private hovered: FocusHit | null = null;
  private grid: GridConfig = {
    widthCells: 30,
    heightCells: 20,
    cellPixels: CELL,
    showGridLines: true,
    snapToGrid: true,
    lineColor: "#222",
  };

  // True while this overlay has overridden the canvas cursor/title.
  private ownsCursor = false;
  private savedCanvasTitle = "";

  constructor(private readonly scene: Phaser.Scene) {
    this.authoritativeGfx = this.scene.add.graphics();
    this.authoritativeGfx.setDepth(DEPTH.FOCUS_RULER);

    this.previewGfx = this.scene.add.graphics();
    this.previewGfx.setDepth(DEPTH.FOCUS_RULER + 1);
  }

  setFocusRect(rect: FocusRect | null): void {
    this.currentFocus = rect;
    if (!this.canEdit()) this.setHovered(null);
    this.redrawAuthoritative();
  }

  setGrid(grid: GridConfig): void {
    this.grid = grid;
  }

  /** Show handles and allow move/resize of the box when it belongs to mapId. */
  setEditable(editable: boolean, mapId: string | null): void {
    this.editable = editable;
    this.activeMapId = mapId;
    if (!this.canEdit()) this.setHovered(null);
    this.redraw();
  }

  get isGesturing(): boolean {
    return this.gesture !== null;
  }

  private canEdit(): boolean {
    return (
      this.editable && this.currentFocus !== null && this.currentFocus.mapId === this.activeMapId
    );
  }

  /** Which part of the editable box is under a cell-space point, if any. */
  hitTest(cellX: number, cellY: number): FocusHit | null {
    if (!this.canEdit()) return null;
    const r = this.currentFocus!;

    // Corner hit squares match the image handles' on-screen hit size; on a
    // small box where they overlap, the nearest corner wins.
    const reach = HANDLE_HIT_SIZE / 2 / this.scene.cameras.main.zoom / CELL;
    let best: CornerId | null = null;
    let bestDist = Infinity;
    for (const id of CORNER_IDS) {
      const p = cornerPoint(r, id);
      const dx = Math.abs(cellX - p.x);
      const dy = Math.abs(cellY - p.y);
      if (dx <= reach && dy <= reach && Math.hypot(dx, dy) < bestDist) {
        best = id;
        bestDist = Math.hypot(dx, dy);
      }
    }
    if (best) return best;

    const inside =
      cellX >= r.x && cellX <= r.x + r.width && cellY >= r.y && cellY <= r.y + r.height;
    return inside ? "body" : null;
  }

  /** Start a move/resize when pressing on the box or a handle, else a new draw. */
  beginGesture(cellX: number, cellY: number): void {
    const pt = { x: cellX, y: cellY };
    const hit = this.hitTest(cellX, cellY);
    if (hit === "body") {
      this.gesture = { kind: "move", origin: this.currentFocus!, grab: pt, current: pt };
    } else if (hit) {
      this.gesture = { kind: "resize", origin: this.currentFocus!, corner: hit, current: pt };
    } else {
      this.gesture = { kind: "draw", start: pt, current: pt };
    }
    this.setHovered(hit);
    this.redraw();
  }

  updateGesture(cellX: number, cellY: number, snapToGrid = true, freeAspect = false): void {
    if (!this.gesture) return;
    this.gesture.current = { x: cellX, y: cellY };
    this.lastSnap = snapToGrid;
    this.lastFreeAspect = freeAspect;
    this.redraw();
  }

  /**
   * Finish the gesture and return the rect to commit, or null when there is
   * nothing to commit (degenerate draw, or a move/resize that changed nothing).
   */
  endGesture(mapId: string, snapToGrid = true, freeAspect = false): FocusRect | null {
    const gesture = this.gesture;
    if (!gesture) return null;
    this.lastSnap = snapToGrid;
    this.lastFreeAspect = freeAspect;
    const box = this.gestureRect(gesture, snapToGrid, freeAspect);
    this.gesture = null;
    this.previewGfx.clear();

    let rect: FocusRect | null = null;
    if (gesture.kind === "draw") {
      if (box.width > 0.1 && box.height > 0.1) rect = { mapId, ...box };
    } else if (!this.sameBox(box, gesture.origin)) {
      rect = { mapId: gesture.origin.mapId, ...box };
    }

    // Optimistic: show the committed box until the state echo replaces it,
    // so it doesn't flash back to the old geometry.
    if (rect) this.currentFocus = rect;
    this.redrawAuthoritative();
    this.syncCursor();
    return rect;
  }

  /** Abandon the gesture in flight; the stored box is left untouched. */
  cancelGesture(): void {
    this.gesture = null;
    this.previewGfx.clear();
    this.redrawAuthoritative();
    this.syncCursor();
  }

  /** Hover feedback (handle highlight + cursor) while no button is held. */
  updateHover(cellX: number, cellY: number): void {
    if (this.gesture) return;
    this.setHovered(this.hitTest(cellX, cellY));
  }

  clearHover(): void {
    if (this.gesture) return;
    this.setHovered(null);
  }

  private setHovered(hit: FocusHit | null): void {
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.redrawAuthoritative();
    }
    this.syncCursor();
  }

  private sameBox(a: Box, b: Box): boolean {
    return (
      Math.abs(a.x - b.x) < EPSILON &&
      Math.abs(a.y - b.y) < EPSILON &&
      Math.abs(a.width - b.width) < EPSILON &&
      Math.abs(a.height - b.height) < EPSILON
    );
  }

  private gestureRect(gesture: FocusGesture, snapToGrid: boolean, freeAspect: boolean): Box {
    switch (gesture.kind) {
      case "draw":
        return this.drawRect(gesture.start, gesture.current, snapToGrid);
      case "move": {
        const o = gesture.origin;
        const rawX = o.x + (gesture.current.x - gesture.grab.x);
        const rawY = o.y + (gesture.current.y - gesture.grab.y);
        const p = snapToGrid ? snapCorner(rawX, rawY, this.grid) : { x: rawX, y: rawY };
        return { x: p.x, y: p.y, width: o.width, height: o.height };
      }
      case "resize": {
        const o = gesture.origin;
        const anchor = cornerPoint(o, OPPOSITE[gesture.corner]);
        // Snapped boxes keep at least one whole cell.
        return snapImageResize(
          anchor.x,
          anchor.y,
          gesture.current.x,
          gesture.current.y,
          this.grid,
          !freeAspect,
          o.width / Math.max(0.001, o.height),
          snapToGrid ? 1 : 0.1,
          !snapToGrid,
        );
      }
    }
  }

  private drawRect(start: Pt, current: Pt, snapToGrid: boolean): Box {
    let x0 = Math.min(start.x, current.x);
    let x1 = Math.max(start.x, current.x);
    let y0 = Math.min(start.y, current.y);
    let y1 = Math.max(start.y, current.y);

    if (snapToGrid) {
      x0 = Math.floor(x0);
      x1 = Math.ceil(x1);
      y0 = Math.floor(y0);
      y1 = Math.ceil(y1);
    }

    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }

  redraw(): void {
    this.redrawAuthoritative();
    this.redrawPreview();
  }

  private redrawAuthoritative(): void {
    this.authoritativeGfx.clear();
    if (!this.currentFocus) return;
    // A move/resize preview replaces the stored box while it is in flight.
    const editing = this.gesture !== null && this.gesture.kind !== "draw";
    if (editing) return;

    this.drawBox(this.authoritativeGfx, this.currentFocus, 0.08, 0.85);
    if (this.canEdit() && this.gesture === null) {
      this.drawHandles(this.authoritativeGfx, this.currentFocus, this.hovered);
    }
  }

  private redrawPreview(): void {
    this.previewGfx.clear();
    const gesture = this.gesture;
    if (!gesture) return;
    const rect = this.gestureRect(gesture, this.lastSnap, this.lastFreeAspect);
    if (rect.width <= 0 || rect.height <= 0) return;

    this.drawBox(this.previewGfx, rect, 0.15, 1.0);
    if (gesture.kind !== "draw") {
      this.drawHandles(this.previewGfx, rect, gesture.kind === "resize" ? gesture.corner : null);
    }
  }

  private drawBox(
    g: Phaser.GameObjects.Graphics,
    r: Box,
    fillAlpha: number,
    strokeAlpha: number,
  ): void {
    const invZoom = 1 / this.scene.cameras.main.zoom;
    const wx = r.x * CELL;
    const wy = r.y * CELL;
    const ww = r.width * CELL;
    const wh = r.height * CELL;

    g.fillStyle(SELECTION_COLOR, fillAlpha);
    g.fillRect(wx, wy, ww, wh);

    g.lineStyle(2 * invZoom, SELECTION_COLOR, strokeAlpha);
    g.strokeRect(wx, wy, ww, wh);
  }

  /** Selection outline + corner squares, sized in screen pixels like image handles. */
  private drawHandles(g: Phaser.GameObjects.Graphics, r: Box, highlighted: FocusHit | null): void {
    const invZoom = 1 / this.scene.cameras.main.zoom;
    g.lineStyle(OUTLINE_WIDTH * invZoom, SELECTION_COLOR, 0.9);
    g.strokeRect(r.x * CELL, r.y * CELL, r.width * CELL, r.height * CELL);

    for (const id of CORNER_IDS) {
      const p = cornerPoint(r, id);
      const hot = id === highlighted;
      const size = CORNER_HANDLE_SIZE * (hot ? HANDLE_HOVER_SCALE : 1) * invZoom;
      const x = p.x * CELL - size / 2;
      const y = p.y * CELL - size / 2;
      g.fillStyle(hot ? HANDLE_HOVER_COLOR : SELECTION_COLOR, 1);
      g.fillRect(x, y, size, size);
      g.lineStyle(HANDLE_STROKE_WIDTH * invZoom, HANDLE_STROKE_COLOR, 1);
      g.strokeRect(x, y, size, size);
    }
  }

  private desiredCursor(): { cursor: string; title: string } | null {
    const gesture = this.gesture;
    if (gesture?.kind === "move") return { cursor: "move", title: "" };
    if (gesture?.kind === "resize") {
      return { cursor: resizeCursorForAngle(CORNER_BASE_DEG[gesture.corner]), title: "" };
    }
    if (gesture || !this.hovered) return null;
    if (this.hovered === "body") return { cursor: "move", title: "" };
    return { cursor: resizeCursorForAngle(CORNER_BASE_DEG[this.hovered]), title: RESIZE_HINT };
  }

  /** Same canvas cursor/tooltip ownership scheme as ImageLayer.syncCursor(). */
  private syncCursor(): void {
    const canvas = this.scene.game.canvas as HTMLCanvasElement | null | undefined;
    if (!canvas) return;
    const desired = this.desiredCursor();
    if (desired) {
      if (!this.ownsCursor) {
        this.savedCanvasTitle = canvas.title;
        this.ownsCursor = true;
      }
      canvas.style.cursor = desired.cursor;
      canvas.title = desired.title;
    } else if (this.ownsCursor) {
      this.ownsCursor = false;
      canvas.style.cursor = this.scene.input?.manager?.defaultCursor ?? "";
      canvas.title = this.savedCanvasTitle;
    }
  }

  destroy(): void {
    // Release the cursor without redrawing: the camera is gone during teardown.
    this.gesture = null;
    this.hovered = null;
    this.syncCursor();
    this.authoritativeGfx.destroy();
    this.previewGfx.destroy();
  }
}
