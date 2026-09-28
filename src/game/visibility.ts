/*
 * Pure visibility and permission helpers.
 *
 * Rules:
 *   1. DM is the lobby owner (state.dmPlayerId) and possesses unrestricted permissions.
 *   2. Token movement respects DndMapperSettings.tokenMovement:
 *        - "HostOnly": only DM may move
 *        - "Anyone": any connected user may move
 *        - "OwnerOrHost": DM or token owner (ownerUserId)
 *      (Mirrors rules.mayMoveToken — keep the two in sync.)
 *   3. Sheet edit respects DndMapperSettings.sheetEditByOthers:
 *        - "HostOnly": only DM may edit
 *        - "Anyone": any connected user may edit
 *        - "OwnersAndHost": DM or sheet owner
 *   4. Token visibility: hidden tokens are visible only to the DM.
 *   5. Sheet visibility: non-DM players see other sheets only if playersCanSeeOtherSheets is true,
 *      otherwise they see only their owned sheets.
 *   6. Strict JSON compatibility; pure TypeScript with no DOM or Node globals.
 */

import type { CharacterSheet, DndMapperState, MapImage, Token } from "./domain.js";

/** Checks if a user id matches the DM / host id. */
export function isDm(state: DndMapperState, userId: string | null): boolean {
  if (!userId || !state.dmPlayerId) return false;
  return state.dmPlayerId === userId;
}

/** Determines if the caller has permission to move a given token.
 *  Mirrors the server's mayMoveToken decision (rules.ts) exactly so the
 *  client-side drag gate predicts what the authority will accept. */
export function canMoveToken(state: DndMapperState, userId: string | null, token: Token): boolean {
  if (isDm(state, userId)) return true;
  if (!userId) return false;

  switch (state.settings.tokenMovement) {
    case "HostOnly":
      return false;
    case "Anyone":
      return true;
    case "OwnerOrHost":
      return token.ownerUserId === userId;
  }
}

/** Determines if the caller has permission to edit a character sheet. */
export function canEditSheet(
  state: DndMapperState,
  userId: string | null,
  sheet: CharacterSheet,
): boolean {
  if (isDm(state, userId)) return true;
  if (!userId) return false;

  switch (state.settings.sheetEditByOthers) {
    case "HostOnly":
      return false;
    case "Anyone":
      return true;
    case "OwnersAndHost":
      return sheet.ownerUserId === userId || sheet.representsUserId === userId;
  }
}

/** Determines if a token is visible to a user. */
export function isTokenVisibleToPlayer(
  token: Token,
  isDmUser: boolean,
  _userId?: string | null,
): boolean {
  if (isDmUser) return true;
  return !token.hidden;
}

/** Determines if a map image is visible to a user. */
export function isImageVisibleToPlayer(image: MapImage, isDmUser: boolean): boolean {
  if (isDmUser) return true;
  return !image.hidden;
}

/** Determines if a character sheet is visible to a user. */
export function isSheetVisibleToPlayer(
  sheet: CharacterSheet,
  state: DndMapperState,
  userId: string | null,
): boolean {
  if (isDm(state, userId)) return true;
  if (state.settings.playersCanSeeOtherSheets) return true;
  if (!userId) return false;
  return sheet.ownerUserId === userId || sheet.representsUserId === userId;
}

/** Filters a list of tokens according to user visibility permissions. */
export function filterTokensForPlayer(
  tokens: readonly Token[],
  isDmUser: boolean,
  userId?: string | null,
): readonly Token[] {
  if (isDmUser) return tokens;
  return tokens.filter((t) => isTokenVisibleToPlayer(t, isDmUser, userId));
}

/** Filters a dictionary of character sheets according to user visibility permissions. */
export function filterSheetsForPlayer(
  sheets: Readonly<Record<string, CharacterSheet>>,
  state: DndMapperState,
  userId: string | null,
): Readonly<Record<string, CharacterSheet>> {
  if (isDm(state, userId) || state.settings.playersCanSeeOtherSheets) {
    return sheets;
  }

  const result: Record<string, CharacterSheet> = {};
  const keys = Object.keys(sheets);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const sheet = sheets[key];
    if (isSheetVisibleToPlayer(sheet, state, userId)) {
      result[key] = sheet;
    }
  }
  return result;
}
