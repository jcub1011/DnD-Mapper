import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GameMap, GridConfig, MapSummary } from "../../game/domain";
import { isFullMap } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import { gearIcon, penIcon, trashIcon } from "../icons";
import "../modals/dndm-confirm";
import "../modals/dndm-map-settings";
import "../shared/dndm-rail-menu";
import "./dndm-collapsible-panel";

@customElement("dndm-map-list")
export class DndmMapList extends GameElement {
  @property({ attribute: false })
  maps: readonly (GameMap | MapSummary)[] = [];

  @property({ type: String })
  activeMapId: string | null = null;

  @property({ attribute: false })
  onCreateMap?: () => void;

  @property({ attribute: false })
  onSelectMap?: (mapId: string) => void;

  @property({ attribute: false })
  onRenameMap?: (mapId: string, name: string) => void;

  @property({ attribute: false })
  onDuplicateMap?: (mapId: string) => void;

  @property({ attribute: false })
  onDeleteMap?: (mapId: string) => void;

  @property({ attribute: false })
  onReorderMaps?: (order: readonly string[]) => void;

  @property({ attribute: false })
  onUpdateGrid?: (mapId: string, grid: GridConfig) => void;

  @state() private renamingId: string | null = null;
  @state() private renameDraft = "";
  @state() private pendingDeleteMap: (GameMap | MapSummary) | null = null;
  @state() private settingsTargetMap: (GameMap | MapSummary) | null = null;
  @state() private dragIndex: number | null = null;

  private handleRowClick(mapId: string): void {
    if (this.renamingId === mapId) return;
    this.dispatchEvent(
      new CustomEvent<string>("select-map", {
        bubbles: true,
        composed: true,
        detail: mapId,
      }),
    );
    this.onSelectMap?.(mapId);
  }

  private startRename(map: GameMap | MapSummary, e?: Event): void {
    e?.stopPropagation();
    this.renamingId = map.id;
    this.renameDraft = map.name;
  }

  private commitRename(mapId: string): void {
    if (!this.renamingId) return;
    const nextName = this.renameDraft.trim() || "Untitled Map";
    this.renamingId = null;
    this.dispatchEvent(
      new CustomEvent<{ mapId: string; name: string }>("rename-map", {
        bubbles: true,
        composed: true,
        detail: { mapId, name: nextName },
      }),
    );
    this.onRenameMap?.(mapId, nextName);
  }

  private handleRenameKey(e: KeyboardEvent, mapId: string): void {
    if (e.key === "Enter") {
      this.commitRename(mapId);
    } else if (e.key === "Escape") {
      this.renamingId = null;
    }
  }

  private readonly handleNewMap = (): void => {
    this.dispatchEvent(new CustomEvent("create-map", { bubbles: true, composed: true }));
    this.onCreateMap?.();
  };

  private handleDuplicate(mapId: string, e?: Event): void {
    e?.stopPropagation();
    this.dispatchEvent(
      new CustomEvent<string>("duplicate-map", {
        bubbles: true,
        composed: true,
        detail: mapId,
      }),
    );
    this.onDuplicateMap?.(mapId);
  }

  private handleDeleteRequest(map: GameMap | MapSummary, e?: Event): void {
    e?.stopPropagation();
    this.pendingDeleteMap = map;
  }

  private confirmDelete(): void {
    if (!this.pendingDeleteMap) return;
    const mapId = this.pendingDeleteMap.id;
    this.pendingDeleteMap = null;
    this.dispatchEvent(
      new CustomEvent<string>("delete-map", {
        bubbles: true,
        composed: true,
        detail: mapId,
      }),
    );
    this.onDeleteMap?.(mapId);
  }

  private handleDragStart(index: number, e: DragEvent): void {
    this.dragIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    }
  }

  private handleDrop(targetIndex: number, e: DragEvent): void {
    e.preventDefault();
    if (this.dragIndex === null || this.dragIndex === targetIndex) return;

    const list = [...this.maps];
    const [moved] = list.splice(this.dragIndex, 1);
    if (!moved) return;
    list.splice(targetIndex, 0, moved);
    this.dragIndex = null;

    const order = list.map((m) => m.id);
    this.dispatchEvent(
      new CustomEvent<readonly string[]>("reorder-maps", {
        bubbles: true,
        composed: true,
        detail: order,
      }),
    );
    this.onReorderMaps?.(order);
  }

  override render(): TemplateResult {
    return html`
      <dndm-collapsible-panel
        panelTitle="Maps"
        panelClass="dndm-mapsw"
        bodyClass="dndm-mapsw-list"
        .actions=${html`
          <button
            class="dndm-btn dndm-btn--icon dndm-btn--small"
            type="button"
            title="New map"
            @click=${this.handleNewMap}
          >
            +
          </button>
        `}
        .content=${this.maps.length === 0
          ? html`<div class="dndm-panel-empty">
              No maps yet — click <strong>+</strong> to create one.
            </div>`
          : this.maps.map((m, idx) => {
              const isActive = this.activeMapId === m.id;
              const imgCount = isFullMap(m) ? m.images.length : 0;
              const width = isFullMap(m) ? m.grid.widthCells : m.widthCells;
              const height = isFullMap(m) ? m.grid.heightCells : m.heightCells;

              return html`
                <div
                  class="dndm-mapsw-row ${isActive ? "dndm-mapsw-row--active" : ""}"
                  draggable="true"
                  @dragstart=${(e: DragEvent) => this.handleDragStart(idx, e)}
                  @dragover=${(e: DragEvent) => e.preventDefault()}
                  @drop=${(e: DragEvent) => this.handleDrop(idx, e)}
                  @click=${() => this.handleRowClick(m.id)}
                >
                  <div class="dndm-mapsw-thumb">${imgCount > 0 ? "🗺️" : "⌗"}</div>
                  <div class="dndm-mapsw-row-main">
                    ${this.renamingId === m.id
                      ? html`
                          <input
                            class="dndm-input dndm-mapsw-rename"
                            .value=${this.renameDraft}
                            @input=${(e: Event) => {
                              this.renameDraft = (e.target as HTMLInputElement).value;
                            }}
                            @click=${(e: Event) => e.stopPropagation()}
                            @keydown=${(e: KeyboardEvent) => this.handleRenameKey(e, m.id)}
                            @blur=${() => this.commitRename(m.id)}
                            autofocus
                          />
                        `
                      : html`<span class="dndm-mapsw-name">${m.name}</span>`}
                    <span class="dndm-mapsw-meta">
                      ${width}×${height} · ${imgCount} layer${imgCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div class="dndm-mapsw-actions">
                    <dndm-rail-menu
                      menuTitle="Map actions"
                      .actions=${() => html`
                        <button
                          class="dndm-btn dndm-btn--icon dndm-btn--small"
                          type="button"
                          title="Grid & settings"
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            this.settingsTargetMap = isFullMap(m)
                              ? m
                              : {
                                  ...m,
                                  images: [],
                                  tokens: [],
                                  createdUtc: new Date().toISOString(),
                                  listOrder: 0,
                                  defaultSpawnPosition: null,
                                  markupSvg: null,
                                  fogMask: "",
                                };
                          }}
                        >
                          ${gearIcon()}
                        </button>
                        <button
                          class="dndm-btn dndm-btn--icon dndm-btn--small"
                          type="button"
                          title="Rename"
                          @click=${(e: Event) => this.startRename(m, e)}
                        >
                          ${penIcon()}
                        </button>
                        <button
                          class="dndm-btn dndm-btn--icon dndm-btn--small"
                          type="button"
                          title="Duplicate"
                          @click=${(e: Event) => this.handleDuplicate(m.id, e)}
                        >
                          ⎘
                        </button>
                        <button
                          class="dndm-btn dndm-btn--icon dndm-btn--small dndm-btn--danger"
                          type="button"
                          title="Delete"
                          @click=${(e: Event) => this.handleDeleteRequest(m, e)}
                        >
                          ${trashIcon()}
                        </button>
                      `}
                    ></dndm-rail-menu>
                  </div>
                </div>
              `;
            })}
      ></dndm-collapsible-panel>

      <dndm-confirm
        ?isOpen=${this.pendingDeleteMap !== null}
        modalTitle="Delete map?"
        message=${`This will permanently delete "${this.pendingDeleteMap?.name}".`}
        confirmText="Delete"
        .onConfirm=${() => this.confirmDelete()}
        .onCancel=${() => {
          this.pendingDeleteMap = null;
        }}
        .onClose=${() => {
          this.pendingDeleteMap = null;
        }}
        @cancel=${() => {
          this.pendingDeleteMap = null;
        }}
        @close=${() => {
          this.pendingDeleteMap = null;
        }}
      ></dndm-confirm>

      <dndm-map-settings
        ?isOpen=${this.settingsTargetMap !== null}
        .map=${this.settingsTargetMap}
        .onSave=${(grid: GridConfig) => {
          if (this.settingsTargetMap) {
            this.onUpdateGrid?.(this.settingsTargetMap.id, grid);
          }
          this.settingsTargetMap = null;
        }}
        .onCancel=${() => {
          this.settingsTargetMap = null;
        }}
        .onClose=${() => {
          this.settingsTargetMap = null;
        }}
        @cancel=${() => {
          this.settingsTargetMap = null;
        }}
        @close=${() => {
          this.settingsTargetMap = null;
        }}
      ></dndm-map-settings>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-map-list": DndmMapList;
  }
}
