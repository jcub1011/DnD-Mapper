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
| Bundler | Vite 8 (Rolldown-based — `vite.authority.config.ts` uses `build.rolldownOptions`) |
| Renderer | **Phaser 4.2.1** — not 3.x |
| UI | **Lit 3** web components, rendered into **light DOM** |
| Tests | Vitest 4 (`environment: "node"`; `happy-dom` is installed but unwired) |
| Lint/format | ESLint 10 flat config + Prettier (100 cols, double quotes, semicolons, trailing commas) |
| TS | strict, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `isolatedModules`; `experimentalDecorators` with `useDefineForClassFields: false` for Lit |

### Layout that matters

```
src/
  game/          ENGINE-AGNOSTIC. Shared by the authority module AND the client.
                 No DOM, no Phaser, no Lit.
    types.ts     The wire contract
    rules.ts     Pure rules
    view.ts      MatchView — the client's read-only replica
    emitter.ts   22-line typed emitter
  authority/     Bundled to dist/authority.js; runs in the SERVER sandbox
    kb.ts        ABI types
    authority.ts ENTRY: createAuthority(kb) + config
  net/           Gameplay ↔ transport seam
    authorityController.ts   The one controller
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

From the template's own README, and all three are load-bearing for this port:

1. **`isHost` is `false` on every client**, including the lobby creator. Never branch game logic on
   it. The member holding lobby powers is the **owner** — gate DM UI on `isOwner`, and handle
   `owner-changed`.
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

## The authority sandbox

The server runs `dist/authority.js` in **Jint 4.16.1**, one `Engine` per lobby, single-threaded off
a per-lobby actor queue.

```csharp
// Games\JsAuthorityRuntime.cs:83-113
var engine = new Engine(o => {
    o.Strict().LimitMemory(options.MaxMemoryBytes)
     .TimeoutInterval(_callTimeout).RegexTimeoutInterval(_callTimeout);
    if (options.MaxStatements > 0) o.MaxStatements(options.MaxStatements);
    o.Constraints.StackOverflowGuard = true;
    o.Constraints.MaxArraySize = options.MaxArrayLength;
});
engine.Global.Delete("Date");
```

| Knob | Default | Meaning |
| --- | --- | --- |
| `AuthorityMaxMemoryBytes` | **32 MiB** | per-invocation allocation budget |
| `AuthorityCallTimeoutMs` | **250 ms** | wall-clock per module call |
| `AuthorityMaxScriptBytes` | **1 MiB** | max size of `authority.js` |
| `AuthorityTickHzMax` | **20 Hz** | clamps `config.tickHz` |
| `AuthorityMaxArrayLength` | 10,000,000 | array growth bound |
| `AuthorityMaxConsecutiveOverruns` | **3** | then the lobby is **closed** |
| `AuthorityQueueCapacity` | 256 | actor inbound channel |

Also: no CLR access, **no module loader** (so `import` fails at load — the module must bundle to a
single file), `Date` deleted (`kb.now()` is the only clock — `engine.Global.Delete("Date")` at
`JsAuthorityRuntime.cs:121`), and per-call constraints re-armed each invocation.

> **Two constraints in that snippet are off by default.** `AuthorityMaxStatements` and
> `AuthorityRecursionLimit` both default to **0**, and the `> 0` guards mean neither is armed —
> arming them costs a measured **4.4× interpreter slowdown**, which the source explains at
> `JsAuthorityRuntime.cs:76-82`. So there is **no deterministic runaway guard**: an infinite loop is
> caught by the 250 ms wall clock and `MaxMemoryBytes`, nothing else. That is fine in practice, but
> do not design as though a statement ceiling will catch a pathological input first.

Failure modes worth internalising:
- **3 consecutive tick overruns** or **5 consecutive contained throws** → the lobby is closed with
  `authority-failed`.
- `budgetRemainingMs()` lets a module bail cleanly before it overruns. It is real
  (`JsAuthorityRuntime.cs:275-280`; the local peer returns a flat 250), but **`src/authority/kb.ts`
  does not declare it** — that file is a hand-written mirror of the ABI, so using the call means
  adding it to the `Kb` interface first.
- There is a `--authority-bench <game-dir>` CLI mode to measure the module against the real budget
  in CI. **Use it** once the fog/token state grows.

### The guards that keep you honest locally

Two mechanisms enforce the sandbox before deployment, and they **do not cover the same files**:

```json
// tsconfig.authority.json — an explicit four-file include, no globs
"include": [
  "src/authority/kb.ts", "src/authority/authority.ts",
  "src/game/types.ts",   "src/game/rules.ts"
]
```

```js
// eslint.config.js:55 — a glob for src/authority/, explicit for src/game/
files: ["src/authority/**/*.ts", "src/game/rules.ts", "src/game/types.ts"],
ignores: ["src/authority/**/*.test.ts", "src/authority/fakeKb.ts"],
```

The ESLint block bans `Date`, `console`, `fetch`, `setTimeout`, `setInterval`, `process`,
`document`, `window`, **and any non-relative import**.

The difference matters, so here is the rule in full:

| New file | `tsconfig.authority.json` | `eslint.config.js` |
| --- | --- | --- |
| `src/game/*.ts` (shared) | **must be added** | **must be added** |
| `src/authority/*.ts` | **must be added** | covered by the glob |
| `src/authority/*.test.ts`, `fakeKb.ts` | not included (correct — they are test-only) | deliberately ignored |

> **Every new shared module under `src/game/` must be added to both lists.** A new `src/game/fog.ts`
> that nobody registers is typechecked against the DOM lib and may call `Date.now()` — and will
> fail only in production, inside a sandbox with no console. `src/game/` is where the port will add
> most of its files (fog, grid, tokens, maps, wire), so this is a recurring chore, not a one-off.

## Wire limits

### The 512 KiB ceiling

```csharp
// Networking\WebSocketHandler.cs:946-951
internal const int MaxMessageBytes = 512 * 1024;
```

Non-configurable — a `const`, not an option. Two enforcement sites with **different failure modes**:

| Direction | Enforcement | Failure |
| --- | --- | --- |
| Client → server | `WebSocketHandler.cs:954-992` | Socket closed with **1009** `MessageTooBig` |
| Authority → clients | `Games\ServerAuthority.cs:442-451` | **Frame silently dropped**, logged server-side; clients never converge |

The second is the dangerous one. An oversized snapshot does not error — the game just stops
updating for everyone, with no client-visible signal.

Note also that **1009 is not in the SDK's terminal set** — `addons/knockbox/kb-core.js:28` (this
repo's vendored copy) sets `TERMINAL_CLOSE_CODE = 1008` and `isTerminalClose` tests only that. So a
client that sends an oversized frame is closed, treats the close as transient, reconnects, and
retries forever. Upstream this logic has since moved to `KnockBox-Games/web/kb-protocol.js:25-29`;
the vendored copy is the one that ships in this game, and it is what the line reference above
means.

**This is the single nastiest interaction in the platform**, and it cuts both ways: an oversized
frame *from* the authority is dropped silently server-side, and an oversized frame *to* the server
closes the socket in a way no SDK recognises as fatal. Neither direction produces an error a player
or a developer can see. Everything in [`06`](06-state-and-authority.md) about patch narrowing and
chunked import exists because of this paragraph.

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

In server-authority lobbies the relay additionally reads the `_kb` discriminator and **drops
client-sent `_kb:"delta"|"state"` frames** — only the server may publish state.

**The escape hatch:** `KBAuthority` ignores any payload lacking the `_kb` envelope —
*"not ours (a raw plugin game message) — ignore"* (`kb-authority.js:203-205`). So a game can send
raw peer-to-peer messages on the same socket that bypass the authority entirely. Useful for
presence, cursors, or transfer signalling — but **not** for bulk bytes, per the numbers above.

## Launch modes

```ts
// src/net/launch.ts
export type LaunchMode = "platform" | "local-tab" | "solo";
```

| Mode | Trigger | Authority |
| --- | --- | --- |
| `solo` | default | your module, emulated in-process |
| `local-tab` | `?kbLocal=tab` | your module, emulated on the elected tab |
| `platform` | `#kbTicket=…` | the real server, sandboxed |

**All three run the same server-authoritative code path**, so there is no single-player path that
can rot. The one emulation gap: locally the module's state lives inside the elected peer, so closing
*that* tab ends the session. The real server survives it.

`?kbLocal=tab` in two browser tabs is the real networked path with no server, and it is the primary
development loop for this port.

### Two boot-ordering hazards, already documented in the template

1. `detectLaunch()` must run **before** the Phaser game boots — the plugin scrubs `#kbTicket` from
   `location.hash` the moment it starts.
2. The controller must be constructed **synchronously in the same task** as `fx.init()`, because
   `KBAuthority` requests its first snapshot from the transport's `ready` event, which a fast
   transport may fire immediately. `AuthorityController` carries a second guard for this
   (`authorityController.ts:68-72`).

Preserve both when the map scene is added.

## Build and export

```bash
npm install             # required — node_modules is absent
npm run dev             # http://localhost:5173
npm run dev             # + open ?kbLocal=tab in TWO tabs for the networked path
npm test                # vitest
npm run typecheck       # BOTH TS projects (app + authority)
npm run build           # typecheck → app bundle → authority bundle
npm run lint
npm run manifest:check
npm run export:game     # → dist-game/<id>.kbg
```

**Build-order trap, documented twice in the template README:** `dist/authority.js` is written by a
*second* Vite pass after the app build has emptied `dist/`. A bare `vite build` afterwards silently
deletes it, and the next pack fails with `serverAuthority module not found`. **Always go through
`npm run build`.**

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

Keep the `"KnockBox"` plugin key, the `this.knockbox` mapping, and the `serverAuthority` filename
`authority.js` — those are platform contract, not naming.

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
- No store library. One authoritative state server-side, one read-only replica client-side, Lit
  `@state()` fields mirroring it.
- FX fire from **observed confirmed state changes**, never from the click — a deliberate
  anti-optimism pattern under server authority. **Keep this for token moves and fog strokes.**
