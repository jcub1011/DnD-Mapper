/*
 * Tier 2 of the KnockBox local dev loop: the whole networked path with no server.
 *
 * KnockBoxLocalPeer in `mode: 'process'` runs several peers in one JS realm with
 * NO virtual server actor — the first peer is the host (`isHost: true` /
 * `authority: 'host'`), exactly as the relay reports live. The host peer's
 * MatchView (host half) is the truth; guests adopt what it publishes. So these
 * tests exercise the production code path, not a stand-in.
 *
 * IMPORT DISCIPLINE: only kb-authority.js and knockbox-local.js may be imported
 * here. `knockbox-plugin.js` throws at factory time without Phaser, so anything
 * that reaches it (src/net/knockboxPlugin.ts, phaserGlobal.ts, ui/fx/fx.ts) would
 * break this file under Node.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import KBAuthority from "../../addons/knockbox/kb-authority.js";
import KnockBoxLocal from "../../addons/knockbox/knockbox-local.js";
import type { KnockBoxPlugin } from "../../addons/knockbox/knockbox-phaser";
import type { MatchState, Patch } from "../game/types";
import { MatchView } from "../game/view";
import { isFullMap } from "../game/domain";
import type { GameMap } from "../game/domain";
import { createDefaultDndMapperState, createDefaultGridConfig } from "../game/domain";
import { AuthorityController } from "./authorityController";
import type { KnockBoxTransport } from "./transport";

const { KnockBoxLocalPeer, _resetLocalHubs } = KnockBoxLocal;

type Peer = InstanceType<typeof KnockBoxLocalPeer>;

const open: Peer[] = [];

afterEach(() => {
  for (const peer of open) peer.destroy();
  open.length = 0;
  _resetLocalHubs(); // isolate hub state between tests
});

function makePeer(playerId: string): Peer {
  // TRUE host mode: no `authority:` option, so no virtual server actor. The
  // first peer is elected host (isHost:true, authority:'host') and its
  // MatchView host half is the truth — exactly as the relay reports live.
  const peer = new KnockBoxLocalPeer({
    mode: "process",
    channel: "test-lobby",
    playerId,
    displayName: playerId.toUpperCase(),
  });
  open.push(peer);
  return peer;
}

function asTransport(peer: Peer): KnockBoxTransport {
  return peer as unknown as KnockBoxTransport;
}

function attachView(peer: Peer): MatchView {
  const view = new MatchView();
  new KBAuthority<MatchState, Patch>(peer as unknown as KnockBoxPlugin, view);
  // Mirror what AuthorityController.emitRoster does: feed the host half its
  // membership so DM-gated intents validate (and DM seeds to roster[0]).
  const feedRoster = (): void => {
    view.setRoster(
      peer.players.map((p: { id: string; displayName: string }) => ({
        id: p.id,
        displayName: p.displayName,
      })),
    );
  };
  peer.events.on("ready", feedRoster);
  peer.events.on("player-joined", feedRoster);
  peer.events.on("player-left", feedRoster);
  feedRoster();
  return view;
}

/** Start a peer and wait until its replica has settled to `expected` members. */
async function startAndSettle(peer: Peer, expected: number): Promise<void> {
  peer.start();
  await vi.waitFor(() => expect(peer.players).toHaveLength(expected));
}

/** Let any pending broadcasts drain, for assertions about something NOT happening. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("host-authority mode over the local transport", () => {
  it("elects the first peer as host", async () => {
    const a = makePeer("a");
    const viewA = attachView(a);
    await startAndSettle(a, 1);

    // The single most important fact of host-authoritative mode: the lobby
    // creator IS the host, and the relay reports authority:'host'.
    expect(a.isHost).toBe(true);
    expect(a.authority).toBe("host");
    // Lobby powers belong to the host — the creator, until it moves them.
    expect(a.isOwner).toBe(true);
    expect(a.ownerId).toBe("a");
    expect(viewA.state.dmPlayerId).toBe("a");
  });

  it("converges both clients when DM and guest send intents", async () => {
    const a = makePeer("a");
    const viewA = attachView(a);
    await startAndSettle(a, 1);

    const b = makePeer("b");
    const viewB = attachView(b);
    await startAndSettle(b, 2);
    await vi.waitFor(() => expect(a.players).toHaveLength(2));

    expect(b.isHost).toBe(false);
    expect(b.authority).toBe("host");
    expect(b.isOwner).toBe(false);

    // DM creates a map
    a.sendToHost({ _kb: "intent", action: { kind: "createMap", name: "The Crypt" } });
    await vi.waitFor(() => {
      expect(viewA.state.maps).toHaveLength(1);
      expect(viewB.state.maps).toHaveLength(1);
    });

    const mapId = viewB.state.maps[0].id;
    // Guest spawns a player token
    b.sendToHost({
      _kb: "intent",
      action: {
        kind: "spawnToken",
        mapId,
        token: {
          type: "PlayerToken",
          name: "Ranger",
          color: "#0f0",
          iconKind: "Initial",
          x: 4.5,
          y: 4.5,
          sheetId: null,
          hidden: false,
        },
      },
    });

    await vi.waitFor(() => {
      const mapB = viewB.state.maps[0];
      const mapA = viewA.state.maps[0];
      expect(isFullMap(mapB) && mapB.tokens.length === 1).toBe(true);
      expect(isFullMap(mapA) && mapA.tokens.length === 1).toBe(true);
    });
  });

  it("silently drops an illegal intent and leaves state untouched", async () => {
    const a = makePeer("a");
    const viewA = attachView(a);
    await startAndSettle(a, 1);

    const b = makePeer("b");
    const viewB = attachView(b);
    await startAndSettle(b, 2);

    // Guest 'b' attempts to create a map (DM-only intent)
    b.sendToHost({ _kb: "intent", action: { kind: "createMap", name: "Illegal Map" } });
    await settle();

    expect(viewA.state.maps).toHaveLength(0);
    expect(viewB.state.maps).toHaveLength(0);
  });

  it("keeps the match running when a non-owner leaves", async () => {
    const a = makePeer("a");
    const viewA = attachView(a);
    await startAndSettle(a, 1);
    const b = makePeer("b");
    attachView(b);
    await startAndSettle(b, 2);

    a.sendToHost({ _kb: "intent", action: { kind: "createMap", name: "Dungeon" } });
    await vi.waitFor(() => expect(viewA.state.maps).toHaveLength(1));

    b.destroy();
    await vi.waitFor(() => expect(a.players).toHaveLength(1));

    // DM can still manipulate state after guest left
    a.sendToHost({ _kb: "intent", action: { kind: "createMap", name: "Dungeon 2" } });
    await vi.waitFor(() => expect(viewA.state.maps).toHaveLength(2));
  });

  it("ends the local session when the HOST leaves (no migration)", async () => {
    const a = makePeer("a");
    attachView(a);
    await startAndSettle(a, 1);
    const b = makePeer("b");
    attachView(b);
    await startAndSettle(b, 2);

    let closed = false;
    b.events.on("closed", () => {
      closed = true;
    });

    a.destroy(); // "a" is players[0]: both the lobby owner AND the host
    await vi.waitFor(() => expect(closed).toBe(true));
  });
});

describe("AuthorityController", () => {
  it("drives the match through the controller seam", async () => {
    const peer = makePeer("a");
    const controller = new AuthorityController(asTransport(peer));
    peer.start();
    await vi.waitFor(() => expect(peer.players).toHaveLength(1));

    expect(controller.playerId).toBe("a");
    expect(controller.isOwner).toBe(true);
    expect(controller.isHost).toBe(true);

    const mapNames: string[] = [];
    controller.events.on("changed", ({ state }) => {
      if (state.maps.length > 0) {
        mapNames.push(state.maps[0].name);
      }
    });

    controller.sendIntent({ kind: "createMap", name: "Goblin Cave" });
    await vi.waitFor(() => expect(controller.view.state.maps).toHaveLength(1));

    expect(controller.view.state.maps[0].name).toBe("Goblin Cave");
    expect(mapNames).toContain("Goblin Cave");
    controller.destroy();
  });

  it("recovers when the transport was ALREADY ready before it was constructed", async () => {
    const peer = makePeer("a");
    peer.start();
    await vi.waitFor(() => expect(peer.playerId).toBeTruthy());
    await vi.waitFor(() => expect(peer.players).toHaveLength(1));

    const controller = new AuthorityController(asTransport(peer));
    await vi.waitFor(() => expect(controller.view.state.dmPlayerId).toBe("a"));

    controller.sendIntent({ kind: "createMap", name: "Quick Map" });
    await vi.waitFor(() => expect(controller.view.state.maps).toHaveLength(1));
    controller.destroy();
  });

  it("stops emitting once destroyed", async () => {
    const peer = makePeer("a");
    const controller = new AuthorityController(asTransport(peer));
    peer.start();
    await vi.waitFor(() => expect(peer.players).toHaveLength(1));

    let changes = 0;
    controller.events.on("changed", () => changes++);
    controller.destroy();

    peer.sendToHost({ _kb: "intent", action: { kind: "createMap", name: "Never Received" } });
    await settle();
    expect(changes).toBe(0);
  });

  it("projects per player: guests never receive hidden tokens", async () => {
    const hostPeer = makePeer("dm-1");
    const host = new AuthorityController(asTransport(hostPeer));
    hostPeer.start();
    await vi.waitFor(() => expect(hostPeer.players).toHaveLength(1));

    const guestPeer = makePeer("guest-1");
    const guest = new AuthorityController(asTransport(guestPeer));
    guestPeer.start();
    await vi.waitFor(() => expect(guestPeer.players).toHaveLength(2));
    await vi.waitFor(() => expect(hostPeer.players).toHaveLength(2));

    host.sendIntent({ kind: "createMap", name: "Dungeon" });
    await vi.waitFor(() => expect(host.view.state.maps).toHaveLength(1));
    await vi.waitFor(() => expect(guest.state.maps).toHaveLength(1));

    const mapId = (host.view.state.maps[0] as { id: string }).id;

    // Guest spawns a token (creates a bound sheet pair via full-state sync).
    guest.sendIntent({
      kind: "spawnToken",
      mapId,
      token: {
        type: "PlayerToken",
        name: "Ranger",
        color: "#0f0",
        iconKind: "Initial",
        x: 4.5,
        y: 4.5,
        sheetId: null,
        hidden: false,
      },
    });
    await vi.waitFor(() => {
      const map = guest.state.maps[0];
      expect(isFullMap(map) && map.tokens.length === 1).toBe(true);
    });

    const tokenId = ((): string => {
      const map = host.view.state.maps[0];
      if (!isFullMap(map)) throw new Error("expected a full map");
      return map.tokens[0].id;
    })();

    // DM hides the token.
    host.sendIntent({ kind: "setTokenHidden", tokenId, hidden: true });
    await vi.waitFor(() => {
      const map = host.view.state.maps[0];
      expect(isFullMap(map) && map.tokens[0].hidden).toBe(true);
    });

    // The guest's projected view drops the token entirely — no hidden bytes
    // cross the wire — while the host keeps the truth.
    await vi.waitFor(() => {
      const map = guest.state.maps[0];
      expect(isFullMap(map) && map.tokens.length === 0).toBe(true);
    });
    const guestBytes = JSON.stringify(guest.state);
    expect(guestBytes).not.toContain(tokenId);
    const hostMap = host.view.state.maps[0];
    expect(isFullMap(hostMap) && hostMap.tokens.length === 1).toBe(true);

    host.destroy();
    guest.destroy();
  });

  it("applies a loaded save on the host and converges guests (no chunked import)", async () => {
    function makeLoadedMap(id: string, name: string, listOrder: number): GameMap {
      return {
        id,
        name,
        grid: createDefaultGridConfig(),
        images: [],
        tokens: [],
        createdUtc: "2026-09-08T00:00:00.000Z",
        listOrder,
        defaultSpawnPosition: null,
        markupSvg: null,
        fogMask: "",
      };
    }

    const hostPeer = makePeer("dm-1");
    const host = new AuthorityController(asTransport(hostPeer));
    hostPeer.start();
    await vi.waitFor(() => expect(hostPeer.players).toHaveLength(1));

    const guestPeer = makePeer("guest-1");
    const guest = new AuthorityController(asTransport(guestPeer));
    guestPeer.start();
    await vi.waitFor(() => expect(guestPeer.players).toHaveLength(2));
    await vi.waitFor(() => expect(hostPeer.players).toHaveLength(2));

    // A slot as loadSlot returns it: Lobby phase, no DM owner.
    const loaded: MatchState = {
      ...createDefaultDndMapperState(),
      phase: "Lobby",
      maps: [makeLoadedMap("m1", "Hall", 0), makeLoadedMap("m2", "Crypt", 1)],
      activeMapId: "m1",
      dmPlayerId: null,
    };

    host.applyLoadedCampaign(loaded);

    // Host swaps directly: full maps live, session Playing, roster DM kept.
    await vi.waitFor(() => expect(host.view.state.maps).toHaveLength(2));
    expect(host.view.state.phase).toBe("Playing");
    expect(host.view.state.activeMapId).toBe("m1");
    expect(host.view.state.dmPlayerId).toBe("dm-1");
    expect(host.view.state.announcement).toBeDefined();

    // Guest converges to the projected snapshot: active map full, the other
    // a summary — same fan-out shape as intent-driven mutations.
    await vi.waitFor(() => expect(guest.state.maps).toHaveLength(2));
    const guestActive = guest.state.maps.find((m) => m.id === "m1")!;
    const guestInactive = guest.state.maps.find((m) => m.id === "m2")!;
    expect(isFullMap(guestActive)).toBe(true);
    expect(isFullMap(guestInactive)).toBe(false);

    // A guest has no host store: loading there is a silent no-op.
    guest.applyLoadedCampaign(loaded);
    await settle();
    expect(guest.view.state.maps).toHaveLength(0);
    expect(host.view.state.maps).toHaveLength(2);

    host.destroy();
    guest.destroy();
  });
});
