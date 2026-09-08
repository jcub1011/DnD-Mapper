/**
 * <dndm-vtf-import> Lit web component.
 *
 * Implements legacy VtfImportButton behavior:
 *   - File input accepting .vtf and zip archives
 *   - Drag-and-drop target
 *   - Calls importVtf() streaming reader
 *   - Dispatches 'vtf-imported' on success and 'vtf-error' on failure
 *   - Optionally persists the imported slot to LibraryService when provided
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { LibraryService } from "../../storage/libraryService.js";
import { importVtf } from "../../vtf/import.js";
import type { UnpackResult } from "../../vtf/types.js";
import { GameElement } from "../app/GameElement.js";

export interface VtfImportedDetail {
  readonly result: UnpackResult;
  readonly slotId: string | null;
}

export interface VtfErrorDetail {
  readonly error: Error;
}

@customElement("dndm-vtf-import")
export class DndmVtfImport extends GameElement {
  @property({ attribute: false })
  libraryService?: LibraryService;

  @property({ type: Boolean })
  autoSaveSlot = false;

  @state()
  private importing = false;

  @state()
  private isDragOver = false;

  @state()
  private errorMessage: string | null = null;

  @state()
  private warnings: readonly string[] = [];

  private fileInputRef?: HTMLInputElement;

  private triggerFileInput(): void {
    if (this.importing) return;
    this.errorMessage = null;
    this.fileInputRef?.click();
  }

  private onFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void this.processFile(file);
    }
    // Reset so selecting the same file again still fires change
    input.value = "";
  }

  private onDragOver(e: DragEvent): void {
    e.preventDefault();
    if (this.importing) return;
    this.isDragOver = true;
  }

  private onDragLeave(e: DragEvent): void {
    e.preventDefault();
    this.isDragOver = false;
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    this.isDragOver = false;
    if (this.importing) return;

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      void this.processFile(file);
    }
  }

  public async processFile(file: Blob): Promise<UnpackResult | null> {
    this.importing = true;
    this.errorMessage = null;
    this.warnings = [];

    try {
      const result = await importVtf(file);
      this.warnings = result.warnings;

      let slotId: string | null = null;
      if (this.autoSaveSlot && this.libraryService) {
        slotId = await this.libraryService.importSlot(result);
      }

      this.dispatchEvent(
        new CustomEvent<VtfImportedDetail>("vtf-imported", {
          bubbles: true,
          composed: true,
          detail: { result, slotId },
        }),
      );

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.errorMessage = error.message;

      this.dispatchEvent(
        new CustomEvent<VtfErrorDetail>("vtf-error", {
          bubbles: true,
          composed: true,
          detail: { error },
        }),
      );

      return null;
    } finally {
      this.importing = false;
    }
  }

  override render(): TemplateResult {
    return html`
      <div
        class="dndm-vtf-import-zone ${this.isDragOver ? "is-drag-over" : ""}"
        @dragover=${this.onDragOver}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}
      >
        <input
          type="file"
          accept=".vtf,.zip,application/zip,application/x-zip-compressed,application/octet-stream"
          style="display: none"
          @change=${this.onFileChange}
          ${(el?: Element) => {
            if (el instanceof HTMLInputElement) this.fileInputRef = el;
          }}
        />

        <button
          type="button"
          class="dndm-btn dndm-btn--primary"
          ?disabled=${this.importing}
          @click=${this.triggerFileInput}
        >
          ${this.importing ? "Importing .vtf…" : "Import .vtf"}
        </button>

        ${
          this.errorMessage
            ? html`<div
                class="dndm-import-error"
                style="color: var(--dndm-danger, #b04a3a); margin-top: 6px; font-size: 0.85em;"
              >
                ${this.errorMessage}
              </div>`
            : nothing
        }
        ${
          this.warnings.length > 0
            ? html`<ul
                class="dndm-import-warnings"
                style="color: var(--dndm-gold, #8b6a3a); margin-top: 6px; font-size: 0.8em;"
              >
                ${this.warnings.map((w) => html`<li>${w}</li>`)}
              </ul>`
            : nothing
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-vtf-import": DndmVtfImport;
  }
}
