# 06 — State and Authority

How the 86-verb Blazor game engine becomes a sandboxed authority module, and how to stay under a
512 KiB ceiling whose failure mode is silence.

## The shape of the problem

Legacy and target are both server-authoritative, which is lucky — the *model* ports directly. What
changes is the execution environment:

| | Legacy | Target |
| --- | --- | --- |
| Authority runs in | ASP.NET, per circuit | **Jint sandbox**, one per lobby |
| Language | C# | TypeScript → single bundled JS file |
| State size limit | Server RAM | **512 KiB per broadcast frame** |
| Time source | `DateTime.UtcNow` | `kb.now()` — `Date` is deleted |
| Logging | `ILogger` | `kb.log.*` |
| Call budget | none | **250 ms**, 32 MiB, 3 overruns → lobby closed |
| Mutation entry | 86 engine verbs | `applyIntent(fromId, action)` |

## Verbs become intents

Each legacy verb `Engine.MoveTokenAsync(state, caller, tokenId, x, y)` becomes an intent variant
plus a branch in `applyIntent`. The signature already carries what the authority needs:
`caller` → `fromId`, and the state is the module's own.

```ts
// src/game/types.ts
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
  // campaign loading — see "Getting a campaign INTO the authority" below
  | { kind: "requestMap"; mapId: string }
  | { kind: "beginImport"; campaign: CampaignHeader; chunkCount: number }
  | { kind: "importChunk"; token: string; index: number; maps: readonly GameMap[] }
  | { kind: "commitImport"; token: string };
```

> `action` arrives **untrusted** — a modified client can send anything. `applyIntent` must take
> `unknown` and narrow, exactly as the template's `rules.ts` does. **Returning `null` for an
> illegal intent is the anti-cheat**, and it is the whole of it.

### Where permission checks live

Legacy's `TokenMovementPolicy` / `SheetEditPolicy` checks are scattered through the 86 verbs. In the
port they belong in `src/game/rules.ts`, called from `applyIntent` before any mutation:

```ts
function mayMoveToken(state: DndMapperState, fromId: string, token: Token): boolean {
  if (isDm(state, fromId)) return true;
  switch (state.settings.tokenMovement) {
    case "HostOnly":     return false;
    case "Anyone":       return true;
    case "OwnerOrHost":  return token.ownerUserId === fromId;
  }
}
```

**The DM is the lobby owner** — and the authority's knowledge of who that is rests on a
convention, not on the ABI. Worth being precise, because every permission check hangs off it:

- `PlayerInfo` is `{ id, displayName }` (`src/game/types.ts`). It does **not** say who the owner is.
- `Kb` exposes `setOwner(playerId)` but no getter (`src/authority/kb.ts`).
- So the only initial signal is **`init(players)[0]`**. The template relies on it
  (`src/authority/authority.ts:38`), and the local peer makes it true by construction —
  `knockbox-local.js:937`, *"index 0 is the elected host on every transport"*, which then sets
  `ownerId`. Client-side, `isOwner` "starts as the creator and moves when the authority module
  calls `kb.setOwner`" (`src/net/transport.ts`).

Take `dmPlayerId = players[0].id` at `init`, keep it **explicit in state**, and update it only when
this module calls `kb.setOwner` — that is the only way it can change, since nothing else can tell
us. Confirm the `players[0]`-is-creator ordering against the real server before phase 4; it is
documented for the local peer and merely conventional for the platform.

> **In `local-tab` development the DM is whichever tab you opened first**, because that tab wins the
> `BroadcastChannel` election and lands at index 0. There is no way to choose. Plan two-tab testing
> around that ([`11`](11-verification.md#two-tab-multiplayer--the-primary-loop)).

## The 512 KiB ceiling

This is the design constraint that shapes everything else.

```csharp
// Games\ServerAuthority.cs:442-451
if (bytes.Length > WebSocketHandler.MaxMessageBytes) {
    _logger.LogError("Authority for lobby {LobbyId} produced a {Size}-byte frame (max {Max}); dropping it", …);
    return;
}
```

**An oversized frame is dropped, not rejected.** No client-visible error; the game simply stops
updating for everyone. This is the single worst failure mode in the platform, and a VTT is exactly
the kind of game that will hit it.

### Budget

Rough sizes for a large table:

| Content | Approximate JSON size |
| --- | --- |
| Fog mask, 200×200 map, base64 | 5,000 bytes → ~6.7 KB base64 |
| 60 tokens | ~12 KB |
| 40 image records (metadata only) | ~14 KB |
| **One such map** | **~33 KB** |
| 8 maps | ~262 KB |
| + roll log (50), sheets, settings, schema, dice rules | ~300 KB |
| 16 maps | **~525 KB — over the cap** |

**Read that table honestly: a large campaign today lands at roughly 60% of the ceiling, not past
it.** Whole-state broadcast would *work*, right up until it didn't. That is precisely why it has to
go:

- The margin is ~1.7× on a campaign a real DM could plausibly build in a season, and campaigns only
  grow. Nothing warns you as you approach it.
- The overage is **invisible** — no error, no client-side signal, no degraded mode. The table simply
  stops updating (see above).
- It is paid on **every change**. A one-cell fog poke would ship 300 KB to every player, which
  wastes the 512 KiB budget's real purpose: absorbing the occasional big legitimate frame.

So the argument for narrowing is headroom and blast radius, not an immediate overflow. The
template's approach still has to go:

```ts
// src/game/types.ts:57 — the template
export type Patch = MatchState;   // broadcasts the ENTIRE state on every change
```

### Strategy — three rules

**1. Narrow the patch.** `Patch` becomes a discriminated union of what actually changed, still
carrying **absolute** values:

```ts
export type Patch =
  | { kind: "full"; state: DndMapperState }              // sync / join / reconnect only
  | { kind: "token"; token: Token }                      // absolute position, not a delta
  | { kind: "tokenRemoved"; tokenId: string }
  | { kind: "fog"; mapId: string; mask: string }         // whole mask for ONE map
  | { kind: "image"; image: MapImage }
  | { kind: "imageRemoved"; imageId: string }
  | { kind: "grid"; mapId: string; grid: GridConfig }
  | { kind: "activeMap"; mapId: string }
  | { kind: "focusRect"; rect: FocusRect | null }
  | { kind: "centerViewport"; request: CenterViewportRequest }
  | { kind: "settings"; settings: DndMapperSettings }
  | { kind: "mapList"; maps: readonly MapSummary[] }      // metadata only, no tokens/images
  | { kind: "map"; map: GameMap }                         // ONE map in full — see below
  | { kind: "dm"; dmPlayerId: string };                   // succession
```

`MatchView.applyPatch` merges by kind instead of replacing wholesale.

> **`{ kind: "map" }` is not optional.** `activeMap` carries only a `mapId`, so without a full-map
> patch there is no way to deliver the newly-active map's tokens, images and fog when the DM
> switches — the clients would learn *which* map is active and nothing about it. This is the patch
> that answers a `requestMap` intent, and it is the one patch whose size has to be checked against
> the frame cap every time (a 200×200 map with 60 tokens and 40 images is ~33 KB, so there is
> room — but see the budget below).
>
> `MapSummary` is `{ id, name, listOrder, widthCells, heightCells }` — enough to render the map
> list and nothing else. Define it in [`03`](03-domain-model.md) alongside `NewToken` and
> `NewMapImage`, which the `Intent` union also references.

**2. Keep the full snapshot small.** `snapshot()` is called on every join and reconnect, and it
must fit in one frame. **Send only the active map in full**; other maps are summaries
(`id`, `name`, `listOrder`, grid dimensions), fetched on demand via a `requestMap` intent when the
DM switches.

This is the most important structural decision in the document. It bounds the snapshot by *one
map's* content rather than the whole campaign's.

**3. Keep client-local state out of the wire entirely.**

| Stays client-local | Why |
| --- | --- |
| Camera pan/zoom | Per-player view. Legacy synced it only for "centre everyone here". |
| Selected image | Pure UI state |
| Tool mode, brush radius | Pure UI state |
| Ruler points | Never left the client in legacy either |
| Fog stroke preview | Optimistic; discarded when the patch lands |
| Save slots / library | Browser-local by design (D1, Q4) |
| **Image bytes** | Can't cross the relay at all — see [`09`](09-blob-share-server-spec.md) |

### Guardrails

Add a size check in the authority itself, since the server's own check is silent:

```ts
/**
 * UTF-8 byte length, computed by hand.
 *
 * `TextEncoder` is a Web API, not ECMAScript: the Jint sandbox does not provide it, and
 * eslint.config.js bans DOM globals in `src/game/` and `src/authority/` anyway. `String.length`
 * is wrong in the other direction — it counts UTF-16 code units, so a map named "Ténèbres"
 * or any CJK label under-reports, and the server counts BYTES.
 */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }   // surrogate pair → 4 bytes
    else n += 3;
  }
  return n;
}

function guardSize(patch: Patch): Patch | null {
  const bytes = utf8Length(JSON.stringify(patch));
  if (bytes > 400_000) {                           // ~78% of the cap, leaving envelope headroom
    kb.log.error(`patch ${patch.kind} is ${bytes} bytes — refusing to broadcast`);
    return null;
  }
  return patch;
}
```

Better to drop it **loudly in our own log** than to have the platform drop it silently. `utf8Length`
belongs in a shared `src/game/` module so the budget test measures exactly what the guard measures
(and remember to register that file in both sandbox lists).

Add a Vitest that builds a worst-case state and asserts `snapshot()` stays under budget — but
**size the fixture so it actually fails without the narrowing.** By the table above, 8 maps is
~300 KB and passes even with `Patch = MatchState`, so a fixture that small tests nothing. Use ~24
maps, or 8 maps plus the full phase-6 domain, and assert both directions: the narrowed snapshot fits
and the un-narrowed one would not. See [`11`](11-verification.md#tier-2--authority-under-emulation).

Also run `--authority-bench <game-dir>` (the platform's CLI mode) against a realistic map once fog
and tokens are in, to check the **250 ms call budget**. Three consecutive overruns close the lobby.

## Getting a campaign INTO the authority

Easy to miss, because two documents each look like the other covers it — and the naive
implementation has a **terminal** failure mode.

The situation:

- The campaign library is **browser-local to the DM**, in IndexedDB, by design
  ([`08`](08-assets-pipeline.md), `D1`, `Q4`).
- The authoritative state lives in the **sandbox**, and the only way in is `applyIntent`.
- Client→server frames over 512 KiB do not error — the socket is **closed with 1009**
  (`WebSocketHandler.cs:977-982`). And **1009 is not in the SDK's terminal set**; only 1008 is
  (`addons/knockbox/kb-core.js:28`). So the client reconnects, retries the same oversized
  frame, and loops forever.

An 8-map campaign is ~300 KB of JSON and would squeeze through; a 16-map one would not, and would
brick the DM's session with no error anywhere. "Import a `.vtf` and the table sees it" therefore
needs a real protocol, not one big intent.

### Chunked import

```ts
const CHUNK_BUDGET = 200_000;        // bytes of utf8Length(JSON.stringify(chunk)), ~39% of the cap

// DM client:
//  1. beginImport  { campaign: header, chunkCount }   → authority stages a pending import
//  2. importChunk  { token, index, maps: [...] }      × N, each built up to CHUNK_BUDGET
//  3. commitImport { token }                          → atomic swap into live state
```

Rules that make it safe:

- **Pack chunks by measured size, not by map count.** One 200×200 map is ~33 KB; one 500×500 map
  with heavy art is not. Fill a chunk until the next map would cross `CHUNK_BUDGET`, and reject any
  single map that cannot fit alone (surface it as a real error, not a dropped frame).
- **Stage, then swap.** Chunks accumulate in a `pendingImports[token]` side table and become live
  only on `commitImport`, so a DM who disconnects mid-import leaves the table on the old campaign
  rather than half a new one. Drop stale pending imports on `onPlayerLeft` and after a timeout.
- **DM-only, and one at a time.** `beginImport` from a non-DM returns `null`, like every other
  privileged intent.
- **Broadcast nothing until commit**, then send `{ kind: "full" }` — or, better,
  `{ kind: "mapList" }` plus a `{ kind: "map" }` for the active map, which is what the snapshot
  projection already does.
- **Count the intents.** N chunks is N messages against the 30 msg/s inbound budget, whose overage
  *is* terminal. At `CHUNK_BUDGET = 200 KB` even a very large campaign is a handful of messages, so
  this is comfortable — but do not be tempted into per-map chunks.

### Map switching

The same seam covers the other half of "keep the snapshot small". `snapshot()` sends the active map
in full and the rest as summaries, so switching maps needs `requestMap`:

```
DM sends   { kind: "setActiveMap", mapId }
authority  → { kind: "activeMap", mapId }              (broadcast, tiny)
any client { kind: "requestMap", mapId }               when it holds only a summary
authority  → { kind: "map", map }                      (that client, or broadcast)
```

Clients render grid, fog and tokens for a map only once they hold the full record; until then they
show the map's name and a loading state. This is the same "resolve or draw a placeholder" shape the
asset pipeline already uses.

### Recovery after a restart

A server restart drops every lobby and invalidates every ticket (`LobbyManager.cs:6`,
`TokenService.cs:28`), so the DM re-imports. Note what that actually costs, and make sure both parts
are smooth:

1. **The campaign** goes back through the chunked import above.
2. **The blob handles are gone too** — phase 0 sweeps the blob root at startup precisely because
   lobby-anchored handles cannot survive the process ([`09`](09-blob-share-server-spec.md#the-two-races)).
   So the DM must re-`publish()` every image. Content addressing makes this cheap-but-not-free:
   the `HEAD` probe finds nothing (the file was swept), so the bytes really do re-upload.

One reassurance is worth writing down for the DM-facing docs: because the library is browser-local,
**nothing is lost** in a restart — only re-sent.

## The `perRecipient` tension

Open question **Q1**, and it needs a deliberate answer before phase 4.

Legacy has `Token.Hidden` and visibility filters, but **the fog mask is sent to every client** —
players receive the full mask and simply render it opaque. A modified client could read through it.
Legacy accepted that.

The platform offers a faithful alternative:

```ts
export const config: AuthorityConfig = { perRecipient: true };
```

Then `snapshot(forPlayerId)` projects a different view per player, and hidden tokens can be omitted
server-side rather than hidden client-side.

**But `perRecipient` disables deltas entirely.** From the addon:

> *"In this mode there are no deltas and guests need no model: the host sends each player their own
> snapshot."*

So every token nudge re-projects and sends a **full snapshot to every player**: at a six-player
table, six projections and six full frames per token move, each bounded by the 512 KiB cap rather
than by what changed.

Two corrections to the obvious version of this argument, because getting them wrong invites the
wrong fix:

- **The 30 msg/s limiter is not what bites.** It is inbound and per connection
  (`ServerLimits.cs:43-44`), enforced on the client's socket with a terminal 1008. Server→client
  fan-out is not governed by it at all. What bites is the frame cap plus the outbound queue:
  `OutboundCapacity = 1024` with `OutboundOverflow.DropOldest` (`Connection.cs:34`), which for
  supersedable snapshots is *correct* — a dropped snapshot is superseded by the next — but it means
  a slow client silently runs behind under sustained per-recipient traffic.
- **The relay is not the cost either.** It serializes an inbound frame once and hands the same
  `byte[]` to every recipient, so relaying is O(lobby) in socket writes, not in serialization.
  Per-recipient mode is the one path that genuinely serializes per player
  (`ServerAuthority.cs:420-424`).

The real objection is simply that it makes payload size proportional to `players × whole state`
instead of `players × what changed`. It does not scale for a VTT.

| Option | Verdict |
| --- | --- |
| **Broadcast + client-side hiding** (legacy parity) | **Recommended.** Matches legacy exactly, keeps deltas, keeps the port honest about what it is. |
| `perRecipient` | Correct but unaffordable at this state size. |
| Hybrid: broadcast deltas, plus a per-player filtered token list | Possible later; adds real complexity. |

**Recommendation: match legacy.** Document the leak plainly in the game's own docs so a DM knows
hidden tokens are hidden by convention, not by cryptography. Revisit only if it becomes a real
complaint.

## Authority module structure

```
src/game/                    shared, sandbox-safe — NO DOM, NO imports outside relative
  types.ts       MatchState (= DndMapperState), Intent, Patch
  rules.ts       applyIntent + permission policies
  fog.ts         bitset get/set/paint, mask diff (pure)
  grid.ts        snapping, bounds (pure)
  wire.ts        utf8Length + guardSize (pure; shared with the budget test)
  tokens.ts      spawn, move, stack (pure)
  maps.ts        CRUD, ordering (pure)
src/authority/
  authority.ts   createAuthority(kb) — thin: wires kb into rules.ts
```

> **Register every one of those new `src/game/*` files in BOTH `tsconfig.authority.json`'s
> `include` and `eslint.config.js`'s sandbox `files` list.** Neither is a glob. A module missing
> from both is typechecked against the DOM and may call `Date.now()`, failing only in production
> inside a sandbox with no console. See [`02-target-platform.md`](02-target-platform.md).

### `authority.ts` skeleton

```ts
export function createAuthority(kb: Kb): Authority {
  let state: DndMapperState = createInitialState(kb.now());

  return {
    init(players) { state = withPlayers(state, players); },

    applyIntent(fromId, action) {
      const result = rules.applyIntent(state, fromId, action, kb.now());
      if (result === null) return null;          // illegal — broadcast nothing
      state = result.state;
      return guardSize(result.patch);
    },

    snapshot(_forPlayerId) { return projectSnapshot(state); },  // active map full, others summarised

    onPlayerJoined(player) { … },

    onPlayerLeft(playerId) {
      // Owner succession: the platform ships setOwner, the POLICY is ours.
      if (playerId === state.dmPlayerId) {
        const successor = pickSuccessor(state);
        if (successor) {
          kb.setOwner(successor);
          state = { ...state, dmPlayerId: successor };
          return { kind: "dm", dmPlayerId: successor };   // defined in the Patch union above
        }
      }
      return null;   // the server re-broadcasts full state after any roster change anyway
    },
  };
}
```

**DM succession is a real decision, not boilerplate.** If the DM drops, does the table continue?
Legacy had no equivalent — the host owned a SignalR circuit and the room ended with it. Options:
promote the longest-connected player, freeze the session until the DM returns (they have a 60 s
reconnect grace), or end it. Pick one and write it down; the platform will not choose for you.

## Reconnect and late join

The platform gives this mostly for free, but the port must not break it:

- `KBAuthority` sends `{_kb:'sync'}` on `ready`, including after a reconnect.
- The server re-broadcasts full state on **any** roster change.
- **Patches must be absolute** so a delta that overtakes a snapshot still converges.
- Disconnect grace is **60 s**; a player is held in the roster and returns via `player-connected`.
- Tickets last 12 h, but the token secret is per-process — **a server restart invalidates every
  ticket and drops every lobby** (they are in-memory). Sessions do not survive a deploy. Since the
  library is browser-local, the DM can re-import and continue; make sure that path is smooth.

## Testing

Three tiers, cheapest first — the template already wires all three.

1. **Pure rules** — `src/game/rules.test.ts`, `fog.test.ts`, `grid.test.ts`. No `kb`, no network.
   The fog bitset and the snap-to-centre-vs-corner distinction deserve exhaustive tests; they are
   silent-corruption bugs otherwise.
2. **Authority with `fakeKb`** — `createAuthority(fakeKb)`, feed intents, assert patches. Add the
   **snapshot-size budget test** here.
3. **Local emulation** — `authorityController.test.ts` with several `KnockBoxLocalPeer`s running the
   real module, with strict-JSON fidelity checks on. This is where a stray `undefined` or `Date`
   surfaces.

Then manually: `?kbLocal=tab` in two tabs, one as DM.
