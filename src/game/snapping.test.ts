import { describe, expect, it } from "vitest";
import type { GridConfig } from "./domain.js";
import { snapCorner, snapImageResize, snapRotation, snapToken } from "./snapping.js";

function makeGrid(snapToGrid: boolean, widthCells = 30, heightCells = 20): GridConfig {
  return {
    widthCells,
    heightCells,
    cellPixels: 50,
    showGridLines: true,
    snapToGrid,
    lineColor: "#222",
  };
}

describe("snapping", () => {
  describe("snapToken", () => {
    it("leaves already-centred token unchanged", () => {
      const { x, y } = snapToken(5.5, 7.5, makeGrid(true));
      expect(x).toBeCloseTo(5.5);
      expect(y).toBeCloseTo(7.5);
    });

    it("rounds offset token to nearest cell centre", () => {
      const { x, y } = snapToken(5.7, 7.3, makeGrid(true));
      expect(x).toBeCloseTo(5.5);
      expect(y).toBeCloseTo(7.5);

      const r2 = snapToken(5.2, 8.1, makeGrid(true));
      expect(r2.x).toBeCloseTo(5.5);
      expect(r2.y).toBeCloseTo(8.5);
    });

    it("clamps out-of-bounds positions to [0.5, W-0.5]", () => {
      const grid = makeGrid(true, 10, 10);
      const low = snapToken(-3, -4, grid);
      expect(low.x).toBeCloseTo(0.5);
      expect(low.y).toBeCloseTo(0.5);

      const high = snapToken(99, 99, grid);
      expect(high.x).toBeCloseTo(9.5);
      expect(high.y).toBeCloseTo(9.5);
    });

    it("with snapping OFF: preserves raw position but clamps to [0, W]", () => {
      const grid = makeGrid(false, 10, 10);
      const within = snapToken(3.7, 4.2, grid);
      expect(within.x).toBeCloseTo(3.7);
      expect(within.y).toBeCloseTo(4.2);

      const out = snapToken(-1, 99, grid);
      expect(out.x).toBe(0);
      expect(out.y).toBe(10);
    });
  });

  describe("snapCorner", () => {
    it("leaves integer corners unchanged", () => {
      const { x, y } = snapCorner(3, 7, makeGrid(true));
      expect(x).toBe(3);
      expect(y).toBe(7);
    });

    it("rounds fractional coordinates to nearest integer cell", () => {
      const { x, y } = snapCorner(3.3, 7.7, makeGrid(true));
      expect(x).toBe(3);
      expect(y).toBe(8);
    });

    it("with snapping ON: does NOT clamp out of bounds (images can hang off-map)", () => {
      const grid = makeGrid(true, 10, 10);
      const low = snapCorner(-5.3, -2.7, grid);
      expect(low.x).toBe(-5);
      expect(low.y).toBe(-3);

      const high = snapCorner(99.4, 99.6, grid);
      expect(high.x).toBe(99);
      expect(high.y).toBe(100);
    });

    it("with snapping OFF: returns raw coordinates untouched", () => {
      const grid = makeGrid(false, 10, 10);
      const within = snapCorner(3.7, 4.2, grid);
      expect(within.x).toBeCloseTo(3.7);
      expect(within.y).toBeCloseTo(4.2);

      const off = snapCorner(-5.5, 999.25, grid);
      expect(off.x).toBeCloseTo(-5.5);
      expect(off.y).toBeCloseTo(999.25);
    });
  });

  describe("snapImageResize", () => {
    it("resizes corner with snapping on", () => {
      const grid = makeGrid(true, 20, 20);
      const res = snapImageResize(2, 3, 7.8, 8.2, grid);
      expect(res.x).toBe(2);
      expect(res.y).toBe(3);
      expect(res.width).toBe(6); // 8 - 2
      expect(res.height).toBe(5); // 8 - 3
    });

    it("respects minimum dimension of 0.1 cells", () => {
      const grid = makeGrid(false, 20, 20);
      const res = snapImageResize(2, 3, 2.01, 3.01, grid, false, 1.0, 0.1);
      expect(res.width).toBe(0.1);
      expect(res.height).toBe(0.1);
    });

    it("bypasses grid snap when bypassSnap is true (Ctrl free-form resize)", () => {
      const grid = makeGrid(true, 20, 20);
      const res = snapImageResize(2, 3, 7.3, 8.7, grid, false, 1.0, 0.1, true);
      expect(res.x).toBe(2);
      expect(res.y).toBe(3);
      expect(res.width).toBeCloseTo(5.3);
      expect(res.height).toBeCloseTo(5.7);
    });
  });

  describe("snapRotation", () => {
    it("snaps to 5-degree increments by default", () => {
      expect(snapRotation(12)).toBe(10);
      expect(snapRotation(13)).toBe(15);
      expect(snapRotation(12.4)).toBe(10);
    });

    it("returns raw angle normalized when bypassed (Ctrl)", () => {
      expect(snapRotation(12.4, 5, true)).toBeCloseTo(12.4);
    });

    it("normalizes wraparound to [0, 360)", () => {
      expect(snapRotation(359)).toBe(0);
      expect(snapRotation(-3)).toBe(355);
      expect(snapRotation(-1)).toBe(0);
      expect(snapRotation(362.4, 5, true)).toBeCloseTo(2.4);
    });

    it("snaps non-multiples to the nearest absolute multiple", () => {
      expect(snapRotation(7)).toBe(5);
      expect(snapRotation(8)).toBe(10);
      expect(snapRotation(12)).toBe(10);
      expect(snapRotation(13)).toBe(15);
    });
  });
});
