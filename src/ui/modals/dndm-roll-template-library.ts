import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { BUILTIN_ROLL_TEMPLATES, formatDiceFormula } from "../../game/dice.js";
import type {
  CharacterSheet,
  DiceTerm,
  DndMapperState,
  RollMode,
  RollTemplate,
  RollTemplateScope,
} from "../../game/domain.js";
import { GameElement } from "../app/GameElement.js";
import "./dndm-modal.js";

const DIE_SIZES = [4, 6, 8, 10, 12, 20, 100] as const;

@customElement("dndm-roll-template-library")
export class DndmRollTemplateLibrary extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ attribute: false })
  state!: DndMapperState;

  @property({ type: String })
  sheetId: string | null = null;

  @property({ type: Boolean })
  isDm = false;

  @property({ type: String })
  currentUserId: string | null = null;

  @property({ attribute: false })
  onCreateGlobalTemplate?: (template: Omit<RollTemplate, "id" | "scope">) => void;

  @property({ attribute: false })
  onUpdateGlobalTemplate?: (
    templateId: string,
    patch: Partial<Omit<RollTemplate, "id" | "scope">>,
  ) => void;

  @property({ attribute: false })
  onDeleteGlobalTemplate?: (templateId: string) => void;

  @property({ attribute: false })
  onCreateSheetTemplate?: (sheetId: string, template: Omit<RollTemplate, "id" | "scope">) => void;

  @property({ attribute: false })
  onUpdateSheetTemplate?: (
    sheetId: string,
    templateId: string,
    patch: Partial<Omit<RollTemplate, "id" | "scope">>,
  ) => void;

  @property({ attribute: false })
  onDeleteSheetTemplate?: (sheetId: string, templateId: string) => void;

  @property({ attribute: false })
  onClose?: () => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @state() private editingId: string | null = null;
  @state() private editName = "";
  @state() private editDice: DiceTerm[] = [{ count: 1, sides: 20 }];
  @state() private editFlat = 0;
  @state() private editMode: RollMode = "Normal";
  @state() private editAttr: string | null = null;
  @state() private editLabel = "";

  @state() private newGlobalName = "";
  @state() private newSheetName = "";

  private get currentSheet(): CharacterSheet | null {
    if (this.sheetId && this.state.sheets[this.sheetId]) {
      return this.state.sheets[this.sheetId];
    }
    return null;
  }

  private get canEditSheet(): boolean {
    const s = this.currentSheet;
    return s !== null && (this.isDm || s.ownerUserId === this.currentUserId);
  }

  private startEdit(t: RollTemplate): void {
    this.editingId = t.id;
    this.editName = t.name;
    this.editDice = t.dice.length > 0 ? [...t.dice] : [{ count: 1, sides: 20 }];
    this.editFlat = t.flatModifier;
    this.editMode = t.mode;
    this.editAttr = t.attributeName;
    this.editLabel = t.label;
  }

  private cancelEdit = (): void => {
    this.editingId = null;
  };

  private handleClose = (): void => {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.editingId = null;
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.onClose?.();
    this.onCancel?.();
  };

  private saveEdit(scope: RollTemplateScope, templateId: string): void {
    const patch: Partial<Omit<RollTemplate, "id" | "scope">> = {
      name: this.editName.trim() || "Template",
      dice: this.editDice.filter((d) => d.count > 0),
      flatModifier: this.editFlat,
      mode: this.editMode,
      attributeName: this.editAttr || null,
      label: this.editLabel.trim() || this.editName.trim(),
    };

    if (scope === "Global") {
      this.onUpdateGlobalTemplate?.(templateId, patch);
    } else if (scope === "Sheet" && this.sheetId) {
      this.onUpdateSheetTemplate?.(this.sheetId, templateId, patch);
    }

    this.editingId = null;
  }

  private handleCreateGlobal(): void {
    const name = this.newGlobalName.trim();
    if (!name) return;
    this.onCreateGlobalTemplate?.({
      name,
      dice: [{ count: 1, sides: 20 }],
      flatModifier: 0,
      mode: "Normal",
      attributeName: null,
      label: name,
    });
    this.newGlobalName = "";
  }

  private handleCreateSheet(): void {
    const name = this.newSheetName.trim();
    if (!name || !this.sheetId) return;
    this.onCreateSheetTemplate?.(this.sheetId, {
      name,
      dice: [{ count: 1, sides: 20 }],
      flatModifier: 0,
      mode: "Normal",
      attributeName: null,
      label: name,
    });
    this.newSheetName = "";
  }

  private summarize(t: RollTemplate): string {
    const dice = formatDiceFormula(t.dice, t.flatModifier);
    const attr = t.attributeName ? ` +${t.attributeName}` : "";
    const mode = t.mode === "Advantage" ? " (ADV)" : t.mode === "Disadvantage" ? " (DIS)" : "";
    return `${dice}${attr}${mode}`;
  }

  override render(): TemplateResult {
    const sheet = this.currentSheet;
    const globalTemplates = this.state.globalRollTemplates ?? [];
    const sheetTemplates = sheet?.rollTemplates ?? [];

    return html`
      <dndm-modal
        class="dndm-roll-library-modal"
        cardClass="dndm-roll-library-modal"
        .isOpen=${this.isOpen}
        .modalTitle=${"Roll Template Library"}
        @close=${this.handleClose}
        .body=${html`
          <!-- Built-in section -->
          <section class="dndm-roll-library-section">
            <h4 class="dndm-roll-library-section-title">Built-in Templates</h4>
            <div class="dndm-dice-quick-row">
              ${BUILTIN_ROLL_TEMPLATES.map(
                (t) => html`
                  <span class="dndm-btn dndm-btn--small" title=${this.summarize(t)}>
                    ${t.name}
                  </span>
                `,
              )}
            </div>
          </section>

          <!-- Global templates section -->
          <section class="dndm-roll-library-section">
            <h4 class="dndm-roll-library-section-title">Global Templates (Campaign)</h4>
            ${
              globalTemplates.length === 0
                ? html`<div class="dndm-panel-empty">No global templates yet.</div>`
                : globalTemplates.map((t) => this.renderTemplateRow(t, "Global", this.isDm))
            }
            ${
              this.isDm
                ? html`
                    <div style="display:flex;gap:0.4rem;margin-top:0.4rem;">
                      <input
                        class="dndm-input"
                        placeholder="Template name (e.g. Fireball)"
                        .value=${this.newGlobalName}
                        @input=${(e: Event) =>
                        (this.newGlobalName = (e.target as HTMLInputElement).value)}
                        @keydown=${(e: KeyboardEvent) => {
                        if (e.key === "Enter") this.handleCreateGlobal();
                      }}
                      />
                      <button
                        class="dndm-btn dndm-btn--small dndm-btn--primary"
                        type="button"
                        ?disabled=${!this.newGlobalName.trim()}
                        @click=${() => this.handleCreateGlobal()}
                      >
                        Create
                      </button>
                    </div>
                  `
                : nothing
            }
          </section>

          <!-- Sheet-specific templates section -->
          <section class="dndm-roll-library-section">
            <h4 class="dndm-roll-library-section-title">
              ${sheet ? `Templates for ${sheet.characterName || "Sheet"}` : "Sheet Templates"}
            </h4>
            ${
              !sheet
                ? html`<div class="dndm-panel-empty">No character sheet assigned.</div>`
                : sheetTemplates.length === 0
                  ? html`<div class="dndm-panel-empty">No templates for this sheet yet.</div>`
                  : sheetTemplates.map((t) => this.renderTemplateRow(t, "Sheet", this.canEditSheet))
            }
            ${
              this.canEditSheet
                ? html`
                    <div style="display:flex;gap:0.4rem;margin-top:0.4rem;">
                      <input
                        class="dndm-input"
                        placeholder="Template name (e.g. Greatsword Attack)"
                        .value=${this.newSheetName}
                        @input=${(e: Event) =>
                        (this.newSheetName = (e.target as HTMLInputElement).value)}
                        @keydown=${(e: KeyboardEvent) => {
                        if (e.key === "Enter") this.handleCreateSheet();
                      }}
                      />
                      <button
                        class="dndm-btn dndm-btn--small dndm-btn--primary"
                        type="button"
                        ?disabled=${!this.newSheetName.trim()}
                        @click=${() => this.handleCreateSheet()}
                      >
                        Create
                      </button>
                    </div>
                  `
                : nothing
            }
          </section>
        `}
        .footer=${html`
          <button class="dndm-btn dndm-btn--primary" type="button" @click=${this.handleClose}>
            Done
          </button>
        `}
      ></dndm-modal>
    `;
  }

  private renderTemplateRow(
    t: RollTemplate,
    scope: RollTemplateScope,
    canEdit: boolean,
  ): TemplateResult {
    const isEditing = this.editingId === t.id;

    if (isEditing) {
      return html`
        <div
          class="dndm-roll-template-row"
          style="flex-direction:column;align-items:stretch;gap:0.4rem;"
        >
          <div style="display:flex;gap:0.4rem;">
            <input
              class="dndm-input"
              .value=${this.editName}
              @input=${(e: Event) => (this.editName = (e.target as HTMLInputElement).value)}
              placeholder="Name"
            />
            <button
              class="dndm-btn dndm-btn--small dndm-btn--primary"
              type="button"
              @click=${() => this.saveEdit(scope, t.id)}
            >
              Save
            </button>
            <button
              class="dndm-btn dndm-btn--small dndm-btn--ghost"
              type="button"
              @click=${() => this.cancelEdit()}
            >
              Cancel
            </button>
          </div>

          <!-- Dice terms editor -->
          <div style="display:flex;flex-wrap:wrap;gap:0.3rem;align-items:center;">
            ${this.editDice.map(
              (d, idx) => html`
                <div class="dndm-dice-term">
                  <input
                    type="number"
                    min="1"
                    max="20"
                    class="dndm-input dndm-input--num"
                    style="width:3rem;"
                    .value=${String(d.count)}
                    @change=${(e: Event) => {
                      const val = parseInt((e.target as HTMLInputElement).value, 10);
                      this.editDice[idx] = { ...d, count: isNaN(val) ? 1 : Math.max(1, val) };
                      this.requestUpdate();
                    }}
                  />
                  <span>d</span>
                  <select
                    class="dndm-select"
                    .value=${String(d.sides)}
                    @change=${(e: Event) => {
                      const val = parseInt((e.target as HTMLSelectElement).value, 10);
                      this.editDice[idx] = { ...d, sides: val };
                      this.requestUpdate();
                    }}
                  >
                    ${DIE_SIZES.map(
                      (s) => html`<option value=${s} ?selected=${d.sides === s}>${s}</option>`,
                    )}
                  </select>
                  ${
                    this.editDice.length > 1
                      ? html`
                          <button
                            class="dndm-btn dndm-btn--small dndm-btn--icon"
                            type="button"
                            @click=${() => {
                            this.editDice.splice(idx, 1);
                            this.requestUpdate();
                          }}
                          >
                            ×
                          </button>
                        `
                      : nothing
                  }
                </div>
              `,
            )}
            <button
              class="dndm-btn dndm-btn--small dndm-btn--ghost"
              type="button"
              @click=${() => {
                this.editDice.push({ count: 1, sides: 6 });
                this.requestUpdate();
              }}
            >
              + Die
            </button>
          </div>

          <!-- Flat modifier, mode, attribute -->
          <div style="display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center;">
            <label class="dndm-label" style="display:flex;align-items:center;gap:0.3rem;">
              Modifier:
              <input
                type="number"
                class="dndm-input dndm-input--num"
                style="width:4rem;"
                .value=${String(this.editFlat)}
                @change=${(e: Event) => {
                  const val = parseInt((e.target as HTMLInputElement).value, 10);
                  this.editFlat = isNaN(val) ? 0 : val;
                }}
              />
            </label>

            <label class="dndm-label" style="display:flex;align-items:center;gap:0.3rem;">
              Mode:
              <select
                class="dndm-select"
                .value=${this.editMode}
                @change=${(e: Event) => (this.editMode = (e.target as HTMLSelectElement).value as RollMode)}
              >
                <option value="Normal">Normal</option>
                <option value="Advantage">Advantage</option>
                <option value="Disadvantage">Disadvantage</option>
              </select>
            </label>

            <label class="dndm-label" style="display:flex;align-items:center;gap:0.3rem;">
              Attribute:
              <select
                class="dndm-select"
                .value=${this.editAttr ?? ""}
                @change=${(e: Event) => {
                  const val = (e.target as HTMLSelectElement).value;
                  this.editAttr = val || null;
                }}
              >
                <option value="">(None)</option>
                ${this.state.attributeSchema.rows.map(
                  (r) =>
                    html`<option value=${r.name} ?selected=${this.editAttr === r.name}>
                      ${r.name}
                    </option>`,
                )}
              </select>
            </label>
          </div>
        </div>
      `;
    }

    return html`
      <div class="dndm-roll-template-row">
        <div class="dndm-roll-template-info">
          <span class="dndm-roll-template-name">${t.name}</span>
          <span class="dndm-roll-template-summary">${this.summarize(t)}</span>
        </div>
        ${
          canEdit
            ? html`
                <div style="display:flex;gap:0.3rem;">
                  <button
                    class="dndm-btn dndm-btn--small dndm-btn--ghost"
                    type="button"
                    @click=${() => this.startEdit(t)}
                  >
                    Edit
                  </button>
                  <button
                    class="dndm-btn dndm-btn--small dndm-btn--danger"
                    type="button"
                    @click=${() => {
                    if (scope === "Global") {
                      this.onDeleteGlobalTemplate?.(t.id);
                    } else if (scope === "Sheet" && this.sheetId) {
                      this.onDeleteSheetTemplate?.(this.sheetId, t.id);
                    }
                  }}
                  >
                    Delete
                  </button>
                </div>
              `
            : nothing
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-roll-template-library": DndmRollTemplateLibrary;
  }
}
