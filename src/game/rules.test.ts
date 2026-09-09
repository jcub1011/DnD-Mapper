import { describe, expect, it } from "vitest";
import {
  applyIntent,
  clearPendingImports,
  createState,
  isDm,
  mayEditSheet,
  mayMoveToken,
  maySpawnToken,
  mayViewSheet,
  mayViewSheetNotesAndHp,
  projectSnapshot,
} from "./rules";
import type {
  CampaignHeader,
  CharacterSheet,
  DndMapperState,
  GameMap,
  NewMapImage,
  NewToken,
  Token,
} from "./domain";
import { isFullMap } from "./domain";

const ROSTER = [
  { id: "dm-1", displayName: "Dungeon Master" },
  { id: "player-1", displayName: "Alice" },
  { id: "player-2", displayName: "Bob" },
];

function setupMatch(): DndMapperState {
  clearPendingImports();
  const state = createState(ROSTER);
  // DM creates initial map
  const res = applyIntent(state, "dm-1", { kind: "createMap", name: "Dungeon Level 1" }, 1000);
  return res!.state;
}

describe("createState & permissions", () => {
  it("seeds the first player as the DM and starts in Lobby", () => {
    const state = createState(ROSTER);
    expect(state.phase).toBe("Lobby");
    expect(state.dmPlayerId).toBe("dm-1");
    expect(isDm(state, "dm-1")).toBe(true);
    expect(isDm(state, "player-1")).toBe(false);
  });

  it("evaluates mayMoveToken according to tokenMovement policy", () => {
    let state = createState(ROSTER);
    const token: Token = {
      id: "tok-1",
      type: "PlayerToken",
      ownerUserId: "player-1",
      representsUserId: null,
      name: "Hero",
      color: "#f00",
      iconKind: "Initial",
      mapId: "map-1",
      x: 1.5,
      y: 1.5,
      sheetId: null,
      hidden: false,
    };

    // Under OwnerOrHost: DM and owner can move; others cannot
    state = { ...state, settings: { ...state.settings, tokenMovement: "OwnerOrHost" } };
    expect(mayMoveToken(state, "dm-1", token)).toBe(true);
    expect(mayMoveToken(state, "player-1", token)).toBe(true);
    expect(mayMoveToken(state, "player-2", token)).toBe(false);

    // Under HostOnly: only DM can move
    state = { ...state, settings: { ...state.settings, tokenMovement: "HostOnly" } };
    expect(mayMoveToken(state, "dm-1", token)).toBe(true);
    expect(mayMoveToken(state, "player-1", token)).toBe(false);

    // Under Anyone: any player can move
    state = { ...state, settings: { ...state.settings, tokenMovement: "Anyone" } };
    expect(mayMoveToken(state, "player-2", token)).toBe(true);
  });

  it("evaluates maySpawnToken for NPCs and players", () => {
    let state = createState(ROSTER);
    const npc: NewToken = {
      type: "NPCToken",
      name: "Goblin",
      color: "#0f0",
      iconKind: "Initial",
      x: 2.5,
      y: 2.5,
      sheetId: null,
      hidden: false,
    };
    const pc: NewToken = { ...npc, type: "PlayerToken" };

    // When playersCanCreateNPCs is false:
    state = { ...state, settings: { ...state.settings, playersCanCreateNPCs: false } };
    expect(maySpawnToken(state, "dm-1", npc)).toBe(true);
    expect(maySpawnToken(state, "player-1", npc)).toBe(false);
    expect(maySpawnToken(state, "player-1", pc)).toBe(true);

    // When playersCanCreateNPCs is true:
    state = { ...state, settings: { ...state.settings, playersCanCreateNPCs: true } };
    expect(maySpawnToken(state, "player-1", npc)).toBe(true);
  });
});

describe("applyIntent — rejection (anti-cheat)", () => {
  it("rejects non-object or null intents", () => {
    const state = setupMatch();
    expect(applyIntent(state, "dm-1", null, 1000)).toBeNull();
    expect(applyIntent(state, "dm-1", "createMap", 1000)).toBeNull();
    expect(applyIntent(state, "dm-1", {}, 1000)).toBeNull();
  });

  it("rejects DM-privileged intents from non-DM players", () => {
    const state = setupMatch();
    expect(applyIntent(state, "player-1", { kind: "createMap", name: "Hack" }, 1000)).toBeNull();
    expect(
      applyIntent(state, "player-1", { kind: "fillFog", mapId: state.activeMapId }, 1000),
    ).toBeNull();
    expect(applyIntent(state, "player-1", { kind: "updateSettings", patch: {} }, 1000)).toBeNull();
  });

  it("rejects moving a token a player does not own under OwnerOrHost", () => {
    let state = setupMatch();
    state = { ...state, settings: { ...state.settings, tokenMovement: "OwnerOrHost" } };
    const spawnRes = applyIntent(
      state,
      "dm-1",
      {
        kind: "spawnToken",
        mapId: state.activeMapId!,
        token: {
          type: "PlayerToken",
          name: "AliceToken",
          color: "#00f",
          iconKind: "Initial",
          x: 1.5,
          y: 1.5,
          sheetId: null,
          hidden: false,
        },
      },
      1000,
    );
    state = spawnRes!.state;
    if (spawnRes!.patch?.kind !== "token") throw new Error("expected token patch");
    const token = spawnRes!.patch.token;

    // Bob tries to move Alice's token
    const hackedToken = { ...token, ownerUserId: "player-1" };
    state = {
      ...state,
      maps: state.maps.map((m) => (isFullMap(m) ? { ...m, tokens: [hackedToken] } : m)),
    };

    expect(
      applyIntent(
        state,
        "player-2",
        { kind: "moveToken", tokenId: token.id, x: 5.5, y: 5.5 },
        1000,
      ),
    ).toBeNull();
  });
});

describe("applyIntent — maps & tokens", () => {
  it("creates, renames, duplicates, and reorders maps", () => {
    let state = setupMatch();
    const map1Id = state.activeMapId!;

    // Create second map
    const res2 = applyIntent(state, "dm-1", { kind: "createMap", name: "Dungeon Level 2" }, 2000);
    state = res2!.state;
    expect(res2!.patch?.kind).toBe("map");
    expect(state.maps).toHaveLength(2);
    const map2Id = state.maps[1].id;

    // Rename second map
    const resRename = applyIntent(
      state,
      "dm-1",
      { kind: "renameMap", mapId: map2Id, name: "Crypt" },
      2100,
    );
    state = resRename!.state;
    expect(state.maps.find((m) => m.id === map2Id)?.name).toBe("Crypt");

    // Reorder maps
    const resReorder = applyIntent(
      state,
      "dm-1",
      { kind: "reorderMaps", order: [map2Id, map1Id] },
      2200,
    );
    state = resReorder!.state;
    expect(state.maps[0].id).toBe(map2Id);
    expect(state.maps[1].id).toBe(map1Id);

    // Duplicate map
    const resDup = applyIntent(state, "dm-1", { kind: "duplicateMap", mapId: map2Id }, 2300);
    state = resDup!.state;
    expect(state.maps).toHaveLength(3);
    expect(state.maps[2].name).toBe("Crypt (Copy)");

    // Switch active map
    const resActive = applyIntent(state, "dm-1", { kind: "setActiveMap", mapId: map2Id }, 2400);
    state = resActive!.state;
    expect(state.activeMapId).toBe(map2Id);
    expect(resActive!.patch).toEqual({ kind: "activeMap", mapId: map2Id });
  });

  it("spawns, moves, snaps, and removes tokens", () => {
    let state = setupMatch();
    const mapId = state.activeMapId!;

    // Spawn token
    const spawnRes = applyIntent(
      state,
      "dm-1",
      {
        kind: "spawnToken",
        mapId,
        token: {
          type: "PlayerToken",
          name: "Paladin",
          color: "#fff",
          iconKind: "Initial",
          x: 2.2, // raw coord, snapping should center at 2.5
          y: 3.8, // raw coord, snapping should center at 3.5
          sheetId: null,
          hidden: false,
        },
      },
      3000,
    );
    expect(spawnRes).not.toBeNull();
    state = spawnRes!.state;
    if (spawnRes!.patch?.kind !== "token") throw new Error("expected token patch");
    const token = spawnRes!.patch.token;
    expect(token.x).toBe(2.5);
    expect(token.y).toBe(3.5);

    // Move token (respecting cell centering and clamp)
    const moveRes = applyIntent(
      state,
      "dm-1",
      {
        kind: "moveToken",
        tokenId: token.id,
        x: 10.1,
        y: 15.9,
      },
      3100,
    );
    expect(moveRes).not.toBeNull();
    state = moveRes!.state;
    if (moveRes!.patch?.kind !== "token") throw new Error("expected token patch");
    const moved = moveRes!.patch.token;
    expect(moved.x).toBe(10.5);
    expect(moved.y).toBe(15.5);

    // Remove token
    const removeRes = applyIntent(state, "dm-1", { kind: "removeToken", tokenId: token.id }, 3200);
    expect(removeRes).not.toBeNull();
    state = removeRes!.state;
    expect(removeRes!.patch).toEqual({ kind: "tokenRemoved", tokenId: token.id });
    const activeMap = state.maps.find((m) => m.id === mapId) as GameMap;
    expect(activeMap.tokens).toHaveLength(0);
  });
});

describe("applyIntent — images & fog", () => {
  it("adds, transforms, and removes images", () => {
    let state = setupMatch();
    const mapId = state.activeMapId!;

    const newImg: NewMapImage = {
      name: "Chest",
      contentType: "image/png",
      x: 5,
      y: 5,
      width: 2,
      height: 2,
      originalWidth: 2,
      originalHeight: 2,
      rotation: 0,
      opacity: 1,
      locked: false,
      hidden: false,
      byteSize: 1024,
      wasDownscaled: false,
      originalLongEdgePx: 100,
      displayLongEdgePx: 100,
    };

    const addRes = applyIntent(state, "dm-1", { kind: "addImage", mapId, image: newImg }, 4000);
    expect(addRes).not.toBeNull();
    state = addRes!.state;
    if (addRes!.patch?.kind !== "image") throw new Error("expected image patch");
    const img = addRes!.patch.image;
    expect(img.id).toBeTruthy();
    expect(img.layerOrder).toBe(0);

    // Transform image
    const transRes = applyIntent(
      state,
      "dm-1",
      {
        kind: "transformImage",
        imageId: img.id,
        x: 6,
        y: 7,
        width: 3,
        height: 3,
        rotation: 45,
      },
      4100,
    );
    expect(transRes).not.toBeNull();
    state = transRes!.state;
    if (transRes!.patch?.kind !== "image") throw new Error("expected image patch");
    const transformed = transRes!.patch.image;
    expect(transformed.x).toBe(6);
    expect(transformed.rotation).toBe(45);

    // Remove image
    const remRes = applyIntent(state, "dm-1", { kind: "removeImage", imageId: img.id }, 4200);
    expect(remRes).not.toBeNull();
    state = remRes!.state;
    expect(remRes!.patch).toEqual({ kind: "imageRemoved", imageId: img.id });
    expect((state.maps.find((m) => m.id === mapId) as GameMap).images).toHaveLength(0);
  });

  it("paints, fills, and clears fog", () => {
    let state = setupMatch();
    const mapId = state.activeMapId!;

    // Paint fog on cells 0, 1, 2
    const paintRes = applyIntent(
      state,
      "dm-1",
      { kind: "paintFog", mapId, cells: [0, 1, 2], fogged: true },
      5000,
    );
    expect(paintRes).not.toBeNull();
    state = paintRes!.state;
    expect(paintRes!.patch?.kind).toBe("fog");

    // Fill fog
    const fillRes = applyIntent(state, "dm-1", { kind: "fillFog", mapId }, 5100);
    expect(fillRes).not.toBeNull();
    state = fillRes!.state;
    if (fillRes!.patch?.kind !== "fog") throw new Error("expected fog patch");
    expect(fillRes!.patch.mask.length).toBeGreaterThan(0);

    // Clear fog
    const clearRes = applyIntent(state, "dm-1", { kind: "clearFog", mapId }, 5200);
    expect(clearRes).not.toBeNull();
    state = clearRes!.state;
    if (clearRes!.patch?.kind !== "fog") throw new Error("expected fog patch");
    expect(clearRes!.patch.mask).toBe("");
    expect((state.maps.find((m) => m.id === mapId) as GameMap).fogMask).toBe("");
  });
});

describe("applyIntent — chunked campaign import protocol", () => {
  it("stages and commits a multi-chunk campaign atomically", () => {
    const state = createState(ROSTER);
    const mapA = { ...setupMatch().maps[0], id: "map-a", name: "Map Alpha" };
    const mapB = { ...mapA, id: "map-b", name: "Map Beta" };

    const campaignHeader: CampaignHeader = {
      title: "Epic Campaign",
      activeMapId: "map-b",
    };

    const token = "test-token-123";

    // 1. beginImport
    const beginRes = applyIntent(
      state,
      "dm-1",
      { kind: "beginImport", token, campaign: campaignHeader, chunkCount: 2 },
      6000,
    );
    expect(beginRes).not.toBeNull();
    expect(beginRes!.patch).toBeNull(); // No broadcast during staging

    // 2. importChunk index 0
    const chunk0Res = applyIntent(
      state,
      "dm-1",
      { kind: "importChunk", token, index: 0, maps: [mapA] },
      6010,
    );
    expect(chunk0Res).not.toBeNull();
    expect(chunk0Res!.patch).toBeNull();

    // Premature commit before all chunks arrive should be rejected
    expect(applyIntent(state, "dm-1", { kind: "commitImport", token }, 6015)).toBeNull();

    // Re-stage after rejected commit
    applyIntent(
      state,
      "dm-1",
      { kind: "beginImport", token, campaign: campaignHeader, chunkCount: 2 },
      6020,
    );
    applyIntent(state, "dm-1", { kind: "importChunk", token, index: 0, maps: [mapA] }, 6025);

    // 3. importChunk index 1
    const chunk1Res = applyIntent(
      state,
      "dm-1",
      { kind: "importChunk", token, index: 1, maps: [mapB] },
      6030,
    );
    expect(chunk1Res).not.toBeNull();
    expect(chunk1Res!.patch).toBeNull();

    // 4. commitImport
    const commitRes = applyIntent(state, "dm-1", { kind: "commitImport", token }, 6040);
    expect(commitRes).not.toBeNull();
    expect(commitRes!.patch?.kind).toBe("full");

    const liveState = commitRes!.state;
    expect(liveState.phase).toBe("Playing");
    expect(liveState.activeMapId).toBe("map-b");
    expect(liveState.maps).toHaveLength(2);
    expect(liveState.maps.map((m) => m.id)).toEqual(["map-a", "map-b"]);
  });
});

describe("projectSnapshot", () => {
  it("bounds the snapshot by sending only active map in full and others as summaries", () => {
    const state = setupMatch();
    const map1Id = state.activeMapId!;
    const res2 = applyIntent(state, "dm-1", { kind: "createMap", name: "Second Map" }, 7000);
    const fullState = res2!.state;
    expect(fullState.maps).toHaveLength(2);

    const snapshot = projectSnapshot(fullState);
    expect(snapshot.maps).toHaveLength(2);

    const activeInSnapshot = snapshot.maps.find((m) => m.id === map1Id)!;
    const inactiveInSnapshot = snapshot.maps.find((m) => m.id !== map1Id)!;

    // Active map has full fields
    expect(isFullMap(activeInSnapshot)).toBe(true);
    expect("tokens" in activeInSnapshot).toBe(true);
    expect("fogMask" in activeInSnapshot).toBe(true);

    // Inactive map has only summary fields
    expect(isFullMap(inactiveInSnapshot)).toBe(false);
    expect("tokens" in inactiveInSnapshot).toBe(false);
    expect("fogMask" in inactiveInSnapshot).toBe(false);
    expect("widthCells" in inactiveInSnapshot).toBe(true);
  });
});

describe("Character Sheet Permissions (Phase 6)", () => {
  const mockSheet = (ownerUserId: string | null): CharacterSheet => ({
    id: "sheet-1",
    ownerUserId,
    representsUserId: null,
    characterName: "Test Character",
    values: {},
    notes: "Secret backstory",
    hp: 20,
    maxHp: 20,
    armorClass: 14,
    color: "#4a90e2",
    scopedMapId: null,
    statusEffects: [],
    rollTemplates: [],
  });

  describe("mayEditSheet", () => {
    it("DM can edit any sheet regardless of settings", () => {
      const state = setupMatch();
      const sheet = mockSheet("player-1");
      expect(mayEditSheet(state, "dm-1", sheet)).toBe(true);
    });

    it("evaluates HostOnly: non-DM players cannot edit sheets", () => {
      let state = setupMatch();
      state = { ...state, settings: { ...state.settings, sheetEditByOthers: "HostOnly" } };
      const sheet = mockSheet("player-1");
      expect(mayEditSheet(state, "player-1", sheet)).toBe(false);
      expect(mayEditSheet(state, "player-2", sheet)).toBe(false);
    });

    it("evaluates OwnersAndHost: owner can edit, others cannot", () => {
      let state = setupMatch();
      state = { ...state, settings: { ...state.settings, sheetEditByOthers: "OwnersAndHost" } };
      const sheet = mockSheet("player-1");
      expect(mayEditSheet(state, "player-1", sheet)).toBe(true);
      expect(mayEditSheet(state, "player-2", sheet)).toBe(false);
    });

    it("evaluates Anyone: all players can edit any sheet", () => {
      let state = setupMatch();
      state = { ...state, settings: { ...state.settings, sheetEditByOthers: "Anyone" } };
      const sheet = mockSheet("player-1");
      expect(mayEditSheet(state, "player-1", sheet)).toBe(true);
      expect(mayEditSheet(state, "player-2", sheet)).toBe(true);
    });
  });

  describe("mayViewSheet", () => {
    it("DM can view any sheet", () => {
      const state = setupMatch();
      expect(mayViewSheet(state, "dm-1", mockSheet("player-1"))).toBe(true);
      expect(mayViewSheet(state, "dm-1", mockSheet(null))).toBe(true);
    });

    it("hides unowned (NPC) sheets from non-DM players", () => {
      const state = setupMatch();
      expect(mayViewSheet(state, "player-1", mockSheet(null))).toBe(false);
    });

    it("hides sheets owned by others when playersCanSeeOtherSheets is false", () => {
      let state = setupMatch();
      state = { ...state, settings: { ...state.settings, playersCanSeeOtherSheets: false } };
      const sheet1 = mockSheet("player-1");
      // Player 1 can see their own sheet
      expect(mayViewSheet(state, "player-1", sheet1)).toBe(true);
      // Player 2 cannot see Player 1's sheet
      expect(mayViewSheet(state, "player-2", sheet1)).toBe(false);
    });

    it("shows sheets owned by others when playersCanSeeOtherSheets is true", () => {
      let state = setupMatch();
      state = { ...state, settings: { ...state.settings, playersCanSeeOtherSheets: true } };
      const sheet1 = mockSheet("player-1");
      expect(mayViewSheet(state, "player-2", sheet1)).toBe(true);
    });
  });

  describe("mayViewSheetNotesAndHp", () => {
    it("allows DM and owner to view notes and HP, but hides from others", () => {
      const state = setupMatch();
      const sheet = mockSheet("player-1");
      expect(mayViewSheetNotesAndHp(state, "dm-1", sheet)).toBe(true);
      expect(mayViewSheetNotesAndHp(state, "player-1", sheet)).toBe(true);
      expect(mayViewSheetNotesAndHp(state, "player-2", sheet)).toBe(false);
    });
  });
});

