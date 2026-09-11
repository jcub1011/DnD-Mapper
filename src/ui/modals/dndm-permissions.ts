import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { DEFAULT_SETTINGS, type DndMapperSettings } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import "./dndm-modal";

@customElement("dndm-permissions")
export class DndmPermissions extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ type: Boolean })
  embedded = false;

  @property({ attribute: false })
  settings: DndMapperSettings = DEFAULT_SETTINGS;

  @property({ type: Boolean })
  isDm = false;

  @property({ attribute: false })
  onUpdateSettings?: (patch: Partial<DndMapperSettings>) => void;

  @property({ attribute: false })
  onClose?: () => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @state()
  private resetArmed = false;

  private emitPatch(patch: Partial<DndMapperSettings>): void {
    this.dispatchEvent(
      new CustomEvent<Partial<DndMapperSettings>>("update-settings", {
        bubbles: true,
        composed: true,
        detail: patch,
      }),
    );
    this.onUpdateSettings?.(patch);
  }

  private handleReset = (): void => {
    if (!this.resetArmed) {
      this.resetArmed = true;
      setTimeout(() => {
        this.resetArmed = false;
      }, 3000);
      return;
    }
    this.resetArmed = false;
    this.emitPatch(DEFAULT_SETTINGS);
  };

  private handleClose = (): void => {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.onClose?.();
    this.onCancel?.();
  };

  private renderContent(): TemplateResult {
    const s = this.settings;

    return html`
      <div
        class="dndm-panel-section"
        title="Controls which players can drag and move tokens on the map"
      >
        <span class="dndm-label">Token movement</span>
        <div class="dndm-pillgroup">
          <button
            class=${s.tokenMovement === "OwnerOrHost" ? "active" : ""}
            type="button"
            title="Only the token's assigned owner and the DM can move it"
            ?disabled=${!this.isDm}
            @click=${() => this.emitPatch({ tokenMovement: "OwnerOrHost" })}
          >
            Owner / Host
          </button>
          <button
            class=${s.tokenMovement === "Anyone" ? "active" : ""}
            type="button"
            title="Any connected player can move any token on the map"
            ?disabled=${!this.isDm}
            @click=${() => this.emitPatch({ tokenMovement: "Anyone" })}
          >
            Anyone
          </button>
          <button
            class=${s.tokenMovement === "HostOnly" ? "active" : ""}
            type="button"
            title="Only the DM can move tokens on the map"
            ?disabled=${!this.isDm}
            @click=${() => this.emitPatch({ tokenMovement: "HostOnly" })}
          >
            Host only
          </button>
        </div>
      </div>

      <div
        class="dndm-panel-section"
        title="Controls who is allowed to edit character sheets owned by other players"
      >
        <span class="dndm-label">Sheet edits by others</span>
        <div class="dndm-pillgroup">
          <button
            class=${s.sheetEditByOthers === "HostOnly" ? "active" : ""}
            type="button"
            title="Only the DM can edit character sheets owned by other players"
            ?disabled=${!this.isDm}
            @click=${() => this.emitPatch({ sheetEditByOthers: "HostOnly" })}
          >
            Host only
          </button>
          <button
            class=${s.sheetEditByOthers === "OwnersAndHost" ? "active" : ""}
            type="button"
            title="Only the sheet's assigned owner and the DM can edit the sheet"
            ?disabled=${!this.isDm}
            @click=${() => this.emitPatch({ sheetEditByOthers: "OwnersAndHost" })}
          >
            Owners + Host
          </button>
          <button
            class=${s.sheetEditByOthers === "Anyone" ? "active" : ""}
            type="button"
            title="Any connected player can edit any character sheet"
            ?disabled=${!this.isDm}
            @click=${() => this.emitPatch({ sheetEditByOthers: "Anyone" })}
          >
            Anyone
          </button>
        </div>
      </div>

      <div class="dndm-panel-section">
        <label
          class="dndm-toggle"
          title="When enabled, player dice rolls appear in the shared roll log"
        >
          <input
            type="checkbox"
            ?checked=${s.rollsVisibleToPlayers}
            ?disabled=${!this.isDm}
            @change=${(e: Event) =>
              this.emitPatch({ rollsVisibleToPlayers: (e.target as HTMLInputElement).checked })}
          />
          <span class="dndm-toggle-track"></span>
          <span>Rolls visible to players</span>
        </label>
      </div>

      <div class="dndm-panel-section">
        <label
          class="dndm-toggle"
          title="When enabled, non-DM players can create new NPC tokens on the map"
        >
          <input
            type="checkbox"
            ?checked=${s.playersCanCreateNPCs}
            ?disabled=${!this.isDm}
            @change=${(e: Event) =>
              this.emitPatch({ playersCanCreateNPCs: (e.target as HTMLInputElement).checked })}
          />
          <span class="dndm-toggle-track"></span>
          <span>Players can create NPCs</span>
        </label>
      </div>

      <div class="dndm-panel-section">
        <label
          class="dndm-toggle"
          title="When enabled, players can view character sheets belonging to other players"
        >
          <input
            type="checkbox"
            ?checked=${s.playersCanSeeOtherSheets}
            ?disabled=${!this.isDm}
            @change=${(e: Event) =>
              this.emitPatch({ playersCanSeeOtherSheets: (e.target as HTMLInputElement).checked })}
          />
          <span class="dndm-toggle-track"></span>
          <span>Players can see other players' sheets</span>
        </label>
      </div>

      <div class="dndm-panel-section">
        <label class="dndm-toggle" title="When on, rules under Loaded Dice rewrite dice results.">
          <input
            type="checkbox"
            ?checked=${s.loadedDiceEnabled}
            ?disabled=${!this.isDm}
            @change=${(e: Event) =>
              this.emitPatch({ loadedDiceEnabled: (e.target as HTMLInputElement).checked })}
          />
          <span class="dndm-toggle-track"></span>
          <span>Loaded dice</span>
        </label>
      </div>

      <div
        class="dndm-panel-section"
        title="Controls which players can see loaded dice rules and roll modifications in the log"
      >
        <span class="dndm-label">Rule visibility</span>
        <div class="dndm-pillgroup">
          <button
            class=${s.loadedDiceRuleVisibility === "Hidden" ? "active" : ""}
            type="button"
            title="Loaded dice rules and stamps are hidden from players in the roll log"
            ?disabled=${!this.isDm || !s.loadedDiceEnabled}
            @click=${() => this.emitPatch({ loadedDiceRuleVisibility: "Hidden" })}
          >
            Hidden
          </button>
          <button
            class=${s.loadedDiceRuleVisibility === "VisibleToHostOnly" || s.loadedDiceRuleVisibility === "HostOnly" ? "active" : ""}
            type="button"
            title="Loaded dice rules and stamps are visible only to the DM"
            ?disabled=${!this.isDm || !s.loadedDiceEnabled}
            @click=${() => this.emitPatch({ loadedDiceRuleVisibility: "VisibleToHostOnly" })}
          >
            Host only
          </button>
          <button
            class=${s.loadedDiceRuleVisibility === "VisibleToAll" || s.loadedDiceRuleVisibility === "AllPlayers" ? "active" : ""}
            type="button"
            title="All players can see loaded dice rules applied to rolls in the log"
            ?disabled=${!this.isDm || !s.loadedDiceEnabled}
            @click=${() => this.emitPatch({ loadedDiceRuleVisibility: "VisibleToAll" })}
          >
            All players
          </button>
        </div>
      </div>

      <div
        class="dndm-panel-section"
        title="Visual cue shown to players when a dice roll was rewritten by a loaded dice rule"
      >
        <span class="dndm-label">Player indicator on modified rolls</span>
        <div class="dndm-pillgroup">
          <button
            class=${s.loadedDicePlayerIndicator === "None" || s.loadedDicePlayerIndicator === "Hidden" ? "active" : ""}
            type="button"
            title="No indicator shown; modified rolls appear completely normal"
            ?disabled=${!this.isDm || !s.loadedDiceEnabled}
            @click=${() => this.emitPatch({ loadedDicePlayerIndicator: "None" })}
          >
            None
          </button>
          <button
            class=${s.loadedDicePlayerIndicator === "Subtle" || s.loadedDicePlayerIndicator === "RedDotInLog" ? "active" : ""}
            type="button"
            title="Shows a subtle dot in the roll log indicating the roll was modified"
            ?disabled=${!this.isDm || !s.loadedDiceEnabled}
            @click=${() => this.emitPatch({ loadedDicePlayerIndicator: "Subtle" })}
          >
            Subtle
          </button>
          <button
            class=${s.loadedDicePlayerIndicator === "Obvious" ? "active" : ""}
            type="button"
            title="Clearly marks modified rolls with an obvious visual cue in the roll log"
            ?disabled=${!this.isDm || !s.loadedDiceEnabled}
            @click=${() => this.emitPatch({ loadedDicePlayerIndicator: "Obvious" })}
          >
            Obvious
          </button>
        </div>
      </div>

      ${
        this.isDm
          ? html`
              <div class="dndm-panel-section dndm-permp-reset">
                <button
                  class="dndm-btn ${this.resetArmed ? "dndm-btn--danger" : "dndm-btn--ghost"}"
                  type="button"
                  @click=${this.handleReset}
                  title="Restore all settings to their defaults"
                >
                  ${this.resetArmed ? "⚠ Click again to confirm" : "↺ Reset to Defaults"}
                </button>
              </div>
            `
          : nothing
      }
    `;
  }

  override render(): TemplateResult | typeof nothing {
    if (this.embedded) {
      return html`
        <div class="card dndm-permp dndm-permp--embedded">
          <h4>Game Settings</h4>
          <div class="dndm-panel-body">${this.renderContent()}</div>
        </div>
      `;
    }

    if (!this.isOpen) return nothing;

    return html`
      <dndm-modal
        .isOpen=${this.isOpen}
        .modalTitle=${"Settings"}
        cardClass="dndm-permp"
        @close=${this.handleClose}
        .body=${this.renderContent()}
        .footer=${html`
          <button class="dndm-btn dndm-btn--primary" type="button" @click=${this.handleClose}>
            Close
          </button>
        `}
      ></dndm-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-permissions": DndmPermissions;
  }
}
