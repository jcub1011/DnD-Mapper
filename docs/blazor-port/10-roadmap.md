# 10 — Roadmap

Phases, ordering, and what "done" means for each. Every phase ends in something runnable.

## Ordering rationale

- **Phase 0 is separable** and lives in another repo. Phases 1–**4** do not depend on it, thanks to
  the `AssetSource`/`BlobTransport` seam ([`08`](08-assets-pipeline.md),
  [`09`](09-blob-share-server-spec.md)): everything runs against `IdbBlobTransport` until the real
  API exists. Start it early **because the coordination is slow, not because the mapper needs it** —
  a multi-repo release event (addons, a shared `sdkVersion` bump, a parity test, an `addons-v*` tag,
  a server release) has a lead time the server code does not. Do not let it block the mapper.
- **Domain + `.vtf` before rendering.** Import gives real data — real maps, real fog masks, real
  image geometry — which is far better to render against than fixtures.
- **Rendering before authority.** A local-only map that pans, zooms and drags proves the coordinate
  system. Sync on top of a broken coordinate system just produces synchronised wrongness.
- **UI last.** The rails are the largest surface but the lowest risk; nothing else depends on them.

## Phase 0 — Blob share (platform, `KnockBox-Games`)

Spec: [`09-blob-share-server-spec.md`](09-blob-share-server-spec.md). ~600–1,000 lines with tests,
plus a coordinated `addons-v*` release.

1. `BlobStore` — three maps, refcount, register/unregister/release, grace window.
2. `BlobApi` — `HEAD`/`GET`/`PUT`/`POST register`/`DELETE`, with the three auth checks.
3. `ContentPaths` seventh root + the seven `Program.cs` touchpoints.
4. Eviction hooks in `CloseLobbyIfDark` and `LobbyCloser`, plus the startup sweep.
5. Sweeper timer, limits, disk accounting.
6. Client SDK methods across all four addons; bump `sdkVersion`; release.

**Done when:**
- [ ] Two lobbies register the same bytes; one file exists on disk.
- [ ] **R6:** two logical ids in *one* lobby release independently — unregistering one keeps the file.
- [ ] Closing a lobby releases its handles with no game-side cleanup call.
- [ ] Uploading 100 MB does not move the server's managed heap (`dotnet-counters` while uploading).
- [ ] A hash that doesn't match the uploaded bytes is rejected and leaves no staging file.
- [ ] An unauthenticated `PUT` is refused; a `GET` by hash succeeds without auth.
- [ ] Restart leaves no orphaned blobs.
- [ ] `npm run addon:update` in this repo pulls the new client method.

## Phase 1 — Foundation

Make the template *this* game, and stand up the Phaser map surface with nothing on it.

1. `npm install`. **Spike the Phaser 4 APIs listed in [`05`](05-rendering.md#phaser-4--verify-before-building) first** — before writing scene code, and start with the `scrollX`-vs-`worldView` question.
2. Rename everything per [`02`](02-target-platform.md#the-template-rename-is-still-pending); fill in `export/GAME.json`; raise `maxPlayers`.
3. Copy `panels.css` into `src/ui/styles/`; replace the template's placeholder tokens.
4. Invert the layer stack: add `#map`, move `#fx` above, make `<dndm-app>`'s root `pointer-events: none`.
5. Add `MapScene` to the **existing** `Phaser.Game`. Camera pan/zoom via `applyViewport` (the midpoint correction is not optional), grid rendering clamped to the map bounds, cursor-anchored wheel zoom, unbounded pan.
6. Extend the WebGL context-loss guards to the map scene.

**Done when:**
- [ ] `npm run lint && npm test && npm run build` all pass (`build` already runs `typecheck`).
- [ ] `npm run manifest:check -- --strict` passes (no placeholders). **Note the `--`** — without it
      npm eats the flag and the gate passes without checking.
- [ ] An empty grid renders; wheel zoom holds the world point under the cursor; pan is unbounded.
- [ ] **World cell `(panX, panY)` sits at the viewport's top-left at zoom 1, 4 *and* 10** — the
      midpoint-correction check. Assert it, don't eyeball it.
- [ ] Clicking the map is not swallowed by the UI layer.
- [ ] Zoom stays crisp at 0.01 and 10.0, and at 0.01 the grid draws **≤ `widthCells + heightCells + 2`
      lines** (clamped to the map, not to the camera).

## Phase 2 — Domain model and `.vtf` import

1. `src/game/` types per [`03`](03-domain-model.md). **Register each new file in `tsconfig.authority.json` and `eslint.config.js`.**
2. Pure helpers: snapping, fog bitset, token stacking. Tests first — these are silent-corruption bugs.
3. `src/vtf/` — a `Blob`-backed unzip (never slurp the archive), safe paths, import, per
   [`04`](04-vtf-format.md).
4. IndexedDB library: sharded slots, debounced auto-save, fingerprint short-circuit.
5. Image pipeline: file input, texture-size probe, worker downscale, `LocalAssetSource`.

**Done when:**
- [ ] A **real legacy `.vtf`** imports: maps, grid, tokens, images, fog all correct.
- [ ] Fog decodes correctly for a width that is not a multiple of 8.
- [ ] An absent fog mask reads as **revealed**, not fogged.
- [ ] Tokens land on cell centres (`x.5`); images on corners.
- [ ] A zip-slip entry name is rejected.
- [ ] A large archive (~200 MB) imports without ever materialising the whole file in memory.
- [ ] A 12000px image is downscaled below `MAX_TEXTURE_SIZE` and still renders.
- [ ] Auto-save writes only the changed shards (verify in devtools).
- [ ] Reload restores the campaign from IndexedDB.

## Phase 3 — Phaser map renderer

Everything in [`05`](05-rendering.md), rendering imported data locally with no networking.

1. Image layers: depth, opacity, rotation, hidden, locked.
2. Fog: `CanvasTexture` at 1 texel/cell, `NEAREST`, DM 0.45 / player 1.0.
3. Tokens: containers, stacking, chips, labels.
4. Drag: tokens and images (move, 4-corner resize, rotate), with Ctrl/Shift modifiers.
5. Tool-mode state machine; fog brush; focus box; ruler.
6. Selection handles and the image inspector.
7. **Touch: two-finger pan and pinch-zoom.** A deliberate deviation — legacy has no touch
   navigation at all, so exact fidelity would be unusable at a table
   ([`07`](07-ui-shell.md#accessibility-and-input-notes)).

**Done when:**
- [ ] An imported map renders indistinguishably from the legacy app, side by side.
- [ ] **A rotated image matches legacy** (the origin trap in [`05`](05-rendering.md)).
- [ ] Drag respects snapping; Ctrl bypasses it; Shift frees aspect ratio.
- [ ] Middle-drag pans from anywhere, including over a token.
- [ ] Space-to-pan works with a tool armed.
- [ ] The 3 px dead zone distinguishes click-deselect from pan.
- [ ] Ruler shows Chebyshev squares and feet, staying screen-constant at any zoom.
- [ ] Fog painting is smooth at brush radius 3 on a 200×200 map.
- [ ] A rotated fog region has hard cell edges at integer zoom (the fractional-zoom texel snapping
      in [`05`](05-rendering.md#fog--do-not-port-the-polygon-tracer) is a known, accepted deviation).
- [ ] Two-finger pan and pinch-zoom work on a tablet and respect the same zoom clamps.

## Phase 4 — Authority and multiplayer

Everything in [`06`](06-state-and-authority.md).

1. `MatchState`, `Intent`, narrowed `Patch`; `MatchView.applyPatch` merging by kind.
2. `rules.ts`: intent handling + permission policies. Illegal → `null`.
3. `authority.ts`: `createAuthority`, snapshot projection (**active map full, others summarised**), DM succession.
4. **The campaign-loading protocol** — chunked `beginImport`/`importChunk`/`commitImport`, plus
   `requestMap` and the `{ kind: "map" }` patch
   ([`06`](06-state-and-authority.md#getting-a-campaign-into-the-authority)). Without this an
   imported campaign cannot reach the authority at all, and the naive version bricks the DM's
   socket.
5. `guardSize` + `utf8Length` + a snapshot-budget test sized to actually fail without narrowing.
6. Wire the scene to controller events; render only confirmed state (fog preview excepted).
7. `BlobShareAssetSource` over `IdbBlobTransport` — multiplayer art in `solo` and `local-tab`.

**Done when:**
- [ ] Two tabs via `?kbLocal=tab`: DM moves a token, the player sees it. (The DM is the tab you
      opened **first** — that tab wins the election and lands at `players[0]`.)
- [ ] Fog painting syncs; the DM sees 0.45 opacity, the player 1.0.
- [ ] A player cannot move a token they don't own under `OwnerOrHost`.
- [ ] A forged intent from a non-DM is rejected (test it directly).
- [ ] **A worst-case snapshot stays under 400 KB** — automated test, with a fixture large enough
      that the un-narrowed `Patch = MatchState` version would *fail* it. 8 maps is only ~300 KB and
      proves nothing; use ~24.
- [ ] A large campaign imports through chunked intents, and no single frame approaches 512 KiB.
- [ ] Switching to a summarised map fetches it via `requestMap` and renders fog/tokens correctly.
- [ ] The platform's bench shows calls well inside the 250 ms budget — from a built
      `KnockBox-Games` checkout: `KnockBox.Server --authority-bench <game-dir>`. It drives `tick` by
      default and **exits non-zero when a call blows the budget**, so wire it into CI once fog and
      token counts are realistic.
- [ ] A late joiner receives full state; a reconnect within 60 s resumes.
- [ ] Strict-JSON fidelity checks pass (no `undefined`, no `Date`).
- [ ] **Local emulation:** the player tab sees map art via `IdbBlobTransport`. With `publish()`
      commented out: a dashed placeholder, not the image. (This is the check that proves the local
      blob store is not falling through to the DM's library — see
      [`11`](11-verification.md#the-asset-check-that-must-not-be-skipped).)
- [ ] **Platform, after phase 0:** the same two outcomes against the real API, with
      `HttpBlobTransport` selected by launch mode.

## Phase 5 — UI shell

Everything in [`07`](07-ui-shell.md). Largest surface, lowest risk.

1. `<dndm-app>` shell; rails with resize/collapse; toolbar.
2. Map list, layer panel, token panel, image inspector.
3. Modals: confirm, map settings, permissions; toasts.
4. Lobby view; DM gating on `isOwner` + `owner-changed`.
5. Saves panel and `.vtf` import UI.

**Done when:**
- [ ] The DM sees the left rail; a player does not.
- [ ] Rails resize 200–600 px, persist, and collapse on click-without-drag.
- [ ] The rail-aware zoom anchor is correct with rails at different widths.
- [ ] Every v1 legacy DM action has an equivalent control.
- [ ] Visual comparison against legacy is close enough that the theme reads as the same product.

## Phase 6+ — Deferred subsystems

Ordered by dependency, not priority:

| Order | Subsystem | Notes |
| --- | --- | --- |
| 1 | Character sheets, attribute schemas, status effects | Unblocks initiative and dice modifiers |
| 2 | Dice, roll log, roll templates | Re-vendor `dice-box-threejs` (D5) |
| 3 | Loaded-dice rules | Needs host-key streaming and the sheet targeting model |
| 4 | Initiative / combat tracker | Needs sheets |
| 5 | Freehand markup | Needs a drawing surface decision |
| 6 | Display / projector view | **Q3** — was a second route; would become a fullscreen mode |

Each needs its own scope pass; do not treat this table as a plan.

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Phaser 4 APIs differ from 3.x** | Rework in phase 3 | Spike day one of phase 1; record findings in [`05`](05-rendering.md) |
| **Snapshot exceeds 512 KiB** | Silent sync failure | Active-map-only snapshots; `guardSize`; automated budget test |
| **Phase 0 slips** | Platform multiplayer art delayed | `BlobTransport` seam; phases 1–4 unaffected, and art still works in `solo`/`local-tab` |
| **Phase 0's coordination overruns** | The real schedule risk, not the server code | Start the `addons-v*` release early and in parallel; ship phaser + web only and defer Godot via `KNOWN_GODOT_GAPS` ([`09`](09-blob-share-server-spec.md#client-addon--the-expensive-half)) |
| **Art works in dev, fails on the platform** | Structural, until phase 0 ships | Keep the `publish()`-removed placeholder check in every asset test pass |
| **An imported campaign can't reach the authority** | Terminal: 1009 close, endless reconnect | The chunked import protocol, with a measured per-chunk budget ([`06`](06-state-and-authority.md#getting-a-campaign-into-the-authority)) |
| **`.vtf` fidelity gaps** | Corrupt user data | Get a real file early; test cell-centre/corner and fog bit layout hard |
| **Cell-vs-pixel confusion** | Silent half-cell offsets | Encode units in type names; assert in tests |
| **`scrollX` mistaken for the top-left world coord** | Everything drifts, but only at zoom ≠ 1 | The zoom-1/4/10 assertion in phase 1; `applyViewport` is the only writer |
| **Rotated-image origin mismatch** | Visible misplacement | Explicit acceptance check in phase 3 |
| **Forgotten `publish()`** | Works in dev, fails in prod | Keep the local blob store separate from the DM's library ([`09`](09-blob-share-server-spec.md)) |
| **New `src/game/` file escapes sandbox guards** | Production-only failure | Checklist item in every phase touching `src/game/` |
| **Scope creep from the deferred 60%** | v1 never ships | D1 is the contract; new work goes to phase 6+ |
| **Scoped-CSS volume underestimated** | Phase 5 overruns | 4,658 lines across 34 `.razor.css` files need de-scoping, not copying ([`07`](07-ui-shell.md#the-css-12-copies-88-is-work)); a third belongs to phase 6+ components and defers with them |
