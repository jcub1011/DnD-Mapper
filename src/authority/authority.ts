/*
 * THE AUTHORITY MODULE — the KnockBox SERVER runs this, sandboxed, one instance
 * per lobby. It is the entry point bundled to `dist/authority.js` and named by
 * `export/GAME.json`'s `"serverAuthority": "authority.js"`.
 *
 * What that means in practice:
 *   - This is the ONLY place the match state actually changes. Clients send
 *     intents and render what comes back; a modified client cannot cheat, because
 *     it never holds the truth.
 *   - The session survives the lobby creator leaving. No browser is the host.
 *   - There is no DOM, no console, no fetch, no timers, and NO `Date` — the
 *     sandbox deletes it. `kb.now()` is the clock. `kb.log.*` is the log.
 *   - It must bundle to a SINGLE file with no top-level imports: the server
 *     configures no module loader. `npm run build:authority` inlines everything
 *     it imports from `src/game/`, and `npm run export:game` re-checks that.
 */

import {
  applyIntent,
  clearPendingImportsForPlayer,
  createState,
  projectSnapshot,
} from "../game/rules";
import type { DndMapperState, Patch, PlayerInfo } from "../game/types";
import { guardSize } from "../game/wire";
import type { Authority, AuthorityConfig, Kb } from "./kb";

export function createAuthority(kb: Kb): Authority {
  let state: DndMapperState = createState([]);
  let roster: PlayerInfo[] = [];

  return {
    init(players: PlayerInfo[]): void {
      roster = [...players];
      state = createState(players);
      kb.log.info(`match authority started with ${players.length} player(s) at ${kb.now()}`);
    },

    applyIntent(fromId: string, action: unknown): Patch | null {
      const result = applyIntent(state, fromId, action, kb.now());
      if (result === null) return null; // illegal intent — broadcast nothing
      state = result.state;
      if (result.patch === null) return null; // staged action with no broadcast
      return guardSize(result.patch, (msg) => kb.log.error(msg));
    },

    snapshot(): DndMapperState {
      // Broadcast mode: snapshot projects the active map in full and others as summaries,
      // keeping the frame well below the 512 KiB ceiling.
      return projectSnapshot(state);
    },

    onPlayerJoined(player: PlayerInfo): Patch | null {
      if (!roster.some((p) => p.id === player.id)) {
        roster.push(player);
      }
      if (state.dmPlayerId === null && roster.length > 0) {
        const first = roster[0].id;
        state = { ...state, dmPlayerId: first };
        kb.setOwner(first);
      }
      return null; // server re-broadcasts state after roster changes
    },

    onPlayerLeft(playerId: string): Patch | null {
      clearPendingImportsForPlayer(playerId);
      roster = roster.filter((p) => p.id !== playerId);

      // OWNER SUCCESSION: If the DM drops, promote the next longest-standing player in the lobby.
      if (playerId === state.dmPlayerId) {
        const successor = roster.length > 0 ? roster[0].id : null;
        if (successor) {
          kb.setOwner(successor);
          state = { ...state, dmPlayerId: successor };
          kb.log.info(`dm left; promoted ${successor}`);
          return { kind: "dm", dmPlayerId: successor };
        }
        state = { ...state, dmPlayerId: null };
      }

      return null;
    },
  };
}

/**
 * Broadcast mode with client-side hiding (legacy parity) and event-driven sim.
 * No tick exported means no server-side simulation timer is created.
 */
export const config: AuthorityConfig = {};
