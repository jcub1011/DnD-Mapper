import { describe, expect, it } from "vitest";
import type { GridConfig } from "./domain.js";
import {
  decodeFog,
  encodeFog,
  fogByteLength,
  isFogged,
  setCellFogged,
  setCellsFogged,
} from "./fog.js";

function makeGrid(widthCells = 30, heightCells = 20): GridConfig {
  return {
    widthCells,
    heightCells,
    cellPixels: 50,
    showGridLines: true,
    snapToGrid: true,
    lineColor: "#222",
  };
}

describe("fog", () => {
  it("treats an empty or absent mask as ALL REVEALED", () => {
    const grid = makeGrid(100, 100);
    const emptyMask = new Uint8Array(0);

    expect(isFogged(emptyMask, grid, 0, 0)).toBe(false);
    expect(isFogged(emptyMask, grid, 50, 50)).toBe(false);
    expect(isFogged(emptyMask, grid, 99, 99)).toBe(false);

    // Empty b64 string decodes to empty bytes
    expect(decodeFog("").length).toBe(0);
    expect(isFogged(decodeFog(""), grid, 5, 5)).toBe(false);
  });

  it("sets and gets fogged cells correctly", () => {
    const grid = makeGrid(100, 100);
    let mask = new Uint8Array(0);

    mask = setCellFogged(mask, grid, 3, 4, true);
    expect(isFogged(mask, grid, 3, 4)).toBe(true);
    expect(isFogged(mask, grid, 3, 5)).toBe(false);
    expect(isFogged(mask, grid, 4, 4)).toBe(false);

    // Clear it
    mask = setCellFogged(mask, grid, 3, 4, false);
    expect(isFogged(mask, grid, 3, 4)).toBe(false);
  });

  it("handles non-byte-aligned widths without row crosstalk or bleeding", () => {
    // Width 7 is not a multiple of 8. 7 * 5 = 35 cells -> 5 bytes.
    const grid = makeGrid(7, 5);
    expect(fogByteLength(grid)).toBe(5);

    let mask = new Uint8Array(0);

    // End of row 0: (6, 0) -> bit 6
    mask = setCellFogged(mask, grid, 6, 0, true);
    expect(isFogged(mask, grid, 6, 0)).toBe(true);

    // Start of row 1: (0, 1) -> bit 7 (same byte, but next row!)
    expect(isFogged(mask, grid, 0, 1)).toBe(false);

    // Now fog (0, 1) as well
    mask = setCellFogged(mask, grid, 0, 1, true);
    expect(isFogged(mask, grid, 6, 0)).toBe(true);
    expect(isFogged(mask, grid, 0, 1)).toBe(true);

    // Other adjacent cells remain revealed
    expect(isFogged(mask, grid, 5, 0)).toBe(false);
    expect(isFogged(mask, grid, 1, 1)).toBe(false);

    // Width 13: 13 * 9 = 117 cells -> 15 bytes
    const grid13 = makeGrid(13, 9);
    let mask13 = new Uint8Array(0);
    mask13 = setCellFogged(mask13, grid13, 12, 0, true); // bit 12 -> byte 1, bit 4
    mask13 = setCellFogged(mask13, grid13, 0, 1, true); // bit 13 -> byte 1, bit 5
    expect(isFogged(mask13, grid13, 12, 0)).toBe(true);
    expect(isFogged(mask13, grid13, 0, 1)).toBe(true);
    expect(isFogged(mask13, grid13, 11, 0)).toBe(false);
    expect(isFogged(mask13, grid13, 1, 1)).toBe(false);
  });

  it("safely ignores out-of-bounds cells", () => {
    const grid = makeGrid(10, 10);
    let mask = new Uint8Array(0);

    mask = setCellFogged(mask, grid, -1, 0, true);
    mask = setCellFogged(mask, grid, 0, -1, true);
    mask = setCellFogged(mask, grid, 10, 0, true);
    mask = setCellFogged(mask, grid, 0, 10, true);

    expect(mask.length).toBe(0);
    expect(isFogged(mask, grid, -1, 0)).toBe(false);
    expect(isFogged(mask, grid, 10, 0)).toBe(false);
  });

  it("encodes and decodes base64 losslessly", () => {
    const grid = makeGrid(30, 20);
    let mask = new Uint8Array(0);

    mask = setCellFogged(mask, grid, 0, 0, true);
    mask = setCellFogged(mask, grid, 29, 19, true);
    mask = setCellFogged(mask, grid, 15, 10, true);

    const b64 = encodeFog(mask);
    expect(typeof b64).toBe("string");
    expect(b64.length).toBeGreaterThan(0);

    const decoded = decodeFog(b64);
    expect(decoded.length).toBe(mask.length);
    expect(isFogged(decoded, grid, 0, 0)).toBe(true);
    expect(isFogged(decoded, grid, 29, 19)).toBe(true);
    expect(isFogged(decoded, grid, 15, 10)).toBe(true);
    expect(isFogged(decoded, grid, 1, 0)).toBe(false);
  });

  it("supports batch updates via setCellsFogged", () => {
    const grid = makeGrid(20, 20);
    const cellsToFog = [
      0 * 20 + 0, // (0, 0)
      0 * 20 + 1, // (1, 0)
      1 * 20 + 0, // (0, 1)
      5 * 20 + 5, // (5, 5)
    ];

    const mask = setCellsFogged(new Uint8Array(0), grid, cellsToFog, true);
    expect(isFogged(mask, grid, 0, 0)).toBe(true);
    expect(isFogged(mask, grid, 1, 0)).toBe(true);
    expect(isFogged(mask, grid, 0, 1)).toBe(true);
    expect(isFogged(mask, grid, 5, 5)).toBe(true);
    expect(isFogged(mask, grid, 2, 0)).toBe(false);

    // Reveal subset
    const cleared = setCellsFogged(mask, grid, [0 * 20 + 0, 5 * 20 + 5], false);
    expect(isFogged(cleared, grid, 0, 0)).toBe(false);
    expect(isFogged(cleared, grid, 1, 0)).toBe(true);
    expect(isFogged(cleared, grid, 5, 5)).toBe(false);
  });
});
