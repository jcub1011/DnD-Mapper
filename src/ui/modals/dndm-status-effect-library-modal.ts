import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { StatusEffectTemplate } from "../../game/domain";
import { STANDARD_STATUS_EFFECT_TEMPLATES } from "../../game/domain";
import { GameElement } from "../app/GameElement";

@customElement("dndm-status-effect-library-modal")
export class DndmStatusEffectLibraryModal extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ attribute: false })
  customTemplates: readonly StatusEffectTemplate[] = [];

  @property({ attribute: false })
  onApply?: (template: StatusEffectTemplate) => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @state() private search = "";
  @state() private selectedTemplateId: string | null = null;

  private handleSelect(template: StatusEffectTemplate): void {
    this.selectedTemplateId = template.id;
  }

  private handleApply(): void {
    const allTemplates = [...STANDARD_STATUS_EFFECT_TEMPLATES, ...this.customTemplates];
    const selected = allTemplates.find((t) => t.id === this.selectedTemplateId);
    if (!selected) return;

    this.dispatchEvent(
      new CustomEvent<{ template: StatusEffectTemplate }>("apply-effect", {
        bubbles: true,
        composed: true,
        detail: { template: selected },
      }),
    );
    this.onApply?.(selected);
  }

  private handleCancel(): void {
    this.selectedTemplateId = null;
    this.search = "";
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.onCancel?.();
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.isOpen) return nothing;

    const allTemplates = [...STANDARD_STATUS_EFFECT_TEMPLATES, ...this.customTemplates];
    const query = this.search.toLowerCase().trim();
    const filtered = query
      ? allTemplates.filter(
          (t) =>
            t.name.toLowerCase().includes(query) ||
            t.notes.toLowerCase().includes(query),
        )
      : allTemplates;

    const selected = allTemplates.find((t) => t.id === this.selectedTemplateId);

    return html`
      <div class="dndm-modal-overlay" @click=${this.handleCancel}>
        <div
          class="dndm-modal-card"
          role="dialog"
          aria-modal="true"
          style="max-width: 540px; width: 90%;"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <h3 class="dndm-modal-title">Status Effects &amp; Conditions</h3>

          <div class="dndm-modal-body" style="display: flex; flex-direction: column; gap: 8px;">
            <input
              type="text"
              class="dndm-input"
              placeholder="Search conditions..."
              .value=${this.search}
              @input=${(e: Event) => {
                this.search = (e.target as HTMLInputElement).value;
              }}
            />

            <div class="dndm-effect-library-grid">
              ${filtered.map((t) => {
                const isSelected = this.selectedTemplateId === t.id;
                return html`
                  <div
                    class="dndm-effect-template-card ${isSelected ? "dndm-effect-template-card--selected" : ""}"
                    @click=${() => this.handleSelect(t)}
                  >
                    <div class="dndm-effect-template-title">${t.name}</div>
                    <div class="dndm-effect-template-notes">${t.notes}</div>
                    ${t.maxHpDelta != null
                      ? html`<div style="font-size: 0.7rem; color: var(--dndm-color-accent);">Max HP: ${t.maxHpDelta >= 0 ? `+${t.maxHpDelta}` : t.maxHpDelta}</div>`
                      : nothing}
                    ${t.onApplyHpDelta != null
                      ? html`<div style="font-size: 0.7rem; color: var(--dndm-color-crimson);">On Apply HP: ${t.onApplyHpDelta >= 0 ? `+${t.onApplyHpDelta}` : t.onApplyHpDelta}</div>`
                      : nothing}
                  </div>
                `;
              })}
            </div>

            ${selected
              ? html`
                  <div style="padding: 6px 8px; background: var(--dndm-color-surface-sunken); border-radius: var(--dndm-radius-sm); font-size: 0.8rem; border-left: 3px solid var(--dndm-color-accent);">
                    <strong>${selected.name}:</strong> ${selected.notes}
                  </div>
                `
              : nothing}
          </div>

          <div class="dndm-modal-actions">
            <button class="dndm-btn" @click=${this.handleCancel}>
              Cancel
            </button>
            <button
              class="dndm-btn dndm-btn--primary"
              ?disabled=${!selected}
              @click=${this.handleApply}
            >
              Apply Condition
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
