import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AttributePreset } from "../../game/domain";
import { GameElement } from "../app/GameElement";

interface PresetOption {
  preset: AttributePreset;
  title: string;
  description: string;
}

const PRESET_OPTIONS: readonly PresetOption[] = [
  {
    preset: "DnD5eCore",
    title: "D&D 5e Core",
    description: "Standard 6 ability scores (STR, DEX, CON, INT, WIS, CHA) with modifiers.",
  },
  {
    preset: "DnD5ePlusCommonSkills",
    title: "D&D 5e + Common Skills",
    description: "Core 6 ability scores plus standard 5e skills (Athletics, Stealth, Perception, etc.).",
  },
  {
    preset: "SimpleD20",
    title: "Simple D20",
    description: "Streamlined ability scores for fast-paced, rules-light d20 games.",
  },
  {
    preset: "Custom",
    title: "Custom Schema",
    description: "Custom user-defined attributes and calculations.",
  },
];

@customElement("dndm-schema-preset-modal")
export class DndmSchemaPresetModal extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ type: String })
  currentPreset: AttributePreset = "DnD5eCore";

  @property({ attribute: false })
  onSelectPreset?: (preset: AttributePreset) => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @state() private selectedPreset: AttributePreset = "DnD5eCore";

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("currentPreset")) {
      this.selectedPreset = this.currentPreset;
    }
  }

  private handleSelect(preset: AttributePreset): void {
    this.selectedPreset = preset;
  }

  private handleApply(): void {
    this.dispatchEvent(
      new CustomEvent<{ preset: AttributePreset }>("select-preset", {
        bubbles: true,
        composed: true,
        detail: { preset: this.selectedPreset },
      }),
    );
    this.onSelectPreset?.(this.selectedPreset);
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
          <h3 class="dndm-modal-title">Attribute Schema Preset</h3>

          <div class="dndm-modal-body" style="display: flex; flex-direction: column; gap: 8px;">
            ${PRESET_OPTIONS.map((opt) => {
              const isCurrent = this.selectedPreset === opt.preset;
              return html`
                <div
                  class="dndm-preset-card"
                  style="
                    padding: 10px;
                    border: 1px solid ${isCurrent ? "var(--dndm-color-accent)" : "var(--dndm-color-border)"};
                    background: ${isCurrent ? "rgba(196, 116, 56, 0.15)" : "var(--dndm-color-surface)"};
                    border-radius: var(--dndm-radius-sm);
                    cursor: pointer;
                  "
                  @click=${() => this.handleSelect(opt.preset)}
                >
                  <div style="font-weight: bold; color: var(--dndm-color-text); margin-bottom: 2px;">
                    ${opt.title}
                  </div>
                  <div style="font-size: 0.8rem; color: var(--dndm-text-dim);">
                    ${opt.description}
                  </div>
                </div>
              `;
            })}
          </div>

          <div class="dndm-modal-actions">
            <button class="dndm-btn" @click=${this.handleCancel}>
              Cancel
            </button>
            <button
              class="dndm-btn dndm-btn--primary"
              @click=${this.handleApply}
            >
              Apply Preset
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
