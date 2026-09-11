import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { MapImage } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import "../modals/dndm-confirm";

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

@customElement("dndm-image-inspector")
export class DndmImageInspector extends GameElement {
  @property({ attribute: false })
  image: MapImage | null = null;

  @property({ type: Number })
  maxLayerOrder = 0;

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

  private handleLayerUp(): void {
    if (!this.image) return;
    const next = this.image.layerOrder + 1;
    this.onReorder?.(next);
  }

  private handleLayerDown(): void {
    if (!this.image) return;
    const next = Math.max(0, this.image.layerOrder - 1);
    this.onReorder?.(next);
  }

  private handleLayerToFront(): void {
    this.onReorder?.(this.maxLayerOrder + 1);
  }

  private handleLayerToBack(): void {
    this.onReorder?.(0);
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.image) return nothing;

    const img = this.image;

    return html`
      <section class="dndm-panel dndm-imgi">
        <header class="dndm-panel-header">
          <span>Image</span>
          <button
            class="dndm-btn dndm-btn--icon dndm-btn--small"
            type="button"
            title="Close inspector"
            @click=${() => this.onClose?.()}
          >
            ×
          </button>
        </header>
        <div class="dndm-panel-body">
          <div class="dndm-imgi-grid">
            <label class="dndm-label">
              X
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
            <label class="dndm-label">
              Y
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
            <label class="dndm-label">
              W
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
            <label class="dndm-label">
              H
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
            <label class="dndm-label">
              Rotation
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
          </div>

          ${img.originalWidth > 0 && img.originalHeight > 0
            ? html`
                <div class="dndm-imgi-aspect">
                  <button
                    class="dndm-btn dndm-btn--small"
                    type="button"
                    title="Restore original aspect ratio"
                    @click=${() => this.resetAspectRatio()}
                  >
                    Reset aspect
                  </button>
                </div>
              `
            : nothing}

          <div class="dndm-imgi-lock">
            <label class="dndm-toggle">
              <input
                type="checkbox"
                ?checked=${img.locked}
                @change=${(e: Event) =>
                  this.onSetLocked?.((e.target as HTMLInputElement).checked)}
              />
              <span class="dndm-toggle-track"></span>
              <span>Locked</span>
            </label>
          </div>

          <div class="dndm-imgi-layer">
            <span class="dndm-label">Layer</span>
            <button
              class="dndm-btn dndm-btn--small"
              type="button"
              title="Send to back"
              @click=${() => this.handleLayerToBack()}
            >
              ⤓
            </button>
            <button
              class="dndm-btn dndm-btn--small"
              type="button"
              title="Lower"
              @click=${() => this.handleLayerDown()}
            >
              ↓
            </button>
            <span class="dndm-imgi-layer-readout">${img.layerOrder}</span>
            <button
              class="dndm-btn dndm-btn--small"
              type="button"
              title="Raise"
              @click=${() => this.handleLayerUp()}
            >
              ↑
            </button>
            <button
              class="dndm-btn dndm-btn--small"
              type="button"
              title="Bring to front"
              @click=${() => this.handleLayerToFront()}
            >
              ⤒
            </button>
          </div>

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
        </div>
      </section>

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
