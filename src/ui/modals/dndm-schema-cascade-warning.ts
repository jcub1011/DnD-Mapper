import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";

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
          <h3 class="dndm-modal-title" style="color: var(--dndm-danger);">
            Schema Change Warning
          </h3>

          <div class="dndm-modal-body">
            <p>
              Switching the attribute schema will permanently remove the following attributes
              currently populated on character sheets:
            </p>
            <ul style="margin: 8px 0; padding-left: 20px; color: var(--dndm-ember-hi);">
              ${this.prunedAttributes.map((attr) => html`<li><strong>${attr}</strong></li>`)}
            </ul>
            <p style="font-size: 0.85rem; color: var(--dndm-text-dim);">
              Values stored under these attributes will be discarded. Are you sure you want to proceed?
            </p>
          </div>

          <div class="dndm-modal-actions">
            <button class="dndm-btn" @click=${this.handleCancel}>
              Cancel
            </button>
            <button
              class="dndm-btn dndm-btn--danger"
              @click=${this.handleConfirm}
            >
              Proceed &amp; Prune
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
