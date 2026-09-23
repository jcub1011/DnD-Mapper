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
  LoadedDiceRule,
  CombatantEntry,
  CombatState,
} from "./domain.js";
import {
  advanceTurn,
  getInitiativeModifier,
  isAllRollsComplete,
  reverseTurn,
  sortTurnOrder,
} from "./combat.js";
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
import { seedColorForName } from "./color.js";
import { snapToken } from "./snapping.js";
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

// ── Token ↔ Sheet N:1 Binding ─────────────────────────────────────────────
// Tokens and character sheets are bound N:1: every token links to exactly one
// sheet, and a sheet may have zero or more tokens (across any maps). The sheet
// is the source of truth for shared identity (name, color identifier); each
// token mirrors those fields. A sheet belongs to a single player and its
// tokens are that player's tokens — moving one token to another player
// re-links just that token to the target player's sheet. The color is seeded
// from the sheet name until a user explicitly picks one (colorOverridden),
// after which renames stop reseeding.

export interface BoundPairSpec {
  readonly name: string;
  readonly color?: string | null;
  readonly ownerUserId: string | null;
  readonly representsUserId: string | null;
  readonly type: Token["type"];
  readonly iconKind?: Token["iconKind"];
  readonly scopedMapId?: string | null;
}

function spawnPositionForMap(map: GameMap): { readonly x: number; readonly y: number } {
  return (
    map.defaultSpawnPosition ?? {
      x: Math.floor(map.grid.widthCells / 2) + 0.5,
      y: Math.floor(map.grid.heightCells / 2) + 0.5,
    }
  );
}

/** Finds the token bound to a sheet, anywhere on any map. */
export function findBoundToken(
  fullMaps: readonly GameMap[],
  sheetId: string,
): { readonly map: GameMap; readonly token: Token } | null {
  for (const m of fullMaps) {
    const token = m.tokens.find((t) => t.sheetId === sheetId);
    if (token) return { map: m, token };
  }
  return null;
}

/** Finds ALL tokens bound to a sheet, anywhere on any map. */
export function findBoundTokens(
  fullMaps: readonly GameMap[],
  sheetId: string,
): { readonly map: GameMap; readonly token: Token }[] {
  const out: { readonly map: GameMap; readonly token: Token }[] = [];
  for (const m of fullMaps) {
    for (const token of m.tokens) {
      if (token.sheetId === sheetId) out.push({ map: m, token });
    }
  }
  return out;
}

/** Finds all sheets owned by a player. */
export function findSheetsByOwner(
  sheets: Readonly<Record<string, CharacterSheet>>,
  ownerUserId: string,
): CharacterSheet[] {
  return Object.values(sheets).filter((s) => s.ownerUserId === ownerUserId);
}

function defaultSheetValues(schema: AttributeSchema): Record<string, AttributeValue> {
  const values: Record<string, AttributeValue> = {};
  for (const row of schema.rows) {
    values[row.name] = row.default;
  }
  return values;
}

/**
 * Inserts a new sheet plus its bound token on the given map, sharing name,
 * color, and player assignation. An explicit color marks the pair as manually
 * overridden; otherwise the color is seeded from the name.
 */
function insertBoundPair(
  fullMaps: readonly GameMap[],
  targetMapId: string,
  spec: BoundPairSpec,
  schema: AttributeSchema,
  position?: { readonly x: number; readonly y: number } | null,
): { maps: readonly GameMap[]; sheet: CharacterSheet; token: Token } | null {
  const target = fullMaps.find((m) => m.id === targetMapId);
  if (!target) return null;
  const name = spec.name.trim() || "Unnamed Character";
  const explicitColor =
    typeof spec.color === "string" && spec.color.trim().length > 0 ? spec.color : null;
  const color = explicitColor ?? seedColorForName(name);
  const sheet: CharacterSheet = {
    id: generateGuid(),
    ownerUserId: spec.ownerUserId,
    representsUserId: spec.representsUserId,
    characterName: name,
    values: defaultSheetValues(schema),
    notes: "",
    hp: null,
    maxHp: null,
    armorClass: null,
    color,
    colorOverridden: explicitColor !== null,
    scopedMapId: typeof spec.scopedMapId === "string" ? spec.scopedMapId : null,
    statusEffects: [],
    rollTemplates: [],
  };
  const raw = position ?? spawnPositionForMap(target);
  const pos = snapToken(raw.x, raw.y, target.grid);
  const token: Token = {
    id: generateGuid(),
    type: spec.type,
    ownerUserId: spec.ownerUserId,
    representsUserId: spec.representsUserId,
    name,
    color,
    iconKind: spec.iconKind ?? "Initial",
    mapId: target.id,
    x: pos.x,
    y: pos.y,
    sheetId: sheet.id,
    hidden: false,
  };
  const maps = fullMaps.map((m) =>
    m.id === target.id ? { ...m, tokens: [...m.tokens, token] } : m,
  );
  return { maps, sheet, token };
}

/**
 * Synthesizes the missing sheet for an orphan token, preserving the token's
 * visible name, color, and assignation. The adopted color counts as manually
 * overridden so backfill never recolors existing tokens.
 */
function synthesizeSheetForToken(
  token: Token,
  schema: AttributeSchema,
  sheetId?: string,
): CharacterSheet {
  return {
    id: sheetId ?? generateGuid(),
    ownerUserId: token.ownerUserId,
    representsUserId: token.representsUserId,
    characterName: token.name,
    values: defaultSheetValues(schema),
    notes: "",
    hp: null,
    maxHp: null,
    armorClass: null,
    color: token.color,
    colorOverridden: true,
    scopedMapId: null,
    statusEffects: [],
    rollTemplates: [],
  };
}

/**
 * Repairs legacy orphans so the N:1 invariant holds: tokens without a (live)
 * sheet get a sheet. Sheets without tokens are normal (sheet-only sheets) and
 * are left alone. Missing `colorOverridden` flags on imported sheets default
 * to false.
 */
function ensureBoundPairs(
  fullMaps: readonly GameMap[],
  sheets: Readonly<Record<string, CharacterSheet>>,
  _activeMapId: string | null,
  schema: AttributeSchema,
): { maps: readonly GameMap[]; sheets: Record<string, CharacterSheet> } {
  const nextSheets: Record<string, CharacterSheet> = {};
  for (const [id, sheet] of Object.entries(sheets)) {
    nextSheets[id] = {
      ...sheet,
      colorOverridden: sheet.colorOverridden ?? false,
    };
  }

  let maps: readonly GameMap[] = fullMaps;

  // Tokens without a live sheet → synthesize the sheet, keep token stable.
  for (const m of fullMaps) {
    for (const token of m.tokens) {
      if (token.sheetId && nextSheets[token.sheetId]) continue;
      const sheet = synthesizeSheetForToken(token, schema, token.sheetId ?? undefined);
      nextSheets[sheet.id] = sheet;
      if (!token.sheetId || token.sheetId !== sheet.id) {
        const fixed: Token = { ...token, sheetId: sheet.id };
        maps = maps.map((candidate) =>
          candidate.id === m.id
            ? { ...candidate, tokens: candidate.tokens.map((t) => (t.id === token.id ? fixed : t)) }
            : candidate,
        );
      }
    }
  }

  return { maps, sheets: nextSheets };
}

/** Drops combatants whose tokens were removed, clamping the turn index. */
function stripCombatantsByTokenIds(
  combat: CombatState | null,
  tokenIds: ReadonlySet<string>,
): CombatState | null {
  if (!combat) return combat;
  if (!combat.turnOrder.some((c) => tokenIds.has(c.tokenId))) return combat;
  const turnOrder = combat.turnOrder.filter((c) => !tokenIds.has(c.tokenId));
  return {
    ...combat,
    turnOrder,
    currentTurnIndex:
      turnOrder.length === 0 ? 0 : Math.min(combat.currentTurnIndex, turnOrder.length - 1),
  };
}

/**
 * Mirrors shared IDENTITY fields from sheet → token (name/color only).
 * Ownership is never fanned out through this path: token ownership moves via
 * reassignTokenSheet (single token, re-link) or assignSheetOwner (whole
 * sheet cascade). The token type only flips when ownership actually changed
 * hands (preserves legacy mismatches).
 */
function mirrorSheetToToken(token: Token, sheet: CharacterSheet): Token {
  const ownerChanged =
    token.ownerUserId !== sheet.ownerUserId || token.representsUserId !== sheet.representsUserId;
  return {
    ...token,
    name: sheet.characterName,
    color: sheet.color,
    ownerUserId: sheet.ownerUserId,
    representsUserId: sheet.representsUserId,
    type: ownerChanged
      ? sheet.ownerUserId !== null
        ? ("PlayerToken" as const)
        : ("NPCToken" as const)
      : token.type,
  };
}

/** Mirrors sheet → token identity ONLY (name/color), leaving ownership alone. */
function mirrorSheetIdentityToToken(token: Token, sheet: CharacterSheet): Token {
  if (token.name === sheet.characterName && token.color === sheet.color) return token;
  return {
    ...token,
    name: sheet.characterName,
    color: sheet.color,
  };
}

/**
 * Mirrors IDENTITY fields from token → sheet (token is the edited side).
 * Ownership never flows token → sheet: use the assign intents for that.
 */
function mirrorTokenToSheet(sheet: CharacterSheet, token: Token): CharacterSheet {
  return {
    ...sheet,
    characterName: token.name,
    color: token.color,
  };
}

// ── State Initialization ─────────────────────────────────────────────────────

export function createState(players: readonly PlayerInfo[]): DndMapperState {
  const dmPlayerId = players.length > 0 ? players[0].id : null;
  return createDefaultDndMapperState(dmPlayerId);
}

// ── Player Lifecycle & Abandonment (Phase 11) ────────────────────────────────

/**
 * Handles a player disconnecting from the session:
 *   1. If the DM drops, promotes the oldest remaining peer in the roster.
 *   2. If a non-DM drops:
 *      - Converts their tokens to NPCToken on the board, ownerUserId = null,
 *        recording representsUserId = leavingPlayerId so characters stay on the board.
 *      - Updates any owned character sheets: ownerUserId = null, representsUserId = leavingPlayerId.
 *      - Clears ownership on active combatants so DM can roll and manage them.
 */
export function handlePlayerLeft(
  state: DndMapperState,
  leavingPlayerId: string,
  roster: readonly PlayerInfo[],
): { state: DndMapperState; patch: Patch | null } {
  let changed = false;

  // 1. Owner succession: if leaving player was DM, promote oldest remaining peer
  let newDmPlayerId = state.dmPlayerId;
  if (leavingPlayerId === state.dmPlayerId) {
    const successor = roster.find((p) => p.id !== leavingPlayerId)?.id ?? null;
    newDmPlayerId = successor;
    changed = true;
  }

  // 2. Maps & tokens: convert leaving player's tokens to NPCToken
  const nextMaps: GameMap[] = [];
  let tokenChanged = false;

  for (const m of state.maps) {
    if (!isFullMap(m)) {
      nextMaps.push(m as unknown as GameMap);
      continue;
    }

    let mapChanged = false;
    const updatedTokens: Token[] = m.tokens.map((tok) => {
      if (tok.ownerUserId === leavingPlayerId) {
        mapChanged = true;
        tokenChanged = true;
        return {
          ...tok,
          type: "NPCToken" as const,
          ownerUserId: null,
          representsUserId: leavingPlayerId,
        };
      }
      return tok;
    });

    if (mapChanged) {
      nextMaps.push({ ...m, tokens: updatedTokens });
    } else {
      nextMaps.push(m);
    }
  }

  // 3. Sheets: clear ownerUserId and set representsUserId on leaving player's sheets
  let sheetChanged = false;
  const nextSheets: Record<string, CharacterSheet> = {};
  for (const [id, sheet] of Object.entries(state.sheets)) {
    if (sheet.ownerUserId === leavingPlayerId) {
      sheetChanged = true;
      nextSheets[id] = {
        ...sheet,
        ownerUserId: null,
        representsUserId: leavingPlayerId,
      };
    } else {
      nextSheets[id] = sheet;
    }
  }

  // 4. Combat: clear ownerUserId on leaving player's combatants
  let nextCombat = state.activeCombat;
  if (nextCombat) {
    let combatChanged = false;
    const nextTurnOrder = nextCombat.turnOrder.map((c) => {
      if (c.ownerUserId === leavingPlayerId) {
        combatChanged = true;
        return {
          ...c,
          ownerUserId: null,
        };
      }
      return c;
    });
    if (combatChanged) {
      nextCombat = { ...nextCombat, turnOrder: nextTurnOrder };
      changed = true;
    }
  }

  if (tokenChanged || sheetChanged || newDmPlayerId !== state.dmPlayerId) {
    changed = true;
  }

  if (!changed) {
    return { state, patch: null };
  }

  const nextState: DndMapperState = {
    ...state,
    dmPlayerId: newDmPlayerId,
    maps: nextMaps,
    sheets: nextSheets,
    activeCombat: nextCombat,
  };

  if (tokenChanged || sheetChanged) {
    return {
      state: nextState,
      patch: {
        kind: "full",
        state: projectSnapshot(nextState),
      },
    };
  }

  // Only DM changed
  return {
    state: nextState,
    patch: newDmPlayerId ? { kind: "dm", dmPlayerId: newDmPlayerId } : null,
  };
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
 * Deterministic, sandbox-safe SVG validator for freehand markup.
 * Strictly enforces an allowlist of harmless vector tags and attributes.
 * Rejects any scripts, event handlers, hrefs, or external references.
 */
export function validateMarkupSvg(svg: string): boolean {
  if (svg.length > 200_000) return false;
  const trimmed = svg.trim();
  if (trimmed.length === 0) return true;

  const openCount = (trimmed.match(/</g) || []).length;
  const closeCount = (trimmed.match(/>/g) || []).length;
  if (openCount !== closeCount) return false;

  // 1. Blacklist check: reject script, on*, href, xlink, javascript:, data:, external url
  if (/<\s*script/i.test(trimmed)) return false;
  if (/\bon\w+\s*=/i.test(trimmed)) return false;
  if (/\b(?:href|xlink:href|src|action)\s*=/i.test(trimmed)) return false;
  if (/javascript\s*:/i.test(trimmed)) return false;
  if (/data\s*:/i.test(trimmed)) return false;
  if (/url\s*\(\s*['"]?\s*https?:/i.test(trimmed)) return false;

  // 2. Reject dangerous tags
  const forbiddenTags =
    /<\s*\/?\s*(?:iframe|object|embed|foreignobject|style|link|meta|use|animate|set|audio|video|picture|input|form|button)/i;
  if (forbiddenTags.test(trimmed)) return false;

  // 3. Allowlist tags: only svg, g, path, circle, rect, line, polyline
  const allowedTags = new Set(["svg", "g", "path", "circle", "rect", "line", "polyline"]);

  const tagRegex = /<\s*(\/?)\s*([a-zA-Z0-9:-]+)([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(trimmed)) !== null) {
    const tagName = match[2].toLowerCase();
    if (!allowedTags.has(tagName)) {
      return false;
    }

    const attrs = match[3];
    if (attrs && attrs.trim().length > 0) {
      const attrRegex = /([a-zA-Z0-9:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=]+)))?/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(attrs)) !== null) {
        const attrName = attrMatch[1].toLowerCase();
        const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";

        const allowedAttrs = new Set([
          "stroke",
          "stroke-width",
          "stroke-linecap",
          "stroke-linejoin",
          "stroke-opacity",
          "stroke-dasharray",
          "fill",
          "fill-opacity",
          "fill-rule",
          "d",
          "r",
          "cx",
          "cy",
          "x",
          "y",
          "width",
          "height",
          "opacity",
          "transform",
          "viewbox",
          "xmlns",
          "class",
          "id",
        ]);

        if (!allowedAttrs.has(attrName)) {
          return false;
        }

        if (
          /javascript\s*:/i.test(attrVal) ||
          /data\s*:/i.test(attrVal) ||
          /url\s*\(\s*['"]?\s*https?:/i.test(attrVal)
        ) {
          return false;
        }
      }
    }
  }

  return true;
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
  roster?: readonly PlayerInfo[],
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
      const nextActiveMapId = state.activeMapId ?? newMap.id;
      // Backfill: normalize imported sheets (colorOverridden flags). Sheets
      // are tokenless by design, so no tokens are spawned here.
      const repaired = ensureBoundPairs(
        nextMaps,
        state.sheets,
        nextActiveMapId,
        state.attributeSchema,
      );
      const sheetsGrew = Object.keys(repaired.sheets).length !== Object.keys(state.sheets).length;
      const tokensGrew = repaired.maps.some(
        (m, i) => isFullMap(m) && isFullMap(nextMaps[i]) && m.tokens.length !== nextMaps[i].tokens.length,
      );
      const nextState: DndMapperState = {
        ...state,
        maps: repaired.maps,
        sheets: repaired.sheets,
        activeMapId: nextActiveMapId,
      };
      if (sheetsGrew || tokensGrew) {
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
      // N:1 binding: sheets are global and survive map deletion — only the
      // map's tokens (and their combat seats) leave with it.
      const nextSheets: Record<string, CharacterSheet> = state.sheets;
      const removedTokenIds = new Set<string>();
      const deleted = fullMaps.find((m) => m.id === intent.mapId);
      if (deleted) {
        for (const t of deleted.tokens) removedTokenIds.add(t.id);
      }
      const nextCombat = stripCombatantsByTokenIds(state.activeCombat, removedTokenIds);
      const nextState: DndMapperState = {
        ...state,
        maps: nextMaps,
        sheets: nextSheets,
        activeCombat: nextCombat,
        activeMapId: nextActive,
      };
      if (nextCombat !== state.activeCombat) {
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
      // N:1 binding: cloned tokens keep their sheetId so the duplicated map
      // shares sheets with the source map (same player, more maps). Token ids
      // and mapId are already reminted by duplicateMap.
      const nextState: DndMapperState = { ...state, maps: nextMaps, sheets: state.sheets };
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

    case "switchMap":
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

    case "setGridConfig":
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

    case "exportMapImage": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string") return null;
      const mapExists = state.maps.some((m) => m.id === intent.mapId);
      if (!mapExists) return null;
      return {
        state,
        patch: null,
      };
    }

    // ── Tokens ──────────────────────────────────────────────────────────────
    case "createToken":
    case "spawnToken": {
      if (typeof intent.mapId !== "string" || !intent.token || typeof intent.token !== "object")
        return null;
      const newToken = intent.token as NewToken;
      if (!maySpawnToken(state, fromId, newToken)) return null;
      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;

      // Placing a token for an existing sheet: the spawned token takes the
      // sheet's name/color/assignation as a one-time inheritance. Sheets may
      // back any number of tokens, so already-linked sheets are fine.
      const adoptId = typeof newToken.sheetId === "string" ? newToken.sheetId : null;
      const adoptSheet = adoptId ? state.sheets[adoptId] : undefined;
      if (adoptSheet) {
        const { maps: nextMaps, token: spawned } = spawnTokenOnMap(fullMaps, intent.mapId, {
          ...newToken,
          name: adoptSheet.characterName,
          color: adoptSheet.color,
          sheetId: adoptSheet.id,
        });
        if (!spawned) return null;
        const synced: Token = {
          ...spawned,
          ownerUserId: adoptSheet.ownerUserId,
          representsUserId: adoptSheet.representsUserId,
          type:
            adoptSheet.ownerUserId !== null
              ? ("PlayerToken" as const)
              : ("NPCToken" as const),
        };
        const syncedMaps = nextMaps.map((m) =>
          m.id === targetMap.id
            ? { ...m, tokens: m.tokens.map((t) => (t.id === synced.id ? synced : t)) }
            : m,
        );
        const nextState: DndMapperState = { ...state, maps: syncedMaps };
        return {
          state: nextState,
          patch: {
            kind: "full",
            state: projectSnapshot(nextState),
          },
        };
      }

      // Fresh spawn: the counterpart sheet is created alongside the token.
      // An explicit token color counts as a manual override for the pair.
      const paired = insertBoundPair(fullMaps, intent.mapId, {
        name: newToken.name,
        color: newToken.color,
        ownerUserId: null,
        representsUserId: null,
        type: newToken.type,
        iconKind: newToken.iconKind,
      }, state.attributeSchema, { x: newToken.x, y: newToken.y });
      if (!paired) return null;
      const nextSheets = { ...state.sheets, [paired.sheet.id]: paired.sheet };
      const nextState: DndMapperState = { ...state, maps: paired.maps, sheets: nextSheets };
      return {
        state: nextState,
        patch: {
          kind: "full",
          state: projectSnapshot(nextState),
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
      // Binding fields are managed by the assign/create/delete intents, never
      // by direct patch. Ownership (ownerUserId / representsUserId / type)
      // moves exclusively through reassignTokenSheet (single token) and
      // assignSheetOwner (whole sheet), so it is stripped here for everyone,
      // DM included.
      const {
        id: _patchId,
        mapId: _patchMap,
        sheetId: _patchSheet,
        ownerUserId: _patchOwner,
        representsUserId: _patchRepresents,
        type: _patchType,
        ...restPatch
      } = intent.patch as Partial<Token>;
      const patch = restPatch as Partial<Token>;
      const { maps: nextMaps, token: updated } = updateTokenOnMap(fullMaps, intent.tokenId, patch);
      if (!updated) return null;

      // Mirror identity onto the bound sheet so all of the sheet's tokens
      // stay identical. Ownership never flows token → sheet.
      const boundSheet = updated.sheetId ? state.sheets[updated.sheetId] : undefined;
      if (!boundSheet) {
        const nextState: DndMapperState = { ...state, maps: nextMaps };
        return {
          state: nextState,
          patch: {
            kind: "token",
            token: updated,
          },
        };
      }
      let nextSheet = mirrorTokenToSheet(boundSheet, updated);
      let finalToken = updated;
      if (typeof patch.color === "string" && patch.color !== boundSheet.color) {
        // An explicit color pick freezes the sheet's color identifier.
        nextSheet = { ...nextSheet, colorOverridden: true };
      } else if (
        nextSheet.characterName !== boundSheet.characterName &&
        !boundSheet.colorOverridden
      ) {
        // Rename re-seeds the color on the sheet and all its tokens while
        // not overridden.
        const seeded = seedColorForName(nextSheet.characterName);
        nextSheet = { ...nextSheet, color: seeded };
        finalToken = { ...updated, color: seeded };
      }
      // The sheet is the source of truth for identity: re-mirror the edited
      // token, then fan the sheet's identity out to all sibling tokens.
      finalToken = mirrorSheetIdentityToToken(finalToken, nextSheet);
      const sheetChanged =
        nextSheet.characterName !== boundSheet.characterName ||
        nextSheet.color !== boundSheet.color ||
        nextSheet.colorOverridden !== boundSheet.colorOverridden;
      if (!sheetChanged) {
        const nextState: DndMapperState = { ...state, maps: nextMaps };
        return {
          state: nextState,
          patch: {
            kind: "token",
            token: updated,
          },
        };
      }
      const syncedMaps = nextMaps.map((m) => {
        if (!isFullMap(m)) return m;
        let changed = false;
        const nextTokens = m.tokens.map((t) => {
          if (t.sheetId !== nextSheet.id) return t;
          if (t.id === finalToken.id) {
            if (finalToken.name !== t.name || finalToken.color !== t.color) {
              changed = true;
              return finalToken;
            }
            return t;
          }
          const mirrored = mirrorSheetIdentityToToken(t, nextSheet);
          if (mirrored !== t) changed = true;
          return mirrored;
        });
        return changed ? { ...m, tokens: nextTokens } : m;
      });
      const nextState: DndMapperState = {
        ...state,
        maps: syncedMaps,
        sheets: { ...state.sheets, [nextSheet.id]: nextSheet },
      };
      return {
        state: nextState,
        patch: {
          kind: "full",
          state: projectSnapshot(nextState),
        },
      };
    }

    case "deleteToken":
    case "removeToken": {
      if (typeof intent.tokenId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const found = findTokenById(fullMaps, intent.tokenId);
      if (!found) return null;
      if (!mayEditToken(state, fromId, found.token)) return null;
      const { maps: nextMaps, removed } = removeTokenFromMap(fullMaps, intent.tokenId);
      if (!removed) return null;

      // N:1 binding: deleting a token removes just that token. Its character
      // sheet (and any sibling tokens) survives.
      const nextSheets: Record<string, CharacterSheet> = state.sheets;

      const nextCombat = stripCombatantsByTokenIds(
        state.activeCombat,
        new Set([intent.tokenId as string]),
      );

      const nextState: DndMapperState = {
        ...state,
        maps: nextMaps,
        sheets: nextSheets,
        activeCombat: nextCombat,
      };
      if (nextCombat !== state.activeCombat) {
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
          kind: "tokenRemoved",
          tokenId: intent.tokenId,
        },
      };
    }

    case "duplicateToken": {
      if (typeof intent.tokenId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const found = findTokenById(fullMaps, intent.tokenId);
      if (!found) return null;
      if (!mayEditToken(state, fromId, found.token)) return null;

      // N:1 binding: the clone is just another token for the same sheet —
      // same sheetId, same name/color/owner, offset position.
      const cloned: Token = {
        ...found.token,
        id: generateGuid(),
        x: found.token.x + 1,
        y: found.token.y + 1,
      };

      let nextSheets: Record<string, CharacterSheet> = state.sheets;
      let finalCloned = cloned;
      if (!cloned.sheetId || !state.sheets[cloned.sheetId]) {
        const sheet = synthesizeSheetForToken(cloned, state.attributeSchema);
        finalCloned = { ...cloned, sheetId: sheet.id };
        nextSheets = { ...state.sheets, [sheet.id]: sheet };
      }

      const nextMaps = fullMaps.map((m) => {
        if (m.id === found.map.id) {
          return { ...m, tokens: [...m.tokens, finalCloned] };
        }
        return m;
      });

      const nextState: DndMapperState = { ...state, maps: nextMaps, sheets: nextSheets };
      return {
        state: nextState,
        patch: {
          kind: "full",
          state: projectSnapshot(nextState),
        },
      };
    }

    case "reorderTokens": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string" || !Array.isArray(intent.tokenIds)) return null;
      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;

      const idOrder = intent.tokenIds as string[];
      const tokenMap = new Map(targetMap.tokens.map((t) => [t.id, t]));
      const ordered: Token[] = [];
      for (const tid of idOrder) {
        const t = tokenMap.get(tid);
        if (t) {
          ordered.push(t);
          tokenMap.delete(tid);
        }
      }
      for (const t of tokenMap.values()) {
        ordered.push(t);
      }

      const updatedMap: GameMap = { ...targetMap, tokens: ordered };
      const nextMaps = fullMaps.map((m) => (m.id === targetMap.id ? updatedMap : m));
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "map",
          map: updatedMap,
        },
      };
    }

    case "spawnPlayerToken": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.playerId !== "string") return null;

      const fullMaps = state.maps.filter(isFullMap);
      const targetMapId = typeof intent.mapId === "string" ? intent.mapId : state.activeMapId;
      const targetMap = fullMaps.find((m) => m.id === targetMapId) ?? fullMaps[0];
      if (!targetMap) return null;

      const spawnPos = targetMap.defaultSpawnPosition ?? {
        x: Math.floor(targetMap.grid.widthCells / 2) + 0.5,
        y: Math.floor(targetMap.grid.heightCells / 2) + 0.5,
      };

      const name =
        typeof intent.name === "string" && intent.name.trim().length > 0
          ? intent.name.trim()
          : "Player";

      // N:1 binding: if the player already owns a sheet, place another
      // token for that sheet instead of minting a duplicate character.
      const owned = findSheetsByOwner(state.sheets, intent.playerId);
      if (owned.length === 1) {
        const sheet = owned[0];
        const { maps: placedMaps, token: spawned } = spawnTokenOnMap(fullMaps, targetMap.id, {
          type: "PlayerToken",
          name: sheet.characterName,
          color: sheet.color,
          iconKind: "Initial",
          x: spawnPos.x,
          y: spawnPos.y,
          sheetId: sheet.id,
          hidden: false,
        });
        if (!spawned) return null;
        const synced: Token = {
          ...spawned,
          ownerUserId: sheet.ownerUserId,
          representsUserId: sheet.representsUserId,
          type: "PlayerToken",
        };
        const syncedMaps = placedMaps.map((m) =>
          m.id === targetMap.id
            ? { ...m, tokens: m.tokens.map((t) => (t.id === synced.id ? synced : t)) }
            : m,
        );
        const nextState: DndMapperState = { ...state, maps: syncedMaps };
        return {
          state: nextState,
          patch: {
            kind: "full",
            state: projectSnapshot(nextState),
          },
        };
      }

      // No sheet (or ambiguous sheets): fall back to creating a fresh pair.
      const paired = insertBoundPair(fullMaps, targetMap.id, {
        name,
        color: typeof intent.color === "string" ? intent.color : null,
        ownerUserId: intent.playerId,
        representsUserId: null,
        type: "PlayerToken",
        iconKind: "Initial",
      }, state.attributeSchema, spawnPos);
      if (!paired) return null;
      const nextSheets = { ...state.sheets, [paired.sheet.id]: paired.sheet };
      const nextState: DndMapperState = { ...state, maps: paired.maps, sheets: nextSheets };
      return {
        state: nextState,
        patch: {
          kind: "full",
          state: projectSnapshot(nextState),
        },
      };
    }

    case "reassignTokenSheet": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.tokenId !== "string") return null;
      const sheetId = typeof intent.sheetId === "string" ? intent.sheetId : null;

      const fullMaps = state.maps.filter(isFullMap);
      const found = findTokenById(fullMaps, intent.tokenId);
      if (!found) return null;

      // N:1 binding: reassigning moves ONLY this token to the target sheet,
      // adopting that sheet's ownership and identity. Sibling tokens are
      // untouched, and no sheet is modified.
      let updatedToken: Token;
      if (sheetId === null) {
        // Unassign: fully unlink the token. It becomes a DM-controlled NPC
        // with no sheet link and no ownership.
        updatedToken = {
          ...found.token,
          type: "NPCToken",
          ownerUserId: null,
          representsUserId: null,
          sheetId: null,
        };
      } else {
        const target = state.sheets[sheetId];
        if (!target) return null;
        updatedToken = {
          ...found.token,
          type: target.ownerUserId !== null ? "PlayerToken" : "NPCToken",
          ownerUserId: target.ownerUserId,
          representsUserId: target.representsUserId,
          name: target.characterName,
          color: target.color,
          sheetId: target.id,
        };
      }

      const nextMaps = fullMaps.map((m) => {
        if (m.id === found.map.id) {
          return {
            ...m,
            tokens: m.tokens.map((t) => (t.id === found.token.id ? updatedToken : t)),
          };
        }
        return m;
      });

      const nextState: DndMapperState = {
        ...state,
        maps: nextMaps,
      };

      return {
        state: nextState,
        patch: {
          kind: "full",
          state: projectSnapshot(nextState),
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
    case "placeImage":
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

    case "reorderImages":
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

    case "lockImage":
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

    case "deleteImage":
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
    case "setFogBitset": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string" || typeof intent.mask !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;

      const nextMaps = fullMaps.map((m) =>
        m.id === intent.mapId ? { ...m, fogMask: intent.mask as string } : m,
      );
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "fog",
          mapId: intent.mapId,
          mask: intent.mask as string,
        },
      };
    }

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

    case "hideAllFog":
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

    case "revealAllFog":
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

    // ── Markup (Phase 10) ───────────────────────────────────────────────────
    case "updateMarkup": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string") return null;
      if (intent.markupSvg !== null && typeof intent.markupSvg !== "string") return null;
      if (typeof intent.markupSvg === "string") {
        if (intent.markupSvg.length > 200_000) return null;
        if (!validateMarkupSvg(intent.markupSvg)) return null;
      }
      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;

      const nextMarkup = intent.markupSvg;
      const nextMaps = state.maps.map((m) =>
        m.id === targetMap.id && isFullMap(m) ? { ...m, markupSvg: nextMarkup } : m,
      );
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "markup",
          mapId: targetMap.id,
          markupSvg: nextMarkup,
        },
      };
    }

    case "clearMarkup": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string") return null;
      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;

      const nextMaps = state.maps.map((m) =>
        m.id === targetMap.id && isFullMap(m) ? { ...m, markupSvg: null } : m,
      );
      const nextState: DndMapperState = { ...state, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "markup",
          mapId: targetMap.id,
          markupSvg: null,
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

    case "clearFocusRect": {
      if (!isDm(state, fromId)) return null;
      const nextState: DndMapperState = { ...state, focusRect: null };
      return {
        state: nextState,
        patch: {
          kind: "focusRect",
          rect: null,
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

    // ── Settings, Lifecycle & Campaign Saves (Phase 11) ──────────────────────
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

    case "endSession": {
      if (!isDm(state, fromId)) return null;
      const nextState: DndMapperState = { ...state, phase: "Lobby" };
      return {
        state: nextState,
        patch: {
          kind: "phase",
          phase: "Lobby",
        },
      };
    }

    case "syncClientState": {
      return {
        state,
        patch: {
          kind: "full",
          state: projectSnapshot(state),
        },
      };
    }

    case "saveCampaign":
    case "loadCampaign":
    case "deleteCampaignSave": {
      if (!isDm(state, fromId)) return null;
      return { state, patch: null };
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
      // N:1 binding: imported campaigns may predate sheets entirely —
      // repair orphan tokens and normalize color flags before going live.
      // Sheet-only sheets are kept as-is.
      const repaired = ensureBoundPairs(
        allMaps,
        header.sheets ?? {},
        activeMapId,
        header.attributeSchema ?? state.attributeSchema,
      );
      const nextState: DndMapperState = {
        ...state,
        phase: "Playing",
        settings: header.settings ?? state.settings,
        attributeSchema: header.attributeSchema ?? state.attributeSchema,
        activeMapId,
        sheets: repaired.sheets,
        customTemplates: header.customTemplates ?? {},
        globalRollTemplates: header.globalRollTemplates ?? [],
        activeSchemaTemplateId: header.activeSchemaTemplateId ?? null,
        initiativeAttributeName: header.initiativeAttributeName ?? null,
        activeCombat: header.activeCombat ?? null,
        loadedDiceRules: header.loadedDiceRules ?? [],
        maps: repaired.maps,
        // Ephemeral marker so every client can notify once that the DM
        // loaded a save. Uses the import token as the id (unique per load)
        // and the authority clock — no `Date` in the sandbox.
        announcement: { id: intent.token as string, loadedAt: now },
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

      // Auto-spawn on session start:
      // For each connected player (excluding the host/DM — the host is not a
      // player and owns anything unassigned) lacking an active token on active
      // map, spawn one
      let spawnedTokensCount = 0;
      if (roster && roster.length > 0) {
        const fullMaps = nextMaps.filter(isFullMap);
        const targetMap = fullMaps.find((m) => m.id === nextActiveMapId);
        if (targetMap) {
          const spawnPos = targetMap.defaultSpawnPosition ?? {
            x: Math.floor(targetMap.grid.widthCells / 2) + 0.5,
            y: Math.floor(targetMap.grid.heightCells / 2) + 0.5,
          };
          // N:1 binding: a player lacking a token on the active map gets one.
          // If they already own a sheet, the token is placed for that sheet;
          // otherwise a fresh sheet is seeded from their display name.
          let nextSheets: Record<string, CharacterSheet> = { ...state.sheets };
          for (const player of roster) {
            if (player.id === state.dmPlayerId) continue;
            const currentTarget = nextMaps.filter(isFullMap).find((m) => m.id === targetMap.id);
            const hasToken = currentTarget?.tokens.some((t) => t.ownerUserId === player.id);
            if (hasToken) continue;
            const owned = findSheetsByOwner(nextSheets, player.id);
            if (owned.length === 1) {
              const sheet = owned[0];
              const { maps: placedMaps, token: spawned } = spawnTokenOnMap(
                nextMaps.filter(isFullMap),
                targetMap.id,
                {
                  type: "PlayerToken",
                  name: sheet.characterName,
                  color: sheet.color,
                  iconKind: "Initial",
                  x: spawnPos.x,
                  y: spawnPos.y,
                  sheetId: sheet.id,
                  hidden: false,
                },
              );
              if (!spawned) continue;
              const synced: Token = {
                ...spawned,
                ownerUserId: sheet.ownerUserId,
                representsUserId: sheet.representsUserId,
                type: "PlayerToken",
              };
              nextMaps = placedMaps.map((m) =>
                m.id === targetMap.id
                  ? { ...m, tokens: m.tokens.map((t) => (t.id === synced.id ? synced : t)) }
                  : m,
              );
              spawnedTokensCount++;
              continue;
            }
            if (owned.length === 0) {
              const paired = insertBoundPair(nextMaps.filter(isFullMap), targetMap.id, {
                name: player.displayName || "Player",
                color: null,
                ownerUserId: player.id,
                representsUserId: null,
                type: "PlayerToken",
                iconKind: "Initial",
              }, state.attributeSchema, spawnPos);
              if (!paired) continue;
              nextMaps = paired.maps;
              nextSheets = { ...nextSheets, [paired.sheet.id]: paired.sheet };
              spawnedTokensCount++;
            }
          }
          if (spawnedTokensCount > 0) {
            const nextStateWithPairs: DndMapperState = {
              ...state,
              phase: "Playing",
              maps: nextMaps,
              activeMapId: nextActiveMapId,
              sheets: nextSheets,
            };
            return {
              state: nextStateWithPairs,
              patch: {
                kind: "full",
                state: projectSnapshot(nextStateWithPairs),
              },
            };
          }
        }
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

      // N:1 binding: a sheet is created tokenless (global roster). Tokens
      // are placed explicitly via spawnToken with the sheet's id.
      // An explicit color marks the sheet as manually overridden; otherwise
      // the color is seeded from the sheet name.
      const explicitColor =
        typeof intent.color === "string" && intent.color.trim().length > 0
          ? intent.color
          : null;
      // The sheet starts tokenless; extra tokens are placed explicitly.
      const sheet: CharacterSheet = {
        id: generateGuid(),
        ownerUserId,
        representsUserId: null,
        characterName: name,
        values: defaultSheetValues(state.attributeSchema),
        notes: "",
        hp: null,
        maxHp: null,
        armorClass: null,
        color: explicitColor ?? seedColorForName(name),
        colorOverridden: explicitColor !== null,
        scopedMapId: typeof intent.scopedMapId === "string" ? intent.scopedMapId : null,
        statusEffects: [],
        rollTemplates: [],
      };

      const nextSheets = { ...state.sheets, [sheet.id]: sheet };
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
      const nextNotes = typeof patch.notes === "string" ? patch.notes : sheet.notes;
      const nextScope = patch.scopedMapId !== undefined
        ? (typeof patch.scopedMapId === "string" ? patch.scopedMapId : null)
        : sheet.scopedMapId;

      // Color: an explicit pick freezes the pair's color identifier, while a
      // rename re-seeds it from the new name until manually overridden.
      let nextColor = sheet.color;
      let nextOverridden = sheet.colorOverridden ?? false;
      if (typeof patch.color === "string" && patch.color !== sheet.color) {
        nextColor = patch.color;
        nextOverridden = true;
      } else if (nextName !== sheet.characterName && !nextOverridden) {
        nextColor = seedColorForName(nextName);
      }

      const updatedSheet: CharacterSheet = {
        ...sheet,
        characterName: nextName,
        color: nextColor,
        colorOverridden: nextOverridden,
        notes: nextNotes,
        scopedMapId: nextScope,
      };

      // All bound tokens mirror the sheet's identity (name/color).
      // Ownership is never touched here — see the assign intents.
      const fullMaps = state.maps.filter(isFullMap);
      const bound = findBoundTokens(fullMaps, sheet.id);
      if (bound.length === 0) {
        const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
        const nextState: DndMapperState = { ...state, sheets: nextSheets };
        return {
          state: nextState,
          patch: { kind: "sheet", sheet: updatedSheet },
        };
      }
      const nextMaps = state.maps.map((m) => {
        if (!isFullMap(m)) return m;
        let changed = false;
        const nextTokens = m.tokens.map((t) => {
          if (t.sheetId !== sheet.id) return t;
          const mirrored = mirrorSheetIdentityToToken(t, updatedSheet);
          if (mirrored !== t) changed = true;
          return mirrored;
        });
        return changed ? { ...m, tokens: nextTokens } : m;
      });

      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets, maps: nextMaps };
      return {
        state: nextState,
        patch: {
          kind: "full",
          state: projectSnapshot(nextState),
        },
      };
    }

    case "deleteSheet": {
      if (typeof intent.sheetId !== "string") return null;
      if (!isDm(state, fromId)) return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;

      // N:1 binding: deleting a sheet deletes ALL of its tokens (across all
      // maps), plus their combat seats.
      const removedTokenIds = new Set<string>();
      const nextMaps = state.maps.map((m) => {
        if (!isFullMap(m)) return m;
        const remaining = m.tokens.filter((t) => {
          if (t.sheetId === intent.sheetId) {
            removedTokenIds.add(t.id);
            return false;
          }
          return true;
        });
        return remaining.length === m.tokens.length ? m : { ...m, tokens: remaining };
      });

      const nextCombat = stripCombatantsByTokenIds(state.activeCombat, removedTokenIds);

      const nextSheets = { ...state.sheets };
      delete nextSheets[intent.sheetId];
      const nextState: DndMapperState = {
        ...state,
        sheets: nextSheets,
        maps: nextMaps,
        activeCombat: nextCombat,
      };
      if (removedTokenIds.size > 0 || nextCombat !== state.activeCombat) {
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
        patch: { kind: "sheetRemoved", sheetId: intent.sheetId },
      };
    }

    case "duplicateSheet": {
      if (typeof intent.sheetId !== "string") return null;
      if (!isDm(state, fromId)) return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;

      // N:1 binding: the clone is sheet-only (no token). Tokens are placed
      // explicitly via spawnToken.
      const newId = generateGuid();
      const cloneName = `${sheet.characterName} (copy)`;
      const clone: CharacterSheet = {
        ...sheet,
        id: newId,
        characterName: cloneName,
        ownerUserId: null,
        representsUserId: null,
        statusEffects: (sheet.statusEffects || []).map((e) => ({ ...e })),
        rollTemplates: (sheet.rollTemplates || []).map((r) => ({ ...r })),
      };

      const nextSheets = { ...state.sheets, [newId]: clone };
      const nextState: DndMapperState = { ...state, sheets: nextSheets };
      return {
        state: nextState,
        patch: {
          kind: "full",
          state: projectSnapshot(nextState),
        },
      };
    }

    case "assignCharacterToPlayer":
    case "assignSheetOwner": {
      if (typeof intent.sheetId !== "string") return null;
      if (!isDm(state, fromId)) return null;
      const sheet = state.sheets[intent.sheetId];
      if (!sheet) return null;

      const nextOwner =
        typeof intent.playerId === "string"
          ? intent.playerId
          : typeof intent.ownerUserId === "string"
            ? intent.ownerUserId
            : null;

      const updatedSheet: CharacterSheet = {
        ...sheet,
        ownerUserId: nextOwner,
        representsUserId: nextOwner !== null ? null : sheet.representsUserId,
      };

      // Assigning a sheet assigns ALL of its tokens too: every bound token
      // takes the sheet's owner (and re-mirrors identity), so a sheet's
      // tokens never end up split across players. Moving a single token
      // elsewhere is reassignTokenSheet's job.
      let tokenUpdated = false;
      const nextMaps = state.maps.map((m) => {
        if (!isFullMap(m)) return m;
        let changed = false;
        const nextTokens = m.tokens.map((t) => {
          if (t.sheetId === sheet.id) {
            changed = true;
            tokenUpdated = true;
            // Pass the original token so the type flips exactly when the
            // owner actually changed hands.
            return mirrorSheetToToken(t, updatedSheet);
          }
          return t;
        });
        return changed ? { ...m, tokens: nextTokens } : m;
      });

      const nextSheets = { ...state.sheets, [sheet.id]: updatedSheet };
      const nextState: DndMapperState = { ...state, sheets: nextSheets, maps: nextMaps };
      if (tokenUpdated) {
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

      // N:1 binding: a templated sheet is created tokenless. The template
      // color counts as an explicit pick, so it never reseeds on rename.
      // Tokens are placed explicitly via spawnToken.
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
        color: template.color || seedColorForName(name),
        colorOverridden: Boolean(template.color),
        scopedMapId: typeof intent.scopedMapId === "string" ? intent.scopedMapId : null,
        statusEffects: [],
        rollTemplates: Array.isArray(template.rollTemplates) ? [...template.rollTemplates] : [],
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
      const isCombatActive = state.activeCombat !== null;
      const roll = executeRoll(intent.formula, mode, fromId, {
        nowMs: now,
        label: typeof intent.label === "string" ? intent.label : undefined,
        tokenId: typeof intent.tokenId === "string" ? intent.tokenId : null,
        sheetId: typeof intent.sheetId === "string" ? intent.sheetId : null,
        attributeName: typeof intent.attributeName === "string" ? intent.attributeName : null,
        sheets: state.sheets,
        loadedDiceRules: state.loadedDiceRules,
        loadedDiceEnabled: state.settings.loadedDiceEnabled,
        activeMapId: state.activeMapId,
        isCombatActive,
        hostHeldKeys: state.hostHeldKeys,
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

      const isCombatActive = state.activeCombat !== null;
      const roll = executeRoll(template.dice, mode, fromId, {
        nowMs: now,
        label: template.label || template.name,
        tokenId: typeof intent.tokenId === "string" ? intent.tokenId : null,
        sheetId,
        attributeName: template.attributeName,
        sheets: state.sheets,
        flatModifierOverride: template.flatModifier,
        loadedDiceRules: state.loadedDiceRules,
        loadedDiceEnabled: state.settings.loadedDiceEnabled,
        activeMapId: state.activeMapId,
        isCombatActive,
        hostHeldKeys: state.hostHeldKeys,
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

    // ── Phase 8: Loaded Dice ─────────────────────────────────────────────────────

    case "createLoadedDiceRule": {
      if (!isDm(state, fromId)) return null;
      const rule = intent.rule as Omit<LoadedDiceRule, "id"> | undefined;
      if (
        !rule ||
        typeof rule.name !== "string" ||
        !Array.isArray(rule.conditions) ||
        !Array.isArray(rule.modifications)
      ) {
        return null;
      }

      const newRule: LoadedDiceRule = {
        id: generateGuid(),
        name: rule.name.trim() || "New Loaded Dice Rule",
        enabled: typeof rule.enabled === "boolean" ? rule.enabled : true,
        targetSheetIds: Array.isArray(rule.targetSheetIds) ? [...rule.targetSheetIds] : [],
        conditions: [...rule.conditions],
        modifications: [...rule.modifications],
      };

      const nextRules = [...state.loadedDiceRules, newRule];
      const nextState: DndMapperState = { ...state, loadedDiceRules: nextRules };
      return { state: nextState, patch: { kind: "loadedDiceRules", rules: nextRules } };
    }

    case "updateLoadedDiceRule": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.ruleId !== "string" || !intent.patch) return null;
      const index = state.loadedDiceRules.findIndex((r) => r.id === intent.ruleId);
      if (index === -1) return null;

      const existing = state.loadedDiceRules[index];
      const patch = intent.patch as Partial<LoadedDiceRule>;
      const updated: LoadedDiceRule = {
        ...existing,
        name: typeof patch.name === "string" ? patch.name.trim() : existing.name,
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : existing.enabled,
        targetSheetIds: Array.isArray(patch.targetSheetIds)
          ? [...patch.targetSheetIds]
          : existing.targetSheetIds,
        conditions: Array.isArray(patch.conditions) ? [...patch.conditions] : existing.conditions,
        modifications: Array.isArray(patch.modifications)
          ? [...patch.modifications]
          : existing.modifications,
      };

      const nextRules = [...state.loadedDiceRules];
      nextRules[index] = updated;
      const nextState: DndMapperState = { ...state, loadedDiceRules: nextRules };
      return { state: nextState, patch: { kind: "loadedDiceRules", rules: nextRules } };
    }

    case "deleteLoadedDiceRule": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.ruleId !== "string") return null;

      const nextRules = state.loadedDiceRules.filter((r) => r.id !== intent.ruleId);
      const nextState: DndMapperState = { ...state, loadedDiceRules: nextRules };
      return { state: nextState, patch: { kind: "loadedDiceRules", rules: nextRules } };
    }

    case "toggleLoadedDiceRule": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.ruleId !== "string" || typeof intent.enabled !== "boolean") return null;

      const index = state.loadedDiceRules.findIndex((r) => r.id === intent.ruleId);
      if (index === -1) return null;

      const nextRules = [...state.loadedDiceRules];
      nextRules[index] = { ...nextRules[index], enabled: intent.enabled };
      const nextState: DndMapperState = { ...state, loadedDiceRules: nextRules };
      return { state: nextState, patch: { kind: "loadedDiceRules", rules: nextRules } };
    }

    case "reorderLoadedDiceRules": {
      if (!isDm(state, fromId)) return null;
      if (!Array.isArray(intent.ruleIds)) return null;

      const idMap = new Map(state.loadedDiceRules.map((r) => [r.id, r]));
      const nextRules: LoadedDiceRule[] = [];
      for (const id of intent.ruleIds) {
        const r = idMap.get(id);
        if (r) {
          nextRules.push(r);
          idMap.delete(id);
        }
      }
      for (const r of idMap.values()) {
        nextRules.push(r);
      }

      const nextState: DndMapperState = { ...state, loadedDiceRules: nextRules };
      return { state: nextState, patch: { kind: "loadedDiceRules", rules: nextRules } };
    }

    case "updateHostKeys": {
      if (!isDm(state, fromId)) return null;
      if (!Array.isArray(intent.heldKeys)) return null;

      const normalized = Array.from(
        new Set(intent.heldKeys.map((k) => String(k).toUpperCase())),
      );
      const nextState: DndMapperState = { ...state, hostHeldKeys: normalized };
      return { state: nextState, patch: { kind: "hostKeys", keys: normalized } };
    }

    // ── Phase 9: Combat & Initiative ─────────────────────────────────────────────

    case "startCombat": {
      if (!isDm(state, fromId)) return null;
      if (typeof intent.mapId !== "string") return null;

      const fullMaps = state.maps.filter(isFullMap);
      const targetMap = fullMaps.find((m) => m.id === intent.mapId);
      if (!targetMap) return null;

      const npcTokenIds = Array.isArray(intent.npcTokenIds) ? (intent.npcTokenIds as string[]) : null;
      const eligibleTokens = targetMap.tokens.filter((t) => {
        if (npcTokenIds) {
          return (!t.hidden && (t.type === "PlayerToken" || t.ownerUserId !== null)) || npcTokenIds.includes(t.id);
        }
        return !t.hidden;
      });

      const turnOrder: CombatantEntry[] = eligibleTokens.map((token) => {
        const sheet = token.sheetId ? state.sheets[token.sheetId] : null;
        const name = (sheet ? sheet.characterName : token.name) || "Combatant";
        const ownerUserId = token.ownerUserId ?? sheet?.ownerUserId ?? null;
        return {
          id: generateGuid(),
          tokenId: token.id,
          name,
          ownerUserId,
          initiativeRoll: null,
          isForceRolled: false,
          pendingInitiative: null,
        };
      });

      const combat: CombatState = {
        phase: "WaitingForRolls",
        roundNumber: 1,
        currentTurnIndex: 0,
        turnOrder,
      };

      const nextState: DndMapperState = { ...state, activeCombat: combat };
      return { state: nextState, patch: { kind: "combat", combat } };
    }

    case "endCombat": {
      if (!isDm(state, fromId)) return null;
      const nextState: DndMapperState = { ...state, activeCombat: null };
      return { state: nextState, patch: { kind: "combat", combat: null } };
    }

    case "nextTurn": {
      if (!isDm(state, fromId)) return null;
      if (!state.activeCombat || state.activeCombat.phase !== "Active") return null;
      const nextCombat = advanceTurn(state.activeCombat);
      const nextState: DndMapperState = { ...state, activeCombat: nextCombat };
      return { state: nextState, patch: { kind: "combat", combat: nextCombat } };
    }

    case "previousTurn": {
      if (!isDm(state, fromId)) return null;
      if (!state.activeCombat || state.activeCombat.phase !== "Active") return null;
      const nextCombat = reverseTurn(state.activeCombat);
      const nextState: DndMapperState = { ...state, activeCombat: nextCombat };
      return { state: nextState, patch: { kind: "combat", combat: nextCombat } };
    }

    case "rollInitiative": {
      if (!state.activeCombat) return null;
      if (typeof intent.combatantId !== "string") return null;

      const combatant = state.activeCombat.turnOrder.find((c) => c.id === intent.combatantId);
      if (!combatant) return null;
      if (!isDm(state, fromId) && combatant.ownerUserId !== fromId) return null;

      let score: number;
      let nextRollLog = state.rollLog;
      if (typeof intent.rollOverride === "number") {
        score = intent.rollOverride;
      } else {
        const fullMaps = state.maps.filter(isFullMap);
        let token: Token | null = null;
        for (const m of fullMaps) {
          const found = m.tokens.find((t) => t.id === combatant.tokenId);
          if (found) {
            token = found;
            break;
          }
        }
        const sheet = token?.sheetId ? state.sheets[token.sheetId] : null;
        const mod = getInitiativeModifier(sheet, state.initiativeAttributeName);
        const roll = executeRoll("1d20", "Normal", fromId, {
          nowMs: now,
          flatModifierOverride: mod,
          label: `${combatant.name} Initiative`,
          sheetId: token?.sheetId,
          attributeName: state.initiativeAttributeName || "Dexterity",
          sheets: state.sheets,
          loadedDiceRules: state.loadedDiceRules,
          loadedDiceEnabled: state.settings.loadedDiceEnabled,
          activeMapId: state.activeMapId,
          isCombatActive: true,
          hostHeldKeys: state.hostHeldKeys,
        });
        score = roll ? roll.total : Math.floor(Math.random() * 20) + 1 + mod;
        if (roll) {
          nextRollLog = [...state.rollLog, roll].slice(-MAX_ROLL_LOG);
        }
      }

      const nextTurnOrder = state.activeCombat.turnOrder.map((c) =>
        c.id === combatant.id ? { ...c, initiativeRoll: score, isForceRolled: false } : c,
      );

      let nextCombat: CombatState;
      if (isAllRollsComplete(nextTurnOrder)) {
        nextCombat = {
          phase: "Active",
          roundNumber: state.activeCombat.roundNumber,
          currentTurnIndex: 0,
          turnOrder: sortTurnOrder(nextTurnOrder),
        };
      } else {
        nextCombat = { ...state.activeCombat, turnOrder: nextTurnOrder };
      }

      const nextState: DndMapperState = { ...state, activeCombat: nextCombat, rollLog: nextRollLog };
      return { state: nextState, patch: { kind: "combat", combat: nextCombat } };
    }

    case "forceInitiativeRoll": {
      if (!isDm(state, fromId)) return null;
      if (!state.activeCombat) return null;
      if (typeof intent.combatantId !== "string") return null;

      const combatant = state.activeCombat.turnOrder.find((c) => c.id === intent.combatantId);
      if (!combatant) return null;

      let score: number;
      let nextRollLog = state.rollLog;
      if (typeof intent.score === "number") {
        score = intent.score;
      } else {
        const fullMaps = state.maps.filter(isFullMap);
        let token: Token | null = null;
        for (const m of fullMaps) {
          const found = m.tokens.find((t) => t.id === combatant.tokenId);
          if (found) {
            token = found;
            break;
          }
        }
        const sheet = token?.sheetId ? state.sheets[token.sheetId] : null;
        const mod = getInitiativeModifier(sheet, state.initiativeAttributeName);
        const roll = executeRoll("1d20", "Normal", fromId, {
          nowMs: now,
          flatModifierOverride: mod,
          label: `${combatant.name} Forced Initiative`,
          sheetId: token?.sheetId,
          attributeName: state.initiativeAttributeName || "Dexterity",
          sheets: state.sheets,
          loadedDiceRules: state.loadedDiceRules,
          loadedDiceEnabled: state.settings.loadedDiceEnabled,
          activeMapId: state.activeMapId,
          isCombatActive: true,
          hostHeldKeys: state.hostHeldKeys,
        });
        score = roll ? roll.total : Math.floor(Math.random() * 20) + 1 + mod;
        if (roll) {
          nextRollLog = [...state.rollLog, roll].slice(-MAX_ROLL_LOG);
        }
      }

      const nextTurnOrder = state.activeCombat.turnOrder.map((c) =>
        c.id === combatant.id ? { ...c, initiativeRoll: score, isForceRolled: true } : c,
      );

      let nextCombat: CombatState;
      if (isAllRollsComplete(nextTurnOrder)) {
        nextCombat = {
          phase: "Active",
          roundNumber: state.activeCombat.roundNumber,
          currentTurnIndex: 0,
          turnOrder: sortTurnOrder(nextTurnOrder),
        };
      } else {
        nextCombat = { ...state.activeCombat, turnOrder: nextTurnOrder };
      }

      const nextState: DndMapperState = { ...state, activeCombat: nextCombat, rollLog: nextRollLog };
      return { state: nextState, patch: { kind: "combat", combat: nextCombat } };
    }

    case "setNpcInitiative": {
      if (!isDm(state, fromId)) return null;
      if (!state.activeCombat) return null;
      if (typeof intent.combatantId !== "string" || typeof intent.score !== "number") return null;

      const combatant = state.activeCombat.turnOrder.find((c) => c.id === intent.combatantId);
      if (!combatant || combatant.ownerUserId !== null) return null;

      const nextTurnOrder = state.activeCombat.turnOrder.map((c) =>
        c.id === combatant.id ? { ...c, pendingInitiative: intent.score as number } : c,
      );
      const nextCombat: CombatState = { ...state.activeCombat, turnOrder: nextTurnOrder };
      const nextState: DndMapperState = { ...state, activeCombat: nextCombat };
      return { state: nextState, patch: { kind: "combat", combat: nextCombat } };
    }

    case "rollAllUnsetNpcs":
    case "rollAllNpcInitiative": {
      if (!isDm(state, fromId)) return null;
      if (!state.activeCombat) return null;

      const isUnsetOnly = kind === "rollAllUnsetNpcs";
      const fullMaps = state.maps.filter(isFullMap);
      let nextRollLog = state.rollLog;

      const nextTurnOrder = state.activeCombat.turnOrder.map((c) => {
        if (c.ownerUserId !== null) return c;

        // If DM staged a pending value, commit it
        if (c.pendingInitiative !== null) {
          return {
            ...c,
            initiativeRoll: c.pendingInitiative,
            pendingInitiative: null,
          };
        }

        // If unset only and already rolled, leave it
        if (isUnsetOnly && c.initiativeRoll !== null) {
          return c;
        }

        // Roll d20 + modifier
        let token: Token | null = null;
        for (const m of fullMaps) {
          const found = m.tokens.find((t) => t.id === c.tokenId);
          if (found) {
            token = found;
            break;
          }
        }
        const sheet = token?.sheetId ? state.sheets[token.sheetId] : null;
        const mod = getInitiativeModifier(sheet, state.initiativeAttributeName);
        const roll = executeRoll("1d20", "Normal", fromId, {
          nowMs: now,
          flatModifierOverride: mod,
          label: `${c.name} Initiative`,
          sheetId: token?.sheetId,
          attributeName: state.initiativeAttributeName || "Dexterity",
          sheets: state.sheets,
          loadedDiceRules: state.loadedDiceRules,
          loadedDiceEnabled: state.settings.loadedDiceEnabled,
          activeMapId: state.activeMapId,
          isCombatActive: true,
          hostHeldKeys: state.hostHeldKeys,
        });
        const score = roll ? roll.total : Math.floor(Math.random() * 20) + 1 + mod;
        if (roll) {
          nextRollLog = [...nextRollLog, roll].slice(-MAX_ROLL_LOG);
        }
        return {
          ...c,
          initiativeRoll: score,
        };
      });

      let nextCombat: CombatState;
      if (isAllRollsComplete(nextTurnOrder)) {
        nextCombat = {
          phase: "Active",
          roundNumber: state.activeCombat.roundNumber,
          currentTurnIndex: 0,
          turnOrder: sortTurnOrder(nextTurnOrder),
        };
      } else {
        nextCombat = { ...state.activeCombat, turnOrder: nextTurnOrder };
      }

      const nextState: DndMapperState = { ...state, activeCombat: nextCombat, rollLog: nextRollLog };
      return { state: nextState, patch: { kind: "combat", combat: nextCombat } };
    }

    case "addCombatant": {
      if (!isDm(state, fromId)) return null;
      if (!state.activeCombat) return null;
      if (typeof intent.tokenId !== "string" || typeof intent.initiativeRoll !== "number") return null;

      const fullMaps = state.maps.filter(isFullMap);
      let foundToken: Token | null = null;
      for (const m of fullMaps) {
        const t = m.tokens.find((tok) => tok.id === intent.tokenId);
        if (t) {
          foundToken = t;
          break;
        }
      }
      if (!foundToken) return null;

      const sheet = foundToken.sheetId ? state.sheets[foundToken.sheetId] : null;
      const name = (sheet ? sheet.characterName : foundToken.name) || "Combatant";
      const ownerUserId = foundToken.ownerUserId ?? sheet?.ownerUserId ?? null;

      const newCombatant: CombatantEntry = {
        id: generateGuid(),
        tokenId: foundToken.id,
        name,
        ownerUserId,
        initiativeRoll: intent.initiativeRoll,
        isForceRolled: false,
        pendingInitiative: null,
      };

      let nextCombat: CombatState;
      if (state.activeCombat.phase === "Active") {
        const currentActiveId = state.activeCombat.turnOrder[state.activeCombat.currentTurnIndex]?.id;
        const sorted = sortTurnOrder([...state.activeCombat.turnOrder, newCombatant]);
        const nextTurnIndex = sorted.findIndex((c) => c.id === currentActiveId);
        nextCombat = {
          ...state.activeCombat,
          turnOrder: sorted,
          currentTurnIndex: nextTurnIndex >= 0 ? nextTurnIndex : state.activeCombat.currentTurnIndex,
        };
      } else {
        const nextTurnOrder = [...state.activeCombat.turnOrder, newCombatant];
        if (isAllRollsComplete(nextTurnOrder)) {
          nextCombat = {
            phase: "Active",
            roundNumber: state.activeCombat.roundNumber,
            currentTurnIndex: 0,
            turnOrder: sortTurnOrder(nextTurnOrder),
          };
        } else {
          nextCombat = { ...state.activeCombat, turnOrder: nextTurnOrder };
        }
      }

      const nextState: DndMapperState = { ...state, activeCombat: nextCombat };
      return { state: nextState, patch: { kind: "combat", combat: nextCombat } };
    }

    case "removeCombatant": {
      if (!isDm(state, fromId)) return null;
      if (!state.activeCombat) return null;
      if (typeof intent.combatantId !== "string") return null;

      const removedIndex = state.activeCombat.turnOrder.findIndex((c) => c.id === intent.combatantId);
      if (removedIndex === -1) return null;

      const nextTurnOrder = state.activeCombat.turnOrder.filter((c) => c.id !== intent.combatantId);
      let nextTurnIndex = state.activeCombat.currentTurnIndex;
      if (nextTurnOrder.length === 0) {
        nextTurnIndex = 0;
      } else if (removedIndex < state.activeCombat.currentTurnIndex) {
        nextTurnIndex = state.activeCombat.currentTurnIndex - 1;
      } else if (removedIndex === state.activeCombat.currentTurnIndex) {
        nextTurnIndex = state.activeCombat.currentTurnIndex % nextTurnOrder.length;
      }

      const nextCombat: CombatState = {
        ...state.activeCombat,
        turnOrder: nextTurnOrder,
        currentTurnIndex: nextTurnIndex,
      };

      const nextState: DndMapperState = { ...state, activeCombat: nextCombat };
      return { state: nextState, patch: { kind: "combat", combat: nextCombat } };
    }

    default:
      return null;
  }
}
