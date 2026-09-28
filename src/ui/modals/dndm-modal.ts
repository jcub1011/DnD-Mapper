import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";

/**
 * Standard reusable modal component for DnD-Mapper.
 *
 * Provides consistent display logic across the app:
 * - Native <dialog> with showModal() to ensure rendering in the Top Layer above
 *   all parent stacking contexts, rails, and overflow containers.
 * - Backdrop overlay preventing clicks from reaching underlying elements.
 * - Standard header with modal title and close button (✕).
 * - Scrollable body container for modal content.
 * - Standard footer container for action buttons.
 * - Light-dismiss via backdrop click, close button, or Escape key.
 */
@customElement("dndm-modal")
export class DndmModal extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({
    converter: {
      fromAttribute(value: string | null) {
        return value ?? "";
      },
      toAttribute(value: unknown) {
        return typeof value === "string" ? value : null;
      },
    },
  })
  modalTitle: string | TemplateResult = "";

  @property({ attribute: false })
  body?: TemplateResult | unknown;

  @property({ attribute: false })
  footer?: TemplateResult | unknown;

  @property({ type: String })
  cardClass = "";

  @property({ type: String })
  cardStyle = "";

  @property({ type: Boolean })
  dismissible = true;

  @property({ attribute: false })
  onClose?: () => void;

  @property({ attribute: false })
  onCancel?: () => void;

  protected override firstUpdated(changedProperties: PropertyValues): void {
    super.firstUpdated(changedProperties);
    this.syncDialogState();
  }

  protected override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    if (changedProperties.has("isOpen")) {
      this.syncDialogState();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    const dialog = this.querySelector<HTMLDialogElement>("dialog.dndm-dialog");
    if (dialog && dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
    }
  }

  private syncDialogState(): void {
    const dialog = this.querySelector<HTMLDialogElement>("dialog.dndm-dialog");
    if (!dialog) return;

    if (this.isOpen) {
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") {
          dialog.showModal();
        } else {
          dialog.setAttribute("open", "");
        }
      }
    } else {
      if (dialog.open) {
        if (typeof dialog.close === "function") {
          dialog.close();
        } else {
          dialog.removeAttribute("open");
        }
      }
    }
  }

  public handleClose(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dispatchEvent(new CustomEvent("close", { bubbles: false, composed: false }));
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: false, composed: false }));
    this.onClose?.();
    this.onCancel?.();
  }

  private handleCancel(e: Event): void {
    e.preventDefault();
    if (this.dismissible) {
      this.handleClose();
    }
  }

  private handleDialogClick(e: MouseEvent): void {
    if (!this.dismissible) return;

    // Light-dismiss fallback: if clicking the dialog element or outside card bounding box
    const card = this.querySelector(".dndm-modal-card");
    if (card) {
      const rect = card.getBoundingClientRect();
      const isInside =
        rect.top <= e.clientY &&
        e.clientY <= rect.bottom &&
        rect.left <= e.clientX &&
        e.clientX <= rect.right;
      if (isInside) return;
    }
    this.handleClose();
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.isOpen) return nothing;

    const titleStr = typeof this.modalTitle === "string" ? this.modalTitle : "Modal";

    return html`
      <dialog
        class="dndm-dialog"
        closedby="any"
        @cancel=${this.handleCancel}
        @click=${this.handleDialogClick}
        aria-modal="true"
        aria-label=${titleStr}
      >
        <div
          class="dndm-modal-card ${this.cardClass}"
          style=${this.cardStyle ? this.cardStyle : nothing}
          role="dialog"
          aria-modal="true"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <header class="dndm-modal-header">
            <h3 class="dndm-modal-title">${this.modalTitle}</h3>
            ${
              this.dismissible
                ? html`
                    <button
                      class="dndm-btn dndm-btn--ghost dndm-btn--icon dndm-modal-close-btn"
                      type="button"
                      aria-label="Close"
                      title="Close"
                      @click=${this.handleClose}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        aria-hidden="true"
                      >
                        <path d="M3 3l10 10M13 3L3 13" />
                      </svg>
                    </button>
                  `
                : nothing
            }
          </header>

          <div class="dndm-modal-body">${this.body}</div>

          ${
            this.footer
              ? html` <footer class="dndm-modal-actions dndm-modal-footer">${this.footer}</footer> `
              : nothing
          }
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-modal": DndmModal;
  }
}
