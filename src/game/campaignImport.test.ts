import { describe, expect, it, vi } from "vitest";
import {
  buildCampaignHeader,
  hasCampaignContent,
  packCampaignChunks,
  sendChunkedImport,
  shouldOfferAutoRestore,
} from "./campaignImport";
import type { CampaignHeader, DndMapperState, GameMap } from "./domain";
import { createDefaultDndMapperState, createDefaultGridConfig } from "./domain";
import type { Intent } from "./types";

function makeMap(id: string, name: string, tokenCount = 0): GameMap {
  return {
    id,
    name,
    grid: createDefaultGridConfig(),
    images: [],
    tokens: Array.from({ length: tokenCount }, (_, i) => ({
      id: `tok-${id}-${i}`,
      type: "PlayerToken",
      ownerUserId: null,
      representsUserId: null,
      name: `Token ${i}`,
      color: "#f00",
      iconKind: "Initial",
      mapId: id,
      x: 1.5,
      y: 1.5,
      sheetId: null,
      hidden: false,
    })),
    createdUtc: "2026-09-08T00:00:00.000Z",
    listOrder: 0,
    defaultSpawnPosition: null,
    markupSvg: null,
    fogMask: "",
  };
}

describe("packCampaignChunks", () => {
  it("packs small maps into a single chunk", () => {
    const maps = [makeMap("1", "Map 1"), makeMap("2", "Map 2")];
    const chunks = packCampaignChunks(maps, 200_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("splits maps into multiple chunks when exceeding maxBytes", () => {
    // 3 maps with tokens (~2.2 KB each), maxBytes set to 3500 to force splitting
    const maps = [makeMap("1", "Map 1", 10), makeMap("2", "Map 2", 10), makeMap("3", "Map 3", 10)];
    const chunks = packCampaignChunks(maps, 3500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const flattened = chunks.flat();
    expect(flattened).toHaveLength(3);
    expect(flattened.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("throws if a single map exceeds maxBytes", () => {
    const hugeMap = makeMap("huge", "Huge Map", 200);
    expect(() => packCampaignChunks([hugeMap], 100)).toThrow(/exceeds the chunk limit/);
  });
});

describe("sendChunkedImport", () => {
  it("dispatches beginImport, importChunk (x N), and commitImport in sequence", () => {
    const intents: Intent[] = [];
    const sendIntent = vi.fn((intent: Intent) => {
      intents.push(intent);
    });

    const header: CampaignHeader = { title: "Campaign Alpha" };
    const maps = [makeMap("1", "Map 1"), makeMap("2", "Map 2")];

    const token = sendChunkedImport(sendIntent, header, maps, "custom-token-999");
    expect(token).toBe("custom-token-999");

    expect(intents).toHaveLength(3);
    expect(intents[0]).toEqual({
      kind: "beginImport",
      campaign: header,
      chunkCount: 1,
      token: "custom-token-999",
    });
    expect(intents[1]).toEqual({
      kind: "importChunk",
      token: "custom-token-999",
      index: 0,
      maps,
    });
    expect(intents[2]).toEqual({
      kind: "commitImport",
      token: "custom-token-999",
    });
  });
});

describe("buildCampaignHeader", () => {
  it("carries every persisted campaign field so a re-import restores the slot", () => {
    const state: DndMapperState = {
      ...createDefaultDndMapperState(),
      maps: [makeMap("1", "Map 1")],
      activeMapId: "1",
    };
    const header = buildCampaignHeader(state);
    expect(header.settings).toBe(state.settings);
    expect(header.attributeSchema).toBe(state.attributeSchema);
    expect(header.activeMapId).toBe("1");
    expect(header.sheets).toBe(state.sheets);
    expect(header.customTemplates).toBe(state.customTemplates);
    expect(header.statusEffectTemplates).toBe(state.statusEffectTemplates);
    expect(header.globalRollTemplates).toBe(state.globalRollTemplates);
    expect(header.activeSchemaTemplateId).toBe(state.activeSchemaTemplateId);
    expect(header.initiativeAttributeName).toBe(state.initiativeAttributeName);
    expect(header.activeCombat).toBe(state.activeCombat);
    expect(header.loadedDiceRules).toBe(state.loadedDiceRules);
  });
});

describe("shouldOfferAutoRestore", () => {
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

  it("offers only when live is empty and the auto-save holds a campaign", () => {
    expect(shouldOfferAutoRestore(empty(), withContent())).toBe(true);
  });

  it("declines when there is no auto-save", () => {
    expect(shouldOfferAutoRestore(empty(), null)).toBe(false);
  });

  it("declines when the auto-save is empty", () => {
    expect(shouldOfferAutoRestore(empty(), empty())).toBe(false);
  });

  it("declines when live state already has content", () => {
    expect(shouldOfferAutoRestore(withContent(), withContent())).toBe(false);
  });
});
