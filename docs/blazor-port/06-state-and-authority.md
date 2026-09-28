# 06 — State and Authority

How the 86-verb Blazor game engine becomes a pure rules module run by the DM's browser, how every
player receives only what they may see, and how to stay under a 512 KiB relay ceiling whose failure
mode is silence.

## The shape of the problem

Legacy and target are both authoritative in one place, which is lucky — the *model* ports
directly. What changes is where the truth lives and what it has to squeeze through:

| | Legacy | Target |
| --- | --- | --- |
| Authority runs in | ASP.NET, per circuit | **The DM's browser** — the KnockBox host (`isHost: true`, `authority: 'host'`) |
| Truth held by | the engine's server-side state | `MatchView` (`src/game/view.ts`) on the DM's tab |
| Language | C# | TypeScript, bundled with the app — no separate authority build |
| State size limit | Server RAM | **512 KiB per relay frame**, host → each guest |
| Time source | `DateTime.UtcNow` | `Date.now()` on the host, passed into the rules as `now` |
| Logging | `ILogger` | `createLogger` (`src/log.ts`) |
| Call budget | none | none — no sandbox, no timeout, no overrun counter |
| Mutation entry | 86 engine verbs | `applyIntent(fromId, action)` |

The platform's server-authority sandbox (Jint, `kb.now()`, the 250 ms call budget) is **not used**.
An earlier iteration of this port ran there; it was removed in favour of host authority, and
nothing in `src/` targets it any more. See [`02`](02-target-platform.md#host-mode-phase-0-spike-findings)
for how the platform behaves in host mode.

The loop, end to end:

```
UI ──sendIntent──► KBAuthority ──{_kb:'intent'}──► host (DM browser)
                                                      │ MatchView.applyIntent → rules.applyIntent
                                                      │ accepted? (Patch !== null)
UI ◄── currentView ◄──{_kb:'state'} per player ◄──────┘ sendTo(pid, projectForPlayer(state, pid))
```

Guests keep **no model**. They render `authority.currentView`, the host's latest projection for
them. The host renders its own live state.

## Verbs become intents

Each legacy verb `Engine.MoveTokenAsync(state, caller, tokenId, x, y)` becomes an intent variant
plus a branch in `applyIntent`. The signature already carries what the authority needs:
`caller` → `fromId`, and the state is `MatchView`'s own.

```ts
// src/game/types.ts — excerpt; the real union also covers sheets, schema, status
// effects, templates, dice, loaded dice, combat and host keys
export type Intent =
  // maps
  | { kind: "createMap"; name: string }
  | { kind: "renameMap"; mapId: string; name: string }
  | { kind: "deleteMap"; mapId: string }
  | { kind: "duplicateMap"; mapId: string }
  | { kind: "reorderMaps"; order: readonly string[] }
  | { kind: "setActiveMap"; mapId: string }
  | { kind: "updateGrid"; mapId: string; grid: GridConfig }
  // tokens
  | { kind: "spawnToken"; mapId: string; token: NewToken }
  | { kind: "moveToken"; tokenId: string; x: number; y: number }
  | { kind: "updateToken"; tokenId: string; patch: Partial<Token> }
  | { kind: "removeToken"; tokenId: string }
  | { kind: "setTokenHidden"; tokenId: string; hidden: boolean }
  // images
  | { kind: "addImage"; mapId: string; image: NewMapImage }
  | { kind: "transformImage"; imageId: string; x: number; y: number;
      width: number; height: number; rotation: number }
  | { kind: "reorderImage"; imageId: string; layerOrder: number }
  | { kind: "setImageLocked"; imageId: string; locked: boolean }
  | { kind: "setImageHidden"; imageId: string; hidden: boolean }
  | { kind: "removeImage"; imageId: string }
  // fog — ONE intent per stroke, never per cell
  | { kind: "paintFog"; mapId: string; cells: readonly number[]; fogged: boolean }
  | { kind: "fillFog"; mapId: string }
  | { kind: "clearFog"; mapId: string }
  // viewport
  | { kind: "setFocusRect"; rect: FocusRect | null }
  | { kind: "centerViewport"; mapId: string; x: number; y: number }
  // session
  | { kind: "updateSettings"; patch: Partial<DndMapperSettings> }
  | { kind: "updateHostKeys"; heldKeys: readonly string[] }
  | { kind: "requestMap"; mapId: string };   // legacy — see "Map switching"
```

There are **no campaign-import intents.** Loading a save is a direct host-local swap
([below](#getting-a-campaign-into-the-authority)); a `beginImport` / `importChunk` /
`commitImport` frame from any client is rejected by the rules like any other unknown kind.

> `action` arrives **untrusted** — a modified client can send anything. `applyIntent` takes
> `unknown` and narrows. **Returning `null` for an illegal intent is the permission model**, and it
> is the whole of it. Under the locked **DM trusted** decision this guards against guests, not
> against the DM — the DM's browser *is* the authority.

`MatchView.applyIntent` is a thin wrapper: it calls the pure `applyIntent` in `src/game/rules.ts`
with `Date.now()` as the clock and the current roster, keeps the new state, and returns the
`Patch`. **The `Patch` is only an accept signal** under `perRecipient` — non-null means "accepted,
re-project everyone", null means "rejected, broadcast nothing". Its contents do not travel (see
[rule 1](#strategy--three-rules)).

### Where permission checks live

Legacy's `TokenMovementPolicy` / `SheetEditPolicy` checks are scattered through the 86 verbs. In the
port they live in `src/game/rules.ts`, called from `applyIntent` before any mutation:

```ts
export function mayMoveToken(state: DndMapperState, fromId: string, token: Token): boolean {
  if (isDm(state, fromId)) return true;
  switch (state.settings.tokenMovement) {
    case "HostOnly":     return false;
    case "Anyone":       return true;
    case "OwnerOrHost":  return token.ownerUserId === fromId;
  }
}
```

The same file holds the read-side policies the projection uses — `mayViewSheet`,
`mayViewSheetNotesAndHp` — so "may this player change X" and "may this player see X" are decided
next to each other.

**The DM is the host**, in every launch mode. Every permission check hangs off `dmPlayerId`, so be
precise about where it comes from:

- `PlayerInfo` is `{ id, displayName }` (`src/game/types.ts`). It does not say who the DM is.
- The controller feeds the lobby roster to `MatchView.setRoster` on `ready` and on every roster
  change (`AuthorityController.emitRoster` in `src/net/authorityController.ts`).
- `setRoster` seeds `dmPlayerId` from **`roster[0]`** when the slot is empty. Index 0 is the host by
  construction — `knockbox-local.js` documents *"index 0 is the elected host on every transport"* —
  and the host is the browser running `MatchView` at all, so the DM and the authority are the same
  player.
- After that, `dmPlayerId` is **explicit in state** and never re-derived. A loaded save cannot
  overwrite it: `applyLoaded` keeps the live value over whatever the slot persisted.

There is no owner succession to track — see [freeze on DM leave](#freeze-on-dm-leave).

> **In `local-tab` development the DM is whichever tab you opened first**, because that tab wins the
> `BroadcastChannel` election and lands at index 0. There is no way to choose. Plan two-tab testing
> around that ([`11`](11-verification.md#two-tab-multiplayer--the-primary-loop)).

## Per-player projection

Locked decision: **true per-player filtering.** The host never sends a guest anything that guest may
not see. `MatchView.snapshot(forPlayerId)` returns `projectForPlayer(state, forPlayerId)`
(`src/game/rules.ts`):

1. **Start from `projectSnapshot(state)`** — the active map in full, every other map reduced to a
   `MapSummary` (`{ id, name, listOrder, widthCells, heightCells }`).
2. **The DM gets that unchanged.**
3. **Everyone else additionally loses:**

| Stripped for non-DM viewers | Rule |
| --- | --- |
| Hidden tokens and hidden images | `hidden` flag |
| Tokens standing on fogged cells | unless the viewer owns them (`ownerUserId` or `representsUserId`) — unowned NPCs in fog are DM-only |
| Sheets | dropped where `mayViewSheet` fails; `notes` and `hp` redacted where `mayViewSheetNotesAndHp` fails |
| Roll log entries | gated by `settings.rollsVisibleToPlayers` (own rolls always visible) |
| Combatants | hidden or fog-stripped tokens drop out of the turn order; `pendingInitiative` cleared |
| `loadedDiceRules` | emptied unless `loadedDiceRuleVisibility` is `VisibleToAll` (or legacy `AllPlayers`) |

A null or unknown player id projects as a stranger — **default-deny**.

> **The fog mask itself is still broadcast.** Legacy sent the whole mask to every client and
> rendered it opaque; the port keeps that for parity. A modified client can read the mask and learn
> the map's *shape* — but not what stands in the fog, because tokens on fogged cells are stripped
> above. Document this plainly in the DM-facing docs.

Client-side mirrors of these rules (`src/game/visibility.ts`, UI filters) are prediction or
DM-local rendering only. **The projection is the authority**; a mirror must never be the only thing
hiding something.

## The 512 KiB ceiling

This is the design constraint that shapes everything else. Host mode changes *who sends* state —
the DM's socket instead of a server actor — but it is the same relay, and the same limits bind
host → guest frames ([`02`](02-target-platform.md#the-512-kib-ceiling)):

- **512 KiB per frame.** A host → guest snapshot is an inbound frame on the DM's socket, so an
  oversized one closes **the DM's** socket with 1009 — which the SDK treats as transient, so the
  host reconnects, re-pushes the same snapshot on reconnect, and loops. The guest never converges,
  and nobody sees an error.
- **30 msg/s sustained, 60 burst, per connection**, and violation is a **terminal 1008 close**
  ([`02`](02-target-platform.md#rate-limiting)). The connection that pays is the **DM's** — and the
  DM's socket closing ends the session for everyone.
- `OutboundCapacity 1024 / DropOldest`, no acks, no sequencing. Harmless for whole snapshots (a
  dropped one is superseded by the next), fatal for anything sequential.

### Budget

Rough sizes for a large table:

| Content | Approximate JSON size |
| --- | --- |
| Fog mask, 200×200 map, base64 | 5,000 bytes → ~6.7 KB base64 |
| 60 tokens | ~12 KB |
| 40 image records (metadata only) | ~14 KB |
| **One such map** | **~33 KB** |
| 8 maps in full | ~262 KB |
| + roll log (50), sheets, settings, schema, dice rules | ~300 KB |
| 16 maps in full | **~525 KB — over the cap** |

Whole-campaign state would *work* for a mid-sized campaign, right up until it didn't: the margin is
~1.7× on a campaign a real DM could build in a season, and nothing warns you as you approach it.
That is why the frame is bounded by **one map's** content, not the campaign's — rule 2 below.

### Fan-out budget

`perRecipient` has no deltas. Every accepted intent, every roster change (join or leave), every
save load and every host reconnect re-projects and sends **one `sendTo` frame per non-host player**
from the DM's socket. So the rate limit is spent by the DM, multiplied by the table (the DM's own
intents also round-trip the relay via `sendToHost`, one more message each):

| Players (incl. DM) | Frames per accepted intent | Sustained accepted intents/s under 30 msg/s |
| --- | --- | --- |
| 4 | 3 | 10 |
| 8 | 7 | ~4 |
| 16 | 15 | **~2** |

**Open risk — "16-player fan-out", to verify in Phase 06.** At `maxPlayers: 16` the DM can sustain
only about two accepted intents per second before the limiter closes the DM's socket with 1008. A
drag that emits several `moveToken`s a second, or a fog stroke followed by a token nudge, can exceed
that. `updateHostKeys` is throttled to 20/s (`src/net/hostInput.ts`), but that throttle does not
scale with the table: 20 accepted intents/s × 15 guests is 300 frames/s on the DM's connection. The
burst of 60 hides all of this in short tests.
Measure against the real relay at 16 seats before treating the budget as met; mitigations, in
order of preference, are the parked delta hook (rule 1), coalescing high-rate intents host-side, and
keeping purely cosmetic host state (held keys) off the authoritative path.

### Strategy — three rules

**1. Narrow the patch — dormant until KnockBox-Games#62.** `Patch` in `src/game/types.ts` is still a
discriminated union of what actually changed, carrying **absolute** values (`token`, `fog` with the
whole mask for one map, `map`, `sheet`, `roll`, …). Under `perRecipient` it is not sent: the addon
treats a non-null return as an accept signal and re-projects full snapshots
(`addons/knockbox/kb-authority.js`, `'intent'` branch). `projectPatchForPlayer` in `rules.ts` —
per-viewer patch filtering with tombstones for newly-hidden tokens and images — is written and
tested but **parked** until the upstream per-recipient delta hook
([KnockBox-Games#62](https://github.com/jcub1011/KnockBox-Games/issues/62)) lands. When it does,
the fan-out becomes N−1 *small* frames instead of N−1 snapshots, and patches must stay absolute so a
delta that overtakes a snapshot still converges.

**2. Keep every snapshot to one map.** `projectSnapshot` sends only the **active map in full**; other
maps are summaries. Every per-player projection starts from it, so the frame is bounded by one map
plus campaign-wide metadata (sheets, schema, templates, roll log), not by campaign size. This is the
most important structural decision in the document.

> `MapSummary` is `{ id, name, listOrder, widthCells, heightCells }` — enough to render the map list
> and nothing else. It is defined in [`03`](03-domain-model.md) alongside `NewToken` and
> `NewMapImage`.

**3. Keep client-local state out of the wire entirely.**

| Stays client-local | Why |
| --- | --- |
| Camera pan/zoom | Per-player view. Legacy synced it only for "centre everyone here". |
| Selected image | Pure UI state |
| Tool mode, brush radius | Pure UI state |
| Ruler points | Never left the client in legacy either |
| Fog stroke preview | Optimistic; discarded when the next projection lands |
| Save slots / library | Browser-local by design (D1, Q4) |
| **Image bytes** | Can't cross the relay at all — see [`09`](09-blob-share-server-spec.md) |

### Guardrails

**Today nothing size-checks the per-player snapshot that actually crosses the relay.** The addon
builds and sends it (`_stateMsg` → `sendTo`), and `addons/` is CLI-managed, so the game has no hook
between projection and send. What exists:

- `utf8Length` and `guardSize` in `src/game/wire.ts` — a hand-rolled UTF-8 byte count (the relay
  counts **bytes**; `String.length` counts UTF-16 code units and under-reports "Ténèbres" or any CJK
  label) and a check against `MAX_FRAME_BYTES` (400,000, ~78% of the cap, leaving envelope
  headroom). They remain the relay-frame measure for the parked #62 fan-out, where the game will
  own each outgoing patch again.
- `src/game/snapshotBudget.test.ts` — builds a 24-map, 50-sheet, 100-token campaign (half-fogged
  active map) and asserts `projectSnapshot` stays under 400 KiB and that inactive maps carry no
  tokens or fog. The DM's projection is the largest one, so this bounds every guest's too.

The gap is real: a single active map large enough to cross the cap (a 500×500 map with heavy art
and hundreds of tokens) would put the DM's socket into the 1009 reconnect loop described above. Until #62 gives the game
the send path back, the options are a host-side `utf8Length(JSON.stringify(projectForPlayer(…)))`
check logged through `createLogger` before `broadcastState`, or a UI-level cap on active-map size.
Better to fail **loudly in our own log** than to have the platform drop it silently. See
[`11`](11-verification.md#tier-2--the-host-store-and-host-mode-sync).

## Getting a campaign INTO the authority

The campaign library is **browser-local to the DM**, in IndexedDB, by design
([`08`](08-assets-pipeline.md), `D1`, `Q4`). The authority is **the same browser**. So there is no
upload: loading a save is a host-local swap followed by a fan-out.

```
DM clicks Load (or accepts the auto-save restore prompt)
dndm-app.applyLoadedCampaign        host only; a guest gets a toast and nothing happens
  └─ re-publish every image blob    assetSource.publish(id, blob) for each map image
  └─ controller.applyLoadedCampaign
       └─ view.applyLoaded(loaded)  swap the slot into MatchView
       └─ controller.broadcastState()  one {_kb:'state'} sendTo per guest
```

`MatchView.applyLoaded` normalises the slot the way the old commit step did:

- **Drops summary-only maps.** Slots should hold full maps; pre-fix slots may contain summary
  shards, which are unrecoverable. `dndm-app` warns and toasts which maps were omitted.
- **Repairs token/sheet pairs** via `ensureBoundPairs`.
- **Resets session-ephemeral state**: `rollLog`, `hostHeldKeys`, `pendingCenterRequest`,
  `focusRect`.
- **Keeps the live `dmPlayerId`**, and the live `statusEffectTemplates` — the save does not decide
  who the DM is.
- **Sets `announcement`** (`{ id, loadedAt }`) so every client toasts the load once.

`broadcastState` is the addon's public host-only method: it re-sends each guest its projection with
the normal `_kb:'state'` envelope and fires `state-changed` for the host. The controller reaches it
through one cast because the CLI-managed `.d.ts` does not declare it yet; the addon file itself is
not modified.

What this replaced, and why it could go: the sandbox version needed a **chunked import protocol**
because the only way into server-side state was a client→server frame, and a >512 KiB frame closes
the socket with 1009 — which the SDK treats as transient, so the DM would reconnect and resend
forever. With the truth in the DM's browser the campaign never crosses the wire whole; each guest
receives one bounded projection. Saving is pure-local too: `src/storage/` has no network leg.

### Recovery after a restart

A server restart drops every lobby and invalidates every ticket (`LobbyManager.cs:6`,
`TokenService.cs:28`). Nothing authoritative lived on the server, but the session is gone, so the DM
starts a new lobby and reloads. Two parts, both of which should be smooth:

1. **The campaign** comes back through the load path above. The DM's boot also offers the
   `__auto__` slot as a declinable restore prompt (`maybeOfferAutoRestore` in
   `src/ui/app/dndm-app.ts`).
2. **The blob handles are gone too** — phase 0 sweeps the blob root at startup precisely because
   lobby-anchored handles cannot survive the process ([`09`](09-blob-share-server-spec.md#the-two-races)).
   `applyLoadedCampaign` re-`publish()`es every image; content addressing makes that
   cheap-but-not-free, since the `HEAD` probe finds nothing and the bytes really do re-upload.

The same applies if the **DM's tab** closes or reloads: `MatchView` is in-memory, so the session
ends and recovery is a reload from the library. For the DM-facing docs: because the library is
browser-local, **nothing is lost** — only re-sent, up to the last save or auto-save.

## Map switching

```
DM sends   { kind: "setActiveMap", mapId }
host       applyIntent accepts → activeMapId changes
host       → each guest: projectForPlayer(state, pid)   the new active map in full, others summaries
```

There is no separate fetch. Every projection carries the active map in full, so the switch is one
fan-out like any other intent. Guests do **not** hydrate inactive maps: the old `requestMap` round
trip is gone from the UI, and while the rule case still exists it changes nothing a guest can
observe. The DM's own browser holds every map in full already.

Until the first projection after a switch lands, a guest still shows the old map; there is no
half-loaded state to render, because the map and its tokens, images and fog arrive in the same frame.

## The `perRecipient` tension

**Resolved: `perRecipient: true`.** `src/net/authorityController.ts` constructs `KBAuthority` with
it, under the locked decision **true per-player filtering**.

The tension the earlier draft of this document weighed was real: the addon says so outright —

> *"In this mode there are no deltas and guests need no model: the host sends each player their own
> snapshot."*

— so payload is proportional to `players × active-map snapshot` rather than `players × what
changed`. The draft recommended broadcast plus client-side hiding (legacy parity). It was overruled
because:

- Rule 2 bounds each snapshot by one map, so the frame-size half of the objection is contained
  (and tested — see [Guardrails](#guardrails)).
- Client-side hiding means a modified client reads hidden tokens, DM-only sheets and secret rolls.
  With the rules already running in a browser, projecting per player is cheap.

What remains is the **message-count** half — [Fan-out budget](#fan-out-budget) — and the parked
delta hook is the long-term answer to both.

## Reconnect, late join, and DM leave

### Reconnect and late join

The addon gives this mostly for free; the port must not break it (`kb-authority.js`):

- A **guest** sends `{_kb:'sync'}` on every `ready` — first join, late join and reconnect — and the
  host answers with that guest's projection via `sendTo`.
- The **host** re-sends every guest's projection on **any** roster change, joins and leaves alike —
  a leave can change what others may see.
- On a **host reconnect** (`net.reconnected`), guests that already synced will not ask again, so the
  host re-pushes everyone.
- **Boot-order guard:** a fast transport can fire `ready` before the controller exists, so nobody
  sends the sync. The `AuthorityController` constructor re-sends `{_kb:'sync'}` and re-emits the
  roster when `net.playerId` is already set. A duplicate sync costs one snapshot; a missing one
  costs the session.
- Disconnect grace is **60 s**; a player is held in the roster and returns via `player-connected`.
- Tickets last 12 h, but the token secret is per-process — **a server restart invalidates every
  ticket and drops every lobby**. See [Recovery after a restart](#recovery-after-a-restart).

### Player leave

When a non-DM player leaves, `MatchView.handlePlayerLeft` runs the leave lifecycle in the rules so
their character stays on the board under DM control:

- Their tokens become `NPCToken` with `ownerUserId: null` and `representsUserId` set to the leaver.
- Their sheets get the same treatment — ownership cleared, `representsUserId` recorded.
- Their combatants' ownership is cleared, so the DM can roll and manage them.

### Freeze on DM leave

Locked decision: **freeze on DM leave — no host migration, no DM succession.** The truth lives in
the DM's browser, so there is nothing for anyone else to be promoted *to*. When the host leaves,
the lobby ends on every transport — platform, `local-tab` and solo alike.

The Phase 04 **"waiting for DM" freeze overlay is not built yet**; until it is, guests are left with
their last `currentView` and no explanation. Anything that looks like owner succession (`kb.setOwner`
on DM leave, a `dm` patch) is dead and should not be revived.

## Forgery posture

In host mode **any peer can forge `_kb` frames.** The addon's `from === 'server'` checks only fire
when `net.authority === 'server'`, and the relay stops dropping client-sent `_kb:'state'` frames in
host lobbies — it has to, since the DM's per-player snapshots *are* client-sent frames. A modified
guest could push a fake `state` to another guest.

This is **accepted** under the locked **DM trusted** decision, and the reasoning is in
[`02`](02-target-platform.md#forgery-posture--accepted-under-dm-trusted-model): the answer to a
malicious guest is the lobby kick, not per-frame authentication. What the design *does* guarantee is
that a guest can only affect the truth through intents the DM's rules accept, and can only
*receive* what `projectForPlayer` lets through.

## Testing

Three tiers, cheapest first.

1. **Pure rules and projection** — `src/game/rules.test.ts`, `projection.test.ts` (the per-player
   visibility matrix), `visibility.test.ts`, `playerLifecycle.test.ts`, `fog.test.ts`,
   `snapping.test.ts`, `snapshotBudget.test.ts`. No network, and the clock is a parameter, so these
   are deterministic. `src/game/` stays free of DOM and browser APIs for exactly this reason — there
   is no sandbox enforcing it any more, only the convention. The fog bitset and the
   snap-to-centre-vs-corner distinction deserve exhaustive tests; they are silent-corruption bugs
   otherwise.
2. **Host store** — `src/game/view.test.ts`: `MatchView.applyIntent`, `snapshot(forPlayerId)`,
   `applyLoaded` normalisation, `setRoster` seeding, `handlePlayerLeft`.
3. **Host-mode relay sync** — `src/net/authorityController.test.ts` with several
   `KnockBoxLocalPeer`s in `mode: 'process'` and no `authority:` option (true host mode): guest
   intents validate on the host, each guest converges on *its own* projection, late join and
   `broadcastState` converge. Strict-JSON cloning is on, so a stray `undefined` surfaces here.

UI is tested against a mock controller (`src/ui/app/dndm-app.test.ts`).

Then manually: `?kbLocal=tab` in two tabs, the first as DM. The fan-out risk above needs a
**real-relay** run at 16 seats; the local peer does not enforce the rate limit.
