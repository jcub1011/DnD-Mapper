/*
 * Token stacking helpers.
 *
 * Rules:
 *   1. Tokens at cell centres (x.5, y.5) or anywhere inside cell bounds group
 *      into a stack keyed by floor(x), floor(y).
 *   2. Grouping is deterministic: ordered by row (cellY), then column (cellX).
 *   3. Popover chip fan-out computes horizontal layout clamped within map bounds.
 */

import type { GridConfig, Token } from "./domain.js";

export interface TokenCellKey {
  readonly cellX: number;
  readonly cellY: number;
}

export interface TokenStack {
  readonly cell: TokenCellKey;
  readonly tokens: readonly Token[];
}

export interface ChipPosition {
  readonly tokenId: string;
  readonly x: number;
  readonly y: number;
}

export interface StackPopoverLayout {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly rowCx: number;
  readonly rowCy: number;
  readonly chips: readonly ChipPosition[];
}

/**
 * Returns the integer cell coordinates occupied by position (x, y).
 */
export function tokenCellOf(x: number, y: number): TokenCellKey {
  return {
    cellX: Math.floor(x),
    cellY: Math.floor(y),
  };
}

/**
 * Groups tokens by cell, maintaining deterministic row-then-column order.
 */
export function groupTokensIntoStacks(tokens: readonly Token[]): TokenStack[] {
  const map = new Map<string, { cell: TokenCellKey; tokens: Token[] }>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const key = tokenCellOf(t.x, t.y);
    const id = `${key.cellX},${key.cellY}`;

    let stack = map.get(id);
    if (!stack) {
      stack = { cell: key, tokens: [] };
      map.set(id, stack);
    }
    stack.tokens.push(t);
  }

  return [...map.values()]
    .sort((a, b) => (a.cell.cellY !== b.cell.cellY ? a.cell.cellY - b.cell.cellY : a.cell.cellX - b.cell.cellX))
    .map((s) => ({ cell: s.cell, tokens: s.tokens }));
}

/**
 * Calculates expanded chip positions when a token stack is opened.
 */
export function getStackChipPositions(stack: TokenStack, grid: GridConfig): StackPopoverLayout {
  const n = stack.tokens.length;
  const spacing = 1.0;
  const totalWidth = (n - 1) * spacing;

  const anchorCx = stack.cell.cellX + 0.5;
  const anchorCy = stack.cell.cellY + 0.5;

  const minCx = totalWidth / 2 + 0.5;
  const maxCx = Math.max(minCx, grid.widthCells - totalWidth / 2 - 0.5);
  const rowCx = Math.min(Math.max(anchorCx, minCx), maxCx);

  const below = stack.cell.cellY < 1;
  const rowCy = below ? stack.cell.cellY + 1.7 : stack.cell.cellY - 0.7;

  const chips: ChipPosition[] = [];
  for (let i = 0; i < n; i++) {
    const chipX = rowCx + (i - (n - 1) / 2.0) * spacing;
    chips.push({
      tokenId: stack.tokens[i].id,
      x: chipX,
      y: rowCy,
    });
  }

  return {
    anchorX: anchorCx,
    anchorY: anchorCy,
    rowCx,
    rowCy,
    chips,
  };
}
