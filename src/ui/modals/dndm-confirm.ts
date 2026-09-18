import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";
import "./dndm-modal";

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

  @property({ attribute: false })
  onClose?: () => void;

  private handleConfirm = (): void => {
    this.isOpen = false;
    this.dispatchEvent(new CustomEvent("confirm", { bubbles: true, composed: true }));
    this.onConfirm?.();
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
        .isOpen=${this.isOpen}
        .modalTitle=${this.modalTitle}
        @close=${this.handleCancel}
        .body=${html`<p class="dndm-modal-message">${this.message}</p>`}
        .footer=${html`
          <button class="dndm-btn dndm-btn--ghost" type="button" @click=${this.handleCancel}>
            ${this.cancelText}
          </button>
          <button class="dndm-btn dndm-btn--danger" type="button" @click=${this.handleConfirm}>
            ${this.confirmText}
          </button>
        `}
      ></dndm-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-confirm": DndmConfirm;
  }
}
