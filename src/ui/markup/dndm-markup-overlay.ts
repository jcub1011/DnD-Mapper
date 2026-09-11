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
import type { GameMap } from "../../game/domain";
import { fx } from "../fx/fx";
import {
  isStrokeHit,
  parseSvgToStrokes,
  pointsToQuadraticBezier,
  serializeStrokesToSvg,
  type MarkupStroke,
  type Point,
} from "./bezier";

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
      return { x: worldPoint.x / 50, y: worldPoint.y / 50 };
    }

    const rect = this.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / 50,
      y: (e.clientY - rect.top) / 50,
    };
  }

  private onPointerDown(e: PointerEvent): void {
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
    if (!this.isDrawing || this.isPanningWithSpace) return;

    const pt = this.getPointerCellPoint(e);

    if (this.activeTool === "pen") {
      this.currentStrokePoints = [...this.currentStrokePoints, pt];
    } else if (this.activeTool === "eraser") {
      this.eraseAtPoint(pt);
    }
  }

  private onPointerUp(_e: PointerEvent): void {
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

  private eraseAtPoint(pt: Point): void {
    const eraserRadius = 0.25; // in cells (~12.5px)
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
    // Current in-progress stroke preview (in screen pixels or transformed)
    const cam = fx.map()?.cameras.main;
    const previewD =
      this.activeTool === "pen" && this.currentStrokePoints.length > 0
        ? pointsToQuadraticBezier(this.currentStrokePoints)
        : "";

    // Calculate preview SVG viewBox/transform matching Phaser camera
    const zoom = cam?.zoom ?? 1.0;
    const scrollX = cam?.worldView.x ?? 0;
    const scrollY = cam?.worldView.y ?? 0;

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
            ⌫
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
            : ""}"
          @pointerdown=${this.onPointerDown}
          @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerUp}
          @pointercancel=${this.onPointerUp}
        >
          ${previewD
            ? html`
                <svg class="dndm-markup-preview-svg">
                  <g
                    transform="scale(${zoom}) translate(${-scrollX / 50}, ${-scrollY / 50}) scale(50)"
                    stroke="${this.activeColor}"
                    stroke-width="${this.activeWidth}"
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
