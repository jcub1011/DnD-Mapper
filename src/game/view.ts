/*
 * MatchView — the replicated state plus (on the host) the truth.
 *
 * This implements BOTH halves of the KBAuthority model contract:
 *
 *   host  `applyIntent(fromId, action)` → Patch | null  (DM browser only)
 *   host  `snapshot(forPlayerId?)` → shared projected snapshot
 *   guest `applyPatch` / `applySnapshot` — adopt what the host publishes
 *
 * KBAuthority enforces the roles: only the host's `applyIntent` is ever called,
 * and the host never adopts `delta`/`state` echoes. Patches stay absolute.
 */

import type { CharacterSheet, DndMapperState, GameMap, MapSummary, Token } from "./domain.js";
import {
  createDefaultDndMapperState,
  isFullMap,
  MAX_ROLL_LOG,
  reconcileSheetValues,
} from "./domain.js";
import { applyIntent as applyIntentRules, projectForPlayer, projectSnapshot } from "./rules.js";
import type { Patch, PlayerInfo } from "./types.js";
import { guardSize } from "./wire.js";
import { createLogger } from "../log.js";

const log = createLogger("view");

export class MatchView {
  private _state: DndMapperState = createDefaultDndMapperState();
  private _roster: readonly PlayerInfo[] = [];

  /** The latest state the authority published. Treat it as read-only. */
  get state(): Readonly<DndMapperState> {
    return this._state;
  }

  /**
   * Host only. The controller feeds the lobby roster here (see
   * `AuthorityController.emitRoster`) so DM-gated intents validate against the
   * same membership the server module used to see. Mirrors the authority
   * module's init: an empty DM slot seeds to the first roster member.
   */
  setRoster(roster: readonly PlayerInfo[]): void {
    this._roster = roster;
    if (this._state.dmPlayerId === null && roster.length > 0) {
      this._state = { ...this._state, dmPlayerId: roster[0].id };
    }
  }

  /**
   * Host only — validate an untrusted intent, mutate, and return the narrowed
   * absolute patch to broadcast. Null means REJECTED (broadcast nothing).
   * The browser host owns its clock, so `Date.now()` replaces `kb.now()`.
   */
  applyIntent(fromId: string, action: unknown): Patch | null {
    const result = applyIntentRules(this._state, fromId, action, Date.now(), this._roster);
    if (result === null || result.patch === null) return null;
    this._state = result.state;
    return guardSize(result.patch, (msg) => log.error(msg));
  }

  /**
   * Host only — the state projected for one player (sync / join / reconnect,
   * roster-change re-push). The DM gets the shared snapshot unchanged; every
   * other player gets `projectForPlayer` filtering (hidden tokens/images
   * dropped, sheets gated + redacted, rolls/combat/dice gated). Fog stays
   * broadcast (documented legacy leak).
   */
  snapshot(forPlayerId?: string): DndMapperState {
    if (forPlayerId === undefined) return projectSnapshot(this._state);
    return projectForPlayer(this._state, forPlayerId);
  }

  /** Full state snapshot, on join / reconnect. */
  applySnapshot(state: DndMapperState): void {
    this._state = state;
  }

  /**
   * Applies a broadcast delta. Patches carry absolute values, merged by kind.
   */
  applyPatch(patch: Patch): void {
    switch (patch.kind) {
      case "full": {
        this._state = patch.state;
        break;
      }

      case "token": {
        const token = patch.token;
        const nextMaps = this._state.maps.map((m) => {
          if (m.id !== token.mapId) return m;
          if (isFullMap(m)) {
            const exists = m.tokens.some((t) => t.id === token.id);
            const nextTokens: readonly Token[] = exists
              ? m.tokens.map((t) => (t.id === token.id ? token : t))
              : [...m.tokens, token];
            return { ...m, tokens: nextTokens };
          } else {
            return {
              id: m.id,
              name: m.name,
              listOrder: m.listOrder,
              grid: {
                widthCells: m.widthCells,
                heightCells: m.heightCells,
                cellPixels: 50,
                showGridLines: true,
                snapToGrid: true,
                lineColor: "#222",
              },
              images: [],
              tokens: [token],
              createdUtc: "",
              defaultSpawnPosition: null,
              markupSvg: null,
              fogMask: "",
            };
          }
        });
        this._state = { ...this._state, maps: nextMaps };
        break;
      }

      case "tokenRemoved": {
        const tokenId = patch.tokenId;
        const nextMaps = this._state.maps.map((m) => {
          if (!isFullMap(m)) return m;
          const filtered = m.tokens.filter((t) => t.id !== tokenId);
          return filtered.length === m.tokens.length ? m : { ...m, tokens: filtered };
        });
        this._state = { ...this._state, maps: nextMaps };
        break;
      }

      case "fog": {
        const nextMaps = this._state.maps.map((m) => {
          if (!isFullMap(m) || m.id !== patch.mapId) return m;
          return { ...m, fogMask: patch.mask };
        });
        this._state = { ...this._state, maps: nextMaps };
        break;
      }

      case "markup": {
        const nextMaps = this._state.maps.map((m) => {
          if (!isFullMap(m) || m.id !== patch.mapId) return m;
          return { ...m, markupSvg: patch.markupSvg };
        });
        this._state = { ...this._state, maps: nextMaps };
        break;
      }

      case "image": {
        const image = patch.image;
        let found = false;
        let nextMaps = this._state.maps.map((m) => {
          if (!isFullMap(m)) return m;
          const idx = m.images.findIndex((img) => img.id === image.id);
          if (idx !== -1) {
            found = true;
            const updated = [...m.images];
            updated[idx] = image;
            return { ...m, images: updated };
          }
          return m;
        });

        // If not already in an existing map, add to the active map
        if (!found && this._state.activeMapId) {
          nextMaps = nextMaps.map((m) => {
            if (isFullMap(m) && m.id === this._state.activeMapId) {
              return { ...m, images: [...m.images, image] };
            }
            return m;
          });
        }
        this._state = { ...this._state, maps: nextMaps };
        break;
      }

      case "imageRemoved": {
        const imageId = patch.imageId;
        const nextMaps = this._state.maps.map((m) => {
          if (!isFullMap(m)) return m;
          const filtered = m.images.filter((img) => img.id !== imageId);
          return filtered.length === m.images.length ? m : { ...m, images: filtered };
        });
        this._state = { ...this._state, maps: nextMaps };
        break;
      }

      case "grid": {
        const nextMaps = this._state.maps.map((m) => {
          if (!isFullMap(m) || m.id !== patch.mapId) return m;
          return { ...m, grid: patch.grid };
        });
        this._state = { ...this._state, maps: nextMaps };
        break;
      }

      case "activeMap": {
        this._state = { ...this._state, activeMapId: patch.mapId };
        break;
      }

      case "focusRect": {
        this._state = { ...this._state, focusRect: patch.rect };
        break;
      }

      case "centerViewport": {
        this._state = { ...this._state, pendingCenterRequest: patch.request };
        break;
      }

      case "settings": {
        this._state = { ...this._state, settings: patch.settings };
        break;
      }

      case "mapList": {
        const summariesById = new Map<string, MapSummary>();
        for (const s of patch.maps) {
          summariesById.set(s.id, s);
        }

        const existingById = new Map<string, GameMap | MapSummary>();
        for (const m of this._state.maps) {
          existingById.set(m.id, m);
        }

        const merged: Array<GameMap | MapSummary> = [];
        for (const summary of patch.maps) {
          const existing = existingById.get(summary.id);
          if (existing && isFullMap(existing)) {
            // Keep full map data, updating metadata
            merged.push({
              ...existing,
              name: summary.name,
              listOrder: summary.listOrder,
              grid: {
                ...existing.grid,
                widthCells: summary.widthCells,
                heightCells: summary.heightCells,
              },
            });
          } else {
            merged.push(summary);
          }
        }

        this._state = { ...this._state, maps: merged };
        break;
      }

      case "map": {
        const fullMap = patch.map;
        const exists = this._state.maps.some((m) => m.id === fullMap.id);
        const nextMaps = exists
          ? this._state.maps.map((m) => (m.id === fullMap.id ? fullMap : m))
          : [...this._state.maps, fullMap];
        const nextActive = this._state.activeMapId ?? fullMap.id;
        this._state = { ...this._state, maps: nextMaps, activeMapId: nextActive };
        break;
      }

      case "dm": {
        this._state = { ...this._state, dmPlayerId: patch.dmPlayerId };
        break;
      }

      case "phase": {
        this._state = { ...this._state, phase: patch.phase };
        break;
      }

      case "sheet": {
        const nextSheets = { ...this._state.sheets, [patch.sheet.id]: patch.sheet };
        this._state = { ...this._state, sheets: nextSheets };
        break;
      }

      case "sheetRemoved": {
        const nextSheets = { ...this._state.sheets };
        delete nextSheets[patch.sheetId];
        this._state = { ...this._state, sheets: nextSheets };
        break;
      }

      case "schema": {
        const nextSheets: Record<string, CharacterSheet> = {};
        for (const [id, s] of Object.entries(this._state.sheets)) {
          nextSheets[id] = reconcileSheetValues(s, patch.schema);
        }
        this._state = {
          ...this._state,
          attributeSchema: patch.schema,
          initiativeAttributeName: patch.initiativeAttributeName,
          sheets: nextSheets,
        };
        break;
      }

      case "effectTemplate": {
        const nextTemplates = {
          ...this._state.statusEffectTemplates,
          [patch.template.id]: patch.template,
        };
        this._state = { ...this._state, statusEffectTemplates: nextTemplates };
        break;
      }

      case "effectTemplateRemoved": {
        const nextTemplates = { ...this._state.statusEffectTemplates };
        delete nextTemplates[patch.templateId];
        this._state = { ...this._state, statusEffectTemplates: nextTemplates };
        break;
      }

      case "customTemplate": {
        const nextTemplates = {
          ...this._state.customTemplates,
          [patch.template.id]: patch.template,
        };
        this._state = { ...this._state, customTemplates: nextTemplates };
        break;
      }

      case "customTemplateRemoved": {
        const nextTemplates = { ...this._state.customTemplates };
        delete nextTemplates[patch.templateId];
        this._state = { ...this._state, customTemplates: nextTemplates };
        break;
      }

      case "roll": {
        const nextRollLog = [...this._state.rollLog, patch.roll].slice(-MAX_ROLL_LOG);
        this._state = { ...this._state, rollLog: nextRollLog };
        break;
      }

      case "rollLogCleared": {
        this._state = { ...this._state, rollLog: [] };
        break;
      }

      case "globalRollTemplates": {
        this._state = { ...this._state, globalRollTemplates: patch.templates };
        break;
      }

      case "loadedDiceRules": {
        this._state = { ...this._state, loadedDiceRules: patch.rules };
        break;
      }

      case "hostKeys": {
        this._state = { ...this._state, hostHeldKeys: patch.keys };
        break;
      }

      case "combat": {
        this._state = { ...this._state, activeCombat: patch.combat };
        break;
      }
    }
  }
}
