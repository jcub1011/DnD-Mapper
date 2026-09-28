/*
 * AuthorityController — the ONE controller. It works identically in all three
 * launch modes because all three run the same host-authoritative path: the DM's
 * browser holds the truth (MatchView), the relay just routes frames, and guests
 * render the per-player snapshot the host publishes.
 *
 * The loop it participates in:
 *
 *   UI ──sendIntent──► KBAuthority ──{_kb:'intent'}──► host (DM browser)
 *                                                          │ applyIntent
 *   UI ◄──changed──── currentView ◄──{_kb:'state'}─────────┘ (per-player sendTo)
 *
 * KBAuthority (the addon helper) owns the envelope and the sync-on-ready
 * handshake. We supply the host model (MatchView) and re-expose its events to
 * the UI.
 */

import KBAuthority from "../../addons/knockbox/kb-authority.js";
import type { KBModel, KnockBoxPlugin } from "../../addons/knockbox/knockbox-phaser";
import { Emitter } from "../game/emitter";
import type { Intent, MatchState, Patch } from "../game/types";
import { MatchView } from "../game/view";
import { createLogger } from "../log";
import type { ControllerEvents, GameController } from "./controller";
import type { KnockBoxTransport } from "./transport";

const log = createLogger("net");

export class AuthorityController implements GameController {
  readonly view = new MatchView();
  readonly events = new Emitter<ControllerEvents>();

  private readonly net: KnockBoxTransport;
  private readonly authority: KBAuthority<MatchState, Patch>;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(net: KnockBoxTransport) {
    this.net = net;

    // LISTENER ORDER. These subscribe BEFORE KBAuthority does, because the
    // transport runs listeners in registration order and KBAuthority re-projects
    // every player's snapshot from its own `player-joined`/`player-left`
    // handlers. Mutating the host store first means that fan-out already
    // carries the change (a leaver's tokens turned NPC), and `ready` seeds the
    // DM slot before KBAuthority projects the host's first view.
    this.on("ready", this.onReady);
    this.on("owner-changed", this.onRosterChanged);
    this.on("player-joined", this.onRosterChanged);
    this.on("player-left", this.onPlayerLeft);

    // MatchView implements the per-recipient model contract: on the host
    // KBAuthority calls applyIntent/snapshot(forPlayerId); guests keep no model
    // and render their own projected view (`currentView`). Every accepted
    // intent re-projects a full per-player snapshot. Per-recipient patch
    // fan-out (`projectPatchForPlayer` in `src/game/rules.ts`) activates with
    // the upstream delta hook (KnockBox-Games#62).
    const model: KBModel<MatchState, Patch> = this.view;

    // The addon types this parameter as the concrete KnockBoxPlugin. The local
    // testing plugin is a documented drop-in at runtime (same events, properties
    // and methods) but is not nominally assignable — it has no logPlay and its
    // state properties are readonly. One cast, here, is the entire cost of the
    // no-server path. Do NOT "fix" this by shadowing the addon's .d.ts: that file
    // is CLI-managed and would be overwritten by `knockbox addon update`.
    this.authority = new KBAuthority<MatchState, Patch>(net as unknown as KnockBoxPlugin, model, {
      perRecipient: true,
    });

    this.authority.events.on("state-changed", this.onStateChanged);
    this.unsubscribe.push(() => this.authority.events.off("state-changed", this.onStateChanged));

    // ORDERING GUARD. KBAuthority asks for a snapshot from the transport's `ready`
    // event — but Phaser starts the global plugin inside fx.init(), before this
    // controller exists, so a fast transport (solo, or an already-connected
    // reconnect) can have fired `ready` already. Nobody would then have sent the
    // sync, and the client would sit in an empty Lobby forever.
    //
    // Re-request it with the exact envelope KBAuthority itself sends. A duplicate
    // sync costs one extra snapshot; a missing one costs the whole session.
    if (net.playerId !== null) {
      log.debug("transport was already ready; requesting a snapshot");
      net.sendToHost({ _kb: "sync" });
      this.emitRoster();
    }
  }

  get playerId(): string {
    return this.net.playerId ?? "";
  }

  get isOwner(): boolean {
    return this.net.isOwner;
  }

  get isHost(): boolean {
    return this.net.isHost;
  }

  /**
   * What the local player may render. On the host this is the live truth; on
   * guests it is the host's per-player projection (`currentView`), which is
   * null until the first snapshot lands (fall back to the empty local model).
   */
  get state(): Readonly<MatchState> {
    if (!this.isHost && this.authority.currentView) {
      return this.authority.currentView;
    }
    return this.view.state;
  }

  sendIntent(intent: Intent): void {
    // Fire-and-forget. The host validates against ITS state, not ours, and a
    // rejected intent broadcasts nothing at all — we simply never see a change.
    this.authority.sendIntent(intent);
  }

  applyLoadedCampaign(loaded: MatchState): void {
    // Save/load is a pure-local IndexedDB write with zero network on the way
    // in: swap the slot directly into the host store (the host holds full
    // maps, so no chunk budget applies), then fan out fresh per-player
    // snapshots to everyone.
    if (!this.isHost) return;
    this.view.applyLoaded(loaded);
    this.broadcastState();
  }

  setLobbyOpen(open: boolean): void {
    // Host-enforced: a non-owner's call is ignored rather than failing.
    this.authority.setOpen(open);
  }

  kickPlayer(playerId: string): void {
    this.net.kickPlayer(playerId);
  }

  destroy(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.authority.destroy();
  }

  /** Subscribe to a transport event and remember how to undo it. */
  private on(event: string, fn: (...args: never[]) => void): void {
    this.net.events.on(event, fn);
    this.unsubscribe.push(() => this.net.events.off(event, fn));
  }

  /**
   * Host only — re-publish the host store to every guest after a direct
   * mutation that bypassed the intent path (a save-load swap), then re-render
   * locally. Uses KBAuthority's `_kb:'state'` envelope, the same way the
   * ordering guard reuses `_kb:'sync'`; `kb-authority.js` itself is
   * CLI-managed and must not be edited.
   *
   * Stopgap until KnockBox-Games#62 (per-recipient delta hook) lands: this
   * fans out full per-player snapshots. With #62, host-local mutations should
   * project a patch per recipient instead.
   * https://github.com/jcub1011/KnockBox-Games/issues/62
   */
  private broadcastState(): void {
    if (!this.isHost) return;
    for (const player of this.net.players) {
      if (player.id === this.net.playerId) continue;
      this.net.sendTo(player.id, { _kb: "state", state: this.view.snapshot(player.id) });
    }
    this.onStateChanged();
  }

  private readonly onStateChanged = (): void => {
    this.events.emit("changed", { state: this.state });
  };

  private readonly onReady = (): void => {
    log.info(
      `ready — player=${this.playerId} authority=${this.net.authority} ` +
        `owner=${String(this.net.ownerId)} isHost=${this.net.isHost}`,
    );
    if (this.net.authority !== "host") {
      // Host-authority game: anything else means a relay/server mismatch and
      // state will not converge.
      log.warn(`expected host authority but got '${this.net.authority}' — state will not update`);
    }
    this.emitRoster();
  };

  private readonly onRosterChanged = (): void => {
    this.emitRoster();
  };

  private readonly onPlayerLeft = (playerId: string): void => {
    if (this.isHost) this.view.handlePlayerLeft(playerId);
    this.emitRoster();
  };

  private emitRoster(): void {
    // Feed the host store its membership so DM-gated intents validate.
    this.view.setRoster(this.net.players.map((p) => ({ id: p.id, displayName: p.displayName })));
    this.events.emit("roster", {
      players: this.net.players,
      ownerId: this.net.ownerId,
      isOwner: this.net.isOwner,
    });
  }
}
