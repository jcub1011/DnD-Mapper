# 02 — Target Platform

What the KnockBox game platform allows, forbids, and silently drops. Platform citations are
relative to `…\KnockBox-Games\KnockBox.Server\`; target citations are relative to this repo.

## What this repo is today

An **unmodified KnockBox game template**. One commit, 56 tracked files, ~1,454 lines of production
TypeScript, and every identifier still carrying a placeholder name (`knockbox-game-template`,
`game-app`, `GameApp`, a "race to 5 points" demo). `docs/` did not exist before this document set.
`node_modules/` is not installed — **`npm install` is step zero.**

There is no D&D, mapper, grid, token, camera, or asset-loading code to build on. The port is
greenfield inside a fixed frame.

### Stack

| | |
| --- | --- |
| Bundler | Vite 8 (Rolldown-based) — one app build, no separate authority bundle |
| Renderer | **Phaser 4.2.1** — not 3.x |
| UI | **Lit 3** web components, rendered into **light DOM** |
| Tests | Vitest 4 (`environment: "node"`; `happy-dom` is installed but unwired) |
| Lint/format | ESLint 10 flat config + Prettier (100 cols, double quotes, semicolons, trailing commas) |
| TS | strict, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `isolatedModules`; `experimentalDecorators` with `useDefineForClassFields: false` for Lit |

### Layout that matters

```
src/
  game/          ENGINE-AGNOSTIC and pure. No DOM, no Phaser, no Lit; the clock is passed in
                 as `now`. Kept pure for testability — nothing sandboxes it.
    types.ts     The wire contract (Intent, Patch)
    rules.ts     Pure rules: applyIntent, permission policies, projectForPlayer
    view.ts      MatchView — the HOST store: the DM browser's truth
    emitter.ts   22-line typed emitter
  net/           Gameplay ↔ transport seam
    authorityController.ts   The one controller; wraps KBAuthority with perRecipient
    launch.ts                Launch-mode detection
    knockboxPlugin.ts        Phaser global-plugin config per launch mode
  ui/
    app/game-app.ts   Lit root shell; owns the rAF loop
    fx/FxScene.ts     The one Phaser scene — decorative particles only
    fx/fx.ts          Imperative FX facade + knockbox() transport accessor
addons/knockbox/   CLI-managed, hash-verified. DO NOT EDIT.
```

**Dependencies only ever point inward toward `src/game/`.**

## The three rules the platform will not bend on

Adapted from the template's own README (which was written for server authority), and all three are
load-bearing for this port:

1. **The DM is the host.** This game runs host authority in every launch mode, so the lobby
   creator's browser has `isHost: true` and `authority: 'host'` and holds the truth; guests have
   `isHost: false`. The DM is `roster[0]` — the host — and `MatchView` records it as `dmPlayerId`.
   DM-only UI keys off that; there is no owner succession to handle
   ([`06`](06-state-and-authority.md#freeze-on-dm-leave)).
2. **Patches must carry absolute values.** A broadcast delta can overtake a point-to-point snapshot
   on a real socket, so re-applying a patch must be safe. `{ x: 5 }`, never `{ dx: +1 }`.
3. **State is strict JSON.** No `undefined` (use `null`), no `Date`/`Map`/`Set`, no class instances,
   no functions, no cycles. The local harness strict-clones everything crossing the module boundary,
   so violations throw during `npm run dev` rather than only in production.

## Phaser is currently an FX overlay, not a renderer

`src/main.ts` says so outright: *"No Phaser scenes drive gameplay — the game loop runs from
`<game-app>`, and the FX canvas is purely decorative."*

```ts
// src/ui/fx/fx.ts:41-51
this.game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: parentId,
  transparent: true,
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  scene: [FxScene],
  ...(net ? { plugins: { global: [net] } } : {}),
  input: { mouse: { preventDefaultWheel: false } },
  fps: { target: 60 },
});
```

`#fx` is `position:fixed; inset:0; z-index:10; pointer-events:none` — **above** the UI and
click-through. `game-app` is `z-index:1` and owns all interaction.

**The port inverts this** (decision E1). Two things must survive the inversion:

- **The KnockBox plugin is registered on this one game config.** A second `Phaser.Game` would have
  no networking, so the map scene joins *this* game (decision E2).
- **The WebGL context-loss guards** (`fx.ts:61-72`). Losing context on a decorative particle layer
  is cosmetic; losing it on the map renderer is a blank table. Keep and extend them.

`Scale.RESIZE` at displayScale 1 means canvas coordinates equal viewport CSS pixels, so DOM rects
map straight on with no conversion — convenient for anchoring Lit UI to world positions.

## The authority sandbox (not used)

The platform can run a game-supplied `serverAuthority` module in a Jint sandbox (no `Date`, a
`kb.now()` clock, a 250 ms / 32 MiB per-call budget, lobby closed after repeated overruns). **This
game does not use it:** the manifest has no `serverAuthority` key, so every lobby runs host
authority ([Host mode](#host-mode-phase-0-spike-findings)) and none of the sandbox's constraints or
local guards apply.

## Wire limits

### The 512 KiB ceiling

```csharp
// Networking\WebSocketHandler.cs:946-951
internal const int MaxMessageBytes = 512 * 1024;
```

Non-configurable — a `const`, not an option. Two enforcement sites with **different failure modes**:

| Direction | Enforcement | Failure |
| --- | --- | --- |
| Client → server (any inbound frame) | `WebSocketHandler.cs:954-992` | Socket closed with **1009** `MessageTooBig` |
| Server authority → clients (legacy path, `Games\ServerAuthority.cs:442-451`) | not used by this game | **Frame silently dropped**, logged server-side |

In host mode a host → guest state frame is an ordinary *inbound* frame from the DM's socket, so it
meets the first row: an oversized per-player snapshot is never relayed, the guest never converges,
and nothing on the guest says why. Either way the game just stops updating, with no player-visible
signal. Each per-player snapshot is bounded by one active map
([`06`](06-state-and-authority.md#strategy--three-rules)), but **nothing measures it before send**
today ([`06`](06-state-and-authority.md#guardrails)).

Note also that **1009 is not in the SDK's terminal set** — `addons/knockbox/kb-core.js:28` (this
repo's vendored copy) sets `TERMINAL_CLOSE_CODE = 1008` and `isTerminalClose` tests only that. So a
client that sends an oversized frame is closed, treats the close as transient, reconnects, and
retries forever. Upstream this logic has since moved to `KnockBox-Games/web/kb-protocol.js:25-29`;
the vendored copy is the one that ships in this game, and it is what the line reference above
means.

**This is the single nastiest interaction in the platform.** An oversized frame closes the socket in
a way no SDK recognises as fatal, and in host mode the socket that sends every state frame is the
**DM's** — so one oversized snapshot can put the host in a reconnect loop that resends it. No error
reaches a player or a developer. Everything in [`06`](06-state-and-authority.md) about bounding the
snapshot to one map exists because of this paragraph.

### Rate limiting

```csharp
// Networking\ServerLimits.cs:41-57
config.GetValue("KnockBox:GameMessagesPerSecond", 30.0),
config.GetValue("KnockBox:GameMessagesBurst",     60.0),
```

**30 messages/second sustained, 60 burst, per connection.** Nothing overrides these in
`appsettings.json`, so that is what runs. The same budget also carries `SetLobbyOpen`,
`KickPlayer`, `Log` and `PlayLog`.

Violating it is **terminal**: the server sends `Error{rate_limited}` and closes with **1008**, which
the SDK *does* treat as terminal — `_stopped = true`, no reconnect. The player's session is dead
until the iframe is rebuilt.

`GameMessagesPerSecond`/`Burst` are operator-editable at runtime; `MaxMessageBytes` is not.

In host mode the DM's connection carries **every** state frame — one `sendTo` per guest per accepted
intent — so the DM's budget is divided by the table size, and a 1008 on the DM's socket ends the
session for everyone. See [`06`](06-state-and-authority.md#fan-out-budget).

### Backpressure

```csharp
// Networking\Connection.cs:31-34
private const int OutboundCapacity = 1024;
```

Data sockets use `OutboundOverflow.DropOldest` — correct for supersedable state snapshots, and
**catastrophically wrong for anything sequential**. On overflow the oldest queued frame is evicted
silently. There is no ack, no retransmit, and no sequence-gap detection anywhere in the protocol.

### Why images cannot cross the relay

Putting those together for a 20 MB battlemap:

| Step | Number |
| --- | --- |
| Usable payload after base64 (×4/3) and JSON envelope | ~380 KiB/message |
| Messages required | **~54** (a 40 MB map: ~108) |
| Burst allowance | **60**, then 30/s sustained |

**The disqualifying problems are not the message count.** A paced sender could push 108 messages in
~3.6 s without tripping the limiter at all. What rules it out:

| Problem | Why it is fatal for bulk transfer |
| --- | --- |
| **`DropOldest` on overflow** | `OutboundCapacity = 1024` with `OutboundOverflow.DropOldest` (`Connection.cs:34`) — correct for supersedable snapshots, catastrophic for a byte stream. A slow receiver silently loses chunks in the middle. |
| **No acks, no sequencing, no gap detection** | Confirmed absent from the entire protocol. So the loss above is not merely possible, it is **undetectable**: the receiver cannot know a chunk is missing, and the sender cannot know to resend. |
| **No chunking protocol at all** | There is nothing to build on. Reassembly, ordering, retry and integrity would all be new game-level code carried over a transport that actively fights it. |
| **Per-hop JSON** | `GameMessage.Payload` is a `JsonElement`, so every frame is fully deserialized and re-serialized on the relay (`WebSocketHandler.cs:750`) — base64 megabytes through a JSON parser, per message. |
| **O(lobby size) fan-out** | Serialization happens once and the buffer is shared, but every recipient still gets a full socket write of every chunk. |
| **Zero headroom** | Gameplay traffic shares the same budget, and exceeding it is a **terminal 1008** with no reconnect. |

The relay is explicitly sized for *"a host broadcasting state ~20×/s"* (`ServerLimits.cs:5-6`, which
also notes that *"each game frame fans out O(lobby size)"*). It is a state relay, not a file
transfer.

**This is why [`09-blob-share-server-spec.md`](09-blob-share-server-spec.md) is phase 0.**

## The relay, and the escape hatch

```csharp
// Networking\WebSocketHandler.cs:693-779 — HandleGameMessage
var bytes = ConnectionManager.Serialize(m with { From = conn.PlayerId });
case "all":  foreach (var p in lobby.Players) …SendRawToGame(p.Id, bytes);
case "host": …SendRawToGame(lobby.HostId, bytes);
default:     if (lobby.Contains(m.To) && …) SendRawToGame(m.To, bytes);
```

> **Server-mode only:** in server-authority lobbies the relay additionally reads the `_kb`
> discriminator and drops client-sent `_kb:"delta"|"state"` frames — only the server may publish
> state. Host-mode lobbies (this game) relay them untouched, which is what lets the DM's per-player
> snapshots through at all — and why any peer can forge one
> ([Forgery posture](#forgery-posture--accepted-under-dm-trusted-model)).

**The escape hatch:** `KBAuthority` ignores any payload lacking the `_kb` envelope —
*"not ours (a raw plugin game message) — ignore"* (`kb-authority.js:218-220`). So a game can send
raw peer-to-peer messages on the same socket that bypass the authority entirely. Useful for
presence, cursors, or transfer signalling — but **not** for bulk bytes, per the numbers above.

## Host mode (Phase 0 spike findings)

This game runs host authority. `export/GAME.json` has **no `serverAuthority` key**, which opts every
lobby out of the server sandbox. First verified on scratch branch `spike/phase-00-host-mode`
(manifest key absent, boot path code-cited, harness green, branch deleted): the platform falls back
to the host contract in `normalizeReady` (`addons/knockbox/kb-core.js:145-158` — `authority`
defaults to `'host'`, owner derivable only when we ARE the host). This section replaces the relay
description above for this game's lobbies.

### Truth table

| | Server-authority (legacy) | Host mode (this game) |
| --- | --- | --- |
| `authority` on `ready` | `'server'` | `'host'` (the default when the server sends no `authority` field) |
| `isHost` | `false` on **every** client, incl. creator | `true` on the lobby creator (DM), `false` on guests |
| `ownerId` / `isOwner` | creator until `kb.setOwner` moves it | creator (DM) initially; same `setOwner` / `owner-changed` mechanism |
| `sendToHost` goes to | the server actor, never a player (`knockbox-plugin.js:164-177`) | the DM player's browser — `Hub.deliver` targets `peers[0]` (`knockbox-local.js:115-126`); tabs deliver only when `isHost()` (`_onGame:306-311`, self-echo `send:316-326`) |
| State fan-out from the authority | server broadcast | DM → each guest: one `sendTo(pid, {_kb:'state'})` per non-host player under `perRecipient` (relay `default:` case, not `case "all"`) |
| Kick / open-close enforced by | server (non-owner sends ignored) | DM host client (same opcodes, host-enforced) |
| `from` on state frames | `'server'` (reserved sender id) | DM's `playerId` — there is no `'server'` sender |

### What activates in `KBAuthority`

With `authority:'host'`, the branches that are dead under server authority come alive
(`addons/knockbox/kb-authority.js`; `src/net/authorityController.ts` constructs it with
`{ perRecipient: true }`):

* Guest sync on ready (`172-177`); host renders its own projected view into `currentView` and
  re-pushes everyone on a host reconnect (`178-184`).
* Host re-sends state on any roster change, joins and leaves (`189-196`). `_broadcastState`
  (`200-215`) under `perRecipient` loops the roster: the host's own projection becomes its
  `currentView`, every other player gets `sendTo(pid, {_kb:'state', state: snapshot(pid)})`.
* Host-only intent handling (`224-244`): a non-null `applyIntent` result is **only an accept
  signal** — under `perRecipient` the host calls `_broadcastState()` (a per-player snapshot to each
  guest), never `sendToAll(delta)`. Host-only sync answers with that one guest's projection
  (`245-247`).
* The `from !== 'server'` forgery guards (`252`, `261`) go **inert** — the check requires
  `net.authority === 'server'`, so in host mode it never fires.
* Guests adopt `payload.state` as `currentView` and keep no model; `applyPatch`/`applySnapshot` are
  unused (`MatchView` no longer implements them). `currentView` is deep-frozen under the local
  transport (dev only) so an accidental write throws.
* `broadcastState()` (`142-146`) is the public host-only re-publish, used after a save load.

DM intent → guest convergence was first demonstrated on the spike with two `KnockBoxLocalPeer`
`process` peers and **no** `authority:` option (true host mode, no virtual server actor). The same
shape is now the permanent test: `src/net/authorityController.test.ts` — guest intents validate on
the host, each guest converges on its own projection, late join and `broadcastState` converge.

### Forgery posture — accepted under DM-trusted model

In host mode **any peer can forge `_kb` frames** — the spike harness proved a delta stamped
`from:'evil-peer'` is adopted, and the same holds for the `_kb:'state'` frames guests now render
directly; the relay does not drop client state frames in host lobbies. This is accepted: the rewrite's locked decisions are **DM trusted** (no server
anti-cheat) and **freeze on DM leave**. Do not reintroduce per-frame authentication later; the
answer to malicious guests is the lobby kick, not the wire protocol.

### Live-relay limits still bind host→guest; saves are exempt

Only the *sender* of state changes (DM browser instead of server actor). The path is the same
relay, so all of the above still applies to host→guest frames: the 512 KiB ceiling, 30 msg/s + 60
burst with terminal 1008 on violation, and `OutboundCapacity 1024 / DropOldest` with no acks or
sequencing. Two consequences are new with host mode and `perRecipient`, and both are **open**:

- **Fan-out multiplier.** Every accepted intent costs N−1 `sendTo` frames from the DM's socket (the
  DM's own intents also round-trip the relay via `sendToHost` → `case "host"`). At 16 seats that is
  ~2 accepted intents/s sustained before a terminal 1008 on the host — and `updateHostKeys` alone
  may dispatch up to 20/s. To verify in Phase 06 ("16-player fan-out"); see
  [`06`](06-state-and-authority.md#fan-out-budget).
- **Unguarded snapshot size.** The per-player snapshot is built and sent inside the CLI-managed
  addon, so nothing measures it before it hits the relay. `guardSize`/`utf8Length`
  (`src/game/wire.ts`) remain as the frame measure for the parked per-recipient delta hook
  (KnockBox-Games#62); `src/game/snapshotBudget.test.ts` bounds a large campaign's projection under
  400 KiB, but no runtime check exists. See [`06`](06-state-and-authority.md#guardrails).

Loading a campaign no longer needs a wire protocol at all: the DM's browser is the authority, so a
save slot is swapped directly into `MatchView` and fanned out as ordinary per-player snapshots
([`06`](06-state-and-authority.md#getting-a-campaign-into-the-authority)). The old chunked
`beginImport`/`importChunk`/`commitImport` protocol is gone.

Saves are exempt: `src/storage/` holds zero references to `sendTo*`, `KnockBox`, `WebSocket`,
`fetch(` or the transport — persistence is pure-local IndexedDB writes with no network leg, so the
relay budget never sees it.

## Launch modes

```ts
// src/net/launch.ts
export type LaunchMode = "platform" | "local-tab" | "solo";
```

| Mode | Trigger | Authority |
| --- | --- | --- |
| `solo` | default | the DM's browser — host of a one-player in-process lobby |
| `local-tab` | `?kbLocal=tab` | the DM's browser — the elected tab (index 0) |
| `platform` | `#kbTicket=…` | the DM's browser — the lobby creator; the real server only relays |

**All three run the same host-authoritative code path** (`isHost: true` and `authority: 'host'` on
the DM), so there is no single-player path that can rot. There is also **no emulation gap** any
more: in every mode the truth lives in the DM's `MatchView`, so closing or reloading the DM's tab
ends the session everywhere, the real platform included. That is the locked **freeze on DM leave**
decision (no host migration); the Phase 04 "waiting for DM" overlay is not built yet
([`06`](06-state-and-authority.md#freeze-on-dm-leave)).

`?kbLocal=tab` in two browser tabs is the real networked path with no server, and it is the primary
development loop for this port.

### Two boot-ordering hazards, already documented in the template

1. `detectLaunch()` must run **before** the Phaser game boots — the plugin scrubs `#kbTicket` from
   `location.hash` the moment it starts.
2. The controller must be constructed **synchronously in the same task** as `fx.init()`, because
   `KBAuthority` requests its first snapshot from the transport's `ready` event, which a fast
   transport may fire immediately. The `AuthorityController` constructor carries a second guard
   for this (`src/net/authorityController.ts`, the `ORDERING GUARD` block): if `net.playerId` is
   already set it re-sends `{_kb:'sync'}` and re-emits the roster.

Preserve both when the map scene is added.

## Build and export

```bash
npm install             # required — node_modules is absent
npm run dev             # http://localhost:5173
npm run dev             # + open ?kbLocal=tab in TWO tabs for the networked path
npm test                # vitest
npm run typecheck       # the one TS project
npm run build           # typecheck → app bundle
npm run lint
npm run manifest:check
npm run export:game     # → dist-game/<id>.kbg
```

There is **one TypeScript project and one Vite build**. No authority bundle, no second build pass,
and so no build-order trap: `export/GAME.json` names no `serverAuthority` module for the pack step
to look for.

### The template rename is still pending

`npm run manifest:check -- --strict` runs in the release workflow (`.github/workflows/release.yml`)
and **fails** on the placeholder values. Note the `--`: the script reads
`process.argv.includes("--strict")`, and `npm run manifest:check --strict` **silently swallows the
flag** (npm consumes it as its own config), so the gate passes without checking anything. The rename
is part of phase 1:

| What | Where |
| --- | --- |
| Package name | `package.json` → `name` |
| Page title | `index.html` → `<title>`, `.boot-mark` |
| Custom element | `index.html`, `src/main.ts`, `src/ui/app/game-app.ts` |
| Component classes | `GameApp`, `GameElement` |
| CSS classes | `.game-*`, `game-shake`, `game-boot` |
| Manifest | `export/GAME.json` — `id`, `name`, `version`, `description`, `author`, `license`, `homepage`, `bugs`, `tags` |

Keep the `"KnockBox"` plugin key and the `this.knockbox` mapping — those are platform contract,
not naming. Do **not** add a `serverAuthority` key back to the manifest: its presence is what would
switch lobbies to server authority.

**Picking `id` matters:** it is the catalog key, the install directory *and* the URL segment, so
renaming later is a reinstall rather than a metadata edit.

`maxPlayers` needs raising from the template's 8 to whatever a table realistically seats.

### Don't touch `addons/`

`addons/knockbox/` is CLI-managed and hash-verified in `knockbox.json`. Editing a file makes
`knockbox addon check` report `MODIFIED` and blocks `addon update`. It is in `.prettierignore` and
the ESLint ignores for exactly this reason.

If phase 0 adds a blob API, it arrives here through `npm run addon:update` after a coordinated
`addons-v*` release — **not** by hand-editing these files.

## Conventions to match

The template's style is distinctive and the port should not read as foreign:

- **Heavy prose block headers on nearly every file**, explaining *why* rather than what.
- `PascalCase` classes/types, `camelCase` functions, `SCREAMING_SNAKE` module constants.
- Files: `camelCase.ts` modules, `PascalCase.ts` classes, `kebab-case.ts` custom elements.
- Tests colocated as `*.test.ts`.
- `import type { … }` for type-only imports; `override` mandatory; `readonly` where possible.
- Arrow-function class properties for bound handlers:
  `private readonly onStateChanged = (): void => {}`.
- No store library. Truth lives in the DM's `MatchView`; guests render the host's per-player
  projection (`currentView`) and keep no model. Lit `@state()` fields mirror whichever the
  controller's `state` returns.
- FX fire from **observed confirmed state changes**, never from the click — a deliberate
  anti-optimism pattern. It still holds under host authority, including on the DM's own browser:
  the host's intents go through the same `applyIntent` path and may be rejected. **Keep this for
  token moves and fog strokes.**
