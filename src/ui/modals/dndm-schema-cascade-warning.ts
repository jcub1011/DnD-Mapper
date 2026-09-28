import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";
import "./dndm-modal";

@customElement("dndm-schema-cascade-warning")
export class DndmSchemaCascadeWarning extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ attribute: false })
  prunedAttributes: readonly string[] = [];

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
        .modalTitle=${html`<span style="color: var(--dndm-danger);">Schema Change Warning</span>`}
        @close=${this.handleCancel}
        .body=${html`
          <p>
            Switching the attribute schema will permanently remove the following attributes
            currently populated on character sheets:
          </p>
          <ul style="margin: 8px 0; padding-left: 20px; color: var(--dndm-ember-hi);">
            ${this.prunedAttributes.map((attr) => html`<li><strong>${attr}</strong></li>`)}
          </ul>
          <p style="font-size: 0.85rem; color: var(--dndm-text-dim);">
            Values stored under these attributes will be discarded. Are you sure you want to
            proceed?
          </p>
        `}
        .footer=${html`
          <button class="dndm-btn dndm-btn--ghost" type="button" @click=${this.handleCancel}>
            Cancel
          </button>
          <button class="dndm-btn dndm-btn--danger" type="button" @click=${this.handleConfirm}>
            Proceed &amp; Prune
          </button>
        `}
      ></dndm-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-schema-cascade-warning": DndmSchemaCascadeWarning;
  }
}
