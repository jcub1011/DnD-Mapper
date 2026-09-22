import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CharacterSheet, Token } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import "./dndm-confirm";
import "./dndm-modal";

@customElement("dndm-token-details-modal")
export class DndmTokenDetailsModal extends GameElement {
  @property({ type: Boolean })
  isOpen = false;

  @property({ attribute: false })
  token: Token | null = null;

  @property({ attribute: false })
  roster: readonly { id: string; name: string }[] = [];

  @property({ attribute: false })
  sheets: Readonly<Record<string, CharacterSheet>> = {};

  @property({ type: String })
  dmPlayerId: string | null = null;

  @property({ type: Boolean })
  isDm = false;

  @property({ attribute: false })
  onUpdateToken?: (
    tokenId: string,
    patch: { name?: string; color?: string; iconKind?: "Initial" | "Solid" },
  ) => void;

  @property({ attribute: false })
  onToggleHidden?: (tokenId: string, hidden: boolean) => void;

  @property({ attribute: false })
  onReassignTokenSheet?: (tokenId: string, sheetId: string | null) => void;

  @property({ attribute: false })
  onDeleteToken?: (tokenId: string) => void;

  @property({ attribute: false })
  onCenterOnToken?: (x: number, y: number) => void;

  @property({ attribute: false })
  onClose?: () => void;

  @property({ attribute: false })
  onCancel?: () => void;

  @state() private name = "";
  @state() private color = "#e8b849";
  @state() private iconKind: "Initial" | "Solid" = "Initial";
  @state() private confirmDelete = false;

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if ((changedProperties.has("token") || changedProperties.has("isOpen")) && this.token) {
      this.name = this.token.name;
      this.color = this.token.color;
      this.iconKind = this.token.iconKind;
      this.confirmDelete = false;
    }
  }

  private handleClose = (): void => {
    this.confirmDelete = false;
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dispatchEvent(new CustomEvent("cancel", { bubbles: true, composed: true }));
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
    this.onCancel?.();
    this.onClose?.();
  };

  private handleSave = (): void => {
    if (!this.token) return;
    const patch: { name?: string; color?: string; iconKind?: "Initial" | "Solid" } = {};
    const trimmed = this.name.trim();
    if (trimmed && trimmed !== this.token.name) patch.name = trimmed;
    if (this.color !== this.token.color) patch.color = this.color;
    if (this.iconKind !== this.token.iconKind) patch.iconKind = this.iconKind;
    if (Object.keys(patch).length > 0) {
      this.dispatchEvent(
        new CustomEvent<{ tokenId: string; patch: typeof patch }>("save-token", {
          bubbles: true,
          composed: true,
          detail: { tokenId: this.token.id, patch },
        }),
      );
      this.onUpdateToken?.(this.token.id, patch);
    }
    this.handleClose();
  };

  private handleToggleHidden = (): void => {
    if (!this.token) return;
    const nextHidden = !this.token.hidden;
    this.dispatchEvent(
      new CustomEvent<{ tokenId: string; hidden: boolean }>("toggle-token-hidden", {
        bubbles: true,
        composed: true,
        detail: { tokenId: this.token.id, hidden: nextHidden },
      }),
    );
    this.onToggleHidden?.(this.token.id, nextHidden);
  };

  private handleCenter = (): void => {
    if (!this.token) return;
    this.dispatchEvent(
      new CustomEvent<{ x: number; y: number }>("center-token", {
        bubbles: true,
        composed: true,
        detail: { x: this.token.x, y: this.token.y },
      }),
    );
    this.onCenterOnToken?.(this.token.x, this.token.y);
  };

  private handleReassign = (e: Event): void => {
    if (!this.token) return;
    e.stopPropagation();
    const val = (e.target as HTMLSelectElement).value;
    const next = val ? val : null;
    this.dispatchEvent(
      new CustomEvent<{ tokenId: string; sheetId: string | null }>(
        "reassign-token-sheet",
        {
          bubbles: true,
          composed: true,
          detail: { tokenId: this.token.id, sheetId: next },
        }),
    );
    this.onReassignTokenSheet?.(this.token.id, next);
  };

  private handleDelete = (): void => {
    if (!this.token) return;
    const id = this.token.id;
    this.confirmDelete = false;
    this.isOpen = false;
    this.dispatchEvent(
      new CustomEvent<string>("delete-token", { bubbles: true, composed: true, detail: id }),
    );
    this.onDeleteToken?.(id);
  };

  override render(): TemplateResult {
    const t = this.token;
    const isPlayer = t?.type === "PlayerToken";
    const linkedSheet = t?.sheetId ? (this.sheets[t.sheetId] ?? null) : null;
    const ownerName = t?.ownerUserId
      ? (this.roster.find((p) => p.id === t.ownerUserId)?.name ?? t.ownerUserId)
      : null;

    return html`
      <dndm-modal
        .isOpen=${this.isOpen && !!t}
        .modalTitle=${t ? `Token — ${t.name}` : "Token"}
        cardStyle="max-width: 520px; width: 100%;"
        @close=${this.handleClose}
        .onClose=${this.handleClose}
        .onCancel=${this.handleClose}
        .body=${t
          ? html`
              <div style="display: flex; flex-direction: column; gap: 10px;">
                <label class="dndm-label">
                  Name
                  <input
                    type="text"
                    class="dndm-input"
                    .value=${this.name}
                    ?disabled=${!this.isDm}
                    @input=${(e: Event) => {
                      this.name = (e.target as HTMLInputElement).value;
                    }}
                  />
                </label>

                <label class="dndm-label">
                  Color
                  <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                    <input
                      type="color"
                      class="dndm-input"
                      style="width: 44px; height: 32px; padding: 2px; cursor: pointer;"
                      .value=${this.color}
                      ?disabled=${!this.isDm}
                      @input=${(e: Event) => {
                        this.color = (e.target as HTMLInputElement).value;
                      }}
                    />
                    <span style="font-family: var(--font-mono); font-size: 0.85rem;"
                      >${this.color}</span
                    >
                  </div>
                </label>

                <div class="dndm-label">
                  Type
                  <div style="margin-top: 4px;">
                    <span class="dndm-tokenp-tag">${isPlayer ? "Player" : "NPC"}</span>
                    ${t.iconKind
                      ? html`<span
                          class="dndm-tokenp-tag"
                          style="margin-left: 6px;"
                          title="Icon style"
                          >${t.iconKind}</span
                        >`
                      : nothing}
                  </div>
                </div>

                ${this.isDm
                  ? html`
                      <label class="dndm-label">
                        Icon style
                        <select
                          class="dndm-select"
                          style="width: 100%; margin-top: 4px;"
                          .value=${this.iconKind}
                          @change=${(e: Event) => {
                            this.iconKind = (e.target as HTMLSelectElement).value as
                              | "Initial"
                              | "Solid";
                          }}
                        >
                          <option value="Initial">Initial</option>
                          <option value="Solid">Solid</option>
                        </select>
                      </label>

                      <label class="dndm-label">
                        Character sheet
                        <select
                          class="dndm-select"
                          style="width: 100%; margin-top: 4px;"
                          .value=${t.sheetId ?? ""}
                          @change=${this.handleReassign}
                        >
                          <option value="">Unassigned (NPC / DM Controlled)</option>
                          ${Object.values(this.sheets).map(
                            (s) => html`<option value=${s.id}>${s.characterName}</option>`,
                          )}
                        </select>
                      </label>
                    `
                  : html`
                      <div class="dndm-label">
                        Character sheet
                        <div style="margin-top: 4px; color: var(--dndm-text-dim);">
                          ${linkedSheet?.characterName ?? "Unassigned (NPC / DM Controlled)"}
                        </div>
                      </div>
                      <div class="dndm-label">
                        Owner
                        <div style="margin-top: 4px; color: var(--dndm-text-dim);">
                          ${ownerName ?? "Unassigned (NPC / DM Controlled)"}
                        </div>
                      </div>
                    `}

                <div
                  style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;"
                >
                  <button
                    class="dndm-btn dndm-btn--small ${t.hidden
                      ? "dndm-btn--primary"
                      : "dndm-btn--ghost"}"
                    type="button"
                    ?disabled=${!this.isDm}
                    title=${this.isDm
                      ? t.hidden
                        ? "Hidden — click to reveal"
                        : "Visible — click to hide"
                      : "Only the DM can change visibility"}
                    @click=${this.handleToggleHidden}
                  >
                    ${t.hidden ? "Reveal token" : "Hide token"}
                  </button>
                  <button
                    class="dndm-btn dndm-btn--small dndm-btn--ghost"
                    type="button"
                    @click=${this.handleCenter}
                  >
                    Center on map
                  </button>
                </div>

                <div style="font-size: 0.8rem; color: var(--dndm-text-dim);">
                  Position x=${t.x.toFixed(1)} y=${t.y.toFixed(1)}
                  ${t.sheetId ? html` · Linked sheet ${t.sheetId}` : nothing}
                </div>
              </div>
            `
          : html`<p class="dndm-modal-message">No token selected.</p>`}
        .footer=${t
          ? html`
              <div style="display: flex; justify-content: space-between; width: 100%;">
                <div>
                  ${this.isDm
                    ? html`
                        <button
                          class="dndm-btn dndm-btn--danger"
                          type="button"
                          @click=${() => {
                            this.confirmDelete = true;
                          }}
                        >
                          Delete
                        </button>
                      `
                    : nothing}
                </div>
                <div style="display: flex; gap: 8px;">
                  <button
                    class="dndm-btn dndm-btn--ghost"
                    type="button"
                    @click=${this.handleClose}
                  >
                    Cancel
                  </button>
                  ${this.isDm
                    ? html`
                        <button
                          class="dndm-btn dndm-btn--primary"
                          type="button"
                          @click=${this.handleSave}
                        >
                          Save
                        </button>
                      `
                    : nothing}
                </div>
              </div>
            `
          : nothing}
      ></dndm-modal>

      <dndm-confirm
        .isOpen=${this.confirmDelete}
        modalTitle="Delete token?"
        message=${`This removes "${t?.name}" from the map. Its character sheet will be kept.`}
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
    "dndm-token-details-modal": DndmTokenDetailsModal;
  }
}
