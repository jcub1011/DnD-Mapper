/*
 * Pure color contrast and accessibility helpers.
 *
 * Rules:
 *   1. WCAG 2.1 relative luminance and contrast ratio calculations.
 *   2. Used for readable token label colors and UI contrast.
 *   3. Strict JSON compatibility; pure TypeScript with no DOM or Node globals.
 */

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
