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
  private expandedStackCell: string | null = null;
  private activeTurnTokenId: string | null = null;

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
    this.isDm = isDm;
    this.updateVisibility();
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

  private updateVisibility(): void {
    const stacks = groupTokensIntoStacks(this.tokens);
    const stackMap = new Map<string, TokenStack>();
    for (const s of stacks) {
      stackMap.set(`${s.cell.cellX},${s.cell.cellY}`, s);
    }

    for (const token of this.tokens) {
      const container = this.tokenContainers.get(token.id);
      if (!container) continue;

      const cellKey = `${Math.floor(token.x)},${Math.floor(token.y)}`;
      const stack = stackMap.get(cellKey);
      const isStackedBehind = stack && stack.tokens.length > 1 && stack.tokens[0].id !== token.id;

      if (isStackedBehind) {
        container.setVisible(false);
      } else if (token.hidden) {
        if (this.isDm) {
          container.setVisible(true);
          container.setAlpha(0.5);
        } else {
          container.setVisible(false);
        }
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

    const stacks = groupTokensIntoStacks(this.tokens);
    const stackMap = new Map<string, TokenStack>();
    for (const s of stacks) {
      stackMap.set(`${s.cell.cellX},${s.cell.cellY}`, s);
    }

    for (const token of this.tokens) {
      let container = this.tokenContainers.get(token.id);
      const isNew = !container;

      if (isNew) {
        container = this.scene.add.container(token.x * CELL, token.y * CELL);
        container.setDepth(DEPTH.TOKENS);
        this.tokenContainers.set(token.id, container);
      } else {
        container!.removeAll(true);
        container!.setPosition(token.x * CELL, token.y * CELL);
      }

      this.populateTokenContainer(container!, token);

      // Add stack count badge if multiple tokens share this cell
      const cellKey = `${Math.floor(token.x)},${Math.floor(token.y)}`;
      const stack = stackMap.get(cellKey);
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

  private populateTokenContainer(container: Phaser.GameObjects.Container, token: Token): void {
    const radius = TOKEN_RADIUS * CELL;
    const sheet = token.sheetId ? this.sheets[token.sheetId] : null;
    const effectiveColor = sheet?.color && sheet.color.trim().length > 0 ? sheet.color : token.color;
    const colorInt = parseInt(effectiveColor.replace("#", ""), 16) || 0x888888;

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

    // Hit Area & Interactivity
    container.setSize(radius * 2, radius * 2);
    container.setInteractive({ draggable: true });

    this.setupContainerInput(container, token);
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

  private setupContainerInput(container: Phaser.GameObjects.Container, token: Token): void {
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
          this.onTokenDoubleClick?.(token.id);
          if (token.sheetId) {
            window.dispatchEvent(
              new CustomEvent<{ sheetId: string }>("dndm-open-sheet", {
                bubbles: true,
                composed: true,
                detail: { sheetId: token.sheetId },
              }),
            );
          }
        } else {
          // Check if this token belongs to a multi-token stack
          const cellKey = `${Math.floor(token.x)},${Math.floor(token.y)}`;
          if (this.expandedStackCell === cellKey) {
            this.closePopover();
          } else {
            const stacks = groupTokensIntoStacks(this.tokens);
            const stack = stacks.find((s) => `${s.cell.cellX},${s.cell.cellY}` === cellKey);
            if (stack && stack.tokens.length > 1) {
              this.openPopover(stack);
            }
          }
        }
        lastClickTime = now;
        container.setPosition(token.x * CELL, token.y * CELL);
        return;
      }

      // Dropped after drag
      const rawCellX = container.x / CELL;
      const rawCellY = container.y / CELL;
      const ctrlHeld = pointer.event ? (pointer.event as MouseEvent).ctrlKey : false;

      let finalPos: { x: number; y: number };
      if (ctrlHeld || !this.grid.snapToGrid) {
        finalPos = {
          x: Phaser.Math.Clamp(rawCellX, 0, this.grid.widthCells),
          y: Phaser.Math.Clamp(rawCellY, 0, this.grid.heightCells),
        };
      } else {
        finalPos = snapToken(rawCellX, rawCellY, this.grid);
      }

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

    // Create chip tokens
    const chipRadius = TOKEN_STACK_CHIP_RADIUS * CELL;
    for (const chip of layout.chips) {
      const t = stack.tokens.find((item) => item.id === chip.tokenId);
      if (!t) continue;

      const chipContainer = this.scene.add.container(chip.x * CELL, chip.y * CELL);
      const chipSheet = t.sheetId ? this.sheets[t.sheetId] : null;
      const chipColor = chipSheet?.color && chipSheet.color.trim().length > 0 ? chipSheet.color : t.color;
      const colorInt = parseInt(chipColor.replace("#", ""), 16) || 0x888888;

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

      chipContainer.setSize(chipRadius * 2, chipRadius * 2);
      chipContainer.setInteractive();

      let lastChipClick = 0;
      chipContainer.on(Phaser.Input.Events.POINTER_UP, () => {
        const now = Date.now();
        if (now - lastChipClick < 350) {
          this.onTokenDoubleClick?.(t.id);
          if (t.sheetId) {
            window.dispatchEvent(
              new CustomEvent<{ sheetId: string }>("dndm-open-sheet", {
                bubbles: true,
                composed: true,
                detail: { sheetId: t.sheetId },
              }),
            );
          }
        }
        lastChipClick = now;
      });

      this.popoverContainer.add(chipContainer);
    }
  }

  setInteractiveState(enabled: boolean): void {
    for (const container of this.tokenContainers.values()) {
      if (enabled) {
        container.setInteractive({ draggable: true });
      } else {
        container.disableInteractive();
      }
    }
    if (!enabled) {
      this.closePopover();
    }
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
