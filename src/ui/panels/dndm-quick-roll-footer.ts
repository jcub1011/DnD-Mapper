import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  BUILTIN_ROLL_TEMPLATES,
  formatDiceFormula,
  isNatural1,
  isNatural20,
} from "../../game/dice.js";
import type {
  AttributeRow,
  CharacterSheet,
  DndMapperState,
  RollMode,
  RollResult,
  RollTemplate,
} from "../../game/domain.js";
import { resolveAttributeContribution } from "../../game/domain.js";
import { GameElement } from "../app/GameElement.js";
import {
  chevronIcon,
  closeIcon,
  dieIcon,
  gearIcon,
  rollLogIcon,
  volumeIcon,
} from "../icons.js";
import { diceAnimationTracker } from "../dice/diceAnimationTracker.js";

const POLYHEDRAL_DICE = [4, 6, 8, 10, 12, 20, 100] as const;
const DEFAULT_QUICK_DICE: readonly number[] = [20, 6, 12];

function modeShort(mode: RollMode): string {
  return mode === "Advantage" ? "Adv" : mode === "Disadvantage" ? "Dis" : "Normal";
}

@customElement("dndm-quick-roll-footer")
export class DndmQuickRollFooter extends GameElement {
  @property({ attribute: false })
  state!: DndMapperState;

  @property({ type: Boolean })
  isDm = false;

  @property({ type: String })
  currentUserId: string | null = null;

  @property({ type: String })
  selectedSheetId: string | null = null;

  @property({ type: Boolean })
  soundEnabled = false;

  @property({ type: Number })
  diceScale = 75;

  @property({ attribute: false })
  onChangeDiceScale?: (scale: number) => void;

  @property({ attribute: false })
  onRollDice?: (
    formula: string,
    mode: RollMode,
    label?: string,
    sheetId?: string | null,
    attributeName?: string | null,
  ) => void;

  @property({ attribute: false })
  onRollTemplate?: (
    templateId: string,
    modeOverride?: RollMode,
    sheetId?: string | null,
  ) => void;

  @property({ attribute: false })
  onToggleSound?: () => void;

  @property({ attribute: false })
  onOpenHistory?: () => void;

  @property({ attribute: false })
  onReRoll?: (roll: RollResult, modeOverride?: RollMode) => void;

  @property({ attribute: false })
  onOpenTemplates?: () => void;

  @state() private logOpen = false;
  @state() private presetsOpen = false;
  @state() private modeOpen = false;
  @state() private attrOpen = false;
  @state() private diceExpanded = false;
  @state() private showCustomInput = false;
  @state() private customSelected = false;

  @state() private selectedSides = 20;
  @state() private customCount = 1;
  @state() private customSides = 20;
  @state() private customModifier = 0;
  @state() private customFormulaInput = "";
  @state() private selectedMode: RollMode = "Normal";
  @state() private previewMode: RollMode | null = null;
  @state() private recentLocal: readonly number[] = [];

  private unsubscribeTracker: (() => void) | null = null;

  private readonly handleWindowKey = (e: KeyboardEvent): void => {
    if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Meta") return;
    this.updatePreview(e.shiftKey, e.ctrlKey || e.metaKey);
  };

  private readonly handleWindowKeyUp = (e: KeyboardEvent): void => {
    this.updatePreview(e.shiftKey, e.ctrlKey || e.metaKey);
  };

  private readonly handleWindowBlur = (): void => {
    if (this.previewMode !== null) this.previewMode = null;
  };

  private updatePreview(shift: boolean, ctrl: boolean): void {
    const next: RollMode | null =
      shift && !ctrl ? "Advantage" : ctrl && !shift ? "Disadvantage" : null;
    if (next !== this.previewMode) this.previewMode = next;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeTracker = diceAnimationTracker.subscribe(() => {
      this.requestUpdate();
    });
    window.addEventListener("keydown", this.handleWindowKey);
    window.addEventListener("keyup", this.handleWindowKeyUp);
    window.addEventListener("blur", this.handleWindowBlur);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeTracker?.();
    this.unsubscribeTracker = null;
    window.removeEventListener("keydown", this.handleWindowKey);
    window.removeEventListener("keyup", this.handleWindowKeyUp);
    window.removeEventListener("blur", this.handleWindowBlur);
  }

  private get effectiveMode(): RollMode {
    return this.previewMode ?? this.selectedMode;
  }

  private get isPreviewing(): boolean {
    return this.previewMode !== null && this.previewMode !== this.selectedMode;
  }

  private get assignedSheet(): CharacterSheet | null {
    if (this.selectedSheetId && this.state.sheets[this.selectedSheetId]) {
      return this.state.sheets[this.selectedSheetId];
    }
    if (this.currentUserId) {
      for (const sheet of Object.values(this.state.sheets)) {
        if (sheet.ownerUserId === this.currentUserId) return sheet;
      }
    }
    return null;
  }

  private get visibleRecentRolls(): readonly RollResult[] {
    const log = this.state.rollLog ?? [];
    const visible = this.isDm || this.state.settings.rollsVisibleToPlayers
      ? log
      : log.filter((r) => r.rollerUserId === this.currentUserId);

    return visible
      .filter((r) => !diceAnimationTracker.isAnimating(r.id))
      .slice(-5)
      .reverse();
  }

  private get visibleTemplates(): readonly RollTemplate[] {
    const list: RollTemplate[] = [...BUILTIN_ROLL_TEMPLATES];
    if (this.state.globalRollTemplates) {
      list.push(...this.state.globalRollTemplates);
    }
    const sheet = this.assignedSheet;
    if (sheet?.rollTemplates) {
      list.push(...sheet.rollTemplates);
    }
    return list;
  }

  /** Most-recently-used die sides: session picks first, then roll history, then defaults. */
  private get mruDice(): readonly number[] {
    const seen: number[] = [];
    for (const s of this.recentLocal) {
      if (!seen.includes(s)) seen.push(s);
      if (seen.length >= 3) break;
    }
    const log = this.state?.rollLog ?? [];
    for (let i = log.length - 1; i >= 0 && seen.length < 3; i--) {
      const r = log[i];
      const rolls = r?.rolls;
      if (!rolls || rolls.length === 0) continue;
      const sides = rolls[0].sides;
      if (typeof sides !== "number") continue;
      if (!(POLYHEDRAL_DICE as readonly number[]).includes(sides)) continue;
      if (!rolls.every((d) => d.sides === sides)) continue;
      if (!seen.includes(sides)) seen.push(sides);
    }
    for (const s of DEFAULT_QUICK_DICE) {
      if (seen.length >= 3) break;
      if (!seen.includes(s)) seen.push(s);
    }
    return seen.slice(0, 3);
  }

  private get visibleDice(): readonly number[] {
    return this.diceExpanded ? POLYHEDRAL_DICE : this.mruDice;
  }

  private touchRecent(sides: number): void {
    this.recentLocal = [sides, ...this.recentLocal.filter((s) => s !== sides)].slice(0, 10);
  }

  private resolveClickMode(e: MouseEvent): RollMode {
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) return "Advantage";
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) return "Disadvantage";
    return this.effectiveMode;
  }

  private closeAllPopovers(): void {
    this.logOpen = false;
    this.presetsOpen = false;
    this.modeOpen = false;
    this.attrOpen = false;
  }

  private handleDieClick(sides: number, e: MouseEvent): void {
    this.selectedSides = sides;
    this.customSelected = false;
    this.touchRecent(sides);
    const mode = this.resolveClickMode(e);
    const formula = `1d${sides}`;
    const label = `d${sides} Roll`;
    this.onRollDice?.(formula, mode, label, this.assignedSheet?.id ?? null, null);
  }

  private handleCustomToggle(): void {
    const next = !this.customSelected;
    this.customSelected = next;
    this.showCustomInput = next;
  }

  private handleRollButton(): void {
    if (this.customSelected) {
      this.handleCustomRoll();
      return;
    }
    const sides = this.selectedSides;
    this.touchRecent(sides);
    this.onRollDice?.(
      `1d${sides}`,
      this.effectiveMode,
      `d${sides} Roll`,
      this.assignedSheet?.id ?? null,
      null,
    );
  }

  private handleCustomRoll(): void {
    if (this.customFormulaInput.trim().length > 0) {
      this.onRollDice?.(
        this.customFormulaInput.trim(),
        this.effectiveMode,
        "Custom Roll",
        this.assignedSheet?.id ?? null,
        null,
      );
      return;
    }

    const count = Math.max(1, Math.min(20, this.customCount));
    const formula = formatDiceFormula([{ count, sides: this.customSides }], this.customModifier);
    this.onRollDice?.(
      formula,
      this.effectiveMode,
      "Dice Roll",
      this.assignedSheet?.id ?? null,
      null,
    );
  }

  private handleAttributeRoll(row: AttributeRow, e: MouseEvent): void {
    const sheet = this.assignedSheet;
    if (!sheet) return;

    const mode = this.resolveClickMode(e);
    this.onRollDice?.("1d20", mode, `${row.name} Check`, sheet.id, row.name);
    this.attrOpen = false;
  }

  private handleReRoll(roll: RollResult, e: MouseEvent): void {
    let mode: RollMode = roll.mode;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      mode = "Advantage";
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      mode = "Disadvantage";
    }

    this.onReRoll?.(roll, mode);
  }

  private formatMod(mod: number): string {
    return mod >= 0 ? `+${mod}` : `${mod}`;
  }

  private getAttrModifier(row: AttributeRow): number {
    const sheet = this.assignedSheet;
    if (!sheet) return 0;
    const base = sheet.values[row.name];
    if (!base) return 0;
    return resolveAttributeContribution(sheet, row.name, base).effectiveModifier;
  }

  override render(): TemplateResult {
    const sheet = this.assignedSheet;
    const numericRows = sheet
      ? this.state.attributeSchema.rows.filter(
          (r) => r.type === "Score" || r.type === "Modifier",
        )
      : [];
    const effective = this.effectiveMode;
    const anyPopover = this.logOpen || this.presetsOpen || this.modeOpen || this.attrOpen;

    return html`
      <div class="dndm-rollfooter ${anyPopover ? "dndm-rollfooter--popover" : ""}">
        <!-- 1. Roll button -->
        <button
          class="dndm-rollfooter__rollbtn"
          type="button"
          title=${this.customSelected && this.customFormulaInput.trim()
            ? `Roll ${this.customFormulaInput.trim()} (${effective})`
            : this.customSelected
              ? `Roll custom (${effective}) — Shift: Adv, Ctrl: Dis`
              : `Roll d${this.selectedSides} (${effective}) — Shift: Adv, Ctrl: Dis`}
          @click=${() => this.handleRollButton()}
        >
          ${dieIcon()} Roll${this.customSelected ? "" : html` d${this.selectedSides}`}
        </button>

        <!-- 2. Settings -->
        <button
          class="dndm-rollfooter__gear"
          type="button"
          title=${this.presetsOpen ? "Hide dice options" : "Dice options & presets"}
          aria-expanded=${this.presetsOpen ? "true" : "false"}
          @click=${() => {
            const next = !this.presetsOpen;
            this.closeAllPopovers();
            this.presetsOpen = next;
          }}
        >
          ${gearIcon()}
        </button>

        ${this.presetsOpen
          ? html`
              <div class="dndm-rollfooter__presets" role="dialog" aria-label="Dice options">
                <div class="dndm-rollfooter__recent-head">
                  <span class="dndm-label">Dice Options</span>
                  <div class="dndm-rollfooter__recent-actions">
                    <button
                      class="dndm-btn dndm-btn--small dndm-btn--ghost"
                      type="button"
                      @click=${() => {
                        this.presetsOpen = false;
                        this.onOpenTemplates?.();
                      }}
                    >
                      Library
                    </button>
                    <button
                      class="dndm-btn dndm-btn--icon dndm-btn--small"
                      type="button"
                      @click=${() => (this.presetsOpen = false)}
                    >
                      ${closeIcon()}
                    </button>
                  </div>
                </div>
                <div class="dndm-rollfooter__opt-row">
                  <span class="dndm-rollfooter__opt-title">Dice Size</span>
                  <div class="dndm-rollfooter__size-chips" role="group" aria-label="Dice size">
                    ${[
                      { scale: 50, label: "50%" },
                      { scale: 75, label: "75%" },
                      { scale: 100, label: "100%" },
                      { scale: 125, label: "125%" },
                    ].map(
                      (opt) => html`
                        <button
                          type="button"
                          class="dndm-rollfooter__size-chip ${this.diceScale === opt.scale ? "dndm-rollfooter__size-chip--active" : ""}"
                          title="${opt.label} scale${opt.scale === 75 ? " (Default)" : ""}"
                          @click=${() => this.onChangeDiceScale?.(opt.scale)}
                        >
                          ${opt.label}
                        </button>
                      `,
                    )}
                  </div>
                </div>
                <div class="dndm-rollfooter__opt-row">
                  <span class="dndm-rollfooter__opt-title">Templates</span>
                  <div class="dndm-dice-quick-row">
                    ${this.visibleTemplates.map(
                      (t) => html`
                        <button
                          class="dndm-btn dndm-btn--small"
                          type="button"
                          @click=${() => {
                            this.onRollTemplate?.(t.id, this.effectiveMode, sheet?.id ?? null);
                            this.presetsOpen = false;
                          }}
                        >
                          ${t.name}
                        </button>
                      `,
                    )}
                  </div>
                </div>
              </div>
            `
          : nothing}

        <!-- 3. Roll Log -->
        <button
          class="dndm-rollfooter__log"
          type="button"
          title=${this.logOpen ? "Hide recent rolls" : "Show recent rolls"}
          aria-expanded=${this.logOpen ? "true" : "false"}
          @click=${() => {
            const next = !this.logOpen;
            this.closeAllPopovers();
            this.logOpen = next;
          }}
        >
          ${rollLogIcon()}
        </button>

        ${this.logOpen
          ? html`
              <div class="dndm-rollfooter__recent" role="dialog" aria-label="Recent rolls">
                <div class="dndm-rollfooter__recent-head">
                  <span class="dndm-label">Recent rolls</span>
                  <div class="dndm-rollfooter__recent-actions">
                    <button
                      class="dndm-btn dndm-btn--small dndm-btn--ghost"
                      type="button"
                      @click=${() => {
                        this.logOpen = false;
                        this.onOpenHistory?.();
                      }}
                    >
                      See all rolls
                    </button>
                    <button
                      class="dndm-btn dndm-btn--icon dndm-btn--small"
                      type="button"
                      @click=${() => (this.logOpen = false)}
                    >
                      ${closeIcon()}
                    </button>
                  </div>
                </div>
                ${this.visibleRecentRolls.length === 0
                  ? html`<div class="dndm-panel-empty">No rolls yet.</div>`
                  : html`<div class="dndm-rollfooter__recent-list">
                      ${this.visibleRecentRolls.map((r) => this.renderRecentRollEntry(r))}
                    </div>`}
              </div>
            `
          : nothing}

        <!-- 4. Sound toggle -->
        <button
          class="dndm-rollfooter__sound ${this.soundEnabled ? "dndm-rollfooter__sound--active" : ""}"
          type="button"
          title=${this.soundEnabled ? "Dice sounds: On (click to mute)" : "Dice sounds: Muted (click to enable)"}
          @click=${() => this.onToggleSound?.()}
        >
          ${volumeIcon(!this.soundEnabled)}
        </button>

        <!-- 5. Mode dropdown -->
        <div class="dndm-rollfooter__select-wrap">
          <button
            class="dndm-rollfooter__select ${this.isPreviewing ? "dndm-rollfooter__select--preview" : ""}"
            type="button"
            title=${this.isPreviewing
              ? `Previewing ${effective} while modifier held — releases back to ${this.selectedMode}`
              : "Roll mode — hold Shift for Advantage, Ctrl for Disadvantage to preview"}
            aria-haspopup="listbox"
            aria-expanded=${this.modeOpen ? "true" : "false"}
            @click=${() => {
              const next = !this.modeOpen;
              this.closeAllPopovers();
              this.modeOpen = next;
            }}
          >
            <span>${this.isPreviewing ? effective : this.selectedMode}</span>
            ${this.isPreviewing
              ? html`<span class="dndm-rollfooter__preview-dot" title="Modifier preview">●</span>`
              : nothing}
            ${chevronIcon(this.modeOpen ? "down" : "right")}
          </button>
          ${this.modeOpen
            ? html`
                <div
                  class="dndm-rollfooter__menu"
                  role="listbox"
                  aria-label="Roll mode"
                >
                  ${( ["Normal", "Advantage", "Disadvantage"] as const ).map(
                    (mode) => html`
                      <button
                        role="option"
                        aria-selected=${this.selectedMode === mode ? "true" : "false"}
                        class="dndm-rollfooter__menu-item ${this.selectedMode === mode ? "dndm-rollfooter__menu-item--active" : ""}"
                        type="button"
                        @click=${() => {
                          this.selectedMode = mode;
                          this.modeOpen = false;
                        }}
                      >
                        ${modeShort(mode) === mode ? mode : html`${mode} (${modeShort(mode)})`}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing}
        </div>

        <!-- 6. Attribute dropdown -->
        ${numericRows.length > 0
          ? html`
              <div class="dndm-rollfooter__select-wrap">
                <button
                  class="dndm-rollfooter__select"
                  type="button"
                  title="Quick attribute roll (d20 + modifier)"
                  aria-haspopup="listbox"
                  aria-expanded=${this.attrOpen ? "true" : "false"}
                  @click=${() => {
                    const next = !this.attrOpen;
                    this.closeAllPopovers();
                    this.attrOpen = next;
                  }}
                >
                  <span>Attributes</span>
                  ${chevronIcon(this.attrOpen ? "down" : "right")}
                </button>
                ${this.attrOpen
                  ? html`
                      <div class="dndm-rollfooter__menu" role="listbox" aria-label="Attributes">
                        ${numericRows.map((row) => {
                          const mod = this.getAttrModifier(row);
                          return html`
                            <button
                              role="option"
                              aria-selected="false"
                              class="dndm-rollfooter__menu-item"
                              type="button"
                              title="Roll d20 ${this.formatMod(mod)} (${row.name}, ${effective})"
                              @click=${(e: MouseEvent) => this.handleAttributeRoll(row, e)}
                            >
                              <span>${row.name}</span>
                              <span class="dndm-rollfooter__attr-mod">${this.formatMod(mod)}</span>
                            </button>
                          `;
                        })}
                      </div>
                    `
                  : nothing}
              </div>
            `
          : nothing}

        <!-- 7. Quick Roll Type Select -->
        <div class="dndm-rollfooter__polygroup" role="group" aria-label="Quick roll type">
          ${this.visibleDice.map(
            (sides) => html`
              <button
                class="dndm-rollfooter__diebtn ${!this.customSelected && this.selectedSides === sides ? "dndm-rollfooter__diebtn--active" : ""}"
                type="button"
                title="Select d${sides} — click to roll (Shift: Adv, Ctrl: Dis)"
                aria-pressed=${!this.customSelected && this.selectedSides === sides ? "true" : "false"}
                @click=${(e: MouseEvent) => this.handleDieClick(sides, e)}
              >
                d${sides}
              </button>
            `,
          )}
          <button
            class="dndm-rollfooter__expand"
            type="button"
            title=${this.diceExpanded ? "Show fewer dice" : "Show all dice"}
            aria-expanded=${this.diceExpanded ? "true" : "false"}
            @click=${() => {
              this.diceExpanded = !this.diceExpanded;
              if (!this.diceExpanded) {
                this.showCustomInput = false;
                this.customSelected = false;
              }
            }}
          >
            ${chevronIcon(this.diceExpanded ? "down" : "right")}
          </button>
          ${this.diceExpanded
            ? html`
                <button
                  class="dndm-rollfooter__diebtn dndm-rollfooter__diebtn--custom ${this.customSelected ? "dndm-rollfooter__diebtn--active" : ""}"
                  type="button"
                  title="Type a custom roll (e.g. 4d6+5)"
                  aria-pressed=${this.customSelected ? "true" : "false"}
                  aria-expanded=${this.showCustomInput ? "true" : "false"}
                  @click=${() => this.handleCustomToggle()}
                >
                  Custom
                </button>
              `
            : nothing}
        </div>

        ${this.showCustomInput && this.diceExpanded
          ? html`
              <input
                class="dndm-input dndm-rollfooter__custom-formula"
                placeholder="e.g. 4d6+5"
                aria-label="Custom roll formula"
                .value=${this.customFormulaInput}
                @input=${(e: Event) =>
                  (this.customFormulaInput = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") this.handleCustomRoll();
                  if (e.key === "Escape") {
                    this.showCustomInput = false;
                    this.customSelected = false;
                  }
                }}
              />
            `
          : nothing}
      </div>
    `;
  }

  private renderRecentRollEntry(r: RollResult): TemplateResult {
    const isNat20 = isNatural20(r);
    const isNat1 = isNatural1(r);
    const canReRoll = r.rollerUserId === this.currentUserId;

    const hasAppliedRules = Boolean(r.appliedRules && r.appliedRules.length > 0);
    const visibility = this.state.settings.loadedDiceRuleVisibility ?? "Hidden";
    const showRuleStamps =
      this.isDm || visibility === "VisibleToAll" || visibility === "AllPlayers";
    const indicator = this.state.settings.loadedDicePlayerIndicator ?? "None";
    const showSubtleCue =
      hasAppliedRules && (indicator === "Subtle" || indicator === "RedDotInLog");
    const showObviousCue = hasAppliedRules && indicator === "Obvious";

    return html`
      <div
        class="dndm-rolllog-entry ${isNat20 ? "dndm-rolllog-entry--nat20" : ""} ${isNat1 ? "dndm-rolllog-entry--nat1" : ""}"
      >
        <div class="dndm-rolllog-meta">
          <span class="dndm-rolllog-formula">${r.formula}</span>
          <span class="dndm-rolllog-label">${r.label}</span>
          ${r.mode !== "Normal"
            ? html`<span class="dndm-rolllog-mode">${r.mode === "Advantage" ? "ADV" : "DIS"}</span>`
            : nothing}
          ${hasAppliedRules && (showSubtleCue || (this.isDm && indicator === "None"))
            ? html`<span class="dndm-rolllog-cue--subtle" title="Roll modified by Loaded Dice">●</span>`
            : nothing}
          <span class="dndm-rolllog-time">${r.timestampUtc.slice(11, 19)}</span>
          ${canReRoll
            ? html`
                <button
                  class="dndm-rolllog-reroll"
                  type="button"
                  title="Re-roll (Shift: Adv, Ctrl: Dis)"
                  @click=${(e: MouseEvent) => this.handleReRoll(r, e)}
                >
                  ↻
                </button>
              `
            : nothing}
        </div>
        <div class="dndm-rolllog-dice">
          <span class="dndm-rolllog-total">${r.total}</span>
          <div class="dndm-rolllog-dice-detail">
            ${r.rolls.map(
              (d) => html`
                <span class="dndm-die ${d.discarded ? "dndm-die--discarded" : ""}">
                  ${d.value}
                </span>
              `,
            )}
            ${r.flatModifier !== 0 || r.attributeModifier !== 0
              ? html`
                  <span class="dndm-rolllog-mod">
                    ${this.formatMod(r.flatModifier + r.attributeModifier)}
                  </span>
                `
              : nothing}
          </div>
        </div>
        ${r.modifierBreakdown
          ? html`<div class="dndm-rolllog-breakdown">${r.modifierBreakdown}</div>`
          : nothing}
        ${hasAppliedRules && showRuleStamps
          ? html`
              <div class="dndm-rolllog-stamps" style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px;">
                ${r.appliedRules.map((stamp) => {
                  const name = typeof stamp === "string" ? stamp : stamp.ruleName;
                  const type = typeof stamp === "object" ? ` (${stamp.modificationType})` : "";
                  return html`
                    <span class="dndm-rolllog-tampered-badge" title="Loaded Dice: ${name}${type}">
                      ⚡ ${name}
                    </span>
                  `;
                })}
              </div>
            `
          : nothing}
        ${showObviousCue
          ? html`<div class="dndm-rolllog-cue--obvious">⚡ Tampered by a divine hand</div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-quick-roll-footer": DndmQuickRollFooter;
  }
}
