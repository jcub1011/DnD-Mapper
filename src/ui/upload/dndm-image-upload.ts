import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { decodeAndMaybeDownscale } from "../../assets/imageDownscale";
import type { NewMapImage } from "../../game/domain";
import type { LibraryService } from "../../storage/libraryService";
import { GameElement } from "../app/GameElement";
import { uploadIcon } from "../icons";

@customElement("dndm-image-upload")
export class DndmImageUpload extends GameElement {
  @property({ type: Boolean })
  compact = true;

  @property({ type: Boolean })
  disabled = false;

  @property({ attribute: false })
  libraryService?: LibraryService;

  @property({ attribute: false })
  onImageUploaded?: (image: NewMapImage, blob: Blob) => void;

  @state() private uploading = false;

  private async handleFileChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length === 0) return;

    this.uploading = true;
    try {
      for (const file of files) {
        const decoded = await decodeAndMaybeDownscale(file);
        const id = "img-" + Math.random().toString(36).slice(2, 10);

        if (this.libraryService) {
          await this.libraryService.putImage(id, decoded.blob);
        }

        const widthCells = Math.max(1, Math.round(decoded.widthPx / 50));
        const heightCells = Math.max(1, Math.round(decoded.heightPx / 50));

        const newImage: NewMapImage = {
          name: file.name.replace(/\.[^/.]+$/, ""),
          contentType: decoded.blob.type || "image/png",
          x: 0,
          y: 0,
          width: widthCells,
          height: heightCells,
          originalWidth: decoded.originalWidthPx,
          originalHeight: decoded.originalHeightPx,
          rotation: 0,
          opacity: 1,
          locked: false,
          hidden: false,
          byteSize: decoded.blob.size,
          wasDownscaled: decoded.wasDownscaled,
          originalLongEdgePx: Math.max(decoded.originalWidthPx, decoded.originalHeightPx),
          displayLongEdgePx: Math.max(decoded.widthPx, decoded.heightPx),
        };

        this.dispatchEvent(
          new CustomEvent<{ image: NewMapImage; blob: Blob }>("image-uploaded", {
            bubbles: true,
            composed: true,
            detail: { image: newImage, blob: decoded.blob },
          }),
        );
        this.onImageUploaded?.(newImage, decoded.blob);
      }
    } finally {
      this.uploading = false;
    }
  }

  override render(): TemplateResult {
    if (this.compact) {
      return html`
        <label
          class="dndm-btn dndm-btn--icon dndm-btn--small ${this.disabled || this.uploading
            ? "disabled"
            : ""}"
          title="Upload images (PNG, JPEG, WebP)"
          aria-label="Upload images"
          style="cursor: pointer; position: relative;"
        >
          ${this.uploading ? html`<span>…</span>` : uploadIcon()}
          <input
            type="file"
            style="display: none;"
            accept="image/png,image/jpeg,image/webp"
            multiple
            ?disabled=${this.disabled || this.uploading}
            @change=${this.handleFileChange}
          />
        </label>
      `;
    }

    return html`
      <label
        class="dndm-btn ${this.disabled || this.uploading ? "disabled" : ""}"
        style="cursor: pointer;"
      >
        <span>${this.uploading ? "Uploading…" : "+ Upload Images"}</span>
        <input
          type="file"
          style="display: none;"
          accept="image/png,image/jpeg,image/webp"
          multiple
          ?disabled=${this.disabled || this.uploading}
          @change=${this.handleFileChange}
        />
      </label>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-image-upload": DndmImageUpload;
  }
}
