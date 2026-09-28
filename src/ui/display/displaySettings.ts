/*
 * Per-window settings for the projector display popout. Local to the popout
 * (localStorage) — never sent to the authority.
 */

export type DisplayFraming = "fit" | "fill";

export interface DisplaySettings {
  /** Black out everything outside the focus box (only applies when one is set). */
  hideOutsideFocus: boolean;
  /** Show the map when no focus box is set; otherwise the screen goes black. */
  showWithoutFocus: boolean;
  /** Contain the target box ("fit") or cover the window with it ("fill"). */
  framing: DisplayFraming;
  /** Popout-only grid hide; the map's own "Show grid lines" still applies. */
  showGrid: boolean;
  /** Full roll history side panel; off by default since it takes screen space. */
  showRollHistory: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: Readonly<DisplaySettings> = {
  hideOutsideFocus: false,
  showWithoutFocus: true,
  framing: "fit",
  showGrid: true,
  showRollHistory: false,
};

export const DISPLAY_SETTINGS_STORAGE_KEY = "dndm.display.settings";

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Validate field by field so one malformed value doesn't reset the rest. */
export function parseDisplaySettings(raw: unknown): DisplaySettings {
  const d = DEFAULT_DISPLAY_SETTINGS;
  if (!raw || typeof raw !== "object") return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    hideOutsideFocus: bool(r.hideOutsideFocus, d.hideOutsideFocus),
    showWithoutFocus: bool(r.showWithoutFocus, d.showWithoutFocus),
    framing: r.framing === "fit" || r.framing === "fill" ? r.framing : d.framing,
    showGrid: bool(r.showGrid, d.showGrid),
    showRollHistory: bool(r.showRollHistory, d.showRollHistory),
  };
}

export function loadDisplaySettings(): DisplaySettings {
  try {
    const v = window.localStorage?.getItem(DISPLAY_SETTINGS_STORAGE_KEY);
    return parseDisplaySettings(v ? JSON.parse(v) : null);
  } catch {
    return { ...DEFAULT_DISPLAY_SETTINGS };
  }
}

export function saveDisplaySettings(settings: DisplaySettings): void {
  try {
    window.localStorage?.setItem(DISPLAY_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota/privacy errors
  }
}
