/*
 * Image layers management in Phaser MapScene.
 * Responsibilities:
 *  - Rank-normalized depth assignment (DEPTH.IMAGES + rank)
 *  - Center-anchored rotation parity matching legacy Canvas2D
 *  - Placeholder dashed textures for missing/loading assets
 *  - Interactive selection outline, 4-corner resize handles, and rotation stem
 *  - Snapping with Ctrl (bypass) and Shift (free aspect ratio) modifiers
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import type { GridConfig, MapImage } from "../../game/domain";
import { MIN_IMAGE_DIMENSION } from "../../game/domain";
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

    // 2. Sort by layerOrder to establish rank (DEPTH.IMAGES + rank)
    const sorted = [...this.images].sort((a, b) => a.layerOrder - b.layerOrder);

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

    // Make scene listen to pointer move when selected image is dragging
    this.scene.input.setDraggable(sprite);

    sprite.on(Phaser.Input.Events.DRAG_START, (_pointer: Phaser.Input.Pointer) => {
      if (!this.interactionsEnabled) return;
      didDrag = false;
      this.activeSpriteDragId = img.id;
      this.selectImage(img.id);
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
    this.selectionGfx.lineStyle(2 * invZoom, 0xe89055, 0.9);
    for (let i = 0; i < 4; i++) {
      const p1 = worldCorners[i];
      const p2 = worldCorners[(i + 1) % 4];
      this.selectionGfx.lineBetween(p1.x, p1.y, p2.x, p2.y);
    }

    const stemLength = 24 * invZoom;
    const topCenterX = cx + (0 * cos - -halfH * sin);
    const topCenterY = cy + (0 * sin + -halfH * cos);
    const rotHandleX = cx + (0 * cos - (-halfH - stemLength) * sin);
    const rotHandleY = cy + (0 * sin + (-halfH - stemLength) * cos);
    this.selectionGfx.lineStyle(1.5 * invZoom, 0xe89055, 0.8);
    this.selectionGfx.lineBetween(topCenterX, topCenterY, rotHandleX, rotHandleY);

    for (const corner of worldCorners) {
      this.handleContainers.get(corner.id)?.setPosition(corner.x, corner.y);
    }
    this.handleContainers.get("rot")?.setPosition(rotHandleX, rotHandleY);
  }

  private redrawSelectionHandles(): void {
    // While a tool is selected no selection outline or handles may exist.
    if (!this.interactionsEnabled) {
      this.selectionGfx.clear();
      for (const h of this.handleContainers.values()) h.destroy(true);
      this.handleContainers.clear();
      return;
    }
    // While a transform drag is active the dragged container must survive;
    // just reposition instead of destroy/recreate.
    if (this.activeDragHandle !== null || this.activeSpriteDragId !== null) {
      this.repositionHandles();
      return;
    }
    this.selectionGfx.clear();
    for (const h of this.handleContainers.values()) h.destroy(true);
    this.handleContainers.clear();

    if (!this.selectedImageId) return;
    const img = this.images.find((i) => i.id === this.selectedImageId);
    const sprite = this.sprites.get(this.selectedImageId);
    if (!img || !sprite) return;

    const cam = this.scene.cameras.main;
    const invZoom = 1 / cam.zoom;

    const rad = Phaser.Math.DegToRad(img.rotation);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const halfW = (img.width * CELL) / 2;
    const halfH = (img.height * CELL) / 2;
    const cx = sprite.x;
    const cy = sprite.y;

    // 4 corners relative to center
    const corners = [
      { id: "nw", x: -halfW, y: -halfH },
      { id: "ne", x: halfW, y: -halfH },
      { id: "se", x: halfW, y: halfH },
      { id: "sw", x: -halfW, y: halfH },
    ];

    const worldCorners = corners.map((c) => ({
      id: c.id,
      x: cx + (c.x * cos - c.y * sin),
      y: cy + (c.x * sin + c.y * cos),
    }));

    // Draw selection outline
    this.selectionGfx.lineStyle(2 * invZoom, 0xe89055, 0.9);
    for (let i = 0; i < 4; i++) {
      const p1 = worldCorners[i];
      const p2 = worldCorners[(i + 1) % 4];
      this.selectionGfx.lineBetween(p1.x, p1.y, p2.x, p2.y);
    }

    // Draw rotation stem and handle
    const stemLength = 24 * invZoom;
    const topCenterX = cx + (0 * cos - -halfH * sin);
    const topCenterY = cy + (0 * sin + -halfH * cos);
    const rotHandleX = cx + (0 * cos - (-halfH - stemLength) * sin);
    const rotHandleY = cy + (0 * sin + (-halfH - stemLength) * cos);

    this.selectionGfx.lineStyle(1.5 * invZoom, 0xe89055, 0.8);
    this.selectionGfx.lineBetween(topCenterX, topCenterY, rotHandleX, rotHandleY);

    // Create Interactive Rotation Handle
    const rotContainer = this.scene.add.container(rotHandleX, rotHandleY);
    rotContainer.setDepth(DEPTH.SELECTION + 2);
    const rotDot = this.scene.add.graphics();
    rotDot.fillStyle(0xe89055, 1);
    rotDot.lineStyle(1.5, 0x07060a, 1);
    rotDot.fillCircle(0, 0, 7 * invZoom);
    rotDot.strokeCircle(0, 0, 7 * invZoom);
    rotContainer.add(rotDot);
    rotContainer.setSize(18 * invZoom, 18 * invZoom);
    rotContainer.setInteractive({ draggable: true });

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
      this.activeDragHandle = "rot";
    });

    rotContainer.on(Phaser.Input.Events.DRAG, (pointer: Phaser.Input.Pointer) => {
      if (!this.interactionsEnabled) return;
      sprite.setAngle(resolveRotation(pointer));
      this.repositionHandles();
    });

    rotContainer.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
      this.activeDragHandle = null;
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

    this.handleContainers.set("rot", rotContainer);

    // Create 4 Interactive Corner Resize Handles
    for (const corner of worldCorners) {
      const handle = this.scene.add.container(corner.x, corner.y);
      handle.setDepth(DEPTH.SELECTION + 1);

      const hGfx = this.scene.add.graphics();
      hGfx.fillStyle(0xe89055, 1);
      hGfx.lineStyle(1.5, 0x07060a, 1);
      const hSize = 8 * invZoom;
      hGfx.fillRect(-hSize / 2, -hSize / 2, hSize, hSize);
      hGfx.strokeRect(-hSize / 2, -hSize / 2, hSize, hSize);
      handle.add(hGfx);

      handle.setSize(18 * invZoom, 18 * invZoom);
      handle.setInteractive({ draggable: true });

      this.setupCornerResize(handle, corner.id, img, sprite);
      this.handleContainers.set(corner.id, handle);
    }
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
      this.activeDragHandle = cornerId;
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
      this.activeDragHandle = null;
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
