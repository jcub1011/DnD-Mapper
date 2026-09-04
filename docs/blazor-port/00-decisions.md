# 00 — Decision Register

Decisions that shape the port, with the reasoning behind each. When a later session disagrees with
one of these, change it *here first* — several downstream documents assume these hold.

## Confirmed decisions

### D1 — v1 scope is the core mapper only

**Ships in v1:** maps, grid, image layers, tokens, fog of war, pan/zoom, ruler, focus box,
`.vtf` import, IndexedDB save slots.

**Deferred:** character sheets, attribute schemas, status effects, dice + roll log, loaded-dice
rules, initiative/combat tracker, freehand markup, the read-only display/projector view.

*Why:* the legacy plugin is ~31,900 lines. The mapper is the part everything else hangs off, and
it is also where all the genuinely hard architecture lives (rendering, coordinates, file format,
state sync). Getting it right first de-risks everything after it.

### D2 — Blob-share is started first, in the platform repo

Phase 0 is a new blob-share feature in `KnockBox-Games`, kicked off before mapper code lands — but
running **alongside** it, not gating it.

*Why:* map images cannot cross the KnockBox relay, and no amount of tuning changes that — see
[`02-target-platform.md`](02-target-platform.md#why-images-cannot-cross-the-relay). So the feature
has to exist for multiplayer map art to work at all.

*Why first, given the mapper does not need it:* the **server code** is a week and low-risk; the
**release** is a multi-repo event with real lead time (client addons, a shared `sdkVersion` bump
across four manifests, a parity test, an `addons-v*` tag, then a server release). Starting it early
buys that lead time.

*What it is emphatically **not**:* a blocker. The seam's shape is defined **inside this repo**, by
`AssetSource` and `BlobTransport` ([`08`](08-assets-pipeline.md),
[`09`](09-blob-share-server-spec.md#dont-block-the-port-on-the-addon-release)), and phases 1–4 run
against `IdbBlobTransport` throughout. If phase 0 slipped indefinitely, the mapper would still ship;
only platform players would see placeholders where art should be.

### D3 — v1 syncs all non-image state

Maps, grid config, tokens, fog and viewport-centering all flow through the authority module and
replicate to players in v1. Only map *art* is DM-local until blob-share lands.

*Why:* state partitioning, patch granularity and the 512 KiB ceiling are the riskiest parts of the
design. They are far easier to get right while the state is still small.

> **"DM-local" means on the platform only, and that asymmetry is a hazard worth naming.** With
> `IdbBlobTransport`, same-origin tabs share IndexedDB, so map art works fully in `solo` and
> `local-tab` from phase 1 — which is the entire development loop. Only platform players see
> placeholders, and only until phase 0 ships.
>
> So the port's normal working environment shows art succeeding while production shows it failing.
> That is the right trade (the alternative is no local multiplayer testing at all), but it means the
> placeholder path must be **exercised deliberately** rather than trusted to show up — hence the
> "comment out `publish()`" check in
> [`11`](11-verification.md#the-asset-check-that-must-not-be-skipped), which is load-bearing rather
> than nice-to-have.

### D4 — `.vtf` is import-only

The port must open legacy `.vtf` files faithfully. Export may extend the format and is not required
to round-trip back into the Blazor app.

*Why:* the legacy app is being retired. Import fidelity protects existing user data; export
fidelity would constrain the new format for no ongoing benefit.

> Note: export is still *cheapish* — the legacy exporter already runs in the browser as
> hand-written JS (`wwwroot/js/dndMapperVtfPackager.js`, 282 lines: its own CRC32 table,
> `CompressionStream('deflate-raw')`, local headers, central directory, EOCD) and ports nearly
> as-is. "Import only" is a statement about what is **guaranteed**, not a ban on writing `.vtf`.
>
> But that module only writes the ZIP; the JSON shards are handed to it by
> `VtfPackager.BuildClientPayload` on the C# side, which regenerates the spec-level `layers[]` and
> `entityInstances[]` projections from scratch on every pack. Porting export therefore also means
> porting that projection logic — a slice of the 599-line packager, not zero.

### D5 — 3D dice re-vendor `dice-box-threejs` as-is

When the dice phase arrives, copy the vendored library and its assets rather than rebuilding dice
in Phaser.

*Why:* it is 17,248 lines of Three.js + cannon physics with 38 textures and 75 sounds. Re-vendoring
is near-zero risk and maximum fidelity; rebuilding is high effort for a visibly worse result. The
cost is package size, which matters less than the signature feel of the roll.

### D6 — Blob storage is disk-backed with constant server memory

The blob service streams to and from disk. Server memory stays flat regardless of blob size or
count, across any number of concurrent sessions.

*Why (user's rationale):* server memory is a premium resource that multi-megabyte images consume
very quickly, especially with several sessions running at once.

### D7 — Blob storage is content-addressed, with per-session name→hash indirection

The SHA-256 of the bytes is the identity and the on-disk filename. Sessions register blobs under
their own logical ids; a mapping layer resolves those to hashes.

*Why:* dedup becomes free — two sessions registering the same battlemap write one file — and
identical uploads can be skipped entirely.

### D8 — Blob lifetime is tied to the lobby lifecycle

Registering a blob anchors it to that session. When the lobby closes it is released automatically,
through the existing lobby-eviction system. Games *may* unregister manually but never have to.

*Why:* games should not have to run cleanup logic that a crashed or abandoned session would skip.
Anchoring to a lifecycle the server already manages makes leaks structurally impossible.

### D9 — Dedup is invisible to the game

Two registrations are two independent handles the game can release independently — whether they are
in different lobbies **or in the same lobby under different logical ids** — even though a single
file backs both.

*Why:* it keeps the game's mental model simple. The consequence is that refcounting must be **per
handle**, not per `(lobby, hash)` pair. See [`09-blob-share-server-spec.md`](09-blob-share-server-spec.md).

### D10 — Blob quotas are three-tiered, with a per-game override

This is the answer to `Q2`, given by the user and implemented.

| Tier | Default | Editable |
| --- | --- | --- |
| Per blob | 100 MB | runtime, from the portal |
| Per lobby | 1 GB | runtime, from the portal |
| **Per game**, overriding the per-lobby figure | none | runtime, per game id |
| Server-wide aggregate | 20 GB | runtime, from the portal |

*Why an aggregate at all:* it is the difference between a bounded feature and a disk-fill vector.
`AuthorityWordService` is the cautionary example — it caps `MaxWordFileBytes` per file and sums
nothing, so N games × cap is genuinely unbounded there.

*Why per-game:* a mapper needs gigabytes of art where a word game needs none, and one number for both
either starves the first or hands the second a quota it has no use for. It is keyed by game id and
persisted in `AdminSettings`, which already carries two per-game-id override maps (availability and
update policy), so it follows an established shape rather than inventing one.

*What a lobby is charged:* the summed length of the **distinct** hashes it references. A lobby that
registers one 500 MB file under two logical ids is charged 500 MB, because the quota is about disk and
the file on disk is one file. Charging twice would penalise a game for a dedup `D9` says it must not
be able to see.

### D11 — Blob read URLs are keyed on a MAC of the hash, not the bare hash

`GET /blob/{sha256}.{tag}`, where `tag` is a truncated `HMAC-SHA256(perProcessSecret, sha256)`.

*Why:* a bare hash is not a capability. A hash is derived from the bytes, so it is unguessable only
for content the requester does not already have — anyone holding the same commercial map pack can
compute every hash in it and probe an unauthenticated read route for which maps the DM uploaded.
Spoilers are most of what a VTT's asset privacy is for, and legacy's random Guid had no such property.
The token is stateless (the hash stays visible; what changes is that it cannot be *forged*), so
storage is still keyed by hash and dedup is untouched.

*The cost:* URLs do not survive a restart. They already did not — the startup sweep deletes every
blob — so this costs nothing that was not already gone.

*The corollary:* `HEAD /blob/{sha256}`, the dedup probe, **takes a ticket**. It reveals one bit, but
that bit is the whole oracle. An SDK `fetch` can carry a header; `<img src>` cannot, which is why only
`GET` is anonymous.

## Decisions made without consultation

Low-risk and conventional, but recorded so they can be challenged.

| # | Decision | Reasoning |
| --- | --- | --- |
| E1 | **Phaser becomes the primary interactive renderer**, with Lit UI in DOM above it | Inverts the template, where `#fx` is a click-through overlay at `z-index:10`. A map surface must receive input. |
| E2 | **The map scene joins the existing `Phaser.Game`** rather than a second instance | The KnockBox global plugin is registered on that one game config (`src/ui/fx/fx.ts:41-51`); a second game would not have networking. |
| E3 | **The DM is the lobby owner (`isOwner`)**, never `isHost` | `isHost` is `false` on *every* client under server authority. The platform says so explicitly. |
| E4 | **Fog renders as a 1-texel-per-cell texture**, not traced polygons | Phaser has no `evenodd` fill, and `FogPolygonBuilder.cs` is 171 lines of ring tracing with saddle-vertex handling. A `NEAREST`-filtered texture reads the same and makes per-cell updates cheap. One accepted deviation: at fractional zoom, texel snapping makes fog cell edges differ by up to 1 px — recorded in [`05`](05-rendering.md#fog--do-not-port-the-polygon-tracer). |
| E5 | **Keep legacy's WebGL2 texture-size probe and Web Worker downscaler** | Phaser has the same `MAX_TEXTURE_SIZE` ceiling; the problem and solution are unchanged. |

## Open questions

Resolve these before or during the phase that depends on them.

| # | Question | Blocks | Notes |
| --- | --- | --- | --- |
| Q1 | Do hidden tokens need real server-side visibility filtering, or is client-side hiding acceptable? | Phase 4 | `perRecipient` mode is the faithful answer but **disables deltas entirely**, which collides with the 512 KiB cap. See [`06-state-and-authority.md`](06-state-and-authority.md#the-perrecipient-tension). Legacy already leaks fog to clients, so full fidelity here would *exceed* legacy. |
| ~~Q2~~ | ~~What is the aggregate disk quota for blobs, per lobby and server-wide?~~ | — | **Answered — see `D10`.** 20 GB server-wide, 1 GB per lobby, plus a per-game override of the per-lobby figure. |
| Q3 | Does the display/projector view survive the port at all? | Phase 6+ | It was a second Blazor route. A KnockBox game has one entry point, so it would become an in-game fullscreen mode. |
| Q4 | Should save slots stay DM-local, or move to server storage once blob-share exists? | Phase 2 | Legacy is entirely browser-local (IndexedDB). Keeping that is simplest and matches D1 — but note it makes the DM's browser the only copy of the campaign, and makes post-restart recovery a re-import ([`06`](06-state-and-authority.md#recovery-after-a-restart)). |
| Q6 | Which browsers must the port support? | Phase 2 | Nothing in this doc set states a floor, yet [`04`](04-vtf-format.md) depends on `DecompressionStream('deflate-raw')` (Safari 16.4+, Firefox 113+) and [`08`](08-assets-pipeline.md) on `OffscreenCanvas` in a worker. Needs a one-line answer. |
| Q7 | Is `players[0]` at `init` guaranteed to be the lobby creator on the real server? | Phase 4 | It is documented for the local peer (*"index 0 is the elected host on every transport"*) and is what the template assumes, but `PlayerInfo` carries no owner flag and `Kb` has no getter — so the authority's whole DM-permission model rests on the convention. Confirm it directly. |
| Q5 | Is Phaser 4's API materially different for cameras, drag input and dynamic textures? | Phase 3 | Must be checked early — the target pins 4.2.1 and most Phaser material online is 3.x. |
