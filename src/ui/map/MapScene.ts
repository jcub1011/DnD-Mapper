/*
 * Primary interactive map scene in Phaser.
 *
 * Implements 05 — Rendering:
 *  - Fixed depth bands (0..6000)
 *  - Bounded grid clamped strictly to map bounds
 *  - CanvasTexture fog of war with nearest filtering and XOR diff updates
 *  - Image layers with rank-normalized depths and center-anchored rotation
 *  - Token containers with owner halos, readable initials, and stack chip fan-out
 *  - Interactive transform handles (move, 4-corner resize, rotate)
 *  - Chebyshev/Euclidean measurement ruler with screen-constant scaling
 *  - Focus rect visualization and drag creation
 *  - Tool mode state machine with Space-to-pan override
 *  - Two-finger pan & pinch-zoom touch navigation
 *  - WebGL context loss recovery
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import {
  CELL,
  WHEEL_FACTOR,
  TOOLBAR_FACTOR,
  applyViewport,
  readViewport,
  zoomAtAnchor,
  type ViewportState,
} from "./viewport";
import type { GameMap, GridConfig, MapImage, Token, FocusRect } from "../../game/domain";
import type { FogMaskB64 } from "../../game/fog";
import type { AssetSource } from "../../assets/assetSource";
import { FogLayer } from "./fogLayer";
import { TokenLayer, type TokenDragEvent } from "./tokenLayer";
import { ImageLayer, type ImageTransformEvent } from "./imageLayer";
import { RulerOverlay } from "./rulerOverlay";
import { FocusOverlay } from "./focusOverlay";
import { TouchNavigation } from "./touchNavigation";

export type ToolMode = "none" | "markup" | "focus" | "fog" | "ruler";

export class MapScene extends Phaser.Scene {
  private bgGfx!: Phaser.GameObjects.Graphics;
  private gridGfx!: Phaser.GameObjects.Graphics;

  private imageLayer!: ImageLayer;
  private fogLayer!: FogLayer;
  private tokenLayer!: TokenLayer;
  private rulerOverlay!: RulerOverlay;
  private focusOverlay!: FocusOverlay;
  private touchNav!: TouchNavigation;

  // Active map and state
  public activeMap: GameMap | null = null;
  public widthCells = 30;
  public heightCells = 20;
  public lineColor = 0x3a2d23;
  public bgColor = 0x07060a;
  public showGridLines = true;
  public snapToGrid = true;
  public isDm = false;

  // Tool Modes & Modifiers
  private currentToolMode: ToolMode = "none";
  public fogBrushRadius = 1; // 1..3
  public fogBrushMode: "paint" | "erase" = "paint";
  private spaceHeld = false;

  // Pointer panning state
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private camStartX = 0;
  private camStartY = 0;
  private didMoveDuringPan = false;

  // Rail insets for rail-aware visible center zoom anchor
  public railLeft = 0;
  public railRight = 0;

  // Event callbacks
  public onTokenMoveEnd?: (event: TokenDragEvent) => void;
  public onTokenDoubleClick?: (tokenId: string) => void;
  public onImageTransformEnd?: (event: ImageTransformEvent) => void;
  public onImageSelect?: (imageId: string | null) => void;
  public onFogStrokeCommit?: (cells: number[], fogged: boolean) => void;
  public onFocusRectCommit?: (rect: FocusRect | null) => void;
  public onViewportChanged?: (vp: ViewportState) => void;

  constructor() {
    super("Map");
  }

  create(): void {
    const cam = this.cameras.main;

    // Pan is unbounded — NEVER call cam.setBounds()
    applyViewport(cam, 0, 0, 1.0, CELL);

    // 1. Background fill (DEPTH.BACKGROUND = 0)
    this.bgGfx = this.add.graphics();
    this.bgGfx.setDepth(DEPTH.BACKGROUND);

    // 2. Image layers (DEPTH.IMAGES = 1..999)
    this.imageLayer = new ImageLayer(this);
    this.imageLayer.onImageTransformEnd = (e) => this.onImageTransformEnd?.(e);
    this.imageLayer.onImageSelect = (id) => this.onImageSelect?.(id);

    // 3. Grid lines (DEPTH.GRID = 1000)
    this.gridGfx = this.add.graphics();
    this.gridGfx.setDepth(DEPTH.GRID);

    // 4. Fog layer (DEPTH.FOG = 3000)
    this.fogLayer = new FogLayer(this);

    // 5. Token layer (DEPTH.TOKENS = 4000)
    this.tokenLayer = new TokenLayer(this);
    this.tokenLayer.onTokenMoveEnd = (e) => this.onTokenMoveEnd?.(e);
    this.tokenLayer.onTokenDoubleClick = (id) => this.onTokenDoubleClick?.(id);

    // 6. Overlays (DEPTH.FOCUS_RULER = 5000)
    this.rulerOverlay = new RulerOverlay(this);
    this.focusOverlay = new FocusOverlay(this);

    // Multi-touch navigation
    this.touchNav = new TouchNavigation(this);

    this.drawBackground();
    this.redrawGrid();
    this.setupInput();

    // Redraw on window resize
    this.scale.on(Phaser.Scale.Events.RESIZE, () => {
      this.drawBackground();
      this.redrawGrid();
      this.rulerOverlay.redraw();
      this.focusOverlay.redraw();
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.cleanUp());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.cleanUp());
  }

  override update(): void {
    // Check multi-touch navigation first
    if (this.touchNav.update()) {
      this.redrawGrid();
      this.rulerOverlay.redraw();
      this.focusOverlay.redraw();
      this.onViewportChanged?.(readViewport(this.cameras.main, CELL));
    }
  }

  // ── Public Model & State Setters ───────────────────────────────────────────

  setMap(map: GameMap, isDm = this.isDm, assetSource?: AssetSource): void {
    this.activeMap = map;
    this.isDm = isDm;
    this.widthCells = map.grid.widthCells;
    this.heightCells = map.grid.heightCells;
    this.showGridLines = map.grid.showGridLines;
    this.snapToGrid = map.grid.snapToGrid;
    if (map.grid.lineColor) {
      this.lineColor = parseInt(map.grid.lineColor.replace("#", ""), 16) || 0x3a2d23;
    }

    this.drawBackground();
    this.redrawGrid();

    // Propagate grid
    this.imageLayer.setDm(this.isDm);
    this.imageLayer.setGrid(map.grid);
    if (assetSource) this.imageLayer.setAssetSource(assetSource);
    this.imageLayer.setImages(map.images);

    this.fogLayer.setDm(this.isDm);
    this.fogLayer.setupGrid(map.grid);
    if (map.fogMask) {
      this.fogLayer.updateMask(map.fogMask);
    }

    this.tokenLayer.setDm(this.isDm);
    this.tokenLayer.setGrid(map.grid);
    this.tokenLayer.setTokens(map.tokens);

    this.focusOverlay.setFocusRect(null);
    this.rulerOverlay.clear();
  }

  updateGrid(grid: GridConfig): void {
    this.widthCells = grid.widthCells;
    this.heightCells = grid.heightCells;
    this.showGridLines = grid.showGridLines;
    this.snapToGrid = grid.snapToGrid;
    if (grid.lineColor) {
      this.lineColor = parseInt(grid.lineColor.replace("#", ""), 16) || 0x3a2d23;
    }

    this.drawBackground();
    this.redrawGrid();
    this.imageLayer.setGrid(grid);
    this.fogLayer.setupGrid(grid);
    this.tokenLayer.setGrid(grid);
  }

  updateImages(images: readonly MapImage[]): void {
    this.imageLayer.setImages(images);
  }

  updateTokens(tokens: readonly Token[]): void {
    this.tokenLayer.setTokens(tokens);
  }

  updateFog(mask: FogMaskB64): void {
    this.fogLayer.updateMask(mask);
  }

  setFocusRect(rect: FocusRect | null): void {
    this.focusOverlay.setFocusRect(rect);
  }

  setDm(isDm: boolean): void {
    this.isDm = isDm;
    this.imageLayer.setDm(isDm);
    this.fogLayer.setDm(isDm);
    this.tokenLayer.setDm(isDm);
  }

  setAssetSource(source: AssetSource): void {
    this.imageLayer.setAssetSource(source);
  }

  setRailInsets(leftPx: number, rightPx: number): void {
    this.railLeft = leftPx;
    this.railRight = rightPx;
  }

  selectImage(imageId: string | null): void {
    this.imageLayer.selectImage(imageId);
  }

  getSelectedImageId(): string | null {
    return this.imageLayer.getSelectedImageId();
  }

  // ── Tool Mode State Machine ────────────────────────────────────────────────

  setToolMode(mode: ToolMode): void {
    if (this.currentToolMode === mode) return;
    this.currentToolMode = mode;

    // Reset temporary states
    this.rulerOverlay.clear();
    this.focusOverlay.cancelDrag();
    this.fogLayer.cancelStroke();

    this.applyInteractiveState();
  }

  get effectiveMode(): ToolMode {
    if (this.spaceHeld) return "none"; // Space always yields to panning
    return this.currentToolMode;
  }

  private applyInteractiveState(): void {
    const isNone = this.effectiveMode === "none";
    this.imageLayer.setInteractiveState(isNone);
    this.tokenLayer.setInteractiveState(isNone);
  }

  // ── Camera Navigation ──────────────────────────────────────────────────────

  centerOn(cellX: number, cellY: number): void {
    const cam = this.cameras.main;
    cam.centerOn(cellX * CELL, cellY * CELL);
    this.redrawGrid();
    this.rulerOverlay.redraw();
    this.focusOverlay.redraw();
    this.onViewportChanged?.(readViewport(cam, CELL));
  }

  zoomIn(factor = TOOLBAR_FACTOR): void {
    const cam = this.cameras.main;
    const anchorX = (cam.width + this.railLeft - this.railRight) / 2;
    const anchorY = cam.height / 2;
    zoomAtAnchor(cam, factor, anchorX, anchorY);
    this.redrawGrid();
    this.rulerOverlay.redraw();
    this.focusOverlay.redraw();
    this.onViewportChanged?.(readViewport(cam, CELL));
  }

  zoomOut(factor = TOOLBAR_FACTOR): void {
    const cam = this.cameras.main;
    const anchorX = (cam.width + this.railLeft - this.railRight) / 2;
    const anchorY = cam.height / 2;
    zoomAtAnchor(cam, 1 / factor, anchorX, anchorY);
    this.redrawGrid();
    this.rulerOverlay.redraw();
    this.focusOverlay.redraw();
    this.onViewportChanged?.(readViewport(cam, CELL));
  }

  resetView(): void {
    const cam = this.cameras.main;
    applyViewport(cam, 0, 0, 1.0, CELL);
    this.redrawGrid();
    this.rulerOverlay.redraw();
    this.focusOverlay.redraw();
    this.onViewportChanged?.(readViewport(cam, CELL));
  }

  // ── Grid & Background Rendering ────────────────────────────────────────────

  private drawBackground(): void {
    this.bgGfx.clear();
    this.bgGfx.fillStyle(this.bgColor, 1);
    this.bgGfx.fillRect(0, 0, this.widthCells * CELL, this.heightCells * CELL);
  }

  redrawGrid(): void {
    if (!this.gridGfx) return;

    const cam = this.cameras.main;
    const g = this.gridGfx.clear();

    if (!this.showGridLines) return;

    const view = cam.worldView;
    g.lineStyle(1 / cam.zoom, this.lineColor, 1);

    // Strictly clamped to map bounds
    const x0 = Math.max(0, Math.floor(view.x / CELL));
    const x1 = Math.min(this.widthCells, Math.ceil(view.right / CELL));
    const y0 = Math.max(0, Math.floor(view.y / CELL));
    const y1 = Math.min(this.heightCells, Math.ceil(view.bottom / CELL));

    if (x1 < x0 || y1 < y0) return;

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

  // ── Input & Gestures ───────────────────────────────────────────────────────

  private setupInput(): void {
    const cam = this.cameras.main;

    // 1. Keyboard Space listener for Space-to-pan
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.code === "Space" && !this.spaceHeld) {
        this.spaceHeld = true;
        this.applyInteractiveState();
      }
    });

    window.addEventListener("keyup", (e: KeyboardEvent) => {
      if (e.code === "Space") {
        this.spaceHeld = false;
        this.applyInteractiveState();
      }
    });

    // 2. Cursor-anchored wheel zoom
    this.input.on(
      Phaser.Input.Events.POINTER_WHEEL,
      (pointer: Phaser.Input.Pointer, _over: unknown[], _dx: number, dy: number) => {
        const factor = dy < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
        zoomAtAnchor(cam, factor, pointer.x, pointer.y);
        this.redrawGrid();
        this.rulerOverlay.redraw();
        this.focusOverlay.redraw();
        this.onViewportChanged?.(readViewport(cam, CELL));
      },
    );

    // 3. Pointer Down
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      if (this.touchNav.isGesturing) return;

      const isMiddle = pointer.middleButtonDown();
      const isLeft = pointer.leftButtonDown();
      const isRight = pointer.rightButtonDown();
      const mode = this.effectiveMode;

      // Right-click handling: clears ruler in ruler mode
      if (isRight) {
        if (mode === "ruler") {
          this.rulerOverlay.clear();
        }
        return;
      }

      // Middle-click ALWAYS pans from anywhere
      if (isMiddle || (isLeft && mode === "none")) {
        this.isPanning = true;
        this.didMoveDuringPan = false;
        this.panStartX = pointer.x;
        this.panStartY = pointer.y;
        this.camStartX = cam.scrollX;
        this.camStartY = cam.scrollY;
        return;
      }

      const cellX = pointer.worldX / CELL;
      const cellY = pointer.worldY / CELL;

      // Tool modes handling
      if (isLeft) {
        if (mode === "fog") {
          this.fogLayer.startStroke();
          this.fogLayer.addBrushCells(Math.floor(cellX), Math.floor(cellY), this.fogBrushRadius);
          this.fogLayer.redrawPreview(this.fogBrushMode === "paint");
        } else if (mode === "focus") {
          const ctrl = pointer.event ? (pointer.event as MouseEvent).ctrlKey : false;
          this.focusOverlay.startDrag(cellX, cellY);
          this.focusOverlay.updateDrag(cellX, cellY, !ctrl && this.snapToGrid);
        } else if (mode === "ruler") {
          if (!this.rulerOverlay.pointA) {
            this.rulerOverlay.setPointA(cellX, cellY);
          } else if (!this.rulerOverlay.pointB) {
            this.rulerOverlay.setPointB(cellX, cellY);
          } else {
            this.rulerOverlay.setPointB(cellX, cellY);
          }
        }
      }
    });

    // 4. Pointer Move
    this.input.on(Phaser.Input.Events.POINTER_MOVE, (pointer: Phaser.Input.Pointer) => {
      if (this.touchNav.isGesturing) return;

      if (this.isPanning) {
        const dx = pointer.x - this.panStartX;
        const dy = pointer.y - this.panStartY;
        if (Math.hypot(dx, dy) > 3) {
          this.didMoveDuringPan = true;
        }
        cam.scrollX = this.camStartX - dx / cam.zoom;
        cam.scrollY = this.camStartY - dy / cam.zoom;
        this.redrawGrid();
        this.rulerOverlay.redraw();
        this.focusOverlay.redraw();
        this.onViewportChanged?.(readViewport(cam, CELL));
        return;
      }

      const cellX = pointer.worldX / CELL;
      const cellY = pointer.worldY / CELL;
      const mode = this.effectiveMode;

      if (mode === "fog" && pointer.isDown) {
        this.fogLayer.addBrushCells(Math.floor(cellX), Math.floor(cellY), this.fogBrushRadius);
        this.fogLayer.redrawPreview(this.fogBrushMode === "paint");
      } else if (mode === "focus" && pointer.isDown) {
        const ctrl = pointer.event ? (pointer.event as MouseEvent).ctrlKey : false;
        this.focusOverlay.updateDrag(cellX, cellY, !ctrl && this.snapToGrid);
      } else if (mode === "ruler" && this.rulerOverlay.pointA && !this.rulerOverlay.pointB) {
        this.rulerOverlay.setPreviewPoint(cellX, cellY);
      }
    });

    // 5. Pointer Up
    this.input.on(Phaser.Input.Events.POINTER_UP, (pointer: Phaser.Input.Pointer) => {
      if (this.isPanning) {
        this.isPanning = false;
        if (!this.didMoveDuringPan && this.effectiveMode === "none") {
          // Click dead zone (<= 3px): click on empty background deselects image
          this.imageLayer.selectImage(null);
        }
        return;
      }

      const mode = this.effectiveMode;

      if (mode === "fog") {
        const stroke = this.fogLayer.endStroke();
        if (stroke.length > 0) {
          this.onFogStrokeCommit?.(stroke, this.fogBrushMode === "paint");
        }
      } else if (mode === "focus") {
        const ctrl = pointer.event ? (pointer.event as MouseEvent).ctrlKey : false;
        const mapId = this.activeMap?.id ?? "active";
        const rect = this.focusOverlay.endDrag(mapId, !ctrl && this.snapToGrid);
        if (rect) {
          this.onFocusRectCommit?.(rect);
        }
      }
    });
  }

  // ── WebGL Context Restoration ──────────────────────────────────────────────

  onContextRestored(): void {
    this.drawBackground();
    this.redrawGrid();
    this.fogLayer.onContextRestored();
    if (this.activeMap) {
      this.imageLayer.setImages(this.activeMap.images);
      this.imageLayer.onContextRestored();
      this.tokenLayer.setTokens(this.activeMap.tokens);
    }
    this.rulerOverlay.redraw();
    this.focusOverlay.redraw();
  }

  cleanUp(): void {
    this.imageLayer?.destroy();
    this.fogLayer?.destroy();
    this.tokenLayer?.destroy();
    this.rulerOverlay?.destroy();
    this.focusOverlay?.destroy();
  }
}
