import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";
import {
  centerTargetIcon,
  closeIcon,
  focusRectIcon,
  fogClearIcon,
  fogEraseIcon,
  fogFillIcon,
  fogPaintIcon,
  penIcon,
  resetViewIcon,
  rulerIcon,
  zoomInIcon,
  zoomOutIcon,
} from "../icons";
import type { ToolMode } from "../map/MapScene";

@customElement("dndm-toolbar")
export class DndmToolbar extends GameElement {
  @property({ type: Boolean })
  isDm = false;

  @property({ type: Number })
  zoom = 1.0;

  @property({ type: Boolean })
  showGridLines = true;

  @property({ type: String })
  toolMode: ToolMode = "none";

  @property({ type: String })
  fogBrushMode: "paint" | "erase" = "paint";

  @property({ type: Number })
  fogBrushRadius = 1;

  @property({ type: Boolean })
  hasFocusRect = false;

  @property({ attribute: false })
  onToggleGrid?: (show: boolean) => void;

  @property({ attribute: false })
  onZoomIn?: () => void;

  @property({ attribute: false })
  onZoomOut?: () => void;

  @property({ attribute: false })
  onResetView?: () => void;

  @property({ attribute: false })
  onSetToolMode?: (mode: ToolMode) => void;

  @property({ attribute: false })
  onSetFogBrushMode?: (mode: "paint" | "erase") => void;

  @property({ attribute: false })
  onCycleBrushRadius?: () => void;

  @property({ attribute: false })
  onFillFog?: () => void;

  @property({ attribute: false })
  onClearFog?: () => void;

  @property({ attribute: false })
  onClearFocusRect?: () => void;

  @property({ attribute: false })
  onCenterEveryone?: () => void;

  private toggleFocus(): void {
    const next: ToolMode = this.toolMode === "focus" ? "none" : "focus";
    this.onSetToolMode?.(next);
  }

  private toggleMarkup(): void {
    const next: ToolMode = this.toolMode === "markup" ? "none" : "markup";
    this.onSetToolMode?.(next);
  }

  private toggleRuler(): void {
    const next: ToolMode = this.toolMode === "ruler" ? "none" : "ruler";
    this.onSetToolMode?.(next);
  }

  private selectFogPaint(): void {
    if (this.toolMode === "fog" && this.fogBrushMode === "paint") {
      this.onSetToolMode?.("none");
    } else {
      this.onSetFogBrushMode?.("paint");
      this.onSetToolMode?.("fog");
    }
  }

  private selectFogErase(): void {
    if (this.toolMode === "fog" && this.fogBrushMode === "erase") {
      this.onSetToolMode?.("none");
    } else {
      this.onSetFogBrushMode?.("erase");
      this.onSetToolMode?.("fog");
    }
  }

  /**
   * Mouse-clicking a tool leaves keyboard focus on the button, so a later
   * Space-to-pan would re-activate the focused button and toggle the tool
   * back off. Drop focus so Space pans instead. (Keyboard users who Tab to
   * a button and press Space still get normal button activation.)
   */
  private blurToolControl(e: Event): void {
    const control = (e.target as Element | null)?.closest?.("button, input");
    (control as HTMLElement | null)?.blur?.();
  }

  override render(): TemplateResult {
    const pct = Math.round(this.zoom * 100);

    return html`
      <div
        class="dndm-canvas-toolbar"
        role="toolbar"
        aria-label="Map tools"
        @click=${this.blurToolControl}
      >
        <label class="dndm-grid-toggle" title="Toggle grid lines">
          <input
            type="checkbox"
            ?checked=${this.showGridLines}
            @change=${(e: Event) =>
              this.onToggleGrid?.((e.target as HTMLInputElement).checked)}
          />
          Grid
        </label>

        <button
          class="dndm-zoom-btn"
          type="button"
          title="Zoom out"
          @click=${() => this.onZoomOut?.()}
        >
          ${zoomOutIcon()}
        </button>
        <span class="dndm-zoom-readout">${pct}%</span>
        <button
          class="dndm-zoom-btn"
          type="button"
          title="Zoom in"
          @click=${() => this.onZoomIn?.()}
        >
          ${zoomInIcon()}
        </button>
        <button
          class="dndm-zoom-btn"
          type="button"
          title="Reset view"
          @click=${() => this.onResetView?.()}
        >
          ${resetViewIcon()}
        </button>

        ${this.isDm
          ? html`
              <span class="dndm-toolbar-sep" aria-hidden="true"></span>

              <button
                class="dndm-zoom-btn ${this.toolMode === "markup" ? "active" : ""}"
                type="button"
                title="Markup — draw freehand vector lines and notes on the map"
                @click=${() => this.toggleMarkup()}
              >
                ${penIcon()}
              </button>

              <button
                class="dndm-zoom-btn ${this.toolMode === "focus" ? "active" : ""}"
                type="button"
                title="Focus box — drag on the map to define a focus region"
                @click=${() => this.toggleFocus()}
              >
                ${focusRectIcon()}
              </button>
              ${this.hasFocusRect
                ? html`
                    <button
                      class="dndm-zoom-btn"
                      type="button"
                      title="Clear focus box"
                      @click=${() => this.onClearFocusRect?.()}
                    >
                      ${closeIcon()}
                    </button>
                  `
                : nothing}

              <button
                class="dndm-zoom-btn ${this.toolMode === "ruler" ? "active" : ""}"
                type="button"
                title="Ruler — click two points to measure distance; right-click clears"
                @click=${() => this.toggleRuler()}
              >
                ${rulerIcon()}
              </button>

              <span class="dndm-toolbar-sep" aria-hidden="true"></span>

              <button
                class="dndm-zoom-btn ${this.toolMode === "fog" && this.fogBrushMode === "paint"
                  ? "active"
                  : ""}"
                type="button"
                title="Paint fog — drag on the map to hide cells (tokens on fogged cells are hidden from players except their owners)"
                @click=${() => this.selectFogPaint()}
              >
                ${fogPaintIcon()}
              </button>
              <button
                class="dndm-zoom-btn ${this.toolMode === "fog" && this.fogBrushMode === "erase"
                  ? "active"
                  : ""}"
                type="button"
                title="Erase fog — drag on the map to reveal cells"
                @click=${() => this.selectFogErase()}
              >
                ${fogEraseIcon()}
              </button>
              <button
                class="dndm-zoom-btn"
                type="button"
                title="Brush radius (click to cycle 1 → 2 → 3)"
                @click=${() => this.onCycleBrushRadius?.()}
              >
                ${this.fogBrushRadius}
              </button>
              <button
                class="dndm-zoom-btn"
                type="button"
                title="Fill the entire map with fog"
                @click=${() => this.onFillFog?.()}
              >
                ${fogFillIcon()}
              </button>
              <button
                class="dndm-zoom-btn"
                type="button"
                title="Clear all fog"
                @click=${() => this.onClearFog?.()}
              >
                ${fogClearIcon()}
              </button>

              <span class="dndm-toolbar-sep" aria-hidden="true"></span>

              <button
                class="dndm-zoom-btn"
                type="button"
                title="Center all players on current view"
                @click=${() => this.onCenterEveryone?.()}
              >
                ${centerTargetIcon()}
              </button>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-toolbar": DndmToolbar;
  }
}
