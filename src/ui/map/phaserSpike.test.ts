// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import Phaser from "phaser";

describe("Phaser 4 API Spike (docs/blazor-port/05-rendering.md)", () => {
  it("verifies scrollX vs worldView.x midpoint equation at zoom != 1", () => {
    const cam = new Phaser.Cameras.Scene2D.Camera(0, 0, 1920, 1080);
    cam.scrollX = 500;
    cam.scrollY = 300;
    cam.setZoom(4.0);
    cam.preRender();

    // Phaser midpoint formula: worldView.x = scrollX + (cam.width / 2) * (1 - 1 / cam.zoom)
    const expectedWorldViewX = 500 + (1920 / 2) * (1 - 1 / 4.0); // 500 + 960 * 0.75 = 1220
    const expectedWorldViewY = 300 + (1080 / 2) * (1 - 1 / 4.0); // 300 + 540 * 0.75 = 705

    expect(cam.worldView.x).toBeCloseTo(expectedWorldViewX, 4);
    expect(cam.worldView.y).toBeCloseTo(expectedWorldViewY, 4);
    expect(cam.worldView.x).not.toBeCloseTo(cam.scrollX, 1);
  });

  it("verifies camera.centerOn centers the world point on the camera midpoint", () => {
    const cam = new Phaser.Cameras.Scene2D.Camera(0, 0, 1920, 1080);
    const targetX = 1000;
    const targetY = 800;

    cam.centerOn(targetX, targetY);
    cam.preRender();

    expect(cam.midPoint.x).toBeCloseTo(targetX, 4);
    expect(cam.midPoint.y).toBeCloseTo(targetY, 4);
  });

  it("verifies getWorldPoint converts screen coordinates to world coordinates", () => {
    const cam = new Phaser.Cameras.Scene2D.Camera(0, 0, 1920, 1080);
    cam.scrollX = 0;
    cam.scrollY = 0;
    cam.setZoom(2.0);
    cam.preRender();

    // Midpoint screen coord (960, 540) maps to camera midPoint in world
    const pt = cam.getWorldPoint(960, 540);
    expect(pt.x).toBeCloseTo(cam.midPoint.x, 3);
    expect(pt.y).toBeCloseTo(cam.midPoint.y, 3);
  });

  it("verifies Texture filter mode constants exist in Phaser 4", () => {
    expect(Phaser.Textures.NEAREST).toBe(1);
    expect(Phaser.Textures.FilterMode.NEAREST).toBe(1);
    expect(Phaser.Textures.LINEAR).toBe(0);
    expect(Phaser.Textures.FilterMode.LINEAR).toBe(0);
  });
});
