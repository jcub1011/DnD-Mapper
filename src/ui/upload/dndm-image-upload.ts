import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { decodeAndMaybeDownscale } from "../../assets/imageDownscale";
import { probeMaxTextureSize } from "../../assets/textureSize";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_ROOM_STORAGE_BYTES,
  type NewMapImage,
} from "../../game/domain";
import { StorageQuotaError } from "../../storage/db";
import type { LibraryService } from "../../storage/libraryService";
import { GameElement } from "../app/GameElement";
import { uploadIcon } from "../icons";
import { toastService } from "../toast/toastService";

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function isAllowedImageType(file: File): boolean {
  if (ALLOWED_MIME_TYPES.has(file.type.toLowerCase())) return true;
  const dot = file.name.lastIndexOf(".");
  if (dot >= 0) {
    const ext = file.name.slice(dot).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

@customElement("dndm-image-upload")
export class DndmImageUpload extends GameElement {
  @property({ type: Boolean })
  compact = true;

  @property({ type: Boolean })
  disabled = false;

  @property({ attribute: false })
  libraryService?: LibraryService;

  @property({ attribute: false })
  onImageUploaded?: (image: NewMapImage, blob: Blob, imageId: string) => void;

  @state() private uploading = false;
  @state() private isDragOver = false;

  public async processFiles(files: File[]): Promise<void> {
    if (files.length === 0 || this.disabled || this.uploading) return;

    this.uploading = true;
    try {
      let currentBytesUsed = (await this.libraryService?.getBytesUsed()) ?? 0;

      for (const file of files) {
        // 1. MIME / extension check
        if (!isAllowedImageType(file)) {
          toastService.error(
            `Unsupported format for "${file.name}". Only PNG, JPEG, and WebP are supported.`,
          );
          continue;
        }

        // 2. Per-file size cap (100 MB)
        if (file.size > MAX_FILE_SIZE_BYTES) {
          const mb = (file.size / (1024 * 1024)).toFixed(1);
          toastService.error(`File "${file.name}" (${mb} MB) exceeds the 100 MB per-file limit.`);
          continue;
        }

        // 3. Room aggregate storage cap (1 GB)
        if (currentBytesUsed + file.size > MAX_ROOM_STORAGE_BYTES) {
          toastService.error(
            `Room storage quota (1 GB) exceeded. Cannot upload "${file.name}".`,
          );
          break;
        }

        // 4. Downscale if exceeding GPU MAX_TEXTURE_SIZE
        const maxLongEdge = probeMaxTextureSize();
        const decoded = await decodeAndMaybeDownscale(file, maxLongEdge);

        const imageId =
          typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID()
            : `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        // 5. Store image blob in IndexedDB
        if (this.libraryService) {
          try {
            await this.libraryService.putImage(imageId, decoded.blob);
            currentBytesUsed += decoded.blob.size;
          } catch (err: unknown) {
            if (
              err instanceof StorageQuotaError ||
              (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "QuotaExceededError")
            ) {
              toastService.error(
                "Storage quota exceeded. The browser cannot store additional campaign data or images.",
              );
              break;
            }
            throw err;
          }
        }

        // Grid cell calculations (corner-anchored, 50 px default cells)
        const widthCells = Math.max(1, Math.round(decoded.originalWidthPx / 50));
        const heightCells = Math.max(1, Math.round(decoded.originalHeightPx / 50));

        const newImage: NewMapImage = {
          name: file.name.replace(/\.[^/.]+$/, ""),
          contentType: decoded.blob.type || "image/webp",
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
          new CustomEvent<{ image: NewMapImage; blob: Blob; imageId: string }>("image-uploaded", {
            bubbles: true,
            composed: true,
            detail: { image: newImage, blob: decoded.blob, imageId },
          }),
        );
        this.onImageUploaded?.(newImage, decoded.blob, imageId);
      }
    } finally {
      this.uploading = false;
    }
  }

  private async handleFileChange(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await this.processFiles(files);
  }

  private onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!this.disabled && !this.uploading) {
      this.isDragOver = true;
    }
  };

  private onDragLeave = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.isDragOver = false;
  };

  private onDrop = async (e: DragEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    this.isDragOver = false;
    if (this.disabled || this.uploading || !e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files);
    await this.processFiles(files);
  };

  override render(): TemplateResult {
    const dragClass = this.isDragOver ? "dndm-upload--dragover" : "";

    if (this.compact) {
      return html`
        <label
          class="dndm-btn dndm-btn--icon dndm-btn--small ${dragClass} ${this.disabled || this.uploading
            ? "disabled"
            : ""}"
          title="Upload images (PNG, JPEG, WebP, max 100MB)"
          aria-label="Upload images"
          style="cursor: pointer; position: relative;"
          @dragover=${this.onDragOver}
          @dragleave=${this.onDragLeave}
          @drop=${this.onDrop}
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
        class="dndm-btn ${dragClass} ${this.disabled || this.uploading ? "disabled" : ""}"
        style="cursor: pointer;"
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
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
