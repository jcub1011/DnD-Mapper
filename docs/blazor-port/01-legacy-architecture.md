# 01 — Legacy Architecture

How `KnockBox.DndMapper` actually works. Paths are relative to
`…\KnockBox\host\KnockBox.DndMapper`.

## Shape of the thing

A **Razor Class Library** (`net10.0`), loaded as a plugin into the KnockBox ASP.NET host, running
as **Blazor Server over SignalR with prerendering disabled**:

```csharp
// KnockBox\Components\App.razor:45
private static readonly InteractiveServerRenderMode InteractiveServer = new(prerender: false);
```

**That single line explains most of the architecture.** Every pointer event that would otherwise
round-trip over SignalR was pushed into hand-written JS modules that call back into .NET only at
*gesture end*. Roughly half the JavaScript in this plugin exists solely to dodge that latency, and
**most of it evaporates in Phaser.**

Only NuGet dependency: `Markdig` 0.42.0 (character-sheet notes). Everything else is framework.
The plugin loads into its own `AssemblyLoadContext`, which is why two custom MSBuild targets stage
`Markdig.dll` into the plugin folder.

### Size

| Type | Lines |
| --- | ---: |
| `.cs` | 18,311 |
| `.razor` | 5,128 |
| `.css` | 5,292 |
| `.js` | 3,191 |
| **Total first-party** | **31,922** |
| *(vendored `dice-box.es.js`)* | *17,248* |

| Area | Lines | Notes |
| --- | ---: | --- |
| `Pages/Components/` | 14,603 | 32 `.razor` files (13,382 of it top-level; the rest under `LoadedDice/` and `Shared/`) |
| `Services/Library/` | 4,290 | persistence + `.vtf` (777 of it under `Vtf/`) |
| `wwwroot/js/` | 3,191 | 19 interop modules |
| `Pages/` | 2,141 | 4 pages, only 2 routable |
| `Helpers/` | 1,432 | 19 static classes across 21 files (two are records) |
| `Services/Logic`, `State`, `Storage` | ~4,400 | engine + state + records |

Largest single files, i.e. the porting hot spots:

| Lines | File |
| ---: | --- |
| 3,703 | `Services/Logic/Games/DndMapperGameEngine.cs` |
| 2,910 | `Services/Library/DndMapperLibraryService.cs` |
| 1,319 | `Pages/Components/MapCanvas.razor.cs` |
| 634 | `wwwroot/css/panels.css` |
| 610 | `Pages/Components/CharacterSheetPanel.razor.cs` |
| 599 | `Services/Library/Vtf/VtfPackager.cs` |
| 510 | `Services/Library/LibrarySnapshot.cs` |
| 493 | `wwwroot/js/dndMapperImageDrag.js` |
| 461 | `wwwroot/js/dndMapperViewport.js` |

## Routing and pages

Only two `@page` directives in the whole plugin:

- `Pages/DndMapperRoom.razor:1` → `/room/dnd-mapper/{ObfuscatedRoomCode}` — the entry point.
  Inherits `LobbyPageBase<DndMapperGameState>`; the base picks Lobby vs Playing and renders
  `DndMapperLobby` or `DndMapperPlayingPhase`.
- `Pages/DndMapperDisplay.razor:1` → `…/display` — read-only projector view.

There is **no client-side router inside the plugin**. Phase switching is a conditional render.

`DndMapperPlayingPhase` is the app shell: a three-column layout with a host-only left rail, a
`<main class="dndm-canvas-area">`, and a right rail. It owns rail resize/collapse, the unload
guard, clipboard access, host-key streaming, and library attach/hydrate. It cascades
`DndMapperViewport` and `DndMapperToastService` down the tree.

## Rendering — the critical section

### Three stacked layers, three technologies

From `MapCanvas.razor:74-110`:

```
.dndm-canvas-stage                     overflow:hidden, clips
├── <canvas class="dndm-bitmap-canvas">          z-index 0
│     viewport-sized, NEVER CSS-transformed. Map images drawn here.
└── .dndm-canvas-transform                        z-index 1
    │   transform-origin 50% 50%; size = W*cellPx × H*cellPx
    ├── .dndm-grid-background          grid = two CSS linear-gradients + inset box-shadow
    └── <svg viewBox="0 0 W H" overflow="visible">
          ├── transparent hit-rect
          ├── <g class="dndm-image-pickers">   invisible rects: hit-test + selection only
          ├── markup            (MarkupString of saved SVG)
          ├── fog               <path fill-rule="evenodd">
          ├── focus rect
          ├── ruler overlay
          ├── <TokenLayer>
          └── image resize/rotate handles
```

The split is **not** a design preference — it is a compositor workaround. The header comment on
`dndMapperBitmapCanvas.js` records why: an earlier model CSS-scaled a layer of `<img>` elements,
and at high zoom the compositor's backing store exceeded the GPU's max texture size and fell back
to software raster. **Phaser sidesteps this natively, and the three layers collapse into one scene.**

### The coordinate system — memorize this

- The SVG `viewBox` is `0 0 WidthCells HeightCells`. **1 SVG user unit = 1 grid cell.**
- All token, image and fog geometry — in the DOM *and* in C# *and* in `.vtf` — is in **cell units**.
- `GridConfig.CellPixels` (default 50) converts cells → CSS px.
- **Tokens sit at cell centres** (`x.5`, `y.5`). **Images are corner-anchored** at whole cells.
- Client → world conversion is always `createSVGPoint` + `getScreenCTM().inverse()`, via
  `dndMapperSvgMetrics.js::clientToSvgPoint`. Every gesture module uses it.

### Pan and zoom — `wwwroot/js/dndMapperViewport.js` (461 lines)

State per SVG id: `{ panX, panY, zoom, basePxPerCell }` plus in-flight gesture deltas.

```js
function applyTransform(state) {
    const { panX, panY, zoom } = combinedViewport(state);
    const tx = base * (W * (zoom - 1) / 2 - zoom * panX);
    const ty = base * (H * (zoom - 1) / 2 - zoom * panY);
    state.wrapper.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`;
    state.wrapper.style.setProperty('--dndm-inv-zoom', String(1 / zoom));
    // …rewrite [data-dndm-screenpx] nodes' literal scale…
    state.bitmapCanvasModule.setViewport(state.canvasId, panX, panY, zoom, base);
}
```

- **`panX`/`panY` is the world cell coordinate at the stage's top-left.**
- `MIN_ZOOM = 0.01`, `MAX_ZOOM = 10.0`.
- **Pan is deliberately unbounded.** The file header explicitly warns against reintroducing
  clamping — hosts scroll past the map edge to reach off-map notes.
- Wheel zoom: ×1.1 per notch, **cursor-anchored**. Toolbar ±: ×1.25 (applied from C#,
  `MapCanvas.razor.cs:905-906`), anchored at the *rail-aware* visible centre, because the rails
  overlay the canvas: `anchorX = (stageRect.width + leftPx - rightPx) / 2` — which lives in
  `dndMapperSvgMetrics.js::getStageAnchor`, not in the viewport module.
- Commit is debounced (`WHEEL_COMMIT_DEBOUNCE_MS = 140`), then invokes
  `OnViewportChanged(panX, panY, zoom, centerX, centerY, wasClickWithoutDrag)`.
- `CLICK_DEAD_ZONE_PX = 3` separates click-to-deselect from a pan drag.
- A `BAIL_SELECTOR` (`[data-token-id]`, picker rects, handles) keeps pan from stealing those
  gestures.
- Exports: `initialize, setMode, zoomByFactorAtCenter, setViewBox, centerOnWorld, setBounds,
  forceBeginPan, reassertViewBox, dispose`.

### The bitmap render loop — `wwwroot/js/dndMapperBitmapCanvas.js` (306 lines)

The "Canvas Viewport Method", and it maps almost 1:1 onto a Phaser camera:

```js
const pxPerCell   = state.cellPx * state.zoom;
const worldOriginX = -state.panX * pxPerCell;
const worldOriginY = -state.panY * pxPerCell;
const sorted = state.images.slice().sort((a, b) => a.layerOrder - b.layerOrder);
for (const img of sorted) {
    const screenX = worldOriginX + ix * pxPerCell;
    // conservative circumscribed-circle cull vs canvas rect
    ctx.save(); ctx.globalAlpha = opacity;
    ctx.translate(cx, cy);
    if (irot !== 0) ctx.rotate(irot * Math.PI / 180);
    ctx.drawImage(bm, -screenW / 2, -screenH / 2, screenW, screenH);
    ctx.restore();
}
```

**The formula to carry over:** `stage_px = (world_cells − pan) × cellPx × zoom`.

Other details worth keeping:

- Redraw is **dirty-flag + `requestAnimationFrame`**, not a continuous loop.
- Backing store is sized to `stageRect × devicePixelRatio`; a `ResizeObserver` marks dirty.
- Textures: `fetch → blob → createImageBitmap`, cached with `'loading'`/`'failed'` sentinels,
  evicted with `bm.close()`.
- `state.inFlight` lets a drag override one image's transform per frame with no .NET round-trip.
- A missing bitmap draws a dashed placeholder (`rgba(80,75,68,0.5)` fill,
  `rgba(196,116,56,0.6)` dashed stroke) rather than nothing.

### The display view renders differently again

`DndMapperDisplay.razor` is **pure SVG, no canvas** — `<image href="/blob-share/{token}">` per
image, grid as a `<pattern>` with `stroke-width="0.025"` in cell units, tokens as `<g>` positioned
by `dndMapperDisplayTokens.js` using the **Web Animations API** (250 ms ease-out) rather than CSS
transitions, because CSS transitions on SVG attributes were being interrupted by the host tab's
IndexedDB work on the main thread. Its `viewBox` is the `FocusRect` when set, else the whole map.

## JS interop inventory

19 modules, 3,191 lines, imported as `./_content/KnockBox.DndMapper/js/{file}.js`. Each keeps a
module-scope `instances = new Map()` keyed by SVG/canvas id and tears down with `AbortController`.

| Module | Lines | Fate in the port |
| --- | ---: | --- |
| `dndMapperViewport.js` | 461 | **Evaporates** → Phaser camera |
| `dndMapperImageDrag.js` | 493 | **Evaporates** → Phaser drag input |
| `dndMapperBitmapCanvas.js` | 306 | **Evaporates** → Phaser display list |
| `dndMapperTokenDrag.js` | 253 | **Evaporates** → Phaser drag input |
| `dndMapperFocusDrag.js` | 143 | **Evaporates** → Phaser pointer handling |
| `dndMapperSvgMetrics.js` | 103 | **Evaporates** → `camera.getWorldPoint()` |
| `dndMapperFogPaint.js` | 147 | Mostly evaporates; keep the stroke-accumulation idea |
| `dndMapperVtfPackager.js` | 282 | **Port nearly as-is** (browser ZIP writer) |
| `dndMapperImageDownscale.js` + worker | 243 | **Port as-is** (same GPU limits apply) |
| `dndMapperDiceBox.js` | 198 | Port when dice phase arrives |
| `dndMapperRailResize.js` | 153 | Port to Lit/CSS |
| `dndMapperHostInput.js` | 138 | Port (loaded-dice phase) |
| `dndMapperDisplayTokens.js` | 121 | Port if display view survives (Q3) |
| `dndMapperPanelCollapse.js` | 50 | Port to Lit |
| `dndMapperClipboard.js` | 18 | Trivial |
| `dndMapperFileDownload.js` | 17 | Trivial |
| `dndMapperUnloadGuard.js` | 23 | Trivial |
| `dndMapperDisplayImageFallback.js` | 42 | Trivial |

**~1,760 of these 3,191 lines simply disappear** (the rows marked *evaporates*), plus most of
`dndMapperFogPaint.js`'s 147.

### The JS→C# callback surface

| Method | Signature |
| --- | --- |
| `OnViewportChanged` | `(panX, panY, zoom, centerX, centerY, wasClickWithoutDrag)` |
| `ApplyFogStroke` | `(int[] xs, int[] ys, bool fogged)` — the **whole stroke** at pointer-up |
| `CommitFocusRect` | `(x, y, w, h)` |
| `OnImageDragEnd` | `(imageId, kind, orig…, new…, snapBypass, freeAspect)` |
| `OnTokenDragEnd` | `(tokenIdStr, x, y)` |
| `OnHostKeysChanged` | `(string[] keys)` |
| `OnRailResize` / `OnRailToggleCollapse` | `(side, px, persist)` / `(side)` |
| `OnRollSettled` | `(string boxKey, Guid rollId)` — dice only, phase 6+ |

Note the shape: **one call per completed gesture, never per pointer-move.** That was the SignalR
tax — but keep the shape anyway, because on this platform the penalty is harsher, not softer.

An intent is a client→server message against a **30/s sustained, 60 burst** budget whose overage is
a **terminal 1008 close that no SDK reconnects from** ([`02`](02-target-platform.md#rate-limiting)).
A single 60 Hz drag would exceed it in one second and kill the player's session until the iframe is
rebuilt. So: **never send an intent per pointer-move** — not for fog, not for token drags, not for
image resize. Accumulate locally, render optimistically where it matters, and commit once at
gesture end, exactly as legacy did for a different reason.

## Interaction reference

### Mouse

| Gesture | Behaviour |
| --- | --- |
| Left-drag background | Pan (blocked when a tool is armed unless Space held) |
| Middle-drag anywhere | Always pans; pickers forward via `forceBeginPan` |
| Wheel | Cursor-anchored zoom, ×1.1 |
| Left-click background, no drag | Deselect the selected image |
| Left-click image picker | Select (one SignalR round-trip) |
| Left-drag image body/handle | Move / resize (4 corners) / rotate — one commit at mouseup |
| Left-drag token | Move, clamped to `[0,W]×[0,H]` |
| Click collapsed token stack | Expand into a fan of chips with a leader line |
| Double-click token or chip | Open its character sheet in the right rail |
| Right-click canvas (host) | Context menu: "Cell x, y" + **"⊙ Centre everyone here"** |
| Right-click while ruler active | Clears both ruler points instead of opening the menu |
| Touch | Single-touch drag for tokens and images only. **No pinch-zoom — and no touch pan or zoom at all:** `dndMapperViewport.js` binds only `wheel` and the `mouse*` events. Legacy is effectively unusable on a tablet, so exact fidelity here is a bug to fix, not a behaviour to keep (see [`07`](07-ui-shell.md#accessibility-and-input-notes)). |

"Centre everyone here" broadcasts a `CenterViewportRequest` with a fresh nonce; every client's
`centerOnWorld` fires. The nonce is what makes a repeat request to the same cell still take effect.

### Keyboard

| Key | Effect |
| --- | --- |
| **Space (hold)** | Forces JS mode to `'none'` so left-drag pans even with a tool armed; also flips markup to pass-through and disables image pickers |
| **Ctrl (during drag)** | Bypass grid snap |
| **Shift (during resize)** | Free aspect ratio (default preserves) |
| **Shift / Ctrl at roll-click** | Advantage / Disadvantage |
| **Any key (host)** | Streamed to the server for loaded-dice `HostKeyHeld` conditions; `" "` normalises to `"Space"`, and `blur` clears the set |

There are **no other hotkeys** — no delete key, no arrow nudging, no undo/redo.

### Tool modes — a mutually exclusive state machine

```csharp
// MapCanvas.CurrentJsMode()
if (_spaceHeld)         return "none";
if (_markupActive)      return "markup";
if (_focusActive)       return "focus";
if (IsFogPaintActive)   return "fog";
if (_rulerActive)       return "ruler";
return "none";
```

Entering any tool clears the others (`ExitOtherCanvasTools`). While a tool is active, image
pickers, handles and the token layer all flip to `pointer-events:none`.

**Toolbar** (`MapCanvas.razor:14-72`): `[✓] Grid` · `−` · `NNN%` · `+` · `⟲ Reset view`, then
host-only: `✎ markup` · `▭ focus box` · `✕ clear focus` · `📐 ruler` · `▒ paint fog` ·
`◌ erase fog` · `[1-3] brush` · `▣ fill all fog` · `◻ clear all fog` (last two confirm first).

### Tool details

- **Fog paint** — brush radius 1–3, cycled by a button. `beginStroke` appends a client-only preview
  `<g class="dndm-fog-preview">` that Blazor's diff never sees, accumulates a `Set` of `"cx,cy"`
  keys on pointermove, and sends the entire stroke at pointerup as two int arrays. Paint preview
  `#000 @ 0.45`; erase preview `#e89055 @ 0.35`.
  **Host sees fog at 0.45 opacity, players at 1.0.**
- **Focus box** — drag a rect, snapped with `floor`/`ceil` when snapping is on. Becomes the display
  view's `viewBox`.
- **Ruler** — pure C#/SVG, no JS module. Click A, click B, further clicks move B, right-click
  clears. Label: `"{cheb} sq · {euc:0.0} actual · {ft} ft"` — **Chebyshev distance for 5e**,
  Euclidean shown for reference, ×5 ft per square. Endpoint dots and the label live in
  `[data-dndm-screenpx]` groups the viewport rewrites per frame with `scale(1/(cellPx*zoom))` so
  they stay a constant size on screen.
- **Markup** — resets the view first (the drawing surface uses a fixed viewBox), then wraps the
  serialized SVG in `<g transform="scale(1/CellPixels)">` into `Map.MarkupSvg`.

### Snapping — `Helpers/SnapToGridHelper.cs`

```csharp
Snap(x, y, grid)        // tokens → cell CENTRE: Math.Round(x - 0.5) + 0.5,
                        //          clamped to [0.5, W - 0.5]
SnapCorner(x, y, grid)  // images → Math.Round(x), NO clamping (images may sit off-map)
```

Resize snaps *both* the anchor corner and the drag corner, then recomputes W/H. Minimum dimension
`0.1` cells.

### Rails

Drag `.dndm-rail-resize` to resize (200–600 px, persisted per side and per role in
**`sessionStorage`**, under `dndm.rail.{role}.{side}`); click without dragging toggles collapse.
The module says why: *"Rail widths are a non-critical, per-tab UI preference … Trade-off: widths
reset when a new browser session starts."* That is a deliberate choice, not an oversight — carry it
across, or record the deviation. Panel headers collapse their own panel, skipping clicks that
landed on interactive descendants.

## State and services

**Server-authoritative**, with no optimistic client state beyond transient gesture previews:

```
Browser ──SignalR──▶ circuit ──▶ DndMapperGameEngine ──Execute(lock)──▶ DndMapperGameState
                                                              │
    all subscribed circuits ◀── StateChangedEventManager ──────┘
```

`DndMapperGameEngine` (3,703 lines) exposes **85 public methods** (86 public members counting the
constructor; one is a `CreateStateAsync` override, so ~84 domain verbs), each taking
`(state, caller, …)` and returning `Result`/`ValueResult<T>`. Groups: map CRUD (create/rename/delete/duplicate/reorder/
setActive/updateGrid), token CRUD, sheet CRUD, schema/templates, settings, loaded dice, viewport
(`RequestCenterViewportAsync`, `SetFocusRect`, `ClearFocusRect`), initiative/combat (11 verbs),
markup, status effects, roll templates, `RollAsync`, session, images, and fog (`PaintFogAsync`,
`RevealCellsAsync`, `HideCellsAsync`, `FillMapWithFogAsync`, `ClearAllFogAsync`).

**These ~84 verbs are the real product.** They encode every permission check, cap, and rule. This is
the ~3,700 lines that cannot be shortcut — see [`06-state-and-authority.md`](06-state-and-authority.md).

All mutation goes through `state.Execute(Action)` (a lock) and fires one change notification after
release. Reads use `state.WithExclusiveRead(...)`.

### DI services (all scoped per SignalR circuit)

| Service | Role |
| --- | --- |
| `DndMapperGameEngine` | The only mutator |
| `DndMapperLibraryService` | 2,910 lines: IndexedDB, blob cache, share tokens, debounced auto-save, slot CRUD, `.vtf` |
| `DndMapperStorage` | Route-scoped localStorage wrapper |
| `TokenFocusService` | `event Func<Guid, ValueTask> Focused` — panel → canvas "recentre on this token" |
| `IFogPaintContext` | `{ Mode, BrushRadius 1..3, event Changed }` shared by toolbar and canvas |
| `IDiceAnimationTracker` | Rolls whose 3D dice are still tumbling; gates roll-log and initiative reveal |

Cascaded rather than injected — and there are only **two**: `DndMapperViewport` (mutable
`{CenterX, CenterY, MapId}`, written by the canvas, read by the token panel as the spawn anchor) and
`DndMapperToastService`, both `IsFixed="true"` on `DndMapperPlayingPhase`. `DiceRollerConfig` looks
like a third but is not: it is a plain field on `DndMapperPlayingPhase` passed down as
`[Parameter, EditorRequired]`.

### Persistence

1. **IndexedDB** — `KnockBox.DndMapper` v3, host-browser only. Stores `library` (JSON),
   `slots_index` (JSON), `images` (Blob). Slot keys shard as `{slotId}:core`,
   `{slotId}:map:{mapId}`, `{slotId}:sheet:{sheetId}`; a bare `{slotId}` is the pre-sharding blob
   kept only as a migration source for `LoadSlotAsync`. Note **two independent version numbers**:
   the IndexedDB `CurrentVersion` is 3, while `LibraryCoreSnapshot.SchemaVersion` — the shard
   layout — is 4. Don't conflate them. `__auto__` is the reserved auto-save slot ("Auto Save"), which cannot
   be renamed or deleted.
   - **Debounced auto-save**, 500 ms quiet period.
   - A `PersistedFingerprint` of nine object *references* short-circuits when nothing persisted
     changed — a dice roll appends to `RollLog`, which isn't persisted, so it writes nothing.
   - **Per-shard SHA-256 caching**: moving a token on map A rewrites only `__auto__:map:{A}` and
     `__auto__:core`.
   - `SemaphoreSlim` serializes flushes; `_pendingDirty` re-arms the timer if an edit lands
     mid-flush; a `beforeunload` guard is active while saving.
2. **sessionStorage** — rail widths (per tab, by design; see Rails above).
   **localStorage** — host permission-panel defaults.
3. **Blob sharing** — the host's browser owns the image bytes. The host's circuit publishes a
   per-image `ShareToken` (a Guid); players and the display fetch `/blob-share/{token}`, which pulls
   the bytes from the *host's* browser over the host's circuit. The host itself uses a local
   `blob:` URL to avoid a pointless round-trip. **This is the mechanism that does not exist for
   KnockBox games** — see [`09-blob-share-server-spec.md`](09-blob-share-server-spec.md).

   > **Note the path.** The plugin only *consumes* this: the endpoint itself is platform SDK code —
   > `sdk/KnockBox.Platform/Services/Storage/IndexedDb/BlobShareEndpoint.cs:49`
   > (`MapGet("/blob-share/{token:guid}", …)`), wired from `host/KnockBox/Program.cs:142`, with
   > `BlobShareRegistry`, `BlobShareByteCache` and `IndexedDbBlobImpl` beside it. So it is outside
   > the source tree this document covers, and there is even less to "port" than it looks: the whole
   > mechanism has to be replaced, not translated.
4. **No server-side database or filesystem storage at all.**

**Deliberate persistence omissions:** `Token.OwnerUserId` / `RepresentsUserId`,
`CharacterSheet.OwnerUserId`, `MapImage.ShareToken`, `FocusRect`, `HostHeldKeys`, `RollLog`, and
`CombatState` (except inside `.vtf`). User ids are per-session, so tokens rehydrate as `NPCToken`
with no owner and the host reassigns them.

### Image upload pipeline

`ImageUploadButton` → `AdoptInputElementFilesAsync` (bytes go browser→IndexedDB directly, never
through SignalR) → `probeMaxTextureSize()` (WebGL2 `MAX_TEXTURE_SIZE`, clamped to 8192) →
`decodeAndMaybeDownscale` in a **Web Worker with OffscreenCanvas**, re-encoding oversize art to
**WebP q=0.92** and overwriting the IDB row → `Engine.AddImageAsync` with metadata only.
Caps: 100 MB/file, 1 GB/room, MIME `image/png|jpeg|webp`.

## Styling

Hand-written CSS. **No Bootstrap, no MudBlazor, no Tailwind.** Blazor scoped CSS per component plus
one shared global sheet, `wwwroot/css/panels.css` (634 lines).

Theme is **"Forge & Ember"** — charcoal and blackened iron with copper accents, all as custom
properties on `panels.css`'s `:root`. The nine load-bearing colours:

```css
--dndm-bg-deep: #0c0a08;   --dndm-bg-panel: #191512;  --dndm-border: #3a2d23;
--dndm-text:    #ece0cc;   --dndm-ember:    #c4743a;  --dndm-ember-hi: #e89055;
--dndm-void:    #07060a;   --dndm-danger:   #b04a3a;  --dndm-success:  #6a8a52;
```

**That block is not the whole set — copy the `:root` rule, not this excerpt.** It also defines
`--dndm-bg-panel-2`, `--dndm-border-strong`, `--dndm-border-accent`, `--dndm-text-dim`,
`--dndm-text-muted`, and `--dndm-display` (the font stack
`"Cormorant Garamond", "EB Garamond", Georgia, serif`; no font files ship with the plugin), plus
`--dndm-noise` (an inline SVG `feTurbulence` data-URI), `--dndm-panel-gradient` and
`--dndm-panel-vignette`.

Runtime variables driving layout, and where each is actually set:

| Variable | Set by |
| --- | --- |
| `--dndm-rail-w-left` / `-right` | `Pages/DndMapperPlayingPhase.razor.css:2-3` (defaults 280/320 px), rewritten from `DndMapperPlayingPhase.razor.cs:75` — **not** in `panels.css` |
| `--dndm-cell-px`, `--dndm-grid-line` | inline on `.dndm-canvas-transform`, `MapCanvas.razor:99-100` |
| `--dndm-inv-zoom` | JS, rewritten every frame by `dndMapperViewport.js` |

**All icons are inline SVG paths in Razor markup** — no icon font, no sprite sheet.
`Helpers/TokenIcons.cs` emits eye / eye-slash / token glyphs as `MarkupString`.

Dice assets: 38 `.webp` textures and **75** `.mp3` sounds under `wwwroot/dice/`
(`sounds/dicehit/` 45 + `sounds/surfaces/` 30).

## What is deliberately *not* modelled

There are **no walls, no line-of-sight or vision, no lights, no doors, no dynamic lighting, no
measurement templates, no sound emitters, no hex grids, no elevation, and no token sizes larger
than one cell.** Fog of war is a purely manual, host-painted cell bitmask.

This matters twice: it keeps the port smaller than a general VTT would be, and it means there is no
legacy schema to honour if any of those are added later — `Map` gains new fields cleanly.
