import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";

@customElement("dndm-confirm")
export class DndmConfirm extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ type: String })
  modalTitle = "Confirm";

  @property({ type: String })
  message = "Are you sure?";

  @property({ type: String })
  confirmText = "Confirm";

  @property({ type: String })
  cancelText = "Cancel";

  @property({ attribute: false })
  onConfirm?: () => void;

  @property({ attribute: false })
  onCancel?: () => void;

  private handleConfirm(): void {
    this.dispatchEvent(new CustomEvent("confirm", { bubbles: true, composed: true }));
    this.onConfirm?.();
  }

  private handleCancel(): void {
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.onCancel?.();
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.isOpen) return nothing;

    return html`
      <div class="dndm-modal-overlay" @click=${this.handleCancel}>
        <div
          class="dndm-modal-card"
          role="dialog"
          aria-modal="true"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <h3 class="dndm-modal-title">${this.modalTitle}</h3>
          <p class="dndm-modal-message">${this.message}</p>
          <div class="dndm-modal-actions">
            <button class="dndm-btn dndm-btn--ghost" type="button" @click=${this.handleCancel}>
              ${this.cancelText}
            </button>
            <button class="dndm-btn dndm-btn--danger" type="button" @click=${this.handleConfirm}>
              ${this.confirmText}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-confirm": DndmConfirm;
  }
}
