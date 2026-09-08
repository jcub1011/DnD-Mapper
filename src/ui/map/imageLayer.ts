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
import { snapCorner, snapImageResize } from "../../game/snapping";
import type { AssetSource } from "../../assets/assetSource";

export interface ImageTransformEvent {
  imageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
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
    this.selectedImageId = imageId;
    this.redrawSelectionHandles();
    this.onImageSelect?.(imageId);
  }

  getSelectedImageId(): string | null {
    return this.selectedImageId;
  }

  private rebuildImages(): void {
    // 1. Clean up removed sprites
    const activeIds = new Set(this.images.map((img) => img.id));
    for (const [id, sprite] of this.sprites.entries()) {
      if (!activeIds.has(id)) {
        sprite.destroy();
        this.sprites.delete(id);
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

      // Parity geometry: set origin to center (0.5, 0.5) and position at center
      const centerX = (img.x + img.width / 2) * CELL;
      const centerY = (img.y + img.height / 2) * CELL;

      sprite!.setOrigin(0.5, 0.5);
      sprite!.setPosition(centerX, centerY);
      sprite!.setDisplaySize(img.width * CELL, img.height * CELL);
      sprite!.setAngle(img.rotation);
      sprite!.setAlpha(img.opacity);
      // Allocate depth 1..999 by rank, avoiding arbitrary layerOrder collisions
      sprite!.setDepth(DEPTH.IMAGES + Math.min(rank, 998));

      // Setup interaction
      if (!img.locked) {
        sprite!.setInteractive();
        this.setupSpriteDrag(sprite!, img);
      } else {
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
    if (!this.assetSource) return;
    try {
      const url = await this.assetSource.getUrl(img.id);
      if (!url) return;

      const textureKey = `img_${img.id}`;
      if (this.scene.textures.exists(textureKey)) {
        const sprite = this.sprites.get(img.id);
        if (sprite) {
          sprite.setTexture(textureKey);
          sprite.setDisplaySize(img.width * CELL, img.height * CELL);
        }
        return;
      }

      // Load image dynamically
      this.scene.load.image(textureKey, url);
      this.scene.load.once(`filecomplete-image-${textureKey}`, () => {
        const sprite = this.sprites.get(img.id);
        if (sprite) {
          sprite.setTexture(textureKey);
          sprite.setDisplaySize(img.width * CELL, img.height * CELL);
        }
      });
      this.scene.load.start();
    } catch {
      // Fallback stays placeholder
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
      didDrag = false;
      this.selectImage(img.id);
    });

    sprite.on(
      Phaser.Input.Events.DRAG,
      (pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
        if (Math.hypot(pointer.worldX - startPointerX, pointer.worldY - startPointerY) > 3) {
          didDrag = true;
        }

        // dragX/dragY are center coordinates
        sprite.setPosition(dragX, dragY);
        this.redrawSelectionHandles();
      },
    );

    sprite.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
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

  private redrawSelectionHandles(): void {
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

    rotContainer.on(Phaser.Input.Events.DRAG, (pointer: Phaser.Input.Pointer) => {
      const angleRad = Phaser.Math.Angle.Between(cx, cy, pointer.worldX, pointer.worldY);
      // Angle relative to -Y axis (top)
      let deg = Phaser.Math.RadToDeg(angleRad) + 90;
      if (deg < 0) deg += 360;
      if (deg >= 360) deg -= 360;

      sprite.setAngle(deg);
      this.redrawSelectionHandles();
    });

    rotContainer.on(Phaser.Input.Events.DRAG_END, () => {
      this.onImageTransformEnd?.({
        imageId: img.id,
        x: img.x,
        y: img.y,
        width: img.width,
        height: img.height,
        rotation: sprite.angle,
      });
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

    handle.on(Phaser.Input.Events.DRAG, (pointer: Phaser.Input.Pointer) => {
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
      );

      const sprite = this.sprites.get(img.id);
      if (sprite) {
        sprite.setDisplaySize(result.width * CELL, result.height * CELL);
        sprite.setPosition(
          (result.x + result.width / 2) * CELL,
          (result.y + result.height / 2) * CELL,
        );
      }
      this.redrawSelectionHandles();

      if (ctrlHeld) {
        // Free raw dimensions without grid snap
      }
    });

    handle.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
      const dragCellX = pointer.worldX / CELL;
      const dragCellY = pointer.worldY / CELL;
      const shiftHeld = pointer.event ? (pointer.event as MouseEvent).shiftKey : false;

      const result = snapImageResize(
        anchorCornerX,
        anchorCornerY,
        dragCellX,
        dragCellY,
        this.grid,
        !shiftHeld,
        aspectRatio,
        MIN_IMAGE_DIMENSION,
      );

      this.onImageTransformEnd?.({
        imageId: img.id,
        x: result.x,
        y: result.y,
        width: result.width,
        height: result.height,
        rotation: img.rotation,
      });
    });
  }

  setInteractiveState(enabled: boolean): void {
    for (const [id, sprite] of this.sprites.entries()) {
      const img = this.images.find((i) => i.id === id);
      if (enabled && img && !img.locked) {
        sprite.setInteractive();
      } else {
        sprite.disableInteractive();
      }
    }
    if (!enabled) {
      this.selectImage(null);
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
