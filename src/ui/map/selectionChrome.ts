/*
 * Selection chrome shared by every editable map object (images, focus box),
 * so their outlines and handles look and behave identically.
 * Sizes are in screen pixels (world sizes are divided by zoom).
 */

export const SELECTION_COLOR = 0xe89055;
export const HANDLE_HOVER_COLOR = 0xffc49c;
export const HANDLE_STROKE_COLOR = 0x07060a;
export const HANDLE_STROKE_WIDTH = 2;
export const HANDLE_HOVER_SCALE = 1.25;
export const HANDLE_HIT_SIZE = 28;
export const CORNER_HANDLE_SIZE = 12;
export const OUTLINE_WIDTH = 3;

export const CORNER_IDS = ["nw", "ne", "se", "sw"] as const;
export type CornerId = (typeof CORNER_IDS)[number];

// Outward direction of each corner on an unrotated box, in degrees
// clockwise from +x (screen y points down, so 45° is down-right).
export const CORNER_BASE_DEG: Record<string, number> = { se: 45, sw: 135, nw: 225, ne: 315 };

export const RESIZE_HINT = "Drag to resize · Shift: free aspect ratio · Ctrl: ignore grid snap";

const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

/** CSS resize cursor closest to an outward handle direction (degrees clockwise from +x). */
export function resizeCursorForAngle(deg: number): string {
  const axis = ((deg % 180) + 180) % 180;
  return RESIZE_CURSORS[Math.round(axis / 45) % 4];
}
