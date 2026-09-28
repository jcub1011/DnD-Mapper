/*
 * Image layers management in Phaser MapScene.
 * Responsibilities:
 *  - Rank-normalized depth assignment (DEPTH.IMAGES + rank)
 *  - Center-anchored rotation parity matching legacy Canvas2D
 *  - Placeholder dashed textures for missing/loading assets
 *  - Interactive selection outline, 4-corner resize handles, and rotation stem
 *  - Handle hover feedback: highlight, gesture cursor, and modifier-key tooltip
 *  - Snapping with Ctrl (bypass) and Shift (free aspect ratio) modifiers
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import type { GridConfig, MapImage } from "../../game/domain";
import { MIN_IMAGE_DIMENSION, sortImagesByLayer } from "../../game/domain";
import { snapCorner, snapImageResize, snapRotation } from "../../game/snapping";
import type { AssetSource } from "../../assets/assetSource";

export interface ImageTransformEvent {
  imageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

const inFlight = new Map<string, Promise<boolean>>();

// Selection chrome, sized in screen pixels (world sizes are divided by zoom).
const SELECTION_COLOR = 0xe89055;
const HANDLE_HOVER_COLOR = 0xffc49c;
const HANDLE_STROKE_COLOR = 0x07060a;
const HANDLE_STROKE_WIDTH = 2;
const HANDLE_HOVER_SCALE = 1.25;
const HANDLE_HIT_SIZE = 28;
const CORNER_HANDLE_SIZE = 12;
const ROTATE_HANDLE_RADIUS = 8;
const OUTLINE_WIDTH = 3;
const STEM_WIDTH = 2;
const STEM_LENGTH = 32;

const ROTATE_HANDLE_ID = "rot";
const CORNER_IDS = ["nw", "ne", "se", "sw"] as const;
// Outward direction of each corner on an unrotated image, in degrees
// clockwise from +x (screen y points down, so 45° is down-right).
const CORNER_BASE_DEG: Record<string, number> = { se: 45, sw: 135, nw: 225, ne: 315 };

const RESIZE_HINT = "Drag to resize · Shift: free aspect ratio · Ctrl: ignore grid snap";
const ROTATE_HINT = "Drag to rotate · Ctrl: free rotation (no 5° snap)";

// Clockwise-arrow cursor (Lucide "rotate-cw", ISC) with a white halo for
// contrast on dark maps; falls back to `grab` where SVG cursors are unsupported.
const ROTATE_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='-1 -1 26 26' " +
  "fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
  "<g stroke='white' stroke-width='5'><path d='M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'/><path d='M21 3v5h-5'/></g>" +
  "<g stroke='black' stroke-width='2'><path d='M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8'/><path d='M21 3v5h-5'/></g>" +
  "</svg>";
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ROTATE_CURSOR_SVG)}") 12 12, grab`;

const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

/** CSS resize cursor closest to an outward handle direction (degrees clockwise from +x). */
export function resizeCursorForAngle(deg: number): string {
  const axis = ((deg % 180) + 180) % 180;
  return RESIZE_CURSORS[Math.round(axis / 45) % 4];
}

/**
 * Ensures texture is loaded into Phaser for the given map image.
 *
 * Implements 08 — Asset Pipeline Wiring into Phaser:
 *  - One in-flight load per image id, and exactly one listener pair per attempt.
 *  - loaderror scoped strictly to file.key === image.id to prevent cross-image rejection.
 *  - Unregistered listeners cleaned up in done().
 *  - Revokes blob: URLs once texture is uploaded to avoid pinning browser memory.
 */
export function ensureTexture(
  scene: Phaser.Scene,
  image: MapImage,
  assets?: AssetSource,
): Promise<boolean> {
  if (scene.textures.exists(image.id)) return Promise.resolve(true);
  if (!assets) return Promise.resolve(false);

  const existing = inFlight.get(image.id);
  if (existing) return existing;

  const task = (async () => {
    const url = await assets.resolve(image.id);
    if (url === null) return false; // -> dashed placeholder

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        scene.load.off(`filecomplete-image-${image.id}`, onDone);
        scene.load.off("loaderror", onError);
        if (url.startsWith("blob:")) {
          URL.revokeObjectURL(url);
        }
        resolve(ok);
      };
      const onDone = () => done(true);
      const onError = (file: { key: string }) => {
        if (file.key === image.id) done(false); // scoped, not global
      };

      scene.load.on(`filecomplete-image-${image.id}`, onDone);
      scene.load.on("loaderror", onError);
      scene.load.image(image.id, url);
      if (!scene.load.isLoading()) scene.load.start(); // required outside preload()
    });
  })().finally(() => inFlight.delete(image.id));

  inFlight.set(image.id, task);
  return task;
}

export class ImageLayer {
  private readonly sprites = new Map<string, Phaser.GameObjects.Image>();
  private readonly selectionGfx: Phaser.GameObjects.Graphics;
  private readonly handleContainers = new Map<string, Phaser.GameObjects.Container>();

  private images: readonly MapImage[] = [];
  private grid: GridConfig = {
    widthCells: 30,
    heightCells: 20,
    cellPixels: CELL,
    showGridLines: true,
    snapToGrid: true,
    lineColor: "#222",
  };
  private isDm = false;
  private assetSource?: AssetSource;
  private selectedImageId: string | null = null;
  private activeDragHandle: string | null = null;
  private activeSpriteDragId: string | null = null;
  private hoveredHandle: string | null = null;
  private hoveredSpriteId: string | null = null;
  // True while this layer has overridden the canvas cursor/title for a handle.
  private ownsCursor = false;
  private savedCanvasTitle = "";
  // Sticky tool lock: while a map tool is selected, images stay
  // non-interactive across rebuilds (setImages on every state sync).
  private interactionsEnabled = true;

  public onImageTransformEnd?: (event: ImageTransformEvent) => void;
  public onImageSelect?: (imageId: string | null) => void;

  constructor(private readonly scene: Phaser.Scene) {
    this.selectionGfx = this.scene.add.graphics();
    this.selectionGfx.setDepth(DEPTH.SELECTION);
  }

  setDm(isDm: boolean): void {
    this.isDm = isDm;
    this.updateVisibility();
  }

  setGrid(grid: GridConfig): void {
    this.grid = grid;
  }

  setAssetSource(source?: AssetSource): void {
    this.assetSource = source;
    // Reload textures for images that may now resolve
    for (const img of this.images) {
      void this.resolveImageTexture(img);
    }
  }

  setImages(images: readonly MapImage[]): void {
    this.images = images;
    this.rebuildImages();
  }

  selectImage(imageId: string | null): void {
    if (this.selectedImageId === imageId) return;
    // While a tool is selected, block new selections (deselect always allowed).
    if (imageId !== null && !this.interactionsEnabled) return;
    this.selectedImageId = imageId;
    if (imageId === null) {
      // External deselect (empty click, tool switch) must not leave a stale
      // in-drag flag that would turn the next full redraw into a reposition.
      this.activeDragHandle = null;
      this.activeSpriteDragId = null;
    }
    this.redrawSelectionHandles();
    this.onImageSelect?.(imageId);
  }

  getSelectedImageId(): string | null {
    return this.selectedImageId;
  }

  private rebuildImages(): void {
    // 1. Clean up removed sprites and textures
    const activeIds = new Set(this.images.map((img) => img.id));
    for (const [id, sprite] of this.sprites.entries()) {
      if (!activeIds.has(id)) {
        sprite.destroy();
        this.sprites.delete(id);
        if (this.scene.textures.exists(id)) {
          this.scene.textures.remove(id);
        }
      }
    }

    // Re-registering interactivity below clears Phaser's over-tracking, so a
    // later POINTER_OUT would never fire for the current hover; forget it and
    // let the next pointer move re-emit POINTER_OVER.
    this.hoveredSpriteId = null;

    // 2. Sort by layerOrder to establish rank (DEPTH.IMAGES + rank)
    const sorted = sortImagesByLayer(this.images);

    sorted.forEach((img, rank) => {
      let sprite = this.sprites.get(img.id);
      const isNew = !sprite;

      if (isNew) {
        // Create initial sprite with placeholder
        const placeholderKey = this.ensurePlaceholderTexture(img);
        sprite = this.scene.add.image(0, 0, placeholderKey);
        this.sprites.set(img.id, sprite);

        // Resolve real texture asynchronously
        void this.resolveImageTexture(img);
      }

      // Parity geometry: set origin to center (0.5, 0.5) and position at center.
      // Skip the geometry reset for the sprite/handle currently being dragged
      // so an incoming state sync mid-gesture doesn't snap the preview back.
      const isLiveDrag =
        this.activeSpriteDragId === img.id ||
        (this.activeDragHandle !== null && this.selectedImageId === img.id);
      sprite!.setOrigin(0.5, 0.5);
      if (!isLiveDrag) {
        const centerX = (img.x + img.width / 2) * CELL;
        const centerY = (img.y + img.height / 2) * CELL;
        sprite!.setPosition(centerX, centerY);
        sprite!.setDisplaySize(img.width * CELL, img.height * CELL);
        sprite!.setAngle(img.rotation);
      }
      sprite!.setAlpha(img.opacity);
      // Allocate depth 1..999 by rank, avoiding arbitrary layerOrder collisions
      sprite!.setDepth(DEPTH.IMAGES + Math.min(rank, 998));

      // Setup interaction (drop stale listeners first: setImages() runs on
      // every state sync, otherwise DRAG_END handlers accumulate with stale
      // closures that fight over sprite position — same bug class as tokens).
      // A selected tool locks all images: stay non-interactive across rebuilds.
      if (this.interactionsEnabled && !img.locked) {
        sprite!.removeAllListeners();
        sprite!.disableInteractive();
        sprite!.setInteractive();
        this.setupSpriteDrag(sprite!, img);
      } else {
        sprite!.removeAllListeners();
        sprite!.disableInteractive();
      }
    });

    this.updateVisibility();
    this.redrawSelectionHandles();
  }

  private updateVisibility(): void {
    for (const img of this.images) {
      const sprite = this.sprites.get(img.id);
      if (!sprite) continue;

      if (img.hidden) {
        if (this.isDm) {
          sprite.setVisible(true);
          sprite.setAlpha(img.opacity * 0.5);
        } else {
          sprite.setVisible(false);
        }
      } else {
        sprite.setVisible(true);
        sprite.setAlpha(img.opacity);
      }
    }
  }

  private ensurePlaceholderTexture(img: MapImage): string {
    const key = `placeholder_${img.id}`;
    if (this.scene.textures.exists(key)) return key;

    // Create dashed placeholder: fill rgba(80,75,68,0.5), dashed stroke rgba(196,116,56,0.6)
    const w = 128;
    const h = 128;
    const canvasTex = this.scene.textures.createCanvas(key, w, h);
    if (!canvasTex) return "__DEFAULT";

    const ctx = canvasTex.getContext();
    if (ctx) {
      ctx.fillStyle = "rgba(80, 75, 68, 0.5)";
      if (typeof ctx.fillRect === "function") ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = "rgba(196, 116, 56, 0.6)";
      ctx.lineWidth = 4;
      if (typeof ctx.setLineDash === "function") {
        ctx.setLineDash([8, 6]);
      }
      if (typeof ctx.strokeRect === "function") ctx.strokeRect(2, 2, w - 4, h - 4);

      ctx.fillStyle = "#ece0cc";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (typeof ctx.fillText === "function") {
        ctx.fillText(img.name || `Image #${img.layerOrder}`, w / 2, h / 2);
      }
    }

    try {
      canvasTex.refresh();
    } catch {
      // Headless test runner without WebGL renderer
    }
    return key;
  }

  private async resolveImageTexture(img: MapImage): Promise<void> {
    try {
      const ok = await ensureTexture(this.scene, img, this.assetSource);
      if (ok) {
        const sprite = this.sprites.get(img.id);
        if (sprite) {
          sprite.setTexture(img.id);
          sprite.setDisplaySize(img.width * CELL, img.height * CELL);
        }
      }
    } catch {
      // Fallback stays placeholder
    }
  }

  public onContextRestored(): void {
    for (const img of this.images) {
      void this.resolveImageTexture(img);
    }
  }

  // ── Sprite Dragging & Selection ────────────────────────────────────────────

  private setupSpriteDrag(sprite: Phaser.GameObjects.Image, img: MapImage): void {
    let didDrag = false;
    let startPointerX = 0;
    let startPointerY = 0;

    sprite.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown() || pointer.middleButtonDown()) return;
      didDrag = false;
      startPointerX = pointer.worldX;
      startPointerY = pointer.worldY;
    });

    sprite.on(Phaser.Input.Events.POINTER_UP, (pointer: Phaser.Input.Pointer) => {
      if (!this.interactionsEnabled) return;
      if (
        !didDrag &&
        Math.hypot(pointer.worldX - startPointerX, pointer.worldY - startPointerY) <= 3
      ) {
        // Click to select
        this.selectImage(img.id);
      }
    });

    // Move cursor while over the selected image (see desiredCursor()).
    sprite.on(Phaser.Input.Events.POINTER_OVER, () => {
      this.hoveredSpriteId = img.id;
      this.syncCursor();
    });
    sprite.on(Phaser.Input.Events.POINTER_OUT, () => {
      if (this.hoveredSpriteId !== img.id) return;
      this.hoveredSpriteId = null;
      this.syncCursor();
    });

    // Make scene listen to pointer move when selected image is dragging
    this.scene.input.setDraggable(sprite);

    sprite.on(Phaser.Input.Events.DRAG_START, (_pointer: Phaser.Input.Pointer) => {
      if (!this.interactionsEnabled) return;
      didDrag = false;
      this.activeSpriteDragId = img.id;
      this.selectImage(img.id);
      // Mid-drag selection only repositions the handles; update the cursor here.
      this.syncCursor();
    });

    sprite.on(
      Phaser.Input.Events.DRAG,
      (pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
        if (!this.interactionsEnabled) return;
        if (Math.hypot(pointer.worldX - startPointerX, pointer.worldY - startPointerY) > 3) {
          didDrag = true;
        }

        // dragX/dragY are center coordinates
        sprite.setPosition(dragX, dragY);
        this.repositionHandles();
      },
    );

    sprite.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
      this.activeSpriteDragId = null;
      this.syncCursor();
      if (!this.interactionsEnabled) {
        sprite.setPosition((img.x + img.width / 2) * CELL, (img.y + img.height / 2) * CELL);
        this.redrawSelectionHandles();
        return;
      }
      if (!didDrag) {
        sprite.setPosition((img.x + img.width / 2) * CELL, (img.y + img.height / 2) * CELL);
        this.redrawSelectionHandles();
        return;
      }

      // Convert center back to top-left corner
      const currentCenterX = sprite.x / CELL;
      const currentCenterY = sprite.y / CELL;
      const rawX = currentCenterX - img.width / 2;
      const rawY = currentCenterY - img.height / 2;

      const ctrlHeld = pointer.event ? (pointer.event as MouseEvent).ctrlKey : false;
      const snapped =
        ctrlHeld || !this.grid.snapToGrid
          ? { x: rawX, y: rawY }
          : snapCorner(rawX, rawY, this.grid);

      sprite.setPosition((snapped.x + img.width / 2) * CELL, (snapped.y + img.height / 2) * CELL);
      this.redrawSelectionHandles();

      this.onImageTransformEnd?.({
        imageId: img.id,
        x: snapped.x,
        y: snapped.y,
        width: img.width,
        height: img.height,
        rotation: img.rotation,
      });
    });
  }

  // ── Transform Handles & Gizmos ─────────────────────────────────────────────

  /** True when the object is an image sprite or a selection handle of this layer. */
  isImageObject(obj: unknown): boolean {
    if (!(obj instanceof Phaser.GameObjects.Container)) {
      for (const sprite of this.sprites.values()) {
        if (sprite === obj) return true;
      }
      return false;
    }
    for (const handle of this.handleContainers.values()) {
      if (handle === obj) return true;
    }
    return false;
  }

  private liveGeometry(): {
    img: MapImage;
    sprite: Phaser.GameObjects.Image;
    cx: number;
    cy: number;
    halfW: number;
    halfH: number;
    rad: number;
    cos: number;
    sin: number;
  } | null {
    if (!this.selectedImageId) return null;
    const img = this.images.find((i) => i.id === this.selectedImageId);
    const sprite = this.sprites.get(this.selectedImageId);
    if (!img || !sprite) return null;
    // Use live sprite state so previews during an active drag don't snap back
    // to the stale committed model.
    const liveW = sprite.displayWidth / CELL;
    const liveH = sprite.displayHeight / CELL;
    const w = liveW > 0 ? liveW : img.width;
    const h = liveH > 0 ? liveH : img.height;
    const rotation =
      this.activeDragHandle !== null || this.activeSpriteDragId !== null
        ? sprite.angle
        : img.rotation;
    const rad = Phaser.Math.DegToRad(rotation);
    return {
      img,
      sprite,
      cx: sprite.x,
      cy: sprite.y,
      halfW: (w * CELL) / 2,
      halfH: (h * CELL) / 2,
      rad,
      cos: Math.cos(rad),
      sin: Math.sin(rad),
    };
  }

  private cornerWorldPositions(
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    cos: number,
    sin: number,
  ): { id: string; x: number; y: number }[] {
    const corners = [
      { id: "nw", x: -halfW, y: -halfH },
      { id: "ne", x: halfW, y: -halfH },
      { id: "se", x: halfW, y: halfH },
      { id: "sw", x: -halfW, y: halfH },
    ];
    return corners.map((c) => ({
      id: c.id,
      x: cx + (c.x * cos - c.y * sin),
      y: cy + (c.x * sin + c.y * cos),
    }));
  }

  /**
   * Repositions existing handles + redraws the outline without destroying the
   * containers. Must be used from every DRAG tick: destroying the container
   * mid-drag aborts the Phaser drag and the gesture dies after one tick.
   */
  private repositionHandles(): void {
    const geo = this.liveGeometry();
    if (!geo) return;
    const { cx, cy, halfW, halfH, cos, sin } = geo;
    const cam = this.scene.cameras.main;
    const invZoom = 1 / cam.zoom;

    const worldCorners = this.cornerWorldPositions(cx, cy, halfW, halfH, cos, sin);

    this.selectionGfx.clear();
    this.selectionGfx.lineStyle(OUTLINE_WIDTH * invZoom, SELECTION_COLOR, 0.9);
    for (let i = 0; i < 4; i++) {
      const p1 = worldCorners[i];
      const p2 = worldCorners[(i + 1) % 4];
      this.selectionGfx.lineBetween(p1.x, p1.y, p2.x, p2.y);
    }

    const stemLength = STEM_LENGTH * invZoom;
    const topCenterX = cx + (0 * cos - -halfH * sin);
    const topCenterY = cy + (0 * sin + -halfH * cos);
    const rotHandleX = cx + (0 * cos - (-halfH - stemLength) * sin);
    const rotHandleY = cy + (0 * sin + (-halfH - stemLength) * cos);
    this.selectionGfx.lineStyle(STEM_WIDTH * invZoom, SELECTION_COLOR, 0.8);
    this.selectionGfx.lineBetween(topCenterX, topCenterY, rotHandleX, rotHandleY);

    for (const corner of worldCorners) {
      this.handleContainers.get(corner.id)?.setPosition(corner.x, corner.y);
    }
    this.handleContainers.get(ROTATE_HANDLE_ID)?.setPosition(rotHandleX, rotHandleY);

    // Handle graphics are drawn in screen pixels; counter-scale the containers
    // (which also scales their hit areas) so they stay a constant on-screen size.
    for (const handle of this.handleContainers.values()) {
      handle.setScale(invZoom);
    }
  }

  /** Re-fit the selection chrome to the current camera zoom. Safe mid-drag. */
  onZoomChanged(): void {
    this.repositionHandles();
  }

  private destroyHandles(): void {
    this.selectionGfx.clear();
    for (const h of this.handleContainers.values()) h.destroy(true);
    this.handleContainers.clear();
    // Destroyed containers never emit POINTER_OUT, so drop hover state here.
    this.hoveredHandle = null;
    this.syncCursor();
  }

  /**
   * Creates an interactive handle container whose graphics are drawn in
   * screen pixels; repositionHandles() places it and applies the 1/zoom
   * counter-scale.
   */
  private createHandle(id: string): Phaser.GameObjects.Container {
    const handle = this.scene.add.container(0, 0);
    handle.setDepth(DEPTH.SELECTION + (id === ROTATE_HANDLE_ID ? 2 : 1));
    handle.add(this.scene.add.graphics());
    handle.setSize(HANDLE_HIT_SIZE, HANDLE_HIT_SIZE);
    handle.setInteractive({ draggable: true });

    handle.on(Phaser.Input.Events.POINTER_OVER, () => {
      this.hoveredHandle = id;
      this.refreshHandleHighlight();
    });
    handle.on(Phaser.Input.Events.POINTER_OUT, () => {
      if (this.hoveredHandle !== id) return;
      this.hoveredHandle = null;
      this.refreshHandleHighlight();
    });

    this.handleContainers.set(id, handle);
    this.drawHandle(id, handle, false);
    return handle;
  }

  private drawHandle(id: string, handle: Phaser.GameObjects.Container, highlighted: boolean): void {
    const gfx = handle.getAt(0) as Phaser.GameObjects.Graphics;
    gfx.clear();
    gfx.setScale(highlighted ? HANDLE_HOVER_SCALE : 1);
    gfx.fillStyle(highlighted ? HANDLE_HOVER_COLOR : SELECTION_COLOR, 1);
    gfx.lineStyle(HANDLE_STROKE_WIDTH, HANDLE_STROKE_COLOR, 1);
    if (id === ROTATE_HANDLE_ID) {
      gfx.fillCircle(0, 0, ROTATE_HANDLE_RADIUS);
      gfx.strokeCircle(0, 0, ROTATE_HANDLE_RADIUS);
    } else {
      const half = CORNER_HANDLE_SIZE / 2;
      gfx.fillRect(-half, -half, CORNER_HANDLE_SIZE, CORNER_HANDLE_SIZE);
      gfx.strokeRect(-half, -half, CORNER_HANDLE_SIZE, CORNER_HANDLE_SIZE);
    }
  }

  /** The dragged handle, else the hovered one, is highlighted and owns the cursor. */
  private refreshHandleHighlight(): void {
    const active = this.activeDragHandle ?? this.hoveredHandle;
    for (const [id, handle] of this.handleContainers) {
      this.drawHandle(id, handle, id === active);
    }
    this.syncCursor();
  }

  private setActiveDragHandle(id: string | null): void {
    this.activeDragHandle = id;
    this.refreshHandleHighlight();
  }

  private handleCursor(id: string): string {
    if (id === ROTATE_HANDLE_ID) return ROTATE_CURSOR;
    const rotationDeg = Phaser.Math.RadToDeg(this.liveGeometry()?.rad ?? 0);
    return resizeCursorForAngle(CORNER_BASE_DEG[id] + rotationDeg);
  }

  /**
   * Cursor + tooltip for the current pointer state, or null to leave the
   * canvas default. A hovered/dragged handle wins over the image beneath it.
   */
  private desiredCursor(): { cursor: string; title: string } | null {
    const handleId = this.activeDragHandle ?? this.hoveredHandle;
    if (handleId !== null && this.handleContainers.has(handleId)) {
      // Hide the tooltip mid-drag so it doesn't trail the gesture.
      const hint = handleId === ROTATE_HANDLE_ID ? ROTATE_HINT : RESIZE_HINT;
      return {
        cursor: this.handleCursor(handleId),
        title: this.activeDragHandle !== null ? "" : hint,
      };
    }
    const spriteId = this.activeSpriteDragId ?? this.hoveredSpriteId;
    if (spriteId !== null && spriteId === this.selectedImageId) {
      return { cursor: "move", title: "" };
    }
    return null;
  }

  /**
   * Applies desiredCursor() to the canvas: gesture cursors for handles and
   * the selected image, plus a native tooltip naming each handle's gesture
   * and modifier keys. Managed here rather than via Phaser's `cursor` option,
   * which resets whenever the pointer slips off a handle mid-drag.
   */
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
      canvas.style.cursor = this.scene.input.manager.defaultCursor;
      canvas.title = this.savedCanvasTitle;
    }
  }

  private redrawSelectionHandles(): void {
    // While a tool is selected no selection outline or handles may exist.
    if (!this.interactionsEnabled) {
      this.destroyHandles();
      return;
    }
    // While a transform drag is active the dragged container must survive;
    // just reposition instead of destroy/recreate.
    if (this.activeDragHandle !== null || this.activeSpriteDragId !== null) {
      this.repositionHandles();
      return;
    }
    this.destroyHandles();

    if (!this.selectedImageId) return;
    const img = this.images.find((i) => i.id === this.selectedImageId);
    const sprite = this.sprites.get(this.selectedImageId);
    if (!img || !sprite) return;

    // Create Interactive Rotation Handle
    const rotContainer = this.createHandle(ROTATE_HANDLE_ID);

    // Snap to absolute 5deg multiples (e.g. 7deg snaps to 10 on first move);
    // holding Ctrl bypasses quantization for free rotation.
    const pointerDeg = (pointer: Phaser.Input.Pointer): number =>
      Phaser.Math.RadToDeg(
        Phaser.Math.Angle.Between(sprite.x, sprite.y, pointer.worldX, pointer.worldY),
      ) + 90;

    const resolveRotation = (pointer: Phaser.Input.Pointer): number => {
      const ctrlHeld = pointer.event ? (pointer.event as MouseEvent).ctrlKey : false;
      return snapRotation(pointerDeg(pointer), 5, ctrlHeld);
    };

    rotContainer.on(Phaser.Input.Events.DRAG_START, () => {
      if (!this.interactionsEnabled) return;
      this.setActiveDragHandle(ROTATE_HANDLE_ID);
    });

    rotContainer.on(Phaser.Input.Events.DRAG, (pointer: Phaser.Input.Pointer) => {
      if (!this.interactionsEnabled) return;
      sprite.setAngle(resolveRotation(pointer));
      this.repositionHandles();
    });

    rotContainer.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
      this.setActiveDragHandle(null);
      if (!this.interactionsEnabled) return;
      // Recompute from the release point so the commit matches the preview
      // even if Ctrl was pressed/released between the last move tick and drop.
      const finalRotation = resolveRotation(pointer);
      sprite.setAngle(finalRotation);
      this.onImageTransformEnd?.({
        imageId: img.id,
        x: img.x,
        y: img.y,
        width: img.width,
        height: img.height,
        rotation: finalRotation,
      });
      this.redrawSelectionHandles();
    });

    // Create 4 Interactive Corner Resize Handles
    for (const cornerId of CORNER_IDS) {
      this.setupCornerResize(this.createHandle(cornerId), cornerId, img, sprite);
    }

    // Draws the outline + stem and positions/scales the handles for the current zoom.
    this.repositionHandles();
  }

  private setupCornerResize(
    handle: Phaser.GameObjects.Container,
    cornerId: string,
    img: MapImage,
    _sprite: Phaser.GameObjects.Image,
  ): void {
    // Determine opposite anchor corner
    let anchorCornerX = img.x;
    let anchorCornerY = img.y;
    if (cornerId === "nw") {
      anchorCornerX = img.x + img.width;
      anchorCornerY = img.y + img.height;
    } else if (cornerId === "ne") {
      anchorCornerX = img.x;
      anchorCornerY = img.y + img.height;
    } else if (cornerId === "se") {
      anchorCornerX = img.x;
      anchorCornerY = img.y;
    } else if (cornerId === "sw") {
      anchorCornerX = img.x + img.width;
      anchorCornerY = img.y;
    }

    const aspectRatio = img.width / Math.max(0.001, img.height);

    handle.on(Phaser.Input.Events.DRAG_START, () => {
      if (!this.interactionsEnabled) return;
      this.setActiveDragHandle(cornerId);
    });

    handle.on(Phaser.Input.Events.DRAG, (pointer: Phaser.Input.Pointer) => {
      if (!this.interactionsEnabled) return;
      const dragCellX = pointer.worldX / CELL;
      const dragCellY = pointer.worldY / CELL;

      const shiftHeld = pointer.event ? (pointer.event as MouseEvent).shiftKey : false;
      const ctrlHeld = pointer.event ? (pointer.event as MouseEvent).ctrlKey : false;

      const result = snapImageResize(
        anchorCornerX,
        anchorCornerY,
        dragCellX,
        dragCellY,
        this.grid,
        !shiftHeld, // Lock aspect ratio unless shift is held
        aspectRatio,
        MIN_IMAGE_DIMENSION,
        ctrlHeld, // Ctrl bypasses grid snap for free-form resize
      );

      const sprite = this.sprites.get(img.id);
      if (sprite) {
        sprite.setDisplaySize(result.width * CELL, result.height * CELL);
        sprite.setPosition(
          (result.x + result.width / 2) * CELL,
          (result.y + result.height / 2) * CELL,
        );
      }
      this.repositionHandles();
    });

    handle.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
      this.setActiveDragHandle(null);
      if (!this.interactionsEnabled) return;
      const dragCellX = pointer.worldX / CELL;
      const dragCellY = pointer.worldY / CELL;
      const shiftHeld = pointer.event ? (pointer.event as MouseEvent).shiftKey : false;
      const ctrlHeld = pointer.event ? (pointer.event as MouseEvent).ctrlKey : false;

      const result = snapImageResize(
        anchorCornerX,
        anchorCornerY,
        dragCellX,
        dragCellY,
        this.grid,
        !shiftHeld,
        aspectRatio,
        MIN_IMAGE_DIMENSION,
        ctrlHeld,
      );

      this.onImageTransformEnd?.({
        imageId: img.id,
        x: result.x,
        y: result.y,
        width: result.width,
        height: result.height,
        rotation: img.rotation,
      });
      this.redrawSelectionHandles();
    });
  }

  setInteractiveState(enabled: boolean): void {
    this.interactionsEnabled = enabled;
    // Toggling interactivity drops Phaser's over-tracking (no POINTER_OUT follows).
    this.hoveredSpriteId = null;
    for (const [id, sprite] of this.sprites.entries()) {
      const img = this.images.find((i) => i.id === id);
      if (enabled && img && !img.locked) {
        sprite.setInteractive();
      } else {
        sprite.disableInteractive();
      }
    }
    for (const handle of this.handleContainers.values()) {
      handle.disableInteractive();
    }
    if (!enabled) {
      this.selectImage(null);
      // selectImage(null) already clears via redrawSelectionHandles, but
      // ensure no stale handle survives if selection was already null.
      this.redrawSelectionHandles();
    }
  }

  destroy(): void {
    this.selectImage(null);
    this.selectionGfx.destroy();
    for (const sprite of this.sprites.values()) {
      sprite.destroy();
    }
    this.sprites.clear();
  }
}
