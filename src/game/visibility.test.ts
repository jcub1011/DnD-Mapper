import { describe, expect, it } from "vitest";
import { createDefaultDndMapperState, type CharacterSheet, type Token } from "./domain.js";
import {
  canEditSheet,
  canMoveToken,
  filterSheetsForPlayer,
  filterTokensForPlayer,
  isDm,
  isSheetVisibleToPlayer,
  isTokenVisibleToPlayer,
} from "./visibility.js";

function makeToken(overrides?: Partial<Token>): Token {
  return {
    id: "token-1",
    type: "PlayerToken",
    ownerUserId: "user-alice",
    representsUserId: null,
    name: "Alice",
    color: "#ff0000",
    iconKind: "Initial",
    mapId: "map-1",
    x: 3.5,
    y: 4.5,
    sheetId: "sheet-1",
    hidden: false,
    ...overrides,
  };
}

function makeSheet(overrides?: Partial<CharacterSheet>): CharacterSheet {
  return {
    id: "sheet-1",
    ownerUserId: "user-alice",
    representsUserId: null,
    characterName: "Alice",
    values: {},
    notes: "",
    hp: 20,
    maxHp: 20,
    armorClass: 15,
    color: "#ff0000",
    scopedMapId: null,
    statusEffects: [],
    rollTemplates: [],
    ...overrides,
    colorOverridden: overrides?.colorOverridden ?? false,
  };
}

describe("visibility and permission helpers", () => {
  const dmId = "dm-user";
  const aliceId = "user-alice";
  const bobId = "user-bob";

  describe("isDm", () => {
    it("returns true only for matching dmPlayerId", () => {
      const state = createDefaultDndMapperState(dmId);
      expect(isDm(state, dmId)).toBe(true);
      expect(isDm(state, aliceId)).toBe(false);
      expect(isDm(state, null)).toBe(false);
    });
  });

  describe("canMoveToken", () => {
    it("always permits the DM to move any token", () => {
      const state = createDefaultDndMapperState(dmId);
      const token = makeToken({ ownerUserId: aliceId });
      expect(canMoveToken(state, dmId, token)).toBe(true);
    });

    it("enforces HostOnly policy", () => {
      const state = {
        ...createDefaultDndMapperState(dmId),
        settings: {
          ...createDefaultDndMapperState(dmId).settings,
          tokenMovement: "HostOnly" as const,
        },
      };
      const token = makeToken({ ownerUserId: aliceId });
      expect(canMoveToken(state, dmId, token)).toBe(true);
      expect(canMoveToken(state, aliceId, token)).toBe(false);
    });

    it("enforces Anyone policy", () => {
      const state = {
        ...createDefaultDndMapperState(dmId),
        settings: {
          ...createDefaultDndMapperState(dmId).settings,
          tokenMovement: "Anyone" as const,
        },
      };
      const token = makeToken({ ownerUserId: aliceId });
      expect(canMoveToken(state, bobId, token)).toBe(true);
    });

    it("enforces OwnerOrHost policy", () => {
      const state = {
        ...createDefaultDndMapperState(dmId),
        settings: {
          ...createDefaultDndMapperState(dmId).settings,
          tokenMovement: "OwnerOrHost" as const,
        },
      };
      const token = makeToken({ ownerUserId: aliceId });
      expect(canMoveToken(state, dmId, token)).toBe(true);
      expect(canMoveToken(state, aliceId, token)).toBe(true);
      expect(canMoveToken(state, bobId, token)).toBe(false);
    });
  });

  describe("canEditSheet", () => {
    it("always permits the DM to edit any sheet", () => {
      const state = createDefaultDndMapperState(dmId);
      const sheet = makeSheet({ ownerUserId: aliceId });
      expect(canEditSheet(state, dmId, sheet)).toBe(true);
    });

    it("enforces HostOnly policy", () => {
      const state = {
        ...createDefaultDndMapperState(dmId),
        settings: {
          ...createDefaultDndMapperState(dmId).settings,
          sheetEditByOthers: "HostOnly" as const,
        },
      };
      const sheet = makeSheet({ ownerUserId: aliceId });
      expect(canEditSheet(state, aliceId, sheet)).toBe(false);
    });

    it("enforces OwnersAndHost policy", () => {
      const state = {
        ...createDefaultDndMapperState(dmId),
        settings: {
          ...createDefaultDndMapperState(dmId).settings,
          sheetEditByOthers: "OwnersAndHost" as const,
        },
      };
      const sheet = makeSheet({ ownerUserId: aliceId });
      expect(canEditSheet(state, aliceId, sheet)).toBe(true);
      expect(canEditSheet(state, bobId, sheet)).toBe(false);
    });
  });

  describe("Token visibility", () => {
    it("shows hidden tokens to DM, but hides them from players", () => {
      const visibleToken = makeToken({ id: "t1", hidden: false });
      const hiddenToken = makeToken({ id: "t2", hidden: true });

      expect(isTokenVisibleToPlayer(visibleToken, false)).toBe(true);
      expect(isTokenVisibleToPlayer(hiddenToken, false)).toBe(false);
      expect(isTokenVisibleToPlayer(hiddenToken, true)).toBe(true);

      const all = [visibleToken, hiddenToken];
      expect(filterTokensForPlayer(all, true)).toHaveLength(2);
      expect(filterTokensForPlayer(all, false)).toEqual([visibleToken]);
    });
  });

  describe("Sheet visibility", () => {
    it("hides other sheets when playersCanSeeOtherSheets is false", () => {
      const state = {
        ...createDefaultDndMapperState(dmId),
        settings: {
          ...createDefaultDndMapperState(dmId).settings,
          playersCanSeeOtherSheets: false,
        },
      };

      const aliceSheet = makeSheet({ id: "s-alice", ownerUserId: aliceId });
      const bobSheet = makeSheet({ id: "s-bob", ownerUserId: bobId });
      const sheets = { [aliceSheet.id]: aliceSheet, [bobSheet.id]: bobSheet };

      expect(isSheetVisibleToPlayer(aliceSheet, state, aliceId)).toBe(true);
      expect(isSheetVisibleToPlayer(bobSheet, state, aliceId)).toBe(false);

      const filtered = filterSheetsForPlayer(sheets, state, aliceId);
      expect(Object.keys(filtered)).toEqual(["s-alice"]);
    });

    it("shows all sheets when playersCanSeeOtherSheets is true", () => {
      const state = {
        ...createDefaultDndMapperState(dmId),
        settings: {
          ...createDefaultDndMapperState(dmId).settings,
          playersCanSeeOtherSheets: true,
        },
      };

      const aliceSheet = makeSheet({ id: "s-alice", ownerUserId: aliceId });
      const bobSheet = makeSheet({ id: "s-bob", ownerUserId: bobId });
      const sheets = { [aliceSheet.id]: aliceSheet, [bobSheet.id]: bobSheet };

      const filtered = filterSheetsForPlayer(sheets, state, aliceId);
      expect(Object.keys(filtered)).toEqual(["s-alice", "s-bob"]);
    });
  });
});
