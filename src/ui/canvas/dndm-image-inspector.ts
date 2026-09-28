import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { MapImage } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import "../modals/dndm-confirm";
import "../panels/dndm-collapsible-panel";

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

@customElement("dndm-image-inspector")
export class DndmImageInspector extends GameElement {
  @property({ attribute: false })
  image: MapImage | null = null;

  /** Stacking position of this image, 0 = bottom. */
  @property({ type: Number })
  layerRank = 0;

  /** Number of images on the map. */
  @property({ type: Number })
  layerCount = 1;

  @property({ attribute: false })
  onTransform?: (patch: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  }) => void;

  @property({ attribute: false })
  onReorder?: (layerOrder: number) => void;

  @property({ attribute: false })
  onSetLocked?: (locked: boolean) => void;

  @property({ attribute: false })
  onRemove?: () => void;

  @property({ attribute: false })
  onClose?: () => void;

  @state() private pendingDelete = false;

  private commitTransform(delta: Partial<MapImage>): void {
    if (!this.image) return;
    const next = {
      x: delta.x ?? this.image.x,
      y: delta.y ?? this.image.y,
      width: delta.width ?? this.image.width,
      height: delta.height ?? this.image.height,
      rotation: delta.rotation ?? this.image.rotation,
    };
    this.dispatchEvent(
      new CustomEvent("transform", { bubbles: true, composed: true, detail: next }),
    );
    this.onTransform?.(next);
  }

  private resetAspectRatio(): void {
    if (!this.image || this.image.originalWidth <= 0 || this.image.originalHeight <= 0) return;
    const aspect = this.image.originalWidth / this.image.originalHeight;
    const currentAspect = this.image.width / this.image.height;

    let nextW = this.image.width;
    let nextH = this.image.height;

    if (currentAspect > aspect) {
      nextW = round1(nextH * aspect);
    } else {
      nextH = round1(nextW / aspect);
    }

    this.commitTransform({ width: nextW, height: nextH });
  }

  // onReorder takes a target stacking rank; the reducer renumbers the map.
  private get isTop(): boolean {
    return this.layerRank >= this.layerCount - 1;
  }

  private get isBottom(): boolean {
    return this.layerRank <= 0;
  }

  private handleLayerUp(): void {
    if (!this.image || this.isTop) return;
    this.onReorder?.(this.layerRank + 1);
  }

  private handleLayerDown(): void {
    if (!this.image || this.isBottom) return;
    this.onReorder?.(this.layerRank - 1);
  }

  private handleLayerToFront(): void {
    if (!this.image || this.isTop) return;
    this.onReorder?.(this.layerCount - 1);
  }

  private handleLayerToBack(): void {
    if (!this.image || this.isBottom) return;
    this.onReorder?.(0);
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.image) return nothing;

    const img = this.image;

    return html`
      <dndm-collapsible-panel
        panelTitle="Image Properties"
        panelClass="dndm-imgi"
        .actions=${html`
          <button
            class="dndm-btn dndm-btn--icon dndm-btn--small"
            type="button"
            title="Close inspector"
            @click=${() => this.onClose?.()}
          >
            ×
          </button>
        `}
        .content=${html`
          <div class="dndm-imgi-grid">
            <label class="dndm-imgi-field">
              <span class="dndm-label">X</span>
              <input
                type="number"
                step="0.1"
                class="dndm-input dndm-input--num"
                .value=${String(round1(img.x))}
                @change=${(e: Event) =>
                  this.commitTransform({
                    x: parseFloat((e.target as HTMLInputElement).value) || 0,
                  })}
              />
            </label>
            <label class="dndm-imgi-field">
              <span class="dndm-label">Y</span>
              <input
                type="number"
                step="0.1"
                class="dndm-input dndm-input--num"
                .value=${String(round1(img.y))}
                @change=${(e: Event) =>
                  this.commitTransform({
                    y: parseFloat((e.target as HTMLInputElement).value) || 0,
                  })}
              />
            </label>
            <label class="dndm-imgi-field">
              <span class="dndm-label">Width</span>
              <input
                type="number"
                step="0.1"
                min="0.1"
                class="dndm-input dndm-input--num"
                .value=${String(round1(img.width))}
                @change=${(e: Event) =>
                  this.commitTransform({
                    width: Math.max(0.1, parseFloat((e.target as HTMLInputElement).value) || 1),
                  })}
              />
            </label>
            <label class="dndm-imgi-field">
              <span class="dndm-label">Height</span>
              <input
                type="number"
                step="0.1"
                min="0.1"
                class="dndm-input dndm-input--num"
                .value=${String(round1(img.height))}
                @change=${(e: Event) =>
                  this.commitTransform({
                    height: Math.max(0.1, parseFloat((e.target as HTMLInputElement).value) || 1),
                  })}
              />
            </label>
            <label class="dndm-imgi-field">
              <span class="dndm-label">Rotation</span>
              <input
                type="number"
                step="1"
                class="dndm-input dndm-input--num"
                .value=${String(Math.round(img.rotation))}
                @change=${(e: Event) =>
                  this.commitTransform({
                    rotation: parseFloat((e.target as HTMLInputElement).value) || 0,
                  })}
              />
            </label>
            ${img.originalWidth > 0 && img.originalHeight > 0
              ? html`
                  <button
                    class="dndm-btn dndm-btn--small dndm-imgi-aspect"
                    type="button"
                    title="Restore original aspect ratio"
                    @click=${() => this.resetAspectRatio()}
                  >
                    Reset aspect
                  </button>
                `
              : nothing}
          </div>

          <div class="dndm-imgi-row dndm-imgi-layer">
            <span class="dndm-label">Layer</span>
            <div class="dndm-imgi-layer-controls">
              <button
                class="dndm-btn dndm-btn--icon dndm-btn--small"
                type="button"
                title="Send to back"
                ?disabled=${this.isBottom}
                @click=${() => this.handleLayerToBack()}
              >
                ⤓
              </button>
              <button
                class="dndm-btn dndm-btn--icon dndm-btn--small"
                type="button"
                title="Lower"
                ?disabled=${this.isBottom}
                @click=${() => this.handleLayerDown()}
              >
                ↓
              </button>
              <span class="dndm-imgi-layer-readout" title="Stacking position (1 = bottom)"
                >${this.layerRank + 1} / ${this.layerCount}</span
              >
              <button
                class="dndm-btn dndm-btn--icon dndm-btn--small"
                type="button"
                title="Raise"
                ?disabled=${this.isTop}
                @click=${() => this.handleLayerUp()}
              >
                ↑
              </button>
              <button
                class="dndm-btn dndm-btn--icon dndm-btn--small"
                type="button"
                title="Bring to front"
                ?disabled=${this.isTop}
                @click=${() => this.handleLayerToFront()}
              >
                ⤒
              </button>
            </div>
          </div>

          <label class="dndm-toggle dndm-imgi-row dndm-imgi-lock">
            <span class="dndm-label">Locked</span>
            <input
              type="checkbox"
              ?checked=${img.locked}
              @change=${(e: Event) => this.onSetLocked?.((e.target as HTMLInputElement).checked)}
            />
            <span class="dndm-toggle-track"></span>
          </label>

          <div class="dndm-imgi-actions">
            <button
              class="dndm-btn dndm-btn--danger"
              type="button"
              @click=${() => {
                this.pendingDelete = true;
              }}
            >
              Delete image
            </button>
          </div>
        `}
      ></dndm-collapsible-panel>

      <dndm-confirm
        ?isOpen=${this.pendingDelete}
        modalTitle="Delete image?"
        message="This will remove the image from this map."
        confirmText="Delete"
        .onConfirm=${() => {
          this.pendingDelete = false;
          this.onRemove?.();
        }}
        .onCancel=${() => {
          this.pendingDelete = false;
        }}
        .onClose=${() => {
          this.pendingDelete = false;
        }}
        @cancel=${() => {
          this.pendingDelete = false;
        }}
        @close=${() => {
          this.pendingDelete = false;
        }}
      ></dndm-confirm>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-image-inspector": DndmImageInspector;
  }
}
