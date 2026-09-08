/*
 * Primary interactive map scene in Phaser.
 *
 * Responsibilities in Phase 1:
 *  - Solid background fill at DEPTH.BACKGROUND
 *  - Crisp grid lines at DEPTH.GRID clamped strictly to map bounds
 *  - Cursor-anchored wheel zoom and unbounded pan
 *  - WebGL context loss recovery
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL, WHEEL_FACTOR, applyViewport, zoomAtAnchor } from "./viewport";

export class MapScene extends Phaser.Scene {
  private gridGfx!: Phaser.GameObjects.Graphics;
  private bgGfx!: Phaser.GameObjects.Graphics;

  // Initial map grid dimensions (default 30x20 per domain model)
  widthCells = 30;
  heightCells = 20;
  lineColor = 0x3a2d23;
  bgColor = 0x07060a;

  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private camStartX = 0;
  private camStartY = 0;

  constructor() {
    super("Map");
  }

  create(): void {
    const cam = this.cameras.main;

    // Pan is unbounded — NEVER call cam.setBounds() (DMs scroll past the edge for notes).
    // Initialize default viewport
    applyViewport(cam, 0, 0, 1.0, CELL);

    // Background solid fill
    this.bgGfx = this.add.graphics();
    this.bgGfx.setDepth(DEPTH.BACKGROUND);

    // Grid graphics (redrawn on camera transform)
    this.gridGfx = this.add.graphics();
    this.gridGfx.setDepth(DEPTH.GRID);

    this.drawBackground();
    this.redrawGrid();

    this.setupInput();

    // Redraw on window resize
    this.scale.on(Phaser.Scale.Events.RESIZE, () => {
      this.drawBackground();
      this.redrawGrid();
    });
  }

  private drawBackground(): void {
    this.bgGfx.clear();
    this.bgGfx.fillStyle(this.bgColor, 1);
    this.bgGfx.fillRect(0, 0, this.widthCells * CELL, this.heightCells * CELL);
  }

  /**
   * Redraw the grid clamped to BOTH camera view and map bounds.
   * Clamping to map bounds guarantees <= (widthCells + heightCells + 2) lineBetween calls,
   * avoiding huge loop spikes at minimum zoom (0.01).
   */
  redrawGrid(): void {
    if (!this.gridGfx) return;

    const cam = this.cameras.main;
    const view = cam.worldView;
    const g = this.gridGfx.clear().lineStyle(1 / cam.zoom, this.lineColor, 1);

    // Clamp to intersection of visible viewport and map bounds
    const x0 = Math.max(0, Math.floor(view.x / CELL));
    const x1 = Math.min(this.widthCells, Math.ceil(view.right / CELL));
    const y0 = Math.max(0, Math.floor(view.y / CELL));
    const y1 = Math.min(this.heightCells, Math.ceil(view.bottom / CELL));

    if (x1 < x0 || y1 < y0) return; // Map is entirely off-screen

    const left = x0 * CELL;
    const right = x1 * CELL;
    const top = y0 * CELL;
    const bottom = y1 * CELL;

    for (let cx = x0; cx <= x1; cx++) {
      g.lineBetween(cx * CELL, top, cx * CELL, bottom);
    }
    for (let cy = y0; cy <= y1; cy++) {
      g.lineBetween(left, cy * CELL, right, cy * CELL);
    }
  }

  private setupInput(): void {
    const cam = this.cameras.main;

    // Wheel zoom: holds the world point under the cursor steady
    this.input.on(
      Phaser.Input.Events.POINTER_WHEEL,
      (pointer: Phaser.Input.Pointer, _over: unknown[], _dx: number, dy: number) => {
        const factor = dy < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
        zoomAtAnchor(cam, factor, pointer.x, pointer.y);
        this.redrawGrid();
      },
    );

    // Unbounded pan via drag
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      // Left click or middle click
      if (pointer.leftButtonDown() || pointer.middleButtonDown()) {
        this.isDragging = true;
        this.dragStartX = pointer.x;
        this.dragStartY = pointer.y;
        this.camStartX = cam.scrollX;
        this.camStartY = cam.scrollY;
      }
    });

    this.input.on(Phaser.Input.Events.POINTER_MOVE, (pointer: Phaser.Input.Pointer) => {
      if (!this.isDragging) return;
      const dx = pointer.x - this.dragStartX;
      const dy = pointer.y - this.dragStartY;
      cam.scrollX = this.camStartX - dx / cam.zoom;
      cam.scrollY = this.camStartY - dy / cam.zoom;
      this.redrawGrid();
    });

    this.input.on(Phaser.Input.Events.POINTER_UP, () => {
      this.isDragging = false;
    });
  }

  /** Handle WebGL context recovery */
  onContextRestored(): void {
    this.drawBackground();
    this.redrawGrid();
  }
}
