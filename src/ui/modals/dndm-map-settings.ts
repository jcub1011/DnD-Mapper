import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameMap, GridConfig, MapSummary } from "../../game/domain";
import { isFullMap } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import "./dndm-modal";

@customElement("dndm-map-settings")
export class DndmMapSettings extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ attribute: false })
  map: GameMap | MapSummary | null = null;

  @property({ attribute: false })
  onSave?: (grid: GridConfig) => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @property({ attribute: false })
  onClose?: () => void;

  @state() private width = 30;
  @state() private height = 20;
  @state() private cellPixels = 50;
  @state() private snap = true;
  @state() private showGrid = true;
  @state() private lineColor = "#222";
  @state() private error: string | null = null;

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("map") && this.map) {
      if (isFullMap(this.map)) {
        this.width = this.map.grid.widthCells;
        this.height = this.map.grid.heightCells;
        this.cellPixels = this.map.grid.cellPixels;
        this.snap = this.map.grid.snapToGrid;
        this.showGrid = this.map.grid.showGridLines;
        this.lineColor = this.map.grid.lineColor ?? "#222";
      } else {
        this.width = this.map.widthCells;
        this.height = this.map.heightCells;
        this.cellPixels = 50;
        this.snap = true;
        this.showGrid = true;
        this.lineColor = "#222";
      }
      this.error = null;
    }
  }

  private handleSave = (): void => {
    if (this.width < 1 || this.height < 1) {
      this.error = "Width and height must be at least 1 cell.";
      return;
    }
    if (this.cellPixels < 1) {
      this.error = "Cell size must be at least 1 pixel.";
      return;
    }

    const grid: GridConfig = {
      widthCells: this.width,
      heightCells: this.height,
      cellPixels: this.cellPixels,
      showGridLines: this.showGrid,
      snapToGrid: this.snap,
      lineColor: this.lineColor,
    };

    this.isOpen = false;
    this.dispatchEvent(
      new CustomEvent<GridConfig>("save", {
        bubbles: true,
        composed: true,
        detail: grid,
      }),
    );
    this.onSave?.(grid);
  };

  private handleCancel = (): void => {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    this.onCancel?.();
    this.onClose?.();
  };

  override render(): TemplateResult {
    return html`
      <dndm-modal
        .isOpen=${this.isOpen && !!this.map}
        .modalTitle=${this.map ? `Map settings — ${this.map.name}` : "Map settings"}
        @close=${this.handleCancel}
        .body=${html`
          <div class="dndm-mapsettings">
            <label class="dndm-label">
              Width (cells)
              <input
                type="number"
                min="1"
                max="1000"
                class="dndm-input dndm-input--num"
                .value=${String(this.width)}
                @change=${(e: Event) => {
                  this.width = parseInt((e.target as HTMLInputElement).value, 10) || 1;
                }}
              />
            </label>

            <label class="dndm-label">
              Height (cells)
              <input
                type="number"
                min="1"
                max="1000"
                class="dndm-input dndm-input--num"
                .value=${String(this.height)}
                @change=${(e: Event) => {
                  this.height = parseInt((e.target as HTMLInputElement).value, 10) || 1;
                }}
              />
            </label>

            <label class="dndm-label">
              Cell size (pixels)
              <input
                type="number"
                min="1"
                max="1000"
                class="dndm-input dndm-input--num"
                .value=${String(this.cellPixels)}
                @change=${(e: Event) => {
                  this.cellPixels = parseInt((e.target as HTMLInputElement).value, 10) || 50;
                }}
              />
            </label>

            <label class="dndm-label dndm-mapsettings-check">
              <input
                type="checkbox"
                ?checked=${this.snap}
                @change=${(e: Event) => {
                  this.snap = (e.target as HTMLInputElement).checked;
                }}
              />
              Snap tokens to grid
            </label>

            <label class="dndm-label dndm-mapsettings-check">
              <input
                type="checkbox"
                ?checked=${this.showGrid}
                @change=${(e: Event) => {
                  this.showGrid = (e.target as HTMLInputElement).checked;
                }}
              />
              Show grid lines
            </label>

            ${this.error ? html`<div class="dndm-modal-error">${this.error}</div>` : nothing}

            <div class="dndm-mapsettings-hint">
              Shrinking the grid will keep any tokens that fall outside the new bounds by snapping
              them to the nearest in-bounds cell. Images are not moved.
            </div>
          </div>
        `}
        .footer=${html`
          <button class="dndm-btn dndm-btn--ghost" type="button" @click=${this.handleCancel}>
            Cancel
          </button>
          <button class="dndm-btn dndm-btn--primary" type="button" @click=${this.handleSave}>
            Save
          </button>
        `}
      ></dndm-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-map-settings": DndmMapSettings;
  }
}
