/*
 * Pure token domain helpers.
 *
 * Runs in the sandbox (no DOM, no Date, no Node).
 */

import type { GameMap, NewToken, Token } from "./domain.js";
import { generateGuid } from "./maps.js";
import { snapToken } from "./snapping.js";

/** Finds a token and its parent map by tokenId. */
export function findTokenById(
  maps: readonly GameMap[],
  tokenId: string,
): { readonly map: GameMap; readonly token: Token } | null {
  for (const m of maps) {
    const t = m.tokens.find((tok) => tok.id === tokenId);
    if (t) return { map: m, token: t };
  }
  return null;
}

/** Spawns a new token on the specified map. */
export function spawnTokenOnMap(
  maps: readonly GameMap[],
  mapId: string,
  newToken: NewToken,
  tokenId?: string,
): { maps: readonly GameMap[]; token: Token | null } {
  let created: Token | null = null;
  const updatedMaps = maps.map((m) => {
    if (m.id !== mapId) return m;
    const snapped = snapToken(newToken.x, newToken.y, m.grid);
    created = {
      ...newToken,
      id: tokenId ?? generateGuid(),
      mapId,
      ownerUserId: null,
      representsUserId: null,
      x: snapped.x,
      y: snapped.y,
    };
    return {
      ...m,
      tokens: [...m.tokens, created],
    };
  });

  return { maps: updatedMaps, token: created };
}

/** Moves a token, applying map grid snapping and bounds clamping. */
export function moveTokenOnMap(
  maps: readonly GameMap[],
  tokenId: string,
  x: number,
  y: number,
): { maps: readonly GameMap[]; token: Token | null } {
  let updated: Token | null = null;
  const updatedMaps = maps.map((m) => {
    const idx = m.tokens.findIndex((t) => t.id === tokenId);
    if (idx === -1) return m;
    const snapped = snapToken(x, y, m.grid);
    updated = {
      ...m.tokens[idx],
      x: snapped.x,
      y: snapped.y,
    };
    const nextTokens = [...m.tokens];
    nextTokens[idx] = updated;
    return { ...m, tokens: nextTokens };
  });

  return { maps: updatedMaps, token: updated };
}

/** Updates mutable properties on an existing token. */
export function updateTokenOnMap(
  maps: readonly GameMap[],
  tokenId: string,
  patch: Partial<Token>,
): { maps: readonly GameMap[]; token: Token | null } {
  let updated: Token | null = null;
  const updatedMaps = maps.map((m) => {
    const idx = m.tokens.findIndex((t) => t.id === tokenId);
    if (idx === -1) return m;
    const existing = m.tokens[idx];
    const rawX = patch.x !== undefined ? patch.x : existing.x;
    const rawY = patch.y !== undefined ? patch.y : existing.y;
    const snapped = snapToken(rawX, rawY, m.grid);
    updated = {
      ...existing,
      ...patch,
      id: existing.id,
      mapId: existing.mapId,
      x: snapped.x,
      y: snapped.y,
    };
    const nextTokens = [...m.tokens];
    nextTokens[idx] = updated;
    return { ...m, tokens: nextTokens };
  });

  return { maps: updatedMaps, token: updated };
}

/** Sets the hidden flag on a token. */
export function setTokenHiddenOnMap(
  maps: readonly GameMap[],
  tokenId: string,
  hidden: boolean,
): { maps: readonly GameMap[]; token: Token | null } {
  let updated: Token | null = null;
  const updatedMaps = maps.map((m) => {
    const idx = m.tokens.findIndex((t) => t.id === tokenId);
    if (idx === -1) return m;
    updated = { ...m.tokens[idx], hidden };
    const nextTokens = [...m.tokens];
    nextTokens[idx] = updated;
    return { ...m, tokens: nextTokens };
  });

  return { maps: updatedMaps, token: updated };
}

/** Removes a token from whichever map contains it. */
export function removeTokenFromMap(
  maps: readonly GameMap[],
  tokenId: string,
): { maps: readonly GameMap[]; removed: boolean } {
  let removed = false;
  const updatedMaps = maps.map((m) => {
    const filtered = m.tokens.filter((t) => t.id !== tokenId);
    if (filtered.length !== m.tokens.length) {
      removed = true;
      return { ...m, tokens: filtered };
    }
    return m;
  });

  return { maps: updatedMaps, removed };
}
