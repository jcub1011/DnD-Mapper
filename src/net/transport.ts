/*
 * The transport surface — the structural type that both KnockBoxPlugin (real
 * relay) and KnockBoxLocalPlugin / KnockBoxLocalPeer (no-server testing)
 * satisfy at runtime. Everything above this line is written once and runs
 * unchanged in all three launch modes.
 *
 * Note what host-authoritative mode means for two familiar properties:
 *
 *   isHost   TRUE on the DM's browser (the authority), false on guests.
 *            The host holds the truth via MatchView's host half; guests adopt
 *            what it publishes. Branch host-only work (applyIntent/snapshot)
 *            on this — KBAuthority already does.
 *   isOwner  The member holding the LOBBY powers (kick, open/close). Starts as the
 *            creator (the host) and moves when the host calls setOwner.
 *            Gate owner-only UI on this.
 */

import type { KBPlayer, KnockBoxLogger } from "../../addons/knockbox/knockbox-phaser";

export interface KnockBoxTransport {
  /** This player's id. Null until `ready` fires. */
  readonly playerId: string | null;
  /** The lobby roster, kept current as players join and leave. */
  readonly players: KBPlayer[];
  /** True on the DM browser holding the truth; false on guests. */
  readonly isHost: boolean;
  /** Who runs the game's rules: 'host' for this game, 'server' for opt-out legacy. */
  readonly authority: "host" | "server";
  /** The lobby owner's id, or null when the lobby is running owner-less. */
  readonly ownerId: string | null;
  /** Whether THIS player holds the lobby powers. Gate owner UI on this, not isHost. */
  readonly isOwner: boolean;
  /** True on the local-testing peer; KBAuthority uses it to auto-enable dev checks. */
  readonly isLocal?: boolean;
  /** Ships diagnostic lines to the SERVER log (locally, to the dev console). */
  readonly log: KnockBoxLogger;

  events: {
    on(event: string, fn: (...args: never[]) => void): unknown;
    off(event: string, fn: (...args: never[]) => void): unknown;
  };

  /** Send to the host (DM browser). Guests send intents here; the host answers syncs. */
  sendToHost(payload: unknown): void;
  /** Send to every player including yourself. The host broadcasts deltas/snapshots here;
   *  the relay drops client-sent `_kb` state frames — only the host may publish state. */
  sendToAll(payload: unknown): void;
  sendTo(playerId: string, payload: unknown): void;

  /** Owner-only, host-enforced: open or close the lobby to new joins. */
  setLobbyOpen(open: boolean): void;
  /** Owner-only, host-enforced: remove a player. */
  kickPlayer(playerId: string): void;
  /** Records a Play Log entry on the player's KnockBox home page. Real plugin only. */
  logPlay?(metadata?: Record<string, unknown>): void;
}
