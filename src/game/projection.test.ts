import { describe, expect, it } from "vitest";
import {
  createDefaultDndMapperState,
  createDefaultGridConfig,
  type CharacterSheet,
  type CombatState,
  type DndMapperState,
  type GameMap,
  type MapImage,
  type RollResult,
  type Token,
} from "./domain";
import { projectForPlayer, projectPatchForPlayer, projectSnapshot } from "./rules";
import { guardSize } from "./wire";
import { encodeFog, setCellFogged } from "./fog";
import type { Patch } from "./types";

const DM = "dm-1";
const ALICE = "player-1";
const BOB = "player-2";

function makeToken(overrides: Partial<Token> & { id: string }): Token {
  return {
    type: "PlayerToken",
    ownerUserId: ALICE,
    representsUserId: null,
    name: "Token",
    color: "#f00",
    iconKind: "Initial",
    mapId: "map-1",
    x: 1.5,
    y: 1.5,
    sheetId: null,
    hidden: false,
    ...overrides,
  };
}

function makeImage(overrides: Partial<MapImage> & { id: string }): MapImage {
  return {
    name: "Image",
    contentType: "image/png",
    shareToken: null,
    x: 0,
    y: 0,
    width: 2,
    height: 2,
    originalWidth: 2,
    originalHeight: 2,
    rotation: 0,
    opacity: 1,
    layerOrder: 1,
    locked: false,
    hidden: false,
    byteSize: 100,
    wasDownscaled: false,
    originalLongEdgePx: 10,
    displayLongEdgePx: 10,
    ...overrides,
  };
}

function makeSheet(overrides: Partial<CharacterSheet> & { id: string }): CharacterSheet {
  return {
    ownerUserId: null,
    representsUserId: null,
    characterName: "Sheet",
    values: {},
    notes: "",
    hp: null,
    maxHp: null,
    armorClass: null,
    color: "#f00",
    colorOverridden: false,
    scopedMapId: null,
    statusEffects: [],
    rollTemplates: [],
    ...overrides,
  };
}

function makeRoll(overrides: Partial<RollResult> & { id: string; rollerUserId: string }): RollResult {
  return {
    forcedByUserId: null,
    rolls: [],
    total: 10,
    mode: "Normal",
    flatModifier: 0,
    attributeModifier: 0,
    label: "Roll",
    timestampUtc: "2026-09-08T00:00:00.000Z",
    formula: "1d20",
    modifierBreakdown: "",
    tokenId: null,
    appliedRules: [],
    ...overrides,
  };
}

/** A state rich in hidden/private content for projection tests. */
function setupHiddenState(): DndMapperState {
  const aliceSheet = makeSheet({
    id: "sheet-alice",
    ownerUserId: ALICE,
    characterName: "Alice",
    notes: "alice secret notes",
    hp: 20,
    maxHp: 30,
    armorClass: 15,
  });
  const bobSheet = makeSheet({
    id: "sheet-bob",
    ownerUserId: BOB,
    characterName: "Bob",
    notes: "bob secret notes",
    hp: 5,
    maxHp: 12,
    armorClass: 13,
  });
  const orphanSheet = makeSheet({ id: "sheet-orphan", characterName: "Orphan" });
  const map: GameMap = {
    id: "map-1",
    name: "Dungeon",
    grid: createDefaultGridConfig(),
    images: [makeImage({ id: "img-open" }), makeImage({ id: "img-hidden", hidden: true })],
    tokens: [
      makeToken({ id: "tok-open", name: "Guard", sheetId: "sheet-alice" }),
      makeToken({ id: "tok-hidden", name: "Secret Assassin", hidden: true }),
    ],
    createdUtc: "2026-09-08T00:00:00.000Z",
    listOrder: 0,
    defaultSpawnPosition: null,
    markupSvg: null,
    fogMask: "",
  };
  const combat: CombatState = {
    phase: "Active",
    roundNumber: 2,
    currentTurnIndex: 1,
    turnOrder: [
      {
        id: "c-open",
        tokenId: "tok-open",
        name: "Guard",
        ownerUserId: ALICE,
        initiativeRoll: 15,
        isForceRolled: false,
        pendingInitiative: null,
      },
      {
        id: "c-hidden",
        tokenId: "tok-hidden",
        name: "Secret Assassin",
        ownerUserId: null,
        initiativeRoll: null,
        isForceRolled: false,
        pendingInitiative: 18,
      },
    ],
  };
  return {
    ...createDefaultDndMapperState(DM),
    phase: "Playing",
    maps: [map],
    activeMapId: "map-1",
    sheets: {
      [aliceSheet.id]: aliceSheet,
      [bobSheet.id]: bobSheet,
      [orphanSheet.id]: orphanSheet,
    },
    rollLog: [
      makeRoll({ id: "roll-alice", rollerUserId: ALICE }),
      makeRoll({ id: "roll-dm", rollerUserId: DM }),
    ],
    activeCombat: combat,
    loadedDiceRules: [
      {
        id: "rule-1",
        name: "Force Nat 20",
        enabled: true,
        targetSheetIds: [],
        conditions: [],
        modifications: [],
      },
    ],
  };
}

function fullMapOf(state: DndMapperState): GameMap {
  const map = state.maps[0];
  if (!("tokens" in map)) throw new Error("expected a full map");
  return map;
}

describe("projectForPlayer", () => {
  it("returns the shared snapshot unchanged for the DM (fast path)", () => {
    const state = setupHiddenState();
    expect(projectForPlayer(state, DM)).toEqual(projectSnapshot(state));
    const map = fullMapOf(projectForPlayer(state, DM));
    expect(map.tokens).toHaveLength(2);
    expect(map.images).toHaveLength(2);
    expect(Object.keys(projectForPlayer(state, DM).sheets)).toHaveLength(3);
  });

  it("drops hidden tokens and hidden images for players", () => {
    const state = setupHiddenState();
    const projected = projectForPlayer(state, BOB);
    const map = fullMapOf(projected);
    expect(map.tokens.map((t) => t.id)).toEqual(["tok-open"]);
    expect(map.images.map((i) => i.id)).toEqual(["img-open"]);
  });

  it("hides other sheets by default but keeps the viewer's own with notes/hp", () => {
    const state = setupHiddenState();
    const projected = projectForPlayer(state, ALICE);
    expect(Object.keys(projected.sheets).sort()).toEqual(["sheet-alice"]);
    expect(projected.sheets["sheet-alice"].notes).toBe("alice secret notes");
    expect(projected.sheets["sheet-alice"].hp).toBe(20);
  });

  it("redacts notes/hp (but keeps the sheet) when playersCanSeeOtherSheets is true", () => {
    const state: DndMapperState = {
      ...setupHiddenState(),
      settings: { ...setupHiddenState().settings, playersCanSeeOtherSheets: true },
    };
    const projected = projectForPlayer(state, BOB);
    expect(Object.keys(projected.sheets).sort()).toEqual(["sheet-alice", "sheet-bob"]);
    expect(projected.sheets["sheet-alice"].notes).toBe("");
    expect(projected.sheets["sheet-alice"].hp).toBeNull();
    // Non-private fields survive redaction.
    expect(projected.sheets["sheet-alice"].maxHp).toBe(30);
    expect(projected.sheets["sheet-alice"].characterName).toBe("Alice");
    // Owner still sees their own private fields.
    expect(projected.sheets["sheet-bob"].notes).toBe("bob secret notes");
  });

  it("gates rolls on rollsVisibleToPlayers (DM always sees all)", () => {
    const hidden: DndMapperState = {
      ...setupHiddenState(),
      settings: { ...setupHiddenState().settings, rollsVisibleToPlayers: false },
    };
    expect(projectForPlayer(hidden, ALICE).rollLog.map((r) => r.id)).toEqual(["roll-alice"]);
    expect(projectForPlayer(hidden, BOB).rollLog.map((r) => r.id)).toEqual([]);
    expect(projectForPlayer(hidden, DM).rollLog.map((r) => r.id)).toEqual([
      "roll-alice",
      "roll-dm",
    ]);
    const open = setupHiddenState();
    expect(projectForPlayer(open, BOB).rollLog).toHaveLength(2);
  });

  it("strips hidden-token combatants and pendingInitiative for players", () => {
    const state = setupHiddenState();
    const combat = projectForPlayer(state, BOB).activeCombat;
    expect(combat?.turnOrder.map((c) => c.id)).toEqual(["c-open"]);
    expect(combat?.currentTurnIndex).toBe(0);
    const dmCombat = projectForPlayer(state, DM).activeCombat;
    expect(dmCombat?.turnOrder).toHaveLength(2);
    expect(dmCombat?.turnOrder[1].pendingInitiative).toBe(18);
  });

  it("gates loadedDiceRules when visibility is Hidden (DM keeps them)", () => {
    const state = setupHiddenState();
    expect(projectForPlayer(state, BOB).loadedDiceRules).toEqual([]);
    expect(projectForPlayer(state, DM).loadedDiceRules).toHaveLength(1);
    const visible: DndMapperState = {
      ...state,
      settings: { ...state.settings, loadedDiceRuleVisibility: "VisibleToAll" },
    };
    expect(projectForPlayer(visible, BOB).loadedDiceRules).toHaveLength(1);
  });

  it("projects a stranger (null playerId) with default-deny", () => {
    const state = setupHiddenState();
    const projected = projectForPlayer(state, null);
    expect(fullMapOf(projected).tokens.map((t) => t.id)).toEqual(["tok-open"]);
    expect(Object.keys(projected.sheets)).toEqual([]);
  });

  it("keeps fog broadcast (documented legacy leak)", () => {
    const map = fullMapOf(setupHiddenState());
    const state: DndMapperState = {
      ...setupHiddenState(),
      maps: [{ ...map, fogMask: "abcd" }],
    };
    expect(fullMapOf(projectForPlayer(state, BOB)).fogMask).toBe("abcd");
  });

  it("strips tokens on fogged cells for non-owners but keeps them for owner and DM", () => {
    // tok-open (owned by ALICE) sits at (1.5, 1.5) → cell (1, 1). Fog it.
    const map = fullMapOf(setupHiddenState());
    const mask = setCellFogged(new Uint8Array(0), map.grid, 1, 1, true);
    const state: DndMapperState = {
      ...setupHiddenState(),
      maps: [{ ...map, fogMask: encodeFog(mask) }],
    };
    // BOB owns nothing here: sees no tokens.
    expect(fullMapOf(projectForPlayer(state, BOB)).tokens).toEqual([]);
    // Owner still sees their token under fog.
    expect(fullMapOf(projectForPlayer(state, ALICE)).tokens.map((t) => t.id)).toEqual([
      "tok-open",
    ]);
    // DM sees the full truth.
    expect(fullMapOf(projectForPlayer(state, DM)).tokens.map((t) => t.id)).toEqual([
      "tok-open",
      "tok-hidden",
    ]);
    // Fog mask itself still broadcasts.
    expect(fullMapOf(projectForPlayer(state, BOB)).fogMask).toBe(encodeFog(mask));
  });

  it("drops fog-stripped combatants from the turn order for non-owners", () => {
    const map = fullMapOf(setupHiddenState());
    const mask = setCellFogged(new Uint8Array(0), map.grid, 1, 1, true);
    const state: DndMapperState = {
      ...setupHiddenState(),
      maps: [{ ...map, fogMask: encodeFog(mask) }],
    };
    expect(projectForPlayer(state, BOB).activeCombat?.turnOrder).toEqual([]);
    expect(
      projectForPlayer(state, ALICE).activeCombat?.turnOrder.map((c) => c.id),
    ).toEqual(["c-open"]);
  });

  it("keeps tokens on revealed cells visible to everyone", () => {
    const state = setupHiddenState();
    expect(fullMapOf(projectForPlayer(state, BOB)).tokens.map((t) => t.id)).toEqual([
      "tok-open",
    ]);
  });

  it("leak test: guest snapshot contains no hidden bytes and is strict-JSON", () => {
    const state = setupHiddenState();
    const projected = projectForPlayer(state, BOB);
    const bytes = JSON.stringify(projected);
    expect(bytes).not.toContain("tok-hidden");
    expect(bytes).not.toContain("Secret Assassin");
    expect(bytes).not.toContain("img-hidden");
    expect(bytes).not.toContain("alice secret notes");
    expect(bytes).not.toContain("sheet-orphan");
    expect(bytes).not.toContain("Force Nat 20");
    // Strict JSON round-trip.
    expect(JSON.parse(bytes)).toEqual(projected);
    // Per-recipient guardSize passes on the projected snapshot.
    expect(guardSize({ kind: "full", state: projected })).not.toBeNull();
  });
});

describe("projectPatchForPlayer", () => {
  it("passes every patch through unchanged for the DM", () => {
    const state = setupHiddenState();
    const patches: Patch[] = [
      { kind: "token", token: makeToken({ id: "tok-hidden", hidden: true }) },
      { kind: "sheet", sheet: makeSheet({ id: "s" }) },
      { kind: "roll", roll: makeRoll({ id: "r", rollerUserId: ALICE }) },
      { kind: "fog", mapId: "map-1", mask: "xx" },
    ];
    for (const patch of patches) {
      expect(projectPatchForPlayer(patch, DM, state)).toBe(patch);
    }
  });

  it("tombstones hidden tokens: tokenRemoved for haves, null for have-nots", () => {
    const prev = setupHiddenState();
    const map = fullMapOf(prev);
    const hidden: DndMapperState = {
      ...prev,
      maps: [
        {
          ...map,
          tokens: map.tokens.map((t) => (t.id === "tok-open" ? { ...t, hidden: true } : t)),
        },
      ],
    };
    const patch: Patch = {
      kind: "token",
      token: { ...makeToken({ id: "tok-open" }), hidden: true },
    };
    // BOB had the token while visible → tombstone.
    expect(projectPatchForPlayer(patch, BOB, hidden, prev)).toEqual({
      kind: "tokenRemoved",
      tokenId: "tok-open",
    });
    // A token hidden in both states was never had → null.
    const alreadyHidden: Patch = {
      kind: "token",
      token: { ...makeToken({ id: "tok-hidden" }), hidden: true },
    };
    expect(projectPatchForPlayer(alreadyHidden, BOB, hidden, prev)).toBeNull();
    // Visible tokens pass through.
    const visible: Patch = { kind: "token", token: makeToken({ id: "tok-open" }) };
    expect(projectPatchForPlayer(visible, BOB, prev, prev)).toBe(visible);
  });

  it("tombstones hidden images the same way", () => {
    const prev = setupHiddenState();
    const map = fullMapOf(prev);
    const hidden: DndMapperState = {
      ...prev,
      maps: [
        {
          ...map,
          images: map.images.map((i) => (i.id === "img-open" ? { ...i, hidden: true } : i)),
        },
      ],
    };
    const patch: Patch = {
      kind: "image",
      image: { ...makeImage({ id: "img-open" }), hidden: true },
    };
    expect(projectPatchForPlayer(patch, BOB, hidden, prev)).toEqual({
      kind: "imageRemoved",
      imageId: "img-open",
    });
    const alreadyHidden: Patch = {
      kind: "image",
      image: { ...makeImage({ id: "img-hidden" }), hidden: true },
    };
    expect(projectPatchForPlayer(alreadyHidden, BOB, hidden, prev)).toBeNull();
  });

  it("maps sheets to sheetRemoved / redacted / as-is", () => {
    const state = setupHiddenState();
    const alice = state.sheets["sheet-alice"];
    // Stranger cannot view → sheetRemoved.
    expect(projectPatchForPlayer({ kind: "sheet", sheet: alice }, BOB, state)).toEqual({
      kind: "sheetRemoved",
      sheetId: "sheet-alice",
    });
    // Owner sees it unchanged.
    const ownerPatch: Patch = { kind: "sheet", sheet: alice };
    expect(projectPatchForPlayer(ownerPatch, ALICE, state)).toBe(ownerPatch);
    // Visible-to-all stranger gets redaction.
    const open: DndMapperState = {
      ...state,
      settings: { ...state.settings, playersCanSeeOtherSheets: true },
    };
    const redacted = projectPatchForPlayer({ kind: "sheet", sheet: alice }, BOB, open);
    expect(redacted?.kind).toBe("sheet");
    if (redacted?.kind === "sheet") {
      expect(redacted.sheet.notes).toBe("");
      expect(redacted.sheet.hp).toBeNull();
    }
  });

  it("suppresses rolls the viewer may not see", () => {
    const state: DndMapperState = {
      ...setupHiddenState(),
      settings: { ...setupHiddenState().settings, rollsVisibleToPlayers: false },
    };
    const aliceRoll: Patch = { kind: "roll", roll: makeRoll({ id: "r", rollerUserId: ALICE }) };
    expect(projectPatchForPlayer(aliceRoll, BOB, state)).toBeNull();
    expect(projectPatchForPlayer(aliceRoll, ALICE, state)).toBe(aliceRoll);
  });

  it("projects full/map/combat/loadedDice patches and passes the rest through", () => {
    const state = setupHiddenState();
    const full = projectPatchForPlayer({ kind: "full", state }, BOB, state);
    expect(full?.kind).toBe("full");
    if (full?.kind === "full") {
      expect(fullMapOf(full.state).tokens.map((t) => t.id)).toEqual(["tok-open"]);
    }
    const mapPatch = projectPatchForPlayer(
      { kind: "map", map: fullMapOf(state) },
      BOB,
      state,
    );
    expect(mapPatch?.kind).toBe("map");
    if (mapPatch?.kind === "map" && "tokens" in mapPatch.map) {
      expect(mapPatch.map.tokens.map((t) => t.id)).toEqual(["tok-open"]);
    }
    const combat: CombatState = setupHiddenState().activeCombat!;
    const projectedCombat = projectPatchForPlayer({ kind: "combat", combat }, BOB, state);
    expect(projectedCombat?.kind).toBe("combat");
    if (projectedCombat?.kind === "combat") {
      expect(projectedCombat.combat?.turnOrder.map((c) => c.id)).toEqual(["c-open"]);
    }
    const dice: Patch = { kind: "loadedDiceRules", rules: state.loadedDiceRules };
    const gated = projectPatchForPlayer(dice, BOB, state);
    expect(gated).toEqual({ kind: "loadedDiceRules", rules: [] });
    // Passthrough kinds broadcast as-is.
    const fog: Patch = { kind: "fog", mapId: "map-1", mask: "xx" };
    expect(projectPatchForPlayer(fog, BOB, state)).toBe(fog);
    const removed: Patch = { kind: "tokenRemoved", tokenId: "tok-hidden" };
    expect(projectPatchForPlayer(removed, BOB, state)).toBe(removed);
  });

  it("tombstones tokens that move onto fog for non-owners", () => {
    const prev = setupHiddenState();
    const map = fullMapOf(prev);
    const mask = setCellFogged(new Uint8Array(0), map.grid, 1, 1, true);
    const fogged: DndMapperState = {
      ...prev,
      maps: [{ ...map, fogMask: encodeFog(mask) }],
    };
    // tok-open (ALICE's) slides onto its own fogged cell — same position, fog added.
    const moved: Patch = { kind: "token", token: makeToken({ id: "tok-open" }) };
    // BOB knew it before → tombstone so his client removes it.
    expect(projectPatchForPlayer(moved, BOB, fogged, prev)).toEqual({
      kind: "tokenRemoved",
      tokenId: "tok-open",
    });
    // Owner still receives the live token.
    expect(projectPatchForPlayer(moved, ALICE, fogged, prev)).toBe(moved);
    // Already fog-hidden in both states → null (never had it).
    expect(projectPatchForPlayer(moved, BOB, fogged, fogged)).toBeNull();
    // Map patches strip fogged foreign tokens too.
    const mapPatch = projectPatchForPlayer({ kind: "map", map: fullMapOf(fogged) }, BOB, fogged);
    expect(mapPatch?.kind).toBe("map");
    if (mapPatch?.kind === "map" && "tokens" in mapPatch.map) {
      expect(mapPatch.map.tokens).toEqual([]);
    }
    // Combat patches drop fog-stripped combatants for non-owners.
    const combatPatch = projectPatchForPlayer(
      { kind: "combat", combat: fogged.activeCombat },
      BOB,
      fogged,
    );
    expect(combatPatch?.kind).toBe("combat");
    if (combatPatch?.kind === "combat") {
      expect(combatPatch.combat?.turnOrder).toEqual([]);
    }
  });

  it("per-recipient guardSize passes on projected patches", () => {
    const state = setupHiddenState();
    const patches: Array<Patch | null> = [
      projectPatchForPlayer({ kind: "full", state }, BOB, state),
      projectPatchForPlayer(
        { kind: "sheet", sheet: state.sheets["sheet-alice"] },
        ALICE,
        state,
      ),
      projectPatchForPlayer(
        { kind: "roll", roll: makeRoll({ id: "r", rollerUserId: ALICE }) },
        ALICE,
        state,
      ),
    ];
    for (const patch of patches) {
      expect(patch).not.toBeNull();
      expect(guardSize(patch!)).not.toBeNull();
    }
  });
});
