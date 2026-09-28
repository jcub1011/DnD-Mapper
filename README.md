# D&D Mapper (TypeScript · Lit · Phaser)

A virtual-tabletop map editor and session viewer for the [KnockBox](#) platform — a port of the
Blazor `KnockBox.DndMapper` plugin. The DM builds maps (grid, images, tokens, fog of war, freehand
markup), runs character sheets, dice, loaded dice and initiative, and the players see exactly what
the DM lets them see.

- **TypeScript-first** — strict mode, engine-agnostic game logic in `src/game/`, unit-tested with
  Vitest.
- **Lit** web components for the DOM UI; **Phaser** renders the battle map.
- **Host-authoritative networking**: the DM's browser holds the truth and sends every player their
  own filtered view. The KnockBox server is just a relay.
- **CLI-managed KnockBox addons** (`knockbox addon`) instead of hand-copied files.
- **Export tooling** — package an installable `.kbg` with one command.

## Quick start

```bash
npm install
npm run dev             # http://localhost:5173
npm test                # vitest
npm run typecheck       # tsc --noEmit (one TS project)
npm run build           # typecheck → vite build → dist/
npm run lint
npm run manifest:check  # is export/GAME.json shippable?
npm run export:game     # manifest:check → build → dist-game/<id>.kbg
```

Open `http://localhost:5173/?kbLocal=tab` in two browser tabs to play against yourself over the
real networked path — no server required. The first tab is the host (and the DM).

---

## How multiplayer works here

The game runs in **host-authoritative mode**. The DM's browser is the host in every launch mode
(`isHost: true`, `authority: 'host'`); the KnockBox server only routes frames between browsers:

```
  guest UI ──sendIntent──► KBAuthority ──{_kb:'intent'}──► relay ──► host (DM browser)
                                                                        │ MatchView.applyIntent
                                                                        │ projectForPlayer(each guest)
  guest UI ◄──changed── currentView ◄──{_kb:'state'}── relay ◄──────────┘ sendTo(guest), one per player
```

- **The truth lives in `MatchView`** (`src/game/view.ts`) on the DM's browser. It validates every
  intent with the pure rules in `src/game/rules.ts` and returns `null` for anything illegal.
- **True per-player filtering.** `src/net/authorityController.ts` wraps
  `addons/knockbox/kb-authority.js` with `perRecipient: true`. On every accepted intent, roster
  change or host reconnect, the host sends each non-host player **its own** full snapshot —
  `snapshot(forPlayerId)` → `projectForPlayer` — via `sendTo`. There are no deltas on the wire.
- **What a player's snapshot omits** (`projectForPlayer`): inactive maps ship as `MapSummary`;
  hidden tokens and images; tokens on fogged cells the player doesn't own; sheets failing
  `mayViewSheet` (and notes/HP where the player may not read them); other players' rolls when
  `rollsVisibleToPlayers` is off; hidden/fogged combatants and `pendingInitiative`; and loaded-dice
  rules unless their visibility is `VisibleToAll`. The DM's view is unchanged. The fog mask itself
  is still broadcast (legacy parity), and loaded-dice `appliedRules` stamps on rolls are so far
  hidden client-side only. Other UI gates (sheet visibility, token ghosting) are defence-in-depth.
- **Guests keep no model.** They render `authority.currentView`, the last snapshot the host sent.
- **Locked decisions:** freeze on DM leave (no host migration), the DM is trusted (no anti-cheat
  beyond the rules), true per-player filtering. The design history is in
  [`docs/architecture-rewrite/`](docs/architecture-rewrite/README.md) and
  [`docs/blazor-port/06-state-and-authority.md`](docs/blazor-port/06-state-and-authority.md).

### Three rules that will bite you if you skip them

1. **The DM is the host.** `isHost` is `true` only in the DM's browser, in every launch mode. Branch
   on it for *role* (host store vs. guest view); gate *game* permissions on `isDm` (the state's
   `dmPlayerId`); gate *lobby* powers (kick, open/close) on `isOwner`. When the host leaves, the
   lobby ends on every transport — there is no DM succession.
2. **Keep patches narrow and absolute.** Today the `Patch` a rule returns is only an accept signal —
   the host always re-sends full per-player snapshots. But per-recipient deltas are coming
   (KnockBox-Games#62), and then patches cross the wire again: `{ score: 5 }`, not `{ delta: +1 }`,
   and never a whole collection.
3. **State is strict JSON.** No `undefined` (use `null`), no `Date`/`Map`/`Set`, no class instances,
   no functions. Everything the host sends is serialized; the projection tests assert guest
   snapshots are strict JSON and fit the frame budget.

### The host store

`MatchView` (`src/game/view.ts`) is the only place truth changes:

| Method | What it does |
| --- | --- |
| `applyIntent(fromId, action)` | Runs `rules.applyIntent` with `Date.now()` as `now`; `null` = rejected, nothing is sent |
| `snapshot(forPlayerId)` | `projectForPlayer` for that player (the DM gets the full view) |
| `applyLoaded(state)` | Swaps a loaded save slot in; the controller then calls `broadcastState()` |
| `handlePlayerLeft(id)` | Non-DM leave: their tokens become `NPCToken` (`ownerUserId: null`, `representsUserId` set), sheets likewise, combatant ownership cleared |
| `setRoster(players)` | Feeds lobby membership in so DM-gated intents validate; seeds an empty DM slot |

`src/game/` stays **pure** — no DOM, no timers, no clock reads (the clock arrives as `now`) — so
the rules and the projection are testable in plain Node. Log through `createLogger` (`src/log.ts`).

**Saves and assets.** Saves are pure-local IndexedDB writes (`src/storage/`) with zero network.
Loading a save re-publishes its image blobs (`src/assets/blobTransport.ts`), swaps the state into
the host store and fans out fresh snapshots — no chunked import.

**Open risk: fan-out rate.** Each accepted intent costs the host N−1 outbound frames. A high-rate
intent stream — `updateHostKeys` for loaded dice, throttled to 20/s — can push the host past the
relay's 30 msg/s (60 burst, then a 1008 close) with several players connected. To be verified in
[`docs/architecture-rewrite/phase-06-verification.md`](docs/architecture-rewrite/phase-06-verification.md).

## Launch modes

The game detects how it was launched (`src/net/launch.ts`). **All three run the same
host-authoritative code path** — there is no single-player path that can rot:

| Mode        | How                                   | Host                                                      |
| ----------- | ------------------------------------- | --------------------------------------------------------- |
| `solo`      | default                               | this browser (you are the DM)                              |
| `local-tab` | `?kbLocal=tab`                        | the first tab (BroadcastChannel between tabs)              |
| `platform`  | `#kbTicket=…` in URL (KnockBox shell) | the DM's browser, over the real relay                      |

In `local-tab`, closing the first tab ends the lobby for the others — the same "freeze on DM leave"
behaviour the platform shows when the DM disconnects.

## Testing your game

Three tiers, cheapest first — only the first two are needed to iterate.

```bash
npm test    # tiers 1 and 2
```

1. **Pure tests** — rules and verbs (`src/game/rules.test.ts` and friends), the projection matrix
   (`projection.test.ts`, `visibility.test.ts`), player leave (`playerLifecycle.test.ts`), the host
   store (`view.test.ts`) and the per-player snapshot budget (`snapshotBudget.test.ts`). Fastest
   loop.
2. **Host-mode relay sync** (`src/net/authorityController.test.ts`) — several `KnockBoxLocalPeer`s
   in `mode: 'process'` in one realm; the first is the host, exactly as the relay reports live. It
   covers convergence, rejected intents, a guest leaving and the host leaving. The UI shell is
   tested against a mock controller (`src/ui/app/dndm-app.test.ts`).
3. **A real platform** (optional) — drop the `.kbg` into a local KnockBox instance and join from
   two browsers.

`src/net/addons.smoke.test.ts` is a canary for the UMD→ESM addon interop and the blob API: if a
Vite or Vitest upgrade breaks it, that file fails with an obvious message instead of a mystifying
gameplay failure.

---

## Project layout

```
addons/knockbox/      KnockBox client addons — installed and verified by the CLI. Do not edit.
knockbox.json         Which addon versions this game is built against. Commit it.
export/               KnockBox export metadata: GAME.json manifest + thumb.svg
scripts/
  check-manifest.mjs  Validates GAME.json against the marketplace schema before packing
.github/workflows/
  release.yml         Manual dispatch -> checks -> .kbg -> GitHub release + tag -> marketplace entry
docs/                 Port plans: blazor-port/, blazor-port-pt-2/, architecture-rewrite/
test/fixtures/        Golden .vtf archive for import tests
src/
  game/               Pure, engine-agnostic rules (no DOM) — runs on the host, tested in Node
    types.ts          The wire contract: MatchState, Intent, Patch (strict JSON only)
    domain.ts         Domain model: maps, tokens, sheets, rolls, combat, settings
    rules.ts          applyIntent + projectForPlayer — the single source of truth
    view.ts           MatchView: the host store
    visibility.ts, fog.ts, dice.ts, loadedDice.ts, combat.ts, …  subsystem rules
    wire.ts           Frame-size guard (UTF-8 byte counting)
  net/                Gameplay ↔ transport seam
    controller.ts     GameController / ControllerEvents — the only surface the UI sees
    authorityController.ts  The one controller: KBAuthority (perRecipient) + MatchView
    transport.ts      KnockBoxTransport — what both plugins satisfy structurally
    launch.ts         Launch-mode detection
    knockboxPlugin.ts Phaser global-plugin config per launch mode
    hostInput.ts      DM held-key streaming for loaded dice
    phaserGlobal.ts   Sets globalThis.Phaser before the UMD addons load
    knockbox-addons.d.ts  Ambient types, redirected at the addon's own .d.ts
  storage/            IndexedDB save library (LibraryService)
  assets/             Image pipeline and content-addressed blob sharing
  vtf/                .vtf (Virtual Table Format) import/export
  lib/dice-box/       Vendored 3D dice
  ui/
    app/dndm-app.ts   Root shell: renders the view, sends intents
    app/GameElement.ts  Lit base (light DOM, auto-cleanup subscriptions)
    map/              Phaser MapScene and its layers (tokens, images, fog, markup, ruler)
    panels/, modals/, canvas/, dice/, display/, markup/, lobby/, …  Lit components
    styles/           tokens.css, base.css and per-feature sheets
  log.ts              App-wide logger (console + KnockBox server sink)
  theme.ts            FX colors + reduced-motion helper
  main.ts             Bootstrap: detect launch → boot Phaser → build controller → mount <dndm-app>
```

## Keeping the KnockBox addons current

The addons in `addons/knockbox/` are installed by the `knockbox` CLI and recorded — with a hash per
file — in `knockbox.json`. Both are committed. **Don't edit anything in `addons/`**: a modified file
makes `check` report `MODIFIED` and blocks `update` (which is why `addons/` is in `.prettierignore`
and the ESLint ignores).

```bash
npm run addon:check     # anything to do? changes nothing; safe in CI
npm run addon:update    # move to the newest published version
npx knockbox addon add phaser   # repair: reinstall the recorded version
```

**Updating the addon does not update your build.** The addon code is bundled by Vite, so rebuild and
repack afterwards for players to get it. The `sdk` stamp the packer writes into the shipped
`GAME.json` is what lets an operator spot a game still running old client code.

## Exporting for KnockBox

```bash
npm run export:game
```

This builds and packages everything in `dist/` into `dist-game/<id>.kbg` — a single drop-in file
an administrator copies into the server's games directory, where it installs itself with no
restart. Packing validates your manifest against the rules the server enforces.

- **Packing is slow on purpose** — Brotli at quality 11. Add `--quality 4` while iterating.
- **The manifest's `version` is what stamps the package.** `knockbox pack --version` only
  overrides the `.kbg` header's build label, so leave it off unless you want a label
  `GAME.json` deliberately doesn't carry.
- **Install into a local KnockBox platform** by pointing the packer at its games directory:

  ```bash
  KNOCKBOX_GAMES_DIR=/path/to/KnockBox-Games/games npm run export:game
  ```

> Picking `id`: it is the catalog key, the install directory **and** the URL segment, so renaming
> it later is a reinstall rather than a metadata edit. This game uses `dnd-mapper`.

**Manifest (`export/GAME.json`) fields.** `GAME.json` is the single source of truth for all of
this — the packer, the server and the marketplace all read it, and nothing here is declared
anywhere else in the repo. **to publish** in the Required column means the server runs happily
without it but the marketplace publish step refuses (or, worse, invents) a value.

| Field | Required | Notes |
|---|---|---|
| `$schema` | no | Points at the marketplace's published schema so an editor autocompletes and validates this file. Ignored by the packer and the server. |
| `id` | yes | Catalog key, install directory **and** URL segment; one path segment, no `/`. **Publishing to the shared catalog? Use `<owner>-<game>`.** The catalog refuses duplicate ids, so the first publisher of a bare name holds it for everyone — and renaming later is a reinstall, not a metadata edit. |
| `name` | yes | Display name in the lobby browser. |
| `version` | to publish | **Your build's** version, semver. Stamped into the `.kbg` header, and what the marketplace compares against an operator's installed copy to offer an update. |
| `minAppVersion` | no | The **oldest server** this build runs on — a different question from `version`. Below it the game reports `Incompatible`, which outranks "update available", so it is never offered; an operator can force it with **Install Anyways**, which leaves the game *staged* rather than playable. Omit it and publishing declares `1.0.0` — "any server" — on your behalf. |
| `maxAppVersion` | no | Inclusive upper bound. Rarely wanted: it locks the game out of every future server. |
| `author` | to publish | Listing attribution; a bare string or `{ "name", "email" }`. |
| `license` | no | SPDX identifier (`MIT`, `Apache-2.0`), shown in the listing. |
| `homepage` / `bugs` | no | `https://` links shown in the listing. |
| `contentRating` | no | Self-declared `everyone` / `teen` / `mature` — a platform label, not an ESRB/PEGI rating. Worth declaring even when it's `everyone`: added later, an absent rating can't be told apart from an unrated game. |
| `description` | no | One line, matched by the home page's search box. Not drawn on the tile. |
| `tags` | no | Category labels; drawn as chips on the tile and matched by search. |
| `entry` | yes | Entry HTML inside the build (`index.html`). |
| `thumbnail` | no | Lobby thumbnail, relative to `export/` (`thumb.svg`). |
| `minPlayers` | no | Shown on the tile and used by the home page's **Players** filter; defaults to `1`. **Display only** — nothing is gated on it, so the game still loads for one player. The packer rejects a value outside `1..maxPlayers`; a server that meets one clamps it and warns rather than dropping the game. |
| `maxPlayers` | yes | Maximum concurrent players (> 0); joins are refused past it. |
| `createdAt` / `updatedAt` | no | ISO 8601 timestamps behind the home page's **Newest** and **Recently Updated** sorts. Omitted, the server derives them from this file's own timestamps — which for a `.kbg` means *when that build was installed*, and a reinstall resets it. Set `createdAt` to hold a stable position across releases. |
| `themeColor` / `themeTextColor` | no | CSS colors the shell tints the in-game header with. Shell-validated, so an invalid value is ignored rather than injected. |
| `crossOriginIsolated` | no | `true` only for threaded engine exports needing `SharedArrayBuffer`. Leave it off here. |
| `serverAuthority` | no | Platform opt-in for a server-run authority module. **This game does not use it** — it is host-authoritative, the platform default — so leave it out. |
| `authorityWords` | no | Server-only dictionaries for `kb.words`; requires `serverAuthority`. Not used by this game. |
| `sdk` | — | Don't write this one: `knockbox pack` stamps the installed addon versions into the *packaged* copy, leaving your file alone. It's how an operator spots a game running old client code. |

## Publishing to the marketplace

`npm run export:game` produces the artifact; getting it into the shared catalog is a second step,
and it's where `version`, `minAppVersion`, `author`, `license`, `contentRating`, `homepage` and
`bugs` actually take effect — the game server itself reads none of them.

`.github/workflows/release.yml` wires this up via a manual workflow dispatch (`Actions` → `Release` → **Run workflow**):

- **Dynamic Tagging:** Sourced directly from `version` in `export/GAME.json` (e.g. `0.1.0` becomes `v0.1.0`).
- **Replace Existing Tag:** Overwrites an existing release and tag with the same version number if enabled. When `false` (the default), the workflow checks early and fails immediately if the tag already exists.
- **Draft:** Builds and packages the game and uploads the `.kbg` as a workflow build artifact without creating a git tag, creating a GitHub release, or updating the marketplace.

Add a `MARKETPLACE_TOKEN` secret (a PAT with write access to the catalog repo) to enable marketplace sync; without it that step is skipped, so a game you only ever hand to your own servers needs no extra setup.

### Failing fast

An invalid manifest is caught in three places, deliberately overlapping:

| Where | When | Catches |
| --- | --- | --- |
| Your editor | as you type | the `$schema` key makes the manifest self-validating |
| `npm run manifest:check` | every `npm run export:game` | schema violations — packing is blocked |
| `sync-catalog` | every publish | the same schema again, plus `author` / `description` / `minAppVersion` |

The last one is the authority: it runs in the marketplace's own code and cannot be skipped, and it
validates the catalog it writes as well as your manifest, so a rejected publish never leaves a
broken entry behind. The first two exist so you hear about a typo in seconds rather than at release
time.

`manifest:check` also warns while `export/GAME.json` still holds the original template's placeholder
values, and the release workflow runs it as `--strict`, where those warnings become failures.

The action reads `export/GAME.json`, finds `dist-game/<id>.kbg`, hashes it and writes one catalog
entry derived entirely from your manifest. Two things worth knowing:

- **The catalog commits to a SHA-256, not to a URL.** The download URL is derived from the repo,
  the tag and the `<id>.kbg` asset name, so the release has to carry the packer's output under
  exactly that name — which the packer guarantees. A release missing the package fails the action
  instead of publishing an entry that points at nothing.
- **`minAppVersion` decides whether the game is offered at all.** It is compared against the
  platform's own version, so the `1.1.0` this game declares reads `Incompatible` on any older
  platform. Local installs never consult the bound: `KNOCKBOX_GAMES_DIR` and a hand-dropped `.kbg`
  are unaffected.

## Where to build next

- **Freeze-on-leave UX** — when the DM disconnects, guests should get a pause overlay ("waiting
  for the DM") instead of a silent stall; see
  [`docs/architecture-rewrite/phase-04-ui-lifecycle.md`](docs/architecture-rewrite/phase-04-ui-lifecycle.md).
- **Per-recipient deltas** — once KnockBox-Games#62 lands the upstream delta hook, switch from
  full per-player snapshots to projected patches (`projectPatchForPlayer` in `src/game/rules.ts`
  is already written and tested, just parked). This is also the fix for the fan-out rate risk.
- **Blazor parity** — the remaining subsystems (character sheets, dice, loaded dice, combat,
  markup, projector, `.vtf` export, player lifecycle) are planned in
  [`docs/blazor-port-pt-2/`](docs/blazor-port-pt-2/README.md).

Platform reference: `docs/GAME_DEVELOPER_GUIDE.md` §5 (host-authoritative mode) in the
KnockBox-Games repo.
