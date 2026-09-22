import { describe, expect, it } from "vitest";
import type {
  CharacterSheet,
  DndMapperState,
  GameMap,
  RollResult,
  Token,
} from "../game/domain.js";
import {
  createDefaultDndMapperState,
  createDefaultGridConfig,
} from "../game/domain.js";
import { encodeFog } from "../game/fog.js";
import { projectSnapshot } from "../game/rules.js";

function makeStressCampaign(): DndMapperState {
  const base = createDefaultDndMapperState();

  // 1. Generate 24 maps
  const maps: GameMap[] = [];
  const mapCount = 24;

  for (let m = 0; m < mapCount; m++) {
    const mapId = `map-${m.toString().padStart(2, "0")}`;
    const widthCells = 40;
    const heightCells = 40;

    // Active map has 100 tokens and 50% fogged cells
    const isMain = m === 0;
    const fogGrid = new Uint8Array(widthCells * heightCells);
    if (isMain) {
      for (let f = 0; f < fogGrid.length; f += 2) {
        fogGrid[f] = 1;
      }
    }
    const fogMask = encodeFog(fogGrid);

    const tokens: Token[] = [];
    if (isMain) {
      for (let t = 0; t < 100; t++) {
        tokens.push({
          id: `tok-${t.toString().padStart(3, "0")}`,
          type: t < 10 ? "PlayerToken" : "NPCToken",
          ownerUserId: t < 10 ? `user-${t}` : null,
          representsUserId: null,
          name: `Creature / Adventurer ${t}`,
          color: t < 10 ? "#3498db" : "#e74c3c",
          iconKind: t % 2 === 0 ? "Initial" : "Solid",
          mapId,
          x: (t % 20) + 0.5,
          y: Math.floor(t / 20) + 0.5,
          sheetId: t < 50 ? `sheet-${t.toString().padStart(2, "0")}` : null,
          hidden: t % 4 === 0,
        });
      }
    }

    maps.push({
      id: mapId,
      name: `Dungeon Chamber ${m + 1} - Lower Depths`,
      grid: {
        ...createDefaultGridConfig(),
        cellPixels: 50,
        widthCells,
        heightCells,
      },
      images: isMain
        ? [
            {
              id: "bg-01",
              name: "Battlefield Background",
              contentType: "image/png",
              shareToken: null,
              x: 0,
              y: 0,
              width: 2000,
              height: 2000,
              originalWidth: 2000,
              originalHeight: 2000,
              rotation: 0,
              layerOrder: 0,
              opacity: 1,
              hidden: false,
              locked: true,
              byteSize: 50000,
              wasDownscaled: false,
              originalLongEdgePx: 2000,
              displayLongEdgePx: 2000,
            },
          ]
        : [],
      tokens,
      createdUtc: "2026-09-08T00:00:00.000Z",
      listOrder: m,
      defaultSpawnPosition: { x: 5, y: 5 },
      markupSvg: null,
      fogMask,
    });
  }

  // 2. Generate 50 character sheets
  const sheets: Record<string, CharacterSheet> = {};
  for (let s = 0; s < 50; s++) {
    const sheetId = `sheet-${s.toString().padStart(2, "0")}`;
    sheets[sheetId] = {
      id: sheetId,
      characterName: `Hero ${s} of Neverwinter`,
      ownerUserId: s < 10 ? `user-${s}` : null,
      representsUserId: null,
      color: "#2ecc71",
      colorOverridden: false,
      scopedMapId: null,
      hp: 35 + s,
      maxHp: 40 + s,
      armorClass: 14 + (s % 5),
      notes: "A valiant combatant skilled in martial arts and dungeon survival.\nPossesses multiple spells and enchanted gear.",
      values: {
        STR: { kind: "Score", value: 16 },
        DEX: { kind: "Score", value: 14 },
        CON: { kind: "Score", value: 15 },
        INT: { kind: "Score", value: 10 },
        WIS: { kind: "Score", value: 12 },
        CHA: { kind: "Score", value: 8 },
        Athletics: { kind: "Modifier", value: 5 },
        Perception: { kind: "Modifier", value: 3 },
      },
      statusEffects: [
        {
          id: `eff-${s}`,
          name: "Blessed",
          appliedUtc: "2026-09-08T00:00:00.000Z",
          attributeDeltas: [],
          maxHpDelta: null,
          onApplyHpDelta: null,
          notes: "+1d4 to attack rolls and saves",
        },
      ],
      rollTemplates: [],
    };
  }

  // 3. Generate 50 roll log entries
  const rollLog: RollResult[] = [];
  for (let r = 0; r < 50; r++) {
    rollLog.push({
      id: `roll-${r.toString().padStart(3, "0")}`,
      rollerUserId: `user-${r % 10}`,
      forcedByUserId: null,
      rolls: [{ sides: 20, value: 13 }],
      formula: "1d20+5",
      flatModifier: 5,
      attributeModifier: 0,
      modifierBreakdown: "+5",
      total: 18,
      timestampUtc: "2026-09-08T00:00:00.000Z",
      mode: "Normal",
      label: "Attack Roll",
      tokenId: null,
      appliedRules: [],
    });
  }

  return {
    ...base,
    phase: "Playing",
    activeMapId: "map-00",
    maps,
    sheets,
    rollLog,
    dmPlayerId: "user-dm",
  };
}

describe("Snapshot Bandwidth Budget (< 400 KiB)", () => {
  it("projects a massive 24-map, 50-sheet, 100-token campaign well within 400 KiB", () => {
    const stressState = makeStressCampaign();

    // Project active map snapshot as sent over the wire to peers
    const projected = projectSnapshot(stressState);

    // Serialize snapshot as JSON (as sent via WebSocket / message broker)
    const serialized = JSON.stringify(projected);
    const sizeBytes = new TextEncoder().encode(serialized).length;
    const sizeKiB = sizeBytes / 1024;

    // Must be under 400 KiB cap per Phase 11 specification
    expect(sizeKiB).toBeLessThan(400);

    // Verify projection invariants
    expect(projected.maps).toHaveLength(24);
    // Active map retained full tokens
    const activeMap = projected.maps[0] as GameMap;
    expect(activeMap.tokens).toHaveLength(100);

    // Inactive maps reduced to summaries without tokens or fog
    const inactiveSummary = projected.maps[1];
    expect("tokens" in inactiveSummary).toBe(false);
    expect("fogMask" in inactiveSummary).toBe(false);
  });
});
