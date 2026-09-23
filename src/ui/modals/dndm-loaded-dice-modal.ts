import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  GM_TARGET_ID,
  type CharacterSheet,
  type GameMap,
  type LoadedDiceCondition,
  type LoadedDiceModification,
  type LoadedDiceRule,
  type MapSummary,
  type RollMode,
} from "../../game/domain.js";
import { GameElement } from "../app/GameElement.js";
import "./dndm-modal.js";

@customElement("dndm-loaded-dice-modal")
export class DndmLoadedDiceModal extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ attribute: false })
  rule: LoadedDiceRule | null = null;

  @property({ attribute: false })
  sheets: Readonly<Record<string, CharacterSheet>> = {};

  @property({ attribute: false })
  maps: readonly (GameMap | MapSummary)[] = [];

  @property({ attribute: false })
  onSave?: (rule: Omit<LoadedDiceRule, "id">, ruleId?: string) => void;

  @property({ attribute: false })
  onClose?: () => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @state() private name = "";
  @state() private enabled = true;
  @state() private targetScope: "all" | "gm" | "sheet" = "all";
  @state() private targetSheetId = "";
  @state() private conditions: LoadedDiceCondition[] = [];
  @state() private modifications: LoadedDiceModification[] = [];

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("rule") || (changedProperties.has("isOpen") && this.isOpen)) {
      if (this.rule) {
        this.name = this.rule.name;
        this.enabled = this.rule.enabled;
        if (!this.rule.targetSheetIds || this.rule.targetSheetIds.length === 0) {
          this.targetScope = "all";
          this.targetSheetId = "";
        } else if (this.rule.targetSheetIds.includes(GM_TARGET_ID)) {
          this.targetScope = "gm";
          this.targetSheetId = "";
        } else {
          this.targetScope = "sheet";
          this.targetSheetId = this.rule.targetSheetIds[0] ?? "";
        }
        this.conditions = [...this.rule.conditions];
        this.modifications = [...this.rule.modifications];
      } else {
        this.name = "";
        this.enabled = true;
        this.targetScope = "all";
        this.targetSheetId = "";
        this.conditions = [];
        this.modifications = [{ $kind: "setResult", value: 20 }];
      }
    }
  }

  private handleClose = (): void => {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.onClose?.();
    this.onCancel?.();
  };

  private handleSave = (): void => {
    const trimmedName = this.name.trim() || "Untitled Rule";
    let targetSheetIds: string[] = [];
    if (this.targetScope === "gm") {
      targetSheetIds = [GM_TARGET_ID];
    } else if (this.targetScope === "sheet" && this.targetSheetId) {
      targetSheetIds = [this.targetSheetId];
    }

    const payload: Omit<LoadedDiceRule, "id"> = {
      name: trimmedName,
      enabled: this.enabled,
      targetSheetIds,
      conditions: this.conditions,
      modifications: this.modifications,
    };

    this.onSave?.(payload, this.rule?.id);
    this.handleClose();
  };

  // ── Condition Management ───────────────────────────────────────────────────

  private addCondition(kind: LoadedDiceCondition["$kind"]): void {
    let cond: LoadedDiceCondition;
    switch (kind) {
      case "currentMap": {
        const firstMapId = this.maps[0]?.id ?? "";
        cond = { $kind: "currentMap", mapId: firstMapId };
        break;
      }
      case "diceTypeRolled":
        cond = { $kind: "diceTypeRolled", sides: 20 };
        break;
      case "rollerIs": {
        const firstSheetId = Object.keys(this.sheets)[0] ?? GM_TARGET_ID;
        cond = { $kind: "rollerIs", sheetId: firstSheetId };
        break;
      }
      case "rollModeIs":
        cond = { $kind: "rollModeIs", mode: "Normal" };
        break;
      case "hostKeyHeld":
        cond = { $kind: "hostKeyHeld", key: "SPACE" };
        break;
      case "combatActive":
        cond = { $kind: "combatActive" };
        break;
      case "rollLabelContains":
        cond = { $kind: "rollLabelContains", substring: "attack" };
        break;
      case "allOf":
        cond = { $kind: "allOf", conditions: [] };
        break;
      case "anyOf":
        cond = { $kind: "anyOf", conditions: [] };
        break;
      case "not":
        cond = { $kind: "not", condition: { $kind: "combatActive" } };
        break;
    }
    this.conditions = [...this.conditions, cond];
  }

  private removeCondition(index: number): void {
    this.conditions = this.conditions.filter((_, i) => i !== index);
  }

  private updateCondition(index: number, updated: LoadedDiceCondition): void {
    const next = [...this.conditions];
    next[index] = updated;
    this.conditions = next;
  }

  // ── Modification Management ────────────────────────────────────────────────

  private addModification(kind: LoadedDiceModification["$kind"]): void {
    let mod: LoadedDiceModification;
    switch (kind) {
      case "setResult":
        mod = { $kind: "setResult", value: 20 };
        break;
      case "clampMax":
        mod = { $kind: "clampMax", max: 15 };
        break;
      case "clampMin":
        mod = { $kind: "clampMin", min: 10 };
        break;
      case "biasLower":
        mod = { $kind: "biasLower", rerollCount: 1 };
        break;
      case "biasHigher":
        mod = { $kind: "biasHigher", rerollCount: 1 };
        break;
      case "rerollOn":
        mod = { $kind: "rerollOn", values: [1] };
        break;
    }
    this.modifications = [...this.modifications, mod];
  }

  private removeModification(index: number): void {
    this.modifications = this.modifications.filter((_, i) => i !== index);
  }

  private updateModification(index: number, updated: LoadedDiceModification): void {
    const next = [...this.modifications];
    next[index] = updated;
    this.modifications = next;
  }

  override render(): TemplateResult {
    const sheetEntries = Object.values(this.sheets);

    return html`
      <dndm-modal
        .isOpen=${this.isOpen}
        .modalTitle=${this.rule ? "Edit Loaded Dice Rule" : "Create Loaded Dice Rule"}
        cardStyle="max-width: 680px; width: 100%; max-height: calc(100vh - 1.5rem);"
        @close=${this.handleClose}
        .body=${html`
          <div class="dndm-panel-section">
            <label class="dndm-label" style="display: block; margin-bottom: 4px;">Rule Name</label>
            <input
              type="text"
              class="dndm-input"
              style="width: 100%; box-sizing: border-box;"
              placeholder="e.g. Spacebar forces d20 to 20"
              .value=${this.name}
              @input=${(e: Event) => {
                this.name = (e.target as HTMLInputElement).value;
              }}
            />
          </div>

          <div class="dndm-panel-section" style="margin-top: 0.75rem;">
            <label class="dndm-toggle" style="display: inline-flex; align-items: center; gap: 8px;">
              <input
                type="checkbox"
                ?checked=${this.enabled}
                @change=${(e: Event) => {
                  this.enabled = (e.target as HTMLInputElement).checked;
                }}
              />
              <span class="dndm-toggle-track"></span>
              <span>Enabled</span>
            </label>
          </div>

          <div class="dndm-panel-section" style="margin-top: 0.75rem;">
            <label class="dndm-label" style="display: block; margin-bottom: 4px;"
              >Target Scope</label
            >
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
              <label style="display: inline-flex; align-items: center; gap: 4px;">
                <input
                  type="radio"
                  name="targetScope"
                  value="all"
                  ?checked=${this.targetScope === "all"}
                  @change=${() => {
                    this.targetScope = "all";
                  }}
                />
                All Rolls
              </label>
              <label style="display: inline-flex; align-items: center; gap: 4px;">
                <input
                  type="radio"
                  name="targetScope"
                  value="gm"
                  ?checked=${this.targetScope === "gm"}
                  @change=${() => {
                    this.targetScope = "gm";
                  }}
                />
                GM Unlinked Only
              </label>
              <label style="display: inline-flex; align-items: center; gap: 4px;">
                <input
                  type="radio"
                  name="targetScope"
                  value="sheet"
                  ?checked=${this.targetScope === "sheet"}
                  @change=${() => {
                    this.targetScope = "sheet";
                    if (!this.targetSheetId && sheetEntries.length > 0) {
                      this.targetSheetId = sheetEntries[0].id;
                    }
                  }}
                />
                Specific Character
              </label>

              ${
                this.targetScope === "sheet"
                  ? html`
                      <select
                        class="dndm-select"
                        .value=${this.targetSheetId}
                        @change=${(e: Event) => {
                        this.targetSheetId = (e.target as HTMLSelectElement).value;
                      }}
                      >
                        ${sheetEntries.map(
                        (s) => html`<option value=${s.id}>${s.characterName || "Unnamed"}</option>`,
                      )}
                      </select>
                    `
                  : nothing
              }
            </div>
          </div>

          <!-- Conditions Section -->
          <div class="dndm-panel-section" style="margin-top: 1rem;">
            <div
              style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;"
            >
              <strong class="dndm-label">Conditions (All must match)</strong>
              <select
                class="dndm-select"
                style="font-size: 0.75rem;"
                @change=${(e: Event) => {
                  const sel = e.target as HTMLSelectElement;
                  if (sel.value) {
                    this.addCondition(sel.value as LoadedDiceCondition["$kind"]);
                    sel.value = "";
                  }
                }}
              >
                <option value="">+ Add Condition...</option>
                <option value="hostKeyHeld">Host Key Held</option>
                <option value="diceTypeRolled">Dice Type Rolled</option>
                <option value="currentMap">Current Map</option>
                <option value="rollModeIs">Roll Mode Is</option>
                <option value="combatActive">Combat Active</option>
                <option value="rollLabelContains">Roll Label Contains</option>
              </select>
            </div>

            ${
              this.conditions.length === 0
                ? html`<div
                    style="font-size: 0.8rem; color: var(--dndm-color-text-muted); font-style: italic;"
                  >
                    No conditions (always applies to target scope).
                  </div>`
                : html`
                    <div class="dndm-rule-builder-group">
                      ${this.conditions.map((c, i) => this.renderConditionRow(c, i))}
                    </div>
                  `
            }
          </div>

          <!-- Modifications Section -->
          <div class="dndm-panel-section" style="margin-top: 1rem;">
            <div
              style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;"
            >
              <strong class="dndm-label">Modifications (Applied in sequence)</strong>
              <select
                class="dndm-select"
                style="font-size: 0.75rem;"
                @change=${(e: Event) => {
                  const sel = e.target as HTMLSelectElement;
                  if (sel.value) {
                    this.addModification(sel.value as LoadedDiceModification["$kind"]);
                    sel.value = "";
                  }
                }}
              >
                <option value="">+ Add Modification...</option>
                <option value="setResult">Set Result (Override)</option>
                <option value="clampMin">Clamp Minimum (Floor)</option>
                <option value="clampMax">Clamp Maximum (Ceil)</option>
                <option value="biasHigher">Bias Higher (Advantage-like)</option>
                <option value="biasLower">Bias Lower (Disadvantage-like)</option>
                <option value="rerollOn">Reroll On Values</option>
              </select>
            </div>

            ${
              this.modifications.length === 0
                ? html`<div
                    style="font-size: 0.8rem; color: var(--dndm-color-text-muted); font-style: italic;"
                  >
                    No modifications defined.
                  </div>`
                : html`
                    <div class="dndm-rule-builder-group">
                      ${this.modifications.map((m, i) => this.renderModificationRow(m, i))}
                    </div>
                  `
            }
          </div>
        `}
        .footer=${html`
          <button class="dndm-btn dndm-btn--ghost" type="button" @click=${this.handleClose}>
            Cancel
          </button>
          <button class="dndm-btn dndm-btn--primary" type="button" @click=${this.handleSave}>
            Save Rule
          </button>
        `}
      ></dndm-modal>
    `;
  }

  private renderConditionRow(c: LoadedDiceCondition, index: number): TemplateResult {
    return html`
      <div class="dndm-rule-item-row">
        <span class="dndm-loaded-rule-badge dndm-loaded-rule-badge--condition">${c.$kind}</span>

        ${
          c.$kind === "hostKeyHeld"
            ? html`
                <input
                  type="text"
                  class="dndm-input"
                  style="width: 100px;"
                  placeholder="Key (e.g. SPACE)"
                  .value=${c.key}
                  @input=${(e: Event) => {
                  this.updateCondition(index, {
                    ...c,
                    key: (e.target as HTMLInputElement).value.toUpperCase(),
                  });
                }}
                />
              `
            : nothing
        }
        ${
          c.$kind === "diceTypeRolled"
            ? html`
                <select
                  class="dndm-select"
                  .value=${String(c.sides)}
                  @change=${(e: Event) => {
                  this.updateCondition(index, {
                    ...c,
                    sides: parseInt((e.target as HTMLSelectElement).value, 10),
                  });
                }}
                >
                  ${[4, 6, 8, 10, 12, 20, 100].map((s) => html`<option value=${s}>d${s}</option>`)}
                </select>
              `
            : nothing
        }
        ${
          c.$kind === "currentMap"
            ? html`
                <select
                  class="dndm-select"
                  .value=${c.mapId}
                  @change=${(e: Event) => {
                  this.updateCondition(index, {
                    ...c,
                    mapId: (e.target as HTMLSelectElement).value,
                  });
                }}
                >
                  ${this.maps.map((m) => html`<option value=${m.id}>${m.name}</option>`)}
                </select>
              `
            : nothing
        }
        ${
          c.$kind === "rollModeIs"
            ? html`
                <select
                  class="dndm-select"
                  .value=${c.mode}
                  @change=${(e: Event) => {
                  this.updateCondition(index, {
                    ...c,
                    mode: (e.target as HTMLSelectElement).value as RollMode,
                  });
                }}
                >
                  <option value="Normal">Normal</option>
                  <option value="Advantage">Advantage</option>
                  <option value="Disadvantage">Disadvantage</option>
                </select>
              `
            : nothing
        }
        ${
          c.$kind === "combatActive"
            ? html`<span style="font-size: 0.8rem; color: var(--dndm-color-text-muted);"
                >Combat must be active</span
              >`
            : nothing
        }
        ${
          c.$kind === "rollLabelContains"
            ? html`
                <input
                  type="text"
                  class="dndm-input"
                  style="flex: 1;"
                  placeholder="Substring"
                  .value=${c.substring}
                  @input=${(e: Event) => {
                  this.updateCondition(index, {
                    ...c,
                    substring: (e.target as HTMLInputElement).value,
                  });
                }}
                />
              `
            : nothing
        }

        <button
          class="dndm-btn dndm-btn--ghost dndm-btn--small"
          style="margin-left: auto; color: var(--dndm-color-danger);"
          type="button"
          @click=${() => this.removeCondition(index)}
        >
          ✕
        </button>
      </div>
    `;
  }

  private renderModificationRow(m: LoadedDiceModification, index: number): TemplateResult {
    return html`
      <div class="dndm-rule-item-row">
        <span class="dndm-loaded-rule-badge dndm-loaded-rule-badge--mod">${m.$kind}</span>

        ${
          m.$kind === "setResult"
            ? html`
                <label style="font-size: 0.75rem;">Value: </label>
                <input
                  type="number"
                  class="dndm-input"
                  style="width: 70px;"
                  .value=${String(m.value)}
                  @change=${(e: Event) => {
                  this.updateModification(index, {
                    ...m,
                    value: parseInt((e.target as HTMLInputElement).value, 10) || 1,
                  });
                }}
                />
              `
            : nothing
        }
        ${
          m.$kind === "clampMin"
            ? html`
                <label style="font-size: 0.75rem;">Min: </label>
                <input
                  type="number"
                  class="dndm-input"
                  style="width: 70px;"
                  .value=${String(m.min)}
                  @change=${(e: Event) => {
                  this.updateModification(index, {
                    ...m,
                    min: parseInt((e.target as HTMLInputElement).value, 10) || 1,
                  });
                }}
                />
              `
            : nothing
        }
        ${
          m.$kind === "clampMax"
            ? html`
                <label style="font-size: 0.75rem;">Max: </label>
                <input
                  type="number"
                  class="dndm-input"
                  style="width: 70px;"
                  .value=${String(m.max)}
                  @change=${(e: Event) => {
                  this.updateModification(index, {
                    ...m,
                    max: parseInt((e.target as HTMLInputElement).value, 10) || 1,
                  });
                }}
                />
              `
            : nothing
        }
        ${
          m.$kind === "biasLower" || m.$kind === "biasHigher"
            ? html`
                <label style="font-size: 0.75rem;">Reroll count: </label>
                <input
                  type="number"
                  class="dndm-input"
                  style="width: 70px;"
                  min="1"
                  max="10"
                  .value=${String(m.rerollCount)}
                  @change=${(e: Event) => {
                  this.updateModification(index, {
                    ...m,
                    rerollCount: Math.max(
                      1,
                      parseInt((e.target as HTMLInputElement).value, 10) || 1,
                    ),
                  });
                }}
                />
              `
            : nothing
        }
        ${
          m.$kind === "rerollOn"
            ? html`
                <label style="font-size: 0.75rem;">Values (CSV): </label>
                <input
                  type="text"
                  class="dndm-input"
                  style="width: 100px;"
                  .value=${m.values.join(", ")}
                  @change=${(e: Event) => {
                  const raw = (e.target as HTMLInputElement).value;
                  const vals = raw
                    .split(",")
                    .map((s) => parseInt(s.trim(), 10))
                    .filter((n) => !isNaN(n));
                  this.updateModification(index, {
                    ...m,
                    values: vals.length > 0 ? vals : [1],
                  });
                }}
                />
              `
            : nothing
        }

        <button
          class="dndm-btn dndm-btn--ghost dndm-btn--small"
          style="margin-left: auto; color: var(--dndm-color-danger);"
          type="button"
          @click=${() => this.removeModification(index)}
        >
          ✕
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-loaded-dice-modal": DndmLoadedDiceModal;
  }
}
