/*
 * MatchView — the CLIENT-side replica of the authoritative state.
 *
 * This is the guest half of the KBAuthority model contract. In server-authority
 * mode every client is a guest, so only `applyPatch` / `applySnapshot` are ever
 * called: the client ADOPTS state, it never computes it.
 *
 * Merges narrowed absolute patches by kind instead of replacing wholesale.
 */

import type { DndMapperState, GameMap, MapSummary, Token } from "./domain.js";
import { createDefaultDndMapperState, isFullMap } from "./domain.js";
import type { Patch } from "./types.js";

export class MatchView {
  private _state: DndMapperState = createDefaultDndMapperState();

  /** The latest state the authority published. Treat it as read-only. */
  get state(): Readonly<DndMapperState> {
    return this._state;
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
    }
  }
}
