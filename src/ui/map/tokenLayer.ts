/*
 * Token layer in Phaser MapScene.
 * Renders token containers with owner halos, readable initials, stacking chips, and fan-out popovers.
 * Belongs at DEPTH.TOKENS (4000).
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import type { CharacterSheet, GridConfig, Token } from "../../game/domain";
import { decodeFog, isFogged, type FogMaskBytes } from "../../game/fog";
import { TOKEN_RADIUS, TOKEN_OWNER_HALO_RADIUS, TOKEN_STACK_CHIP_RADIUS } from "../../game/domain";
import { snapToken } from "../../game/snapping";
import {
  groupTokensIntoStacks,
  getStackChipPositions,
  type TokenStack,
  type StackPopoverLayout,
} from "../../game/stacking";
import { getReadableTextColor } from "../../game/color";

export interface TokenDragEvent {
  tokenId: string;
  x: number;
  y: number;
}

/** Slide duration when another participant's move arrives. */
const MOVE_TWEEN_MS = 250;
/** Fade duration when a token leaves this viewer's projection (e.g. into fog). */
const FADE_OUT_MS = 300;
/** Fade duration when a token enters this viewer's projection (e.g. out of fog). */
const FADE_IN_MS = 300;
/** How long a local drop outranks updates still carrying the pre-drag position. */
const PENDING_MOVE_TTL_MS = 1500;
/** Cell-space tolerance for "same position" comparisons. */
const POS_EPSILON = 1e-3;

/** A drop this viewer made that the authority has not echoed back yet. */
interface PendingLocalMove {
  fromX: number;
  fromY: number;
  x: number;
  y: number;
  at: number;
}

interface DragState {
  tokenId: string;
  startX: number;
  startY: number;
  didDrag: boolean;
}

function samePos(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) < POS_EPSILON && Math.abs(ay - by) < POS_EPSILON;
}

export class TokenLayer {
  private readonly tokenContainers = new Map<string, Phaser.GameObjects.Container>();
  private readonly popoverContainer: Phaser.GameObjects.Container;
  private readonly popoverGfx: Phaser.GameObjects.Graphics;

  private tokens: readonly Token[] = [];
  private sheets: Readonly<Record<string, CharacterSheet>> = {};
  private grid: GridConfig = {
    widthCells: 30,
    heightCells: 20,
    cellPixels: CELL,
    showGridLines: true,
    snapToGrid: true,
    lineColor: "#222",
  };
  private isDm = false;
  private viewerUserId: string | null = null;
  private fogBytes: FogMaskBytes = new Uint8Array(0);
  // Remote moves slide; the mover's own drops snap. A local drop is recorded
  // here so the authority's echo (or a stale pre-drop update) never animates.
  private readonly pendingLocalMoves = new Map<string, PendingLocalMove>();
  // Running slides, keyed by token, with their world-space target so repeated
  // rebuilds (sheets, turn ring) don't restart an in-flight slide.
  private readonly moveTweens = new Map<
    string,
    { tween: Phaser.Tweens.Tween; x: number; y: number }
  >();
  // Drag state lives on the layer, not in listener closures: rebuildTokens
  // replaces listeners, and a mid-drag rebuild must not lose it.
  private activeDrag: DragState | null = null;
  private activeChipDrag: DragState | null = null;
  // Containers of tokens that left the list, fading out before destruction.
  // Detached from tokenContainers so rebuilds and hit tests ignore them.
  private readonly fadingOut = new Map<
    string,
    { container: Phaser.GameObjects.Container; tween: Phaser.Tweens.Tween }
  >();
  // Tokens that just entered the list, fading up to `alpha` (1, or the DM's
  // hidden-token ghost). updateVisibility leaves their alpha to the tween.
  private readonly fadingIn = new Map<string, { tween: Phaser.Tweens.Tween; alpha: number }>();
  private expandedStackCell: string | null = null;
  private activeTurnTokenId: string | null = null;
  // Client-side move gate. Mirrors the server's mayMoveToken decision for the
  // current user (wired from dndm-app via MapScene). Denied tokens render
  // click-only and never emit onTokenMoveEnd.
  private canMoveToken: (token: Token) => boolean = () => true;
  // Sticky tool lock: while a map tool is selected, tokens stay
  // non-interactive across rebuilds (setTokens on every state sync).
  private interactionsEnabled = true;

  public onTokenMoveEnd?: (event: TokenDragEvent) => void;
  public onTokenDoubleClick?: (tokenId: string) => void;

  constructor(private readonly scene: Phaser.Scene) {
    this.popoverGfx = this.scene.add.graphics();
    this.popoverGfx.setDepth(DEPTH.TOKENS + 9);

    this.popoverContainer = this.scene.add.container(0, 0);
    this.popoverContainer.setDepth(DEPTH.TOKENS + 10);
  }

  setActiveTurnTokenId(tokenId: string | null): void {
    if (this.activeTurnTokenId !== tokenId) {
      this.activeTurnTokenId = tokenId;
      this.rebuildTokens();
    }
  }

  setDm(isDm: boolean): void {
    const changed = this.isDm !== isDm;
    this.isDm = isDm;
    // DM toggle changes the visible set (hidden tokens), which changes stack
    // badge bearers — rebuild rather than just updating visibility.
    if (changed) this.rebuildTokens();
    else this.updateVisibility();
  }

  setCanMoveToken(fn: (token: Token) => boolean): void {
    this.canMoveToken = fn;
    this.rebuildTokens();
  }

  setGrid(grid: GridConfig): void {
    this.grid = grid;
  }

  /** Identity of the viewing player; fogged tokens they don't own are hidden. */
  setViewerUserId(userId: string | null): void {
    if (this.viewerUserId === userId) return;
    this.viewerUserId = userId;
    this.updateVisibility();
  }

  /** Current fog bitset (base64); empty means all-revealed. */
  setFogMask(maskB64: string): void {
    this.fogBytes = decodeFog(maskB64 ?? "");
    this.updateVisibility();
  }

  /**
   * Whether this token's cell is concealed from the current viewer: standing
   * on fog while the viewer is neither DM nor owner (owner or represented
   * user — NPC tokens with no owner are DM-only in fog).
   */
  private isFogConcealed(token: Token): boolean {
    if (this.isDm) return false;
    if (this.fogBytes.length === 0) return false;
    if (!isFogged(this.fogBytes, this.grid, Math.floor(token.x), Math.floor(token.y))) {
      return false;
    }
    return token.ownerUserId !== this.viewerUserId && token.representsUserId !== this.viewerUserId;
  }

  setSheets(sheets: Readonly<Record<string, CharacterSheet>>): void {
    this.sheets = sheets;
    this.rebuildTokens();
  }

  /** Apply the token list. `animate: false` snaps every token (map switch,
   *  context restore); otherwise other participants' moves slide. */
  setTokens(tokens: readonly Token[], opts: { animate?: boolean } = {}): void {
    this.tokens = tokens;
    this.rebuildTokens(opts.animate ?? true);
  }

  /** Tokens to stack and render. Hiding is owned by host projection
   *  (`projectForPlayer`): guests never receive hidden tokens. Fog concealment
   *  is enforced server-side too, with `updateVisibility` re-checking it
   *  client-side (covers patch races). The DM renders the full truth, with
   *  hidden tokens ghosted in `updateVisibility`. */
  private visibleTokens(): readonly Token[] {
    return this.tokens;
  }

  /** Stacks built from the projected tokens, plus a cell-key lookup. */
  private stacksForViewer(): { stacks: TokenStack[]; byCell: Map<string, TokenStack> } {
    const stacks = groupTokensIntoStacks(this.visibleTokens());
    const byCell = new Map<string, TokenStack>();
    for (const s of stacks) {
      byCell.set(`${s.cell.cellX},${s.cell.cellY}`, s);
    }
    return { stacks, byCell };
  }

  /** Apply interactive + draggable state. Phaser's setInteractive() only acts
   *  on truthy `draggable`, so force the flag explicitly to allow turning an
   *  already-interactive container back to click-only. */
  private applyDraggable(
    container: Phaser.GameObjects.Container,
    draggable: boolean,
  ): void {
    container.setInteractive({ draggable });
    const input = container.input as unknown as { draggable: boolean } | null;
    if (input) input.draggable = draggable;
  }

  private cellKeyOf(token: Token): string {
    return `${Math.floor(token.x)},${Math.floor(token.y)}`;
  }

  /** Whether the map-level container for this token is directly draggable.
   *  Stacked tokens move via popover chips only (click the stack first). */
  private isDirectlyMovable(token: Token, stack: TokenStack | undefined): boolean {
    if (!this.canMoveToken(token)) return false;
    if (stack && stack.tokens.length > 1) return false;
    return true;
  }

  private updateVisibility(): void {
    const { byCell } = this.stacksForViewer();
    // Topmost *visible* token per stack; hidden stack-tops must not mask it.
    const topVisibleById = new Set<string>();
    for (const s of byCell.values()) {
      if (s.tokens.length > 0) topVisibleById.add(s.tokens[0].id);
    }

    for (const token of this.tokens) {
      const container = this.tokenContainers.get(token.id);
      if (!container) continue;

      const stack = byCell.get(this.cellKeyOf(token));
      const isStackedBehind =
        stack !== undefined && stack.tokens.length > 1 && stack.tokens[0].id !== token.id;
      // A token sliding onto an occupied cell stays visible until it lands;
      // the slide's onComplete re-runs this to settle the stack.
      const isSliding = this.moveTweens.has(token.id);

      if (isSliding && !token.hidden && !this.isFogConcealed(token)) {
        container.setVisible(true);
        this.applyAlpha(token.id, container, 1.0);
      } else if (isStackedBehind) {
        container.setVisible(false);
      } else if (!topVisibleById.has(token.id)) {
        // Stacked behind another token — hidden regardless of viewer.
        container.setVisible(false);
      } else if (this.isFogConcealed(token)) {
        // Standing on fog the viewer neither DMs nor owns: concealed.
        // (Server projection already strips these for guests; this covers
        // the host DM's own view state and any race between patches.)
        container.setVisible(false);
      } else if (token.hidden) {
        // DM-only branch: the DM renders the full truth, so hidden tokens
        // arrive here and render ghosted. Guests never receive them.
        container.setVisible(true);
        this.applyAlpha(token.id, container, 0.5);
      } else {
        container.setVisible(true);
        this.applyAlpha(token.id, container, 1.0);
      }
    }
  }

  /** Set a token's resting alpha, deferring to a fade-in already headed there. */
  private applyAlpha(
    tokenId: string,
    container: Phaser.GameObjects.Container,
    alpha: number,
  ): void {
    const fading = this.fadingIn.get(tokenId);
    if (fading) {
      if (fading.alpha === alpha) return;
      this.stopFadeIn(tokenId);
    }
    container.setAlpha(alpha);
  }

  private rebuildTokens(animate = true): void {
    if (!animate) {
      for (const id of [...this.fadingOut.keys()]) this.cancelFadeOut(id);
      for (const id of [...this.fadingIn.keys()]) this.stopFadeIn(id);
    }

    // Remove obsolete containers
    const activeIds = new Set(this.tokens.map((t) => t.id));
    for (const [id, container] of this.tokenContainers.entries()) {
      if (!activeIds.has(id)) {
        this.stopMoveTween(id);
        // Leaving mid-fade-in: fade out from wherever the fade-in got to.
        this.stopFadeIn(id);
        this.pendingLocalMoves.delete(id);
        if (this.activeDrag?.tokenId === id) this.activeDrag = null;
        this.tokenContainers.delete(id);
        if (animate) this.fadeOutAndDestroy(id, container);
        else container.destroy(true);
      }
    }

    const { byCell: stackMap } = this.stacksForViewer();
    const entered: string[] = [];

    for (const token of this.tokens) {
      let container = this.tokenContainers.get(token.id);
      const isNew = !container;

      if (isNew) {
        if (animate) entered.push(token.id);
        // Back in view before its fade finished: drop the ghost outright.
        this.cancelFadeOut(token.id);
        container = this.scene.add.container(token.x * CELL, token.y * CELL);
        container.setDepth(DEPTH.TOKENS);
        this.tokenContainers.set(token.id, container);
        this.pendingLocalMoves.delete(token.id);
      } else {
        container!.removeAll(true);
        // Drop stale input listeners from the previous build; otherwise every
        // setTokens() accumulates duplicate DRAG_END handlers with stale
        // closures that fight over the container position.
        container!.removeAllListeners();
        this.positionContainer(container!, token, animate);
      }

      const cellKey = this.cellKeyOf(token);
      const stack = stackMap.get(cellKey);
      this.populateTokenContainer(container!, token, {
        draggable: this.interactionsEnabled && this.isDirectlyMovable(token, stack),
      });
      if (!this.interactionsEnabled) {
        container!.disableInteractive();
      }

      // Add stack count badge if multiple *visible* tokens share this cell
      if (stack && stack.tokens.length > 1 && stack.tokens[0].id === token.id) {
        this.addStackBadge(container!, stack.tokens.length);
      } else if (stack && stack.tokens.length > 1 && stack.tokens[0].id !== token.id) {
        // Stacked tokens behind the top token are hidden until expanded
        container!.setVisible(false);
      }
    }

    this.updateVisibility();
    // After updateVisibility, so each fade targets the token's resting alpha.
    for (const id of entered) this.fadeIn(id);

    // If active popover is open, update or close it
    if (this.expandedStackCell) {
      const activeStack = stackMap.get(this.expandedStackCell);
      if (activeStack && activeStack.tokens.length > 1) {
        this.renderPopover(activeStack);
      } else {
        this.closePopover();
      }
    }
  }

  /**
   * Move an existing container to its token's position. Other participants'
   * moves slide; this viewer's own drops snap (the container already sits at
   * the drop point), and a container under the pointer is left alone.
   */
  private positionContainer(
    container: Phaser.GameObjects.Container,
    token: Token,
    animate: boolean,
  ): void {
    if (this.activeDrag?.tokenId === token.id) return;

    const targetX = token.x * CELL;
    const targetY = token.y * CELL;

    const pending = this.pendingLocalMoves.get(token.id);
    if (pending) {
      const isStale =
        !samePos(token.x, token.y, pending.x, pending.y) &&
        samePos(token.x, token.y, pending.fromX, pending.fromY) &&
        Date.now() - pending.at < PENDING_MOVE_TTL_MS;
      this.stopMoveTween(token.id);
      if (isStale) {
        // Update sent before the authority applied our move: hold the drop.
        container.setPosition(pending.x * CELL, pending.y * CELL);
        return;
      }
      // Our move echoed back (possibly re-snapped by the host), was
      // superseded, or timed out: adopt the authoritative position instantly.
      this.pendingLocalMoves.delete(token.id);
      container.setPosition(targetX, targetY);
      return;
    }

    const running = this.moveTweens.get(token.id);
    if (running && running.x === targetX && running.y === targetY) return;
    this.stopMoveTween(token.id);

    const moved = Math.abs(container.x - targetX) > 1 || Math.abs(container.y - targetY) > 1;
    if (!animate || !moved || !this.scene.tweens) {
      container.setPosition(targetX, targetY);
      return;
    }

    const tween = this.scene.tweens.add({
      targets: container,
      x: targetX,
      y: targetY,
      duration: MOVE_TWEEN_MS,
      ease: "Quad.easeOut",
      onComplete: () => {
        if (this.moveTweens.get(token.id)?.tween !== tween) return;
        this.moveTweens.delete(token.id);
        this.updateVisibility();
      },
    });
    this.moveTweens.set(token.id, { tween, x: targetX, y: targetY });
  }

  private stopMoveTween(tokenId: string): void {
    const running = this.moveTweens.get(tokenId);
    if (!running) return;
    this.moveTweens.delete(tokenId);
    running.tween.stop();
  }

  /**
   * Fade out a token that left this viewer's list, then destroy it. The host
   * strips tokens that move into fog (or are hidden/deleted), so this is the
   * only signal the viewer gets; the fade happens where the token was last
   * seen and never slides toward where it went.
   */
  private fadeOutAndDestroy(tokenId: string, container: Phaser.GameObjects.Container): void {
    if (!container.visible || !this.scene.tweens) {
      container.destroy(true);
      return;
    }
    container.disableInteractive();
    container.removeAllListeners();
    const tween = this.scene.tweens.add({
      targets: container,
      alpha: 0,
      duration: FADE_OUT_MS,
      ease: "Quad.easeIn",
      onComplete: () => {
        if (this.fadingOut.get(tokenId)?.container === container) this.fadingOut.delete(tokenId);
        container.destroy(true);
      },
    });
    this.fadingOut.set(tokenId, { container, tween });
  }

  private cancelFadeOut(tokenId: string): void {
    const fading = this.fadingOut.get(tokenId);
    if (!fading) return;
    this.fadingOut.delete(tokenId);
    fading.tween.stop();
    fading.container.destroy(true);
  }

  /**
   * Fade in a token that just entered this viewer's list (out of fog,
   * unhidden, or added). It appears in place at its new position; tokens
   * that enter hidden behind a stack simply show up when they surface.
   */
  private fadeIn(tokenId: string): void {
    const container = this.tokenContainers.get(tokenId);
    if (!container || !container.visible || !this.scene.tweens) return;
    const alpha = container.alpha;
    container.setAlpha(0);
    const tween = this.scene.tweens.add({
      targets: container,
      alpha,
      duration: FADE_IN_MS,
      ease: "Quad.easeOut",
      onComplete: () => {
        if (this.fadingIn.get(tokenId)?.tween === tween) this.fadingIn.delete(tokenId);
      },
    });
    this.fadingIn.set(tokenId, { tween, alpha });
  }

  private stopFadeIn(tokenId: string): void {
    const fading = this.fadingIn.get(tokenId);
    if (!fading) return;
    this.fadingIn.delete(tokenId);
    fading.tween.stop();
  }

  /** Record and emit a drop made by this viewer. */
  private commitLocalMove(token: Token, x: number, y: number): void {
    this.pendingLocalMoves.set(token.id, {
      fromX: token.x,
      fromY: token.y,
      x,
      y,
      at: Date.now(),
    });
    this.onTokenMoveEnd?.({ tokenId: token.id, x, y });
  }

  private populateTokenContainer(
    container: Phaser.GameObjects.Container,
    token: Token,
    opts: { draggable: boolean },
  ): void {
    const radius = TOKEN_RADIUS * CELL;
    const sheet = token.sheetId ? this.sheets[token.sheetId] : null;
    const effectiveColor = sheet?.color && sheet.color.trim().length > 0 ? sheet.color : token.color;
    // NaN check (not `||`): black (0x000000) is a valid token color.
    const parsedTokenColor = parseInt(effectiveColor.replace("#", ""), 16);
    const colorInt = Number.isNaN(parsedTokenColor) ? 0x888888 : parsedTokenColor;

    // 1. Owner Halo
    if (token.ownerUserId) {
      const haloRadius = TOKEN_OWNER_HALO_RADIUS * CELL;
      const halo = this.scene.add.graphics();
      halo.lineStyle(2, 0xe89055, 0.9);
      halo.strokeCircle(0, 0, haloRadius);
      container.add(halo);
    }

    // Active Turn Golden Selection Ring
    if (token.id === this.activeTurnTokenId) {
      const activeHaloRadius = (TOKEN_OWNER_HALO_RADIUS + 0.05) * CELL;
      const ring = this.scene.add.graphics();
      ring.lineStyle(3, 0xffd700, 0.9);
      ring.strokeCircle(0, 0, activeHaloRadius);
      container.add(ring);

      if (this.scene.tweens) {
        this.scene.tweens.add({
          targets: ring,
          alpha: 0.4,
          duration: 800,
          ease: "Sine.easeInOut",
          yoyo: true,
          repeat: -1,
        });
      }
    }

    // 2. Token Circle
    const circle = this.scene.add.graphics();
    circle.fillStyle(colorInt, 1);
    circle.lineStyle(1.5, 0x191512, 0.8);
    circle.fillCircle(0, 0, radius);
    circle.strokeCircle(0, 0, radius);
    container.add(circle);

    // 3. Label text (initial) — Solid style hides the letter.
    if (token.iconKind !== "Solid") {
      const initial = token.name.trim().length > 0 ? token.name.trim()[0].toUpperCase() : "?";
      const textColor = getReadableTextColor(effectiveColor);
      const text = this.scene.add.text(0, 0, initial, {
        fontSize: `${Math.round(0.42 * CELL)}px`,
        fontFamily: '"Cormorant Garamond", Georgia, serif',
        color: textColor,
      });
      text.setOrigin(0.5, 0.5);
      container.add(text);
    }

    // Hit Area & Interactivity. Stacked tops and tokens the viewer may not
    // move are click-only (open popover / sheet); singles the viewer may move
    // are draggable. While a tool is selected everything is fully disabled.
    container.setSize(radius * 2, radius * 2);
    if (!this.interactionsEnabled) {
      container.disableInteractive();
      return;
    }
    this.applyDraggable(container, opts.draggable);

    this.setupContainerInput(container, token, opts);
  }

  private addStackBadge(container: Phaser.GameObjects.Container, count: number): void {
    const badge = this.scene.add.container(TOKEN_RADIUS * CELL * 0.7, -TOKEN_RADIUS * CELL * 0.7);

    const bg = this.scene.add.graphics();
    bg.fillStyle(0xe89055, 1);
    bg.lineStyle(1, 0x07060a, 1);
    bg.fillCircle(0, 0, 9);
    bg.strokeCircle(0, 0, 9);
    badge.add(bg);

    const txt = this.scene.add.text(0, 0, String(count), {
      fontSize: "11px",
      fontFamily: "sans-serif",
      color: "#07060a",
    });
    txt.setOrigin(0.5, 0.5);
    badge.add(txt);

    container.add(badge);
  }

  /** Shared click behavior: toggle the stack popover for multi-token stacks. */
  private handleTokenClick(token: Token): void {
    if (!this.interactionsEnabled) return;
    const cellKey = this.cellKeyOf(token);
    if (this.expandedStackCell === cellKey) {
      this.closePopover();
      return;
    }
    const { byCell } = this.stacksForViewer();
    const stack = byCell.get(cellKey);
    if (stack && stack.tokens.length > 1) {
      this.openPopover(stack);
    }
  }

  private openTokenSheet(tokenId: string, sheetId: string | null): void {
    if (!this.interactionsEnabled) return;
    this.onTokenDoubleClick?.(tokenId);
    if (sheetId) {
      window.dispatchEvent(
        new CustomEvent<{ sheetId: string }>("dndm-open-sheet", {
          bubbles: true,
          composed: true,
          detail: { sheetId },
        }),
      );
    }
  }

  /** Resolve a dropped container position to grid coords (snap unless Ctrl). */
  private resolveDrop(
    container: Phaser.GameObjects.Container,
    pointer: Phaser.Input.Pointer,
  ): { x: number; y: number } {
    const rawCellX = container.x / CELL;
    const rawCellY = container.y / CELL;
    const ctrlHeld = pointer.event ? (pointer.event as MouseEvent).ctrlKey : false;

    if (ctrlHeld || !this.grid.snapToGrid) {
      return {
        x: Phaser.Math.Clamp(rawCellX, 0, this.grid.widthCells),
        y: Phaser.Math.Clamp(rawCellY, 0, this.grid.heightCells),
      };
    }
    return snapToken(rawCellX, rawCellY, this.grid);
  }

  private setupContainerInput(
    container: Phaser.GameObjects.Container,
    token: Token,
    opts: { draggable: boolean },
  ): void {
    if (!this.interactionsEnabled) return;
    if (!opts.draggable) {
      // Click-only token (stack top or no move permission): single click
      // toggles the stack popover, double-click opens the sheet.
      let lastClickTime = 0;
      container.on(Phaser.Input.Events.POINTER_UP, () => {
        if (!this.interactionsEnabled) return;
        const now = Date.now();
        if (now - lastClickTime < 350) {
          this.openTokenSheet(token.id, token.sheetId);
        } else {
          this.handleTokenClick(token);
        }
        lastClickTime = now;
      });
      return;
    }

    let lastClickTime = 0;

    container.on(Phaser.Input.Events.DRAG_START, (_pointer: Phaser.Input.Pointer) => {
      if (!this.interactionsEnabled) return;
      // Grabbing a token mid-slide takes over from the slide.
      this.stopMoveTween(token.id);
      this.activeDrag = {
        tokenId: token.id,
        startX: container.x,
        startY: container.y,
        didDrag: false,
      };
    });

    container.on(
      Phaser.Input.Events.DRAG,
      (_pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
        if (!this.interactionsEnabled) return;
        const drag = this.activeDrag;
        if (drag?.tokenId !== token.id) return;
        if (Math.hypot(dragX - drag.startX, dragY - drag.startY) > 3) {
          drag.didDrag = true;
          this.closePopover();
        }
        container.setPosition(dragX, dragY);
      },
    );

    container.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
      const drag = this.activeDrag;
      if (drag?.tokenId === token.id) this.activeDrag = null;
      if (!this.interactionsEnabled) return;
      if (!drag?.didDrag) {
        // Handle click / stack toggle / double click
        const now = Date.now();
        if (now - lastClickTime < 350) {
          this.openTokenSheet(token.id, token.sheetId);
        } else {
          this.handleTokenClick(token);
        }
        lastClickTime = now;
        container.setPosition(token.x * CELL, token.y * CELL);
        return;
      }

      // Dropped after drag
      const finalPos = this.resolveDrop(container, pointer);

      container.setPosition(finalPos.x * CELL, finalPos.y * CELL);
      this.commitLocalMove(token, finalPos.x, finalPos.y);
    });
  }

  // ── Stack Popover & Chips Fan-out ──────────────────────────────────────────

  openPopover(stack: TokenStack): void {
    if (!this.interactionsEnabled) return;
    this.expandedStackCell = `${stack.cell.cellX},${stack.cell.cellY}`;
    this.renderPopover(stack);
  }

  closePopover(): void {
    this.expandedStackCell = null;
    this.popoverContainer.removeAll(true);
    this.popoverGfx.clear();
  }

  private renderPopover(stack: TokenStack): void {
    if (!this.interactionsEnabled) {
      this.closePopover();
      return;
    }
    this.popoverContainer.removeAll(true);
    this.popoverGfx.clear();

    const layout: StackPopoverLayout = getStackChipPositions(stack, this.grid);
    const anchorWorldX = layout.anchorX * CELL;
    const anchorWorldY = layout.anchorY * CELL;

    // Draw leader lines to each chip
    this.popoverGfx.lineStyle(1.5, 0xe89055, 0.75);
    for (const chip of layout.chips) {
      const chipWorldX = chip.x * CELL;
      const chipWorldY = chip.y * CELL;
      this.popoverGfx.lineBetween(anchorWorldX, anchorWorldY, chipWorldX, chipWorldY);
    }

    // Create chip tokens. Chips the viewer may move are draggable (this is
    // how stacked tokens are moved); others are click-only.
    const chipRadius = TOKEN_STACK_CHIP_RADIUS * CELL;
    for (const chip of layout.chips) {
      const t = stack.tokens.find((item) => item.id === chip.tokenId);
      if (!t) continue;

      const chipContainer = this.scene.add.container(chip.x * CELL, chip.y * CELL);
      const chipSheet = t.sheetId ? this.sheets[t.sheetId] : null;
      const chipColor = chipSheet?.color && chipSheet.color.trim().length > 0 ? chipSheet.color : t.color;
      // NaN check (not `||`): black (0x000000) is a valid token color.
      const parsedChipColor = parseInt(chipColor.replace("#", ""), 16);
      const colorInt = Number.isNaN(parsedChipColor) ? 0x888888 : parsedChipColor;

      const g = this.scene.add.graphics();
      g.fillStyle(colorInt, 1);
      g.lineStyle(1.5, 0xe89055, 1);
      g.fillCircle(0, 0, chipRadius);
      g.strokeCircle(0, 0, chipRadius);
      chipContainer.add(g);

      // Solid style hides the letter.
      if (t.iconKind !== "Solid") {
        const initial = t.name.trim().length > 0 ? t.name.trim()[0].toUpperCase() : "?";
        const textColor = getReadableTextColor(chipColor);
        const txt = this.scene.add.text(0, 0, initial, {
          fontSize: `${Math.round(0.35 * CELL)}px`,
          fontFamily: '"Cormorant Garamond", Georgia, serif',
          color: textColor,
        });
        txt.setOrigin(0.5, 0.5);
        chipContainer.add(txt);
      }

      const movable = this.interactionsEnabled && this.canMoveToken(t);
      if (!movable) chipContainer.setAlpha(0.65);
      chipContainer.setSize(chipRadius * 2, chipRadius * 2);
      this.applyDraggable(chipContainer, movable);
      chipContainer.setData("tokenChipId", t.id);

      if (movable) {
        chipContainer.on(Phaser.Input.Events.DRAG_START, () => {
          if (!this.interactionsEnabled) return;
          this.activeChipDrag = {
            tokenId: t.id,
            startX: chipContainer.x,
            startY: chipContainer.y,
            didDrag: false,
          };
        });
        chipContainer.on(
          Phaser.Input.Events.DRAG,
          (_pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
            if (!this.interactionsEnabled) return;
            const drag = this.activeChipDrag;
            if (drag?.tokenId !== t.id) return;
            if (Math.hypot(dragX - drag.startX, dragY - drag.startY) > 3) {
              drag.didDrag = true;
            }
            chipContainer.setPosition(dragX, dragY);
          },
        );
        chipContainer.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
          const drag = this.activeChipDrag;
          if (drag?.tokenId === t.id) this.activeChipDrag = null;
          if (!this.interactionsEnabled) return;
          if (!drag?.didDrag) return;
          const finalPos = this.resolveDrop(chipContainer, pointer);
          // Park the map container at the drop now so the authority's echo
          // snaps in place rather than sliding out of the stack.
          this.stopMoveTween(t.id);
          this.tokenContainers.get(t.id)?.setPosition(finalPos.x * CELL, finalPos.y * CELL);
          this.commitLocalMove(t, finalPos.x, finalPos.y);
          this.closePopover();
        });
      }

      let lastChipClick = 0;
      chipContainer.on(Phaser.Input.Events.POINTER_UP, () => {
        if (!this.interactionsEnabled) return;
        const now = Date.now();
        if (now - lastChipClick < 350) {
          this.openTokenSheet(t.id, t.sheetId);
        }
        lastChipClick = now;
      });

      this.popoverContainer.add(chipContainer);
    }
  }

  setInteractiveState(enabled: boolean): void {
    this.interactionsEnabled = enabled;
    if (!enabled) {
      // Disabling input mid-drag drops the gesture without a DRAG_END.
      this.activeDrag = null;
      this.activeChipDrag = null;
      for (const container of this.tokenContainers.values()) {
        container.disableInteractive();
      }
      this.closePopover();
      return;
    }
    // Re-apply the per-token policy (stack tops stay click-only).
    const { byCell } = this.stacksForViewer();
    const byId = new Map(this.tokens.map((t) => [t.id, t] as const));
    for (const [id, container] of this.tokenContainers.entries()) {
      const token = byId.get(id);
      if (!token) {
        container.disableInteractive();
        continue;
      }
      this.applyDraggable(
        container,
        this.isDirectlyMovable(token, byCell.get(this.cellKeyOf(token))),
      );
    }
  }

  /** True when the game object belongs to this layer (map token or popover chip). */
  isTokenObject(obj: unknown): boolean {
    if (!(obj instanceof Phaser.GameObjects.Container)) return false;
    for (const container of this.tokenContainers.values()) {
      if (container === obj) return true;
    }
    if (obj.getData?.("tokenChipId") !== undefined) return true;
    return (this.popoverContainer.getAll() as unknown[]).includes(obj);
  }

  /** Pass-through for the scene move gate. */
  canMove(token: Token): boolean {
    return this.canMoveToken(token);
  }

  destroy(): void {
    for (const id of [...this.moveTweens.keys()]) this.stopMoveTween(id);
    for (const id of [...this.fadingOut.keys()]) this.cancelFadeOut(id);
    for (const id of [...this.fadingIn.keys()]) this.stopFadeIn(id);
    this.pendingLocalMoves.clear();
    this.activeDrag = null;
    this.activeChipDrag = null;
    this.closePopover();
    this.popoverGfx.destroy();
    this.popoverContainer.destroy(true);
    for (const container of this.tokenContainers.values()) {
      container.destroy(true);
    }
    this.tokenContainers.clear();
  }
}
