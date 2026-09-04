# 09 — Blob Share (Platform Feature Spec)

A new feature for **`KnockBox-Games`**, not for this repo. It is phase 0: multiplayer map art
cannot work without it.

All citations are relative to `…\KnockBox-Games\KnockBox.Server\` unless noted.

## Requirements

| # | Requirement | Source |
| --- | --- | --- |
| R1 | Server memory stays **constant** regardless of blob size and count, across concurrent sessions | D6 |
| R2 | **Content-addressed**: identical bytes stored once, however many sessions register them | D7 |
| R3 | Sessions register blobs under **their own logical ids**; the mapping is server-side | D7 |
| R4 | Lifetime is **tied to the lobby**; eviction is automatic on lobby close | D8 |
| R5 | Manual unregister is **available but never required** | D8 |
| R6 | Dedup is **invisible to the game** — duplicate registrations are independent handles | D9 |

R1 is the design driver. R6 is the one most likely to be implemented subtly wrong.

## Why not the relay

Covered fully in [`02-target-platform.md`](02-target-platform.md#why-images-cannot-cross-the-relay).
In short: a 512 KiB non-configurable frame cap whose overage closes the socket, a 30 msg/s budget
whose violation is a **terminal** disconnect the SDK never reconnects from, and a `DropOldest`
outbound queue that silently loses chunks with no ack or retransmit anywhere in the protocol. A
20 MB map is ~54 messages against a 60-message burst.

## Architecture

Borrow the **structure** of `Games\Words\AuthorityWordService.cs` — it is already exactly the
"logical name → shared content" indirection R3 asks for — and borrow the **lifetime machinery** from
`Games\AuthorityModuleCache.cs`, which the word service lacks entirely.

### The three maps

```csharp
// Mirrors AuthorityWordService.cs:29-31
private readonly ConcurrentDictionary<(string LobbyId, string LogicalId), BlobHandle> _handles = new();
private readonly ConcurrentDictionary<string, BlobEntry> _content = new(StringComparer.Ordinal);
private readonly ConcurrentDictionary<string, string> _hashByStat = new(StringComparer.Ordinal);
```

| Map | Purpose |
| --- | --- |
| `_handles` | **R3/R6.** One entry per registration. *This is the unit of accounting.* |
| `_content` | **R2.** Keyed by SHA-256 hex. The value describes a file on disk, never its bytes. |
| `_hashByStat` | Optional ingest memo, only if the server ever hashes local files. |

```csharp
private sealed record BlobHandle(string Sha256, long RegisteredTicks);

// Mutable class, NOT a record — AuthorityModuleCache.cs:45-60 explains why:
// a record would allocate a replacement entry on every touch.
private sealed class BlobEntry
{
    public required string Sha256;
    public required string Path;
    public required long Length;
    public required string ContentType;
    public int RefCount;              // guarded by Interlocked
    public long LastUsedTicks;
    public long GraceUntilTicks;      // upload-before-register window
}
```

### Refcounting — get R6 right

**The refcount is the number of live handles, not the number of lobbies.**

```
register(L1, "map-a", H)  → refcount(H) = 1
register(L1, "map-b", H)  → refcount(H) = 2   ← same lobby, different logical id
register(L2, "bg",    H)  → refcount(H) = 3
unregister(L1, "map-b")   → refcount(H) = 2   ← file survives; L1 still sees "map-a"
closeLobby(L1)            → refcount(H) = 1   ← releases every handle L1 holds
closeLobby(L2)            → refcount(H) = 0   → DELETE the file
```

This is what makes dedup invisible: the game registered two blobs and can release either one
independently, exactly as if they were separate files.

Rules:

- **`register` is idempotent** for the same `(lobbyId, logicalId, sha256)` — re-registering must not
  double-count. Use `_handles.TryAdd`; on a collision with an identical hash, return success without
  incrementing.
- **Re-registering an existing `logicalId` against a different hash** releases the old ref and
  acquires the new, in that order, within one operation.
- **`unregister` on an unknown handle is a no-op success**, not an error. Games must be able to call
  it defensively.

> The word service reclaims by mark-and-sweep because its root set (the game catalog) is externally
> enumerable. Blob roots are **not** — only this service knows a lobby's handles — so an explicit
> refcount replaces the sweep. Keep the sweep as a backstop, not as the mechanism.

## Storage — satisfying R1

### Layout

```
blobs/
  <first2>/<sha256>            content-addressed; sharded to avoid one huge directory
  .staging/upload-<guid>.part  in-flight uploads
```

Sharding by the first two hex characters keeps directory sizes sane; `GameAssetPrecompressor`'s
per-game subdirectories are the local precedent for not flattening everything.

**Staging must sit on the destination's own volume** so publishing is a rename, not a copy —
`PackageManager.cs:231-232` and its test `PackageManagerTests.cs:136-138` make this explicit.

### Ingest — stream, hash, rename

Follow **`MarketplaceClient.FetchPackageAsync` (`Marketplace\MarketplaceClient.cs:544-572`)**, not
`PackageManager.ReceiveAsync`. The former already does `ArrayPool` + `useAsync: true` +
`IncrementalHash` in a single pass; the latter does none of the three.

```csharp
var buffer = ArrayPool<byte>.Shared.Rent(81920);      // 81920 is the repo's universal chunk size
using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
var path = Path.Combine(stagingDir, $"upload-{Guid.NewGuid():N}.part");
long total = 0;
try
{
    await using (var file = new FileStream(
        path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true))
    {
        int read;
        while ((read = await body.ReadAsync(buffer.AsMemory(0, 81920), ct)) > 0)
        {
            total += read;
            if (total > limits.MaxBlobBytes) throw new BlobTooLargeException(limits.MaxBlobBytes);
            hasher.AppendData(buffer, 0, read);
            await file.WriteAsync(buffer.AsMemory(0, read), ct);
        }
    }
    var hash = Convert.ToHexStringLower(hasher.GetHashAndReset());
    // …verify against the client-declared hash, then AtomicFile.MoveWithRetry(path, Final(hash))
}
catch { try { File.Delete(path); } catch { } throw; }
finally { ArrayPool<byte>.Shared.Return(buffer); }
```

**Peak managed memory per upload: 80 KB.** That is R1.

The cap is enforced against **bytes written, never `Content-Length`** — a client-supplied length is
not evidence. Same doctrine as `PackageManager.cs:227-229`.

**Verify the hash the client declared.** The URL names a hash; if the bytes don't match, reject with
400 and delete the staging file. Otherwise a client could poison a well-known hash with different
content — the one real attack this design admits.

Concurrency needs **no per-key lock**, and content-addressing is why: two uploaders of identical
bytes each write their own GUID-named `.part` and both rename to the same final name. A lost race is
a no-op *by construction* — the loser's bytes and the winner's bytes are the same bytes, which is
what makes this different from ordinary staging. `overwrite: true` makes the second rename harmless.

> Do **not** justify this by analogy to `PackageManager`. That class does have GUID staging and an
> `overwrite: true` rename, but the rename is documented purely as crash-atomicity
> (`PackageManager.cs:693-694`: *"one atomic rename, so there is no instant at which the id has no
> package"*), and the repo's actual answer to per-key locking is an **inspectable job registry** —
> `PackageManager.cs:56-58` argues for `PackageJobRegistry.ActiveFor` over a semaphore *because a
> dictionary entry can be inspected and reported back to a second caller*. A blob store has no
> equivalent registry, so it cannot borrow that argument; it does not need to, because its keys are
> hashes.

### Serving — `SendFileAsync` for free

Mount a `PhysicalFileProvider` over `blobs/` and let `StaticFileMiddleware` serve it. That gives
**ETag, `If-None-Match`/304, `Range`/206, `Content-Length`, and kernel sendfile** with
framework-guaranteed constant memory — the same machinery the repo already trusts for
multi-hundred-MB WASM payloads (`Program.cs:977-978`, `:1034-1035`).

Because content is immutable by construction:

```
Cache-Control: public, max-age=31536000, immutable
```

Two traps:

- **`application/octet-stream` is in the response-compression MIME list** (`Program.cs:452-461`), so
  a blob served under it would be Brotli-compressed at request time — burning CPU to re-compress
  already-compressed PNG/WebP. Serve a real image content type, or set `Content-Encoding` to make
  `ResponseCompression` skip it (the trick used at `Program.cs:1036`).
- The route must sit **inside the games-origin `MapWhen`** (`Program.cs:1213-1265`), so it inherits
  the two 404 gates (authority-asset denial at `:1223-1231`, `.kbg` denial at `:1237-1245`) — but
  insert it **after `ApplyCrossOriginIsolation` at `:1246-1250`**, not immediately after the gates.
  Slotting in before that middleware would serve blobs without COOP/COEP headers.
- **Do not namespace it under `/games/`.** The shell origin 404s every `/games/*` path that is not a
  catalog-declared thumbnail (`:1293-1304`). `/blob/{hash}` is clear; `/games/blob/{hash}` would be
  killed there.

### Authorization — capability by hash

**Reads need no auth**, and the URL is the capability. This is the same model legacy used —
`/blob-share/{token}` authorized by an unguessable Guid — and it solves a real problem:
`<img src>`, `<audio src>` and Phaser's loader cannot attach headers, so a header-based scheme
would break all of them.

> **But content-addressing makes this capability *weaker* than legacy's, not stronger, and the
> difference should be recorded rather than glossed.** A hash is derived from the bytes, so it is
> unguessable only for content the requester does not already have. Anyone holding the same
> file — a commercial map pack, a popular free battlemap — can compute its hash. Combined with an
> unauthenticated `HEAD /blob/{hash}`, that is a *"does this server hold these bytes"* oracle: a
> player who owns the same map pack as their DM can probe for which maps the DM has uploaded, which
> is spoilers, and spoilers are most of what a VTT's asset privacy is for. Legacy's random Guid had
> no such property.
>
> The repo has already reasoned about the adjacent risk: the `.kbg` 404 gate exists because
> `ServeUnknownFileTypes = true` with `DefaultContentType = "application/octet-stream"`
> (`Program.cs:1026-1027`) *"would hand out the whole archive at a guessable URL, uncached"*
> (`:1232-1236`). A blob store on the same static pipeline inherits exactly that shape.
>
> **Accept it, or spend one line fixing it.** The mitigation keeps the URL headerless: key reads on
> `HMAC(serverSecret, hash)` rather than the bare hash. The server still stores by hash (dedup
> intact), `register` returns the HMAC'd path, and the hash stops being guessable from the bytes.
> The cost is that URLs no longer survive a restart — which they already do not, since the startup
> sweep deletes everything.

**Writes need full auth.** Repeat the three-check pattern from `WebSocketHandler.cs:602-624` —
signature alone is not this repo's bar:

```csharp
if (!tokens.TryVerifyTicket(ticket, out var playerId, out var lobbyId, out var gameId)) return 401;
var lobby = lobbies.Get(lobbyId);
if (lobby is null || !lobby.Contains(playerId))                       return 403; // live membership
if (!string.Equals(gameId, lobby.GameId, StringComparison.OrdinalIgnoreCase)) return 403;
```

The ticket lives in the iframe's URL **fragment** and is deliberately never sent to the server
(`web/kb-core.js:98,119-122`), so the SDK must attach it explicitly — an `Authorization: Bearer` or
`X-KnockBox-Ticket` header on a same-origin `fetch`, which needs no preflight.

Follow `AdminApi.WriteGuardRefusal`'s shape: a **pure** `(int Status, string Error)?` decision
function plus a thin `RequestDelegate` wrapper, kept free of `HttpContext` — the repo does this
because *"it is a security decision, and one that has already been wrong in a way nothing but a real
request would have shown"* (`AdminApi.cs:2221-2225`).

## HTTP surface

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `HEAD` | `/blob/{sha256}` | none | Does the server already have these bytes? |
| `GET` | `/blob/{sha256}` | none | Fetch (static middleware; ranges + 304 free) |
| `PUT` | `/blob/{sha256}` | ticket | Upload. 200 if already present, no body read. |
| `POST` | `/blob/register` | ticket | `{ logicalId, sha256 }` → handle |
| `DELETE` | `/blob/register/{logicalId}` | ticket | Optional unregister (R5) |

`lobbyId` is never a parameter — it comes from the verified ticket. A client cannot register into
someone else's lobby.

`PUT` returning 200 for an already-present hash is what makes the client's `HEAD`-then-skip flow
robust even under a race.

> **Say what happens to the body in that case.** Responding 200 without reading a 100 MB request
> body produces client-visible broken pipes on some stacks. Either drain it (simple, wasteful) or
> respond and let Kestrel reset the stream — and have the client cooperate by sending
> `Expect: 100-continue`, so the common "already present" case never sends bytes at all. Pick one
> and state it; this is the kind of thing that works in a test and fails behind a proxy.

Kestrel's default body cap — **30,000,000 bytes (~28.6 MiB)**, and nothing in this repo overrides
it — must be raised **for the PUT route only**, exactly as `Hosting/AdminApi.cs:809-829` does with
`IHttpMaxRequestBodySizeFeature`. Size the raise off `BlobMaxBytes`, not off the default.

## Eviction

### Hooks

Two teardown paths, and **both** are needed:

| Path | Hook | Covers |
| --- | --- | --- |
| Normal | `WebSocketHandler.CloseLobbyIfDark` (`:853-862`) | disconnect, reap, leave, kick — *"the single normal-teardown chokepoint"* |
| Forced | `LobbyCloser.Close` (`:51-68`) | admin action, game uninstall, authority-fatal |

`CloseLobbyIfDark` is `private` with four call sites; one line after `lobbies.Remove` releases the
lobby's handles, mirroring how `authorities.Stop(lobby.Id)` is already called there.

`LobbyCloser.OnClosing` is a **single `Action<string>`**, already bound to
`ServerAuthorityManager.Stop`. A second subscriber means promoting it to an `event` or composing
both at the wiring site in `Program.cs` — a small but real change, easy to miss.

### The two races

**1. Upload-then-register gap.** Bytes land before any handle references them, so refcount is 0 and
a sweep could delete them mid-flight. Claim a grace window **before the first byte is written**,
copying `GameAssetPrecompressor`'s `_seeded` pattern (`:51`, `:150-159`):

```csharp
// Claim the post-upload grace BEFORE writing anything, so a sweep that starts
// mid-upload can't delete what this call is still producing.
entry.GraceUntilTicks = now + GraceWindow.Ticks;    // default 5 minutes
```

The sweeper skips any entry inside its grace window regardless of refcount.

Two consequences to write down rather than discover in review:

- **An abandoned `PUT` pins a slot.** Because the grace is claimed before the first byte and keyed
  by the hash from the URL, a client can open a `PUT`, send nothing, and leave a grace-protected
  `_content` entry the sweeper skips for 5 minutes. It is bounded (one entry, no bytes, expires on
  its own) and hash verification still blocks poisoning, but cap concurrent in-flight uploads per
  lobby so it cannot be used to churn the table.
- **Claiming the grace is not the same as claiming the content.** The entry must be marked
  *provisional* until the rename succeeds, so a `GET` during the window 404s rather than serving a
  path that does not exist yet.

**2. Restart orphans everything.** Lobbies are an in-memory `ConcurrentDictionary` that dies with
the process (`Lobby\LobbyManager.cs:6`), and the ticket secret is regenerated per process
(`TokenService.cs:28`). So after a restart **every blob is orphaned by definition**.

Sweep the entire blob root at startup — the `SweepStaging()`-at-startup precedent
(`PackageManager.cs:913-928`, called once from `Program.cs:742`), which exists precisely because
startup *"is the only moment nothing can be using one."*

> This makes `blobs/` **regenerable**, which places it with `games-compressed`/`games-unpacked` in
> the `ContentPaths` taxonomy — so it must **not** be added to the ephemeral-mount warning list,
> which is the `persistentState` list at `Program.cs:154-168` (`Hosting/StatePersistence.cs` supplies
> only the `IsEphemeral` mechanism). `Program.cs:139-141` is explicit that warning about regenerable
> roots *"would train an operator to skim past the one line that matters."*

### Backstop sweeper

House pattern: a `System.Threading.Timer` in `Program.cs`, gated on a `> 0` config value, wrapped in
try/catch, disposed on `ApplicationStopping` (`Program.cs:754-764`). **There is no `IHostedService`
or `PeriodicTimer` anywhere in this server** — do not introduce one.

Copy three details from `AuthorityModuleCache.EvictIdle` (`:157-175`) verbatim:

1. **Refresh, don't skip**, the clock on in-use entries — *"Without the refresh, the busiest game on
   the server would be the first evicted."*
2. **Value-comparing removal** — `TryRemove(KeyValuePair)`, so a concurrent register that replaced
   the entry isn't clobbered.
3. **Mutable entry class**, so a touch doesn't allocate.

The one deliberate divergence: both existing caches only drop a dictionary entry and let the GC
decide. **This sweeper deletes files**, so the refcount is load-bearing rather than advisory, and
deletion must be ordered after the refcount hits zero *and* the grace window has expired.

## Limits

Every limit in this repo is configurable, portal-editable and validated. Match that.

| Key | Suggested default | Notes |
| --- | --- | --- |
| `KnockBox:BlobsEnabled` | `true` | master switch, like `precompressEnabled` |
| `KnockBox:BlobMaxBytes` | 100 MB | matches legacy's per-file cap |
| `KnockBox:BlobLobbyQuotaBytes` | 1 GB | matches legacy's per-room cap |
| `KnockBox:BlobTotalQuotaBytes` | **needs a real number (Q2)** | the word service caps per-file only, so N × cap is unbounded |
| `KnockBox:BlobGraceMinutes` | 5 | upload-before-register window |
| `KnockBox:BlobSweepSeconds` | 300 | 0 disables |
| `KnockBox:BlobsRoot` | `blobs` | see below |

**Q2 is genuinely open.** An aggregate cap is the difference between a bounded feature and a disk-
fill vector, and the existing word service is a cautionary example of shipping only a per-item cap.

## Files touched

### Server

| File | Change |
| --- | --- |
| **new** `Hosting\BlobApi.cs` | The routes, modelled on `AdminApi.UploadPackage` |
| **new** `Games\Blobs\BlobStore.cs` | The three maps, refcount, register/unregister/evict |
| **new** `Games\Blobs\IBlobStore.cs` | Interface, mirroring `IAuthorityWordService` |
| `Hosting\ContentPaths.cs` | **Seventh root** (there are six today). *Breaking:* `Resolved` is a positional record and `Resolve` a positional method, so all 8 constructing sites change (`Program.cs:35` plus 7 in tests). **Add it as a named `init` member, not a positional parameter** — `GamePackageExporterTests.cs:34` already passes the six positional args in the wrong order and compiles only because they are all `string`. |
| `Program.cs` | DI; route inside the games-origin `MapWhen`; `bootstrapDirs`; `writableDirs`; overlap guards; the startup roots log; startup sweep; sweeper timer |
| `Networking\ServerLimits.cs`, `OperatorLimits.cs`, `Admin\AdminSettings*.cs`, `Hosting\AdminApiModels.cs` | New limits, configurable **and** portal-editable **and** validated |
| `Networking\WebSocketHandler.cs` | One line in `CloseLobbyIfDark` |
| `Lobby\LobbyCloser.cs` | `OnClosing` → `event`, or compose in `Program.cs` |
| `Admin\DiskUsageReporter.cs` | `DirectoryBytes(paths.BlobsRoot)` on `Report` (~2 lines) |
| `Serialization\KnockBoxProtocolContext.cs` | **Mandatory** for any new JSON type — the project is `PublishAot=True` |
| `KnockBox.Contracts\Messages.cs` | Only if register/unregister go over the socket instead of HTTP |

**Estimate, in two parts — and the second is the one that sets the schedule:**

| | Cost |
| --- | --- |
| **Server** | 600–1,000 lines including tests. Architecturally low-risk: nothing in the relay changes, every primitive already exists, and every pattern is borrowed. |
| **Release coordination** | A multi-repo event. Client methods in 2–3 addons, a shared `sdkVersion` bump agreeing across four package manifests, `client-parity.test.js`, an `addons-v*` tag release, a server release to carry the API, then `npm run addon:update` here — plus a breaking `ContentPaths.Resolved` change touching 8 call sites. |

The lines are a week; the coordination is the risk. **This is the argument for starting phase 0
early rather than for finishing it first** — see `D2` in
[`00-decisions.md`](00-decisions.md#d2--blob-share-is-started-first-in-the-platform-repo). Phases 1–4
proceed against `IdbBlobTransport` regardless.

### Tests

Flat in `KnockBox.Server.Tests\`, xUnit, `<Subject>Tests.cs`, GUID temp dir in the ctor with a
best-effort recursive delete in `Dispose`, sentence-style test names.

| File | Covers |
| --- | --- |
| **new** `BlobStoreTests.cs` | refcount semantics, **R6 duplicate-handle case**, idempotent register, grace window, eviction |
| **new** `BlobApiTests.cs` | the three auth checks, cap enforcement mid-stream, hash mismatch, HEAD/PUT/GET |
| `ContentPathsTests.cs` | all three existing cases must assert the new root |
| `LobbyCloserTests.cs` | blobs released on both teardown paths |

The R6 test is the one to write first, since it is the requirement most easily broken:

```csharp
[Fact]
public void Two_logical_ids_in_one_lobby_are_released_independently()
{
    store.Register("L1", "map-a", hash);
    store.Register("L1", "map-b", hash);      // same bytes, different logical id
    store.Unregister("L1", "map-b");
    Assert.True(File.Exists(store.PathOf(hash)));   // "map-a" still holds it
    store.ReleaseLobby("L1");
    Assert.False(File.Exists(store.PathOf(hash)));
}
```

Borrow `AuthorityModuleCacheTests`' two techniques: a `MutableTimeProvider` so grace and idle
windows are *driven* rather than slept through, and proving cache behaviour **behaviourally** rather
than by counter.

### Client addon — the expensive half

Addons are released **independently of the server** (*"an addon release does not force a server
release, or the reverse"*) and indexed with SHA-256 in `.addons/ADDONS.json`, which is *"the trust
root for every addon install"*. But they are **not independent of each other**: there are **three**
addons — phaser, web, godot — plus the `tools/pack-game` CLI, all covered by **one shared
`sdkVersion`** (currently `1.1.1`), which `AddonManifestTests.cs` enforces across four version
files. There is no such thing as a phaser-only bump.

A server API that games are meant to call needs a coordinated release:

1. **Add the client method.** The files that matter, in two groups:

   | Group | Files | Why |
   | --- | --- | --- |
   | Public surface | `clients/phaser/knockbox-plugin.js`, `web/knockbox.js`, `clients/godot/.../kb_net.gd`, `knockbox-phaser.d.ts` | where `registerBlob` etc. are exposed |
   | **Protocol cores** | `web/kb-protocol.js`, `clients/phaser/kb-core.js`, `clients/godot/.../kb_core.gd` | **`client-parity.test.js` compares exactly these three by declared name** — a change touching fewer than all three either fails that test or silently skips a client |
   | Local peer | `knockbox-local.js` | the server-less peer; **the port's `?kbLocal=tab` loop depends on it** |

   Since the port carries its own `IdbBlobTransport`, the local peer is the one that could be
   skipped — but skipping it means `npm run dev` diverges from production, which is the failure
   class `addons.smoke.test.ts` exists to catch.

2. **Defer Godot deliberately, don't chase parity.** The Godot addon already lacks the owner
   contract entirely (`kb_net.gd` declares only `session_ready`, `message_received`,
   `player_joined`, `player_left`, `closed`, `resumed`), and `client-parity.test.js` carries an
   explicit debt list, `KNOWN_GODOT_GAPS`, whose final test fails if a gap is closed without being
   removed from the list. So the sanctioned move is: ship phaser + web, add the blob names to
   `KNOWN_GODOT_GAPS`, and cut this step from three languages to two.
3. **Bump `sdkVersion`** in `clients/addons.manifest.json`. `AddonManifestTests.cs` enforces that it
   agrees with `clients/phaser/package.json`, `clients/godot/…/plugin.cfg`, `web/package.json` and
   `tools/pack-game/package.json` — and it *throws* on a version file in an unrecognised format, by
   design.
4. **Set the addon's `minAppVersion`** to the server version that ships the API. (This is the
   per-addon field in `addons.manifest.json` / `ADDONS.json`, validated by
   `PluginUpdateEvaluator.cs:151-154` against `KnockBoxVersion` — not the game manifest's field. An
   unparseable bound counts as *incompatible*.)
5. Satisfy `web/__tests__/client-parity.test.js`.
6. Run the `addons-v*` release (`.github/workflows/ci.yml`, triggered on the `addons-v*` tag).

**The game's own `minAppVersion` matters too.** Once this port depends on the blob API, raise
`export/GAME.json`'s `minAppVersion` to the server version that ships it — otherwise the `.kbg`
installs happily onto a server that cannot serve its art. See
[`11`](11-verification.md#pre-release).

Then this repo picks it up with `npm run addon:update` — **never** by hand-editing `addons/`, which
is hash-verified.

### Proposed client API

```ts
interface KnockBoxPlugin {
  /** Upload if needed (skipped when the server already has the bytes) and
   *  register under a session-local id. Returns a URL for <img>/Phaser. */
  registerBlob(logicalId: string, blob: Blob): Promise<string>;

  /** Optional (R5). Lobby close releases everything anyway. */
  unregisterBlob(logicalId: string): Promise<void>;

  /** URL for an already-registered id, or null. */
  blobUrl(logicalId: string): string | null;
}
```

`registerBlob` hides hashing, the `HEAD` probe, upload and registration — satisfying R6 at the API
surface, not just internally. The game never sees a hash.

## Local emulation

There is no server in `solo` or `local-tab` mode, so blobs need a local stand-in. This has to be
designed rather than improvised, because **the obvious approach silently doesn't work**.

### The trap: `blob:` URLs do not cross tabs

`URL.createObjectURL` is fine in `solo` mode — one client, one document, and the DM already has the
bytes. It is **wrong for `local-tab`**. A `blob:` URL is scoped to the document that created it: it
is revoked when that document unloads, and cross-document access is unreliable and actively being
tightened by browsers. Tab A's blob URL will not resolve in tab B.

Since `?kbLocal=tab` with two tabs is the primary development loop for this port, an emulation that
only works in `solo` would hide every multiplayer asset bug until platform testing.

### The stand-in: IndexedDB *is* the local disk

Same-origin tabs share IndexedDB, it is disk-backed, and it is trivially content-addressable. It
emulates the server's storage model closely enough to reproduce real bugs:

```
DB "knockbox-local-blobs"          ← ephemeral; stands in for the SERVER's disk
  store "blobs"    key = sha256           value = Blob
  store "handles"  key = [lobbyId, logicalId]  value = { sha256 }
```

| Server behaviour | Local equivalent |
| --- | --- |
| Content-addressed file on disk (R2) | `blobs` keyed by sha256 |
| Logical id → hash indirection (R3) | `handles` keyed by `[lobbyId, logicalId]` |
| Refcount = live handle count (R6) | count `handles` entries for a hash |
| `HEAD` probe skips upload | `blobs.count(hash)` |
| Constant server memory (R1) | *Not emulated* — see below |
| Startup sweep after restart | Clear both stores on becoming the elected peer with no other peers present |

That last row is a genuinely faithful detail. The server sweeps its blob root at startup because
lobbies are in-memory and die with the process; the local harness should clear these stores for
exactly the same reason, and it keeps repeated `npm run dev` sessions from accumulating garbage.

> **"When the first tab starts" needs a mechanism, and there is one — use it.** `local-tab` mode
> already elects a peer over `BroadcastChannel`, and index 0 is the elected host on every transport
> (`knockbox-local.js`). Clear the stores **when this peer becomes the elected host and the roster
> contains only itself** — not merely on load.
>
> The naive version has a real race: two tabs opening together can both believe they are first, and
> the loser's clear can wipe the winner's freshly-uploaded blobs, producing placeholders that look
> exactly like a forgotten `publish()`. Since diagnosing that is the whole point of the
> `publish()` check in [`11`](11-verification.md#the-asset-check-that-must-not-be-skipped), a
> false positive here is expensive.

**R1 is deliberately not emulated.** There is no shared server to protect, and browsers do not
expose a streaming write to IndexedDB anyway. What must be faithful locally is the **API shape and
the lifetime semantics**, not the storage strategy.

### Keep it separate from the DM's library — this is the important part

The port already has an IndexedDB store: the DM's campaign library
(see [`08-assets-pipeline.md`](08-assets-pipeline.md)). **The emulated blob store must be a
different database, and `resolve()` must never fall back to the library.**

If they were merged, or if resolution fell through to the library, every client would find every
image the DM had locally — and **a forgotten `publish()` call would work perfectly in development
and fail only in production.** That is the single worst bug this emulation could hide.

Keeping them separate means `publish()` is genuinely load-bearing locally: skip it, and the other
tab shows the dashed placeholder, exactly as a real player would.

| Database | Lifetime | Contents |
| --- | --- | --- |
| `DnDMapper` | Persistent — the DM's campaign | Slots, maps, sheets, **the DM's own image bytes** |
| `knockbox-local-blobs` | Ephemeral — cleared at first-tab startup | Stands in for the server's disk |

### Don't block the port on the addon release

The addon changes in the previous section are a multi-repo release event. The port should not wait
on them. Put the seam **inside this repo**, under `AssetSource`:

```ts
// src/assets/blobTransport.ts
export interface BlobTransport {
  has(sha256: string): Promise<boolean>;
  put(sha256: string, blob: Blob): Promise<void>;
  register(logicalId: string, sha256: string): Promise<void>;
  unregister(logicalId: string): Promise<void>;

  /** The handle lookup: logicalId → hash, or null if this client holds no handle.
   *  Without this, `AssetSource.resolve(imageId)` has no way to reach a hash —
   *  `register` writes the mapping and nothing could read it back. */
  hashFor(logicalId: string): Promise<string | null>;

  /** ASYNC on purpose: locally this reads the Blob out of IndexedDB before it can
   *  mint an object URL, so a synchronous signature is unimplementable. */
  urlFor(sha256: string): Promise<string>;
}
```

| Implementation | Used when |
| --- | --- |
| `IdbBlobTransport` | `solo` and `local-tab` — the IndexedDB store above |
| `HttpBlobTransport` | `platform` — `HEAD`/`PUT`/`POST` against the real API |
| `KbBlobTransport` | later: delegates to `knockbox.registerBlob` once the addon ships |

`BlobShareAssetSource` is written once against `BlobTransport`, so phases 1–4 proceed against
`IdbBlobTransport` and the real one drops in when phase 0 lands. Choose by launch mode, alongside
the existing `detectLaunch()` switch in `src/net/knockboxPlugin.ts`.

> Note `urlFor` resolves to a string in both cases — `/blob/{hash}` on the platform (available
> immediately, but keep the signature uniform), and a per-document `blob:` URL minted from the
> IndexedDB record locally. Phaser's loader takes either. Revoke the local ones after the texture
> uploads, per [`08`](08-assets-pipeline.md).

### Testing it

Refcount and R6 bugs should be reproducible in Vitest, not only against a running server. Because
`IdbBlobTransport` implements the same semantics, the R6 case can be asserted in-process with
`fake-indexeddb`, or against `happy-dom` (already a dev dependency, currently unwired).

The `local-tab` path additionally needs one manual check that no unit test replaces: **two tabs, DM
adds an image, the player tab shows it** — and, just as importantly, that commenting out `publish()`
makes the player tab show a placeholder instead.

If the addon route is taken later, `knockbox-local.js` must implement `registerBlob` too, or
`npm run dev` diverges from production — the class of failure `addons.smoke.test.ts` exists to catch.
