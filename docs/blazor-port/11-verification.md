# 11 — Verification

How to know each phase actually works. Phase-level acceptance criteria live in
[`10-roadmap.md`](10-roadmap.md); this document is about *method*.

## The commands

```bash
npm install             # once — node_modules is absent from a fresh clone

npm run dev             # http://localhost:5173  (solo mode)
npm test                # vitest — tiers 1 and 2
npm run test:watch
npm run typecheck       # tsc --noEmit — one TS project
npm run lint
npm run build           # typecheck → vite build
npm run manifest:check          # placeholders are warnings
npm run manifest:check -- --strict   # placeholders are FAILURES (what the release workflow runs)
npm run export:game     # → dist-game/<id>.kbg
```

**There is one bundle.** The game runs host authority — the DM's browser holds the truth — so there
is no server-authority module, no second Vite pass, no `tsconfig.authority.json` and no ESLint
sandbox block. A green `npm run typecheck` covers every file.

`src/game/` still stays **pure** — no DOM, no Phaser, no Lit — but for testability, not for a
sandbox. See the checklist below.

## The three test tiers

The template already wires all three; the port should keep the proportions.

### Tier 1 — pure logic (fastest, most valuable here)

No `kb`, no network, no DOM. This is where the port's genuinely dangerous bugs live, because they
are all **silent corruption** — or, for the projection, **silent leaks** — rather than crashes.

| Module | Why it matters |
| --- | --- |
| `src/game/snapping.test.ts` | Token→centre vs image→corner. A half-cell offset corrupts every save. |
| `src/game/fog.test.ts` | Bit layout; **non-byte-aligned widths**; empty mask = revealed. |
| `src/game/rules.test.ts` | Permission policies; illegal intents return `null`. |
| `src/game/projection.test.ts`, `visibility.test.ts` | The per-player visibility matrix: what `projectForPlayer` strips for a non-DM. A miss here leaks hidden tokens to players, with no error. |
| `src/game/playerLifecycle.test.ts` | A non-DM leave converts tokens/sheets to NPCs and clears combatant ownership. |
| `src/vtf/import.test.ts` | Format fidelity; zip-slip rejection; version gate. |
| `src/game/stacking.test.ts` | Stacking and chip geometry. |

Worth stating plainly: **a wrong fog bit index does not throw.** It renders a plausible-looking map
with the wrong cells hidden, writes that to disk, and is discovered by a DM mid-session. Test the
bit layout exhaustively, including a width of, say, 13 cells.

### Tier 2 — the host store and host-mode sync

`src/game/view.test.ts` drives `MatchView` — the host store — directly: feed intents, assert state
and per-player snapshots. Then `src/net/authorityController.test.ts` runs several
`KnockBoxLocalPeer`s in one process (`mode: 'process'`) in **host mode**, with the first peer
elected host: the DM applies intents, and each guest converges on its own projected snapshot. That
is where a stray `undefined`, `Date`, `Map` or class instance surfaces, and where "guests never
receive hidden tokens", "a loaded save converges guests" and "the host leaving ends the session"
are pinned end to end. `src/ui/app/dndm-app.test.ts` covers the UI against a mock controller, and
`src/net/addons.smoke.test.ts` keeps the addon UMD interop and blob API checks.

**Tests that belong here and have no legacy equivalent:**

```ts
// src/game/snapshotBudget.test.ts — a 24-map / 50-sheet / 100-token campaign.
// Size the fixture so it would FAIL without the narrowing: 8 maps in full is only
// ~300 KB, under the 400 KiB assertion, so an 8-map fixture tests nothing at all.
// projectSnapshot is the unfiltered (DM) projection — the largest any player receives,
// so it bounds every projectForPlayer result.
it("projects a massive 24-map, 50-sheet, 100-token campaign well within 400 KiB", () => {
  const projected = projectSnapshot(makeStressCampaign());
  expect(sizeKiB(projected)).toBeLessThan(400);
});

it("rejects an intent from a non-DM that requires DM rights", () => {
  expect(applyIntent(state, "player-2", { kind: "fillFog", mapId }, now)).toBeNull();
});
```

The budget test is the only size check on per-recipient snapshots today — nothing measures them at
send time — so keep the fixture honest as the state grows.

**Measure UTF-8 bytes, not `String.length`** — a map named "Ténèbres" makes the encoded form longer
than the JS string, and the relay counts bytes. Prefer the port's own `utf8Length` (the one
`guardSize` uses) so a test and the guard cannot disagree at exactly the boundary that matters.

### Tier 3 — a real server

Drop the `.kbg` into a local `KnockBox-Games` instance and play it from several browsers. The
server only relays in host mode, so what this tier adds is the **real relay's limits**: 512 KiB per
frame, 30 msg/s (60 burst) per connection with a terminal 1008, and `DropOldest` backpressure — all
of them spent on the **DM's** socket, since every per-player snapshot leaves from there. The local
peer does not enforce them, so tiers 1–2 cannot see a fan-out problem. See the fan-out check under
manual verification.

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

Both tabs run the **same** host-mode path as the platform — the DM's tab is the host and holds the
truth, the other tab renders its per-player snapshot — with no server. This is where phase 4 gets
verified.

> **The DM is the tab you opened first.** The elected peer is the host and lands at `roster[0]`,
> and that is what the host store takes as `dmPlayerId`
> ([`06`](06-state-and-authority.md)). There is no way to choose, so open the DM tab first — and to
> re-test as a player, close that tab and reload, which also ends the session (below).

**Closing the DM's tab ends the session everywhere.** That is not an emulation gap: the truth lives
in the DM's browser on every transport, and the locked "freeze on DM leave" decision means there is
no succession. The platform behaves the same way. Don't chase it as a bug.

### Checks that only a human will run

With two tabs (or, for the last one, a real server and many browsers):

1. **DM close.** Close the DM tab → every player's session ends. Until the "waiting for DM" freeze
   overlay is built, players are left on their last view with no explanation — note it, don't file
   it.
2. **Hidden-information leak.** As DM, hide a token, fog a cell under another NPC token, and set a
   sheet the player may not view. In the player tab's devtools, inspect the state it actually
   received (a breakpoint in `AuthorityController`'s `state` getter shows `currentView`): none of
   the three may appear — not merely be undrawn. The fog mask itself
   *is* expected to be there.
3. **Fan-out rate.** On a real server at a realistic seat count (ideally 16), drag a token
   continuously and paint fog for 10+ seconds. The DM must not be disconnected with 1008. Short
   tests hide this behind the 60-message burst.

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

There is nothing to register — one TS project covers every file — but `src/game/` stays pure so it
can be tested without a browser. Run through this **every time**:

- [ ] No clock reads — take the time as a `now` parameter (the host store passes `Date.now()`)
- [ ] No `console` — log via `createLogger`; no `fetch`, no timers
- [ ] Nothing DOM, Phaser or Lit
- [ ] Strict JSON only — no `undefined`, `Map`, `Set`, class instances, cycles. Everything in state
      crosses the relay to players.
- [ ] `npm run typecheck` and `npm run lint` both pass

A strict-JSON slip does not throw locally; it surfaces as a player whose view differs from the
DM's.

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
| State stops updating for a player, no error | **A per-player snapshot over 512 KiB.** Nothing size-checks them at send time; re-run `snapshotBudget.test.ts` with a fixture shaped like the failing campaign. |
| A player is disconnected and never reconnects | Rate limit (30/s, 60 burst) → terminal 1008. Count your intents. |
| **Everyone** is dropped at once, mid-session | The DM's socket closed — usually 1008 from fan-out (each accepted intent is one frame per player, all from the DM). Count accepted intents × players. Or the DM simply left: the session ends with them. |
| Sync works solo, fails on platform | Strict-JSON violation (`undefined`, a `Date` object, a `Map`) in state or a snapshot. |
| Blank map after a tab is backgrounded | WebGL context loss; textures need re-uploading. |
| Images work for the DM only | `publish()` not called, or `AssetSource` resolving from the wrong store. |
| Everything is half a cell off | Centre-vs-corner anchoring. |
| Correct at 100% zoom, drifts as you zoom | `camera.scrollX` used as the top-left world coordinate. See [`05`](05-rendering.md#coordinate-mapping--the-heart-of-it). |
| Frame rate collapses when zoomed all the way out | Grid culled to the camera instead of clamped to the map. |
| The DM's socket reconnects in a loop | An oversized frame from the DM: 1009, which no SDK treats as terminal. Loading a save never sends the campaign in one frame, so suspect a per-player snapshot. |
| A player sees something the DM hid | A gap in `projectForPlayer`. Add the case to the projection matrix tests first. |
| An image draws over the fog and tokens | `setDepth(layerOrder)` with a raw `layerOrder ≥ 1000`; rank-normalise instead. |
| Fog is inverted | Empty mask misread as "all fogged" instead of "all revealed". |
| Client sits in an empty lobby forever | The boot-ordering guard — the controller missed `ready`. See the `ORDERING GUARD` comment in the `AuthorityController` constructor (`src/net/authorityController.ts`). |
