import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  GM_TARGET_ID,
  type CharacterSheet,
  type GameMap,
  type LoadedDiceRule,
  type MapSummary,
} from "../../game/domain.js";
import { GameElement } from "../app/GameElement.js";
import "../modals/dndm-loaded-dice-modal.js";
import "./dndm-collapsible-panel.js";

@customElement("dndm-loaded-dice-panel")
export class DndmLoadedDicePanel extends GameElement {
  @property({ attribute: false })
  rules: readonly LoadedDiceRule[] = [];

  @property({ attribute: false })
  sheets: Readonly<Record<string, CharacterSheet>> = {};

  @property({ attribute: false })
  maps: readonly (GameMap | MapSummary)[] = [];

  @property({ attribute: false })
  hostHeldKeys: readonly string[] = [];

  @property({ attribute: false })
  onCreateRule?: (rule: Omit<LoadedDiceRule, "id">) => void;

  @property({ attribute: false })
  onUpdateRule?: (ruleId: string, patch: Partial<LoadedDiceRule>) => void;

  @property({ attribute: false })
  onDeleteRule?: (ruleId: string) => void;

  @property({ attribute: false })
  onToggleRule?: (ruleId: string, enabled: boolean) => void;

  @property({ attribute: false })
  onReorderRules?: (ruleIds: readonly string[]) => void;

  @state() private modalOpen = false;
  @state() private editingRule: LoadedDiceRule | null = null;
  @state() private dragIndex: number | null = null;

  private getTargetBadge(rule: LoadedDiceRule): string {
    if (!rule.targetSheetIds || rule.targetSheetIds.length === 0) {
      return "All";
    }
    if (rule.targetSheetIds.includes(GM_TARGET_ID)) {
      return "GM";
    }
    const names = rule.targetSheetIds
      .map((id) => this.sheets[id]?.characterName || "Unknown")
      .join(", ");
    return names || "Targeted";
  }

  private openCreateModal(): void {
    this.editingRule = null;
    this.modalOpen = true;
  }

  private openEditModal(rule: LoadedDiceRule): void {
    this.editingRule = rule;
    this.modalOpen = true;
  }

  private closeModal(): void {
    this.modalOpen = false;
    this.editingRule = null;
  }

  private handleSaveRule(ruleData: Omit<LoadedDiceRule, "id">, ruleId?: string): void {
    if (ruleId) {
      this.onUpdateRule?.(ruleId, ruleData);
    } else {
      this.onCreateRule?.(ruleData);
    }
  }

  private moveRule(index: number, direction: -1 | 1): void {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= this.rules.length) return;

    const ids = this.rules.map((r) => r.id);
    const temp = ids[index];
    ids[index] = ids[targetIdx];
    ids[targetIdx] = temp;

    this.onReorderRules?.(ids);
  }

  private handleDragStart(index: number, e: DragEvent): void {
    this.dragIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    }
  }

  private handleDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
  }

  private handleDrop(dropIndex: number, e: DragEvent): void {
    e.preventDefault();
    if (this.dragIndex === null || this.dragIndex === dropIndex) return;

    const ids = [...this.rules.map((r) => r.id)];
    const [movedId] = ids.splice(this.dragIndex, 1);
    ids.splice(dropIndex, 0, movedId);

    this.dragIndex = null;
    this.onReorderRules?.(ids);
  }

  override render(): TemplateResult {
    const rules = this.rules ?? [];
    const heldKeys = this.hostHeldKeys ?? [];

    return html`
      <dndm-collapsible-panel
        panelTitle=${`Loaded Dice (${rules.length})`}
        panelClass="dndm-loaded-dice"
        bodyStyle="display: flex; flex-direction: column; gap: var(--dndm-spacing-xs);"
        .actions=${html`
          <button
            class="dndm-btn dndm-btn--small dndm-btn--primary"
            type="button"
            title="Create a new loaded dice rule"
            @click=${this.openCreateModal}
          >
            + Rule
          </button>
        `}
        .content=${html`
          <!-- Held Keys Indicator Bar -->
          <div class="dndm-loaded-keys-bar" title="Keystrokes held by the host DM for trigger conditions">
            <span>Held keys:</span>
            ${heldKeys.length === 0
              ? html`<span style="font-style: italic; opacity: 0.7;">none</span>`
              : heldKeys.map(
                  (k) => html`<span class="dndm-held-key-indicator dndm-held-key-indicator--active">${k}</span>`,
                )}
          </div>

          <!-- Rule List -->
          ${rules.length === 0
            ? html`<div class="dndm-panel-empty">No loaded dice rules authored.</div>`
            : html`
                <div class="dndm-loaded-rule-list">
                  ${rules.map((rule, idx) => this.renderRuleCard(rule, idx))}
                </div>
              `}
        `}
      ></dndm-collapsible-panel>

      <dndm-loaded-dice-modal
        .isOpen=${this.modalOpen}
        .rule=${this.editingRule}
        .sheets=${this.sheets}
        .maps=${this.maps}
        .onSave=${(data: Omit<LoadedDiceRule, "id">, id?: string) => this.handleSaveRule(data, id)}
        .onClose=${() => this.closeModal()}
        .onCancel=${() => this.closeModal()}
        @close=${() => this.closeModal()}
        @cancel=${() => this.closeModal()}
      ></dndm-loaded-dice-modal>
    `;
  }

  private renderRuleCard(rule: LoadedDiceRule, index: number): TemplateResult {
    const targetBadge = this.getTargetBadge(rule);
    const isFirst = index === 0;
    const isLast = index === this.rules.length - 1;

    return html`
      <div
        class="dndm-loaded-rule-card ${rule.enabled ? "" : "dndm-loaded-rule-card--disabled"}"
        draggable="true"
        @dragstart=${(e: DragEvent) => this.handleDragStart(index, e)}
        @dragover=${this.handleDragOver}
        @drop=${(e: DragEvent) => this.handleDrop(index, e)}
      >
        <span class="dndm-loaded-rule-drag-handle" title="Drag to reorder precedence">⋮⋮</span>

        <div class="dndm-loaded-rule-main">
          <span class="dndm-loaded-rule-name" title=${rule.name}>${rule.name}</span>
          <div class="dndm-loaded-rule-meta">
            <span class="dndm-loaded-rule-badge">${targetBadge}</span>
            ${rule.conditions.map(
              (c) => html`
                <span class="dndm-loaded-rule-badge dndm-loaded-rule-badge--condition">
                  ${c.$kind === "hostKeyHeld" ? `[${c.key}]` : c.$kind}
                </span>
              `,
            )}
            ${rule.modifications.map(
              (m) => html`
                <span class="dndm-loaded-rule-badge dndm-loaded-rule-badge--mod">
                  ${m.$kind === "setResult" ? `=${m.value}` : m.$kind}
                </span>
              `,
            )}
          </div>
        </div>

        <div class="dndm-loaded-rule-actions">
          <button
            class="dndm-btn dndm-btn--ghost dndm-btn--small"
            style="padding: 1px 4px; font-size: 0.65rem;"
            type="button"
            title="Move up"
            ?disabled=${isFirst}
            @click=${() => this.moveRule(index, -1)}
          >
            ▲
          </button>
          <button
            class="dndm-btn dndm-btn--ghost dndm-btn--small"
            style="padding: 1px 4px; font-size: 0.65rem;"
            type="button"
            title="Move down"
            ?disabled=${isLast}
            @click=${() => this.moveRule(index, 1)}
          >
            ▼
          </button>

          <input
            type="checkbox"
            title="Enable/disable rule"
            ?checked=${rule.enabled}
            @change=${(e: Event) => {
              this.onToggleRule?.(rule.id, (e.target as HTMLInputElement).checked);
            }}
          />

          <button
            class="dndm-btn dndm-btn--ghost dndm-btn--small"
            style="padding: 2px 5px;"
            type="button"
            title="Edit rule"
            @click=${() => this.openEditModal(rule)}
          >
            ✎
          </button>

          <button
            class="dndm-btn dndm-btn--ghost dndm-btn--small"
            style="padding: 2px 5px; color: var(--dndm-color-danger);"
            type="button"
            title="Delete rule"
            @click=${() => this.onDeleteRule?.(rule.id)}
          >
            ✕
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-loaded-dice-panel": DndmLoadedDicePanel;
  }
}
