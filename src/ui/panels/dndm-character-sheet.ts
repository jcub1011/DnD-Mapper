import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  AttributePreset,
  AttributeRow,
  AttributeSchema,
  AttributeValue,
  CharacterSheet,
  CustomTemplate,
  DndMapperSettings,
  DndMapperState,
  GameMap,
  MapSummary,
  NamedTemplate,
  StatusEffect,
  StatusEffectTemplate,
} from "../../game/domain";
import {
  createDefaultAttributeSchema,
  createDefaultDndMapperState,
  resolveAttributeContribution,
  resolveEffectiveMaxHp,
} from "../../game/domain";
import {
  mayEditSheet,
  mayViewSheet,
  mayViewSheetNotesAndHp,
} from "../../game/rules";
import { GameElement } from "../app/GameElement";
import { toSafeHtml } from "./markdown";
import "./dndm-status-effects";
import "../modals/dndm-sheet-settings-modal";
import type { SheetSettingsPatch } from "../modals/dndm-sheet-settings-modal";
import "../modals/dndm-schema-preset-modal";
import "../modals/dndm-schema-cascade-warning";

const ABILITY_KEYS = new Set([
  "str", "dex", "con", "int", "wis", "cha",
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
]);

function isAbilityRow(row: AttributeRow): boolean {
  return row.type === "Score" && ABILITY_KEYS.has(row.name.toLowerCase().trim());
}

function shortAbilityName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (lower.startsWith("str")) return "STR";
  if (lower.startsWith("dex")) return "DEX";
  if (lower.startsWith("con")) return "CON";
  if (lower.startsWith("int")) return "INT";
  if (lower.startsWith("wis")) return "WIS";
  if (lower.startsWith("cha")) return "CHA";
  return name.slice(0, 3).toUpperCase();
}

export type SheetPatch = Partial<Pick<CharacterSheet, "characterName" | "color" | "scopedMapId" | "notes">>;

@customElement("dndm-character-sheet")
export class DndmCharacterSheet extends GameElement {
  @property({ attribute: false })
  sheets: Readonly<Record<string, CharacterSheet>> = {};

  @property({ type: String })
  selectedSheetId: string | null = null;

  @property({ type: String })
  activeMapId: string | null = null;

  @property({ attribute: false })
  attributeSchema: AttributeSchema = { preset: "DnD5eCore", rows: [] };

  @property({ attribute: false })
  statusEffectTemplates: Readonly<Record<string, StatusEffectTemplate>> = {};

  @property({ attribute: false })
  customTemplates: Readonly<Record<string, CustomTemplate | NamedTemplate>> = {};

  @property({ attribute: false })
  settings: DndMapperSettings = createDefaultDndMapperState().settings;

  @property({ type: Boolean })
  isDm = false;

  @property({ type: String })
  currentUserId: string | null = null;

  @property({ attribute: false })
  roster: readonly { id: string; name: string }[] = [];

  @property({ attribute: false })
  maps: readonly (GameMap | MapSummary)[] = [];

  // Callbacks
  @property({ attribute: false })
  onSelectSheet?: (sheetId: string | null) => void;

  @property({ attribute: false })
  onCreateSheet?: (characterName?: string, scopedMapId?: string | null) => void;

  @property({ attribute: false })
  onUpdateSheet?: (sheetId: string, patch: SheetPatch) => void;

  @property({ attribute: false })
  onAssignSheetOwner?: (sheetId: string, ownerUserId: string | null) => void;

  @property({ attribute: false })
  onSetSheetHp?: (sheetId: string, hp: number | null) => void;

  @property({ attribute: false })
  onSetSheetMaxHp?: (sheetId: string, maxHp: number | null) => void;

  @property({ attribute: false })
  onSetSheetAc?: (sheetId: string, ac: number | null) => void;

  @property({ attribute: false })
  onDeleteSheet?: (sheetId: string) => void;

  @property({ attribute: false })
  onDuplicateSheet?: (sheetId: string) => void;

  @property({ attribute: false })
  onUpdateAttributeValues?: (sheetId: string, values: Readonly<Record<string, AttributeValue>>) => void;

  @property({ attribute: false })
  onApplyStatusEffect?: (sheetId: string, effect: Omit<StatusEffect, "id" | "appliedUtc">) => void;

  @property({ attribute: false })
  onRemoveStatusEffect?: (sheetId: string, effectId: string) => void;

  @property({ attribute: false })
  onSetSchemaPreset?: (preset: AttributePreset) => void;

  // Local component UI state
  @state() private scopeFilter: "map" | "all" = "map";
  @state() private searchQuery = "";
  @state() private notesTab: "edit" | "preview" = "edit";
  @state() private settingsModalOpen = false;
  @state() private schemaModalOpen = false;
  @state() private cascadeWarningOpen = false;
  @state() private pendingPreset: AttributePreset | null = null;
  @state() private prunedAttributes: readonly string[] = [];

  // Draft inputs for 300ms debouncing
  @state() private draftName: string | null = null;
  @state() private draftNotes: string | null = null;
  @state() private draftValues: Record<string, AttributeValue> | null = null;

  private debounceTimers = new Map<string, number>();

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearDebounceTimers();
  }

  private clearDebounceTimers(): void {
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private debounce(key: string, fn: () => void, ms = 300): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, ms);
    this.debounceTimers.set(key, timer);
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("selectedSheetId")) {
      this.clearDebounceTimers();
      this.draftName = null;
      this.draftNotes = null;
      this.draftValues = null;
    }
  }

  private getEffectiveState(): DndMapperState {
    return {
      phase: "Playing",
      settings: this.settings,
      attributeSchema: this.attributeSchema,
      maps: [],
      activeMapId: this.activeMapId,
      sheets: this.sheets as Record<string, CharacterSheet>,
      customTemplates: this.customTemplates,
      statusEffectTemplates: this.statusEffectTemplates,
      rollLog: [],
      globalRollTemplates: [],
      activeSchemaTemplateId: null,
      initiativeAttributeName: null,
      activeCombat: null,
      pendingCenterRequest: null,
      focusRect: null,
      loadedDiceRules: [],
      hostHeldKeys: [],
      dmPlayerId: this.isDm ? (this.currentUserId || "dm-user") : "dm-id",
    };
  }

  private handleSelectSheet(sheetId: string | null): void {
    this.selectedSheetId = sheetId;
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string | null }>("select-sheet", {
        bubbles: true,
        composed: true,
        detail: { sheetId },
      }),
    );
    this.onSelectSheet?.(sheetId);
  }

  private handleCreateSheet(): void {
    const scopedMap = this.scopeFilter === "map" ? this.activeMapId : null;
    this.dispatchEvent(
      new CustomEvent<{ characterName: string; scopedMapId: string | null }>("create-sheet", {
        bubbles: true,
        composed: true,
        detail: { characterName: "New Character", scopedMapId: scopedMap },
      }),
    );
    this.onCreateSheet?.("New Character", scopedMap);
  }

  private handleDuplicateSheet(sheetId: string): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string }>("duplicate-sheet", {
        bubbles: true,
        composed: true,
        detail: { sheetId },
      }),
    );
    this.onDuplicateSheet?.(sheetId);
  }

  private handleDeleteSheet(sheetId: string): void {
    this.settingsModalOpen = false;
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string }>("delete-sheet", {
        bubbles: true,
        composed: true,
        detail: { sheetId },
      }),
    );
    this.onDeleteSheet?.(sheetId);
    if (this.selectedSheetId === sheetId) {
      this.handleSelectSheet(null);
    }
  }

  private emitUpdateSheet(sheetId: string, patch: SheetPatch): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; patch: SheetPatch }>("update-sheet", {
        bubbles: true,
        composed: true,
        detail: { sheetId, patch },
      }),
    );
    this.onUpdateSheet?.(sheetId, patch);
  }

  private emitAssignSheetOwner(sheetId: string, ownerUserId: string | null): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; ownerUserId: string | null }>("assign-sheet-owner", {
        bubbles: true,
        composed: true,
        detail: { sheetId, ownerUserId },
      }),
    );
    this.onAssignSheetOwner?.(sheetId, ownerUserId);
  }

  private emitUpdateAttributeValues(sheetId: string, values: Readonly<Record<string, AttributeValue>>): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; values: Readonly<Record<string, AttributeValue>> }>("update-attributes", {
        bubbles: true,
        composed: true,
        detail: { sheetId, values },
      }),
    );
    this.onUpdateAttributeValues?.(sheetId, values);
  }

  // ── Debounced inputs ────────────────────────────────────────────────────────
  private onNameInput(sheetId: string, e: Event): void {
    const value = (e.target as HTMLInputElement).value;
    this.draftName = value;
    this.debounce("name", () => {
      this.emitUpdateSheet(sheetId, { characterName: value.trim() || "Unnamed Character" });
    });
  }

  private onNotesInput(sheetId: string, e: Event): void {
    const value = (e.target as HTMLTextAreaElement).value;
    this.draftNotes = value;
    this.debounce("notes", () => {
      this.emitUpdateSheet(sheetId, { notes: value });
    });
  }

  private onAttributeInput(sheet: CharacterSheet, row: AttributeRow, val: AttributeValue): void {
    const currentValues = this.draftValues ?? { ...sheet.values };
    const nextValues = { ...currentValues, [row.name]: val };
    this.draftValues = nextValues;
    this.debounce(`attr_${row.name}`, () => {
      this.emitUpdateAttributeValues(sheet.id, nextValues);
    });
  }

  // ── Immediate vital adjustments ─────────────────────────────────────────────
  private adjustHp(sheet: CharacterSheet, delta: number): void {
    const effectiveMax = resolveEffectiveMaxHp(sheet);
    const currentHp = sheet.hp ?? 0;
    let nextHp = currentHp + delta;
    if (effectiveMax !== null) {
      nextHp = Math.min(nextHp, effectiveMax);
    }
    nextHp = Math.max(0, nextHp);
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; hp: number }>("set-sheet-hp", {
        bubbles: true,
        composed: true,
        detail: { sheetId: sheet.id, hp: nextHp },
      }),
    );
    this.onSetSheetHp?.(sheet.id, nextHp);
  }

  private adjustAc(sheet: CharacterSheet, delta: number): void {
    const currentAc = sheet.armorClass ?? 10;
    const nextAc = Math.max(0, currentAc + delta);
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; ac: number }>("set-sheet-ac", {
        bubbles: true,
        composed: true,
        detail: { sheetId: sheet.id, ac: nextAc },
      }),
    );
    this.onSetSheetAc?.(sheet.id, nextAc);
  }

  // ── Preset switching with cascade prune warning ────────────────────────────
  private handleSelectPreset(preset: AttributePreset): void {
    this.schemaModalOpen = false;
    const newSchema = createDefaultAttributeSchema(preset);
    const currentRowNames = new Set(this.attributeSchema.rows.map((r) => r.name));
    const newRowNames = new Set(newSchema.rows.map((r) => r.name));

    const pruned: string[] = [];
    for (const name of currentRowNames) {
      if (!newRowNames.has(name)) {
        const hasData = Object.values(this.sheets).some((s) => {
          const v = s.values[name];
          if (!v) return false;
          if (v.kind === "Score" && v.value !== 10) return true;
          if (v.kind === "Modifier" && v.value !== 0) return true;
          if (v.kind === "Text" && v.value.trim().length > 0) return true;
          return false;
        });
        if (hasData) pruned.push(name);
      }
    }

    if (pruned.length > 0) {
      this.pendingPreset = preset;
      this.prunedAttributes = pruned;
      this.cascadeWarningOpen = true;
    } else {
      this.applyPreset(preset);
    }
  }

  private applyPreset(preset: AttributePreset): void {
    this.dispatchEvent(
      new CustomEvent<{ preset: AttributePreset }>("set-schema-preset", {
        bubbles: true,
        composed: true,
        detail: { preset },
      }),
    );
    this.onSetSchemaPreset?.(preset);
    this.pendingPreset = null;
    this.prunedAttributes = [];
  }

  override render(): TemplateResult {
    const state = this.getEffectiveState();
    const userId = this.currentUserId ?? (this.isDm ? (state.dmPlayerId ?? "") : "");

    // Visible sheets per permission policy
    const visibleSheets = Object.values(this.sheets).filter((s) =>
      mayViewSheet(state, userId, s),
    );

    // Filter by scope and search
    const filteredSheets = visibleSheets.filter((s) => {
      if (this.scopeFilter === "map" && this.activeMapId) {
        if (s.scopedMapId !== null && s.scopedMapId !== this.activeMapId) {
          return false;
        }
      }
      if (this.searchQuery) {
        return s.characterName.toLowerCase().includes(this.searchQuery.toLowerCase());
      }
      return true;
    });

    const activeSheet = this.selectedSheetId ? this.sheets[this.selectedSheetId] : null;
    const canViewActive = activeSheet ? mayViewSheet(state, userId, activeSheet) : false;
    const selectedSheet = canViewActive ? activeSheet : null;

    return html`
      <div class="dndm-sheet-panel">
        <!-- Roster / Selector Header -->
        <div class="dndm-sheet-roster">
          <div class="dndm-sheet-roster-controls">
            <input
              type="text"
              class="dndm-sheet-search"
              placeholder="Search sheets..."
              .value=${this.searchQuery}
              @input=${(e: Event) => {
                this.searchQuery = (e.target as HTMLInputElement).value;
              }}
            />
            <button
              class="dndm-btn dndm-btn--subtle"
              style="padding: 2px 6px; font-size: 0.75rem;"
              @click=${() => {
                this.scopeFilter = this.scopeFilter === "map" ? "all" : "map";
              }}
            >
              ${this.scopeFilter === "map" ? "Map" : "All"}
            </button>
            ${this.isDm || this.settings.playersCanCreateNPCs
              ? html`
                  <button
                    class="dndm-btn dndm-btn--primary"
                    style="padding: 2px 8px; font-size: 0.75rem;"
                    @click=${this.handleCreateSheet}
                  >
                    + New
                  </button>
                `
              : nothing}
            ${this.isDm
              ? html`
                  <button
                    class="dndm-btn dndm-btn--subtle"
                    title="Attribute Schema Presets"
                    style="padding: 2px 6px; font-size: 0.75rem;"
                    @click=${() => {
                      this.schemaModalOpen = true;
                    }}
                  >
                    Schema
                  </button>
                `
              : nothing}
          </div>

          <!-- Sheet Chips -->
          <div class="dndm-sheet-chips">
            ${filteredSheets.map((s) => {
              const isActive = selectedSheet?.id === s.id;
              return html`
                <div
                  class="dndm-sheet-chip ${isActive ? "dndm-sheet-chip--active" : ""}"
                  @click=${() => this.handleSelectSheet(s.id)}
                >
                  <span
                    class="dndm-sheet-color-dot"
                    style="background-color: ${s.color || "#4a90e2"}; width: 10px; height: 10px;"
                  ></span>
                  <span>${s.characterName}</span>
                </div>
              `;
            })}
          </div>
        </div>

        <!-- Selected Character Sheet Body -->
        ${selectedSheet
          ? this.renderSheetDetails(selectedSheet, state, userId)
          : html`
              <div style="padding: 20px; text-align: center; color: var(--dndm-text-muted); font-size: 0.9rem;">
                Select or create a character sheet to view details.
              </div>
            `}
      </div>

      <!-- Modals -->
      <dndm-sheet-settings-modal
        .isOpen=${this.settingsModalOpen}
        .sheet=${selectedSheet}
        .roster=${this.roster}
        .maps=${this.maps}
        .isDm=${this.isDm}
        @save=${(e: CustomEvent<SheetSettingsPatch>) => {
          if (selectedSheet) {
            const { characterName, color, scopedMapId, ownerUserId } = e.detail;
            this.emitUpdateSheet(selectedSheet.id, { characterName, color, scopedMapId });
            if (ownerUserId !== undefined && ownerUserId !== selectedSheet.ownerUserId) {
              this.emitAssignSheetOwner(selectedSheet.id, ownerUserId);
            }
          }
          this.settingsModalOpen = false;
        }}
        @delete=${(e: CustomEvent<{ sheetId: string }>) => {
          this.handleDeleteSheet(e.detail.sheetId);
        }}
        @cancel=${() => {
          this.settingsModalOpen = false;
        }}
      ></dndm-sheet-settings-modal>

      <dndm-schema-preset-modal
        .isOpen=${this.schemaModalOpen}
        .currentPreset=${this.attributeSchema.preset}
        @select-preset=${(e: CustomEvent<{ preset: AttributePreset }>) => {
          this.handleSelectPreset(e.detail.preset);
        }}
        @cancel=${() => {
          this.schemaModalOpen = false;
        }}
      ></dndm-schema-preset-modal>

      <dndm-schema-cascade-warning
        .isOpen=${this.cascadeWarningOpen}
        .prunedAttributes=${this.prunedAttributes}
        @confirm=${() => {
          this.cascadeWarningOpen = false;
          if (this.pendingPreset) {
            this.applyPreset(this.pendingPreset);
          }
        }}
        @cancel=${() => {
          this.cascadeWarningOpen = false;
          this.pendingPreset = null;
        }}
      ></dndm-schema-cascade-warning>
    `;
  }

  private renderSheetDetails(
    sheet: CharacterSheet,
    state: DndMapperState,
    userId: string,
  ): TemplateResult {
    const editable = mayEditSheet(state, userId, sheet);
    const canViewNotesAndHp = mayViewSheetNotesAndHp(state, userId, sheet);

    const effectiveMaxHp = resolveEffectiveMaxHp(sheet);
    const currentHp = sheet.hp ?? 0;
    const hpPercent = effectiveMaxHp !== null && effectiveMaxHp > 0
      ? Math.max(0, Math.min(100, Math.round((currentHp / effectiveMaxHp) * 100)))
      : 0;

    const isBloodied = effectiveMaxHp !== null && currentHp > 0 && currentHp <= Math.floor(effectiveMaxHp / 2);
    const isDead = effectiveMaxHp !== null && currentHp === 0;

    const abilityRows = this.attributeSchema.rows.filter(isAbilityRow);
    const otherRows = this.attributeSchema.rows.filter((r) => !isAbilityRow(r));

    const nameValue = this.draftName !== null ? this.draftName : sheet.characterName;
    const notesValue = this.draftNotes !== null ? this.draftNotes : (sheet.notes || "");

    return html`
      <!-- Title Bar -->
      <div class="dndm-sheet-header-title-bar">
        <span
          class="dndm-sheet-color-dot"
          style="background-color: ${sheet.color || "#4a90e2"};"
          title="Character token color"
        ></span>
        <input
          type="text"
          class="dndm-sheet-name-input"
          .value=${nameValue}
          ?disabled=${!editable}
          @input=${(e: Event) => this.onNameInput(sheet.id, e)}
        />
        ${this.isDm
          ? html`
              <button
                class="dndm-btn dndm-btn--subtle"
                title="Duplicate Sheet"
                style="padding: 2px 6px; font-size: 0.8rem;"
                @click=${() => this.handleDuplicateSheet(sheet.id)}
              >
                Copy
              </button>
            `
          : nothing}
        <button
          class="dndm-btn dndm-btn--subtle"
          title="Sheet Settings"
          style="padding: 2px 6px; font-size: 0.8rem;"
          @click=${() => {
            this.settingsModalOpen = true;
          }}
        >
          ⚙
        </button>
      </div>

      <!-- Vitals (HP & AC) -->
      ${canViewNotesAndHp
        ? html`
            <div class="dndm-sheet-vitals">
              <!-- HP Bar -->
              <div class="dndm-sheet-hp-bar">
                <div
                  class="dndm-sheet-hp-fill ${isDead ? "dndm-sheet-hp-fill--dead" : isBloodied ? "dndm-sheet-hp-fill--bloodied" : ""}"
                  style="width: ${hpPercent}%;"
                ></div>
                <div class="dndm-sheet-hp-text">
                  ${sheet.hp != null && effectiveMaxHp != null
                    ? `${currentHp} / ${effectiveMaxHp} HP`
                    : "HP Not Set"}
                  ${isDead ? " (Dead)" : isBloodied ? " (Bloodied)" : ""}
                </div>
              </div>

              <!-- Controls Row -->
              <div class="dndm-sheet-vitals-row">
                <!-- HP Stepper -->
                <div class="dndm-sheet-stat-box">
                  <span style="font-size: 0.75rem; font-weight: bold;">HP:</span>
                  ${editable
                    ? html`
                        <div class="dndm-sheet-stepper">
                          <button
                            class="dndm-sheet-step-btn"
                            title="-5 HP"
                            @click=${() => this.adjustHp(sheet, -5)}
                          >
                            -5
                          </button>
                          <button
                            class="dndm-sheet-step-btn"
                            title="-1 HP"
                            @click=${() => this.adjustHp(sheet, -1)}
                          >
                            -1
                          </button>
                          <button
                            class="dndm-sheet-step-btn"
                            title="+1 HP"
                            @click=${() => this.adjustHp(sheet, 1)}
                          >
                            +1
                          </button>
                          <button
                            class="dndm-sheet-step-btn"
                            title="+5 HP"
                            @click=${() => this.adjustHp(sheet, 5)}
                          >
                            +5
                          </button>
                        </div>
                      `
                    : html`<span style="font-size: 0.85rem;">${currentHp}</span>`}
                </div>

                <!-- AC Stepper -->
                <div class="dndm-sheet-stat-box">
                  <span style="font-size: 0.75rem; font-weight: bold;">AC:</span>
                  <span style="font-size: 1rem; font-weight: bold; margin-right: 4px;">
                    ${sheet.armorClass ?? 10}
                  </span>
                  ${editable
                    ? html`
                        <div class="dndm-sheet-stepper">
                          <button
                            class="dndm-sheet-step-btn"
                            title="-1 AC"
                            @click=${() => this.adjustAc(sheet, -1)}
                          >
                            -
                          </button>
                          <button
                            class="dndm-sheet-step-btn"
                            title="+1 AC"
                            @click=${() => this.adjustAc(sheet, 1)}
                          >
                            +
                          </button>
                        </div>
                      `
                    : nothing}
                </div>
              </div>
            </div>
          `
        : nothing}

      <!-- Ability Scores Grid -->
      ${abilityRows.length > 0
        ? html`
            <div class="dndm-sheet-scores-grid">
              ${abilityRows.map((row) => {
                const values = this.draftValues ?? sheet.values;
                const attrVal = values[row.name] ?? row.default;
                const contribution = resolveAttributeContribution(sheet, row.name, attrVal);
                const rawNum = attrVal.kind === "Score" ? attrVal.value : 10;
                const effectiveNum = contribution.effectiveValue.kind === "Score" ? contribution.effectiveValue.value : 10;
                const mod = contribution.effectiveModifier;
                const modStr = mod >= 0 ? `+${mod}` : `${mod}`;

                return html`
                  <div class="dndm-score-card">
                    <span class="dndm-score-label">${shortAbilityName(row.name)}</span>
                    ${editable
                      ? html`
                          <input
                            type="number"
                            class="dndm-sheet-attr-input"
                            style="width: 46px; text-align: center; font-size: 1.1rem; font-weight: bold; margin: 2px 0;"
                            .value=${String(rawNum)}
                            @input=${(e: Event) => {
                              const num = parseInt((e.target as HTMLInputElement).value, 10);
                              this.onAttributeInput(sheet, row, {
                                kind: "Score",
                                value: isNaN(num) ? 10 : num,
                              });
                            }}
                          />
                        `
                      : html`<span class="dndm-score-value">${effectiveNum}</span>`}
                    <span class="dndm-score-modifier">${modStr}</span>
                  </div>
                `;
              })}
            </div>
          `
        : nothing}

      <!-- Other Attributes / Skills -->
      ${otherRows.length > 0
        ? html`
            <div>
              <span class="dndm-sheet-section-title">Attributes &amp; Skills</span>
              <div class="dndm-sheet-attrs-table">
                ${otherRows.map((row) => {
                  const values = this.draftValues ?? sheet.values;
                  const val = values[row.name] ?? row.default;

                  return html`
                    <div class="dndm-sheet-attr-row">
                      <span>${row.name}</span>
                      ${this.renderAttributeValueEditor(sheet, row, val, editable)}
                    </div>
                  `;
                })}
              </div>
            </div>
          `
        : nothing}

      <!-- Status Effects Section -->
      <dndm-status-effects
        .sheet=${sheet}
        .editable=${editable}
        .customTemplates=${Object.values(this.statusEffectTemplates)}
        @apply-effect=${(e: CustomEvent<{ effect: Omit<StatusEffect, "id" | "appliedUtc"> }>) => {
          this.dispatchEvent(
            new CustomEvent<{ sheetId: string; effect: Omit<StatusEffect, "id" | "appliedUtc"> }>(
              "apply-status-effect",
              {
                bubbles: true,
                composed: true,
                detail: { sheetId: sheet.id, effect: e.detail.effect },
              },
            ),
          );
          this.onApplyStatusEffect?.(sheet.id, e.detail.effect);
        }}
        @remove-effect=${(e: CustomEvent<{ effectId: string }>) => {
          this.dispatchEvent(
            new CustomEvent<{ sheetId: string; effectId: string }>(
              "remove-status-effect",
              {
                bubbles: true,
                composed: true,
                detail: { sheetId: sheet.id, effectId: e.detail.effectId },
              },
            ),
          );
          this.onRemoveStatusEffect?.(sheet.id, e.detail.effectId);
        }}
      ></dndm-status-effects>

      <!-- Notes Section -->
      ${canViewNotesAndHp
        ? html`
            <div class="dndm-sheet-notes-container">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <span class="dndm-sheet-section-title" style="margin: 0;">Notes</span>
                <div style="display: flex; gap: 2px;">
                  <button
                    class="dndm-btn ${this.notesTab === "edit" ? "dndm-btn--subtle" : ""}"
                    style="padding: 1px 6px; font-size: 0.75rem;"
                    @click=${() => {
                      this.notesTab = "edit";
                    }}
                  >
                    Edit
                  </button>
                  <button
                    class="dndm-btn ${this.notesTab === "preview" ? "dndm-btn--subtle" : ""}"
                    style="padding: 1px 6px; font-size: 0.75rem;"
                    @click=${() => {
                      this.notesTab = "preview";
                    }}
                  >
                    Preview
                  </button>
                </div>
              </div>

              ${this.notesTab === "edit"
                ? html`
                    <textarea
                      class="dndm-sheet-notes-textarea"
                      placeholder="Character backstory, inventory, notes (Markdown supported)..."
                      .value=${notesValue}
                      ?disabled=${!editable}
                      @input=${(e: Event) => this.onNotesInput(sheet.id, e)}
                    ></textarea>
                  `
                : html`
                    <div
                      class="dndm-sheet-notes-preview"
                      .innerHTML=${toSafeHtml(notesValue)}
                    ></div>
                  `}
            </div>
          `
        : nothing}
    `;
  }

  private renderAttributeValueEditor(
    sheet: CharacterSheet,
    row: AttributeRow,
    val: AttributeValue,
    editable: boolean,
  ): TemplateResult {
    switch (row.type) {
      case "Score": {
        const num = val.kind === "Score" ? val.value : 10;
        return editable
          ? html`
              <input
                type="number"
                class="dndm-sheet-attr-input"
                .value=${String(num)}
                @input=${(e: Event) => {
                  const n = parseInt((e.target as HTMLInputElement).value, 10);
                  this.onAttributeInput(sheet, row, { kind: "Score", value: isNaN(n) ? 10 : n });
                }}
              />
            `
          : html`<span>${num}</span>`;
      }
      case "Modifier": {
        const num = val.kind === "Modifier" ? val.value : 0;
        return editable
          ? html`
              <input
                type="number"
                class="dndm-sheet-attr-input"
                .value=${String(num)}
                @input=${(e: Event) => {
                  const n = parseInt((e.target as HTMLInputElement).value, 10);
                  this.onAttributeInput(sheet, row, { kind: "Modifier", value: isNaN(n) ? 0 : n });
                }}
              />
            `
          : html`<span>${num >= 0 ? `+${num}` : num}</span>`;
      }
      case "Text": {
        const text = val.kind === "Text" ? val.value : "";
        return editable
          ? html`
              <input
                type="text"
                class="dndm-sheet-attr-input"
                .value=${text}
                @input=${(e: Event) => {
                  const t = (e.target as HTMLInputElement).value;
                  this.onAttributeInput(sheet, row, { kind: "Text", value: t });
                }}
              />
            `
          : html`<span>${text}</span>`;
      }
    }
  }
}
