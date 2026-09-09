import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CharacterSheet, StatusEffect, StatusEffectTemplate } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import "../modals/dndm-status-effect-library-modal";

@customElement("dndm-status-effects")
export class DndmStatusEffects extends GameElement {
  @property({ attribute: false })
  sheet: CharacterSheet | null = null;

  @property({ type: Boolean })
  editable = false;

  @property({ attribute: false })
  customTemplates: readonly StatusEffectTemplate[] = [];

  @property({ attribute: false })
  onApplyEffect?: (effect: Omit<StatusEffect, "id" | "appliedUtc">) => void;

  @property({ attribute: false })
  onRemoveEffect?: (effectId: string) => void;

  @state() private libraryOpen = false;

  private handleOpenLibrary(): void {
    if (!this.editable) return;
    this.libraryOpen = true;
  }

  private handleApplyTemplate(template: StatusEffectTemplate): void {
    this.libraryOpen = false;
    const effect: Omit<StatusEffect, "id" | "appliedUtc"> = {
      name: template.name,
      attributeDeltas: template.attributeDeltas,
      maxHpDelta: template.maxHpDelta,
      onApplyHpDelta: template.onApplyHpDelta,
      notes: template.notes,
    };
    this.dispatchEvent(
      new CustomEvent<{ effect: Omit<StatusEffect, "id" | "appliedUtc"> }>("apply-effect", {
        bubbles: true,
        composed: true,
        detail: { effect },
      }),
    );
    this.onApplyEffect?.(effect);
  }

  private handleRemove(effectId: string, e: Event): void {
    e.stopPropagation();
    if (!this.editable) return;
    this.dispatchEvent(
      new CustomEvent<{ effectId: string }>("remove-effect", {
        bubbles: true,
        composed: true,
        detail: { effectId },
      }),
    );
    this.onRemoveEffect?.(effectId);
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.sheet) return nothing;

    const effects = this.sheet.statusEffects || [];

    return html`
      <div class="dndm-status-effects-panel">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span class="dndm-sheet-section-title" style="margin: 0;">Status Effects</span>
          ${this.editable
            ? html`
                <button
                  class="dndm-btn dndm-btn--subtle"
                  style="padding: 2px 6px; font-size: 0.75rem;"
                  @click=${this.handleOpenLibrary}
                >
                  + Condition
                </button>
              `
            : nothing}
        </div>

        <div class="dndm-status-effects-list">
          ${effects.length === 0
            ? html`<span style="font-size: 0.8rem; color: var(--dndm-text-muted); font-style: italic;">No active conditions</span>`
            : effects.map((eff) => {
                const deltas: string[] = [];
                if (eff.maxHpDelta != null) {
                  deltas.push(`Max HP ${eff.maxHpDelta >= 0 ? `+${eff.maxHpDelta}` : eff.maxHpDelta}`);
                }
                for (const d of eff.attributeDeltas) {
                  deltas.push(`${d.attributeName} ${d.delta >= 0 ? `+${d.delta}` : d.delta}`);
                }
                const deltaStr = deltas.length > 0 ? ` (${deltas.join(", ")})` : "";

                return html`
                  <span
                    class="dndm-status-badge dndm-status-badge--active"
                    title=${eff.notes ? `${eff.name}: ${eff.notes}` : eff.name}
                  >
                    <span class="dndm-status-badge-name">${eff.name}</span>
                    ${deltaStr ? html`<span class="dndm-status-badge-delta">${deltaStr}</span>` : nothing}
                    ${this.editable
                      ? html`
                          <button
                            class="dndm-status-badge-remove"
                            aria-label="Remove condition"
                            @click=${(e: Event) => this.handleRemove(eff.id, e)}
                          >
                            &times;
                          </button>
                        `
                      : nothing}
                  </span>
                `;
              })}
        </div>
      </div>

      <dndm-status-effect-library-modal
        .isOpen=${this.libraryOpen}
        .customTemplates=${this.customTemplates}
        @apply-effect=${(e: CustomEvent<{ template: StatusEffectTemplate }>) => {
          this.handleApplyTemplate(e.detail.template);
        }}
        @cancel=${() => {
          this.libraryOpen = false;
        }}
      ></dndm-status-effect-library-modal>
    `;
  }
}
