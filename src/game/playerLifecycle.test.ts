import { describe, expect, it } from "vitest";
import type { CharacterSheet, DndMapperState, GameMap } from "./domain.js";
import { createDefaultDndMapperState, createDefaultGridConfig } from "./domain.js";
import { applyIntent, handlePlayerLeft } from "./rules.js";
import type { PlayerInfo } from "./types.js";

function makeLifecycleState(): {
  state: DndMapperState;
  roster: PlayerInfo[];
} {
  const base = createDefaultDndMapperState();

  const map: GameMap = {
    id: "map-main",
    name: "Main Map",
    grid: {
      ...createDefaultGridConfig(),
      widthCells: 20,
      heightCells: 20,
    },
    images: [],
    tokens: [
      {
        id: "tok-dm",
        type: "NPCToken",
        ownerUserId: "user-dm",
        representsUserId: null,
        name: "Dungeon Master",
        color: "#9b59b6",
        iconKind: "Initial",
        mapId: "map-main",
        x: 0,
        y: 0,
        sheetId: null,
        hidden: false,
      },
      {
        id: "tok-alice",
        type: "PlayerToken",
        ownerUserId: "user-alice",
        representsUserId: null,
        name: "Alice",
        color: "#3498db",
        iconKind: "Initial",
        mapId: "map-main",
        x: 5,
        y: 5,
        sheetId: "sheet-alice",
        hidden: false,
      },
    ],
    createdUtc: "2026-09-08T00:00:00.000Z",
    listOrder: 0,
    defaultSpawnPosition: { x: 10, y: 10 },
    markupSvg: null,
    fogMask: "",
  };

  const sheetAlice: CharacterSheet = {
    id: "sheet-alice",
    characterName: "Alice the Fighter",
    ownerUserId: "user-alice",
    representsUserId: null,
    color: "#3498db",
    scopedMapId: null,
    hp: 30,
    maxHp: 30,
    armorClass: 16,
    notes: "",
    values: {},
    statusEffects: [],
    rollTemplates: [],
  };

  const state: DndMapperState = {
    ...base,
    phase: "Lobby",
    dmPlayerId: "user-dm",
    activeMapId: "map-main",
    maps: [map],
    sheets: {
      "sheet-alice": sheetAlice,
    },
    activeCombat: {
      phase: "Active",
      roundNumber: 1,
      currentTurnIndex: 0,
      turnOrder: [
        {
          id: "c-alice",
          tokenId: "tok-alice",
          name: "Alice",
          initiativeRoll: 15,
          isForceRolled: false,
          pendingInitiative: null,
          ownerUserId: "user-alice",
        },
      ],
    },
  };

  const roster: PlayerInfo[] = [
    { id: "user-dm", displayName: "Dungeon Master" },
    { id: "user-alice", displayName: "Alice" },
    { id: "user-bob", displayName: "Bob" },
  ];

  return { state, roster };
}

describe("Auto-Spawn on Session Start", () => {
  it("spawns tokens for connected players lacking tokens on active map", () => {
    const { state, roster } = makeLifecycleState();

    const result = applyIntent(
      state,
      "user-dm",
      { kind: "startSession" },
      Date.now(),
      roster,
    );

    expect(result).not.toBeNull();
    const nextState = result!.state;
    expect(nextState.phase).toBe("Playing");

    const fullMap = nextState.maps[0] as GameMap;
    // DM and Alice had tokens, Bob was in roster but had none
    expect(fullMap.tokens).toHaveLength(3);

    const bobToken = fullMap.tokens.find((t) => t.ownerUserId === "user-bob");
    expect(bobToken).toBeDefined();
    expect(bobToken!.type).toBe("PlayerToken");
    expect(bobToken!.name).toBe("Bob");
    // Spawned at defaultSpawnPosition
    expect(bobToken!.x).toBe(10);
    expect(bobToken!.y).toBe(10);
  });

  it("does not spawn tokens if all players already have tokens", () => {
    const { state } = makeLifecycleState();
    const roster: PlayerInfo[] = [
      { id: "user-dm", displayName: "Dungeon Master" },
      { id: "user-alice", displayName: "Alice" },
    ];

    const result = applyIntent(
      state,
      "user-dm",
      { kind: "startSession" },
      Date.now(),
      roster,
    );

    expect(result).not.toBeNull();
    const fullMap = result!.state.maps[0] as GameMap;
    expect(fullMap.tokens).toHaveLength(2);
  });
});

describe("handlePlayerLeft (Abandonment & Lifecycle)", () => {
  it("converts player tokens to NPCToken and sets representsUserId", () => {
    const { state, roster } = makeLifecycleState();

    const { state: nextState } = handlePlayerLeft(state, "user-alice", roster);

    const fullMap = nextState.maps[0] as GameMap;
    const token = fullMap.tokens.find((t) => t.id === "tok-alice");
    expect(token).toBeDefined();
    expect(token!.type).toBe("NPCToken");
    expect(token!.ownerUserId).toBeNull();
    expect(token!.representsUserId).toBe("user-alice");
  });

  it("clears sheet ownerUserId and records representsUserId", () => {
    const { state, roster } = makeLifecycleState();

    const { state: nextState } = handlePlayerLeft(state, "user-alice", roster);

    const sheet = nextState.sheets["sheet-alice"];
    expect(sheet).toBeDefined();
    expect(sheet.ownerUserId).toBeNull();
    expect(sheet.representsUserId).toBe("user-alice");
  });

  it("clears combatant ownerUserId in active combat", () => {
    const { state, roster } = makeLifecycleState();

    const { state: nextState } = handlePlayerLeft(state, "user-alice", roster);

    expect(nextState.activeCombat?.turnOrder[0].ownerUserId).toBeNull();
  });

  it("promotes oldest remaining peer when DM leaves", () => {
    const { state, roster } = makeLifecycleState();

    const { state: nextState } = handlePlayerLeft(state, "user-dm", roster);

    // DM left, first remaining player in roster is Alice
    expect(nextState.dmPlayerId).toBe("user-alice");
  });
});

describe("DM Reassignment Actions", () => {
  it("allows DM to reassign abandoned token via reassignTokenOwner", () => {
    const { state, roster } = makeLifecycleState();
    // Simulate Alice having left
    const { state: abandonedState } = handlePlayerLeft(state, "user-alice", roster);

    // DM reassigns token to Bob
    const result = applyIntent(
      abandonedState,
      "user-dm",
      {
        kind: "reassignTokenOwner",
        tokenId: "tok-alice",
        newOwnerUserId: "user-bob",
      },
      Date.now(),
    );

    expect(result).not.toBeNull();
    const updatedMap = result!.state.maps[0] as GameMap;
    const token = updatedMap.tokens.find((t) => t.id === "tok-alice")!;

    expect(token.type).toBe("PlayerToken");
    expect(token.ownerUserId).toBe("user-bob");
    expect(token.representsUserId).toBeNull();

    // Linked character sheet should also update
    const sheet = result!.state.sheets["sheet-alice"];
    expect(sheet.ownerUserId).toBe("user-bob");
    expect(sheet.representsUserId).toBeNull();
  });

  it("allows DM to reassign abandoned sheet via assignCharacterToPlayer", () => {
    const { state, roster } = makeLifecycleState();
    const { state: abandonedState } = handlePlayerLeft(state, "user-alice", roster);

    const result = applyIntent(
      abandonedState,
      "user-dm",
      {
        kind: "assignCharacterToPlayer",
        sheetId: "sheet-alice",
        playerId: "user-bob",
      },
      Date.now(),
    );

    expect(result).not.toBeNull();
    const sheet = result!.state.sheets["sheet-alice"];
    expect(sheet.ownerUserId).toBe("user-bob");
    expect(sheet.representsUserId).toBeNull();

    // Linked token should also be updated to PlayerToken owned by Bob
    const map = result!.state.maps[0] as GameMap;
    const token = map.tokens.find((t) => t.sheetId === "sheet-alice")!;
    expect(token.type).toBe("PlayerToken");
    expect(token.ownerUserId).toBe("user-bob");
    expect(token.representsUserId).toBeNull();
  });

  it("rejects reassignTokenOwner if issued by non-DM", () => {
    const { state, roster } = makeLifecycleState();
    const { state: abandonedState } = handlePlayerLeft(state, "user-alice", roster);

    const result = applyIntent(
      abandonedState,
      "user-bob", // Not DM
      {
        kind: "reassignTokenOwner",
        tokenId: "tok-alice",
        newOwnerUserId: "user-bob",
      },
      Date.now(),
    );

    expect(result).toBeNull();
  });
});
