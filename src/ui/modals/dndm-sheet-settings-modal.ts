import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CharacterSheet, GameMap, MapSummary } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import "./dndm-confirm";
import "./dndm-modal";

export interface SheetSettingsPatch {
  characterName: string;
  color: string;
  ownerUserId: string | null;
  representsUserId: string | null;
  scopedMapId: string | null;
}

@customElement("dndm-sheet-settings-modal")
export class DndmSheetSettingsModal extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ attribute: false })
  sheet: CharacterSheet | null = null;

  @property({ attribute: false })
  roster: readonly { id: string; name: string }[] = [];

  @property({ type: String })
  dmPlayerId: string | null = null;

  @property({ attribute: false })
  maps: readonly (GameMap | MapSummary)[] = [];

  @property({ type: Boolean })
  isDm = false;

  @property({ attribute: false })
  onSave?: (patch: SheetSettingsPatch) => void;

  @property({ attribute: false })
  onDelete?: (sheetId: string) => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @property({ attribute: false })
  onClose?: () => void;

  @state() private characterName = "";
  @state() private color = "#4a90e2";
  @state() private ownerUserId: string | null = null;
  @state() private representsUserId: string | null = null;
  @state() private scopedMapId: string | null = null;
  @state() private confirmDelete = false;

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("sheet") && this.sheet) {
      this.characterName = this.sheet.characterName;
      this.color = this.sheet.color || "#4a90e2";
      this.ownerUserId = this.sheet.ownerUserId;
      this.representsUserId = this.sheet.representsUserId;
      this.scopedMapId = this.sheet.scopedMapId;
      this.confirmDelete = false;
    }
  }

  private handleSave = (): void => {
    const patch: SheetSettingsPatch = {
      characterName: this.characterName.trim() || "Unnamed Character",
      color: this.color,
      ownerUserId: this.ownerUserId,
      representsUserId: this.representsUserId,
      scopedMapId: this.scopedMapId,
    };

    this.isOpen = false;
    this.dispatchEvent(
      new CustomEvent<SheetSettingsPatch>("save", {
        bubbles: true,
        composed: true,
        detail: patch,
      }),
    );
    this.onSave?.(patch);
  };

  private handleDelete = (): void => {
    if (!this.sheet) return;
    const sheetId = this.sheet.id;
    this.confirmDelete = false;
    this.isOpen = false;
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string }>("delete", {
        bubbles: true,
        composed: true,
        detail: { sheetId },
      }),
    );
    this.onDelete?.(sheetId);
  };

  private handleCancel = (): void => {
    this.confirmDelete = false;
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    this.onCancel?.();
    this.onClose?.();
  };

  override render(): TemplateResult {
    // The host is not a player, so it is never an assignable owner.
    const assignableRoster =
      this.dmPlayerId === null ? this.roster : this.roster.filter((p) => p.id !== this.dmPlayerId);
    return html`
      <dndm-modal
        .isOpen=${this.isOpen && !!this.sheet}
        .modalTitle=${this.sheet ? `Sheet Settings — ${this.sheet.characterName}` : "Sheet Settings"}
        cardStyle="max-width: 640px; width: 100%;"
        @close=${this.handleCancel}
        .body=${html`
          <div style="display: flex; flex-direction: column; gap: 10px;">
            <label class="dndm-label">
              Character Name
              <input
                type="text"
                class="dndm-input"
                .value=${this.characterName}
                @input=${(e: Event) => {
                  this.characterName = (e.target as HTMLInputElement).value;
                }}
              />
            </label>

            <label class="dndm-label" title="Picking a color here overrides the name-seeded color for the sheet and its linked token.">
              Token &amp; Accent Color
              <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                <input
                  type="color"
                  class="dndm-input"
                  style="width: 44px; height: 32px; padding: 2px; cursor: pointer;"
                  .value=${this.color}
                  @input=${(e: Event) => {
                    this.color = (e.target as HTMLInputElement).value;
                  }}
                />
                <span style="font-family: var(--font-mono); font-size: 0.85rem;"
                  >${this.color}</span
                >
              </div>
            </label>

            ${
              this.isDm
                ? html`
                    <label class="dndm-label">
                      Assigned Owner
                      <select
                        class="dndm-select"
                        style="width: 100%; margin-top: 4px;"
                        @change=${(e: Event) => {
                        const val = (e.target as HTMLSelectElement).value;
                        this.ownerUserId = val ? val : null;
                      }}
                      >
                        <option value="" ?selected=${(this.ownerUserId ?? "") === ""}>
                          Unassigned (NPC / DM Controlled)
                        </option>
                        ${assignableRoster.map(
                          (p) =>
                            html`<option value=${p.id} ?selected=${(this.ownerUserId ?? "") === p.id}>
                              ${p.name}
                            </option>`,
                        )}
                      </select>
                    </label>

                    <label class="dndm-label">
                      Represents Player
                      <select
                        class="dndm-select"
                        style="width: 100%; margin-top: 4px;"
                        @change=${(e: Event) => {
                        const val = (e.target as HTMLSelectElement).value;
                        this.representsUserId = val ? val : null;
                      }}
                      >
                        <option value="" ?selected=${(this.representsUserId ?? "") === ""}>
                          None
                        </option>
                        ${assignableRoster.map(
                          (p) =>
                            html`<option
                              value=${p.id}
                              ?selected=${(this.representsUserId ?? "") === p.id}
                            >
                              ${p.name}
                            </option>`,
                        )}
                      </select>
                    </label>

                    <label class="dndm-label">
                      Map Scope
                      <select
                        class="dndm-select"
                        style="width: 100%; margin-top: 4px;"
                        @change=${(e: Event) => {
                        const val = (e.target as HTMLSelectElement).value;
                        this.scopedMapId = val ? val : null;
                      }}
                      >
                        <option value="" ?selected=${(this.scopedMapId ?? "") === ""}>
                          Global (All Maps)
                        </option>
                        ${this.maps.map(
                          (m) =>
                            html`<option value=${m.id} ?selected=${(this.scopedMapId ?? "") === m.id}>
                              ${m.name}
                            </option>`,
                        )}
                      </select>
                    </label>
                  `
                : nothing
            }
          </div>
        `}
        .footer=${html`
          <div style="display: flex; justify-content: space-between; width: 100%;">
            <div>
              ${
                this.isDm
                  ? html`
                      <button
                        class="dndm-btn dndm-btn--danger"
                        type="button"
                        @click=${() => {
                        this.confirmDelete = true;
                      }}
                      >
                        Delete Sheet
                      </button>
                    `
                  : nothing
              }
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="dndm-btn dndm-btn--ghost" type="button" @click=${this.handleCancel}>
                Cancel
              </button>
              <button class="dndm-btn dndm-btn--primary" type="button" @click=${this.handleSave}>
                Save
              </button>
            </div>
          </div>
        `}
      ></dndm-modal>

      <dndm-confirm
        .isOpen=${this.confirmDelete}
        modalTitle="Delete Character Sheet"
        message=${`Are you sure you want to delete '${this.sheet?.characterName}'? All tokens linked to it, on every map, will also be deleted.`}
        confirmText="Delete"
        @confirm=${this.handleDelete}
        @cancel=${() => {
          this.confirmDelete = false;
        }}
        @close=${() => {
          this.confirmDelete = false;
        }}
        .onCancel=${() => {
          this.confirmDelete = false;
        }}
        .onClose=${() => {
          this.confirmDelete = false;
        }}
      ></dndm-confirm>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-sheet-settings-modal": DndmSheetSettingsModal;
  }
}
