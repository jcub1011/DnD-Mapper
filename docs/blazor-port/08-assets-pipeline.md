# 08 — Asset Pipeline

How a map image gets from the DM's hard drive to every player's screen — and the seam that lets v1
ship before the platform's blob-share exists.

## The legacy pipeline

```
<input type="file">
   ↓  AdoptInputElementFilesAsync      bytes go browser → IndexedDB directly,
   │                                    never through SignalR
   ↓  probeMaxTextureSize()             WebGL2 MAX_TEXTURE_SIZE, clamped to 8192
   ↓  decodeAndMaybeDownscale()         Web Worker + OffscreenCanvas,
   │                                    re-encode oversize art to WebP q=0.92,
   │                                    overwrite the IDB row
   ↓  Engine.AddImageAsync(metadata)    only metadata crosses the wire
   ↓  ShareToken (Guid) published
   ↓  players fetch /blob-share/{token} → pulled from the HOST's browser
                                          over the host's SignalR circuit
```

Caps: **100 MB/file, 1 GB/room**, MIME `image/png|jpeg|webp`.

The DM's own client skips the round trip entirely and uses a local `blob:` URL.

### What survives, what dies

| Stage | Fate |
| --- | --- |
| File input / drag-drop | Port |
| **IndexedDB storage of bytes** | **Port unchanged** — still the right place |
| **`probeMaxTextureSize`** | **Port unchanged** — Phaser has the same GPU ceiling |
| **Worker downscale to WebP** | **Port unchanged** — same problem, same fix |
| Metadata-only through the wire | Port — even more true now (512 KiB cap) |
| `ShareToken` Guid | **Becomes the blob-share handle** |
| `/blob-share/{token}` via SignalR | **Dies.** No equivalent exists. → [`09`](09-blob-share-server-spec.md) |

The downscale worker is worth emphasising: it is not legacy cruft. A 12000×9000 battlemap exceeds
every GPU's `MAX_TEXTURE_SIZE`, and Phaser will fail to render it exactly as the old CSS-transform
path did. **Port it before the first large map is tested, not after.**

## The `AssetSource` seam

This is what lets v1 ship without phase 0 being finished, and what keeps the eventual switch small.

```ts
// src/assets/assetSource.ts
/**
 * Resolves a logical image id to something Phaser can load.
 *
 * The DM always has the bytes locally. Players do not, and how they get them
 * depends on the platform: today, not at all; after blob-share, by URL.
 */
export interface AssetSource {
  /** A URL Phaser can hand to `load.image()`, or null if unavailable here. */
  resolve(imageId: string): Promise<string | null>;

  /** Called by the DM after an image is added. No-op where there is nothing to publish. */
  publish(imageId: string, blob: Blob): Promise<void>;

  /** Called when an image is removed from the campaign. */
  release(imageId: string): Promise<void>;
}
```

Three implementations, arriving in this order:

| Implementation | Phase | Behaviour |
| --- | --- | --- |
| `LocalAssetSource` | 1 | `resolve` returns a `blob:` URL from the DM's library, or `null` if absent. `publish`/`release` are no-ops. |
| `BlobShareAssetSource` | 4 | `publish` hashes, skips via `HEAD` or uploads, then registers; `resolve` returns a URL; `release` unregisters. |
| `NullAssetSource` | tests | Always `null` — exercises the placeholder path. |

`BlobShareAssetSource` is written against a `BlobTransport` interface with an IndexedDB
implementation for `solo`/`local-tab` and an HTTP one for `platform`, so **the port never blocks on
the phase-0 addon release**. The seam, and the reason the local store must stay separate from the
DM's library, are specified in
[`09-blob-share-server-spec.md`](09-blob-share-server-spec.md#local-emulation).

**Everything above this interface is written once.** The Phaser scene asks for a URL, gets one or
gets `null`, and draws the dashed placeholder for `null` — which is exactly legacy's behaviour for a
missing bitmap, so the degraded state is already designed.

That is the whole reason v1 can sync tokens and fog to players while map art stays DM-local: players
simply resolve `null` and see grid, tokens and fog over a placeholder.

> **Be precise about *where* art is DM-local, because it is not everywhere.** With
> `IdbBlobTransport` ([`09`](09-blob-share-server-spec.md#local-emulation)), map art works fully in
> `solo` and `local-tab` from phase 1 — same-origin tabs share IndexedDB. It is only on the
> **platform** that players see placeholders, and only until phase 0 ships.
>
> That is deliberate and it is the right trade, but note what it implies: the port's primary
> development loop shows working art while production does not. So the placeholder path must be
> exercised on purpose, not incidentally — which is exactly what
> [`11`](11-verification.md#the-asset-check-that-must-not-be-skipped)'s
> "comment out `publish()`" check is for. Treat that check as load-bearing, not optional.

Note also that the **metadata** still has to reach the authority, and for an imported campaign
that is its own protocol — see
[`06`](06-state-and-authority.md#getting-a-campaign-into-the-authority).

## Content addressing on the client

Once phase 0 lands, the client hashes locally and can skip uploads entirely.

> **This is `BlobTransport`'s job, not `AssetSource`'s.** The pseudocode below is the *semantics*;
> the HTTP calls live behind `BlobTransport`
> ([`09`](09-blob-share-server-spec.md#dont-block-the-port-on-the-addon-release)) so the same
> `BlobShareAssetSource` runs against IndexedDB locally and HTTP on the platform. `AssetSource`
> never sees a hash or a URL scheme.

```ts
async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
```

```
publish(imageId, blob):                       // BlobShareAssetSource
   hash = sha256Hex(blob)
   if (await transport.has(hash)):            // HEAD /blob/{hash}, or an IDB count
        await transport.register(imageId, hash)    // no bytes transferred at all
   else:
        await transport.put(hash, blob)       // PUT /blob/{hash}, streamed
        await transport.register(imageId, hash)

resolve(imageId):
   hash = await transport.hashFor(imageId)    // the handle lookup — see 09
   return hash === null ? null : await transport.urlFor(hash)
```

Two payoffs:

- The **second** lobby to use a popular battlemap transfers nothing.
- Re-importing the same `.vtf` re-mints image GUIDs (see [`04-vtf-format.md`](04-vtf-format.md)) but
  the **bytes hash identically**, so the server stores one copy and the new logical ids just
  register against it. The indirection layer makes this automatic.

> Hashing a 50 MB blob via `arrayBuffer()` materialises it in memory on the client. That is
> acceptable on a desktop browser (the file is already in memory from the worker), but if it becomes
> a problem, hash incrementally over a `ReadableStream` instead.

## IndexedDB layout

**A new store, reusing legacy's shape.** The layout is well designed and worth copying; the
database itself is deliberately *not* the legacy one — this is a different app, it will never
migrate legacy rows, and opening `KnockBox.DndMapper` by name from a KnockBox game would be wrong
even if it worked (different origin).

```
Database "DnDMapper", version 1          ← new store. Legacy is "KnockBox.DndMapper" v3.
  stores:
    library      JSON — sharded slot data
    slots_index  JSON — the slot list
    images       Blob — keyed by image id
```

> Legacy carries **two** version numbers and it is easy to quote the wrong one: the IndexedDB
> version is 3, while `LibraryCoreSnapshot.SchemaVersion` — the *shard layout* the port is actually
> copying — is 4. The port starts both at 1.

Slot sharding (**keep this** — it is what makes auto-save cheap):

```
{slotId}:core            campaign-level data
{slotId}:map:{mapId}     one map: fog mask, tokens, image metadata
{slotId}:sheet:{sheetId} one character sheet
```

`__auto__` is the reserved auto-save slot, which cannot be renamed or deleted.

### Auto-save

Three mechanisms, all worth porting:

1. **500 ms debounce** after the last change.
2. **A fingerprint of object references** short-circuits when nothing *persisted* changed. Legacy
   uses nine references; a dice roll appends to `RollLog`, which isn't persisted, so it writes
   nothing. In TypeScript this is identity comparison over the same set of slices.
3. **Per-shard hashing** — only shards whose serialized form changed are written. Moving one token
   rewrites `__auto__:map:{A}` and `__auto__:core`, nothing else.

Plus: a `SemaphoreSlim` equivalent (a promise chain) serializing flushes, a re-arm if an edit lands
mid-flush, and a `beforeunload` guard while saving.

> **The fingerprint is not a micro-optimisation.** Without it, every camera nudge and every dice
> roll would rewrite the whole library. With large maps that is a visible stall.

### Storage pressure

Legacy tracks `BytesUsed` and caps at 1 GB/room. Browsers also enforce their own quota, and
IndexedDB writes fail *late* and unhelpfully. Port the accounting, surface it in the saves panel as
legacy does, and handle `QuotaExceededError` with a real message rather than a silent failure.

## Wiring into Phaser

```ts
/**
 * One in-flight load per image id, and exactly one listener pair per attempt.
 *
 * Three traps the obvious version walks into:
 *  - `loaderror` is NOT scoped to a key, so an unscoped handler resolves the wrong promise
 *    whenever any concurrent load fails. Filter on the file key.
 *  - Whichever handler doesn't fire is never removed — a listener leak per image, and this
 *    runs once per image per map switch.
 *  - Two callers both calling `load.start()` on a loader that is already running.
 */
const inFlight = new Map<string, Promise<boolean>>();

function ensureTexture(scene: Phaser.Scene, image: MapImage): Promise<boolean> {
  if (scene.textures.exists(image.id)) return Promise.resolve(true);

  const existing = inFlight.get(image.id);
  if (existing) return existing;

  const task = (async () => {
    const url = await assets.resolve(image.id);
    if (url === null) return false;                            // → dashed placeholder

    return await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        scene.load.off(`filecomplete-image-${image.id}`, onDone);
        scene.load.off("loaderror", onError);
        resolve(ok);
      };
      const onDone = () => done(true);
      const onError = (file: { key: string }) => {
        if (file.key === image.id) done(false);                // scoped, not global
      };

      scene.load.on(`filecomplete-image-${image.id}`, onDone);
      scene.load.on("loaderror", onError);
      scene.load.image(image.id, url);
      if (!scene.load.isLoading()) scene.load.start();         // required outside preload()
    });
  })().finally(() => inFlight.delete(image.id));

  inFlight.set(image.id, task);
  return task;
}
```

Notes:

- **Revoke `blob:` URLs** once the texture is uploaded (`URL.revokeObjectURL`), or the browser
  pins every image's bytes in memory for the session. Legacy managed this with an eviction map and
  `bitmap.close()`; the equivalent discipline applies.
- **Destroy Phaser textures** when an image is removed, or GPU memory grows without bound over a
  long session with many maps.
- On **WebGL context loss**, textures are gone and must be re-uploaded. The template's guards
  (`fx.ts:61-72`) only log; for the map scene, re-run `ensureTexture` for every visible image on
  `webglcontextrestored`. See [`05-rendering.md`](05-rendering.md).

## Order of work

1. **Phase 1** — file input, IndexedDB blob store, `LocalAssetSource`, texture-size probe, worker
   downscale. The DM can add images and see them.
2. **Phase 2** — `.vtf` import feeds blobs into the same store.
3. **Phase 4** — `BlobShareAssetSource` over `IdbBlobTransport`, so multiplayer art works in
   `solo` and `local-tab`. **No scene code changes.**
4. **After phase 0 ships** — swap `IdbBlobTransport` for `HttpBlobTransport` by launch mode. Again
   no scene changes, and no `AssetSource` changes either.

If phase 0 slips, phases 1–4 are unaffected *locally*; only platform players keep seeing
placeholders. That is the point of the seam — and the reason the placeholder path has to be a
tested state rather than an accident.
