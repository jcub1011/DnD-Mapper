# 11 — Verification

How to know each phase actually works. Phase-level acceptance criteria live in
[`10-roadmap.md`](10-roadmap.md); this document is about *method*.

## The commands

```bash
npm install             # once — node_modules is absent from a fresh clone

npm run dev             # http://localhost:5173  (solo mode)
npm test                # vitest — tiers 1 and 2
npm run test:watch
npm run typecheck       # BOTH TS projects — app AND authority
npm run lint
npm run build           # typecheck → app bundle → authority bundle
npm run manifest:check          # placeholders are warnings
npm run manifest:check -- --strict   # placeholders are FAILURES (what the release workflow runs)
npm run export:game     # → dist-game/<id>.kbg
```

**Always build via `npm run build`.** `dist/authority.js` is written by a second Vite pass after the
app build empties `dist/`; a bare `vite build` afterwards silently deletes it, and the next pack
fails with `serverAuthority module not found`.

**`npm run typecheck` runs two projects.** The second is the sandbox guard, and it only covers files
listed in `tsconfig.authority.json`'s explicit `include` — no globs. A green typecheck does **not**
mean a new `src/game/` module is sandbox-safe.

ESLint's sandbox block is *partly* glob-based (`src/authority/**/*.ts`, then explicit entries for
`src/game/rules.ts` and `src/game/types.ts`), which is why the two guards do not cover the same set:

| New file | `tsconfig.authority.json` | ESLint |
| --- | --- | --- |
| `src/game/*.ts` | must add | must add |
| `src/authority/*.ts` | must add | glob covers it |

So `src/game/` is the dangerous direction, and it is where the port adds most of its files. See the
checklist below.

## The three test tiers

The template already wires all three; the port should keep the proportions.

### Tier 1 — pure logic (fastest, most valuable here)

No `kb`, no network, no DOM. This is where the port's genuinely dangerous bugs live, because they
are all **silent corruption** rather than crashes.

| Module | Why it matters |
| --- | --- |
| `src/game/grid.test.ts` | Token→centre vs image→corner. A half-cell offset corrupts every save. |
| `src/game/fog.test.ts` | Bit layout; **non-byte-aligned widths**; empty mask = revealed. |
| `src/game/rules.test.ts` | Permission policies; illegal intents return `null`. |
| `src/vtf/import.test.ts` | Format fidelity; zip-slip rejection; version gate. |
| `src/game/tokens.test.ts` | Stacking and chip geometry. |

Worth stating plainly: **a wrong fog bit index does not throw.** It renders a plausible-looking map
with the wrong cells hidden, writes that to disk, and is discovered by a DM mid-session. Test the
bit layout exhaustively, including a width of, say, 13 cells.

### Tier 2 — authority under emulation

```ts
createAuthority(fakeKb)   // src/authority/fakeKb.ts is a 63-line double
```

Feed intents, assert patches. Then `authorityController.test.ts` runs several `KnockBoxLocalPeer`s
in one process against the **real** module as a virtual `from:"server"` actor, with strict-JSON
fidelity checks on. That is where a stray `undefined`, `Date`, `Map` or class instance surfaces.

**Three tests that belong here and have no legacy equivalent:**

```ts
// Size the fixture so it would FAIL without the narrowing. By 06's budget table one
// 200×200 map with 60 tokens and 40 images is ~33 KB, so 8 maps is only ~300 KB —
// under the 400 KB assertion, meaning an 8-map fixture passes even with the template's
// `Patch = MatchState` and therefore tests nothing at all.
const WORST_CASE = { maps: 24, mapSize: [200, 200], tokens: 60, images: 40 } as const;

it("a worst-case snapshot fits in one frame", () => {
  const state = buildLargeCampaign(WORST_CASE);
  expect(utf8Length(JSON.stringify(snapshot(state)))).toBeLessThan(400_000);   // ~78% of the cap
});

it("the same campaign would NOT fit if we broadcast whole state", () => {
  // Pins the reason the narrowing exists. If this ever passes, either the fixture
  // shrank or someone widened the Patch back out.
  const state = buildLargeCampaign(WORST_CASE);
  expect(utf8Length(JSON.stringify(state))).toBeGreaterThan(400_000);
});

it("rejects an intent from a non-DM that requires DM rights", () => {
  expect(applyIntent(state, "player-2", { kind: "fillFog", mapId })).toBeNull();
});
```

**Measure UTF-8 bytes, not `String.length`** — a map named "Ténèbres" makes the encoded form longer
than the JS string, and the server counts bytes.

> **Use the port's own `utf8Length` here, not `TextEncoder`.** `TextEncoder` is a Web API: the Jint
> sandbox does not provide it, and the ESLint sandbox block bans DOM globals in `src/game/` and
> `src/authority/`. So `guardSize` inside the authority has to hand-roll the byte count anyway
> ([`06`](06-state-and-authority.md#guardrails)) — and the test must measure with the *same*
> function the guard uses, or the two disagree at exactly the boundary that matters.

### Tier 3 — a real server

Drop the `.kbg` into a local `KnockBox-Games` instance for the real Jint sandbox and its constraint
limits. Also run the platform's own benchmark — it is a CLI mode of the server, so it needs that repo
checked out and built, and is run from there rather than from here:

```bash
# in the KnockBox-Games checkout
dotnet run --project KnockBox.Server -- --authority-bench <path-to-unpacked-game-dir>
```

It loads `authority.js` under the real engine with the real constraints, **drives `tick` by default**
(the export a developer never triggers by hand), reports how close each export gets to its per-call
budget, and **exits non-zero if a call blows it** — so it belongs in CI once fog masks and token
counts are realistic. `--script` additionally drives intents.

**Three consecutive 250 ms overruns close the lobby** (and five consecutive contained throws do too,
which is a hard-coded `const` rather than a config knob). Both are invisible in tiers 1–2.

## Manual verification

### Solo

```bash
npm run dev            # http://localhost:5173
```

Covers rendering, import, camera, drag, tools — everything in phases 1–3.

### Two-tab multiplayer — the primary loop

```
http://localhost:5173/?kbLocal=tab      ← open in TWO tabs
```

Both tabs run the **real** authority module through the real networked path, with no server. This is
where phase 4 gets verified.

> **The DM is the tab you opened first.** The elected peer lands at `players[0]`, and that is what
> the authority takes as `dmPlayerId` ([`06`](06-state-and-authority.md#where-permission-checks-live)).
> There is no way to choose, so open the DM tab first — and to re-test as a player, close that tab
> and reload, which also ends the session (below).

One emulation gap to remember: locally the module's state lives inside the elected peer, so closing
*that* tab ends the session. The real server survives it. Don't chase that as a bug.

### The asset check that must not be skipped

With two tabs, one as DM:

1. DM adds a map image → **the player tab shows it.**
2. Comment out the `publish()` call → **the player tab shows a dashed placeholder.**

Step 2 is the important one. If the player still sees the image with `publish()` disabled, the local
blob store is falling through to the DM's library, and every asset bug will hide until production.
See [`09`](09-blob-share-server-spec.md#local-emulation).

## Fidelity checking against legacy

For a port whose goal is faithfulness, **run both applications side by side.** Automated tests
verify the port against these documents; only comparison verifies these documents against reality.

Set up: the legacy Blazor app in one window, the port in another, both with the same `.vtf`.

| Check | What to look for |
| --- | --- |
| Same map, same zoom | Grid lines land on the same features |
| **A rotated image** | Origin trap — legacy rotates about the centre |
| Token positions | Centred in cells, not offset by half |
| Fog edges | Hard cell boundaries, aligned identically |
| Fog opacity | DM 0.45, player 1.0 |
| Zoom extremes | 0.01 and 10.0 both crisp and correctly anchored |
| Ruler | Same square count and feet for the same two cells |
| Colours | Same theme; `panels.css` ported verbatim so any drift is a bug |
| Rail widths | Same range; zoom anchor correct at different widths |

Screenshot the same view in both and flip between them — sub-cell offsets are obvious that way and
almost invisible side by side.

## Checklist: adding a file to `src/game/`

Run through this **every time**. `tsconfig.authority.json`'s `include` has no globs at all, and
ESLint's glob only covers `src/authority/` — so a new `src/game/` module is registered nowhere until
you add it:

- [ ] Added to `tsconfig.authority.json` → `include`
- [ ] Added to `eslint.config.js` → the sandbox block's `files`
      *(a new `src/authority/*.ts` file needs only the first — the ESLint glob has it)*
- [ ] No `Date` (use `kb.now()`), no `console` (use `kb.log.*`), no `fetch`, no timers
- [ ] No non-relative imports
- [ ] Nothing DOM, Phaser or Lit
- [ ] Strict JSON only — no `undefined`, `Map`, `Set`, class instances, cycles
- [ ] `npm run typecheck` and `npm run lint` both pass

A module missing from both lists is typechecked against the DOM lib, may call `Date.now()`, and
**fails only in production** — inside a sandbox with no console.

## Pre-release

Before `npm run export:game`:

- [ ] `npm run build` clean, in that order
- [ ] `npm run manifest:check -- --strict` passes — the release workflow runs it this way, and
      placeholder warnings become failures. **The `--` matters:** `npm run manifest:check --strict`
      lets npm swallow the flag, so the gate reports success without checking
- [ ] `npm run addon:check` reports no drift
- [ ] `export/GAME.json`: real `id`, `author`, `description`, `version`, and a `maxPlayers` that
      fits a real table
- [ ] `export/GAME.json` → `minAppVersion` is **the server version that ships blob-share**, once the
      game depends on it. Leaving it at the template's `1.0.0` lets the `.kbg` install onto a server
      that cannot serve the game's art, which presents as "images work for the DM only"
- [ ] `.kbg` installs into a local KnockBox and launches
- [ ] A real legacy `.vtf` imports correctly in the packaged build

> **`id` is the catalog key, the install directory *and* the URL segment.** Renaming it later is a
> reinstall, not a metadata edit. Decide it once, in phase 1.

## When something goes wrong

| Symptom | Likely cause |
| --- | --- |
| State stops updating for everyone, no error | **Snapshot/patch over 512 KiB** — silently dropped server-side. Check the authority log. |
| A player is disconnected and never reconnects | Rate limit (30/s, 60 burst) → terminal 1008. Count your intents. |
| Sync works solo, fails on platform | Strict-JSON violation, or `Date` used in the authority. |
| Blank map after a tab is backgrounded | WebGL context loss; textures need re-uploading. |
| Images work for the DM only | `publish()` not called, or `AssetSource` resolving from the wrong store. |
| Everything is half a cell off | Centre-vs-corner anchoring. |
| Correct at 100% zoom, drifts as you zoom | `camera.scrollX` used as the top-left world coordinate. See [`05`](05-rendering.md#coordinate-mapping--the-heart-of-it). |
| Frame rate collapses when zoomed all the way out | Grid culled to the camera instead of clamped to the map. |
| The DM's socket reconnects in a loop after an import | An oversized client→server frame: 1009, which no SDK treats as terminal. Chunk the import. |
| An image draws over the fog and tokens | `setDepth(layerOrder)` with a raw `layerOrder ≥ 1000`; rank-normalise instead. |
| Fog is inverted | Empty mask misread as "all fogged" instead of "all revealed". |
| Client sits in an empty lobby forever | The boot-ordering guard — the controller missed `ready`. See `authorityController.ts:68-72`. |
