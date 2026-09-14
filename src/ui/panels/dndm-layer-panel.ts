import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AssetSource } from "../../assets/assetSource";
import type { GameMap, MapImage, NewMapImage } from "../../game/domain";
import type { LibraryService } from "../../storage/libraryService";
import { GameElement } from "../app/GameElement";
import { eyeIcon, lockIcon } from "../icons";
import "../upload/dndm-image-upload";

@customElement("dndm-layer-panel")
export class DndmLayerPanel extends GameElement {
  @property({ attribute: false })
  activeMap: GameMap | null = null;

  @property({ type: String })
  selectedImageId: string | null = null;

  @property({ attribute: false })
  assetSource?: AssetSource;

  @property({ attribute: false })
  libraryService?: LibraryService;

  @property({ attribute: false })
  onImageUploaded?: (image: NewMapImage, blob: Blob, imageId: string) => void;

  @property({ attribute: false })
  onSelectImage?: (imageId: string | null) => void;

  @property({ attribute: false })
  onToggleHidden?: (imageId: string, hidden: boolean) => void;

  @property({ attribute: false })
  onToggleLocked?: (imageId: string, locked: boolean) => void;

  @property({ attribute: false })
  onRenameImage?: (imageId: string, name: string) => void;

  @state() private renamingId: string | null = null;
  @state() private renameDraft = "";
  @state() private thumbUrls = new Map<string, string>();

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("activeMap") || changedProperties.has("assetSource")) {
      this.resolveThumbs();
    }
  }

  private async resolveThumbs(): Promise<void> {
    if (!this.activeMap || !this.assetSource) return;
    const urls = new Map<string, string>();
    for (const img of this.activeMap.images) {
      try {
        const url = await this.assetSource.resolve(img.id);
        if (url) urls.set(img.id, url);
      } catch {
        // ignore resolution failure
      }
    }
    this.thumbUrls = urls;
  }

  private handleRowClick(imageId: string): void {
    if (this.renamingId === imageId) return;
    const next = this.selectedImageId === imageId ? null : imageId;
    this.dispatchEvent(
      new CustomEvent<string | null>("select-image", {
        bubbles: true,
        composed: true,
        detail: next,
      }),
    );
    this.onSelectImage?.(next);
  }

  private startRename(img: MapImage, e?: Event): void {
    e?.stopPropagation();
    this.renamingId = img.id;
    this.renameDraft = img.name;
  }

  private commitRename(imgId: string): void {
    if (!this.renamingId) return;
    const nextName = this.renameDraft.trim() || "Untitled Image";
    this.renamingId = null;
    this.dispatchEvent(
      new CustomEvent<{ imageId: string; name: string }>("rename-image", {
        bubbles: true,
        composed: true,
        detail: { imageId: imgId, name: nextName },
      }),
    );
    this.onRenameImage?.(imgId, nextName);
  }

  private handleKeyDown(e: KeyboardEvent, imgId: string): void {
    if (e.key === "Enter") {
      this.commitRename(imgId);
    } else if (e.key === "Escape") {
      this.renamingId = null;
    }
  }

  private toggleHidden(img: MapImage, e: Event): void {
    e.stopPropagation();
    const next = !img.hidden;
    this.dispatchEvent(
      new CustomEvent<{ imageId: string; hidden: boolean }>("toggle-hidden", {
        bubbles: true,
        composed: true,
        detail: { imageId: img.id, hidden: next },
      }),
    );
    this.onToggleHidden?.(img.id, next);
  }

  private toggleLocked(img: MapImage, e: Event): void {
    e.stopPropagation();
    const next = !img.locked;
    this.dispatchEvent(
      new CustomEvent<{ imageId: string; locked: boolean }>("toggle-locked", {
        bubbles: true,
        composed: true,
        detail: { imageId: img.id, locked: next },
      }),
    );
    this.onToggleLocked?.(img.id, next);
  }

  override render(): TemplateResult {
    const images = this.activeMap?.images ?? [];
    const sortedImages = [...images].sort((a, b) => b.layerOrder - a.layerOrder);

    return html`
      <section class="dndm-panel">
        <header class="dndm-panel-header">
          <span>Map Layers</span>
          <dndm-image-upload
            .compact=${true}
            .disabled=${!this.activeMap}
            .libraryService=${this.libraryService}
            .onImageUploaded=${this.onImageUploaded}
          ></dndm-image-upload>
        </header>
        <div class="dndm-panel-body dndm-layers-body">
          ${!this.activeMap
            ? html`<div class="dndm-panel-empty">No active map.</div>`
            : sortedImages.length === 0
              ? html`<div class="dndm-panel-empty">
                  No image layers yet. Use the upload icon above to add one.
                </div>`
              : html`
                  <ul class="dndm-layers-list">
                    ${sortedImages.map((img) => {
                      const isSelected = img.id === this.selectedImageId;
                      const thumbUrl = this.thumbUrls.get(img.id);

                      return html`
                        <li
                          class="dndm-layer-row ${isSelected ? "dndm-layer-row--selected" : ""} ${img.hidden ? "dndm-layer-row--hidden" : ""}"
                        >
                          <div
                            class="dndm-layer-clickarea"
                            @click=${() => this.handleRowClick(img.id)}
                          >
                            ${thumbUrl
                              ? html`<img class="dndm-layer-thumb" src=${thumbUrl} alt=${img.name} />`
                              : html`<div
                                  class="dndm-layer-thumb dndm-layer-thumb--placeholder"
                                  title="Loading texture…"
                                ></div>`}
                            ${this.renamingId === img.id
                              ? html`
                                  <input
                                    class="dndm-input dndm-layer-name-input"
                                    .value=${this.renameDraft}
                                    @input=${(e: Event) => {
                                      this.renameDraft = (e.target as HTMLInputElement).value;
                                    }}
                                    @keydown=${(e: KeyboardEvent) => this.handleKeyDown(e, img.id)}
                                    @blur=${() => this.commitRename(img.id)}
                                    @click=${(e: Event) => e.stopPropagation()}
                                  />
                                `
                              : html`
                                  <span
                                    class="dndm-layer-name"
                                    title="Double-click to rename"
                                    @dblclick=${(e: Event) => this.startRename(img, e)}
                                  >
                                    ${img.name}
                                  </span>
                                  ${img.wasDownscaled
                                    ? html`<span
                                        class="dndm-layer-downscale-badge"
                                        title="Downscaled for performance"
                                        aria-label="Downscaled"
                                      >
                                        ⤓
                                      </span>`
                                    : nothing}
                                `}
                          </div>
                          <button
                            class="dndm-btn dndm-btn--small dndm-btn--icon"
                            type="button"
                            title=${img.hidden ? "Hidden — click to show" : "Visible — click to hide"}
                            @click=${(e: Event) => this.toggleHidden(img, e)}
                          >
                            ${eyeIcon(!img.hidden)}
                          </button>
                          <button
                            class="dndm-btn dndm-btn--small dndm-btn--icon"
                            type="button"
                            title=${img.locked ? "Locked — click to unlock" : "Unlocked — click to lock"}
                            @click=${(e: Event) => this.toggleLocked(img, e)}
                          >
                            ${lockIcon(img.locked)}
                          </button>
                        </li>
                      `;
                    })}
                  </ul>
                `}
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-layer-panel": DndmLayerPanel;
  }
}
