import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";
import { eyeIcon, penIcon } from "../icons";
import { toSafeHtml } from "../panels/markdown";
import "./dndm-modal";

export type NotesTab = "edit" | "preview";

/**
 * Large-format notes editor modal, pinned to a single sheet.
 * Edits are forwarded live through the caller's debounced update path —
 * this component owns no debounce timers itself.
 */
@customElement("dndm-notes-modal")
export class DndmNotesModal extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ type: String })
  sheetName = "";

  @property({ type: String })
  notesValue = "";

  @property({ type: Boolean })
  editable = false;

  @property({ type: String })
  activeTab: NotesTab = "edit";

  @property({ attribute: false })
  onTabChange?: (tab: NotesTab) => void;

  @property({ attribute: false })
  onNotesInput?: (value: string) => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @property({ attribute: false })
  onClose?: () => void;

  private handleTabFlip(): void {
    if (!this.editable) return;
    const next: NotesTab = this.activeTab === "edit" ? "preview" : "edit";
    this.dispatchEvent(
      new CustomEvent<{ tab: NotesTab }>("tab-change", {
        bubbles: true,
        composed: true,
        detail: { tab: next },
      }),
    );
    this.onTabChange?.(next);
  }

  private handleInput(e: Event): void {
    const value = (e.target as HTMLTextAreaElement).value;
    this.dispatchEvent(
      new CustomEvent<{ value: string }>("notes-input", {
        bubbles: true,
        composed: true,
        detail: { value },
      }),
    );
    this.onNotesInput?.(value);
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.onClose?.();
    this.onCancel?.();
  }

  private renderToggle(showingEdit: boolean): TemplateResult {
    return html`
      <button
        class="dndm-btn dndm-btn--subtle dndm-notes-toggle"
        type="button"
        aria-pressed=${showingEdit ? "true" : "false"}
        ?disabled=${!this.editable}
        title=${this.editable
          ? showingEdit
            ? "Switch to markdown preview"
            : "Switch to markdown editor"
          : "Read-only — preview only"}
        @click=${() => this.handleTabFlip()}
      >
        ${showingEdit
          ? html`${eyeIcon(true)}<span>Preview</span>`
          : html`${penIcon()}<span>Edit</span>`}
      </button>
    `;
  }

  override render(): TemplateResult {
    const effectiveTab: NotesTab = this.editable ? this.activeTab : "preview";
    const showingEdit = effectiveTab === "edit";
    return html`
      <dndm-modal
        .isOpen=${this.isOpen}
        .modalTitle=${html`
          <span class="dndm-notes-modal-title-text"
            >${this.sheetName ? `${this.sheetName} — Notes` : "Notes"}</span
          >
          ${this.renderToggle(showingEdit)}
        `}
        cardClass="dndm-notes-modal"
        @close=${() => this.handleClose()}
        @cancel=${() => this.handleClose()}
        .onClose=${() => this.handleClose()}
        .onCancel=${() => this.handleClose()}
        .body=${html`
          ${showingEdit
            ? html`
                <textarea
                  class="dndm-sheet-notes-textarea dndm-notes-modal-textarea"
                  placeholder="Character backstory, inventory, notes (Markdown supported)..."
                  .value=${this.notesValue}
                  ?disabled=${!this.editable}
                  aria-label="Notes markdown editor"
                  @input=${(e: Event) => this.handleInput(e)}
                ></textarea>
              `
            : html`
                <div
                  class="dndm-sheet-notes-preview dndm-notes-modal-preview"
                  .innerHTML=${toSafeHtml(this.notesValue)}
                ></div>
              `}
        `}
      ></dndm-modal>
      ${nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-notes-modal": DndmNotesModal;
  }
}
