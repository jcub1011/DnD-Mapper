// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_SETTINGS,
  DISPLAY_SETTINGS_STORAGE_KEY,
  loadDisplaySettings,
  parseDisplaySettings,
  saveDisplaySettings,
} from "./displaySettings";

describe("displaySettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadDisplaySettings()).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it("round-trips through localStorage", () => {
    const settings = {
      hideOutsideFocus: true,
      showWithoutFocus: false,
      framing: "fill" as const,
      showGrid: false,
      showRollHistory: false,
    };
    saveDisplaySettings(settings);
    expect(loadDisplaySettings()).toEqual(settings);
  });

  it("falls back to defaults on malformed JSON", () => {
    window.localStorage.setItem(DISPLAY_SETTINGS_STORAGE_KEY, "{not json");
    expect(loadDisplaySettings()).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });

  it("keeps valid fields and defaults invalid or missing ones", () => {
    expect(
      parseDisplaySettings({ showGrid: false, framing: "stretch", hideOutsideFocus: 1 }),
    ).toEqual({ ...DEFAULT_DISPLAY_SETTINGS, showGrid: false });
  });
});
