/*
 * Multi-touch navigation helper for Phaser cameras.
 * Supports two-finger panning and pinch-to-zoom anchored at touch midpoint.
 */

import Phaser from "phaser";
import { zoomAtAnchor } from "./viewport";

export class TouchNavigation {
  private prevDist = 0;
  private prevMidX = 0;
  private prevMidY = 0;
  private isMultiTouching = false;

  constructor(private readonly scene: Phaser.Scene) {
    // Ensure Phaser has at least 2 active pointers for multi-touch
    if (this.scene.input.manager.pointersTotal < 3) {
      this.scene.input.addPointer(2);
    }
  }

  /**
   * Evaluates current active pointers. Returns true if multi-touch gesture was handled.
   */
  update(): boolean {
    const cam = this.scene.cameras.main;
    const pointers = this.scene.input.manager.pointers.filter((p) => p.isDown);

    if (pointers.length < 2) {
      this.isMultiTouching = false;
      this.prevDist = 0;
      return false;
    }

    const p1 = pointers[0];
    const p2 = pointers[1];

    const currentDist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;

    if (!this.isMultiTouching || this.prevDist === 0) {
      this.isMultiTouching = true;
      this.prevDist = currentDist;
      this.prevMidX = midX;
      this.prevMidY = midY;
      return true;
    }

    // 1. Pinch Zoom anchored at midpoint
    if (Math.abs(currentDist - this.prevDist) > 1) {
      const factor = currentDist / this.prevDist;
      zoomAtAnchor(cam, factor, midX, midY);
    }

    // 2. Pan delta
    const dMidX = midX - this.prevMidX;
    const dMidY = midY - this.prevMidY;
    cam.scrollX -= dMidX / cam.zoom;
    cam.scrollY -= dMidY / cam.zoom;

    this.prevDist = currentDist;
    this.prevMidX = midX;
    this.prevMidY = midY;

    return true;
  }

  public get isGesturing(): boolean {
    return this.isMultiTouching;
  }

  public reset(): void {
    this.isMultiTouching = false;
    this.prevDist = 0;
  }
}
