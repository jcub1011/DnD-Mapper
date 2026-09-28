/*
 * MatchView — the host store. The DM's browser holds the truth here.
 *
 * This implements the per-recipient KBAuthority model contract:
 *
 *   `applyIntent(fromId, action)` → Patch | null  (non-null = accepted)
 *   `snapshot(forPlayerId?)` → the state projected for one player
 *
 * KBAuthority only ever calls these on the host. Guests keep no model: they
 * render the per-player snapshot the host sends them (`currentView`), so the
 * returned patch is an accept signal and is never put on the wire.
 */

import type { DndMapperState } from "./domain.js";
import { createDefaultDndMapperState, isFullMap } from "./domain.js";
import {
  applyIntent as applyIntentRules,
  ensureBoundPairs,
  handlePlayerLeft as handlePlayerLeftRules,
  projectForPlayer,
  projectSnapshot,
} from "./rules.js";
import { generateGuid } from "./maps.js";
import type { Patch, PlayerInfo } from "./types.js";

export class MatchView {
  private _state: DndMapperState = createDefaultDndMapperState();
  private _roster: readonly PlayerInfo[] = [];

  /** The host's live truth. Treat it as read-only. */
  get state(): Readonly<DndMapperState> {
    return this._state;
  }

  /**
   * The controller feeds the lobby roster here (see
   * `AuthorityController.emitRoster`) so DM-gated intents validate against
   * the current membership. An empty DM slot seeds to the first roster
   * member, which is the host on every transport.
   */
  setRoster(roster: readonly PlayerInfo[]): void {
    this._roster = roster;
    if (this._state.dmPlayerId === null && roster.length > 0) {
      this._state = { ...this._state, dmPlayerId: roster[0].id };
    }
  }

  /**
   * Validate an untrusted intent and mutate. Null means REJECTED (broadcast
   * nothing). The browser host owns its clock, so `Date.now()` is `now`.
   *
   * A rule may accept with `patch: null`. When it also changed state (e.g.
   * `reorderCustomTemplates`), that change must still reach every player, so
   * a full-state accept signal is returned; per-recipient KBAuthority ignores
   * the body and re-projects each player's snapshot on any non-null return.
   */
  applyIntent(fromId: string, action: unknown): Patch | null {
    const result = applyIntentRules(this._state, fromId, action, Date.now(), this._roster);
    if (result === null) return null;
    const changed = result.state !== this._state;
    this._state = result.state;
    if (result.patch !== null) return result.patch;
    return changed ? { kind: "full", state: projectSnapshot(this._state) } : null;
  }

  /**
   * A player left the lobby: convert their tokens to NPCs, release their
   * sheets and combatants. The controller calls this before KBAuthority's own
   * roster-change re-projection, so that fan-out already carries the result.
   * The DM is the host and never sees its own leave — the lobby ends instead.
   */
  handlePlayerLeft(playerId: string): void {
    this._roster = this._roster.filter((p) => p.id !== playerId);
    this._state = handlePlayerLeftRules(this._state, playerId).state;
  }

  /**
   * Directly swaps a loaded save slot into the live session. This is a
   * pure-local write with zero network: the caller (the controller) fans out
   * fresh per-player snapshots afterwards. The host holds full maps, so no
   * chunk budget applies.
   *
   * Summary maps (pre-fix slots) are unrecoverable from the slot and dropped,
   * orphan tokens are repaired via `ensureBoundPairs`, ephemeral session
   * state (`rollLog`, `hostHeldKeys`, viewport) resets, and live-session
   * fields a slot never persists win over the slot: roster ownership
   * (`dmPlayerId`) and `statusEffectTemplates` (slots load it as `{}`). Sets
   * an `announcement` marker so clients toast the load once.
   */
  applyLoaded(loaded: DndMapperState): void {
    const fullMaps = loaded.maps.filter(isFullMap);
    const activeMapId = fullMaps.some((m) => m.id === loaded.activeMapId)
      ? loaded.activeMapId
      : (fullMaps[0]?.id ?? null);
    const repaired = ensureBoundPairs(
      fullMaps,
      loaded.sheets ?? {},
      activeMapId,
      loaded.attributeSchema,
    );
    this._state = {
      ...loaded,
      phase: "Playing",
      activeMapId,
      maps: repaired.maps,
      sheets: repaired.sheets,
      rollLog: [],
      hostHeldKeys: [],
      pendingCenterRequest: null,
      focusRect: null,
      dmPlayerId: this._state.dmPlayerId,
      statusEffectTemplates: this._state.statusEffectTemplates,
      announcement: { id: generateGuid(), loadedAt: Date.now() },
    };
  }

  /**
   * The state projected for one player (sync / join / reconnect, roster-change
   * re-push, every accepted intent). The DM gets the shared snapshot
   * unchanged; every other player gets `projectForPlayer` filtering (hidden
   * tokens/images dropped, sheets gated + redacted, rolls/combat/dice gated).
   * Fog stays broadcast (documented legacy leak).
   */
  snapshot(forPlayerId?: string): DndMapperState {
    if (forPlayerId === undefined) return projectSnapshot(this._state);
    return projectForPlayer(this._state, forPlayerId);
  }
}
