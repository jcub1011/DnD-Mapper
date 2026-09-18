import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { getReadableTextColor } from "../../game/color.js";
import type {
  CharacterSheet,
  CombatantEntry,
  CombatState,
  GameMap,
  Token,
} from "../../game/domain.js";
import { isFullMap } from "../../game/domain.js";
import { GameElement } from "../app/GameElement.js";
import "./dndm-collapsible-panel.js";

@customElement("dndm-host-initiative")
export class DndmHostInitiative extends GameElement {
  @property({ attribute: false })
  combat: CombatState | null = null;

  @property({ attribute: false })
  activeMap: GameMap | null = null;

  @property({ attribute: false })
  sheets: Readonly<Record<string, CharacterSheet>> = {};

  @property({ type: Boolean })
  isDm = false;

  @property({ type: String })
  currentUserId: string | null = null;

  @property({ attribute: false })
  onStartCombat?: (mapId: string) => void;

  @property({ attribute: false })
  onEndCombat?: () => void;

  @property({ attribute: false })
  onNextTurn?: () => void;

  @property({ attribute: false })
  onPreviousTurn?: () => void;

  @property({ attribute: false })
  onRollInitiative?: (combatantId: string) => void;

  @property({ attribute: false })
  onForceRoll?: (combatantId: string) => void;

  @property({ attribute: false })
  onSetNpcInitiative?: (combatantId: string, score: number) => void;

  @property({ attribute: false })
  onRollAllUnsetNpcs?: () => void;

  @property({ attribute: false })
  onRollAllNpcInitiative?: () => void;

  @property({ attribute: false })
  onAddCombatant?: (tokenId: string, initiativeRoll: number) => void;

  @property({ attribute: false })
  onRemoveCombatant?: (combatantId: string) => void;

  @property({ attribute: false })
  onFocusToken?: (tokenId: string) => void;

  @property({ attribute: false })
  onSetSheetHp?: (sheetId: string, hp: number | null) => void;

  @state()
  private confirmingEnd = false;

  @state()
  private selectedTokenToAdd: string = "";

  @state()
  private newCombatantInit: number = 10;

  @state()
  private pendingInitScores: Record<string, number> = {};

  private getToken(tokenId: string): Token | null {
    if (!this.activeMap || !isFullMap(this.activeMap)) return null;
    return this.activeMap.tokens.find((t) => t.id === tokenId) ?? null;
  }

  private getSheet(token: Token | null): CharacterSheet | null {
    if (!token?.sheetId) return null;
    return this.sheets[token.sheetId] ?? null;
  }

  private handleRowClick(combatant: CombatantEntry): void {
    this.onFocusToken?.(combatant.tokenId);
  }

  private handleHpChange(sheetId: string, e: Event): void {
    const input = e.target as HTMLInputElement;
    const val = parseInt(input.value, 10);
    this.onSetSheetHp?.(sheetId, isNaN(val) ? null : val);
  }

  private handleStagePending(combatantId: string, e: Event): void {
    const input = e.target as HTMLInputElement;
    const val = parseInt(input.value, 10);
    if (!isNaN(val)) {
      this.pendingInitScores = { ...this.pendingInitScores, [combatantId]: val };
      this.onSetNpcInitiative?.(combatantId, val);
    }
  }

  private handleAddCombatant(): void {
    if (!this.selectedTokenToAdd) return;
    this.onAddCombatant?.(this.selectedTokenToAdd, this.newCombatantInit);
    this.selectedTokenToAdd = "";
    this.newCombatantInit = 10;
  }

  private renderAddCombatantSection(): TemplateResult {
    if (!this.activeMap || !isFullMap(this.activeMap)) return html`${nothing}`;
    const enrolledTokenIds = new Set(this.combat?.turnOrder.map((c) => c.tokenId) ?? []);
    const availableTokens = this.activeMap.tokens.filter((t) => !enrolledTokenIds.has(t.id));

    if (availableTokens.length === 0) return html`${nothing}`;

    return html`
      <div class="dndm-initiative-add-box">
        <select
          class="dndm-initiative-add-select"
          .value=${this.selectedTokenToAdd}
          @change=${(e: Event) => {
            this.selectedTokenToAdd = (e.target as HTMLSelectElement).value;
          }}
        >
          <option value="">+ Add Token to Combat…</option>
          ${availableTokens.map(
            (t) => html`<option value=${t.id}>${t.name || "Unnamed Token"}</option>`,
          )}
        </select>
        <input
          type="number"
          class="dndm-pending-init-input"
          title="Initiative Score"
          .value=${String(this.newCombatantInit)}
          @change=${(e: Event) => {
            const v = parseInt((e.target as HTMLInputElement).value, 10);
            this.newCombatantInit = isNaN(v) ? 10 : v;
          }}
        />
        <button
          type="button"
          class="dndm-btn dndm-btn--small dndm-btn--primary"
          ?disabled=${!this.selectedTokenToAdd}
          @click=${this.handleAddCombatant}
        >
          Add
        </button>
      </div>
    `;
  }

  override render(): TemplateResult {
    if (!this.combat) {
      return html`
        <dndm-collapsible-panel
          panelTitle="Initiative & Combat"
          panelClass="dndm-initiative-panel"
          bodyClass="dndm-initiative-empty"
          .content=${html`
            <span>No encounter currently running.</span>
            ${this.isDm && this.activeMap
              ? html`
                  <button
                    type="button"
                    class="dndm-btn dndm-btn--primary dndm-btn--small"
                    @click=${() => this.activeMap && this.onStartCombat?.(this.activeMap.id)}
                  >
                    Start Combat Encounter
                  </button>
                `
              : nothing}
          `}
        ></dndm-collapsible-panel>
      `;
    }

    const { phase, roundNumber, currentTurnIndex, turnOrder } = this.combat;
    const isWaiting = phase === "WaitingForRolls";

    return html`
      <dndm-collapsible-panel
        panelTitle="Combat Tracker"
        panelClass="dndm-initiative-panel"
        .actions=${html`
          <div class="dndm-panel-header-actions">
            ${this.confirmingEnd
              ? html`
                  <button
                    type="button"
                    class="dndm-btn dndm-btn--small dndm-btn--danger"
                    @click=${() => {
                      this.confirmingEnd = false;
                      this.onEndCombat?.();
                    }}
                  >
                    Confirm End
                  </button>
                  <button
                    type="button"
                    class="dndm-btn dndm-btn--small dndm-btn--ghost"
                    @click=${() => {
                      this.confirmingEnd = false;
                    }}
                  >
                    Cancel
                  </button>
                `
              : html`
                  <button
                    type="button"
                    class="dndm-btn dndm-btn--small dndm-btn--ghost"
                    title="End Combat Encounter"
                    @click=${() => {
                      this.confirmingEnd = true;
                    }}
                  >
                    End Combat
                  </button>
                `}
          </div>
        `}
        .content=${html`
          <!-- Round & Turn Navigation Bar -->
          <div class="dndm-initiative-round-bar">
            <div class="dndm-initiative-round-title">
              <span>Round ${roundNumber}</span>
              <span class="dndm-badge ${isWaiting ? "dndm-badge--warning" : "dndm-badge--success"}">
                ${isWaiting ? "Rolling Initiative" : "Active"}
              </span>
            </div>
            <div class="dndm-initiative-round-nav">
              <button
                type="button"
                class="dndm-btn dndm-btn--icon dndm-btn--small"
                title="Previous Turn (<)"
                ?disabled=${isWaiting || turnOrder.length === 0}
                @click=${() => this.onPreviousTurn?.()}
              >
                ◀
              </button>
              <button
                type="button"
                class="dndm-btn dndm-btn--icon dndm-btn--small"
                title="Next Turn (>)"
                ?disabled=${isWaiting || turnOrder.length === 0}
                @click=${() => this.onNextTurn?.()}
              >
                ▶
              </button>
            </div>
          </div>

          <!-- Roll Actions Bar when Waiting -->
          ${isWaiting
            ? html`
                <div style="display: flex; gap: 6px; margin-bottom: 6px;">
                  <button
                    type="button"
                    class="dndm-btn dndm-btn--small dndm-btn--ghost"
                    style="flex: 1;"
                    @click=${() => this.onRollAllUnsetNpcs?.()}
                  >
                    Roll All Unset NPCs
                  </button>
                </div>
              `
            : nothing}

          <!-- Combatants Roster -->
          <div class="dndm-combatant-roster">
            ${turnOrder.map((c, idx) => {
              const token = this.getToken(c.tokenId);
              const sheet = this.getSheet(token);
              const isActive = !isWaiting && idx === currentTurnIndex;
              const effectiveColor =
                sheet?.color && sheet.color.trim().length > 0
                  ? sheet.color
                  : token?.color ?? "#888888";
              const textColor = getReadableTextColor(effectiveColor);
              const initial = c.name.trim().length > 0 ? c.name.trim()[0].toUpperCase() : "?";

              return html`
                <div
                  class="dndm-combatant-card ${isActive ? "dndm-combatant-card--active" : ""}"
                  @click=${() => this.handleRowClick(c)}
                >
                  <!-- Avatar -->
                  <div
                    class="dndm-combatant-avatar"
                    style="background-color: ${effectiveColor}; color: ${textColor};"
                    title=${c.name}
                  >
                    ${initial}
                  </div>

                  <!-- Info -->
                  <div class="dndm-combatant-info">
                    <span class="dndm-combatant-name" title=${c.name}>
                      ${c.name}
                    </span>
                    <div class="dndm-combatant-meta">
                      ${sheet && sheet.hp !== null
                        ? html`
                            <span class="dndm-hp-quick-edit" @click=${(e: Event) => e.stopPropagation()}>
                              HP:
                              <input
                                type="number"
                                class="dndm-hp-input"
                                .value=${String(sheet.hp)}
                                @change=${(e: Event) => sheet && this.handleHpChange(sheet.id, e)}
                              />
                              ${sheet.maxHp !== null ? `/${sheet.maxHp}` : nothing}
                            </span>
                          `
                        : nothing}
                      ${sheet && sheet.armorClass !== null
                        ? html`<span class="dndm-combatant-badge dndm-combatant-badge--ac">AC ${sheet.armorClass}</span>`
                        : nothing}
                      ${sheet && sheet.statusEffects.length > 0
                        ? sheet.statusEffects.map(
                            (eff) =>
                              html`<span class="dndm-badge dndm-badge--accent" title=${eff.name}>${eff.name}</span>`,
                          )
                        : nothing}
                    </div>
                  </div>

                  <!-- Initiative Badge / Controls -->
                  <div class="dndm-combatant-stats" @click=${(e: Event) => e.stopPropagation()}>
                    ${c.initiativeRoll !== null
                      ? html`
                          <span
                            class="dndm-combatant-badge dndm-combatant-badge--init"
                            title=${c.isForceRolled ? "Force Rolled" : "Initiative"}
                          >
                            ${c.initiativeRoll}
                          </span>
                        `
                      : c.pendingInitiative !== null
                        ? html`
                            <span
                              class="dndm-combatant-badge dndm-combatant-badge--pending"
                              title="Staged Pending Initiative"
                            >
                              P:${c.pendingInitiative}
                            </span>
                          `
                        : c.ownerUserId === null
                          ? html`
                              <input
                                type="number"
                                class="dndm-pending-init-input"
                                placeholder="Init"
                                title="Stage NPC score"
                                .value=${this.pendingInitScores[c.id] !== undefined
                                  ? String(this.pendingInitScores[c.id])
                                  : ""}
                                @change=${(e: Event) => this.handleStagePending(c.id, e)}
                              />
                              <button
                                type="button"
                                class="dndm-btn dndm-btn--small dndm-btn--ghost"
                                title="Roll Initiative for NPC"
                                @click=${() => this.onRollInitiative?.(c.id)}
                              >
                                Roll
                              </button>
                            `
                          : html`
                              <button
                                type="button"
                                class="dndm-btn dndm-btn--small dndm-btn--ghost"
                                title="Force Player Roll"
                                @click=${() => this.onForceRoll?.(c.id)}
                              >
                                Force
                              </button>
                            `}
                  </div>

                  <!-- Actions -->
                  <div class="dndm-combatant-actions" @click=${(e: Event) => e.stopPropagation()}>
                    <button
                      type="button"
                      class="dndm-btn dndm-btn--icon dndm-btn--small"
                      title="Remove from Combat"
                      @click=${() => this.onRemoveCombatant?.(c.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              `;
            })}
          </div>

          <!-- Add Combatant Dropdown -->
          ${this.renderAddCombatantSection()}
        `}
      ></dndm-collapsible-panel>
    `;
  }
}
