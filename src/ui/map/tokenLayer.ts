/*
 * Token layer in Phaser MapScene.
 * Renders token containers with owner halos, readable initials, stacking chips, and fan-out popovers.
 * Belongs at DEPTH.TOKENS (4000).
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import type { CharacterSheet, GridConfig, Token } from "../../game/domain";
import { TOKEN_RADIUS, TOKEN_OWNER_HALO_RADIUS, TOKEN_STACK_CHIP_RADIUS } from "../../game/domain";
import { snapToken } from "../../game/snapping";
import { isTokenVisibleToPlayer } from "../../game/visibility";
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
  private tweenMoves = false;
  private expandedStackCell: string | null = null;
  private activeTurnTokenId: string | null = null;
  // Client-side move gate. Mirrors the server's mayMoveToken decision for the
  // current user (wired from dndm-app via MapScene). Denied tokens render
  // click-only and never emit onTokenMoveEnd.
  private canMoveToken: (token: Token) => boolean = () => true;

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

  setTweenMoves(enabled: boolean): void {
    this.tweenMoves = enabled;
  }

  setGrid(grid: GridConfig): void {
    this.grid = grid;
  }

  setSheets(sheets: Readonly<Record<string, CharacterSheet>>): void {
    this.sheets = sheets;
    this.rebuildTokens();
  }

  setTokens(tokens: readonly Token[]): void {
    this.tokens = tokens;
    this.rebuildTokens();
  }

  /** Tokens the current viewer may see. Players exclude hidden tokens so a
   *  hidden stack-top never masks the visible tokens beneath it. */
  private visibleTokens(): readonly Token[] {
    if (this.isDm) return this.tokens;
    return this.tokens.filter((t) => isTokenVisibleToPlayer(t, false));
  }

  /** Stacks built from viewer-visible tokens only, plus a cell-key lookup. */
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

      if (isStackedBehind) {
        container.setVisible(false);
      } else if (!topVisibleById.has(token.id)) {
        // Hidden from this viewer (players only — DM sees everything).
        container.setVisible(false);
      } else if (token.hidden) {
        // DM-only branch: DM sees hidden tokens ghosted.
        container.setVisible(true);
        container.setAlpha(0.5);
      } else {
        container.setVisible(true);
        container.setAlpha(1.0);
      }
    }
  }

  private rebuildTokens(): void {
    // Remove obsolete containers
    const activeIds = new Set(this.tokens.map((t) => t.id));
    for (const [id, container] of this.tokenContainers.entries()) {
      if (!activeIds.has(id)) {
        container.destroy(true);
        this.tokenContainers.delete(id);
      }
    }

    const { byCell: stackMap } = this.stacksForViewer();

    for (const token of this.tokens) {
      let container = this.tokenContainers.get(token.id);
      const isNew = !container;
      const targetX = token.x * CELL;
      const targetY = token.y * CELL;

      if (isNew) {
        container = this.scene.add.container(targetX, targetY);
        container.setDepth(DEPTH.TOKENS);
        this.tokenContainers.set(token.id, container);
      } else {
        container!.removeAll(true);
        // Drop stale input listeners from the previous build; otherwise every
        // setTokens() accumulates duplicate DRAG_END handlers with stale
        // closures that fight over the container position.
        container!.removeAllListeners();
        if (
          this.tweenMoves &&
          this.scene.tweens &&
          (Math.abs(container!.x - targetX) > 1 || Math.abs(container!.y - targetY) > 1)
        ) {
          this.scene.tweens.killTweensOf(container!);
          this.scene.tweens.add({
            targets: container!,
            x: targetX,
            y: targetY,
            duration: 250,
            ease: "Quad.easeOut",
          });
        } else {
          container!.setPosition(targetX, targetY);
        }
      }

      const cellKey = this.cellKeyOf(token);
      const stack = stackMap.get(cellKey);
      this.populateTokenContainer(container!, token, {
        draggable: this.isDirectlyMovable(token, stack),
      });

      // Add stack count badge if multiple *visible* tokens share this cell
      if (stack && stack.tokens.length > 1 && stack.tokens[0].id === token.id) {
        this.addStackBadge(container!, stack.tokens.length);
      } else if (stack && stack.tokens.length > 1 && stack.tokens[0].id !== token.id) {
        // Stacked tokens behind the top token are hidden until expanded
        container!.setVisible(false);
      }
    }

    this.updateVisibility();

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

    // 3. Label text (initial)
    const initial = token.name.trim().length > 0 ? token.name.trim()[0].toUpperCase() : "?";
    const textColor = getReadableTextColor(effectiveColor);
    const text = this.scene.add.text(0, 0, initial, {
      fontSize: `${Math.round(0.42 * CELL)}px`,
      fontFamily: '"Cormorant Garamond", Georgia, serif',
      color: textColor,
    });
    text.setOrigin(0.5, 0.5);
    container.add(text);

    // Hit Area & Interactivity. Stacked tops and tokens the viewer may not
    // move are click-only (open popover / sheet); singles the viewer may move
    // are draggable.
    container.setSize(radius * 2, radius * 2);
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
    if (!opts.draggable) {
      // Click-only token (stack top or no move permission): single click
      // toggles the stack popover, double-click opens the sheet.
      let lastClickTime = 0;
      container.on(Phaser.Input.Events.POINTER_UP, () => {
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
    let didDrag = false;
    let dragStartX = 0;
    let dragStartY = 0;

    container.on(Phaser.Input.Events.DRAG_START, (_pointer: Phaser.Input.Pointer) => {
      didDrag = false;
      dragStartX = container.x;
      dragStartY = container.y;
    });

    container.on(
      Phaser.Input.Events.DRAG,
      (_pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
        if (Math.hypot(dragX - dragStartX, dragY - dragStartY) > 3) {
          didDrag = true;
          this.closePopover();
        }
        container.setPosition(dragX, dragY);
      },
    );

    container.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
      if (!didDrag) {
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
      this.onTokenMoveEnd?.({
        tokenId: token.id,
        x: finalPos.x,
        y: finalPos.y,
      });
    });
  }

  // ── Stack Popover & Chips Fan-out ──────────────────────────────────────────

  openPopover(stack: TokenStack): void {
    this.expandedStackCell = `${stack.cell.cellX},${stack.cell.cellY}`;
    this.renderPopover(stack);
  }

  closePopover(): void {
    this.expandedStackCell = null;
    this.popoverContainer.removeAll(true);
    this.popoverGfx.clear();
  }

  private renderPopover(stack: TokenStack): void {
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

      const initial = t.name.trim().length > 0 ? t.name.trim()[0].toUpperCase() : "?";
      const textColor = getReadableTextColor(chipColor);
      const txt = this.scene.add.text(0, 0, initial, {
        fontSize: `${Math.round(0.35 * CELL)}px`,
        fontFamily: '"Cormorant Garamond", Georgia, serif',
        color: textColor,
      });
      txt.setOrigin(0.5, 0.5);
      chipContainer.add(txt);

      const movable = this.canMoveToken(t);
      if (!movable) chipContainer.setAlpha(0.65);
      chipContainer.setSize(chipRadius * 2, chipRadius * 2);
      this.applyDraggable(chipContainer, movable);
      chipContainer.setData("tokenChipId", t.id);

      if (movable) {
        let didChipDrag = false;
        let chipStartX = 0;
        let chipStartY = 0;
        chipContainer.on(Phaser.Input.Events.DRAG_START, () => {
          didChipDrag = false;
          chipStartX = chipContainer.x;
          chipStartY = chipContainer.y;
        });
        chipContainer.on(
          Phaser.Input.Events.DRAG,
          (_pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
            if (Math.hypot(dragX - chipStartX, dragY - chipStartY) > 3) {
              didChipDrag = true;
            }
            chipContainer.setPosition(dragX, dragY);
          },
        );
        chipContainer.on(Phaser.Input.Events.DRAG_END, (pointer: Phaser.Input.Pointer) => {
          if (!didChipDrag) return;
          const finalPos = this.resolveDrop(chipContainer, pointer);
          this.onTokenMoveEnd?.({ tokenId: t.id, x: finalPos.x, y: finalPos.y });
          this.closePopover();
        });
      }

      let lastChipClick = 0;
      chipContainer.on(Phaser.Input.Events.POINTER_UP, () => {
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
    if (!enabled) {
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
    this.closePopover();
    this.popoverGfx.destroy();
    this.popoverContainer.destroy(true);
    for (const container of this.tokenContainers.values()) {
      container.destroy(true);
    }
    this.tokenContainers.clear();
  }
}
