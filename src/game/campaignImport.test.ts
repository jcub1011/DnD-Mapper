import { describe, expect, it } from "vitest";
import { hasCampaignContent } from "./campaignImport";
import type { DndMapperState, GameMap } from "./domain";
import { createDefaultDndMapperState, createDefaultGridConfig } from "./domain";

function makeMap(id: string, name: string): GameMap {
  return {
    id,
    name,
    grid: createDefaultGridConfig(),
    images: [],
    tokens: [],
    createdUtc: "2026-09-08T00:00:00.000Z",
    listOrder: 0,
    defaultSpawnPosition: null,
    markupSvg: null,
    fogMask: "",
  };
}

describe("hasCampaignContent", () => {
  const empty = (): DndMapperState => createDefaultDndMapperState();
  const withContent = (): DndMapperState => ({
    ...createDefaultDndMapperState(),
    maps: [makeMap("1", "Map 1")],
    activeMapId: "1",
  });

  it("treats maps or sheets as content", () => {
    expect(hasCampaignContent(empty())).toBe(false);
    expect(hasCampaignContent(withContent())).toBe(true);
  });
});
