import { describe, expect, it } from "vitest";
import { MatchView } from "./view";
import type { CustomTemplate, DndMapperState, GameMap, Token } from "./domain";
import { createDefaultDndMapperState, createDefaultGridConfig, isFullMap } from "./domain";
import { toMapSummary } from "./domain";

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
});

/** A host store seeded like a live session: roster fed, DM seeded, state loaded. */
function seedHost(state: Partial<DndMapperState> = {}): MatchView {
  const view = new MatchView();
  view.setRoster([{ id: "dm-1", displayName: "DM" }]);
  if (Object.keys(state).length > 0) {
    view.applyLoaded({ ...createDefaultDndMapperState(), ...state });
  }
  return view;
}

function makeCustomTemplate(id: string, name: string): CustomTemplate {
  return {
    id,
    name,
    description: "",
    values: {},
    maxHp: null,
    armorClass: null,
    color: "#888888",
    notes: "",
    statusEffectTemplates: [],
    rollTemplates: [],
  };
}

describe("MatchView host store", () => {
  it("applyIntent accepts a DM intent and mutates host state", () => {
    const view = seedHost();

    const patch = view.applyIntent("dm-1", { kind: "createMap", name: "The Crypt" });
    expect(patch).not.toBeNull();
    expect(patch?.kind).toBe("map");
    expect(view.state.maps).toHaveLength(1);
    expect(view.state.maps[0].name).toBe("The Crypt");
  });

  it("applyIntent rejects a guest DM-only intent and leaves state untouched", () => {
    const view = new MatchView();
    view.setRoster([
      { id: "dm-1", displayName: "DM" },
      { id: "guest-1", displayName: "Guest" },
    ]);

    const patch = view.applyIntent("guest-1", { kind: "createMap", name: "Illegal Map" });
    expect(patch).toBeNull();
    expect(view.state.maps).toHaveLength(0);
  });

  it("snapshot projects per player: guests lose hidden content, DM keeps all", () => {
    const view = seedHost();
    view.applyIntent("dm-1", { kind: "createMap", name: "The Crypt" });

    const forDm = view.snapshot("dm-1");
    const forGuest = view.snapshot("guest-1");
    expect(forGuest).toEqual(forDm);
    expect(forGuest.maps).toHaveLength(1);
  });

  it("snapshot strips hidden tokens for guests but not the DM", () => {
    const map = makeMap("map-1", "Dungeon");
    const hidden: Token = {
      id: "tok-hidden",
      type: "NPCToken",
      ownerUserId: null,
      representsUserId: null,
      name: "Secret",
      color: "#000",
      iconKind: "Initial",
      mapId: "map-1",
      x: 1.5,
      y: 1.5,
      sheetId: null,
      hidden: true,
    };
    const view = seedHost({ maps: [{ ...map, tokens: [hidden] }], activeMapId: "map-1" });

    const dmMap = view.snapshot("dm-1").maps[0] as GameMap;
    expect(isFullMap(dmMap) && dmMap.tokens).toHaveLength(1);
    const guestMap = view.snapshot("guest-1").maps[0] as GameMap;
    expect(isFullMap(guestMap) && guestMap.tokens).toHaveLength(0);
  });

  it("keeps a state change accepted without a patch and still signals accept", () => {
    const view = seedHost({
      customTemplates: {
        "ct-a": makeCustomTemplate("ct-a", "Goblin"),
        "ct-b": makeCustomTemplate("ct-b", "Orc"),
      },
    });

    const accepted = view.applyIntent("dm-1", {
      kind: "reorderCustomTemplates",
      templateIds: ["ct-b", "ct-a"],
    });

    // Non-null: per-recipient KBAuthority re-projects every player on accept.
    expect(accepted).not.toBeNull();
    expect(Object.keys(view.state.customTemplates)).toEqual(["ct-b", "ct-a"]);
  });

  it("stays silent for an accepted intent that changes nothing", () => {
    const view = seedHost({ maps: [makeMap("map-1", "Dungeon")], activeMapId: "map-1" });
    const before = view.state;

    expect(view.applyIntent("dm-1", { kind: "exportMapImage", mapId: "map-1" })).toBeNull();
    expect(view.state).toBe(before);
  });

  it("handlePlayerLeft turns the leaver's tokens into NPCs", () => {
    const owned: Token = {
      id: "tok-alice",
      type: "PlayerToken",
      ownerUserId: "guest-1",
      representsUserId: null,
      name: "Alice",
      color: "#f00",
      iconKind: "Initial",
      mapId: "map-1",
      x: 1.5,
      y: 1.5,
      sheetId: null,
      hidden: false,
    };
    const view = seedHost({
      maps: [{ ...makeMap("map-1", "Dungeon"), tokens: [owned] }],
      activeMapId: "map-1",
    });
    view.setRoster([
      { id: "dm-1", displayName: "DM" },
      { id: "guest-1", displayName: "Guest" },
    ]);

    view.handlePlayerLeft("guest-1");

    const map = view.state.maps[0];
    const token = isFullMap(map) ? map.tokens.find((t) => t.id === "tok-alice") : undefined;
    expect(token).toMatchObject({
      type: "NPCToken",
      ownerUserId: null,
      representsUserId: "guest-1",
    });
    expect(view.state.dmPlayerId).toBe("dm-1");
  });
});

describe("MatchView.applyLoaded (Phase 03 direct save/load swap)", () => {
  function loadedState(): DndMapperState {
    const mapA = makeMap("map-a", "Hall");
    const mapB = { ...makeMap("map-b", "Crypt"), listOrder: 1 };
    return {
      ...createDefaultDndMapperState(),
      phase: "Lobby",
      maps: [mapA, mapB],
      activeMapId: "map-b",
      // Slot shards persist with no DM owner; the host's roster wins.
      dmPlayerId: null,
    };
  }

  function seededHost(): MatchView {
    return seedHost();
  }

  it("swaps the slot into live state and marks it Playing with an announcement", () => {
    const view = seededHost();
    view.applyLoaded(loadedState());

    expect(view.state.phase).toBe("Playing");
    expect(view.state.maps).toHaveLength(2);
    expect(view.state.maps.map((m) => m.id)).toEqual(["map-a", "map-b"]);
    expect(view.state.activeMapId).toBe("map-b");
    expect(view.state.dmPlayerId).toBe("dm-1");
    expect(view.state.announcement).toBeDefined();
    expect(typeof view.state.announcement?.id).toBe("string");
  });

  it("keeps the live status effect templates (slots never persist them)", () => {
    const view = seededHost();
    const live = view.state.statusEffectTemplates;
    expect(Object.keys(live).length).toBeGreaterThan(0);

    view.applyLoaded({ ...loadedState(), statusEffectTemplates: {} });

    expect(view.state.statusEffectTemplates).toEqual(live);
  });

  it("resets ephemeral session state (roll log, host keys, viewport)", () => {
    const view = seededHost();
    view.applyLoaded({
      ...loadedState(),
      rollLog: [
        {
          id: "r-1",
          rollerUserId: "dm-1",
          forcedByUserId: null,
          rolls: [],
          total: 12,
          mode: "Normal",
          flatModifier: 0,
          attributeModifier: 0,
          label: "",
          timestampUtc: "",
          formula: "1d20",
          modifierBreakdown: "",
          tokenId: null,
          appliedRules: [],
        },
      ],
      hostHeldKeys: ["Shift"],
      pendingCenterRequest: { mapId: "map-a", x: 1, y: 1, nonce: "n" },
      focusRect: { mapId: "map-a", x: 0, y: 0, width: 1, height: 1 },
    });

    expect(view.state.rollLog).toHaveLength(0);
    expect(view.state.hostHeldKeys).toHaveLength(0);
    expect(view.state.pendingCenterRequest).toBeNull();
    expect(view.state.focusRect).toBeNull();
  });

  it("drops summary maps and falls back to the first full map", () => {
    const full = makeMap("full-1", "Full Map");
    const summary = toMapSummary(makeMap("sum-1", "Stale Summary"));
    const view = seededHost();
    view.applyLoaded({
      ...createDefaultDndMapperState(),
      maps: [full, summary],
      // Pre-fix slots may point at a map that no longer has content.
      activeMapId: "sum-1",
      dmPlayerId: null,
    });

    expect(view.state.maps).toHaveLength(1);
    expect(view.state.maps[0].id).toBe("full-1");
    expect(view.state.activeMapId).toBe("full-1");
  });

  it("repairs orphan tokens through ensureBoundPairs", () => {
    const orphan: Token = {
      id: "tok-orphan",
      type: "PlayerToken",
      ownerUserId: null,
      representsUserId: null,
      name: "Orphan",
      color: "#f00",
      iconKind: "Initial",
      mapId: "map-a",
      x: 1.5,
      y: 1.5,
      sheetId: null,
      hidden: false,
    };
    const view = seededHost();
    view.applyLoaded({
      ...loadedState(),
      maps: [{ ...makeMap("map-a", "Hall"), tokens: [orphan] }],
      activeMapId: "map-a",
    });

    const sheetIds = Object.keys(view.state.sheets);
    expect(sheetIds).toHaveLength(1);
    const liveMap = view.state.maps[0];
    expect(isFullMap(liveMap) && liveMap.tokens[0].sheetId).toBe(sheetIds[0]);
  });

  it("snapshot after load projects inactive maps as summaries", () => {
    const view = seededHost();
    view.applyLoaded(loadedState());

    const snapshot = view.snapshot();
    expect(snapshot.maps).toHaveLength(2);
    const active = snapshot.maps.find((m) => m.id === "map-b")!;
    const inactive = snapshot.maps.find((m) => m.id === "map-a")!;
    expect(isFullMap(active)).toBe(true);
    expect(isFullMap(inactive)).toBe(false);
  });
});
