# 04 — The `.vtf` File Format

**"I should be able to open the same proprietary virtual table top files"** is a hard requirement.
This document is the spec, detailed enough to write an importer without reopening the C# source.

Owners in the legacy tree:
- `Services/Library/Vtf/VtfPackager.cs` (599 lines) — `Pack` / `Unpack` / `BuildClientPayload`
- `Services/Library/Vtf/VtfDocument.cs` (178 lines) — the DTOs

## At a glance

| | |
| --- | --- |
| Extension | **`.vtf`** ("Virtual Table Format") |
| Container | **ZIP** |
| Serializer | `System.Text.Json`, **camelCase**, indented, nulls omitted (`WhenWritingNull`) |
| Spec version | `1.0.0`; `SupportedMajorVersion = 1` |
| External VTT interop | **None.** Not Universal VTT / `.dd2vtt` / `.uvtt`, not Roll20, not Foundry. |

> A repo-wide search for `dd2vtt`, `uvtt`, "Universal VTT", `roll20` and `foundry` returns zero
> hits. The name and layout are *inspired by* a "Virtual Table Format spec", but nothing
> interoperates. This also means the walls/lights/portals that Universal VTT carries have no
> counterpart in the domain model anyway.

## Archive layout

```
manifest.json                              deflate
global_state.json                          deflate
scenes/{mapGuid:D}.json                    deflate     one per map
entities/sheet_{sheetGuid:D}.json          deflate     one per character sheet
assets/images/{imageGuid:D}.{png|jpg|webp} STORED  (CompressionLevel.NoCompression)
extensions/knockbox_dnd_mapper.json        deflate
```

**Images are STORED, not deflated** — they are already compressed, and storing them keeps packing
fast. JSON entries are deflated.

Extension mapping:

| Content type | Extension |
| --- | --- |
| `image/png` | `.png` |
| `image/jpeg` | `.jpg` |
| `image/webp` | `.webp` |
| anything else | `.bin` |

On read, the reverse map also accepts `.jpeg` → `image/jpeg`, and **rejects** anything outside that
set with a warning.

`{guid:D}` is the .NET "D" format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, lowercase, hyphenated.

## The round-trip rule — read this before writing any importer

From `VtfPackager.cs:14-17`:

> *"Round-trip authority on import is the vendor data — spec projections are regenerated on every
> pack."*

Every scene and entity carries **both**:

1. A **spec-level projection** (`layers[]`, `entityInstances[]`) — a courtesy for foreign readers.
2. A **`vendorData["knockbox_dnd_mapper"]`** block — the real, complete data.

**On import, read `vendorData` and ignore the projections.** On export, regenerate the projections
from scratch.

There is exactly **one** fallback (`VtfPackager.cs:476-489`): a token instance with no vendor data
but a parseable `instanceId` and `transform.gridPosition` synthesizes a minimal `TokenSnapshot`, so
a foreign `.vtf` still produces something visible. Layers and scenes without vendor data are
**skipped with a warning**.

## `manifest.json`

```json
{
  "vtfVersion": "1.0.0",
  "campaign": {
    "id": "<new guid>",
    "title": "<slot name>",
    "author": null,
    "lastModified": "<utc>"
  },
  "system": { "core": "dnd5e" },
  "dependencies": [{ "name": "knockbox_dnd_mapper", "minVersion": "1" }],
  "entryState": { "activeScene": "scenes/{firstMapId}.json" }
}
```

**Version check:** parse the leading integer of `vtfVersion`; if `major > 1`, throw
`InvalidDataException`. Do not attempt a best-effort read of a future major.

## `global_state.json`

```json
{
  "campaignTime": {},
  "playlist": [],
  "vendorData": { "knockbox_dnd_mapper": { /* DndMapperGlobalVendor */ } }
}
```

`DndMapperGlobalVendor` carries: `Settings`, `AttributeSchema`, `ActiveSchemaTemplateId`,
`InitiativeAttributeName`, `CustomTemplates[]`, `GlobalRollTemplates[]`, `LoadedDiceRules[]`,
`MapOrder[]`, `SheetOrder[]`.

> `MapOrder` and `SheetOrder` are the authority on ordering. Do not infer order from ZIP entry
> order or from `listOrder` alone.

## `scenes/{mapId}.json`

```json
{
  "sceneId": "…",
  "dimensions": { "width": 1500, "height": 1000 },
  "grid": {
    "type": "square",
    "size": 50,
    "offsetX": 0,
    "offsetY": 0,
    "color": "#222",
    "visible": true,
    "measurement": { "distance": 5, "unit": "ft" }
  },
  "ambience": [],
  "layers": [ /* spec projection of images — IGNORED on import */ ],
  "entityInstances": [ /* spec projection of tokens — IGNORED on import */ ],
  "vendorData": { "knockbox_dnd_mapper": { /* DndMapperSceneVendor */ } }
}
```

> **`dimensions` is in PIXELS** (`cells × cellPixels`), while everything in `vendorData` is in
> **cells**. This is the single easiest place to introduce a `CellPixels`-factor bug. `grid.size`
> *is* `cellPixels`, so the cell counts are recoverable — but read them from `vendorData.Grid`,
> which has them directly.

### `DndMapperSceneVendor`

```
Id, Name, ListOrder, CreatedUtc, Grid,
DefaultSpawnX, DefaultSpawnY,
byte[] FogMask          ← base64 (System.Text.Json's default for byte[])
```

**`fogMask` is base64**, not an array of numbers — `System.Text.Json`'s default for `byte[]`. So it
arrives as a `FogMaskB64` and must go through `decodeFog()` before any bit maths; see
[`03-domain-model.md`](03-domain-model.md#1-cell-units-everywhere) for the two named types and the
`isFogged` helper. Do not index the base64 string.

An empty or absent mask means **fully revealed**.

### The spec projections (write-only)

```json
// layers[]
{ "id": "…", "name": "…", "type": "image",
  "assetRef": "assets/images/{id}.png",
  "zIndex": 0, "opacity": 1.0,
  "vendorData": { "knockbox_dnd_mapper": { /* MapImageSnapshot */ } } }

// entityInstances[]
{ "instanceId": "…", "entityRef": "entities/sheet_{id}.json",
  "transform": { "gridPosition": { "x": 3.5, "y": 4.5 },
                 "pixelOffset": { "x": 0, "y": 0 },
                 "rotation": 0, "scale": 1 },
  "vendorData": { "knockbox_dnd_mapper": { /* TokenSnapshot */ } } }
```

Note `transform.rotation` and `scale` are always `0`/`1` for tokens — token rotation is not
modelled. Image rotation lives in the vendor block, not here.

## `entities/sheet_{id}.json`

```json
{ "entityId": "sheet_{guid}", "name": "…", "assetRef": null,
  "vendorData": { "knockbox_dnd_mapper": { /* SheetSnapshot */ } } }
```

## `extensions/knockbox_dnd_mapper.json`

```
VtfExtensionPayload(CombatState? ActiveCombat, DndMapperPhase Phase)
```

`CombatState` is persisted **only here** — the IndexedDB library omits it.

## Forward compatibility

Most DTOs carry:

```csharp
[JsonExtensionData] public Dictionary<string, JsonElement> ExtraData { get; init; }
```

so unknown fields from a future minor revision survive a round trip. **12 of the 14 DTOs in
`VtfDocument.cs` have it; two do not** — `VtfGridPosition` and `VtfPixelOffset` are bare
`{ double X; double Y; }`, so unknown keys on a token's grid position or pixel offset are silently
dropped. Worth fixing on the way through rather than faithfully reproducing, since those are
projection-only structures the port regenerates anyway.

**The TypeScript port should do the same** — capture unrecognised keys and re-emit them:

```ts
interface VtfSceneVendor {
  id: string; name: string; /* … */
  /** Unknown keys from a newer writer, preserved verbatim. */
  extra?: Record<string, unknown>;
}
```

## Security: path safety (do not skip)

`IsSafeRelativePath` is checked for **every entry before reading**, and rejects:

- backslashes
- a leading `/`
- drive letters (`C:`)
- `..` segments
- a bare `.`

This is a **zip-slip guard**. It matters just as much in the browser: a malicious `.vtf` should not
be able to steer entry names into unexpected keys in IndexedDB or a cache. Reproduce the check.

Also enforce the legacy caps on import:

| Cap | Value | Note |
| --- | --- | --- |
| Per file | 100 MB | per image inside the archive |
| Per room | 1 GB | aggregate, tracked as `bytesUsed` |
| Archive | 2 GB | **legacy's server-side number — see below** |
| MIME allow-list | `application/zip`, `application/x-zip-compressed`, `application/octet-stream`, `""` | |

> **The 2 GB archive cap is not reachable in a browser, and pretending otherwise is worse than
> lowering it.** Legacy read `.vtf` server-side, where a 2 GB stream is ordinary. This port reads it
> in the tab: a 2 GB `File` cannot be `arrayBuffer()`'d in any browser, and even 200 MB is an
> unpleasant allocation ([`08`](08-assets-pipeline.md#content-addressing-on-the-client) flags the
> same problem for hashing at 50 MB).
>
> So the reader **must not slurp**. `File` is a `Blob`, and a ZIP is designed for exactly this
> access pattern:
>
> 1. `blob.slice(-65557).arrayBuffer()` → scan backwards for the EOCD signature.
> 2. `blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer()` → the whole central directory, which is
>    small (a few hundred bytes per entry).
> 3. Per entry, `blob.slice(localHeaderOffset, localHeaderOffset + size)` → stream that one entry
>    through `DecompressionStream`, or hand the slice straight to the image store for a STORED
>    entry.
>
> Only one entry is ever in memory, and image entries never need decompressing at all (they are
> STORED). Set a real, enforced browser-side cap as well — **500 MB** is generous for a battlemap
> campaign — and reject earlier with a clear message rather than failing inside an allocation.

Two smaller reader caveats:

- **No ZIP64.** Fine below 4 GB and 65,535 entries, which the caps above guarantee — but reject a
  ZIP64 end-of-central-directory record explicitly instead of misreading it.
- **A trailing archive comment shifts the EOCD**, and data descriptors move the compressed size out
  of the local header. Legacy's own writer produces neither, but this document also wants to accept
  *"a foreign `.vtf`"*, so scan for the EOCD signature rather than assuming it is the last 22 bytes,
  and take sizes from the **central directory**, never from the local header.

## Import behaviour

`VtfImportButton` → `ImportSlotFromInputElementAsync` → `ImportSlotAsync` → `VtfPackager.Unpack`.

**Every image GUID is re-minted on import**, so re-importing the same file twice produces two
independent slots rather than colliding. Preserve this — but note the interaction with
content-addressed blob storage: the *blob hash* is unchanged, so the bytes still dedup on the
server even though the logical image id is new. That is exactly the indirection
[`09-blob-share-server-spec.md`](09-blob-share-server-spec.md) provides.

## Export (not required — D4)

Two paths exist in legacy. The second is the one to port if export is ever wanted:

1. **Server-side** — `ExportSlotAsync` → `VtfPackager.Pack` → download. Image bytes cross SignalR.
2. **Client-side (preferred)** — `BuildClientPayload` returns *JSON shards only*; then
   `wwwroot/js/dndMapperVtfPackager.js` (282 lines) opens IndexedDB directly, reads the blobs, and
   **hand-writes the ZIP**: its own CRC32 table, `CompressionStream('deflate-raw')`, local headers,
   central directory, EOCD, and a fixed DOS date `0x5821`. Image bytes never leave the browser.

**That second module ports to this codebase nearly unchanged** — it is already framework-free
browser JS, and this repo has no server to stream bytes through anyway.

## Implementation plan

Target: `src/vtf/`. This is client-side only — **the authority sandbox has no `fetch`, no file
access, and cannot participate.**

```
src/vtf/
  types.ts       DTOs mirroring VtfDocument.cs, with `extra` passthrough
  unzip.ts       Blob-backed ZIP reader (EOCD scan + central directory + lazy slices)
  import.ts      Archive → DndMapperState + a list of image blobs
  safePath.ts    IsSafeRelativePath, ported verbatim
  import.test.ts Fixtures
```

Import produces a `DndMapperState` in the DM's browser. Note that getting it from there into the
**authority** is a separate protocol, not one big intent — see
[`06`](06-state-and-authority.md#getting-a-campaign-into-the-authority).

Use `DecompressionStream('deflate-raw')`, so no ZIP library is needed — mirroring how the legacy
exporter uses `CompressionStream`.

> **This needs a target-browser statement, which the doc set does not currently have anywhere.**
> `CompressionStream`/`DecompressionStream` are recent: Chrome/Edge 80+, Firefox 113+, **Safari
> 16.4+**. A KnockBox game runs in an iframe on whatever the player brought, and `deflate-raw`
> specifically arrived later than the gzip formats. Either:
>
> - declare the floor (Safari 16.4 / Firefox 113 is reasonable for 2026) in
>   [`02`](02-target-platform.md) and feature-detect with a clear error, or
> - carry a ~2 KB inflate fallback for `DecompressionStream === undefined`.
>
> Detect it at import time, not at first entry — failing after the user picked a file, halfway
> through a campaign, is the worst version of this.

### Steps

1. **`unzip.ts`** — a `Blob`-backed reader: locate the EOCD by signature scan over the last
   ~64 KB, read the central directory, then expose entries lazily as `Blob` slices. Handle both
   STORED (method 0) and DEFLATE (method 8). Validate every name through `safePath` *before*
   reading, and take sizes from the central directory. **Never read the whole file into memory** —
   see the archive-cap note above.
2. **`types.ts`** — DTOs with `extra` passthrough.
3. **`import.ts`** — in order: `manifest.json` (version gate first), `global_state.json`,
   each `scenes/*.json`, each `entities/*.json`, `extensions/…`. Read **vendor data only**, with
   the single token fallback. Apply `MapOrder`/`SheetOrder`. Decode `fogMask` from base64. Re-mint
   image GUIDs. Emit image blobs separately for the asset pipeline.
4. **Wire to the UI** — a file input and a drag-drop target, matching legacy's `VtfImportButton`.

### Tests

Build fixtures by hand rather than depending on a legacy binary:

| Test | Asserts |
| --- | --- |
| Minimal valid archive | Round-trips to the expected state |
| `vtfVersion: "2.0.0"` | Throws, does not best-effort |
| Entry named `../evil.json` | Rejected |
| Base64 fog mask | Decodes to the right fogged cells, incl. non-byte-aligned widths |
| Absent fog mask | Yields fully **revealed**, not fully fogged |
| Token with vendor data | Lands at a cell centre (`x.5`) |
| Token with **no** vendor data | Hits the synthesis fallback |
| Layer with no vendor data | Skipped with a warning, import still succeeds |
| Unknown JSON field | Survives in `extra` |
| Two imports of one file | Produce distinct image ids, identical blob hashes |
| Archive with a trailing comment | EOCD still found by signature scan |
| ZIP64 EOCD record | Rejected explicitly, not misread |
| A 200 MB fixture | Imports without ever materialising the whole archive (assert peak slice size) |
| `DecompressionStream` absent | Fails at import time with a clear message, not mid-entry |

**Get a real legacy `.vtf` and add it as a fixture as early as possible.** Hand-built fixtures
verify the parser against this document; only a real file verifies this document against reality.
