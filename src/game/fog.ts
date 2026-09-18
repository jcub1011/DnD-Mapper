/*
 * Fog of war bitset.
 *
 * Rules:
 *   1. An empty or zero-length mask means "ALL CELLS REVEALED" (false).
 *   2. Base64 is the only wire/storage representation; FogMaskBytes is the
 *      in-memory Uint8Array for bit operations.
 *   3. Pure TypeScript: runs in the Jint sandbox without DOM (atob/btoa) or Node (Buffer).
 *   4. Bit index = cy * widthCells + cx.
 */

import type { GridConfig } from "./domain.js";

/** Base64. The ONLY form that crosses the wire or lands in `.vtf` / IndexedDB. */
export type FogMaskB64 = string;

/** Decoded bytes. The ONLY form the bit maths operates on. */
export type FogMaskBytes = Uint8Array<ArrayBuffer>;

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

/** Pure JS base64 decode (works in Jint sandbox, Node, and browser). */
export function decodeFog(b64: FogMaskB64): FogMaskBytes {
  if (!b64 || b64.length === 0) return new Uint8Array(0);

  const len = b64.length;
  let pad = 0;
  if (len > 0 && b64[len - 1] === "=") pad++;
  if (len > 1 && b64[len - 2] === "=") pad++;

  const rawLen = Math.floor((len * 3) / 4) - pad;
  const out = new Uint8Array(rawLen);

  let inIdx = 0;
  let outIdx = 0;

  while (inIdx < len) {
    const c0 = B64_LOOKUP[b64.charCodeAt(inIdx++)];
    const c1 = inIdx <= len ? B64_LOOKUP[b64.charCodeAt(inIdx++)] : 0;
    const c2 = inIdx <= len ? B64_LOOKUP[b64.charCodeAt(inIdx++)] : 0;
    const c3 = inIdx <= len ? B64_LOOKUP[b64.charCodeAt(inIdx++)] : 0;

    const b0 = (c0 << 2) | (c1 >> 4);
    const b1 = ((c1 & 15) << 4) | (c2 >> 2);
    const b2 = ((c2 & 3) << 6) | c3;

    if (outIdx < rawLen) out[outIdx++] = b0;
    if (outIdx < rawLen) out[outIdx++] = b1;
    if (outIdx < rawLen) out[outIdx++] = b2;
  }

  return out;
}

/** Pure JS base64 encode (works in Jint sandbox, Node, and browser). */
export function encodeFog(bytes: FogMaskBytes): FogMaskB64 {
  if (!bytes || bytes.length === 0) return "";

  let result = "";
  const len = bytes.length;
  const extra = len % 3;
  const mainLen = len - extra;

  for (let i = 0; i < mainLen; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    result += B64_CHARS[b0 >> 2];
    result += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    result += B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)];
    result += B64_CHARS[b2 & 63];
  }

  if (extra === 1) {
    const b0 = bytes[mainLen];
    result += B64_CHARS[b0 >> 2];
    result += B64_CHARS[(b0 & 3) << 4];
    result += "==";
  } else if (extra === 2) {
    const b0 = bytes[mainLen];
    const b1 = bytes[mainLen + 1];
    result += B64_CHARS[b0 >> 2];
    result += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    result += B64_CHARS[(b1 & 15) << 2];
    result += "=";
  }

  return result;
}

/**
 * Returns whether cell (cx, cy) is fogged.
 * Empty or absent mask evaluates to FALSE (all revealed).
 */
export function isFogged(mask: FogMaskBytes, grid: GridConfig, cx: number, cy: number): boolean {
  if (!mask || mask.length === 0) return false;
  if (cx < 0 || cy < 0 || cx >= grid.widthCells || cy >= grid.heightCells) return false;

  const bit = cy * grid.widthCells + cx;
  const byte = bit >> 3;
  if (byte >= mask.length) return false;

  return (mask[byte] & (1 << (bit & 7))) !== 0;
}

/** Minimum byte length required for a grid's fog mask. */
export function fogByteLength(grid: GridConfig): number {
  return Math.ceil((grid.widthCells * grid.heightCells) / 8);
}

/**
 * Sets fog for a single cell, returning a new mask Uint8Array.
 * Out-of-bounds cells or no-op flips return the original mask unmodified.
 */
export function setCellFogged(
  mask: FogMaskBytes,
  grid: GridConfig,
  cx: number,
  cy: number,
  fogged: boolean,
): FogMaskBytes {
  if (cx < 0 || cy < 0 || cx >= grid.widthCells || cy >= grid.heightCells) return mask;

  const bit = cy * grid.widthCells + cx;
  const byte = bit >> 3;
  const maskByte = 1 << (bit & 7);

  const neededBytes = fogByteLength(grid);
  if (neededBytes <= 0) return mask;

  const currentFogged = isFogged(mask, grid, cx, cy);
  if (currentFogged === fogged) return mask;

  // Clone or allocate
  const next = new Uint8Array(Math.max(neededBytes, mask.length));
  next.set(mask);

  if (fogged) {
    next[byte] |= maskByte;
  } else {
    next[byte] &= ~maskByte;
  }

  return next;
}

/**
 * Sets fog for multiple cell indices (cy * widthCells + cx).
 */
export function setCellsFogged(
  mask: FogMaskBytes,
  grid: GridConfig,
  cells: readonly number[],
  fogged: boolean,
): FogMaskBytes {
  if (cells.length === 0) return mask;

  const totalCells = grid.widthCells * grid.heightCells;
  const neededBytes = fogByteLength(grid);
  if (neededBytes <= 0) return mask;

  let next: FogMaskBytes | null = null;

  for (let i = 0; i < cells.length; i++) {
    const bit = cells[i];
    if (bit < 0 || bit >= totalCells) continue;

    const byte = bit >> 3;
    const maskByte = 1 << (bit & 7);
    const hasBit = mask.length > byte && (mask[byte] & maskByte) !== 0;

    if (hasBit === fogged) continue;

    if (next === null) {
      next = new Uint8Array(Math.max(neededBytes, mask.length));
      next.set(mask);
    }

    if (fogged) {
      next[byte] |= maskByte;
    } else {
      next[byte] &= ~maskByte;
    }
  }

  return next ?? mask;
}

/** Creates a fully fogged mask for a grid. */
export function fillFog(grid: GridConfig): FogMaskBytes {
  const bytes = new Uint8Array(fogByteLength(grid));
  bytes.fill(0xff);
  const totalCells = grid.widthCells * grid.heightCells;
  const rem = totalCells & 7;
  if (rem > 0 && bytes.length > 0) {
    bytes[bytes.length - 1] = (1 << rem) - 1;
  }
  return bytes;
}

/** Creates a completely cleared (revealed) fog mask. */
export function clearFog(): FogMaskBytes {
  return new Uint8Array(0);
}
