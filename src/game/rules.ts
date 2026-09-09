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
  AttributePreset,
  AttributeRow,
  AttributeSchema,
  AttributeValue,
  CampaignHeader,
  CharacterSheet,
  CustomTemplate,
  DndMapperSettings,
  DndMapperState,
  FocusRect,
  GameMap,
  GridConfig,
  MapSummary,
  NamedTemplate,
  NewMapImage,
  NewToken,
  StatusEffect,
  StatusEffectTemplate,
  Token,
  RollMode,
  RollTemplate,
} from "./domain.js";
import {
  clampHpToEffectiveMax,
  createDefaultAttributeSchema,
  createDefaultDndMapperState,
  isCustomTemplate,
  isFullMap,
  MAX_ROLL_LOG,
  reconcileSheetValues,
  resolveEffectiveMaxHp,
  toMapSummary,
} from "./domain.js";
import { BUILTIN_ROLL_TEMPLATES, executeRoll, validateDiceTerms } from "./dice.js";
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
  timestampToIsoUtc,
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

/** Determines if a player may view a character sheet in the roster / UI. */
export function mayViewSheet(state: DndMapperState, fromId: string, sheet: CharacterSheet): boolean {
  if (isDm(state, fromId)) return true;
  if (sheet.ownerUserId === null) return false;
  if (sheet.ownerUserId === fromId) return true;
  return state.settings.playersCanSeeOtherSheets;
}

/** Determines if a player may view private fields (notes and HP) of a sheet. */
export function mayViewSheetNotesAndHp(state: DndMapperState, fromId: string, sheet: CharacterSheet): boolean {
  return isDm(state, fromId) || sheet.ownerUserId === fromId;
}

/** Determines if a player may edit a character sheet. */
export function mayEditSheet(state: DndMapperState, fromId: string, sheet: CharacterSheet): boolean {
  if (isDm(state, fromId)) return true;
  switch (state.settings.sheetEditByOthers) {
    case "HostOnly":
      return false;
    case "Anyone":
      return true;
    case "OwnersAndHost":
      return sheet.ownerUserId === fromId;
  }
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
        typeof intent.imageId === "string" ? intent.imageId : undefined,
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

    case "startSession": {
      if (!isDm(state, fromId)) return null;
      if (state.phase === "Playing") return null;

      let nextMaps = state.maps;
      let nextActiveMapId = state.activeMapId;
      let newMapCreated = false;

      if (state.maps.length === 0) {
        const firstMap = createNewMap("First Map", now, 0);
        nextMaps = [firstMap];
        nextActiveMapId = firstMap.id;
        newMapCreated = true;
      }

      const nextState: DndMapperState = {
        ...state,
        phase: "Playing",
        maps: nextMaps,
        activeMapId: nextActiveMapId,
      };

      if (newMapCreated) {
        return {
          state: nextState,
          patch: {
            kind: "full",
            state: projectSnapshot(nextState),
          },
        };
      }

      return {
        state: nextState,
        patch: {
          kind: "phase",
          phase: "Playing",
        },
      };
    }

    // ── Sheets ──────────────────────────────────────────────────────────────
    case "createSheet": {
      if (typeof intent.characterName !== "string") return null;
      const name = intent.characterName.trim();
      if (name.length === 0) return null;

      const dm = isDm(state, fromId);
      const ownerUserId = dm
        ? typeof intent.ownerUserId === "string"
          ? intent.ownerUserId
          : null
        : fromId;

      if (!dm) {
        const alreadyOwns = Object.values(state.sheets).some((s) => s.ownerUserId === fromId);
        if (alreadyOwns) return null;
      }

      const newId = generateGuid();
      const initialValues: Record<string, AttributeValue> = {};
      for (const row of state.attributeSchema.rows) {
        initialValues[row.name] = row.default;
      }

      const sheet: CharacterSheet = {
        id: newId,
        ownerUserId,
        representsUserId: null,
        characterName: name,
        values: initialValues,
        notes: "",
        hp: null,
        maxHp: null,
        armorClass: null,
        color: "#4a90e2",
        scopedMapId: typeof intent.scopedMapId === "string" ? intent.scopedMapId : null,
        statusEffects: [],
        rollTemplates: [],
      };

      const nextSheets = { ...state.sheets, [newId]: sheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet },
      };
    }

    case "updateSheet": {
      if (typeof intent.sheetId !== "string" || !intent.patch || typeof intent.patch !== "object") {
        return null;
      }
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;
      if (!mayEditSheet(state, fromId, sheet)) return null;

      const patch = intent.patch as Partial<Pick<CharacterSheet, "characterName" | "color" | "scopedMapId" | "notes">>;
      const nextName = typeof patch.characterName === "string" && patch.characterName.trim().length > 0
        ? patch.characterName.trim()
        : sheet.characterName;
      const nextColor = typeof patch.color === "string" ? patch.color : sheet.color;
      const nextNotes = typeof patch.notes === "string" ? patch.notes : sheet.notes;
      const nextScope = patch.scopedMapId !== undefined
        ? (typeof patch.scopedMapId === "string" ? patch.scopedMapId : null)
        : sheet.scopedMapId;

      const updatedSheet: CharacterSheet = {
        ...sheet,
        characterName: nextName,
        color: nextColor,
        notes: nextNotes,
        scopedMapId: nextScope,
      };

      let nextMaps = state.maps;
      if (nextName !== sheet.characterName) {
        nextMaps = state.maps.map((m) => {
          if (!isFullMap(m)) return m;
          let changed = false;
          const nextTokens = m.tokens.map((t) => {
            if (t.sheetId === sheet.id && t.name !== nextName) {
              changed = true;
              return { ...t, name: nextName };
            }
            return t;
          });
          return changed ? { ...m, tokens: nextTokens } : m;
        });
      }

      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets, maps: nextMaps };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: updatedSheet },
      };
    }

    case "deleteSheet": {
      if (typeof intent.sheetId !== "string") return null;
      if (!isDm(state, fromId)) return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;

      const nextMaps = state.maps.map((m) => {
        if (!isFullMap(m)) return m;
        let changed = false;
        const nextTokens = m.tokens.map((t) => {
          if (t.sheetId === intent.sheetId) {
            changed = true;
            return { ...t, sheetId: null };
          }
          return t;
        });
        return changed ? { ...m, tokens: nextTokens } : m;
      });

      const nextSheets = { ...state.sheets };
      delete nextSheets[intent.sheetId];
      const nextState: DndMapperState = { ...state, sheets: nextSheets, maps: nextMaps };
      return {
        state: nextState,
        patch: { kind: "sheetRemoved", sheetId: intent.sheetId },
      };
    }

    case "duplicateSheet": {
      if (typeof intent.sheetId !== "string") return null;
      if (!isDm(state, fromId)) return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;

      const newId = generateGuid();
      const clone: CharacterSheet = {
        ...sheet,
        id: newId,
        characterName: `${sheet.characterName} (copy)`,
        ownerUserId: null,
        representsUserId: null,
        statusEffects: sheet.statusEffects.map((e) => ({ ...e })),
        rollTemplates: sheet.rollTemplates.map((r) => ({ ...r })),
      };

      const nextSheets = { ...state.sheets, [newId]: clone };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: clone },
      };
    }

    case "assignSheetOwner": {
      if (typeof intent.sheetId !== "string") return null;
      if (!isDm(state, fromId)) return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;

      const nextOwner = typeof intent.ownerUserId === "string" ? intent.ownerUserId : null;
      const updatedSheet: CharacterSheet = {
        ...sheet,
        ownerUserId: nextOwner,
      };

      const nextMaps = state.maps.map((m) => {
        if (!isFullMap(m)) return m;
        let changed = false;
        const nextTokens = m.tokens.map((t) => {
          if (t.sheetId === sheet.id) {
            changed = true;
            return {
              ...t,
              ownerUserId: nextOwner,
              type: nextOwner ? ("PlayerToken" as const) : ("NPCToken" as const),
            };
          }
          return t;
        });
        return changed ? { ...m, tokens: nextTokens } : m;
      });

      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets, maps: nextMaps };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: updatedSheet },
      };
    }

    case "setSheetHp": {
      if (typeof intent.sheetId !== "string") return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;
      if (!mayEditSheet(state, fromId, sheet)) return null;

      let nextHp = typeof intent.hp === "number" ? Math.max(0, intent.hp) : null;
      if (nextHp !== null) {
        const effMax = resolveEffectiveMaxHp(sheet);
        if (effMax !== null && nextHp > effMax) {
          nextHp = effMax;
        }
      }

      const updatedSheet: CharacterSheet = { ...sheet, hp: nextHp };
      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: updatedSheet },
      };
    }

    case "setSheetMaxHp": {
      if (typeof intent.sheetId !== "string") return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;
      if (!mayEditSheet(state, fromId, sheet)) return null;

      const nextMaxHp = typeof intent.maxHp === "number" ? Math.max(0, intent.maxHp) : null;
      let updatedSheet: CharacterSheet = { ...sheet, maxHp: nextMaxHp };
      updatedSheet = clampHpToEffectiveMax(updatedSheet);

      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: updatedSheet },
      };
    }

    case "setSheetAc": {
      if (typeof intent.sheetId !== "string") return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;
      if (!mayEditSheet(state, fromId, sheet)) return null;

      const nextAc = typeof intent.ac === "number" ? Math.max(0, intent.ac) : null;
      const updatedSheet: CharacterSheet = { ...sheet, armorClass: nextAc };
      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: updatedSheet },
      };
    }

    case "updateAttributeValues": {
      if (typeof intent.sheetId !== "string" || !intent.values || typeof intent.values !== "object") {
        return null;
      }
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;
      if (!mayEditSheet(state, fromId, sheet)) return null;

      const validRows = new Map(state.attributeSchema.rows.map((r) => [r.name, r]));
      const nextValues = { ...sheet.values };
      for (const [k, v] of Object.entries(intent.values as Record<string, unknown>)) {
        const row = validRows.get(k);
        if (row && v && typeof v === "object" && "kind" in v && row.type === (v as AttributeValue).kind) {
          nextValues[k] = v as AttributeValue;
        }
      }

      const updatedSheet: CharacterSheet = { ...sheet, values: nextValues };
      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: updatedSheet },
      };
    }

    // ── Schemas ─────────────────────────────────────────────────────────────
    case "setSchemaPreset": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.preset !== "string") return null;
      const newSchema = createDefaultAttributeSchema(intent.preset as AttributePreset);

      const nextSheets: Record<string, CharacterSheet> = {};
      for (const [id, s] of Object.entries(state.sheets)) {
        nextSheets[id] = reconcileSheetValues(s, newSchema);
      }

      const nextState: DndMapperState = {
        ...state,
        attributeSchema: newSchema,
        sheets: nextSheets,
      };
      return {
        state: nextState,
        patch: {
          kind: "schema",
          schema: newSchema,
          initiativeAttributeName: state.initiativeAttributeName,
        },
      };
    }

    case "updateSchemaRows": {
      if (!isDm(state, fromId)) return null;
      if (!Array.isArray(intent.rows) || intent.rows.length === 0) return null;

      const seen = new Set<string>();
      for (const row of intent.rows) {
        if (!row || typeof row.name !== "string" || row.name.trim().length === 0) return null;
        const lower = row.name.trim().toLowerCase();
        if (seen.has(lower)) return null;
        seen.add(lower);
      }

      const newSchema: AttributeSchema = {
        preset: "Custom",
        rows: intent.rows as readonly AttributeRow[],
      };

      const nextSheets: Record<string, CharacterSheet> = {};
      for (const [id, s] of Object.entries(state.sheets)) {
        nextSheets[id] = reconcileSheetValues(s, newSchema);
      }

      const initiativeAttr = intent.initiativeAttributeName !== undefined
        ? (typeof intent.initiativeAttributeName === "string" ? intent.initiativeAttributeName : null)
        : state.initiativeAttributeName;

      const nextState: DndMapperState = {
        ...state,
        attributeSchema: newSchema,
        initiativeAttributeName: initiativeAttr,
        sheets: nextSheets,
      };
      return {
        state: nextState,
        patch: {
          kind: "schema",
          schema: newSchema,
          initiativeAttributeName: initiativeAttr,
        },
      };
    }

    case "setInitiativeAttribute": {
      if (!isDm(state, fromId)) return null;
      const attrName = typeof intent.attributeName === "string" ? intent.attributeName : null;
      const nextState: DndMapperState = {
        ...state,
        initiativeAttributeName: attrName,
      };
      return {
        state: nextState,
        patch: {
          kind: "schema",
          schema: state.attributeSchema,
          initiativeAttributeName: attrName,
        },
      };
    }

    // ── Status Effects ──────────────────────────────────────────────────────
    case "applyStatusEffect": {
      if (typeof intent.sheetId !== "string" || !intent.effect || typeof intent.effect !== "object") {
        return null;
      }
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;
      if (!mayEditSheet(state, fromId, sheet)) return null;

      const rawEffect = intent.effect as Record<string, unknown>;
      if (typeof rawEffect.name !== "string" || rawEffect.name.trim().length === 0) {
        return null;
      }

      const newEffect: StatusEffect = {
        id: generateGuid(),
        name: rawEffect.name.trim(),
        appliedUtc: timestampToIsoUtc(now),
        attributeDeltas: Array.isArray(rawEffect.attributeDeltas) ? (rawEffect.attributeDeltas as StatusEffect["attributeDeltas"]) : [],
        maxHpDelta: typeof rawEffect.maxHpDelta === "number" ? rawEffect.maxHpDelta : null,
        onApplyHpDelta: typeof rawEffect.onApplyHpDelta === "number" ? rawEffect.onApplyHpDelta : null,
        notes: typeof rawEffect.notes === "string" ? rawEffect.notes : "",
      };

      let updatedSheet: CharacterSheet = {
        ...sheet,
        statusEffects: [...sheet.statusEffects, newEffect],
      };

      if (newEffect.onApplyHpDelta !== null) {
        const effMax = resolveEffectiveMaxHp(updatedSheet);
        const baseHp = sheet.hp ?? effMax;
        if (baseHp !== null) {
          const targetHp = baseHp + newEffect.onApplyHpDelta;
          updatedSheet = {
            ...updatedSheet,
            hp: effMax !== null ? Math.max(0, Math.min(targetHp, effMax)) : Math.max(0, targetHp),
          };
        }
      }

      updatedSheet = clampHpToEffectiveMax(updatedSheet);

      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: updatedSheet },
      };
    }

    case "updateStatusEffect": {
      if (typeof intent.sheetId !== "string" || typeof intent.effectId !== "string" || !intent.patch) {
        return null;
      }
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;
      if (!mayEditSheet(state, fromId, sheet)) return null;

      const idx = sheet.statusEffects.findIndex((e) => e.id === intent.effectId);
      if (idx === -1) return null;

      const existing = sheet.statusEffects[idx];
      const patch = intent.patch as Partial<Omit<StatusEffect, "id" | "appliedUtc">>;
      const updatedEffect: StatusEffect = {
        ...existing,
        name: typeof patch.name === "string" && patch.name.trim().length > 0 ? patch.name.trim() : existing.name,
        attributeDeltas: Array.isArray(patch.attributeDeltas) ? patch.attributeDeltas : existing.attributeDeltas,
        maxHpDelta: patch.maxHpDelta !== undefined ? patch.maxHpDelta : existing.maxHpDelta,
        onApplyHpDelta: patch.onApplyHpDelta !== undefined ? patch.onApplyHpDelta : existing.onApplyHpDelta,
        notes: typeof patch.notes === "string" ? patch.notes : existing.notes,
      };

      const nextEffects = [...sheet.statusEffects];
      nextEffects[idx] = updatedEffect;

      let updatedSheet: CharacterSheet = {
        ...sheet,
        statusEffects: nextEffects,
      };
      updatedSheet = clampHpToEffectiveMax(updatedSheet);

      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: updatedSheet },
      };
    }

    case "removeStatusEffect": {
      if (typeof intent.sheetId !== "string" || typeof intent.effectId !== "string") {
        return null;
      }
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;
      if (!mayEditSheet(state, fromId, sheet)) return null;

      const nextEffects = sheet.statusEffects.filter((e) => e.id !== intent.effectId);
      if (nextEffects.length === sheet.statusEffects.length) return null;

      let updatedSheet: CharacterSheet = {
        ...sheet,
        statusEffects: nextEffects,
      };
      updatedSheet = clampHpToEffectiveMax(updatedSheet);

      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: updatedSheet },
      };
    }

    case "createEffectTemplate": {
      if (!isDm(state, fromId)) return null;
      const t = intent.template as Omit<StatusEffectTemplate, "id"> | undefined;
      if (!t || typeof t.name !== "string" || t.name.trim().length === 0) {
        return null;
      }
      const id = generateGuid();
      const template: StatusEffectTemplate = {
        id,
        name: t.name.trim(),
        attributeDeltas: Array.isArray(t.attributeDeltas) ? t.attributeDeltas : [],
        maxHpDelta: typeof t.maxHpDelta === "number" ? t.maxHpDelta : null,
        onApplyHpDelta: typeof t.onApplyHpDelta === "number" ? t.onApplyHpDelta : null,
        notes: typeof t.notes === "string" ? t.notes : "",
      };

      const nextTemplates = { ...state.statusEffectTemplates, [id]: template };
      const nextState: DndMapperState = { ...state, statusEffectTemplates: nextTemplates };
      return {
        state: nextState,
        patch: { kind: "effectTemplate", template },
      };
    }

    case "updateEffectTemplate": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.templateId !== "string" || !intent.patch) return null;
      const existing = state.statusEffectTemplates[intent.templateId];
      if (!existing) return null;

      const patch = intent.patch as Partial<Omit<StatusEffectTemplate, "id">>;
      const updated: StatusEffectTemplate = {
        ...existing,
        name: typeof patch.name === "string" && patch.name.trim().length > 0 ? patch.name.trim() : existing.name,
        attributeDeltas: Array.isArray(patch.attributeDeltas) ? patch.attributeDeltas : existing.attributeDeltas,
        maxHpDelta: patch.maxHpDelta !== undefined ? patch.maxHpDelta : existing.maxHpDelta,
        onApplyHpDelta: patch.onApplyHpDelta !== undefined ? patch.onApplyHpDelta : existing.onApplyHpDelta,
        notes: typeof patch.notes === "string" ? patch.notes : existing.notes,
      };

      const nextTemplates = { ...state.statusEffectTemplates, [intent.templateId]: updated };
      const nextState: DndMapperState = { ...state, statusEffectTemplates: nextTemplates };
      return {
        state: nextState,
        patch: { kind: "effectTemplate", template: updated },
      };
    }

    case "deleteEffectTemplate": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.templateId !== "string") return null;
      if (!state.statusEffectTemplates[intent.templateId]) return null;

      const nextTemplates = { ...state.statusEffectTemplates };
      delete nextTemplates[intent.templateId];
      const nextState: DndMapperState = { ...state, statusEffectTemplates: nextTemplates };
      return {
        state: nextState,
        patch: { kind: "effectTemplateRemoved", templateId: intent.templateId },
      };
    }

    // ── Custom Templates ────────────────────────────────────────────────────
    case "createCustomTemplate": {
      if (!isDm(state, fromId)) return null;
      const t = intent.template as Omit<CustomTemplate, "id"> | undefined;
      if (!t || typeof t.name !== "string" || t.name.trim().length === 0) {
        return null;
      }
      const id = generateGuid();
      const template: CustomTemplate = {
        id,
        name: t.name.trim(),
        description: typeof t.description === "string" ? t.description : "",
        values: t.values && typeof t.values === "object" ? t.values : {},
        maxHp: typeof t.maxHp === "number" ? t.maxHp : null,
        armorClass: typeof t.armorClass === "number" ? t.armorClass : null,
        color: typeof t.color === "string" ? t.color : "#4a90e2",
        notes: typeof t.notes === "string" ? t.notes : "",
        statusEffectTemplates: Array.isArray(t.statusEffectTemplates) ? t.statusEffectTemplates : [],
        rollTemplates: Array.isArray(t.rollTemplates) ? t.rollTemplates : [],
      };

      const nextCustom = { ...state.customTemplates, [id]: template };
      const nextState: DndMapperState = { ...state, customTemplates: nextCustom };
      return {
        state: nextState,
        patch: { kind: "customTemplate", template },
      };
    }

    case "updateCustomTemplate": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.templateId !== "string" || !intent.patch) return null;
      const existing = state.customTemplates[intent.templateId];
      if (!existing || !isCustomTemplate(existing)) return null;

      const patch = intent.patch as Partial<Omit<CustomTemplate, "id">>;
      const updated: CustomTemplate = {
        ...existing,
        name: typeof patch.name === "string" && patch.name.trim().length > 0 ? patch.name.trim() : existing.name,
        description: typeof patch.description === "string" ? patch.description : existing.description,
        values: patch.values ? patch.values : existing.values,
        maxHp: patch.maxHp !== undefined ? patch.maxHp : existing.maxHp,
        armorClass: patch.armorClass !== undefined ? patch.armorClass : existing.armorClass,
        color: typeof patch.color === "string" ? patch.color : existing.color,
        notes: typeof patch.notes === "string" ? patch.notes : existing.notes,
        statusEffectTemplates: Array.isArray(patch.statusEffectTemplates) ? patch.statusEffectTemplates : existing.statusEffectTemplates,
        rollTemplates: Array.isArray(patch.rollTemplates) ? patch.rollTemplates : existing.rollTemplates,
      };

      const nextCustom = { ...state.customTemplates, [intent.templateId]: updated };
      const nextState: DndMapperState = { ...state, customTemplates: nextCustom };
      return {
        state: nextState,
        patch: { kind: "customTemplate", template: updated },
      };
    }

    case "deleteCustomTemplate": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.templateId !== "string") return null;
      if (!state.customTemplates[intent.templateId]) return null;

      const nextCustom = { ...state.customTemplates };
      delete nextCustom[intent.templateId];
      const nextState: DndMapperState = { ...state, customTemplates: nextCustom };
      return {
        state: nextState,
        patch: { kind: "customTemplateRemoved", templateId: intent.templateId },
      };
    }

    case "applyCustomTemplate": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.templateId !== "string") return null;
      const template = state.customTemplates[intent.templateId];
      if (!template || !isCustomTemplate(template)) return null;

      const newId = generateGuid();
      const name = typeof intent.characterName === "string" && intent.characterName.trim().length > 0
        ? intent.characterName.trim()
        : template.name;

      const sheetValues: Record<string, AttributeValue> = {};
      for (const row of state.attributeSchema.rows) {
        if (template.values[row.name] && template.values[row.name].kind === row.type) {
          sheetValues[row.name] = template.values[row.name];
        } else {
          sheetValues[row.name] = row.default;
        }
      }

      const newSheet: CharacterSheet = {
        id: newId,
        ownerUserId: null,
        representsUserId: null,
        characterName: name,
        values: sheetValues,
        notes: template.notes,
        hp: template.maxHp,
        maxHp: template.maxHp,
        armorClass: template.armorClass,
        color: template.color || "#4a90e2",
        scopedMapId: typeof intent.scopedMapId === "string" ? intent.scopedMapId : null,
        statusEffects: [],
        rollTemplates: [...template.rollTemplates],
      };

      const nextSheets = { ...state.sheets, [newId]: newSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: { kind: "sheet", sheet: newSheet },
      };
    }

    case "duplicateCustomTemplate": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.templateId !== "string") return null;
      const existing = state.customTemplates[intent.templateId];
      if (!existing || !isCustomTemplate(existing)) return null;

      const newId = generateGuid();
      const clone: CustomTemplate = {
        ...existing,
        id: newId,
        name: `${existing.name} (copy)`,
      };

      const nextCustom = { ...state.customTemplates, [newId]: clone };
      const nextState: DndMapperState = { ...state, customTemplates: nextCustom };
      return {
        state: nextState,
        patch: { kind: "customTemplate", template: clone },
      };
    }

    case "reorderCustomTemplates": {
      if (!isDm(state, fromId)) return null;
      if (!Array.isArray(intent.templateIds)) return null;
      const nextCustom: Record<string, CustomTemplate | NamedTemplate> = {};
      for (const id of intent.templateIds) {
        if (typeof id === "string" && state.customTemplates[id]) {
          nextCustom[id] = state.customTemplates[id];
        }
      }
      for (const [id, t] of Object.entries(state.customTemplates)) {
        if (!nextCustom[id]) {
          nextCustom[id] = t;
        }
      }
      const nextState: DndMapperState = { ...state, customTemplates: nextCustom };
      return { state: nextState, patch: null };
    }

    // ── Phase 7: Dice & Roll Templates ──────────────────────────────────────────

    case "rollDice": {
      if (typeof intent.formula !== "string" || !intent.formula) return null;
      const mode: RollMode =
        intent.mode === "Advantage" || intent.mode === "Disadvantage" ? intent.mode : "Normal";
      const roll = executeRoll(intent.formula, mode, fromId, {
        nowMs: now,
        label: typeof intent.label === "string" ? intent.label : undefined,
        tokenId: typeof intent.tokenId === "string" ? intent.tokenId : null,
        sheetId: typeof intent.sheetId === "string" ? intent.sheetId : null,
        attributeName: typeof intent.attributeName === "string" ? intent.attributeName : null,
        sheets: state.sheets,
      });
      if (!roll) return null;

      const nextRollLog = [...state.rollLog, roll].slice(-MAX_ROLL_LOG);
      const nextState: DndMapperState = { ...state, rollLog: nextRollLog };
      return { state: nextState, patch: { kind: "roll", roll } };
    }

    case "rollTemplate": {
      if (typeof intent.templateId !== "string") return null;

      let template: RollTemplate | undefined = BUILTIN_ROLL_TEMPLATES.find((t) => t.id === intent.templateId);

      if (!template) {
        template = state.globalRollTemplates.find((t) => t.id === intent.templateId);
      }

      const sheetId = typeof intent.sheetId === "string" ? intent.sheetId : null;
      if (!template && sheetId && state.sheets[sheetId]) {
        template = state.sheets[sheetId].rollTemplates.find((t: RollTemplate) => t.id === intent.templateId);
      }

      if (!template) return null;

      const modeOverride =
        intent.modeOverride === "Advantage" ||
        intent.modeOverride === "Disadvantage" ||
        intent.modeOverride === "Normal"
          ? intent.modeOverride
          : undefined;
      const mode = modeOverride ?? template.mode;

      const roll = executeRoll(template.dice, mode, fromId, {
        nowMs: now,
        label: template.label || template.name,
        tokenId: typeof intent.tokenId === "string" ? intent.tokenId : null,
        sheetId,
        attributeName: template.attributeName,
        sheets: state.sheets,
        flatModifierOverride: template.flatModifier,
      });
      if (!roll) return null;

      const nextRollLog = [...state.rollLog, roll].slice(-MAX_ROLL_LOG);
      const nextState: DndMapperState = { ...state, rollLog: nextRollLog };
      return { state: nextState, patch: { kind: "roll", roll } };
    }

    case "createGlobalRollTemplate": {
      if (!isDm(state, fromId)) return null;
      const tmpl = intent.template as Omit<RollTemplate, "id" | "scope"> | undefined;
      if (!tmpl || typeof tmpl.name !== "string" || !Array.isArray(tmpl.dice)) return null;
      const diceVal = validateDiceTerms(tmpl.dice);
      if (!diceVal.valid) return null;

      const newTemplate: RollTemplate = {
        id: generateGuid(),
        name: tmpl.name.trim() || "New Template",
        dice: [...tmpl.dice],
        flatModifier: typeof tmpl.flatModifier === "number" ? tmpl.flatModifier : 0,
        mode: tmpl.mode ?? "Normal",
        attributeName: typeof tmpl.attributeName === "string" ? tmpl.attributeName : null,
        label: typeof tmpl.label === "string" ? tmpl.label : tmpl.name,
        scope: "Global",
      };

      const nextTemplates = [...state.globalRollTemplates, newTemplate];
      const nextState: DndMapperState = { ...state, globalRollTemplates: nextTemplates };
      return { state: nextState, patch: { kind: "globalRollTemplates", templates: nextTemplates } };
    }

    case "updateGlobalRollTemplate": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.templateId !== "string" || !intent.patch) return null;
      const patch = intent.patch as Partial<Omit<RollTemplate, "id" | "scope">>;
      const index = state.globalRollTemplates.findIndex((t) => t.id === intent.templateId);
      if (index === -1) return null;

      const existing = state.globalRollTemplates[index];
      if (patch.dice) {
        const diceVal = validateDiceTerms(patch.dice);
        if (!diceVal.valid) return null;
      }

      const updated: RollTemplate = {
        ...existing,
        name: typeof patch.name === "string" ? patch.name.trim() : existing.name,
        dice: patch.dice ? [...patch.dice] : existing.dice,
        flatModifier: typeof patch.flatModifier === "number" ? patch.flatModifier : existing.flatModifier,
        mode: patch.mode ?? existing.mode,
        attributeName: patch.attributeName !== undefined ? patch.attributeName : existing.attributeName,
        label: typeof patch.label === "string" ? patch.label : existing.label,
      };

      const nextTemplates = [...state.globalRollTemplates];
      nextTemplates[index] = updated;
      const nextState: DndMapperState = { ...state, globalRollTemplates: nextTemplates };
      return { state: nextState, patch: { kind: "globalRollTemplates", templates: nextTemplates } };
    }

    case "deleteGlobalRollTemplate": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.templateId !== "string") return null;

      const nextTemplates = state.globalRollTemplates.filter((t) => t.id !== intent.templateId);
      const nextState: DndMapperState = { ...state, globalRollTemplates: nextTemplates };
      return { state: nextState, patch: { kind: "globalRollTemplates", templates: nextTemplates } };
    }

    case "createRollTemplate": {
      if (typeof intent.sheetId !== "string") return null;
      const tmpl = intent.template as Omit<RollTemplate, "id" | "scope"> | undefined;
      if (!tmpl || typeof tmpl.name !== "string" || !Array.isArray(tmpl.dice)) return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet || !mayEditSheet(state, fromId, sheet)) return null;

      const diceVal = validateDiceTerms(tmpl.dice);
      if (!diceVal.valid) return null;

      const newTemplate: RollTemplate = {
        id: generateGuid(),
        name: tmpl.name.trim() || "New Template",
        dice: [...tmpl.dice],
        flatModifier: typeof tmpl.flatModifier === "number" ? tmpl.flatModifier : 0,
        mode: tmpl.mode ?? "Normal",
        attributeName: typeof tmpl.attributeName === "string" ? tmpl.attributeName : null,
        label: typeof tmpl.label === "string" ? tmpl.label : tmpl.name,
        scope: "Sheet",
      };

      const nextSheet: CharacterSheet = {
        ...sheet,
        rollTemplates: [...sheet.rollTemplates, newTemplate],
      };
      const nextSheets = { ...state.sheets, [sheet.id]: nextSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return { state: nextState, patch: { kind: "sheet", sheet: nextSheet } };
    }

    case "updateRollTemplate": {
      if (typeof intent.sheetId !== "string" || typeof intent.templateId !== "string" || !intent.patch) return null;
      const patch = intent.patch as Partial<Omit<RollTemplate, "id" | "scope">>;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet || !mayEditSheet(state, fromId, sheet)) return null;

      const index = sheet.rollTemplates.findIndex((t) => t.id === intent.templateId);
      if (index === -1) return null;

      const existing = sheet.rollTemplates[index];
      if (patch.dice) {
        const diceVal = validateDiceTerms(patch.dice);
        if (!diceVal.valid) return null;
      }

      const updated: RollTemplate = {
        ...existing,
        name: typeof patch.name === "string" ? patch.name.trim() : existing.name,
        dice: patch.dice ? [...patch.dice] : existing.dice,
        flatModifier: typeof patch.flatModifier === "number" ? patch.flatModifier : existing.flatModifier,
        mode: patch.mode ?? existing.mode,
        attributeName: patch.attributeName !== undefined ? patch.attributeName : existing.attributeName,
        label: typeof patch.label === "string" ? patch.label : existing.label,
      };

      const nextRollTemplates = [...sheet.rollTemplates];
      nextRollTemplates[index] = updated;
      const nextSheet: CharacterSheet = { ...sheet, rollTemplates: nextRollTemplates };
      const nextSheets = { ...state.sheets, [sheet.id]: nextSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return { state: nextState, patch: { kind: "sheet", sheet: nextSheet } };
    }

    case "deleteRollTemplate": {
      if (typeof intent.sheetId !== "string" || typeof intent.templateId !== "string") return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet || !mayEditSheet(state, fromId, sheet)) return null;

      const nextRollTemplates = sheet.rollTemplates.filter((t) => t.id !== intent.templateId);
      const nextSheet: CharacterSheet = { ...sheet, rollTemplates: nextRollTemplates };
      const nextSheets = { ...state.sheets, [sheet.id]: nextSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return { state: nextState, patch: { kind: "sheet", sheet: nextSheet } };
    }

    case "clearRollLog": {
      if (!isDm(state, fromId)) return null;
      const nextState: DndMapperState = { ...state, rollLog: [] };
      return { state: nextState, patch: { kind: "rollLogCleared" } };
    }

    default:
      return null;
  }
}
