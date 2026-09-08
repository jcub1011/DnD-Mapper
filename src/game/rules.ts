/*
 * The RULES — the single source of truth for what a player may do and what the
 * state becomes. These run inside the KnockBox server's sandbox (via
 * `src/authority/authority.ts`), so they are pure functions with no
 * ambient I/O: no DOM, no console, no timers, and NO `Date` (the sandbox deletes
 * it — the authority passes `kb.now()` in as a clock).
 *
 * Clients never call these directly. A client sends an Intent and renders whatever
 * Patch or Snapshot the authority publishes.
 */

import type {
  CampaignHeader,
  DndMapperSettings,
  DndMapperState,
  FocusRect,
  GameMap,
  GridConfig,
  MapSummary,
  NewMapImage,
  NewToken,
  Token,
} from "./domain.js";
import { createDefaultDndMapperState, isFullMap, toMapSummary } from "./domain.js";
import { clearFog, decodeFog, encodeFog, fillFog, setCellsFogged } from "./fog.js";
import {
  addImageToMap,
  createNewMap,
  deleteMap,
  duplicateMap,
  generateGuid,
  removeMapImage,
  renameMap,
  reorderMapImage,
  reorderMaps,
  setMapImageHidden,
  setMapImageLocked,
  transformMapImage,
  updateMapGrid,
} from "./maps.js";
import {
  findTokenById,
  moveTokenOnMap,
  removeTokenFromMap,
  setTokenHiddenOnMap,
  spawnTokenOnMap,
  updateTokenOnMap,
} from "./tokens.js";
import type { Patch, PlayerInfo } from "./types.js";

// ── Permission Policies ──────────────────────────────────────────────────────

/** The DM is the lobby owner (dmPlayerId in state). */
export function isDm(state: DndMapperState, playerId: string): boolean {
  return state.dmPlayerId !== null && state.dmPlayerId === playerId;
}

/** Determines if a player may move a specific token. */
export function mayMoveToken(state: DndMapperState, fromId: string, token: Token): boolean {
  if (isDm(state, fromId)) return true;
  switch (state.settings.tokenMovement) {
    case "HostOnly":
      return false;
    case "Anyone":
      return true;
    case "OwnerOrHost":
      return token.ownerUserId === fromId;
  }
}

/** Determines if a player may edit/update a token. */
export function mayEditToken(state: DndMapperState, fromId: string, token: Token): boolean {
  if (isDm(state, fromId)) return true;
  switch (state.settings.tokenMovement) {
    case "HostOnly":
      return false;
    case "Anyone":
      return true;
    case "OwnerOrHost":
      return token.ownerUserId === fromId;
  }
}

/** Determines if a player may spawn a new token. */
export function maySpawnToken(state: DndMapperState, fromId: string, token: NewToken): boolean {
  if (isDm(state, fromId)) return true;
  if (token.type === "NPCToken" && !state.settings.playersCanCreateNPCs) {
    return false;
  }
  return true;
}

// ── State Initialization ─────────────────────────────────────────────────────

export function createState(players: readonly PlayerInfo[]): DndMapperState {
  const dmPlayerId = players.length > 0 ? players[0].id : null;
  return createDefaultDndMapperState(dmPlayerId);
}

// ── Snapshot Projection ──────────────────────────────────────────────────────

/**
 * Projects authoritative state into a bandwidth-bounded snapshot:
 * active map is sent in full; all other maps are reduced to MapSummary metadata.
 */
export function projectSnapshot(state: DndMapperState): DndMapperState {
  const activeId = state.activeMapId;
  const projectedMaps: Array<GameMap | MapSummary> = state.maps.map((m) => {
    if (activeId && m.id === activeId && isFullMap(m)) {
      return m;
    }
    return isFullMap(m) ? toMapSummary(m) : m;
  });

  return {
    ...state,
    maps: projectedMaps,
  };
}

// ── Chunked Import Side-Table ────────────────────────────────────────────────

interface PendingImport {
  readonly campaign: CampaignHeader;
  readonly totalChunks: number;
  readonly chunks: Map<number, readonly GameMap[]>;
  readonly createdAt: number;
  readonly fromId: string;
}

const pendingImports = new Map<string, PendingImport>();

/** Stale pending import timeout (5 minutes). */
const PENDING_IMPORT_TIMEOUT_MS = 5 * 60 * 1000;

export function clearPendingImports(): void {
  pendingImports.clear();
}

export function clearPendingImportsForPlayer(playerId: string): void {
  for (const [token, pending] of pendingImports.entries()) {
    if (pending.fromId === playerId) {
      pendingImports.delete(token);
    }
  }
}

function sweepStalePendingImports(now: number): void {
  for (const [token, pending] of pendingImports.entries()) {
    if (now - pending.createdAt > PENDING_IMPORT_TIMEOUT_MS) {
      pendingImports.delete(token);
    }
  }
}

// ── Apply Intent ─────────────────────────────────────────────────────────────

export interface ApplyIntentResult {
  readonly state: DndMapperState;
  readonly patch: Patch | null;
}

function isFocusRect(obj: unknown): obj is FocusRect {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number"
  );
}

/**
 * Validates untrusted client action, applies mutation if legal, and returns
 * the updated state and the narrowed absolute patch to broadcast.
 * Returning null means REJECTED (anti-cheat: nothing is broadcast).
 */
export function applyIntent(
  state: DndMapperState,
  fromId: string,
  action: unknown,
  now: number,
): ApplyIntentResult | null {
  if (typeof action !== "object" || action === null) return null;
  const intent = action as Record<string, unknown>;
  const kind = intent.kind;
  if (typeof kind !== "string") return null;

  sweepStalePendingImports(now);

  switch (kind) {
    // ── Maps ────────────────────────────────────────────────────────────────
    case "createMap": {
      if (!isDm(state, fromId)) return null;
      const name = typeof intent.name === "string" ? intent.name : "Untitled Map";
      const newMap = createNewMap(name, now, state.maps.length);
      const fullMaps = state.maps.filter(isFullMap);
      const nextMaps = [...fullMaps, newMap];
      const nextState: DndMapperState = {
        ...state,
        maps: nextMaps,
        activeMapId: state.activeMapId ?? newMap.id,
      };
      return {
        state: nextState,
        patch: {
          kind: "map",
          map: newMap,
        },
      };
    }

    case "renameMap": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string" || typeof intent.name !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const nextMaps = renameMap(fullMaps, intent.mapId, intent.name);
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "mapList",
          maps: nextMaps.map(toMapSummary),
        },
      };
    }

    case "deleteMap": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const nextMaps = deleteMap(fullMaps, intent.mapId);
      const nextActive =
        state.activeMapId === intent.mapId ? (nextMaps[0]?.id ?? null) : state.activeMapId;
      const nextState: DndMapperState = {
        ...state,
        maps: nextMaps,
        activeMapId: nextActive,
      };
      return {
        state: nextState,
        patch: {
          kind: "mapList",
          maps: nextMaps.map(toMapSummary),
        },
      };
    }

    case "duplicateMap": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const { maps: nextMaps, duplicated } = duplicateMap(fullMaps, intent.mapId, now);
      if (!duplicated) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "mapList",
          maps: nextMaps.map(toMapSummary),
        },
      };
    }

    case "reorderMaps": {
      if (!isDm(state, fromId)) return null;
      if (!Array.isArray(intent.order)) return null;
      const fullMaps = state.maps.filter(isFullMap);
      const nextMaps = reorderMaps(fullMaps, intent.order as string[]);
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "mapList",
          maps: nextMaps.map(toMapSummary),
        },
      };
    }

    case "setActiveMap": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string") return null;
      const mapExists = state.maps.some((m) => m.id === intent.mapId);
      if (!mapExists) return null;
      const nextState: DndMapperState = { ...state, activeMapId: intent.mapId };
      return {
        state: nextState,
        patch: {
          kind: "activeMap",
          mapId: intent.mapId,
        },
      };
    }

    case "updateGrid": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string" || !intent.grid || typeof intent.grid !== "object")
        return null;
      const fullMaps = state.maps.filter(isFullMap);
      const nextMaps = updateMapGrid(fullMaps, intent.mapId, intent.grid as GridConfig);
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "grid",
          mapId: intent.mapId,
          grid: intent.grid as GridConfig,
        },
      };
    }

    // ── Tokens ──────────────────────────────────────────────────────────────
    case "spawnToken": {
      if (typeof intent.mapId !== "string" || !intent.token || typeof intent.token !== "object")
        return null;
      const newToken = intent.token as NewToken;
      if (!maySpawnToken(state, fromId, newToken)) return null;
      const fullMaps = state.maps.filter(isFullMap);
      const { maps: nextMaps, token: spawned } = spawnTokenOnMap(fullMaps, intent.mapId, newToken);
      if (!spawned) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "token",
          token: spawned,
        },
      };
    }

    case "moveToken": {
      if (
        typeof intent.tokenId !== "string" ||
        typeof intent.x !== "number" ||
        typeof intent.y !== "number"
      ) {
        return null;
      }
      const fullMaps = state.maps.filter(isFullMap);
      const found = findTokenById(fullMaps, intent.tokenId);
      if (!found) return null;
      if (!mayMoveToken(state, fromId, found.token)) return null;
      const { maps: nextMaps, token: moved } = moveTokenOnMap(
        fullMaps,
        intent.tokenId,
        intent.x,
        intent.y,
      );
      if (!moved) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "token",
          token: moved,
        },
      };
    }

    case "updateToken": {
      if (typeof intent.tokenId !== "string" || !intent.patch || typeof intent.patch !== "object")
        return null;
      const fullMaps = state.maps.filter(isFullMap);
      const found = findTokenById(fullMaps, intent.tokenId);
      if (!found) return null;
      if (!mayEditToken(state, fromId, found.token)) return null;
      const { maps: nextMaps, token: updated } = updateTokenOnMap(
        fullMaps,
        intent.tokenId,
        intent.patch as Partial<Token>,
      );
      if (!updated) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "token",
          token: updated,
        },
      };
    }

    case "removeToken": {
      if (typeof intent.tokenId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const found = findTokenById(fullMaps, intent.tokenId);
      if (!found) return null;
      if (!mayEditToken(state, fromId, found.token)) return null;
      const { maps: nextMaps, removed } = removeTokenFromMap(fullMaps, intent.tokenId);
      if (!removed) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "tokenRemoved",
          tokenId: intent.tokenId,
        },
      };
    }

    case "setTokenHidden": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.tokenId !== "string" || typeof intent.hidden !== "boolean") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const { maps: nextMaps, token: updated } = setTokenHiddenOnMap(
        fullMaps,
        intent.tokenId,
        intent.hidden,
      );
      if (!updated) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "token",
          token: updated,
        },
      };
    }

    // ── Images ──────────────────────────────────────────────────────────────
    case "addImage": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string" || !intent.image || typeof intent.image !== "object")
        return null;
      const fullMaps = state.maps.filter(isFullMap);
      const { maps: nextMaps, image: created } = addImageToMap(
        fullMaps,
        intent.mapId,
        intent.image as NewMapImage,
      );
      if (!created) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "image",
          image: created,
        },
      };
    }

    case "transformImage": {
      if (!isDm(state, fromId)) return null;
      if (
        typeof intent.imageId !== "string" ||
        typeof intent.x !== "number" ||
        typeof intent.y !== "number" ||
        typeof intent.width !== "number" ||
        typeof intent.height !== "number" ||
        typeof intent.rotation !== "number"
      ) {
        return null;
      }
      const fullMaps = state.maps.filter(isFullMap);
      const { maps: nextMaps, image: updated } = transformMapImage(fullMaps, intent.imageId, {
        x: intent.x,
        y: intent.y,
        width: intent.width,
        height: intent.height,
        rotation: intent.rotation,
      });
      if (!updated) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "image",
          image: updated,
        },
      };
    }

    case "reorderImage": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.imageId !== "string" || typeof intent.layerOrder !== "number") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const { maps: nextMaps, image: updated } = reorderMapImage(
        fullMaps,
        intent.imageId,
        intent.layerOrder,
      );
      if (!updated) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "image",
          image: updated,
        },
      };
    }

    case "setImageLocked": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.imageId !== "string" || typeof intent.locked !== "boolean") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const { maps: nextMaps, image: updated } = setMapImageLocked(
        fullMaps,
        intent.imageId,
        intent.locked,
      );
      if (!updated) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "image",
          image: updated,
        },
      };
    }

    case "setImageHidden": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.imageId !== "string" || typeof intent.hidden !== "boolean") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const { maps: nextMaps, image: updated } = setMapImageHidden(
        fullMaps,
        intent.imageId,
        intent.hidden,
      );
      if (!updated) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "image",
          image: updated,
        },
      };
    }

    case "removeImage": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.imageId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const { maps: nextMaps, removed } = removeMapImage(fullMaps, intent.imageId);
      if (!removed) return null;
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "imageRemoved",
          imageId: intent.imageId,
        },
      };
    }

    // ── Fog ─────────────────────────────────────────────────────────────────
    case "paintFog": {
      if (!isDm(state, fromId)) return null;
      if (
        typeof intent.mapId !== "string" ||
        !Array.isArray(intent.cells) ||
        typeof intent.fogged !== "boolean"
      ) {
        return null;
      }
      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;

      const maskBytes = decodeFog(targetMap.fogMask);
      const updatedMaskBytes = setCellsFogged(
        maskBytes,
        targetMap.grid,
        intent.cells as number[],
        intent.fogged,
      );
      const maskB64 = encodeFog(updatedMaskBytes);

      const nextMaps = fullMaps.map((m) =>
        m.id === targetMap.id ? { ...m, fogMask: maskB64 } : m,
      );
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "fog",
          mapId: targetMap.id,
          mask: maskB64,
        },
      };
    }

    case "fillFog": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;

      const maskBytes = fillFog(targetMap.grid);
      const maskB64 = encodeFog(maskBytes);
      const nextMaps = fullMaps.map((m) =>
        m.id === targetMap.id ? { ...m, fogMask: maskB64 } : m,
      );
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "fog",
          mapId: targetMap.id,
          mask: maskB64,
        },
      };
    }

    case "clearFog": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;

      const maskB64 = encodeFog(clearFog()); // empty means revealed
      const nextMaps = fullMaps.map((m) =>
        m.id === targetMap.id ? { ...m, fogMask: maskB64 } : m,
      );
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "fog",
          mapId: targetMap.id,
          mask: maskB64,
        },
      };
    }

    // ── Viewport ────────────────────────────────────────────────────────────
    case "setFocusRect": {
      if (!isDm(state, fromId)) return null;
      const rect = isFocusRect(intent.rect) ? intent.rect : null;
      const nextState: DndMapperState = { ...state, focusRect: rect };
      return {
        state: nextState,
        patch: {
          kind: "focusRect",
          rect,
        },
      };
    }

    case "centerViewport": {
      if (!isDm(state, fromId)) return null;
      if (
        typeof intent.mapId !== "string" ||
        typeof intent.x !== "number" ||
        typeof intent.y !== "number"
      ) {
        return null;
      }
      const request = {
        mapId: intent.mapId,
        x: intent.x,
        y: intent.y,
        nonce: generateGuid(),
      };
      const nextState: DndMapperState = { ...state, pendingCenterRequest: request };
      return {
        state: nextState,
        patch: {
          kind: "centerViewport",
          request,
        },
      };
    }

    // ── Settings ────────────────────────────────────────────────────────────
    case "updateSettings": {
      if (!isDm(state, fromId)) return null;
      if (!intent.patch || typeof intent.patch !== "object") return null;
      const nextSettings: DndMapperSettings = {
        ...state.settings,
        ...(intent.patch as Partial<DndMapperSettings>),
      };
      const nextState: DndMapperState = { ...state, settings: nextSettings };
      return {
        state: nextState,
        patch: {
          kind: "settings",
          settings: nextSettings,
        },
      };
    }

    // ── Map On-Demand Fetch ──────────────────────────────────────────────────
    case "requestMap": {
      if (typeof intent.mapId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;
      return {
        state,
        patch: {
          kind: "map",
          map: targetMap,
        },
      };
    }

    // ── Chunked Campaign Import Protocol ────────────────────────────────────
    case "beginImport": {
      if (!isDm(state, fromId)) return null;
      if (
        !intent.campaign ||
        typeof intent.campaign !== "object" ||
        typeof intent.chunkCount !== "number"
      ) {
        return null;
      }
      const token = typeof intent.token === "string" ? intent.token : generateGuid();
      pendingImports.set(token, {
        campaign: intent.campaign as CampaignHeader,
        totalChunks: intent.chunkCount,
        chunks: new Map<number, readonly GameMap[]>(),
        createdAt: now,
        fromId,
      });
      // Broadcast nothing until commitImport
      return { state, patch: null };
    }

    case "importChunk": {
      if (!isDm(state, fromId)) return null;
      if (
        typeof intent.token !== "string" ||
        typeof intent.index !== "number" ||
        !Array.isArray(intent.maps)
      ) {
        return null;
      }
      const pending = pendingImports.get(intent.token);
      if (!pending || pending.fromId !== fromId) return null;
      pending.chunks.set(intent.index, intent.maps as GameMap[]);
      return { state, patch: null };
    }

    case "commitImport": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.token !== "string") return null;
      const pending = pendingImports.get(intent.token);
      if (!pending || pending.fromId !== fromId) return null;

      // Ensure all chunks arrived
      if (pending.chunks.size < pending.totalChunks) {
        pendingImports.delete(intent.token);
        return null;
      }

      const allMaps: GameMap[] = [];
      for (let i = 0; i < pending.totalChunks; i++) {
        const chunk = pending.chunks.get(i);
        if (!chunk) {
          pendingImports.delete(intent.token);
          return null;
        }
        allMaps.push(...chunk);
      }
      pendingImports.delete(intent.token);

      const header = pending.campaign;
      const activeMapId = header.activeMapId ?? allMaps[0]?.id ?? null;
      const nextState: DndMapperState = {
        ...state,
        phase: "Playing",
        settings: header.settings ?? state.settings,
        attributeSchema: header.attributeSchema ?? state.attributeSchema,
        activeMapId,
        sheets: header.sheets ?? {},
        customTemplates: header.customTemplates ?? {},
        globalRollTemplates: header.globalRollTemplates ?? [],
        activeSchemaTemplateId: header.activeSchemaTemplateId ?? null,
        initiativeAttributeName: header.initiativeAttributeName ?? null,
        activeCombat: header.activeCombat ?? null,
        loadedDiceRules: header.loadedDiceRules ?? [],
        maps: allMaps,
      };

      return {
        state: nextState,
        patch: {
          kind: "full",
          state: projectSnapshot(nextState),
        },
      };
    }

    default:
      return null;
  }
}
