/*
 * Ruler overlay for measurement tool in Phaser MapScene.
 * Renders distance line, endpoint dots, and label pill at DEPTH.FOCUS_RULER (5000).
 * Overlays maintain screen-constant dimensions at any camera zoom.
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import { calculateRulerDistance } from "../../game/ruler";

export interface CellPoint {
  x: number;
  y: number;
}

export class RulerOverlay {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly labelContainer: Phaser.GameObjects.Container;
  private readonly labelBg: Phaser.GameObjects.Graphics;
  private readonly labelText: Phaser.GameObjects.Text;

  public pointA: CellPoint | null = null;
  public pointB: CellPoint | null = null;
  public previewPoint: CellPoint | null = null;

  constructor(private readonly scene: Phaser.Scene) {
    this.gfx = this.scene.add.graphics();
    this.gfx.setDepth(DEPTH.FOCUS_RULER);

    this.labelContainer = this.scene.add.container(0, 0);
    this.labelContainer.setDepth(DEPTH.FOCUS_RULER + 1);

    this.labelBg = this.scene.add.graphics();
    this.labelContainer.add(this.labelBg);

    this.labelText = this.scene.add.text(0, 0, "", {
      fontSize: "13px",
      fontFamily: '"Cormorant Garamond", Georgia, serif',
      color: "#ece0cc",
    });
    this.labelText.setOrigin(0.5, 0.5);
    this.labelContainer.add(this.labelText);

    this.labelContainer.setVisible(false);
  }

  setPointA(x: number, y: number): void {
    this.pointA = { x, y };
    this.pointB = null;
    this.previewPoint = null;
    this.redraw();
  }

  setPointB(x: number, y: number): void {
    this.pointB = { x, y };
    this.previewPoint = null;
    this.redraw();
  }

  setPreviewPoint(x: number, y: number): void {
    this.previewPoint = { x, y };
    this.redraw();
  }

  clear(): void {
    this.pointA = null;
    this.pointB = null;
    this.previewPoint = null;
    this.gfx.clear();
    this.labelContainer.setVisible(false);
  }

  get isActive(): boolean {
    return this.pointA !== null;
  }

  redraw(): void {
    this.gfx.clear();

    if (!this.pointA) {
      this.labelContainer.setVisible(false);
      return;
    }

    const cam = this.scene.cameras.main;
    const invZoom = 1 / cam.zoom;

    const p1 = this.pointA;
    const p2 = this.pointB ?? this.previewPoint;

    const p1WorldX = p1.x * CELL;
    const p1WorldY = p1.y * CELL;

    // Draw Point A dot (radius 5px screen space)
    const dotRadius = 5 * invZoom;
    this.gfx.fillStyle(0xe89055, 1);
    this.gfx.fillCircle(p1WorldX, p1WorldY, dotRadius);

    if (!p2) {
      this.labelContainer.setVisible(false);
      return;
    }

    const p2WorldX = p2.x * CELL;
    const p2WorldY = p2.y * CELL;

    // Draw line
    this.gfx.lineStyle(2 * invZoom, 0xe89055, 0.9);
    this.gfx.lineBetween(p1WorldX, p1WorldY, p2WorldX, p2WorldY);

    // Draw Point B dot
    this.gfx.fillStyle(0xc4743a, 1);
    this.gfx.fillCircle(p2WorldX, p2WorldY, dotRadius);

    // Calculate measurement
    const measurement = calculateRulerDistance(p1.x, p1.y, p2.x, p2.y);

    // Position and update screen-constant label pill
    const midX = (p1WorldX + p2WorldX) / 2;
    const midY = (p1WorldY + p2WorldY) / 2 - 18 * invZoom;

    this.labelText.setText(measurement.label);
    const paddingX = 8;
    const paddingY = 4;
    const textBounds = this.labelText.getBounds();
    const w = textBounds.width + paddingX * 2;
    const h = textBounds.height + paddingY * 2;

    this.labelBg.clear();
    this.labelBg.fillStyle(0x191512, 0.9);
    this.labelBg.lineStyle(1, 0x3a2d23, 1);
    this.labelBg.strokeRoundedRect(-w / 2, -h / 2, w, h, 4);
    this.labelBg.fillRoundedRect(-w / 2, -h / 2, w, h, 4);

    this.labelContainer.setPosition(midX, midY);
    this.labelContainer.setScale(invZoom);
    this.labelContainer.setVisible(true);
  }

  destroy(): void {
    this.gfx.destroy();
    this.labelContainer.destroy(true);
  }
}
