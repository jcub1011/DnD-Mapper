import { describe, expect, it } from "vitest";
import {
  advanceTurn,
  findInsertionIndex,
  getInitiativeModifier,
  isAllRollsComplete,
  resolveActiveTurnTokenId,
  reverseTurn,
  sortTurnOrder,
} from "./combat";
import type { CharacterSheet, CombatantEntry, CombatState } from "./domain";

function makeCombatant(overrides: Partial<CombatantEntry>): CombatantEntry {
  return {
    id: "c-1",
    tokenId: "tok-1",
    name: "Hero",
    ownerUserId: "user-1",
    initiativeRoll: null,
    isForceRolled: false,
    pendingInitiative: null,
    ...overrides,
  };
}

describe("Combat Domain Helpers (Phase 9)", () => {
  describe("compareCombatants & sortTurnOrder", () => {
    it("sorts primarily descending by initiative roll", () => {
      const c1 = makeCombatant({ id: "1", name: "Low", initiativeRoll: 10 });
      const c2 = makeCombatant({ id: "2", name: "High", initiativeRoll: 20 });
      const c3 = makeCombatant({ id: "3", name: "Mid", initiativeRoll: 15 });

      const sorted = sortTurnOrder([c1, c2, c3]);
      expect(sorted.map((c) => c.name)).toEqual(["High", "Mid", "Low"]);
    });

    it("sinks null / unrolled combatants to the bottom", () => {
      const c1 = makeCombatant({ id: "1", name: "Unrolled", initiativeRoll: null });
      const c2 = makeCombatant({ id: "2", name: "Rolled-1", initiativeRoll: 1 });
      const c3 = makeCombatant({ id: "3", name: "Rolled-20", initiativeRoll: 20 });

      const sorted = sortTurnOrder([c1, c2, c3]);
      expect(sorted.map((c) => c.name)).toEqual(["Rolled-20", "Rolled-1", "Unrolled"]);
    });

    it("breaks ties with players before NPCs", () => {
      const npc = makeCombatant({
        id: "npc",
        name: "Goblin",
        ownerUserId: null,
        initiativeRoll: 15,
      });
      const player = makeCombatant({
        id: "pc",
        name: "Fighter",
        ownerUserId: "user-alice",
        initiativeRoll: 15,
      });

      const sorted = sortTurnOrder([npc, player]);
      expect(sorted[0].id).toBe("pc");
      expect(sorted[1].id).toBe("npc");
    });

    it("breaks secondary ties alphabetically by name", () => {
      const b = makeCombatant({
        id: "b",
        name: "Bob",
        ownerUserId: "u1",
        initiativeRoll: 15,
      });
      const a = makeCombatant({
        id: "a",
        name: "Alice",
        ownerUserId: "u2",
        initiativeRoll: 15,
      });
      const c = makeCombatant({
        id: "c",
        name: "Charlie",
        ownerUserId: "u3",
        initiativeRoll: 15,
      });

      const sorted = sortTurnOrder([b, c, a]);
      expect(sorted.map((item) => item.name)).toEqual(["Alice", "Bob", "Charlie"]);
    });
  });

  describe("findInsertionIndex", () => {
    it("finds correct position in sorted turn order", () => {
      const c1 = makeCombatant({ id: "1", name: "A", initiativeRoll: 20 });
      const c2 = makeCombatant({ id: "2", name: "B", initiativeRoll: 15 });
      const c3 = makeCombatant({ id: "3", name: "C", initiativeRoll: 10 });
      const turnOrder = [c1, c2, c3];

      const high = makeCombatant({ id: "h", name: "High", initiativeRoll: 25 });
      expect(findInsertionIndex(turnOrder, high)).toBe(0);

      const mid = makeCombatant({ id: "m", name: "Mid", initiativeRoll: 18 });
      expect(findInsertionIndex(turnOrder, mid)).toBe(1);

      const low = makeCombatant({ id: "l", name: "Low", initiativeRoll: 5 });
      expect(findInsertionIndex(turnOrder, low)).toBe(3);
    });
  });

  describe("isAllRollsComplete", () => {
    it("returns false if turnOrder is empty", () => {
      expect(isAllRollsComplete([])).toBe(false);
    });

    it("returns false if any combatant has null initiative", () => {
      const c1 = makeCombatant({ id: "1", initiativeRoll: 12 });
      const c2 = makeCombatant({ id: "2", initiativeRoll: null });
      expect(isAllRollsComplete([c1, c2])).toBe(false);
    });

    it("returns true if all combatants have non-null rolls", () => {
      const c1 = makeCombatant({ id: "1", initiativeRoll: 12 });
      const c2 = makeCombatant({ id: "2", initiativeRoll: 18 });
      expect(isAllRollsComplete([c1, c2])).toBe(true);
    });
  });

  describe("advanceTurn & reverseTurn", () => {
    const combat: CombatState = {
      phase: "Active",
      roundNumber: 1,
      currentTurnIndex: 0,
      turnOrder: [
        makeCombatant({ id: "1", tokenId: "tok-1", name: "First" }),
        makeCombatant({ id: "2", tokenId: "tok-2", name: "Second" }),
        makeCombatant({ id: "3", tokenId: "tok-3", name: "Third" }),
      ],
    };

    it("advanceTurn cycles index and increments roundNumber on wrap to 0", () => {
      const step1 = advanceTurn(combat);
      expect(step1.currentTurnIndex).toBe(1);
      expect(step1.roundNumber).toBe(1);

      const step2 = advanceTurn(step1);
      expect(step2.currentTurnIndex).toBe(2);
      expect(step2.roundNumber).toBe(1);

      const step3 = advanceTurn(step2);
      expect(step3.currentTurnIndex).toBe(0);
      expect(step3.roundNumber).toBe(2);
    });

    it("reverseTurn decrements index and decrements roundNumber (clamped to 1)", () => {
      // From round 2, turn 0 -> round 1, turn 2
      const round2Turn0: CombatState = {
        ...combat,
        roundNumber: 2,
        currentTurnIndex: 0,
      };

      const stepBack1 = reverseTurn(round2Turn0);
      expect(stepBack1.currentTurnIndex).toBe(2);
      expect(stepBack1.roundNumber).toBe(1);

      // From round 1, turn 0 -> round 1, turn 2 (clamped to min 1)
      const stepBack2 = reverseTurn(combat);
      expect(stepBack2.currentTurnIndex).toBe(2);
      expect(stepBack2.roundNumber).toBe(1);
    });

    it("handles empty turnOrder safely", () => {
      const empty: CombatState = {
        phase: "Active",
        roundNumber: 1,
        currentTurnIndex: 0,
        turnOrder: [],
      };
      expect(advanceTurn(empty)).toEqual(empty);
      expect(reverseTurn(empty)).toEqual(empty);
    });
  });

  describe("resolveActiveTurnTokenId", () => {
    it("returns active tokenId only when phase is Active", () => {
      const combat: CombatState = {
        phase: "Active",
        roundNumber: 1,
        currentTurnIndex: 1,
        turnOrder: [
          makeCombatant({ tokenId: "tok-a" }),
          makeCombatant({ tokenId: "tok-b" }),
        ],
      };

      expect(resolveActiveTurnTokenId(combat)).toBe("tok-b");
      expect(resolveActiveTurnTokenId({ ...combat, phase: "WaitingForRolls" })).toBeNull();
      expect(resolveActiveTurnTokenId(null)).toBeNull();
    });
  });

  describe("getInitiativeModifier", () => {
    it("resolves dexterity modifier by default", () => {
      const sheet: CharacterSheet = {
        id: "sheet-1",
        ownerUserId: "u1",
        representsUserId: null,
        characterName: "Hero",
        values: {
          Dexterity: { kind: "Score", value: 16 }, // (16-10)/2 = +3
        },
        notes: "",
        hp: 20,
        maxHp: 20,
        armorClass: 15,
        color: "#f00",
        scopedMapId: null,
        statusEffects: [],
        rollTemplates: [],
      };

      expect(getInitiativeModifier(sheet, null)).toBe(3);
    });

    it("returns 0 if sheet is null or attribute is missing", () => {
      expect(getInitiativeModifier(null, null)).toBe(0);
    });
  });
});
