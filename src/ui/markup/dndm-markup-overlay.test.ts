// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import "./dndm-markup-overlay";
import type { DndmMarkupOverlay } from "./dndm-markup-overlay";
import type { GameMap } from "../../game/domain";
import { DEFAULT_GRID_CONFIG } from "../../game/domain";

describe("<dndm-markup-overlay> Component", () => {
  const MAP: GameMap = {
    id: "map-1",
    name: "Test Map",
    grid: DEFAULT_GRID_CONFIG,
    images: [],
    tokens: [],
    createdUtc: "2026-09-11T12:00:00Z",
    listOrder: 0,
    defaultSpawnPosition: null,
    markupSvg: `<g stroke="#c0392b" stroke-width="0.08"><path d="M 5 5 L 10 10" /></g>`,
    fogMask: "",
  };

  it("renders palette with tools, swatches, width presets, and action buttons", async () => {
    const el = document.createElement("dndm-markup-overlay") as DndmMarkupOverlay;
    el.activeMap = MAP;
    document.body.appendChild(el);
    await el.updateComplete;

    const palette = el.querySelector(".dndm-markup-palette");
    expect(palette).not.toBeNull();

    const buttons = el.querySelectorAll(".dndm-markup-btn");
    expect(buttons.length).toBeGreaterThanOrEqual(5); // Pen, Eraser, Undo, Redo, Clear, Close

    const swatches = el.querySelectorAll(".dndm-markup-swatch");
    expect(swatches.length).toBe(6); // 6 colors

    const widths = el.querySelectorAll(".dndm-markup-width-btn");
    expect(widths.length).toBe(4); // 4 widths

    el.remove();
  });

  it("toggles tool between pen and eraser on button click", async () => {
    const el = document.createElement("dndm-markup-overlay") as DndmMarkupOverlay;
    el.activeMap = MAP;
    document.body.appendChild(el);
    await el.updateComplete;

    const eraserBtn = Array.from(el.querySelectorAll(".dndm-markup-btn")).find(
      (b) => b.textContent?.trim() === "⌫",
    ) as HTMLButtonElement;
    expect(eraserBtn).toBeDefined();

    eraserBtn.click();
    await el.updateComplete;
    expect(eraserBtn.classList.contains("active")).toBe(true);

    const penBtn = Array.from(el.querySelectorAll(".dndm-markup-btn")).find(
      (b) => b.textContent?.trim() === "✎",
    ) as HTMLButtonElement;
    penBtn.click();
    await el.updateComplete;
    expect(penBtn.classList.contains("active")).toBe(true);

    el.remove();
  });

  it("switches active color when a swatch is clicked", async () => {
    const el = document.createElement("dndm-markup-overlay") as DndmMarkupOverlay;
    el.activeMap = MAP;
    document.body.appendChild(el);
    await el.updateComplete;

    const swatches = el.querySelectorAll(".dndm-markup-swatch") as NodeListOf<HTMLButtonElement>;
    // Click emerald swatch
    const emeraldSwatch = swatches[2]; // Emerald
    emeraldSwatch.click();
    await el.updateComplete;

    expect(emeraldSwatch.classList.contains("active")).toBe(true);

    el.remove();
  });

  it("toggles panning class on Space keydown and keyup", async () => {
    const el = document.createElement("dndm-markup-overlay") as DndmMarkupOverlay;
    el.activeMap = MAP;
    document.body.appendChild(el);
    await el.updateComplete;

    const canvas = el.querySelector(".dndm-markup-canvas")!;
    expect(canvas.classList.contains("dndm-markup-canvas--panning")).toBe(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    await el.updateComplete;
    expect(canvas.classList.contains("dndm-markup-canvas--panning")).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    await el.updateComplete;
    expect(canvas.classList.contains("dndm-markup-canvas--panning")).toBe(false);

    el.remove();
  });
});
