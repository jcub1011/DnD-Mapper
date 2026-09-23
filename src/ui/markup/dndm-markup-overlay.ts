/*
 * Freehand Canvas Markup Overlay component.
 *
 * Provides:
 *   - Transparent drawing surface over Phaser map
 *   - Floating palette: Pen, Eraser, 6 colors, 4 width presets, Undo, Redo, Clear All
 *   - Local buffering during pointermove (0 msg/s to network)
 *   - Immediate intent commit on pointerup
 *   - Space-to-pan pass-through
 *   - Local undo/redo history
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";
import { eraserIcon } from "../icons";
import type { GameMap } from "../../game/domain";
import { fx } from "../fx/fx";
import { CELL, WHEEL_FACTOR } from "../map/viewport";
import {
  isStrokeHit,
  parseSvgToStrokes,
  pointsToQuadraticBezier,
  serializeStrokesToSvg,
  type MarkupStroke,
  type Point,
} from "./bezier";

/** Minimal camera snapshot needed for screen projection. */
export interface PreviewCamera {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: number;
  /** Camera viewport size in screen px — Phaser zooms about the viewport
   *  midpoint, so this is required for exact mapping at zoom != 1. */
  readonly width: number;
  readonly height: number;
}

/**
 * Project a cell-unit point into overlay-surface pixel space for the live
 * preview. Inverts Phaser's zoom-about-midpoint camera:
 * `screen = (cell * CELL - scroll) * zoom + (size / 2) * (1 - zoom)
 *          + canvas-to-surface offset`.
 * Pure function so the camera mapping is unit-testable.
 */
export function cellPointToScreenPoint(
  cell: Point,
  cam: PreviewCamera,
  canvasRect: { left: number; top: number },
  surfaceRect: { left: number; top: number },
): Point {
  return {
    x:
      (cell.x * CELL - cam.scrollX) * cam.zoom +
      (cam.width / 2) * (1 - cam.zoom) +
      (canvasRect.left - surfaceRect.left),
    y:
      (cell.y * CELL - cam.scrollY) * cam.zoom +
      (cam.height / 2) * (1 - cam.zoom) +
      (canvasRect.top - surfaceRect.top),
  };
}

/** Project a whole in-progress stroke into preview pixel space. */
export function projectCellPointsToScreen(
  cells: readonly Point[],
  cam: PreviewCamera,
  canvasRect: { left: number; top: number },
  surfaceRect: { left: number; top: number },
): Point[] {
  return cells.map((c) => cellPointToScreenPoint(c, cam, canvasRect, surfaceRect));
}

const PALETTE_COLORS = [
  { name: "Copper", hex: "#d35400" },
  { name: "Crimson", hex: "#c0392b" },
  { name: "Emerald", hex: "#27ae60" },
  { name: "Gold", hex: "#f39c12" },
  { name: "White", hex: "#ffffff" },
  { name: "Black", hex: "#000000" },
];

const WIDTH_PRESETS = [
  { name: "Thin", width: 0.02, dotSize: 4 },
  { name: "Medium", width: 0.04, dotSize: 7 },
  { name: "Thick", width: 0.08, dotSize: 11 },
  { name: "Marker", width: 0.16, dotSize: 15 },
];

@customElement("dndm-markup-overlay")
export class DndmMarkupOverlay extends GameElement {
  @property({ attribute: false })
  activeMap: GameMap | null = null;

  @property({ attribute: false })
  onCommitMarkup?: (svg: string | null) => void;

  @property({ attribute: false })
  onClose?: () => void;

  @state() private activeTool: "pen" | "eraser" = "pen";
  @state() private activeColor = "#c0392b";
  @state() private activeWidth = 0.04; // medium
  @state() private strokes: MarkupStroke[] = [];
  @state() private isDrawing = false;
  @state() private currentStrokePoints: Point[] = [];
  @state() private isPanningWithSpace = false;
  @state() private isMmbPanning = false;

  /** Last client coords of an in-progress middle-drag pan. */
  private mmbLastX = 0;
  private mmbLastY = 0;

  private undoStack: MarkupStroke[][] = [];
  private redoStack: MarkupStroke[][] = [];
  private lastSyncedMapId: string | null = null;
  private lastSyncedSvg: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    if (this.activeMap) {
      this.syncFromMap(this.activeMap);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  override willUpdate(changedProps: Map<string, unknown>): void {
    if (changedProps.has("activeMap") && this.activeMap && !this.isDrawing) {
      if (
        this.activeMap.id !== this.lastSyncedMapId ||
        this.activeMap.markupSvg !== this.lastSyncedSvg
      ) {
        this.syncFromMap(this.activeMap);
      }
    }
  }

  private syncFromMap(map: GameMap): void {
    this.lastSyncedMapId = map.id;
    this.lastSyncedSvg = map.markupSvg ?? null;
    this.strokes = parseSvgToStrokes(map.markupSvg ?? null);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Space" && !this.isPanningWithSpace) {
      this.isPanningWithSpace = true;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space") {
      this.isPanningWithSpace = false;
    }
  };

  private getPointerCellPoint(e: PointerEvent): Point {
    const cam = fx.map()?.cameras.main;
    const canvas = fx.map()?.game?.canvas;

    if (cam && canvas) {
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const worldPoint = cam.getWorldPoint(screenX, screenY);
      return { x: worldPoint.x / CELL, y: worldPoint.y / CELL };
    }

    const surface = this.querySelector(".dndm-markup-canvas");
    const rect = surface?.getBoundingClientRect() ?? this.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / CELL,
      y: (e.clientY - rect.top) / CELL,
    };
  }

  /** Live preview path in overlay-surface pixels (screen space, no SVG transform). */
  private getPreviewScreenD(): { d: string; strokeWidthPx: number } {
    if (this.activeTool !== "pen" || this.currentStrokePoints.length === 0) {
      return { d: "", strokeWidthPx: 0 };
    }
    const cam = fx.map()?.cameras.main;
    const canvas = fx.map()?.game?.canvas;
    if (!cam || !canvas) {
      // Headless/test fallback: world scale at zoom 1, zero scroll.
      const pts = this.currentStrokePoints.map((p) => ({ x: p.x * CELL, y: p.y * CELL }));
      return { d: pointsToQuadraticBezier(pts), strokeWidthPx: Math.max(1, this.activeWidth * CELL) };
    }
    const surface = this.querySelector(".dndm-markup-canvas");
    const surfaceRect = surface?.getBoundingClientRect() ?? this.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const screenPts = projectCellPointsToScreen(
      this.currentStrokePoints,
      {
        scrollX: cam.scrollX,
        scrollY: cam.scrollY,
        zoom: cam.zoom,
        width: cam.width,
        height: cam.height,
      },
      canvasRect,
      surfaceRect,
    );
    return {
      d: pointsToQuadraticBezier(screenPts),
      strokeWidthPx: Math.max(1, this.activeWidth * CELL * cam.zoom),
    };
  }

  private onPointerDown(e: PointerEvent): void {
    // Middle-drag ALWAYS pans, mirroring MapScene (the overlay sits above
    // the Phaser canvas, so Phaser never sees the gesture).
    if (e.button === 1) {
      e.preventDefault();
      if (!fx.map()) return;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      this.isMmbPanning = true;
      this.mmbLastX = e.clientX;
      this.mmbLastY = e.clientY;
      return;
    }
    if (e.button !== 0 || this.isPanningWithSpace) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);

    const pt = this.getPointerCellPoint(e);
    this.isDrawing = true;

    if (this.activeTool === "pen") {
      this.currentStrokePoints = [pt];
    } else if (this.activeTool === "eraser") {
      this.eraseAtPoint(pt);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.isMmbPanning) {
      const dx = e.clientX - this.mmbLastX;
      const dy = e.clientY - this.mmbLastY;
      this.mmbLastX = e.clientX;
      this.mmbLastY = e.clientY;
      fx.map()?.panByScreenDelta(dx, dy);
      // Re-render so an in-progress preview stays glued to the new camera.
      this.requestUpdate();
      return;
    }
    if (!this.isDrawing || this.isPanningWithSpace) return;

    const pt = this.getPointerCellPoint(e);

    if (this.activeTool === "pen") {
      this.currentStrokePoints = [...this.currentStrokePoints, pt];
    } else if (this.activeTool === "eraser") {
      this.eraseAtPoint(pt);
    }
  }

  private onPointerUp(_e: PointerEvent): void {
    if (this.isMmbPanning) {
      this.isMmbPanning = false;
      return;
    }
    if (!this.isDrawing) return;
    this.isDrawing = false;

    if (this.activeTool === "pen" && this.currentStrokePoints.length > 0) {
      const d = pointsToQuadraticBezier(this.currentStrokePoints);
      const newStroke: MarkupStroke = {
        id: `stroke_${Date.now()}_${Math.random()}`,
        color: this.activeColor,
        width: this.activeWidth,
        points: this.currentStrokePoints,
        d,
      };

      this.undoStack.push([...this.strokes]);
      this.redoStack = [];
      this.strokes = [...this.strokes, newStroke];
      this.currentStrokePoints = [];

      const svg = serializeStrokesToSvg(this.strokes);
      this.lastSyncedSvg = svg;
      this.onCommitMarkup?.(svg);
    }
  }

  /**
   * Wheel zoom over the overlay. The drawing surface sits above the Phaser
   * canvas, so Phaser's own POINTER_WHEEL handler never fires — mirror it
   * here, cursor-anchored, via MapScene.
   */
  private onWheel(e: WheelEvent): void {
    const map = fx.map();
    const canvas = map?.game?.canvas;
    if (!map || !canvas) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR;
    map.zoomAtScreenPoint(factor, e.clientX - rect.left, e.clientY - rect.top);
    // Keep an in-progress preview glued to the new camera.
    this.requestUpdate();
  }

  /**
   * Suppress middle-click autoscroll: pointerdown preventDefault does not
   * cancel the mousedown default action that starts it.
   */
  private onMouseDown(e: MouseEvent): void {
    if (e.button === 1) e.preventDefault();
  }

  private eraseAtPoint(pt: Point): void {
    const eraserRadius = 0.25; // in cells (~16px at CELL=64)
    const hitIndex = this.strokes.findIndex((s) => isStrokeHit(s.points, pt, eraserRadius));

    if (hitIndex !== -1) {
      this.undoStack.push([...this.strokes]);
      this.redoStack = [];

      const nextStrokes = [...this.strokes];
      nextStrokes.splice(hitIndex, 1);
      this.strokes = nextStrokes;

      const svg = serializeStrokesToSvg(this.strokes);
      const nextSvg = svg.length > 0 ? svg : null;
      this.lastSyncedSvg = nextSvg;
      this.onCommitMarkup?.(nextSvg);
    }
  }

  private undo(): void {
    if (this.undoStack.length === 0) return;
    const prev = this.undoStack.pop()!;
    this.redoStack.push([...this.strokes]);
    this.strokes = prev;

    const svg = serializeStrokesToSvg(this.strokes);
    const nextSvg = svg.length > 0 ? svg : null;
    this.lastSyncedSvg = nextSvg;
    this.onCommitMarkup?.(nextSvg);
  }

  private redo(): void {
    if (this.redoStack.length === 0) return;
    const next = this.redoStack.pop()!;
    this.undoStack.push([...this.strokes]);
    this.strokes = next;

    const svg = serializeStrokesToSvg(this.strokes);
    const nextSvg = svg.length > 0 ? svg : null;
    this.lastSyncedSvg = nextSvg;
    this.onCommitMarkup?.(nextSvg);
  }

  private clearAll(): void {
    if (this.strokes.length === 0) return;
    if (window.confirm("Clear all markup from this map?")) {
      this.undoStack.push([...this.strokes]);
      this.redoStack = [];
      this.strokes = [];

      this.lastSyncedSvg = null;
      this.onCommitMarkup?.(null);
    }
  }

  override render(): TemplateResult {
    // Current in-progress stroke preview, projected to screen pixels so it
    // sits exactly where the committed Phaser render will land.
    const { d: previewD, strokeWidthPx: previewWidthPx } = this.getPreviewScreenD();

    return html`
      <div class="dndm-markup-overlay">
        <!-- Floating Palette -->
        <div class="dndm-markup-palette" role="toolbar" aria-label="Markup tools">
          <button
            class="dndm-markup-btn ${this.activeTool === "pen" ? "active" : ""}"
            type="button"
            title="Pen — draw freehand vector paths"
            @click=${() => {
              this.activeTool = "pen";
            }}
          >
            ✎
          </button>
          <button
            class="dndm-markup-btn ${this.activeTool === "eraser" ? "active" : ""}"
            type="button"
            title="Eraser — click on a stroke to erase it"
            @click=${() => {
              this.activeTool = "eraser";
            }}
          >
            ${eraserIcon()}
          </button>

          <span class="dndm-markup-sep" aria-hidden="true"></span>

          <!-- Color palette -->
          <div class="dndm-markup-swatch-group" role="radiogroup" aria-label="Markup colors">
            ${PALETTE_COLORS.map(
              (c) => html`
                <button
                  class="dndm-markup-swatch ${this.activeColor === c.hex ? "active" : ""}"
                  type="button"
                  title="${c.name}"
                  style="background-color: ${c.hex};"
                  @click=${() => {
                    this.activeColor = c.hex;
                    this.activeTool = "pen";
                  }}
                ></button>
              `,
            )}
          </div>

          <span class="dndm-markup-sep" aria-hidden="true"></span>

          <!-- Width presets -->
          <div class="dndm-markup-width-group" role="radiogroup" aria-label="Stroke widths">
            ${WIDTH_PRESETS.map(
              (w) => html`
                <button
                  class="dndm-markup-width-btn ${this.activeWidth === w.width ? "active" : ""}"
                  type="button"
                  title="${w.name}"
                  @click=${() => {
                    this.activeWidth = w.width;
                  }}
                >
                  <span
                    class="dndm-markup-width-dot"
                    style="width: ${w.dotSize}px; height: ${w.dotSize}px; color: ${this.activeColor};"
                  ></span>
                </button>
              `,
            )}
          </div>

          <span class="dndm-markup-sep" aria-hidden="true"></span>

          <!-- Actions: Undo, Redo, Clear, Close -->
          <button
            class="dndm-markup-btn"
            type="button"
            title="Undo (Ctrl+Z)"
            ?disabled=${this.undoStack.length === 0}
            @click=${() => this.undo()}
          >
            ↶
          </button>
          <button
            class="dndm-markup-btn"
            type="button"
            title="Redo (Ctrl+Y)"
            ?disabled=${this.redoStack.length === 0}
            @click=${() => this.redo()}
          >
            ↷
          </button>
          <button
            class="dndm-markup-btn"
            type="button"
            title="Clear all markup"
            ?disabled=${this.strokes.length === 0}
            @click=${() => this.clearAll()}
          >
            🗑
          </button>

          <span class="dndm-markup-sep" aria-hidden="true"></span>

          <button
            class="dndm-markup-btn"
            type="button"
            title="Close markup tool"
            @click=${() => this.onClose?.()}
          >
            ✕
          </button>
        </div>

        <!-- Interactive drawing surface -->
        <div
          class="dndm-markup-canvas ${this.isPanningWithSpace
            ? "dndm-markup-canvas--panning"
            : ""} ${this.isMmbPanning ? "dndm-markup-canvas--mmb-pan" : ""}"
          @pointerdown=${this.onPointerDown}
          @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerUp}
          @pointercancel=${this.onPointerUp}
          @mousedown=${this.onMouseDown}
          @wheel=${this.onWheel}
        >
          ${previewD
            ? html`
                <svg class="dndm-markup-preview-svg">
                  <g
                    stroke="${this.activeColor}"
                    stroke-width="${previewWidthPx}"
                    fill="none"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="${previewD}" />
                  </g>
                </svg>
              `
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-markup-overlay": DndmMarkupOverlay;
  }
}
