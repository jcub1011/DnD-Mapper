import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { DndMapperState } from "../../game/domain";
import type { LibraryService } from "../../storage/libraryService";
import type { SlotInfo } from "../../storage/schema";
import { GameElement } from "../app/GameElement";
import { exportIcon, floppyIcon, floppyPlusIcon, trashIcon } from "../icons";
import "../modals/dndm-confirm";
import "../shared/dndm-rail-menu";
import { toastService } from "../toast/toastService";
import "../vtf/dndm-vtf-import";
import { exportCampaignSlot, triggerVtfDownload } from "../../vtf/export";

function formatRelative(isoUtc: string): string {
  try {
    const diffMs = Date.now() - new Date(isoUtc).getTime();
    const diffSec = Math.max(0, Math.floor(diffMs / 1000));
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch {
    return isoUtc;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

@customElement("dndm-saves-panel")
export class DndmSavesPanel extends GameElement {
  @property({ attribute: false })
  libraryService?: LibraryService;

  @property({ attribute: false })
  currentState?: DndMapperState;

  @property({ attribute: false })
  onLoadSlotState?: (state: DndMapperState) => void;

  @state() private slots: readonly SlotInfo[] = [];
  @state() private bytesUsed = 0;
  @state() private creating = false;
  @state() private newSlotName = "";
  @state() private renamingId: string | null = null;
  @state() private renameDraft = "";
  @state() private pendingLoadSlot: SlotInfo | null = null;
  @state() private pendingOverwriteSlot: SlotInfo | null = null;
  @state() private pendingDeleteSlot: SlotInfo | null = null;
  @state() private exportingSlotId: string | null = null;
  @state() private error: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.libraryService) {
      this.libraryService.onSlotsChanged = () => {
        void this.refreshSlots();
      };
    }
    void this.refreshSlots();
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("libraryService")) {
      void this.refreshSlots();
    }
  }

  public async refreshSlots(): Promise<void> {
    if (!this.libraryService) return;
    try {
      this.slots = await this.libraryService.listSlots();
      this.bytesUsed = await this.libraryService.getBytesUsed();
      this.error = null;
    } catch (err) {
      this.error = String(err);
    }
  }

  private async confirmCreate(): Promise<void> {
    if (!this.libraryService || !this.currentState || !this.newSlotName.trim()) return;
    const slotId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `slot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    try {
      await this.libraryService.saveSlot(slotId, this.newSlotName.trim(), this.currentState);
      this.creating = false;
      this.newSlotName = "";
      await this.refreshSlots();
    } catch (err) {
      this.error = String(err);
    }
  }

  private async confirmRename(slotId: string): Promise<void> {
    if (!this.libraryService || !this.renameDraft.trim()) return;
    try {
      await this.libraryService.renameSlot(slotId, this.renameDraft.trim());
      this.renamingId = null;
      this.renameDraft = "";
      await this.refreshSlots();
    } catch (err) {
      this.error = String(err);
    }
  }

  private async confirmOverwrite(): Promise<void> {
    if (!this.libraryService || !this.currentState || !this.pendingOverwriteSlot) return;
    try {
      await this.libraryService.saveSlot(
        this.pendingOverwriteSlot.id,
        this.pendingOverwriteSlot.name,
        this.currentState,
      );
      this.pendingOverwriteSlot = null;
      await this.refreshSlots();
    } catch (err) {
      this.error = String(err);
    }
  }

  private async confirmDelete(): Promise<void> {
    if (!this.libraryService || !this.pendingDeleteSlot) return;
    try {
      await this.libraryService.deleteSlot(this.pendingDeleteSlot.id);
      this.pendingDeleteSlot = null;
      await this.refreshSlots();
    } catch (err) {
      this.error = String(err);
    }
  }

  private async confirmLoad(): Promise<void> {
    if (!this.libraryService || !this.pendingLoadSlot) return;
    const slot = this.pendingLoadSlot;
    this.pendingLoadSlot = null;
    try {
      const loaded = await this.libraryService.loadSlot(slot.id);
      if (loaded) {
        this.dispatchEvent(
          new CustomEvent<DndMapperState>("load-slot", {
            bubbles: true,
            composed: true,
            detail: loaded,
          }),
        );
        this.onLoadSlotState?.(loaded);
      }
    } catch (err) {
      this.error = String(err);
    }
  }

  private async exportSlot(slotId: string, e?: Event): Promise<void> {
    e?.stopPropagation();
    if (!this.libraryService || this.exportingSlotId !== null) return;
    this.exportingSlotId = slotId;
    try {
      const { blob, fileName } = await exportCampaignSlot(this.libraryService, slotId);
      triggerVtfDownload(blob, fileName);
      toastService.success(`Exported ${fileName}`);
    } catch (err) {
      toastService.error(`Export failed: ${String(err)}`);
    } finally {
      this.exportingSlotId = null;
    }
  }

  override render(): TemplateResult {
    return html`
      <section class="dndm-panel dndm-savesp">
        <header class="dndm-panel-header">
          <span>Saves</span>
          <div class="dndm-savesp-header-actions">
            <dndm-vtf-import
              .libraryService=${this.libraryService}
              .autoSaveSlot=${true}
              @vtf-imported=${() => void this.refreshSlots()}
            ></dndm-vtf-import>
            <button
              class="dndm-btn dndm-btn--small dndm-btn--icon"
              type="button"
              title="Save current state to a new slot"
              aria-label="Save as new slot"
              @click=${() => {
                this.creating = true;
                this.newSlotName = "";
              }}
            >
              ${floppyPlusIcon()}
            </button>
          </div>
        </header>

        <div class="dndm-panel-body">
          ${this.creating
            ? html`
                <div class="dndm-saves-create">
                  <input
                    class="dndm-input"
                    placeholder="Slot name"
                    .value=${this.newSlotName}
                    @input=${(e: Event) => {
                      this.newSlotName = (e.target as HTMLInputElement).value;
                    }}
                  />
                  <button
                    class="dndm-btn dndm-btn--small dndm-btn--primary"
                    type="button"
                    ?disabled=${!this.newSlotName.trim()}
                    @click=${() => void this.confirmCreate()}
                  >
                    Save
                  </button>
                  <button
                    class="dndm-btn dndm-btn--small dndm-btn--ghost"
                    type="button"
                    @click=${() => {
                      this.creating = false;
                    }}
                  >
                    Cancel
                  </button>
                </div>
              `
            : nothing}
          ${this.slots.length === 0
            ? html`<div class="dndm-panel-empty">No saves yet.</div>`
            : html`
                <ul class="dndm-saves-list">
                  ${this.slots.map((s) => {
                    const isAuto = s.kind === "Auto";
                    const isRenaming = this.renamingId === s.id;

                    return html`
                      <li
                        class="dndm-saves-row ${isAuto ? "dndm-saves-row--auto" : ""} ${!isAuto &&
                        !isRenaming
                          ? "dndm-saves-row--loadable"
                          : ""}"
                        title=${isAuto || isRenaming ? "" : "Double-click to load"}
                        @dblclick=${() => {
                          if (!isAuto && !isRenaming) this.pendingLoadSlot = s;
                        }}
                      >
                        ${isRenaming
                          ? html`
                              <input
                                class="dndm-input dndm-saves-renameinput"
                                .value=${this.renameDraft}
                                @input=${(e: Event) => {
                                  this.renameDraft = (e.target as HTMLInputElement).value;
                                }}
                                @click=${(e: Event) => e.stopPropagation()}
                              />
                              <button
                                class="dndm-btn dndm-btn--small dndm-btn--primary"
                                type="button"
                                ?disabled=${!this.renameDraft.trim()}
                                @click=${() => void this.confirmRename(s.id)}
                              >
                                OK
                              </button>
                              <button
                                class="dndm-btn dndm-btn--small dndm-btn--ghost"
                                type="button"
                                @click=${() => {
                                  this.renamingId = null;
                                }}
                              >
                                ×
                              </button>
                            `
                          : html`
                              <div class="dndm-saves-meta">
                                <span class="dndm-saves-name">${s.name}</span>
                                <span class="dndm-saves-when">${formatRelative(s.updatedUtc)}</span>
                              </div>
                              <div class="dndm-saves-actions">
                                <dndm-rail-menu
                                  menuTitle="Save actions"
                                  .actions=${() => html`
                                    <button
                                      class="dndm-btn dndm-btn--small dndm-btn--ghost dndm-btn--icon"
                                      type="button"
                                      title="Export this slot as a .vtf archive"
                                      ?disabled=${this.exportingSlotId !== null}
                                      @click=${(e: Event) => void this.exportSlot(s.id, e)}
                                    >
                                      ${this.exportingSlotId === s.id
                                        ? html`<span>…</span>`
                                        : exportIcon()}
                                    </button>
                                    ${!isAuto
                                      ? html`
                                          <button
                                            class="dndm-btn dndm-btn--small dndm-btn--icon"
                                            type="button"
                                            title="Overwrite this slot with current state"
                                            @click=${(e: Event) => {
                                              e.stopPropagation();
                                              this.pendingOverwriteSlot = s;
                                            }}
                                          >
                                            ${floppyIcon()}
                                          </button>
                                          <button
                                            class="dndm-btn dndm-btn--small dndm-btn--ghost dndm-btn--icon"
                                            type="button"
                                            title="Rename"
                                            @click=${(e: Event) => {
                                              e.stopPropagation();
                                              this.renamingId = s.id;
                                              this.renameDraft = s.name;
                                            }}
                                          >
                                            ✎
                                          </button>
                                          <button
                                            class="dndm-btn dndm-btn--small dndm-btn--danger dndm-btn--icon"
                                            type="button"
                                            title="Delete"
                                            @click=${(e: Event) => {
                                              e.stopPropagation();
                                              this.pendingDeleteSlot = s;
                                            }}
                                          >
                                            ${trashIcon()}
                                          </button>
                                        `
                                      : nothing}
                                  `}
                                ></dndm-rail-menu>
                              </div>
                            `}
                      </li>
                    `;
                  })}
                </ul>
              `}
          <div
            class="dndm-saves-storage-meter"
            style="padding: 6px 8px; font-size: 11px; opacity: 0.75; display: flex; justify-content: space-between; border-top: 1px solid var(--dndm-border, #333); margin-top: 8px;"
          >
            <span>Storage</span>
            <span>${formatBytes(this.bytesUsed)} / 1 GB</span>
          </div>
          ${this.error ? html`<div class="dndm-saves-error">${this.error}</div>` : nothing}
        </div>
      </section>

      <dndm-confirm
        ?isOpen=${this.pendingLoadSlot !== null}
        modalTitle="Load this save?"
        message=${`Loading "${this.pendingLoadSlot?.name}" replaces the current campaign.`}
        confirmText="Load"
        .onConfirm=${() => void this.confirmLoad()}
        .onCancel=${() => {
          this.pendingLoadSlot = null;
        }}
      ></dndm-confirm>

      <dndm-confirm
        ?isOpen=${this.pendingOverwriteSlot !== null}
        modalTitle="Overwrite save?"
        message=${`This replaces "${this.pendingOverwriteSlot?.name}" with current campaign state.`}
        confirmText="Overwrite"
        .onConfirm=${() => void this.confirmOverwrite()}
        .onCancel=${() => {
          this.pendingOverwriteSlot = null;
        }}
      ></dndm-confirm>

      <dndm-confirm
        ?isOpen=${this.pendingDeleteSlot !== null}
        modalTitle="Delete save slot?"
        message=${`This permanently removes "${this.pendingDeleteSlot?.name}".`}
        confirmText="Delete"
        .onConfirm=${() => void this.confirmDelete()}
        .onCancel=${() => {
          this.pendingDeleteSlot = null;
        }}
      ></dndm-confirm>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-saves-panel": DndmSavesPanel;
  }
}
