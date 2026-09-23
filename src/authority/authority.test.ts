/*
 * Tier 1 of the KnockBox local dev loop: the authority module as a pure unit,
 * with no server, no network and no Phaser. Feed intents, assert patches.
 */

import { describe, expect, it } from "vitest";
import { config, createAuthority } from "./authority";
import { createFakeKb } from "./fakeKb";
import type { FakeKb } from "./fakeKb";
import type { Authority } from "./kb";
import type { CharacterSheet, GameMap, GridConfig, MapImage, Token } from "../game/domain";
import { isFullMap } from "../game/domain";
import { encodeFog, fillFog } from "../game/fog";
import { utf8Length } from "../game/wire";
import { MAX_FRAME_BYTES } from "../game/types";

const ROSTER = [
  { id: "dm-1", displayName: "Dungeon Master" },
  { id: "player-1", displayName: "Alice" },
  { id: "player-2", displayName: "Bob" },
];

function started(): { kb: FakeKb; authority: Authority } {
  const kb = createFakeKb();
  const authority = createAuthority(kb);
  authority.init(ROSTER);
  return { kb, authority };
}

describe("module contract", () => {
  it("exports a createAuthority function", () => {
    expect(typeof createAuthority).toBe("function");
  });

  it("exports a well-formed config", () => {
    expect(config).toBeTypeOf("object");
    expect(Array.isArray(config)).toBe(false);
    if (config.perRecipient !== undefined) expect(config.perRecipient).toBeTypeOf("boolean");
    if (config.tickHz !== undefined) {
      expect(Number.isFinite(config.tickHz)).toBe(true);
      expect(config.tickHz).toBeGreaterThanOrEqual(0);
    }
  });

  it("declares no tick, so the server creates no timer", () => {
    const { authority } = started();
    expect(authority.tick).toBeUndefined();
  });

  it("implements the three required hooks", () => {
    const { authority } = started();
    expect(authority.init).toBeTypeOf("function");
    expect(authority.applyIntent).toBeTypeOf("function");
    expect(authority.snapshot).toBeTypeOf("function");
  });
});

describe("init & DM election", () => {
  it("elects players[0] as DM and records it in state", () => {
    const { kb, authority } = started();
    const snapshot = authority.snapshot(null);
    expect(snapshot.dmPlayerId).toBe("dm-1");
    expect(kb.logs.some((l) => l.startsWith("info:"))).toBe(true);
  });
});

describe("applyIntent & size guardrails", () => {
  it("returns a narrowed absolute patch for a legal intent", () => {
    const { authority } = started();
    const patch = authority.applyIntent("dm-1", { kind: "createMap", name: "Level 1" });
    expect(patch).not.toBeNull();
    expect(patch?.kind).toBe("map");
  });

  it("returns null for an illegal intent and changes nothing", () => {
    const { authority } = started();
    // Non-DM cannot create maps
    expect(authority.applyIntent("player-1", { kind: "createMap", name: "Hack" })).toBeNull();
    expect(authority.snapshot(null).maps).toHaveLength(0);
  });

  it("drops oversized patches and logs loudly via kb.log.error", () => {
    const { kb, authority } = started();
    // Create map with giant name that produces a patch over MAX_FRAME_BYTES (400 KB)
    const giantName = "X".repeat(MAX_FRAME_BYTES + 2000);
    const res = authority.applyIntent("dm-1", { kind: "createMap", name: giantName });
    expect(res).toBeNull(); // dropped by authority size guard
    expect(kb.logs.some((l) => l.startsWith("error:") && l.includes("refusing to broadcast"))).toBe(
      true,
    );
  });
});

describe("roster hooks & DM succession", () => {
  it("promotes the next longest-standing player when the DM leaves", () => {
    const { kb, authority } = started();
    expect(authority.snapshot(null).dmPlayerId).toBe("dm-1");

    // DM drops
    const patch = authority.onPlayerLeft?.("dm-1");
    expect(kb.owner).toBe("player-1");
    expect(patch).toEqual({ kind: "dm", dmPlayerId: "player-1" });
    expect(authority.snapshot(null).dmPlayerId).toBe("player-1");
  });

  it("does not reassign DM when a non-DM leaves", () => {
    const { kb, authority } = started();
    authority.onPlayerLeft?.("player-1");
    expect(kb.owner).toBeNull();
    expect(authority.snapshot(null).dmPlayerId).toBe("dm-1");
  });

  it("sets dmPlayerId to null when the last player leaves", () => {
    const { authority } = started();
    authority.onPlayerLeft?.("player-2");
    authority.onPlayerLeft?.("player-1");
    authority.onPlayerLeft?.("dm-1");
    expect(authority.snapshot(null).dmPlayerId).toBeNull();
  });
});

describe("wire fidelity", () => {
  it("snapshot survives a JSON round-trip unchanged", () => {
    const { authority } = started();
    authority.applyIntent("dm-1", { kind: "createMap", name: "Catacombs" });
    const snapshot = authority.snapshot(null);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("patches survive a JSON round-trip unchanged", () => {
    const { authority } = started();
    const patch = authority.applyIntent("dm-1", { kind: "createMap", name: "Catacombs" });
    expect(JSON.parse(JSON.stringify(patch))).toEqual(patch);
  });

  it("never puts undefined in state", () => {
    const { authority } = started();
    expect(JSON.stringify(authority.snapshot(null))).not.toContain("undefined");
  });
});

describe("snapshot-size budget test (worst-case campaign)", () => {
  /**
   * Builds a realistic heavy map:
   *   - 200×200 grid (40,000 cells)
   *   - Fully packed fog mask (~6.7 KB base64)
   *   - 60 tokens (~12 KB JSON)
   *   - 40 image records (~14 KB JSON)
   * Total for 1 map = ~33 KB.
   */
  function buildHeavyMap(id: string, name: string): GameMap {
    const grid: GridConfig = {
      widthCells: 200,
      heightCells: 200,
      cellPixels: 50,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222222",
    };

    const fogMask = encodeFog(fillFog(grid));

    const tokens: Token[] = [];
    for (let i = 0; i < 6; i++) {
      tokens.push({
        id: `token-${id}-${i}`,
        type: i % 2 === 0 ? "PlayerToken" : "NPCToken",
        ownerUserId: i % 2 === 0 ? "player-1" : null,
        representsUserId: null,
        name: `Creature ${i} of Map ${name} with long descriptive title`,
        color: "#e63946",
        iconKind: "Initial",
        mapId: id,
        x: (i % 200) + 0.5,
        y: Math.floor(i / 200) + 0.5,
        sheetId: `sheet-${id}-${i}`,
        hidden: i % 5 === 0,
      });
    }

    const images: MapImage[] = [];
    for (let i = 0; i < 40; i++) {
      images.push({
        id: `img-${id}-${i}`,
        name: `Dungeon Terrain Texture Overlay Chunk ${i} High Resolution`,
        contentType: "image/webp",
        shareToken: `token-${id}-${i}-sha256-blob-handle-placeholder`,
        x: (i * 5) % 200,
        y: (i * 5) % 200,
        width: 10,
        height: 10,
        originalWidth: 10,
        originalHeight: 10,
        rotation: (i * 15) % 360,
        opacity: 0.95,
        layerOrder: i,
        locked: true,
        hidden: false,
        byteSize: 524288,
        wasDownscaled: true,
        originalLongEdgePx: 4096,
        displayLongEdgePx: 2048,
      });
    }

    return {
      id,
      name,
      grid,
      images,
      tokens,
      createdUtc: "2026-09-08T12:00:00.000Z",
      listOrder: 0,
      defaultSpawnPosition: { x: 10.5, y: 10.5 },
      markupSvg: null,
      fogMask,
    };
  }

  it("proves fixture size would exceed 512 KiB without narrowing, but snapshot fits under budget", () => {
    const { authority } = started();

    // 24 realistic heavy maps: 24 × ~33 KB = ~790 KB
    const maps: GameMap[] = [];
    for (let i = 0; i < 24; i++) {
      maps.push(buildHeavyMap(`heavy-map-${i}`, `Massive Dungeon Level ${i}`));
    }

    // N:1 binding: every token ships its character sheet, so the commit
    // backfill synthesizes nothing and the frame stays small.
    const sheets: Record<string, CharacterSheet> = {};
    for (const map of maps) {
      for (const tok of map.tokens) {
        if (!tok.sheetId) continue;
        sheets[tok.sheetId] = {
          id: tok.sheetId,
          ownerUserId: tok.ownerUserId,
          representsUserId: null,
          characterName: tok.name,
          values: {},
          notes: "",
          hp: null,
          maxHp: null,
          armorClass: null,
          color: tok.color,
          colorOverridden: true,
          scopedMapId: null,
          statusEffects: [],
          rollTemplates: [],
        };
      }
    }

    // Stage campaign into authority via chunked import
    const token = "budget-import";
    authority.applyIntent("dm-1", {
      kind: "beginImport",
      token,
      campaign: { title: "Huge 24-Map Campaign", activeMapId: maps[0].id, sheets },
      chunkCount: 24,
    });

    for (let i = 0; i < 24; i++) {
      authority.applyIntent("dm-1", {
        kind: "importChunk",
        token,
        index: i,
        maps: [maps[i]],
      });
    }

    const commitPatch = authority.applyIntent("dm-1", {
      kind: "commitImport",
      token,
    });
    expect(commitPatch).not.toBeNull();

    // 1. ASSERT UN-NARROWED STATE FAILS:
    // If we were broadcasting all 24 full maps, it would exceed 512 KiB (524,288 bytes)
    const unNarrowedState = {
      ...authority.snapshot(null),
      maps, // all 24 full maps
    };
    const unNarrowedBytes = utf8Length(JSON.stringify(unNarrowedState));
    expect(unNarrowedBytes).toBeGreaterThan(524_288); // Exceeds 512 KiB!

    // 2. ASSERT NARROWED SNAPSHOT PASSES:
    // With active-map-only narrowing, snapshot fits comfortably within the 400 KB guardrail
    const snapshot = authority.snapshot(null);
    expect(snapshot.maps).toHaveLength(24);

    // Active map is full
    const activeMap = snapshot.maps.find((m) => m.id === maps[0].id)!;
    expect(isFullMap(activeMap)).toBe(true);

    // Inactive maps are summaries
    const inactiveMaps = snapshot.maps.filter((m) => m.id !== maps[0].id);
    expect(inactiveMaps).toHaveLength(23);
    for (const inact of inactiveMaps) {
      expect(isFullMap(inact)).toBe(false);
    }

    const snapshotBytes = utf8Length(JSON.stringify(snapshot));
    expect(snapshotBytes).toBeLessThan(MAX_FRAME_BYTES); // < 400,000 bytes
    expect(snapshotBytes).toBeLessThan(100_000); // In fact only ~35-40 KB!
  });
});
