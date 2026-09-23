# 05 — Rendering

Three stacked render technologies collapse into one Phaser scene. This is the largest single
simplification in the port — and the place where Phaser 4's API differences will bite first.

## The inversion

The template ships Phaser as a **click-through overlay above** the Lit UI:

```css
#fx { position: fixed; inset: 0; z-index: 10; pointer-events: none; }
game-app { z-index: 1; }
```

The port flips this: **Phaser below, receiving input; Lit rails and toolbars above.**

```
┌─────────────────────────────────────────────┐
│  #boot            z-index 30  (removed)     │
│  Lit modals       z-index 20                │
│  #fx  particles   z-index 15  pointer:none  │  ← keep, still decorative
│  Lit rails/toolbar z-index 10 pointer:auto  │  ← overlays the canvas edges
│  #map  Phaser     z-index  1  pointer:auto  │  ← THE MAP
└─────────────────────────────────────────────┘
```

Two constraints carry over from [`02-target-platform.md`](02-target-platform.md):

- **The map scene joins the existing `Phaser.Game`.** The KnockBox plugin is registered on that one
  config; a second game would have no networking.
- **The rails overlay the canvas**, they do not shrink it. Legacy's zoom anchor accounts for this:
  `anchorX = (stageRect.width + leftPx - rightPx) / 2`. Reproduce it or toolbar zoom drifts.

`input: { mouse: { preventDefaultWheel: false } }` in the current config exists to stop the canvas
eating events. **The map needs the wheel**, so this changes — but be deliberate: preventing default
on the wheel stops the page scrolling, which is what you want inside a game iframe.

## Coordinate mapping — the heart of it

Legacy: `stage_px = (world_cells − pan) × cellPx × zoom`, where `pan` is the world cell coordinate
at the stage's top-left.

**Choose Phaser world units = pixels at `cellPixels` scale.** See
[the `cellPixels` coupling](#the-cellpixels-coupling--decide-this-before-writing-the-scene) below —
this is a decision, not a given.

> **⚠ `scrollX` is NOT the top-left world coordinate.**
>
> This is the easiest way to build "synchronised wrongness" into the port, so it gets a box.
>
> **Phaser cameras zoom about the camera's midpoint, not its top-left.** `Camera.preRender`
> computes `midPoint = (scrollX + w/2, scrollY + h/2)` and then
> `worldView.x = midPoint.x - (w / zoom) / 2`, i.e.
>
> ```
> worldView.x = scrollX + (w / 2) * (1 - 1 / zoom)
> ```
>
> which equals `scrollX` **only when `zoom === 1`**. At zoom 10 on a 1920 px viewport the error is
> `960 - 96 = 864 px` ≈ **17 cells**.
>
> Legacy's `panX` really *is* the world cell at the stage's top-left — `applyTransform`'s
> `base * W * (zoom - 1) / 2` term exists solely to cancel the wrapper's
> `transform-origin: 50% 50%`, leaving the left edge at `-base * zoom * panX`, and
> `dndMapperBitmapCanvas.js`'s `worldOriginX = -panX * pxPerCell` agrees. Both modules say so in
> comments. So the legacy semantics in [`01`](01-legacy-architecture.md) are right; it is the naive
> translation of them that breaks.

```ts
const CELL = grid.cellPixels;            // 50 by default

// world position of a thing measured in cells
const worldX = cellX * CELL;
const worldY = cellY * CELL;

// legacy pan/zoom → Phaser camera. The correction term is NOT optional.
export function applyViewport(
  cam: Phaser.Cameras.Scene2D.Camera, panX: number, panY: number, zoom: number,
): void {
  cam.setZoom(Phaser.Math.Clamp(zoom, MIN_ZOOM, MAX_ZOOM));
  cam.scrollX = panX * CELL - (cam.width  / 2) * (1 - 1 / cam.zoom);
  cam.scrollY = panY * CELL - (cam.height / 2) * (1 - 1 / cam.zoom);
}

// …and the inverse, for reading pan back out (to persist it, or to log it).
export function readViewport(cam: Phaser.Cameras.Scene2D.Camera) {
  return { panX: cam.worldView.x / CELL, panY: cam.worldView.y / CELL, zoom: cam.zoom };
}
```

**Prefer `worldView` over `scrollX` for every read.** `cam.worldView` is the visible world
rectangle and is always correct; `scrollX` is an implementation detail of where Phaser puts the
midpoint. Reading through `worldView` and writing through `applyViewport` keeps the two directions
symmetric and keeps the correction in exactly one place.

The cleaner alternative, if the port has no reason to preserve legacy's top-left pan: store pan as
the world **centre** and use `camera.centerOn(cx * CELL, cy * CELL)`, which is midpoint-based and
needs no correction at all. Legacy's pan only ever left the client via `OnViewportChanged`, and the
port does not sync camera state ([`06`](06-state-and-authority.md#strategy--three-rules) keeps it
client-local), so nothing on the wire depends on the choice. Pick one and put a test on it.

Note that `zoomAtAnchor()` below is **already zoom-agnostic** — it adjusts `scrollX` by a
world-point delta, so it stays correct either way and needs no change.

Everything else follows for free:

| Legacy | Phaser |
| --- | --- |
| `clientToSvgPoint()` | `camera.getWorldPoint(pointer.x, pointer.y)` then `/ CELL` |
| `getPixelsPerCell()` | `CELL * camera.zoom` |
| `centerOnWorld(x, y)` | `camera.centerOn(x * CELL, y * CELL)` |
| `[data-dndm-screenpx]` inverse-scale | `setScrollFactor(0)` on a UI layer, or `setScale(1 / camera.zoom)` |
| `layerOrder` | `setDepth(layerOrder)` |

### Zoom rules to preserve

```ts
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 10.0;
const WHEEL_FACTOR   = 1.1;    // per notch, cursor-anchored
const TOOLBAR_FACTOR = 1.25;   // anchored at the rail-aware visible centre
```

**Cursor-anchored zoom** — the world point under the cursor must not move:

```ts
function zoomAtAnchor(cam: Phaser.Cameras.Scene2D.Camera, factor: number, sx: number, sy: number) {
  const before = cam.getWorldPoint(sx, sy);
  cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM));
  const after = cam.getWorldPoint(sx, sy);
  cam.scrollX += before.x - after.x;
  cam.scrollY += before.y - after.y;
}
```

> **Pan stays unbounded.** Do not call `setBounds()` on the camera. The legacy source explicitly
> warns against reintroducing clamping — DMs scroll past the map edge to reach off-map notes.
> `setBounds` is the obvious "improvement" here and it is wrong.

### The `cellPixels` coupling — decide this before writing the scene

`CELL = grid.cellPixels` makes the Phaser world scale a function of **synced, persisted state**.
[`03`](03-domain-model.md) calls `cellPixels` "a rendering concern", but it is a field of
`GridConfig`: it round-trips through `.vtf` (where `dimensions` is `cells × cellPixels`), it
replicates to every client, and the map-settings modal lets the DM change it.

So a DM nudging cell size from 50 to 64 silently rescales **every world coordinate in the live
scene, for everyone at once** — invalidating camera scroll, the fog quad's display size, cached
geometry and any in-flight drag.

Two options, and the port must state which it took:

| | Consequence |
| --- | --- |
| **`CELL = grid.cellPixels`** (as originally written) | Faithful to legacy's CSS-pixel model, but a grid edit becomes a full scene rescale: every `cellPixels` change has to re-run `applyViewport`, rebuild the fog quad, and reposition every object. |
| **`CELL = 64`, fixed** (recommended) | World units are decoupled from replicated state. `cellPixels` becomes legacy metadata used only for `.vtf` `dimensions` and for CSS, and a grid edit touches nothing in the scene. Camera zoom absorbs the difference, which is what zoom is for. |

The second costs one constant and removes a whole class of bug. Legacy needed `cellPixels` in the
renderer because the renderer *was* CSS; Phaser has no such constraint.

## Scene structure

One scene, `MapScene`, with fixed depth bands:

```
depth  Layer                    Implementation
─────  ───────────────────────  ─────────────────────────────────────────
   0   Background               solid fill
1…999  Image layers             Phaser.GameObjects.Image, depth = RANK (not layerOrder)
 1000  Grid                     Graphics, redrawn on camera change
 2000  Markup                   Graphics or a rendered texture (phase 6+)
 3000  Fog                      Image over a CanvasTexture, 1 texel/cell
 4000  Tokens                   Container per token
 5000  Focus rect / ruler       Graphics
 6000  Selection handles        Graphics + interactive zones
```

Keep the band constants in one module.

> **Normalise image depth by rank — never `setDepth(layerOrder)` directly.** `layerOrder` is an
> arbitrary integer: it comes from legacy's reorder verb and from imported `.vtf` data, and nothing
> constrains it to `0…999`, or even to being non-negative. An image with `layerOrder >= 1000` draws
> over the grid, the fog and the tokens. Sort, then use the index:
>
> ```ts
> const sorted = [...map.images].sort((a, b) => a.layerOrder - b.layerOrder);
> sorted.forEach((img, i) => sprite(img).setDepth(DEPTH.IMAGES + i));   // DEPTH.IMAGES = 1
> ```
>
> This also caps a map at 999 images, which is a limit worth having.

Legacy's ordering is load-bearing: **fog draws above images but below tokens**, so a fogged region
hides terrain.

> **Fog does not conceal tokens — from anyone.** With fog at 3000 and tokens at 4000, a
> non-hidden token in a fogged cell draws over the fog; for players, fog alpha is 1.0, so the token
> sits fully visible against opaque black. That is legacy's behaviour — its `<TokenLayer>` renders
> after the fog `<path>` — and concealment is `Token.Hidden` alone, never fog. Reproduce it, and
> state it in [`07`](07-ui-shell.md#dm-vs-player-ui) so a DM knows fog hides terrain, not
> creatures.

### Images

```ts
const img = this.add.image(x * CELL, y * CELL, textureKey)
  .setOrigin(0, 0)                          // CORNER-anchored, matching the domain model
  .setDisplaySize(width * CELL, height * CELL)
  .setAngle(rotation)                       // Phaser setAngle takes DEGREES — same as legacy
  .setAlpha(opacity)
  .setDepth(layerOrder)
  .setVisible(!hidden);
```

> **Rotation origin differs from legacy.** Legacy's Canvas2D path translates to the image *centre*
> and rotates there. With `setOrigin(0, 0)` Phaser rotates about the top-left corner instead. Either
> set `setOrigin(0.5)` and offset the position by half the display size, or use
> `Phaser.GameObjects.Image.setDisplayOrigin()`. **Verify against a rotated image from a real
> `.vtf`** — this is a silent, visually obvious-once-seen bug.

Texture loading is dynamic (blob URLs, not a preload manifest):

```ts
this.load.image(key, blobUrl);
this.load.once(`filecomplete-image-${key}`, () => { /* place it */ });
this.load.start();                          // required outside preload()
```

Keep legacy's placeholder behaviour: a missing texture draws a dashed rect rather than nothing, so
a broken asset is visible instead of invisible.

### Grid

Legacy draws the grid with two CSS `linear-gradient`s. In Phaser, a `Graphics` redrawn on camera
change is simplest and stays crisp at any zoom:

```ts
redrawGrid() {
  const cam = this.cameras.main;
  const view = cam.worldView;                        // visible world rect
  const g = this.gridGfx.clear().lineStyle(1 / cam.zoom, lineColor, 1);

  // Clamp to the intersection of the camera AND THE MAP. See the note below.
  const x0 = Math.max(0, Math.floor(view.x / CELL));
  const x1 = Math.min(grid.widthCells,  Math.ceil(view.right  / CELL));
  const y0 = Math.max(0, Math.floor(view.y / CELL));
  const y1 = Math.min(grid.heightCells, Math.ceil(view.bottom / CELL));
  if (x1 < x0 || y1 < y0) return;                    // map entirely off-screen

  const left = x0 * CELL, right = x1 * CELL, top = y0 * CELL, bottom = y1 * CELL;
  for (let cx = x0; cx <= x1; cx++) g.lineBetween(cx * CELL, top, cx * CELL, bottom);
  for (let cy = y0; cy <= y1; cy++) g.lineBetween(left, cy * CELL, right, cy * CELL);
}
```

**Clamp to the map bounds, not merely to the camera.** Culling to the *visible* range alone is a
trap, and it fails worst at exactly the zoom that looks most dangerous. Pan is unbounded and
`MIN_ZOOM` is 0.01, so at minimum zoom the visible world is 100× the viewport:
`1920 / 0.01 / 50 = 3,840` columns and `1080 / 0.01 / 50 = 2,160` rows — **~6,000 `lineBetween`
calls per redraw**, against 400 for an entire 200×200 map. Visible-range culling is *worse* than no
culling there.

Legacy never had the problem: its grid is two CSS gradients on `.dndm-canvas-transform`, whose box
is `W*cellPx × H*cellPx` — the grid is **bounded to the map**, always. Clamping to
`[0, widthCells] × [0, heightCells]` bounds the work *and* reproduces legacy's appearance, including
the absence of grid lines out in the off-map void — which is also how a DM can tell they have
scrolled past the edge.

Divide the line width by zoom so it stays 1 screen pixel.

### Fog — do not port the polygon tracer

Legacy builds an SVG `<path>` with `fill-rule="evenodd"` via `Helpers/FogPolygonBuilder.cs`
(171 lines), tracing cell-edge rings with a right-turn preference at saddle vertices.

**Phaser has no `evenodd` fill.** Rather than port the tracer and hand-roll hole handling, render
fog as a **texture at 1 texel per cell**:

```ts
// once per map, or on grid resize
const tex = this.textures.createCanvas('fog', grid.widthCells, grid.heightCells);

// on every fog change
const ctx = tex.getContext();
const img = ctx.createImageData(grid.widthCells, grid.heightCells);
for (let i = 0; i < grid.widthCells * grid.heightCells; i++) {
  const fogged = (mask[i >> 3] & (1 << (i & 7))) !== 0;
  img.data[i*4 + 3] = fogged ? 255 : 0;         // alpha only; RGB stays black
}
ctx.putImageData(img, 0, 0);
tex.refresh();

this.fogImage
  .setOrigin(0, 0)
  .setDisplaySize(grid.widthCells * CELL, grid.heightCells * CELL)
  .setAlpha(isDm ? 0.45 : 1.0);                 // legacy's exact opacities
```

Set **`NEAREST` filtering** on the texture. The polygon tracer produced axis-aligned cell-boundary
rings, so a nearest-filtered texel grid reads as the same thing at a fraction of the complexity.

> **One known deviation, worth accepting.** A nearest-sampled texture stretched by a *fractional*
> pixels-per-cell (37.3 px/cell, say) snaps each texel to a whole number of device pixels, so
> adjacent fog cells can differ in on-screen width by 1 px — faintly uneven fog edges, where
> legacy's vector path was exact at every zoom. If it ever grates, draw the mask into a
> `RenderTexture` at `cellPixels × zoom` resolution, or sample the mask in a fragment shader.
> Neither is worth doing pre-emptively.

**Fog updates should be O(changed cells) — which means the client has to know what changed.** The
texture makes a per-cell update cheap (poke `data[]`, then one `refresh()`), but
[`06`](06-state-and-authority.md#strategy--three-rules)'s fog patch carries the **whole mask** for
a map, so on its own it tells you only the result. Reconcile them one of two ways:

- **Diff on receive** (no protocol change): keep the previous mask, XOR against the new one, and
  repaint only the differing bytes. That is 5,000 bytes for a 200×200 map, so the diff itself is
  free, and it stays correct for `fillFog`/`clearFog`, for a full snapshot, and for `.vtf` import.
- **Add a `{ kind: "fogCells"; mapId; cells: number[]; fogged: boolean }` patch** mirroring the
  intent, keeping the whole-mask patch for fill/clear and joins.

Prefer the diff: fewer moving parts, and every path — patch, snapshot, import — goes through one
update routine.

### Tokens

A `Container` per token, so the circle, initial, halo and stack chips move together:

```ts
const c = this.add.container(x * CELL, y * CELL).setDepth(DEPTH.TOKENS);
c.add(this.add.circle(0, 0, 0.45 * CELL, colorInt));          // radius 0.45 cells
c.add(this.add.text(0, 0, initial, style).setOrigin(0.5));
c.setSize(0.9 * CELL, 0.9 * CELL).setInteractive({ draggable: true });
```

Owner halo `0.55` cells, stack chips `0.4`. Label colour comes from legacy's contrast helper.

**Token stacking** — legacy collapses co-located tokens and fans them into chips with a leader line
on click. Port the stacking helper from `Helpers/`; the geometry is pure and reusable.

## Input

Phaser replaces five JS interop modules. The tool-mode state machine survives unchanged:

```ts
type ToolMode = "none" | "markup" | "focus" | "fog" | "ruler";

currentMode(): ToolMode {
  if (this.spaceHeld)   return "none";     // Space always yields to panning
  if (this.markupActive) return "markup";
  if (this.focusActive)  return "focus";
  if (this.fogActive)    return "fog";
  if (this.rulerActive)  return "ruler";
  return "none";
}
```

Gesture rules to reproduce:

| Rule | Detail |
| --- | --- |
| Left-drag background | Pan — only in `"none"` mode |
| **Middle-drag** | **Always** pans, from anywhere, including over tokens |
| **Space held** | Forces `"none"`, so pan works with a tool armed |
| Click dead zone | **3 px** separates click-to-deselect from a pan drag |
| Ctrl during drag | Bypass snap |
| Shift during resize | Free aspect (default preserves) |
| Tool active | Tokens and image handles become non-interactive |

In Phaser, "tool active" means calling `disableInteractive()` on those objects — the equivalent of
legacy flipping `pointer-events: none`.

### Fog painting

Keep legacy's accumulate-then-commit shape, for a different reason than legacy had it. Legacy
batched to avoid SignalR round-trips; the port batches because **each intent is a network message
against a 30/s budget**.

```ts
// pointerdown → pointermove: accumulate locally and paint an optimistic preview.
// Key on the CELL INDEX, which is both the dedup key and the wire format — so there
// are no "cx,cy" strings to convert at commit time.
this.strokeCells.add(cy * grid.widthCells + cx);       // Set<number>

// pointerup → ONE intent carrying the whole stroke
this.controller.sendIntent({
  kind: "paintFog",
  mapId,
  cells: [...this.strokeCells],                        // number[], matching `06`'s Intent
  fogged,
});
```

Note the payload type: [`06`](06-state-and-authority.md#verbs-become-intents) declares
`cells: readonly number[]` — **cell indices**, in the same `bit = cy * widthCells + cx` layout as
the mask itself. (Legacy sent two parallel `int[]` arrays of xs and ys; one index array carries the
same information in half the JSON.) Accumulate indices from the start so there is nothing to
convert.

Preview colours: paint `#000 @ 0.45`, erase `#e89055 @ 0.35`.

> The optimistic preview is the **one** deliberate exception to the template's
> "render only confirmed state" rule, and it is worth it — a fog brush that lags a round-trip feels
> broken. Clear the preview when the authoritative patch lands. Everything else (token moves, image
> transforms) should still render only on confirmation.

### Screen-constant overlays

Ruler endpoint dots and the label pill must stay a fixed size on screen. Legacy rewrote a literal
`scale(1/(cellPx*zoom))` on `[data-dndm-screenpx]` nodes every frame. In Phaser, either:

- put them on a **second camera** with `setScrollFactor(0)`, or
- `setScale(1 / camera.zoom)` on camera-change.

The second camera is cleaner and avoids per-frame work.

Ruler label format, unchanged: `"{cheb} sq · {euc:0.0} actual · {ft} ft"` — **Chebyshev** for 5e
squares, Euclidean alongside, ×5 ft.

## Phaser 4 — verify before building

The target pins **Phaser 4.2.1**. Phaser 4 reworked the renderer, and most material online is 3.x.
**Spike these APIs on day one of phase 3**, before writing the scene:

| API | Used for | Risk |
| --- | --- | --- |
| `cameras.main.getWorldPoint()` | every pointer→world conversion | signature/behaviour drift |
| **`scrollX` vs `worldView.x` at zoom ≠ 1** | pan/zoom | **the whole coordinate model — ask this one first, see the box above** |
| `setZoom`, `centerOn`, `worldView` | pan/zoom | signature/behaviour drift |
| `textures.createCanvas()` + `refresh()` | fog | may be renamed/reshaped in v4 |
| Texture filter mode (`NEAREST`) | crisp fog | constant may have moved |
| `setInteractive({ draggable: true })` + drag events | tokens, images | |
| `load.image()` after boot + `load.start()` | dynamic blob textures | |
| Multi-camera + `setScrollFactor(0)` | screen-constant overlays | |
| `Graphics.lineBetween` perf | grid | |

If any of these differ materially, record the alternative **here** rather than scattering
workarounds through the scene.

## Performance notes

- **Redraw the grid only on camera change**, not per frame. Phaser's `Graphics` is retained; a
  static grid costs nothing until it is cleared and rebuilt.
- **Fog updates are O(changed cells)** with the texture approach. Do not rebuild the full
  `ImageData` for a one-cell change once maps get large.
- **Cull images** — Phaser culls off-camera objects automatically, but `setDisplaySize` on a huge
  texture still costs GPU memory. Legacy's texture-size cap (`min(MAX_TEXTURE_SIZE, 8192)`) applies
  unchanged; see [`08-assets-pipeline.md`](08-assets-pipeline.md).
- **Keep the WebGL context-loss guards** from `fx.ts:61-72` and extend them to the map scene: on
  restore, textures must be re-uploaded or the table goes blank. This is now a correctness concern,
  not a cosmetic one.
- Legacy redrew on a **dirty flag + rAF**, never a continuous loop. Phaser runs a continuous loop by
  design; that is fine, but avoid doing per-frame work that only needs to happen on change (grid
  rebuild, fog rebuild, screen-constant rescaling).
