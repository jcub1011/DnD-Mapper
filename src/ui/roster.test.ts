// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { toDisplayRoster } from "./roster.js";

describe("toDisplayRoster", () => {
  it("maps lobby display names to display entries", () => {
    expect(
      toDisplayRoster([
        { id: "dm-1", displayName: "Dungeon Master" },
        { id: "player-1", displayName: "Alice" },
      ]),
    ).toEqual([
      { id: "dm-1", name: "Dungeon Master" },
      { id: "player-1", name: "Alice" },
    ]);
  });

  it("never renders a blank entry: falls back to the player id", () => {
    expect(
      toDisplayRoster([
        { id: "player-1", displayName: "" },
        { id: "player-2", displayName: "   " },
        { id: "player-3" },
        { id: "player-4", displayName: null },
      ]),
    ).toEqual([
      { id: "player-1", name: "player-1" },
      { id: "player-2", name: "player-2" },
      { id: "player-3", name: "player-3" },
      { id: "player-4", name: "player-4" },
    ]);
  });

  it("returns an empty list for nullish input", () => {
    expect(toDisplayRoster(null)).toEqual([]);
    expect(toDisplayRoster(undefined)).toEqual([]);
    expect(toDisplayRoster([])).toEqual([]);
  });
});
