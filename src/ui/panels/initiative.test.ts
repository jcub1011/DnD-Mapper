// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { CharacterSheet, GameMap, Token } from "../../game/domain.js";
import "./dndm-host-initiative.js";
import type { DndmHostInitiative } from "./dndm-host-initiative.js";
import "./dndm-initiative-banner.js";
import type { DndmInitiativeBanner } from "./dndm-initiative-banner.js";

function makeMap(tokens: Token[] = []): GameMap {
  return {
    id: "map-1",
    name: "Dungeon",
    grid: {
      widthCells: 20,
      heightCells: 20,
      cellPixels: 50,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    },
    images: [],
    tokens,
    createdUtc: new Date().toISOString(),
    listOrder: 0,
    defaultSpawnPosition: null,
    markupSvg: null,
    fogMask: "",
  };
}

describe("<dndm-host-initiative>", () => {
  it("renders empty state with Start Combat Encounter button for DM", async () => {
    const el = document.createElement("dndm-host-initiative") as DndmHostInitiative;
    const onStart = vi.fn();
    el.combat = null;
    el.activeMap = makeMap();
    el.isDm = true;
    el.onStartCombat = onStart;
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.innerHTML).toContain("No encounter currently running");
    const startBtn = el.querySelector<HTMLButtonElement>("button.dndm-btn--primary");
    expect(startBtn).not.toBeNull();
    startBtn!.click();
    expect(onStart).toHaveBeenCalledWith("map-1");

    el.remove();
  });

  it("renders WaitingForRolls state with NPC roll action", async () => {
    const el = document.createElement("dndm-host-initiative") as DndmHostInitiative;
    const onRollAllNpcs = vi.fn();
    el.combat = {
      phase: "WaitingForRolls",
      roundNumber: 1,
      currentTurnIndex: 0,
      turnOrder: [
        {
          id: "c-1",
          tokenId: "tok-1",
          name: "Goblin",
          ownerUserId: null,
          initiativeRoll: null,
          isForceRolled: false,
          pendingInitiative: null,
        },
      ],
    };
    el.activeMap = makeMap();
    el.isDm = true;
    el.onRollAllUnsetNpcs = onRollAllNpcs;
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.textContent).toContain("Rolling Initiative");
    expect(el.textContent).toContain("Goblin");
    const rollNpcsBtn = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Roll All Unset NPCs"),
    );
    expect(rollNpcsBtn).toBeDefined();
    rollNpcsBtn!.click();
    expect(onRollAllNpcs).toHaveBeenCalled();

    el.remove();
  });

  it("renders Active state, highlights active combatant, and handles turn buttons", async () => {
    const el = document.createElement("dndm-host-initiative") as DndmHostInitiative;
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onFocus = vi.fn();

    const token1: Token = {
      id: "tok-1",
      type: "PlayerToken",
      name: "Valeros",
      color: "#f00",
      iconKind: "Initial",
      mapId: "map-1",
      x: 2.5,
      y: 3.5,
      sheetId: "sheet-1",
      hidden: false,
      ownerUserId: "u1",
      representsUserId: null,
    };
    const sheet1: CharacterSheet = {
      id: "sheet-1",
      ownerUserId: "u1",
      representsUserId: null,
      characterName: "Valeros",
      values: {},
      notes: "",
      hp: 25,
      maxHp: 30,
      armorClass: 16,
      color: "#f00",
      scopedMapId: null,
      statusEffects: [{ id: "e1", name: "Blessed", appliedUtc: "", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "" }],
      rollTemplates: [],
    };

    el.combat = {
      phase: "Active",
      roundNumber: 2,
      currentTurnIndex: 0,
      turnOrder: [
        {
          id: "c-1",
          tokenId: "tok-1",
          name: "Valeros",
          ownerUserId: "u1",
          initiativeRoll: 19,
          isForceRolled: false,
          pendingInitiative: null,
        },
        {
          id: "c-2",
          tokenId: "tok-2",
          name: "Goblin",
          ownerUserId: null,
          initiativeRoll: 11,
          isForceRolled: false,
          pendingInitiative: null,
        },
      ],
    };
    el.activeMap = makeMap([token1]);
    el.sheets = { "sheet-1": sheet1 };
    el.isDm = true;
    el.onNextTurn = onNext;
    el.onPreviousTurn = onPrev;
    el.onFocusToken = onFocus;
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.textContent).toContain("Round 2");
    expect(el.textContent).toContain("Valeros");
    expect(el.textContent).toContain("AC 16");
    expect(el.textContent).toContain("Blessed");

    // Active highlight
    const cards = el.querySelectorAll(".dndm-combatant-card");
    expect(cards[0].classList.contains("dndm-combatant-card--active")).toBe(true);
    expect(cards[1].classList.contains("dndm-combatant-card--active")).toBe(false);

    // Clicking row triggers focus
    (cards[0] as HTMLElement).click();
    expect(onFocus).toHaveBeenCalledWith("tok-1");

    // Next turn button
    const nextBtn = el.querySelector<HTMLButtonElement>("button[title*='Next Turn']");
    expect(nextBtn).not.toBeNull();
    nextBtn!.click();
    expect(onNext).toHaveBeenCalled();

    // Prev turn button
    const prevBtn = el.querySelector<HTMLButtonElement>("button[title*='Previous Turn']");
    expect(prevBtn).not.toBeNull();
    prevBtn!.click();
    expect(onPrev).toHaveBeenCalled();

    el.remove();
  });
});

describe("<dndm-initiative-banner>", () => {
  it("displays Roll Initiative button when player has unrolled combatant", async () => {
    const el = document.createElement("dndm-initiative-banner") as DndmInitiativeBanner;
    const onRoll = vi.fn();
    el.currentUserId = "player-alice";
    el.combat = {
      phase: "WaitingForRolls",
      roundNumber: 1,
      currentTurnIndex: 0,
      turnOrder: [
        {
          id: "c-alice",
          tokenId: "tok-alice",
          name: "Alice",
          ownerUserId: "player-alice",
          initiativeRoll: null,
          isForceRolled: false,
          pendingInitiative: null,
        },
        {
          id: "c-bob",
          tokenId: "tok-bob",
          name: "Bob",
          ownerUserId: "player-bob",
          initiativeRoll: 14,
          isForceRolled: false,
          pendingInitiative: null,
        },
      ],
    };
    el.onRollInitiative = onRoll;
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.innerHTML).toContain("Roll Initiative!");
    const rollBtn = el.querySelector<HTMLButtonElement>("button");
    expect(rollBtn).not.toBeNull();
    rollBtn!.click();
    expect(onRoll).toHaveBeenCalledWith("c-alice");

    el.remove();
  });

  it("displays waiting message if current user already rolled or is DM", async () => {
    const el = document.createElement("dndm-initiative-banner") as DndmInitiativeBanner;
    el.currentUserId = "player-bob";
    el.combat = {
      phase: "WaitingForRolls",
      roundNumber: 1,
      currentTurnIndex: 0,
      turnOrder: [
        {
          id: "c-bob",
          tokenId: "tok-bob",
          name: "Bob",
          ownerUserId: "player-bob",
          initiativeRoll: 14,
          isForceRolled: false,
          pendingInitiative: null,
        },
      ],
    };
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.innerHTML).toContain("Waiting for initiative rolls");

    el.remove();
  });

  it("displays YOUR TURN! when local user is active", async () => {
    const el = document.createElement("dndm-initiative-banner") as DndmInitiativeBanner;
    const onFocus = vi.fn();
    el.currentUserId = "player-alice";
    el.combat = {
      phase: "Active",
      roundNumber: 1,
      currentTurnIndex: 0,
      turnOrder: [
        {
          id: "c-alice",
          tokenId: "tok-alice",
          name: "Alice",
          ownerUserId: "player-alice",
          initiativeRoll: 18,
          isForceRolled: false,
          pendingInitiative: null,
        },
        {
          id: "c-bob",
          tokenId: "tok-bob",
          name: "Bob",
          ownerUserId: "player-bob",
          initiativeRoll: 12,
          isForceRolled: false,
          pendingInitiative: null,
        },
      ],
    };
    el.onFocusToken = onFocus;
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.textContent).toContain("YOUR TURN!");
    expect(el.textContent).toContain("Up Next: Bob");
    const banner = el.querySelector(".dndm-initiative-banner");
    expect(banner?.classList.contains("dndm-initiative-banner--my-turn")).toBe(true);

    (banner as HTMLElement).click();
    expect(onFocus).toHaveBeenCalledWith("tok-alice");

    el.remove();
  });

  it("displays combatant turn name when another player is active", async () => {
    const el = document.createElement("dndm-initiative-banner") as DndmInitiativeBanner;
    el.currentUserId = "player-alice";
    el.combat = {
      phase: "Active",
      roundNumber: 3,
      currentTurnIndex: 1,
      turnOrder: [
        {
          id: "c-alice",
          tokenId: "tok-alice",
          name: "Alice",
          ownerUserId: "player-alice",
          initiativeRoll: 18,
          isForceRolled: false,
          pendingInitiative: null,
        },
        {
          id: "c-bob",
          tokenId: "tok-bob",
          name: "Bob",
          ownerUserId: "player-bob",
          initiativeRoll: 12,
          isForceRolled: false,
          pendingInitiative: null,
        },
      ],
    };
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.textContent).toContain("Bob's Turn");
    expect(el.textContent).toContain("Round 3");
    expect(el.textContent).toContain("Up Next: Alice");

    el.remove();
  });
});
