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
  @state() private attrsExpanded = false;

  @state() private customCount = 1;
  @state() private customSides = 20;
  @state() private customModifier = 0;
  @state() private customFormulaInput = "";
  @state() private selectedMode: RollMode = "Normal";

  private unsubscribeTracker: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeTracker = diceAnimationTracker.subscribe(() => {
      this.requestUpdate();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeTracker?.();
    this.unsubscribeTracker = null;
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

  private handleDieClick(sides: number, e: MouseEvent): void {
    let mode: RollMode = this.selectedMode;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      mode = "Advantage";
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      mode = "Disadvantage";
    }

    const formula = `1d${sides}`;
    const label = `d${sides} Roll`;
    this.onRollDice?.(formula, mode, label, this.assignedSheet?.id ?? null, null);
  }

  private handleCustomRoll(): void {
    if (this.customFormulaInput.trim().length > 0) {
      this.onRollDice?.(
        this.customFormulaInput.trim(),
        this.selectedMode,
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
      this.selectedMode,
      "Dice Roll",
      this.assignedSheet?.id ?? null,
      null,
    );
  }

  private handleAttributeRoll(row: AttributeRow, e: MouseEvent): void {
    const sheet = this.assignedSheet;
    if (!sheet) return;

    let mode: RollMode = this.selectedMode;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      mode = "Advantage";
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      mode = "Disadvantage";
    }

    this.onRollDice?.("1d20", mode, `${row.name} Check`, sheet.id, row.name);
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

    return html`
      <div class="dndm-rollfooter ${this.logOpen || this.presetsOpen ? "dndm-rollfooter--popover" : ""}">
        <!-- Recent rolls popover toggle -->
        <button
          class="dndm-rollfooter__log"
          type="button"
          title=${this.logOpen ? "Hide recent rolls" : "Show recent rolls"}
          @click=${() => {
            this.logOpen = !this.logOpen;
            if (this.logOpen) this.presetsOpen = false;
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

        <!-- Dice options popover toggle -->
        <button
          class="dndm-rollfooter__gear"
          type="button"
          title=${this.presetsOpen ? "Hide dice options" : "Dice options & presets"}
          @click=${() => {
            this.presetsOpen = !this.presetsOpen;
            if (this.presetsOpen) this.logOpen = false;
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
                            this.onRollTemplate?.(t.id, this.selectedMode, sheet?.id ?? null);
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

        <!-- Sound toggle -->
        <button
          class="dndm-rollfooter__sound ${this.soundEnabled ? "dndm-rollfooter__sound--active" : ""}"
          type="button"
          title=${this.soundEnabled ? "Dice sounds: On (click to mute)" : "Dice sounds: Muted (click to enable)"}
          @click=${() => this.onToggleSound?.()}
        >
          ${volumeIcon(!this.soundEnabled)}
        </button>

        <!-- Polyhedral Dice Buttons -->
        <div class="dndm-rollfooter__polygroup">
          ${POLYHEDRAL_DICE.map(
            (sides) => html`
              <button
                class="dndm-rollfooter__diebtn"
                type="button"
                title="Roll d${sides} (Shift: Adv, Ctrl: Dis)"
                @click=${(e: MouseEvent) => this.handleDieClick(sides, e)}
              >
                d${sides}
              </button>
            `,
          )}
        </div>

        <!-- Mode selector chips -->
        <div class="dndm-rollfooter__mode-chips">
          <button
            class="dndm-rollfooter__mode-chip ${this.selectedMode === "Normal" ? "dndm-rollfooter__mode-chip--active" : ""}"
            type="button"
            @click=${() => (this.selectedMode = "Normal")}
          >
            Normal
          </button>
          <button
            class="dndm-rollfooter__mode-chip ${this.selectedMode === "Advantage" ? "dndm-rollfooter__mode-chip--active" : ""}"
            type="button"
            @click=${() => (this.selectedMode = "Advantage")}
          >
            Adv
          </button>
          <button
            class="dndm-rollfooter__mode-chip ${this.selectedMode === "Disadvantage" ? "dndm-rollfooter__mode-chip--active" : ""}"
            type="button"
            @click=${() => (this.selectedMode = "Disadvantage")}
          >
            Dis
          </button>
        </div>

        <!-- Custom formula or dice input -->
        <input
          class="dndm-input dndm-rollfooter__custom-formula"
          placeholder="e.g. 4d6+5"
          .value=${this.customFormulaInput}
          @input=${(e: Event) =>
            (this.customFormulaInput = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") this.handleCustomRoll();
          }}
        />

        <button
          class="dndm-rollfooter__rollbtn"
          type="button"
          @click=${() => this.handleCustomRoll()}
        >
          ${dieIcon()} Roll
        </button>

        <!-- Attribute quick rolls expander -->
        ${numericRows.length > 0
          ? html`
              <button
                class="dndm-rollfooter__arrow"
                type="button"
                title=${this.attrsExpanded ? "Hide attributes" : "Quick attribute rolls"}
                @click=${() => (this.attrsExpanded = !this.attrsExpanded)}
              >
                ${chevronIcon(this.attrsExpanded ? "down" : "right")} Attributes
              </button>
            `
          : nothing}

        <span class="dndm-rollfooter__hint">Shift = Adv · Ctrl = Dis</span>

        <!-- Attribute drawers if expanded -->
        ${this.attrsExpanded && numericRows.length > 0
          ? html`
              <div class="dndm-rollfooter__attrs dndm-rollfooter__attrs--open">
                ${numericRows.map((row) => {
                  const mod = this.getAttrModifier(row);
                  return html`
                    <button
                      class="dndm-rollfooter__attr"
                      type="button"
                      title="Roll d20 ${this.formatMod(mod)} (${row.name})"
                      @click=${(e: MouseEvent) => this.handleAttributeRoll(row, e)}
                    >
                      <span class="dndm-rollfooter__attr-name">${row.name}</span>
                      <span class="dndm-rollfooter__attr-mod">${this.formatMod(mod)}</span>
                    </button>
                  `;
                })}
              </div>
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
