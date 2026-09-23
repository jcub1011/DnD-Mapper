/*
 * Pure color contrast and accessibility helpers.
 *
 * Rules:
 *   1. WCAG 2.1 relative luminance and contrast ratio calculations.
 *   2. Used for readable token label colors and UI contrast.
 *   3. Strict JSON compatibility; pure TypeScript with no DOM or Node globals.
 */

import type { DndMapperState } from "./domain.js";

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parses a hex color string (#rgb, #rgba, #rrggbb, #rrggbbaa) into RGB values (0..255).
 * Returns null if the format is invalid.
 */
export function parseHexColor(hex: string): RgbColor | null {
  if (!hex || typeof hex !== "string") return null;

  let cleaned = hex.trim();
  if (cleaned.startsWith("#")) {
    cleaned = cleaned.slice(1);
  }

  let r: number;
  let g: number;
  let b: number;

  if (cleaned.length === 3 || cleaned.length === 4) {
    r = parseInt(cleaned[0] + cleaned[0], 16);
    g = parseInt(cleaned[1] + cleaned[1], 16);
    b = parseInt(cleaned[2] + cleaned[2], 16);
  } else if (cleaned.length === 6 || cleaned.length === 8) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  } else {
    return null;
  }

  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    return null;
  }

  return { r, g, b };
}

/**
 * Converts an 8-bit channel to linear sRGB value for WCAG luminance calculations.
 */
function sRgbToLinear(c: number): number {
  const norm = c / 255;
  return norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
}

/**
 * Calculates the relative luminance of an sRGB color (0.0 to 1.0) according to WCAG 2.1.
 */
export function getRelativeLuminance(rgb: RgbColor): number {
  const r = sRgbToLinear(rgb.r);
  const g = sRgbToLinear(rgb.g);
  const b = sRgbToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Calculates the WCAG contrast ratio (1.0 to 21.0) between two colors.
 * Returns 1.0 if either color cannot be parsed.
 */
export function getContrastRatio(hex1: string, hex2: string): number {
  const rgb1 = parseHexColor(hex1);
  const rgb2 = parseHexColor(hex2);

  if (!rgb1 || !rgb2) return 1.0;

  const lum1 = getRelativeLuminance(rgb1);
  const lum2 = getRelativeLuminance(rgb2);

  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Determines whether black ("#000000") or white ("#ffffff") text yields higher contrast
 * on the provided background color.
 */
export function getReadableTextColor(bgColorHex: string): "#000000" | "#ffffff" {
  const rgb = parseHexColor(bgColorHex);
  if (!rgb) {
    // Default fallback to black text
    return "#000000";
  }

  const bgLum = getRelativeLuminance(rgb);
  // White lum = 1.0, Black lum = 0.0
  const contrastWithWhite = (1.0 + 0.05) / (bgLum + 0.05);
  const contrastWithBlack = (bgLum + 0.05) / (0.0 + 0.05);

  return contrastWithWhite > contrastWithBlack ? "#ffffff" : "#000000";
}

// ── Dice Color Resolvers ──────────────────────────────────────────────────────

export const HOST_GOLD = "#FFD700";

export function stringHashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60.0;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1: number, g1: number, b1: number;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  const m = l - c / 2;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);

  return (
    "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0")
  );
}

export function fallbackColorForHash(hash: number): string {
  const hue = hash % 360;
  return hslToHex(hue, 0.55, 0.55);
}

/**
 * Seeds a deterministic color identifier from a character/sheet name.
 * Used for fresh sheets (and their bound tokens) until a user manually
 * picks a color, which sets `colorOverridden` and freezes the value.
 */
export function seedColorForName(name: string): string {
  const normalized = (name ?? "").trim().toLowerCase();
  return fallbackColorForHash(stringHashCode(normalized));
}

export interface DiceColorRosterEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly name?: string;
}

/**
 * Resolves the dice color for a player: the color of their associated
 * character sheet (via ownership or via a token bound to the sheet),
 * falling back to a hash of the player's display name when they have no
 * character. The DM always rolls gold.
 */
export function resolveDiceColor(
  state: DndMapperState,
  userId: string,
  roster?: readonly DiceColorRosterEntry[],
): string {
  if (!userId) return fallbackColorForHash(0);
  if (state.dmPlayerId === userId) return HOST_GOLD;

  // 1. Directly owned sheet wins — the player's associated character.
  for (const sheet of Object.values(state.sheets)) {
    if (sheet.ownerUserId === userId && parseHexColor(sheet.color)) {
      return sheet.color;
    }
  }

  // 2. Token owned by (or representing) the player that is bound to a sheet:
  // use the bound sheet's color so token and sheet stay visually identical.
  for (const map of state.maps) {
    if ("tokens" in map) {
      for (const token of map.tokens) {
        if (token.ownerUserId === userId || token.representsUserId === userId) {
          if (token.sheetId && state.sheets[token.sheetId]) {
            const sheetColor = state.sheets[token.sheetId].color;
            if (parseHexColor(sheetColor)) return sheetColor;
          }
          if (parseHexColor(token.color)) {
            return token.color;
          }
        }
      }
    }
  }

  // 3. No character: fall back to a hash of the player's display name.
  const entry = roster?.find((p) => p.id === userId);
  const displayName = entry?.displayName ?? entry?.name;
  if (displayName && displayName.trim().length > 0) {
    return fallbackColorForHash(stringHashCode(displayName.trim()));
  }

  return fallbackColorForHash(stringHashCode(userId));
}

export function resolveDiceColorForToken(state: DndMapperState, tokenId: string): string {
  for (const map of state.maps) {
    if ("tokens" in map) {
      for (const token of map.tokens) {
        if (token.id === tokenId) {
          if (token.sheetId && state.sheets[token.sheetId]) {
            const sheetColor = state.sheets[token.sheetId].color;
            if (parseHexColor(sheetColor)) return sheetColor;
          }
          if (parseHexColor(token.color)) return token.color;
          return fallbackColorForHash(stringHashCode(tokenId));
        }
      }
    }
  }
  return fallbackColorForHash(stringHashCode(tokenId));
}

