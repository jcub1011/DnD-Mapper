/*
 * The seam between gameplay and transport. The Lit UI talks only to a
 * GameController; it never touches the network or the replicated state directly.
 *
 * Under host authority this seam is deliberately ASYMMETRIC, and that asymmetry
 * is the whole model:
 *
 *   reading   is local and synchronous — `view.state` is the last state the
 *             host published (on the host itself, the live truth).
 *   writing   is a request, not a call — `sendIntent` posts to the host and
 *             returns nothing. The host may silently reject it (it returns
 *             null and broadcasts nothing), so there is no result to hand back.
 *             The UI finds out what happened by re-rendering on `changed`.
 *
 * That is why there is no `addScore(): SubmitResult` any more, and no `tick(dt)`:
 * the host owns the simulation clock. The rAF loop in the UI is for presentation
 * (FX, interpolation) only.
 */

import type { Emitter } from "../game/emitter";
import type { Intent, MatchState } from "../game/types";
import type { KBPlayer } from "../../addons/knockbox/knockbox-phaser";

export interface ControllerEvents {
  /** The authority published new state — re-render. */
  changed: { state: Readonly<MatchState> };
  /** The roster or the lobby owner changed. */
  roster: { players: readonly KBPlayer[]; ownerId: string | null; isOwner: boolean };
}

export interface GameController {
  /** The replicated state. Read-only: mutating it would just be overwritten. */
  readonly view: { readonly state: Readonly<MatchState> };
  /**
   * What the local player may render. On the host this is the live truth
   * (`view.state`); on guests it is the host's per-player projection, null
   * until the first snapshot lands (then the empty local model). Prefer this
   * over `view.state` for rendering.
   */
  readonly state: Readonly<MatchState>;
  readonly events: Emitter<ControllerEvents>;
  /** The local player's id ("" until the transport is ready). */
  readonly playerId: string;
  /** Whether the local player holds the lobby powers (kick, open/close). */
  readonly isOwner: boolean;
  /** Whether THIS browser is the host (DM) holding the truth. Guests render what it publishes. */
  readonly isHost: boolean;

  /** Ask the host to do something. Fire-and-forget; may be rejected silently. */
  sendIntent(intent: Intent): void;
  /**
   * Host only — swap a loaded save slot directly into the live session and
   * fan out fresh per-player snapshots. Pure-local write, zero network on the
   * way in; a no-op when this browser is not the host. Save/load path only.
   */
  applyLoadedCampaign(loaded: MatchState): void;
  /** Owner-only, host-enforced: open or close the lobby to new joins. Ignored for non-owners. */
  setLobbyOpen(open: boolean): void;
  /** Owner-only, host-enforced: remove a player from the lobby. Ignored for non-owners. */
  kickPlayer(playerId: string): void;
  destroy(): void;
}
