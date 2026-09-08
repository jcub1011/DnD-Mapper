/*
 * Root application shell for D&D Mapper. A pure VIEW over the replicated match
 * state: it renders what the authority published and turns clicks into intents.
 * It never computes game state — that lives in src/authority/, which the server runs.
 *
 * Replaces the template's <game-app> and implements Phase 5 UI Shell (07-ui-shell.md).
 */

import { html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { KBPlayer } from "../../../addons/knockbox/knockbox-phaser";
import { createAssetSource, type AssetSource } from "../../assets/assetSource";
import { IdbBlobTransport } from "../../assets/blobTransport";
import type { DndmImageUpload } from "../upload/dndm-image-upload";
import {
  createDefaultDndMapperState,
  isFullMap,
  type GameMap,
  type GridConfig,
  type MapImage,
  type NewMapImage,
  type Token,
} from "../../game/domain";
import type { Intent, MatchState } from "../../game/types";
import { createLogger } from "../../log";
import type { GameController } from "../../net/controller";
import type { LaunchMode } from "../../net/launch";
import { LibraryService } from "../../storage/libraryService";
import { fx } from "../fx/fx";
import { gearIcon } from "../icons";
import type { ToolMode } from "../map/MapScene";
import { toastService } from "../toast/toastService";
import { GameElement } from "./GameElement";

// Component registrations
import "../canvas/dndm-image-inspector";
import "../canvas/dndm-toolbar";
import "../lobby/dndm-lobby";
import "../modals/dndm-permissions";
import "../panels/dndm-layer-panel";
import "../panels/dndm-map-list";
import "../panels/dndm-my-token";
import "../panels/dndm-saves-panel";
import "../panels/dndm-token-panel";
import "../toast/dndm-toast";
import "../upload/dndm-image-upload";

const log = createLogger("app");

const MIN_RAIL_PX = 200;
const MAX_RAIL_PX = 600;
const CLICK_THRESHOLD_PX = 4;
const STORAGE_PREFIX = "dndm.rail.";

function clampRail(px: number): number {
  return Math.max(MIN_RAIL_PX, Math.min(MAX_RAIL_PX, px));
}

function loadRailWidth(side: "left" | "right", role: "dm" | "player", fallback: number): number {
  try {
    const v = window.sessionStorage?.getItem(STORAGE_PREFIX + role + "." + side);
    if (!v) return fallback;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? clampRail(n) : fallback;
  } catch {
    return fallback;
  }
}

function saveRailWidth(side: "left" | "right", role: "dm" | "player", px: number): void {
  try {
    window.sessionStorage?.setItem(STORAGE_PREFIX + role + "." + side, String(Math.round(px)));
  } catch {
    // ignore quota/privacy errors
  }
}

const EMPTY: MatchState = createDefaultDndMapperState();

@customElement("dndm-app")
export class DndmApp extends GameElement {
  /** Set by main.ts before the element does anything meaningful. */
  launchMode: LaunchMode = "solo";

  private controller?: GameController;
  private rafId = 0;
  private lastCenterNonce: string | null = null;

  public ticket: string | null = null;
  public libraryService = new LibraryService();
  public assetSource: AssetSource = createAssetSource(this.launchMode, this.libraryService);
  private hasSweptLocalBlobs = false;

  @state() private match: Readonly<MatchState> = EMPTY;
  @state() private roster: readonly KBPlayer[] = [];
  @state() private isOwner = false;
  @state() private lobbyOpen = true;

  // Rail State
  @state() private leftRailWidth = 280;
  @state() private rightRailWidth = 320;
  @state() private leftCollapsed = false;
  @state() private rightCollapsed = false;

  // Tool & Canvas State
  @state() private toolMode: ToolMode = "none";
  @state() private fogBrushMode: "paint" | "erase" = "paint";
  @state() private fogBrushRadius = 1;
  @state() private selectedImageId: string | null = null;
  @state() private currentZoom = 1.0;
  @state() private settingsModalOpen = false;

  // Drag resizing tracking
  private activeResizeSide: "left" | "right" | null = null;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private resizeCurrentPx = 0;
  private resizeMoved = false;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onGlobalPanelCollapseClick);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("click", this.onGlobalPanelCollapseClick);
    cancelAnimationFrame(this.rafId);
    this.controller?.destroy();
  }

  /** Attach the controller main.ts built. Safe to call once. */
  attach(controller: GameController): void {
    this.controller = controller;
    this.match = controller.view.state;
    this.isOwner = controller.isOwner;
    this.assetSource = createAssetSource(
      this.launchMode,
      this.libraryService,
      this.ticket,
      "local",
      fx.knockbox(),
    );

    this.initRailWidths();
    this.updateRailCssVars();

    this.listen(controller.events, "changed", ({ state }) => {
      this.onStateChanged(state);
    });
    this.listen(controller.events, "roster", ({ players, isOwner }) => {
      this.roster = players;
      const prevOwner = this.isOwner;
      this.isOwner = isOwner;
      if (isOwner && players.length === 1 && !this.hasSweptLocalBlobs && this.launchMode === "local-tab") {
        this.hasSweptLocalBlobs = true;
        const idb = new IdbBlobTransport();
        idb.clear().finally(() => idb.close());
      }
      if (prevOwner !== isOwner) {
        this.initRailWidths();
        this.updateRailCssVars();
      }
    });

    this.wireMapScene();
    this.rafId = requestAnimationFrame(this.frame);
    log.info(`controller attached (launch=${this.launchMode})`);
  }

  private initRailWidths(): void {
    const role = this.isDm ? "dm" : "player";
    this.leftRailWidth = loadRailWidth("left", role, 280);
    this.rightRailWidth = loadRailWidth("right", role, 320);
  }

  public get isDm(): boolean {
    const me = this.controller?.playerId ?? "";
    if (this.match.dmPlayerId) {
      return this.match.dmPlayerId === me;
    }
    return this.isOwner;
  }

  private updateRailCssVars(): void {
    const leftPad = this.isDm && !this.leftCollapsed ? `${this.leftRailWidth}px` : "0px";
    const rightPad = !this.rightCollapsed ? `${this.rightRailWidth}px` : "28px";

    this.style.setProperty("--dndm-rail-w-left", `${this.leftRailWidth}px`);
    this.style.setProperty("--dndm-rail-w-right", `${this.rightRailWidth}px`);
    this.style.setProperty("--dndm-rail-pad-left", leftPad);
    this.style.setProperty("--dndm-rail-pad-right", rightPad);

    const map = fx.map();
    if (map) {
      const leftInset = this.isDm && !this.leftCollapsed ? this.leftRailWidth : 0;
      const rightInset = !this.rightCollapsed ? this.rightRailWidth : 28;
      map.setRailInsets(leftInset, rightInset);
    }
  }

  // ── Panel Collapse Logic (skipping interactive descendants) ────────────────
  private readonly onGlobalPanelCollapseClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const header = target.closest(".dndm-panel-header");
    if (!header) return;

    // Check if click was on or inside an interactive element
    let el: HTMLElement | null = target;
    while (el && el !== header) {
      const tag = el.tagName;
      if (
        tag === "BUTTON" ||
        tag === "INPUT" ||
        tag === "SELECT" ||
        tag === "TEXTAREA" ||
        tag === "A" ||
        tag === "LABEL" ||
        el.getAttribute("role") === "button"
      ) {
        return;
      }
      el = el.parentElement;
    }

    const panel = header.closest(".dndm-panel");
    if (!panel) return;
    panel.classList.toggle("dndm-panel--collapsed");
  };

  // ── Rail Resize & Click Collapse Handling ──────────────────────────────────
  private startRailResize(side: "left" | "right", e: PointerEvent): void {
    if (e.button !== 0) return;
    this.activeResizeSide = side;
    this.resizeStartX = e.clientX;
    this.resizeStartWidth = side === "left" ? this.leftRailWidth : this.rightRailWidth;
    this.resizeCurrentPx = this.resizeStartWidth;
    this.resizeMoved = false;

    const target = e.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
    e.stopPropagation();
  }

  private onRailResizeMove(e: PointerEvent): void {
    if (!this.activeResizeSide) return;
    const dx = e.clientX - this.resizeStartX;
    if (!this.resizeMoved && Math.abs(dx) < CLICK_THRESHOLD_PX) {
      return;
    }
    this.resizeMoved = true;
    const delta = this.activeResizeSide === "left" ? dx : -dx;
    const nextPx = clampRail(this.resizeStartWidth + delta);
    this.resizeCurrentPx = nextPx;

    if (this.activeResizeSide === "left") {
      this.leftRailWidth = nextPx;
    } else {
      this.rightRailWidth = nextPx;
    }
    this.updateRailCssVars();
  }

  private endRailResize(side: "left" | "right", e: PointerEvent): void {
    if (!this.activeResizeSide) return;
    this.activeResizeSide = null;

    const target = e.currentTarget as HTMLElement;
    try {
      target.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    const role = this.isDm ? "dm" : "player";

    if (this.resizeMoved) {
      saveRailWidth(side, role, this.resizeCurrentPx);
    } else {
      // Click without drag toggles collapse
      if (side === "left") {
        this.leftCollapsed = !this.leftCollapsed;
      } else {
        this.rightCollapsed = !this.rightCollapsed;
      }
      this.updateRailCssVars();
    }
  }

  // ── Canvas Drag & Drop ─────────────────────────────────────────────────────
  private onCanvasDragOver = (e: DragEvent): void => {
    if (!this.isDm) return;
    e.preventDefault();
    e.stopPropagation();
  };

  private onCanvasDragLeave = (e: DragEvent): void => {
    if (!this.isDm) return;
    e.preventDefault();
    e.stopPropagation();
  };

  private onCanvasDrop = async (e: DragEvent): Promise<void> => {
    if (!this.isDm || !e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name),
    );
    if (files.length === 0) return;
    const uploadEl = this.renderRoot.querySelector("dndm-image-upload") as DndmImageUpload | null;
    if (uploadEl) {
      await uploadEl.processFiles(files);
    }
  };

  // ── Map Scene Synchronization ──────────────────────────────────────────────
  private wireMapScene(): void {
    const map = fx.map();
    if (!map) return;

    map.onTokenMoveEnd = (e) => {
      this.send({ kind: "moveToken", tokenId: e.tokenId, x: e.x, y: e.y });
    };
    map.onImageTransformEnd = (e) => {
      this.send({
        kind: "transformImage",
        imageId: e.imageId,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        rotation: e.rotation,
      });
    };
    map.onFogStrokeCommit = (cells, fogged) => {
      if (!this.match.activeMapId) return;
      this.send({
        kind: "paintFog",
        mapId: this.match.activeMapId,
        cells,
        fogged,
      });
    };
    map.onFocusRectCommit = (rect) => {
      this.send({ kind: "setFocusRect", rect });
    };
    map.onImageSelect = (id) => {
      this.selectedImageId = id;
    };
    map.onViewportChanged = (vp) => {
      this.currentZoom = vp.zoom;
    };

    this.syncSceneState();
  }

  private syncSceneState(): void {
    const map = fx.map();
    if (!map) return;

    map.setDm(this.isDm);
    map.setAssetSource(this.assetSource);

    const activeMap = this.activeMap;
    if (activeMap) {
      map.setMap(activeMap, this.isDm, this.assetSource);
    }

    if (this.match.focusRect) {
      map.setFocusRect(this.match.focusRect);
    }

    if (
      this.match.pendingCenterRequest &&
      this.match.pendingCenterRequest.nonce !== this.lastCenterNonce
    ) {
      this.lastCenterNonce = this.match.pendingCenterRequest.nonce;
      map.centerOn(this.match.pendingCenterRequest.x, this.match.pendingCenterRequest.y);
    }

    this.updateRailCssVars();
  }

  private onStateChanged(state: Readonly<MatchState>): void {
    const prevMapId = this.match.activeMapId;
    this.match = state;

    const map = fx.map();
    if (map) {
      const activeMap = this.activeMap;
      if (activeMap) {
        if (prevMapId !== activeMap.id) {
          map.setMap(activeMap, this.isDm, this.assetSource);
        } else {
          map.updateGrid(activeMap.grid);
          map.updateTokens(activeMap.tokens);
          map.updateImages(activeMap.images);
          if (activeMap.fogMask) {
            map.updateFog(activeMap.fogMask);
          }
        }
      }
      map.setFocusRect(state.focusRect);

      if (
        state.pendingCenterRequest &&
        state.pendingCenterRequest.nonce !== this.lastCenterNonce
      ) {
        this.lastCenterNonce = state.pendingCenterRequest.nonce;
        map.centerOn(state.pendingCenterRequest.x, state.pendingCenterRequest.y);
      }
    }

    if (this.isDm) {
      this.libraryService.onStateChanged(state);
    }
  }

  public get activeMap(): GameMap | null {
    if (!this.match.activeMapId) return null;
    const found = this.match.maps.find((m) => m.id === this.match.activeMapId);
    if (!found || !isFullMap(found)) return null;
    return found;
  }

  public get selectedImage(): MapImage | null {
    if (!this.selectedImageId || !this.activeMap) return null;
    return this.activeMap.images.find((img) => img.id === this.selectedImageId) ?? null;
  }

  private send(intent: Intent): void {
    this.controller?.sendIntent(intent);
  }

  private readonly frame = (_ts: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  override render(): TemplateResult {
    const { phase, maps, activeMapId, settings } = this.match;
    const me = this.controller?.playerId ?? "";

    if (phase === "Lobby") {
      return html`
        <dndm-lobby
          .isDm=${this.isDm}
          .isOwner=${this.isOwner}
          .roster=${this.roster}
          .localPlayerId=${me}
          .dmPlayerId=${this.match.dmPlayerId}
          .settings=${settings}
          .lobbyOpen=${this.lobbyOpen}
          .onStartSession=${() => this.send({ kind: "startSession" })}
          .onKickPlayer=${(id: string) => this.controller?.kickPlayer(id)}
          .onToggleLobbyOpen=${() => {
            this.lobbyOpen = !this.lobbyOpen;
            this.controller?.setLobbyOpen(this.lobbyOpen);
          }}
          .onUpdateSettings=${(patch: Partial<typeof settings>) =>
            this.send({ kind: "updateSettings", patch })}
        ></dndm-lobby>
      `;
    }

    const active = this.activeMap;
    const myToken: Token | null =
      active?.tokens.find((t) => t.ownerUserId === me || t.representsUserId === me) ?? null;

    return html`
      <div
        class="dnd-mapper-playing ${this.isDm ? "dnd-mapper-playing--host" : ""} ${this
          .leftCollapsed
          ? "dnd-mapper-playing--left-collapsed"
          : ""} ${this.rightCollapsed ? "dnd-mapper-playing--right-collapsed" : ""}"
      >
        <!-- Left Rail (DM Only) -->
        ${this.isDm
          ? html`
              <aside class="dndm-rail dndm-rail--left">
                <div class="dndm-rail-content">
                  <dndm-map-list
                    .maps=${maps}
                    .activeMapId=${activeMapId}
                    .onCreateMap=${() => this.send({ kind: "createMap", name: "New Map" })}
                    .onSelectMap=${(id: string) => this.send({ kind: "setActiveMap", mapId: id })}
                    .onRenameMap=${(id: string, name: string) =>
                      this.send({ kind: "renameMap", mapId: id, name })}
                    .onDuplicateMap=${(id: string) =>
                      this.send({ kind: "duplicateMap", mapId: id })}
                    .onDeleteMap=${(id: string) => this.send({ kind: "deleteMap", mapId: id })}
                    .onReorderMaps=${(order: readonly string[]) =>
                      this.send({ kind: "reorderMaps", order })}
                    .onUpdateGrid=${(id: string, grid: GridConfig) =>
                      this.send({ kind: "updateGrid", mapId: id, grid })}
                  ></dndm-map-list>

                  <dndm-token-panel
                    .activeMap=${active}
                    .onCenterOnToken=${(x: number, y: number) => {
                      fx.map()?.centerOn(x, y);
                    }}
                    .onToggleIcon=${(id: string, iconKind: "Initial" | "Solid") =>
                      this.send({ kind: "updateToken", tokenId: id, patch: { iconKind } })}
                    .onToggleHidden=${(id: string, hidden: boolean) =>
                      this.send({ kind: "setTokenHidden", tokenId: id, hidden })}
                    .onDeleteToken=${(id: string) =>
                      this.send({ kind: "removeToken", tokenId: id })}
                  ></dndm-token-panel>

                  <dndm-layer-panel
                    .activeMap=${active}
                    .selectedImageId=${this.selectedImageId}
                    .assetSource=${this.assetSource}
                    .onSelectImage=${(id: string | null) => {
                      this.selectedImageId = id;
                      fx.map()?.selectImage(id);
                    }}
                    .onToggleHidden=${(id: string, hidden: boolean) =>
                      this.send({ kind: "setImageHidden", imageId: id, hidden })}
                    .onToggleLocked=${(id: string, locked: boolean) =>
                      this.send({ kind: "setImageLocked", imageId: id, locked })}
                    .onRenameImage=${(id: string, _name: string) => {
                      const img = active?.images.find((i) => i.id === id);
                      if (img) {
                        this.send({
                          kind: "transformImage",
                          imageId: id,
                          x: img.x,
                          y: img.y,
                          width: img.width,
                          height: img.height,
                          rotation: img.rotation,
                        });
                      }
                    }}
                  >
                    <dndm-image-upload
                      slot="header-action"
                      .compact=${true}
                      .libraryService=${this.libraryService}
                      .onImageUploaded=${async (newImg: NewMapImage, blob: Blob, imageId: string) => {
                        if (active) {
                          await this.assetSource.publish(imageId, blob);
                          this.send({ kind: "addImage", mapId: active.id, image: newImg, imageId });
                          toastService.success(`Added image layer "${newImg.name}"`);
                        }
                      }}
                    ></dndm-image-upload>
                  </dndm-layer-panel>

                  <dndm-saves-panel
                    .libraryService=${this.libraryService}
                    .currentState=${this.match}
                    .onLoadSlotState=${async (loaded: MatchState) => {
                      for (const map of loaded.maps) {
                        if ("images" in map) {
                          for (const img of map.images) {
                            const blob = await this.libraryService.getImage(img.id);
                            if (blob) {
                              await this.assetSource.publish(img.id, blob);
                            }
                          }
                        }
                      }
                      this.send({
                        kind: "beginImport",
                        campaign: {
                          settings: loaded.settings,
                          attributeSchema: loaded.attributeSchema,
                          activeMapId: loaded.activeMapId,
                          sheets: loaded.sheets,
                        },
                        chunkCount: 1,
                      });
                    }}
                  ></dndm-saves-panel>

                  <section class="dndm-panel dndm-session-panel">
                    <header class="dndm-panel-header">
                      <span>Session</span>
                    </header>
                    <div class="dndm-panel-body dndm-session-actions">
                      <button
                        class="dndm-btn dndm-btn--icon"
                        type="button"
                        title="Session Settings"
                        @click=${() => {
                          this.settingsModalOpen = true;
                        }}
                      >
                        ${gearIcon()}
                      </button>
                      <button
                        class="dndm-btn dndm-btn--ghost dndm-btn--small"
                        type="button"
                        @click=${() => {
                          this.lobbyOpen = !this.lobbyOpen;
                          this.controller?.setLobbyOpen(this.lobbyOpen);
                        }}
                      >
                        ${this.lobbyOpen ? "Close Lobby" : "Open Lobby"}
                      </button>
                    </div>
                  </section>
                </div>

                <div
                  class="dndm-rail-resize dndm-rail-resize--left"
                  title="Drag to resize, click to collapse"
                  @pointerdown=${(e: PointerEvent) => this.startRailResize("left", e)}
                  @pointermove=${(e: PointerEvent) => this.onRailResizeMove(e)}
                  @pointerup=${(e: PointerEvent) => this.endRailResize("left", e)}
                  @pointercancel=${(e: PointerEvent) => this.endRailResize("left", e)}
                ></div>
              </aside>
            `
          : nothing}

        <!-- Canvas Area -->
        <main
          class="dndm-canvas-area"
          @dragover=${this.onCanvasDragOver}
          @dragleave=${this.onCanvasDragLeave}
          @drop=${this.onCanvasDrop}
        >
          ${!active
            ? html`
                <div class="dndm-empty">
                  ${this.isDm
                    ? html`<span>No active map. Create one from the <strong>Maps</strong> panel.</span>`
                    : html`<span>Waiting for the DM to choose a map…</span>`}
                </div>
              `
            : html`
                <dndm-toolbar
                  .isDm=${this.isDm}
                  .zoom=${this.currentZoom}
                  .showGridLines=${active.grid.showGridLines}
                  .toolMode=${this.toolMode}
                  .fogBrushMode=${this.fogBrushMode}
                  .fogBrushRadius=${this.fogBrushRadius}
                  .hasFocusRect=${this.match.focusRect !== null}
                  .onToggleGrid=${(show: boolean) =>
                    this.send({
                      kind: "updateGrid",
                      mapId: active.id,
                      grid: { ...active.grid, showGridLines: show },
                    })}
                  .onZoomIn=${() => fx.map()?.zoomIn()}
                  .onZoomOut=${() => fx.map()?.zoomOut()}
                  .onResetView=${() => fx.map()?.resetView()}
                  .onSetToolMode=${(mode: ToolMode) => {
                    this.toolMode = mode;
                    fx.map()?.setToolMode(mode);
                  }}
                  .onSetFogBrushMode=${(mode: "paint" | "erase") => {
                    this.fogBrushMode = mode;
                    const m = fx.map();
                    if (m) m.fogBrushMode = mode;
                  }}
                  .onCycleBrushRadius=${() => {
                    const next = (this.fogBrushRadius % 3) + 1;
                    this.fogBrushRadius = next;
                    const m = fx.map();
                    if (m) m.fogBrushRadius = next;
                  }}
                  .onFillFog=${() => this.send({ kind: "fillFog", mapId: active.id })}
                  .onClearFog=${() => this.send({ kind: "clearFog", mapId: active.id })}
                  .onClearFocusRect=${() => this.send({ kind: "setFocusRect", rect: null })}
                  .onCenterEveryone=${() => {
                    const cam = fx.map()?.cameras.main;
                    if (cam) {
                      const world = cam.midPoint;
                      this.send({
                        kind: "centerViewport",
                        mapId: active.id,
                        x: world.x / 50,
                        y: world.y / 50,
                      });
                      toastService.info("Centered all players on current view");
                    }
                  }}
                ></dndm-toolbar>

                ${this.isDm && this.selectedImage
                  ? html`
                      <div class="dndm-canvas-inspector">
                        <dndm-image-inspector
                          .image=${this.selectedImage}
                          .maxLayerOrder=${Math.max(
                            ...active.images.map((i) => i.layerOrder),
                            0,
                          )}
                          .onTransform=${(patch: {
                            x: number;
                            y: number;
                            width: number;
                            height: number;
                            rotation: number;
                          }) => {
                            if (this.selectedImage) {
                              this.send({
                                kind: "transformImage",
                                imageId: this.selectedImage.id,
                                ...patch,
                              });
                            }
                          }}
                          .onReorder=${(layerOrder: number) => {
                            if (this.selectedImage) {
                              this.send({
                                kind: "reorderImage",
                                imageId: this.selectedImage.id,
                                layerOrder,
                              });
                            }
                          }}
                          .onSetLocked=${(locked: boolean) => {
                            if (this.selectedImage) {
                              this.send({
                                kind: "setImageLocked",
                                imageId: this.selectedImage.id,
                                locked,
                              });
                            }
                          }}
                          .onRemove=${async () => {
                            if (this.selectedImage) {
                              const imgId = this.selectedImage.id;
                              await this.assetSource.release(imgId);
                              await this.libraryService.deleteImage(imgId);
                              this.send({
                                kind: "removeImage",
                                imageId: imgId,
                              });
                              this.selectedImageId = null;
                              fx.map()?.selectImage(null);
                            }
                          }}
                          .onClose=${() => {
                            this.selectedImageId = null;
                            fx.map()?.selectImage(null);
                          }}
                        ></dndm-image-inspector>
                      </div>
                    `
                  : nothing}
              `}
        </main>

        <!-- Right Rail -->
        <aside class="dndm-rail dndm-rail--right">
          <div
            class="dndm-rail-resize dndm-rail-resize--right"
            title="Drag to resize, click to collapse"
            @pointerdown=${(e: PointerEvent) => this.startRailResize("right", e)}
            @pointermove=${(e: PointerEvent) => this.onRailResizeMove(e)}
            @pointerup=${(e: PointerEvent) => this.endRailResize("right", e)}
            @pointercancel=${(e: PointerEvent) => this.endRailResize("right", e)}
          ></div>
          <div class="dndm-rail-content">
            ${!this.isDm
              ? html`
                  <dndm-my-token
                    .token=${myToken}
                    .onChangeColor=${(tokenId: string, color: string) =>
                      this.send({ kind: "updateToken", tokenId, patch: { color } })}
                  ></dndm-my-token>
                `
              : nothing}
          </div>
        </aside>

        <!-- Modals & Toasts -->
        <dndm-permissions
          ?isOpen=${this.settingsModalOpen}
          .settings=${settings}
          .isDm=${this.isDm}
          .onUpdateSettings=${(patch: Partial<typeof settings>) =>
            this.send({ kind: "updateSettings", patch })}
          .onClose=${() => {
            this.settingsModalOpen = false;
          }}
        ></dndm-permissions>

        <dndm-toast></dndm-toast>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-app": DndmApp;
  }
}
