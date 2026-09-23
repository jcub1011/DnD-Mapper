import { describe, expect, it } from "vitest";
import { MatchView } from "./view";
import type { DndMapperState, GameMap, MapImage, MapSummary, Token } from "./domain";
import { createDefaultDndMapperState, createDefaultGridConfig, isFullMap } from "./domain";
import type { Patch } from "./types";

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

describe("MatchView", () => {
  it("starts in Lobby with default settings and empty maps", () => {
    const view = new MatchView();
    expect(view.state.phase).toBe("Lobby");
    expect(view.state.maps).toHaveLength(0);
    expect(view.state.activeMapId).toBeNull();
  });

  it("adopts a snapshot via applySnapshot", () => {
    const view = new MatchView();
    const map = makeMap("map-1", "Dungeon");
    const snapshot: DndMapperState = {
      ...createDefaultDndMapperState("dm-1"),
      phase: "Playing",
      maps: [map],
      activeMapId: "map-1",
    };
    view.applySnapshot(snapshot);
    expect(view.state.phase).toBe("Playing");
    expect(view.state.dmPlayerId).toBe("dm-1");
    expect(view.state.activeMapId).toBe("map-1");
    expect(view.state.maps).toHaveLength(1);
  });

  it("merges patch kinds: token and tokenRemoved", () => {
    const view = new MatchView();
    const map = makeMap("map-1", "Dungeon");
    view.applySnapshot({ ...createDefaultDndMapperState(), maps: [map], activeMapId: "map-1" });

    const token: Token = {
      id: "tok-1",
      type: "PlayerToken",
      ownerUserId: "p-1",
      representsUserId: null,
      name: "Rogue",
      color: "#f0f",
      iconKind: "Initial",
      mapId: "map-1",
      x: 3.5,
      y: 4.5,
      sheetId: null,
      hidden: false,
    };

    // Add token via patch
    view.applyPatch({ kind: "token", token });
    let currentMap = view.state.maps[0] as GameMap;
    expect(currentMap.tokens).toHaveLength(1);
    expect(currentMap.tokens[0]).toEqual(token);

    // Update token
    const moved = { ...token, x: 7.5, y: 8.5 };
    view.applyPatch({ kind: "token", token: moved });
    currentMap = view.state.maps[0] as GameMap;
    expect(currentMap.tokens[0].x).toBe(7.5);

    // Remove token
    view.applyPatch({ kind: "tokenRemoved", tokenId: "tok-1" });
    currentMap = view.state.maps[0] as GameMap;
    expect(currentMap.tokens).toHaveLength(0);
  });

  it("merges patch kinds: fog and grid", () => {
    const view = new MatchView();
    const map = makeMap("map-1", "Dungeon");
    view.applySnapshot({ ...createDefaultDndMapperState(), maps: [map], activeMapId: "map-1" });

    // Fog patch
    view.applyPatch({ kind: "fog", mapId: "map-1", mask: "////" });
    let currentMap = view.state.maps[0] as GameMap;
    expect(currentMap.fogMask).toBe("////");

    // Grid patch
    const newGrid = { ...currentMap.grid, widthCells: 50, heightCells: 40 };
    view.applyPatch({ kind: "grid", mapId: "map-1", grid: newGrid });
    currentMap = view.state.maps[0] as GameMap;
    expect(currentMap.grid.widthCells).toBe(50);
  });

  it("merges patch kinds: image and imageRemoved", () => {
    const view = new MatchView();
    const map = makeMap("map-1", "Dungeon");
    view.applySnapshot({ ...createDefaultDndMapperState(), maps: [map], activeMapId: "map-1" });

    const image: MapImage = {
      id: "img-1",
      name: "Altar",
      contentType: "image/png",
      shareToken: null,
      x: 10,
      y: 10,
      width: 4,
      height: 4,
      originalWidth: 4,
      originalHeight: 4,
      rotation: 0,
      opacity: 1,
      layerOrder: 1,
      locked: true,
      hidden: false,
      byteSize: 2048,
      wasDownscaled: false,
      originalLongEdgePx: 200,
      displayLongEdgePx: 200,
    };

    view.applyPatch({ kind: "image", image });
    let currentMap = view.state.maps[0] as GameMap;
    expect(currentMap.images).toHaveLength(1);
    expect(currentMap.images[0].name).toBe("Altar");

    view.applyPatch({ kind: "imageRemoved", imageId: "img-1" });
    currentMap = view.state.maps[0] as GameMap;
    expect(currentMap.images).toHaveLength(0);
  });

  it("merges mapList and full map updates", () => {
    const view = new MatchView();
    const map1 = makeMap("map-1", "Map One");
    view.applySnapshot({ ...createDefaultDndMapperState(), maps: [map1], activeMapId: "map-1" });

    // DM adds map2, client receives mapList summary
    const summaries: MapSummary[] = [
      { id: "map-1", name: "Map One", listOrder: 0, widthCells: 30, heightCells: 20 },
      { id: "map-2", name: "Map Two", listOrder: 1, widthCells: 40, heightCells: 40 },
    ];
    view.applyPatch({ kind: "mapList", maps: summaries });

    expect(view.state.maps).toHaveLength(2);
    // map-1 preserves full map data
    expect(isFullMap(view.state.maps[0])).toBe(true);
    // map-2 is initially just summary
    expect(isFullMap(view.state.maps[1])).toBe(false);

    // Client requests map-2 and receives full map patch
    const fullMap2 = makeMap("map-2", "Map Two");
    view.applyPatch({ kind: "map", map: fullMap2 });
    expect(isFullMap(view.state.maps[1])).toBe(true);
  });

  it("merges activeMap, focusRect, centerViewport, settings, and dm", () => {
    const view = new MatchView();
    view.applySnapshot(createDefaultDndMapperState("dm-1"));

    view.applyPatch({ kind: "activeMap", mapId: "map-9" });
    expect(view.state.activeMapId).toBe("map-9");

    const rect = { mapId: "map-9", x: 0, y: 0, width: 10, height: 10 };
    view.applyPatch({ kind: "focusRect", rect });
    expect(view.state.focusRect).toEqual(rect);

    const center = { mapId: "map-9", x: 5, y: 5, nonce: "n1" };
    view.applyPatch({ kind: "centerViewport", request: center });
    expect(view.state.pendingCenterRequest).toEqual(center);

    const nextSettings = { ...view.state.settings, tokenMovement: "Anyone" as const };
    view.applyPatch({ kind: "settings", settings: nextSettings });
    expect(view.state.settings.tokenMovement).toBe("Anyone");

    view.applyPatch({ kind: "dm", dmPlayerId: "dm-2" });
    expect(view.state.dmPlayerId).toBe("dm-2");
  });

  it("is idempotent: re-applying the same patch changes nothing", () => {
    const view = new MatchView();
    const map = makeMap("map-1", "Dungeon");
    view.applySnapshot({ ...createDefaultDndMapperState(), maps: [map], activeMapId: "map-1" });

    const patch: Patch = { kind: "activeMap", mapId: "map-1" };
    view.applyPatch(patch);
    const state1 = view.state;
    view.applyPatch(patch);
    const state2 = view.state;
    expect(state1).toEqual(state2);
  });
});
