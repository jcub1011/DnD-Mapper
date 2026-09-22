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
  type AttributePreset,
  type AttributeValue,
  type GameMap,
  type GridConfig,
  type MapImage,
  type NewMapImage,
  type StatusEffect,
  type Token,
} from "../../game/domain";
import type { Intent, MatchState } from "../../game/types";
import { createLogger } from "../../log";
import type { GameController } from "../../net/controller";
import type { LaunchMode } from "../../net/launch";
import { LibraryService } from "../../storage/libraryService";
import { fx } from "../fx/fx";
import { fullscreenExitIcon, fullscreenIcon, gearIcon, lockIcon } from "../icons";
import type { ToolMode } from "../map/MapScene";
import { toastService } from "../toast/toastService";
import { GameElement } from "./GameElement";

// Component registrations
import "../canvas/dndm-image-inspector";
import "../canvas/dndm-toolbar";
import "../lobby/dndm-lobby";
import "../modals/dndm-permissions";
import "../modals/dndm-roll-history";
import "../modals/dndm-roll-template-library";
import "../panels/dndm-character-sheet";
import type { SheetPatch } from "../panels/dndm-character-sheet";
import "../panels/dndm-collapsible-panel";
import "../panels/dndm-layer-panel";
import "../panels/dndm-map-list";
import "../panels/dndm-my-token";
import "../panels/dndm-loaded-dice-panel";
import "../panels/dndm-host-initiative";
import "../panels/dndm-initiative-banner";
import "../panels/dndm-quick-roll-footer";
import "../panels/dndm-saves-panel";
import "../panels/dndm-token-rail";
import "../toast/dndm-toast";
import "../upload/dndm-image-upload";
import "../markup/dndm-markup-overlay";
import "../display/dndm-display-roll-ticker";
import { filterDisplayImages, filterDisplayTokens } from "../display/displayProjection";
import { resolveActiveTurnTokenId } from "../../game/combat";
import { getReadableTextColor, resolveDiceColor, resolveDiceColorForToken } from "../../game/color";
import type { LoadedDiceRule, RollMode, RollResult, RollTemplate } from "../../game/domain";
import { HostInputTracker } from "../../net/hostInput";
import { DEFAULT_DICE_SCALE, diceOverlay } from "../dice/diceOverlay";

const log = createLogger("app");

const MIN_RAIL_PX = 200;
const MAX_RAIL_PX = 600;
const CLICK_THRESHOLD_PX = 4;
const COLLAPSE_THRESHOLD_PX = 140;
// Width of a collapsed rail. Must stay in sync with --dndm-rail-collapsed in shell.css.
const COLLAPSED_RAIL_PX = 28;
const STORAGE_PREFIX = "dndm.rail.";
const DICE_SCALE_STORAGE_KEY = "dndm.dice.scale";

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

function loadDiceScale(fallback = DEFAULT_DICE_SCALE): number {
  try {
    const v = window.localStorage?.getItem(DICE_SCALE_STORAGE_KEY);
    if (!v) return fallback;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 25 && n <= 250 ? n : fallback;
  } catch {
    return fallback;
  }
}

function saveDiceScale(scale: number): void {
  try {
    window.localStorage?.setItem(DICE_SCALE_STORAGE_KEY, String(scale));
  } catch {
    // ignore
  }
}

const EMPTY: MatchState = createDefaultDndMapperState();

@customElement("dndm-app")
export class DndmApp extends GameElement {
  /** Set by main.ts before the element does anything meaningful. */
  launchMode: LaunchMode = "solo";

  private controller?: GameController;
  private hostInputTracker?: HostInputTracker;
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
  @state() private selectedSheetId: string | null = null;
  @state() private currentZoom = 1.0;
  @state() private settingsModalOpen = false;
  @state() private rollTemplateLibraryOpen = false;
  @state() private rollHistoryOpen = false;
  @state() private diceSoundEnabled = false;
  @state() private diceScale: number = loadDiceScale(DEFAULT_DICE_SCALE);
  @state() private projectorMode =
    typeof window !== "undefined" && window.location?.search?.includes("view=display");

  private seenRollIds = new Set<string>();
  private displaySyncChannel?: BroadcastChannel;

  // Drag resizing tracking
  private activeResizeSide: "left" | "right" | null = null;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private resizeCurrentPx = 0;
  private resizeMoved = false;
  private isCollapsedAtDragStart = false;

  private onOpenSheet = (e: Event): void => {
    const customEvent = e as CustomEvent<{ sheetId: string }>;
    if (customEvent.detail?.sheetId) {
      this.selectedSheetId = customEvent.detail.sheetId;
      this.rightCollapsed = false;
      this.updateRailCssVars();
    }
  };

  private readonly onEscapeKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.projectorMode) {
      this.toggleProjectorMode();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onGlobalPanelCollapseClick);
    window.addEventListener("dndm-open-sheet", this.onOpenSheet);
    window.addEventListener("keydown", this.onEscapeKey);
    diceOverlay.setDiceScale(this.diceScale);
    void this.libraryService.attach();

    if (typeof BroadcastChannel !== "undefined") {
      this.displaySyncChannel = new BroadcastChannel("dndm-display-sync");
      this.displaySyncChannel.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "state-sync" && this.projectorMode) {
          this.onStateChanged(event.data.state);
        }
      };
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("click", this.onGlobalPanelCollapseClick);
    window.removeEventListener("dndm-open-sheet", this.onOpenSheet);
    window.removeEventListener("keydown", this.onEscapeKey);
    window.removeEventListener("pointermove", this.onWindowPointerMove);
    window.removeEventListener("pointerup", this.onWindowPointerUp);
    window.removeEventListener("pointercancel", this.onWindowPointerUp);
    this.displaySyncChannel?.close();
    cancelAnimationFrame(this.rafId);
    this.controller?.destroy();
    this.hostInputTracker?.destroy();
    void this.libraryService.detach();
    diceOverlay.detach();
  }

  override updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);
    const overlayEl = this.renderRoot.querySelector("#dndm-dice-overlay") as HTMLElement | null;
    if (overlayEl && overlayEl !== diceOverlay.getContainer()) {
      void diceOverlay.attach(overlayEl);
    }
  }

  /** Attach the controller main.ts built. Safe to call once. */
  attach(controller: GameController): void {
    void this.libraryService.attach();
    this.controller = controller;
    this.match = controller.view.state;
    this.seenRollIds = new Set((this.match.rollLog ?? []).map((r) => r.id));
    this.isOwner = controller.isOwner;
    this.assetSource = createAssetSource(
      this.launchMode,
      this.libraryService,
      this.ticket,
      "local",
      fx.knockbox(),
    );

    this.hostInputTracker = new HostInputTracker({
      onKeysChanged: (heldKeys) => {
        this.send({ kind: "updateHostKeys", heldKeys });
      },
    });
    if (this.isDm && this.match.settings.loadedDiceEnabled) {
      this.hostInputTracker.attach();
    }

    this.initRailWidths();
    this.updateRailCssVars();

    this.listen(controller.events, "changed", ({ state }) => {
      this.onStateChanged(state);
    });
    this.listen(controller.events, "roster", ({ players, isOwner }) => {
      this.roster = players;
      const prevOwner = this.isOwner;
      this.isOwner = isOwner;
      if (
        isOwner &&
        players.length === 1 &&
        !this.hasSweptLocalBlobs &&
        this.launchMode === "local-tab"
      ) {
        this.hasSweptLocalBlobs = true;
        const idb = new IdbBlobTransport();
        idb.clear().finally(() => idb.close());
      }
      if (prevOwner !== isOwner) {
        this.initRailWidths();
        this.updateRailCssVars();
      }
      if (this.isDm && this.match.settings.loadedDiceEnabled) {
        this.hostInputTracker?.attach();
      } else {
        this.hostInputTracker?.detach();
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
    const leftPad = !this.isDm
      ? "0px"
      : !this.leftCollapsed
        ? `${this.leftRailWidth}px`
        : `${COLLAPSED_RAIL_PX}px`;
    const rightPad = !this.rightCollapsed ? `${this.rightRailWidth}px` : `${COLLAPSED_RAIL_PX}px`;

    this.style.setProperty("--dndm-rail-w-left", `${this.leftRailWidth}px`);
    this.style.setProperty("--dndm-rail-w-right", `${this.rightRailWidth}px`);
    this.style.setProperty("--dndm-rail-pad-left", leftPad);
    this.style.setProperty("--dndm-rail-pad-right", rightPad);

    const playingEl = this.renderRoot.querySelector(".dnd-mapper-playing") as HTMLElement | null;
    if (playingEl) {
      playingEl.style.setProperty("--dndm-rail-w-left", `${this.leftRailWidth}px`);
      playingEl.style.setProperty("--dndm-rail-w-right", `${this.rightRailWidth}px`);
      playingEl.style.setProperty("--dndm-rail-pad-left", leftPad);
      playingEl.style.setProperty("--dndm-rail-pad-right", rightPad);
    }

    diceOverlay.updateDimensions();

    const map = fx.map();
    if (map) {
      const leftInset = !this.isDm
        ? 0
        : !this.leftCollapsed
          ? this.leftRailWidth
          : COLLAPSED_RAIL_PX;
      const rightInset = !this.rightCollapsed ? this.rightRailWidth : COLLAPSED_RAIL_PX;
      map.setRailInsets(leftInset, rightInset);
    }
  }

  // ── Panel Collapse Logic (skipping interactive descendants) ────────────────
  private readonly onGlobalPanelCollapseClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const header = target.closest(".dndm-panel-header");
    if (!header) return;

    // If managed by dndm-collapsible-panel, it manages its own state
    if (header.closest("dndm-collapsible-panel")) return;

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
  private toggleRailCollapse(side: "left" | "right"): void {
    if (side === "left") {
      this.leftCollapsed = !this.leftCollapsed;
    } else {
      this.rightCollapsed = !this.rightCollapsed;
    }
    this.updateRailCssVars();
  }

  private readonly onWindowPointerMove = (e: PointerEvent): void => {
    this.onRailResizeMove(e);
  };

  private readonly onWindowPointerUp = (e: PointerEvent): void => {
    if (this.activeResizeSide) {
      this.endRailResize(this.activeResizeSide, e);
    }
  };

  private startRailResize(side: "left" | "right", e: PointerEvent): void {
    if (e.button !== 0) return;
    this.activeResizeSide = side;
    this.resizeStartX = e.clientX;
    this.isCollapsedAtDragStart = side === "left" ? this.leftCollapsed : this.rightCollapsed;
    this.resizeStartWidth = side === "left" ? this.leftRailWidth : this.rightRailWidth;
    this.resizeCurrentPx = this.resizeStartWidth;
    this.resizeMoved = false;

    const target = e.currentTarget as HTMLElement | null;
    try {
      target?.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    window.addEventListener("pointermove", this.onWindowPointerMove);
    window.addEventListener("pointerup", this.onWindowPointerUp);
    window.addEventListener("pointercancel", this.onWindowPointerUp);

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

    if (this.isCollapsedAtDragStart) {
      if (delta >= COLLAPSE_THRESHOLD_PX) {
        const nextPx = clampRail(Math.max(MIN_RAIL_PX, delta));
        this.resizeCurrentPx = nextPx;
        if (this.activeResizeSide === "left") {
          this.leftCollapsed = false;
          this.leftRailWidth = nextPx;
        } else {
          this.rightCollapsed = false;
          this.rightRailWidth = nextPx;
        }
      } else {
        if (this.activeResizeSide === "left") {
          this.leftCollapsed = true;
        } else {
          this.rightCollapsed = true;
        }
      }
    } else {
      const rawWidth = this.resizeStartWidth + delta;
      if (rawWidth < COLLAPSE_THRESHOLD_PX) {
        // Auto-collapsed: restore to resizeStartWidth upon uncollapsing
        if (this.activeResizeSide === "left") {
          this.leftCollapsed = true;
          this.leftRailWidth = this.resizeStartWidth;
        } else {
          this.rightCollapsed = true;
          this.rightRailWidth = this.resizeStartWidth;
        }
      } else {
        const nextPx = clampRail(rawWidth);
        this.resizeCurrentPx = nextPx;
        if (this.activeResizeSide === "left") {
          this.leftCollapsed = false;
          this.leftRailWidth = nextPx;
        } else {
          this.rightCollapsed = false;
          this.rightRailWidth = nextPx;
        }
      }
    }
    this.updateRailCssVars();
  }

  private endRailResize(side: "left" | "right", e: PointerEvent): void {
    if (!this.activeResizeSide) return;
    this.activeResizeSide = null;

    window.removeEventListener("pointermove", this.onWindowPointerMove);
    window.removeEventListener("pointerup", this.onWindowPointerUp);
    window.removeEventListener("pointercancel", this.onWindowPointerUp);

    const target = e.currentTarget as HTMLElement | null;
    try {
      target?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    const role = this.isDm ? "dm" : "player";

    if (this.resizeMoved) {
      const isCollapsed = side === "left" ? this.leftCollapsed : this.rightCollapsed;
      if (isCollapsed) {
        saveRailWidth(side, role, this.resizeStartWidth);
      } else {
        saveRailWidth(side, role, this.resizeCurrentPx);
      }
      this.updateRailCssVars();
    } else {
      // Click without drag toggles collapse
      this.toggleRailCollapse(side);
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
      map.updateSheets(this.match.sheets);
    }
    map.setActiveTurnTokenId(resolveActiveTurnTokenId(this.match.activeCombat));

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

  private toggleProjectorMode(): void {
    this.projectorMode = !this.projectorMode;
    this.onStateChanged(this.match);
  }

  private onStateChanged(state: Readonly<MatchState>): void {
    const prevRollLog = this.match?.rollLog ?? [];
    const prevMapId = this.match.activeMapId;
    this.match = state;

    if (this.displaySyncChannel && !this.projectorMode) {
      try {
        this.displaySyncChannel.postMessage({ type: "state-sync", state });
      } catch {
        // channel could be closed
      }
    }

    const map = fx.map();
    if (map) {
      const activeMap = this.activeMap;
      if (activeMap) {
        if (this.projectorMode) {
          map.setProjectorMode(true);
          const displayTokens = filterDisplayTokens(
            activeMap.tokens,
            activeMap.fogMask,
            activeMap.grid,
          );
          const displayImages = filterDisplayImages(
            activeMap.images,
            activeMap.fogMask,
            activeMap.grid,
          );
          if (prevMapId !== activeMap.id) {
            map.setMap(
              { ...activeMap, tokens: displayTokens, images: displayImages },
              false,
              this.assetSource,
            );
            map.updateSheets(state.sheets);
          } else {
            map.updateGrid(activeMap.grid);
            map.updateTokens(displayTokens);
            map.updateImages(displayImages);
            map.updateSheets(state.sheets);
            if (activeMap.fogMask) {
              map.updateFog(activeMap.fogMask);
            }
            map.updateMarkup(activeMap.markupSvg ?? null);
          }
          if (state.focusRect) {
            map.frameBox(state.focusRect);
          } else {
            map.frameBox({
              x: 0,
              y: 0,
              width: activeMap.grid.widthCells,
              height: activeMap.grid.heightCells,
            });
          }
        } else {
          map.setProjectorMode(false);
          if (prevMapId !== activeMap.id) {
            map.setMap(activeMap, this.isDm, this.assetSource);
            map.updateSheets(state.sheets);
          } else {
            map.updateGrid(activeMap.grid);
            map.updateTokens(activeMap.tokens);
            map.updateImages(activeMap.images);
            map.updateSheets(state.sheets);
            if (activeMap.fogMask) {
              map.updateFog(activeMap.fogMask);
            }
            map.updateMarkup(activeMap.markupSvg ?? null);
          }
        }
      }
      map.setActiveTurnTokenId(resolveActiveTurnTokenId(state.activeCombat));
      map.setFocusRect(state.focusRect);

      if (
        !this.projectorMode &&
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

    if (this.isDm && state.settings.loadedDiceEnabled) {
      this.hostInputTracker?.attach();
    } else {
      this.hostInputTracker?.detach();
    }

    const currentRollLog = state.rollLog ?? [];

    if (currentRollLog.length === 0 && prevRollLog.length > 0) {
      this.seenRollIds.clear();
    }

    const newRolls = currentRollLog.filter((r) => !this.seenRollIds.has(r.id));
    for (const roll of newRolls) {
      this.seenRollIds.add(roll.id);

      const isVisible =
        this.isDm ||
        state.settings.rollsVisibleToPlayers ||
        roll.rollerUserId === this.controller?.playerId;

      if (isVisible) {
        const diceColor = roll.tokenId
          ? resolveDiceColorForToken(state, roll.tokenId)
          : resolveDiceColor(state, roll.rollerUserId);
        const fontColor = getReadableTextColor(diceColor);

        diceOverlay.roll(roll, diceColor, fontColor).catch((err) => {
          log.warn("Dice roll animation error:", err);
        });
      }
    }

    if (this.seenRollIds.size > 200) {
      this.seenRollIds = new Set(currentRollLog.map((r) => r.id));
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

    if (this.projectorMode) {
      return html`
        <div class="dndm-display-view">
          <button
            class="dndm-display-exit-btn"
            type="button"
            title="Exit Theater Mode (Esc)"
            @click=${() => this.toggleProjectorMode()}
          >
            ${fullscreenExitIcon()} Exit Theater (Esc)
          </button>
          <div class="dndm-dice-canvas-overlay" id="dndm-dice-overlay"></div>
          <dndm-display-roll-ticker
            .rolls=${this.match.rollLog ?? []}
            .tokens=${active?.tokens ?? []}
            .isDm=${this.isDm}
            .currentUserId=${me}
            .rollsVisibleToPlayers=${settings.rollsVisibleToPlayers}
          ></dndm-display-roll-ticker>
        </div>
      `;
    }

    return html`
      <div
        class="dnd-mapper-playing ${this.isDm ? "dnd-mapper-playing--host" : ""} ${
          this.leftCollapsed ? "dnd-mapper-playing--left-collapsed" : ""
        } ${this.rightCollapsed ? "dnd-mapper-playing--right-collapsed" : ""}"
        style="--dndm-rail-w-left: ${this.leftRailWidth}px; --dndm-rail-w-right: ${this.rightRailWidth}px;"
      >
        <!-- Left Rail (DM Only) -->
        ${
          this.isDm
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

                    <dndm-layer-panel
                      .activeMap=${active}
                      .selectedImageId=${this.selectedImageId}
                      .assetSource=${this.assetSource}
                      .libraryService=${this.libraryService}
                      .onImageUploaded=${async (
                        newImg: NewMapImage,
                        blob: Blob,
                        imageId: string,
                      ) => {
                        if (active) {
                          await this.assetSource.publish(imageId, blob);
                          this.send({ kind: "addImage", mapId: active.id, image: newImg, imageId });
                          toastService.success(`Added image layer "${newImg.name}"`);
                        }
                      }}
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
                    ></dndm-layer-panel>

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

                    ${
                    settings.loadedDiceEnabled
                      ? html`
                          <dndm-loaded-dice-panel
                            .rules=${this.match.loadedDiceRules ?? []}
                            .sheets=${this.match.sheets}
                            .maps=${maps}
                            .hostHeldKeys=${this.match.hostHeldKeys ?? []}
                            .onCreateRule=${(rule: Omit<LoadedDiceRule, "id">) =>
                            this.send({ kind: "createLoadedDiceRule", rule })}
                            .onUpdateRule=${(ruleId: string, patch: Partial<LoadedDiceRule>) =>
                            this.send({ kind: "updateLoadedDiceRule", ruleId, patch })}
                            .onDeleteRule=${(ruleId: string) =>
                            this.send({ kind: "deleteLoadedDiceRule", ruleId })}
                            .onToggleRule=${(ruleId: string, enabled: boolean) =>
                            this.send({ kind: "toggleLoadedDiceRule", ruleId, enabled })}
                            .onReorderRules=${(ruleIds: readonly string[]) =>
                            this.send({ kind: "reorderLoadedDiceRules", ruleIds })}
                          ></dndm-loaded-dice-panel>
                        `
                      : nothing
                  }

                    <dndm-collapsible-panel
                      panelTitle="Session"
                      panelClass="dndm-session-panel"
                      bodyClass="dndm-session-actions"
                      .actions=${html`
                        <button
                          class="dndm-btn dndm-btn--icon dndm-btn--small"
                          type="button"
                          title="Session Settings"
                          @click=${() => {
                            this.settingsModalOpen = true;
                          }}
                        >
                          ${gearIcon()}
                        </button>
                      `}
                      .content=${html`
                        <button
                          class="dndm-btn ${this.lobbyOpen ? "dndm-btn--danger" : "dndm-btn--ghost"} dndm-btn--small"
                          type="button"
                          @click=${() => {
                            this.lobbyOpen = !this.lobbyOpen;
                            this.controller?.setLobbyOpen(this.lobbyOpen);
                          }}
                        >
                          ${this.lobbyOpen ? html`${lockIcon(true)} Close Lobby` : html`${lockIcon(false)} Open Lobby`}
                        </button>
                        <button
                          class="dndm-btn dndm-btn--ghost dndm-btn--small dndm-btn--icon"
                          type="button"
                          title="Enter Projector Theater Mode"
                          aria-label="Enter Projector Theater Mode"
                          @click=${() => this.toggleProjectorMode()}
                        >
                          ${fullscreenIcon()}
                        </button>
                        <button
                          class="dndm-btn dndm-btn--ghost dndm-btn--small"
                          type="button"
                          title="Open Projector in a new window"
                          @click=${() => window.open("?view=display", "_blank")}
                        >
                          ↗ Popout
                        </button>
                      `}
                    ></dndm-collapsible-panel>
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
            : nothing
        }

        <!-- Canvas Area -->
        <main
          class="dndm-canvas-area"
          @dragover=${this.onCanvasDragOver}
          @dragleave=${this.onCanvasDragLeave}
          @drop=${this.onCanvasDrop}
        >
          <div class="dndm-dice-canvas-overlay" id="dndm-dice-overlay"></div>
          <dndm-initiative-banner
            .combat=${this.match.activeCombat}
            .currentUserId=${this.controller?.playerId ?? null}
            .isDm=${this.isDm}
            .tokens=${active?.tokens ?? []}
            .sheets=${this.match.sheets}
            .onRollInitiative=${(combatantId: string) => this.send({ kind: "rollInitiative", combatantId })}
            .onFocusToken=${(tokenId: string) => {
              const tok = active?.tokens.find((t) => t.id === tokenId);
              if (tok) {
                fx.map()?.panToWorld(tok.x * 50, tok.y * 50);
              }
            }}
          ></dndm-initiative-banner>

          ${
            this.isDm && this.toolMode === "markup" && active
              ? html`
                  <dndm-markup-overlay
                    .activeMap=${active}
                    .onCommitMarkup=${(svg: string | null) => {
                    this.send({ kind: "updateMarkup", mapId: active.id, markupSvg: svg });
                  }}
                    .onClose=${() => {
                    this.toolMode = "none";
                    fx.map()?.setToolMode("none");
                  }}
                  ></dndm-markup-overlay>
                `
              : nothing
          }
          ${
            !active
              ? html`
                  <div class="dndm-empty">
                    ${
                    this.isDm
                      ? html`<span
                          >No active map. Create one from the <strong>Maps</strong> panel.</span
                        >`
                      : html`<span>Waiting for the DM to choose a map…</span>`
                  }
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

                  ${
                  this.isDm && this.selectedImage
                    ? html`
                        <div class="dndm-canvas-inspector">
                          <dndm-image-inspector
                            .image=${this.selectedImage}
                            .maxLayerOrder=${Math.max(...active.images.map((i) => i.layerOrder), 0)}
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
                    : nothing
                }
                `
          }

          ${active
            ? html`
                <dndm-token-rail
                  .tokens=${active.tokens}
                  .sheets=${this.match.sheets}
                  .roster=${this.roster}
                  .dmPlayerId=${this.match.dmPlayerId}
                  .currentUserId=${this.controller?.playerId ?? null}
                  .isDm=${this.isDm}
                  .onCenterOnToken=${(x: number, y: number) => {
                    fx.map()?.centerOn(x, y);
                  }}
                  .onUpdateToken=${(
                    id: string,
                    patch: { name?: string; color?: string; iconKind?: "Initial" | "Solid" },
                  ) => this.send({ kind: "updateToken", tokenId: id, patch })}
                  .onToggleHidden=${(id: string, hidden: boolean) =>
                    this.send({ kind: "setTokenHidden", tokenId: id, hidden })}
                  .onDeleteToken=${(id: string) => this.send({ kind: "removeToken", tokenId: id })}
                  .onReassignOwner=${(tokenId: string, newOwnerUserId: string | null) =>
                    this.send({ kind: "reassignTokenOwner", tokenId, newOwnerUserId })}
                ></dndm-token-rail>
              `
            : nothing}

          <dndm-quick-roll-footer
            .state=${this.match}
            .isDm=${this.isDm}
            .currentUserId=${this.controller?.playerId ?? null}
            .selectedSheetId=${this.selectedSheetId}
            .soundEnabled=${this.diceSoundEnabled}
            .onToggleSound=${() => {
              this.diceSoundEnabled = !this.diceSoundEnabled;
              diceOverlay.setSoundEnabled(this.diceSoundEnabled);
            }}
            .diceScale=${this.diceScale}
            .onChangeDiceScale=${(scale: number) => {
              this.diceScale = scale;
              saveDiceScale(scale);
              diceOverlay.setDiceScale(scale);
            }}
            .onRollDice=${(
              formula: string,
              mode: RollMode,
              label?: string,
              sheetId?: string | null,
              attributeName?: string | null,
            ) => {
              this.send({
                kind: "rollDice",
                formula,
                mode,
                label,
                tokenId: myToken?.id ?? null,
                sheetId: sheetId ?? this.selectedSheetId ?? null,
                attributeName,
              });
            }}
            .onRollTemplate=${(
              templateId: string,
              modeOverride?: RollMode,
              sheetId?: string | null,
            ) => {
              this.send({
                kind: "rollTemplate",
                templateId,
                modeOverride,
                tokenId: myToken?.id ?? null,
                sheetId: sheetId ?? this.selectedSheetId ?? null,
              });
            }}
            .onOpenHistory=${() => {
              this.rollHistoryOpen = true;
            }}
            .onReRoll=${(r: RollResult, modeOverride?: RollMode) => {
              this.send({
                kind: "rollDice",
                formula: r.formula,
                mode: modeOverride ?? r.mode,
                label: r.label,
                tokenId: r.tokenId,
                sheetId: r.originalAttributeRef?.sheetId ?? this.selectedSheetId ?? null,
                attributeName: r.originalAttributeRef?.attributeName ?? null,
              });
            }}
            .onOpenTemplates=${() => {
              this.rollTemplateLibraryOpen = true;
            }}
          ></dndm-quick-roll-footer>
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
            ${
              this.isDm
                ? html`
                    <dndm-host-initiative
                      .combat=${this.match.activeCombat}
                      .activeMap=${active}
                      .sheets=${this.match.sheets}
                      .isDm=${this.isDm}
                      .currentUserId=${this.controller?.playerId ?? null}
                      .onStartCombat=${(mapId: string) => this.send({ kind: "startCombat", mapId })}
                      .onEndCombat=${() => this.send({ kind: "endCombat" })}
                      .onNextTurn=${() => this.send({ kind: "nextTurn" })}
                      .onPreviousTurn=${() => this.send({ kind: "previousTurn" })}
                      .onRollInitiative=${(combatantId: string) =>
                      this.send({ kind: "rollInitiative", combatantId })}
                      .onForceRoll=${(combatantId: string) =>
                      this.send({ kind: "forceInitiativeRoll", combatantId })}
                      .onSetNpcInitiative=${(combatantId: string, score: number) =>
                      this.send({ kind: "setNpcInitiative", combatantId, score })}
                      .onRollAllUnsetNpcs=${() => this.send({ kind: "rollAllUnsetNpcs" })}
                      .onRollAllNpcInitiative=${() => this.send({ kind: "rollAllNpcInitiative" })}
                      .onAddCombatant=${(tokenId: string, initiativeRoll: number) =>
                      this.send({ kind: "addCombatant", tokenId, initiativeRoll })}
                      .onRemoveCombatant=${(combatantId: string) =>
                      this.send({ kind: "removeCombatant", combatantId })}
                      .onFocusToken=${(tokenId: string) => {
                      const tok = active?.tokens.find((t) => t.id === tokenId);
                      if (tok) {
                        fx.map()?.panToWorld(tok.x * 50, tok.y * 50);
                      }
                    }}
                      .onSetSheetHp=${(sheetId: string, hp: number | null) =>
                      this.send({ kind: "setSheetHp", sheetId, hp })}
                    ></dndm-host-initiative>
                  `
                : nothing
            }
            ${
              !this.isDm
                ? html`
                    <dndm-my-token
                      .token=${myToken}
                      .onChangeColor=${(tokenId: string, color: string) =>
                      this.send({ kind: "updateToken", tokenId, patch: { color } })}
                    ></dndm-my-token>
                  `
                : nothing
            }
            <dndm-character-sheet
              .sheets=${this.match.sheets}
              .selectedSheetId=${this.selectedSheetId}
              .activeMapId=${this.match.activeMapId}
              .attributeSchema=${this.match.attributeSchema}
              .statusEffectTemplates=${this.match.statusEffectTemplates}
              .customTemplates=${this.match.customTemplates}
              .settings=${this.match.settings}
              .isDm=${this.isDm}
              .currentUserId=${this.controller?.playerId ?? null}
              .roster=${this.roster}
              .dmPlayerId=${this.match.dmPlayerId}
              .maps=${this.match.maps}
              .onSelectSheet=${(id: string | null) => {
                this.selectedSheetId = id;
              }}
              .onCreateSheet=${(characterName?: string, scopedMapId?: string | null) =>
                this.send({
                  kind: "createSheet",
                  characterName: characterName || "New Character",
                  scopedMapId,
                })}
              .onUpdateSheet=${(sheetId: string, patch: SheetPatch) =>
                this.send({ kind: "updateSheet", sheetId, patch })}
              .onAssignSheetOwner=${(sheetId: string, ownerUserId: string | null) =>
                this.send({ kind: "assignSheetOwner", sheetId, ownerUserId })}
              .onSetSheetHp=${(sheetId: string, hp: number | null) =>
                this.send({ kind: "setSheetHp", sheetId, hp })}
              .onSetSheetMaxHp=${(sheetId: string, maxHp: number | null) =>
                this.send({ kind: "setSheetMaxHp", sheetId, maxHp })}
              .onSetSheetAc=${(sheetId: string, ac: number | null) =>
                this.send({ kind: "setSheetAc", sheetId, ac })}
              .onDeleteSheet=${(sheetId: string) => this.send({ kind: "deleteSheet", sheetId })}
              .onDuplicateSheet=${(sheetId: string) =>
                this.send({ kind: "duplicateSheet", sheetId })}
              .onUpdateAttributeValues=${(
                sheetId: string,
                values: Readonly<Record<string, AttributeValue>>,
              ) => this.send({ kind: "updateAttributeValues", sheetId, values })}
              .onApplyStatusEffect=${(
                sheetId: string,
                effect: Omit<StatusEffect, "id" | "appliedUtc">,
              ) => this.send({ kind: "applyStatusEffect", sheetId, effect })}
              .onRemoveStatusEffect=${(sheetId: string, effectId: string) =>
                this.send({ kind: "removeStatusEffect", sheetId, effectId })}
              .onSetSchemaPreset=${(preset: AttributePreset) =>
                this.send({ kind: "setSchemaPreset", preset })}
            ></dndm-character-sheet>
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
          .onCancel=${() => {
            this.settingsModalOpen = false;
          }}
          @close=${() => {
            this.settingsModalOpen = false;
          }}
          @cancel=${() => {
            this.settingsModalOpen = false;
          }}
        ></dndm-permissions>

        <dndm-roll-template-library
          ?isOpen=${this.rollTemplateLibraryOpen}
          .state=${this.match}
          .sheetId=${this.selectedSheetId}
          .isDm=${this.isDm}
          .currentUserId=${this.controller?.playerId ?? null}
          .onCreateGlobalTemplate=${(template: Omit<RollTemplate, "id" | "scope">) =>
            this.send({ kind: "createGlobalRollTemplate", template })}
          .onUpdateGlobalTemplate=${(
            templateId: string,
            patch: Partial<Omit<RollTemplate, "id" | "scope">>,
          ) => this.send({ kind: "updateGlobalRollTemplate", templateId, patch })}
          .onDeleteGlobalTemplate=${(templateId: string) =>
            this.send({ kind: "deleteGlobalRollTemplate", templateId })}
          .onCreateSheetTemplate=${(
            sheetId: string,
            template: Omit<RollTemplate, "id" | "scope">,
          ) => this.send({ kind: "createRollTemplate", sheetId, template })}
          .onUpdateSheetTemplate=${(
            sheetId: string,
            templateId: string,
            patch: Partial<Omit<RollTemplate, "id" | "scope">>,
          ) => this.send({ kind: "updateRollTemplate", sheetId, templateId, patch })}
          .onDeleteSheetTemplate=${(sheetId: string, templateId: string) =>
            this.send({ kind: "deleteRollTemplate", sheetId, templateId })}
          .onClose=${() => {
            this.rollTemplateLibraryOpen = false;
          }}
          .onCancel=${() => {
            this.rollTemplateLibraryOpen = false;
          }}
          @close=${() => {
            this.rollTemplateLibraryOpen = false;
          }}
          @cancel=${() => {
            this.rollTemplateLibraryOpen = false;
          }}
        ></dndm-roll-template-library>

        <dndm-roll-history
          ?isOpen=${this.rollHistoryOpen}
          .state=${this.match}
          .isDm=${this.isDm}
          .currentUserId=${this.controller?.playerId ?? null}
          .onClearLog=${() => this.send({ kind: "clearRollLog" })}
          .onReRoll=${(r: RollResult, modeOverride?: RollMode) => {
            this.send({
              kind: "rollDice",
              formula: r.formula,
              mode: modeOverride ?? r.mode,
              label: r.label,
              tokenId: r.tokenId,
              sheetId: r.originalAttributeRef?.sheetId ?? this.selectedSheetId ?? null,
              attributeName: r.originalAttributeRef?.attributeName ?? null,
            });
          }}
          .onClose=${() => {
            this.rollHistoryOpen = false;
          }}
          .onCancel=${() => {
            this.rollHistoryOpen = false;
          }}
          @close=${() => {
            this.rollHistoryOpen = false;
          }}
          @cancel=${() => {
            this.rollHistoryOpen = false;
          }}
        ></dndm-roll-history>

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
