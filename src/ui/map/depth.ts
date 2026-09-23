/*
 * Depth bands for the Phaser MapScene as specified in docs/blazor-port/05-rendering.md.
 * Keeping these in one module avoids magic numbers and ordering drift across layers.
 */

export const DEPTH = {
  BACKGROUND: 0,
  IMAGES: 1, // 1..999 allocated to image layers ordered by rank
  GRID: 1000,
  MARKUP: 2000,
  FOG: 3000,
  TOKENS: 4000,
  FOCUS_RULER: 5000,
  SELECTION: 6000,
} as const;
