# 07 — UI Shell

32 Razor components → Lit. The visual design ports almost unchanged; the component model does not.

## The CSS: 12% copies, 88% is work

The design *language* carries over completely — hand-written CSS with custom properties, no
framework, which is exactly what Lit wants. The **files** mostly do not, and it is worth being
blunt about the split because it is the difference between an afternoon and a fortnight:

| | Lines | Files | Fate |
| --- | ---: | ---: | --- |
| `wwwroot/css/panels.css` | **634** | 1 | **Copy.** The `:root` token block plus shared panel/button/input chrome. |
| Blazor **scoped** `.razor.css` | **4,658** | 34 | **Rewrite per component**, as each Lit component lands. |
| | 5,292 | 35 | |

The scoped sheets are not incidental — they are where the actual UI lives. The largest:
`DndMapperDisplay.razor.css` 513, `CharacterSheetPanel.razor.css` 490, `MapCanvas.razor.css` 438,
`QuickRollFooter` 333, `DndMapperPlayingPhase.razor.css` 289 (which *owns* the rail-width
variables), `HostInitiativePanel` 228, `StatusEffects` 216.

**Why they cannot be copied:** Blazor compiles scoped CSS by rewriting every selector with a
generated `[b-xxxxxxxxxx]` attribute. Strip that and the rules become global, so a `.panel-row` in
one component silently restyles another. Each sheet has to be de-scoped and re-namespaced by hand
(`.dndm-sheet .row`, say) as its component is ported.

Two mitigations, both cheap:

- Roughly a third of the scoped rules belong to phase-6+ components (sheets, dice, initiative,
  status effects, the display view) and can be deferred with them.
- `MapCanvas.razor.css` (438) largely *dies* — it styles the three-layer DOM stack that Phaser
  replaces.

### The token block

```css
/* "Forge & Ember" — copy panels.css's whole :root rule into src/ui/styles/tokens.css. */
--dndm-bg-deep:  #0c0a08;   --dndm-bg-panel: #191512;   --dndm-border:   #3a2d23;
--dndm-text:     #ece0cc;   --dndm-ember:    #c4743a;   --dndm-ember-hi: #e89055;
--dndm-void:     #07060a;   --dndm-danger:   #b04a3a;   --dndm-success:  #6a8a52;
```

**Copy the rule, not this excerpt** — there are 15 variables, and the six not shown here
(`--dndm-bg-panel-2`, `--dndm-border-strong`, `--dndm-border-accent`, `--dndm-text-dim`,
`--dndm-text-muted`, `--dndm-display`) are used throughout the scoped sheets. Also present:
`--dndm-noise` (inline SVG `feTurbulence` data-URI), `--dndm-panel-gradient`,
`--dndm-panel-vignette`.

Note that `--dndm-rail-w-left` / `-right` are **not** in `panels.css` — they live in
`DndMapperPlayingPhase.razor.css` and are written at runtime. The port sets them from the rail
controller.

The template's own `tokens.css` (15 lines) is a placeholder — replace it rather than merging.

> **Lit renders into light DOM here.** `GameElement` overrides `createRenderRoot()` to return
> `this`, so there is no shadow DOM and no style encapsulation. That is what makes the global
> `panels.css` work directly, exactly as in Blazor's scoped-plus-global model — and it is also
> exactly why the scoped sheets need re-namespacing rather than pasting. Keep it, and keep component
> selectors prefixed.

Icons are **inline SVG paths in markup** — no icon font, no sprite sheet. They copy across as
literal template fragments. `Helpers/TokenIcons.cs` (eye / eye-slash / token glyph) is 35 lines of
`MarkupString` and becomes two small Lit template functions.

## Component mapping

### App shell

| Razor | Lit | Notes |
| --- | --- | --- |
| `DndMapperRoom.razor` | *(gone)* | Routing was a Blazor page concern; a KnockBox game has one entry |
| `DndMapperLobby.razor` | `<dndm-lobby>` | Roster, kick, permissions, "Start Session" |
| `DndMapperPlayingPhase.razor` | `<dndm-app>` | The shell: rails, canvas area, cascades |
| `DndMapperDisplay.razor` | *(deferred — Q3)* | Was a second route; would become a fullscreen mode |

`<dndm-app>` replaces the template's `<game-app>` and keeps its responsibilities: it owns the
controller subscription, the rAF loop, and the roster.

### Left rail (DM only)

| Razor | Lit | Phase |
| --- | --- | --- |
| `HostMapSwitcher` | `<dndm-map-list>` | 1 |
| `HostLayerPanel` | `<dndm-layer-panel>` | 1 |
| `HostTokenPanel` | `<dndm-token-panel>` | 1 |
| `HostSavesPanel` | `<dndm-saves-panel>` | 2 |
| `LoadedDiceRulesPanel` | `<dndm-loaded-dice-panel>` | 6+ |

### Right rail

| Razor | Lit | Phase |
| --- | --- | --- |
| `MyTokenPanel` | `<dndm-my-token>` | 1 |
| `CharacterSheetPanel` | `<dndm-character-sheet>` | 6+ |
| `InitiativeBanner` / `HostInitiativePanel` | `<dndm-initiative>` | 6+ |

### Canvas area

| Razor | Fate |
| --- | --- |
| `MapCanvas.razor` (444) | **Splits.** Toolbar → `<dndm-toolbar>`; stage → the Phaser scene |
| `MapCanvas.razor.cs` (1,319) | **Mostly evaporates** — see [`05-rendering.md`](05-rendering.md) |
| `TokenLayer.razor` | → Phaser containers |
| `MarkupOverlay.razor` | → Phaser graphics (phase 6+) |
| `MapCanvasJsModules.cs` | **Gone** — no JS interop handles to own |
| `HostImageInspector` | `<dndm-image-inspector>` |

### Overlays and modals

| Razor | Lit | Phase |
| --- | --- | --- |
| `ConfirmModal` | `<dndm-confirm>` | 1 |
| `MapSettingsModal` | `<dndm-map-settings>` | 1 |
| `PermissionsPanel` | `<dndm-permissions>` | 1 |
| `DndMapperToast` + service | `<dndm-toast>` | 1 |
| `ImageUploadButton` | `<dndm-image-upload>` | 1 |
| `VtfImportButton` | `<dndm-vtf-import>` | 2 |
| `RailActionsMenu` | `<dndm-rail-menu>` | 1 |
| `QuickRollFooter`, `DiceCanvas`, `RollLog*` | | 6+ |
| `SheetSettingsModal`, `SchemaPresetSelector`, `StatusEffects*`, `RollTemplateLibraryModal` | | 6+ |

## Translating Blazor idioms

### Cascading values → Lit context or explicit properties

Legacy cascades `DndMapperViewport`, `DndMapperToastService` and `DiceRollerConfig` down the tree.
Lit has no cascade. Two options:

- **Explicit properties** — verbose but obvious, and fine for a shallow tree.
- **`@lit/context`** — closest to the Blazor model, but a new dependency.

**Recommend explicit properties**, given the tree is shallow and the repo currently has exactly two
runtime dependencies. Revisit only if prop-drilling gets deep.

`DndMapperViewport` is a special case: it is a *mutable* holder written by the canvas and read by
the token panel (as the spawn anchor). In the port that is client-local camera state — expose it as
a getter on the scene facade rather than a shared mutable object.

### `StateHasChanged()` → reactive properties

Blazor re-renders on `StateHasChanged()`. Lit re-renders when a `@state()` or `@property()` field is
**reassigned** — mutating an array in place does nothing.

```ts
this.tokens = [...this.tokens, newToken];   // re-renders
this.tokens.push(newToken);                 // does NOT
```

This pairs well with the immutability the wire contract already demands.

### `@onclick` → standard listeners

```ts
html`<button @click=${this.onCreateMap}>New map</button>`
```

Use `GameElement.listen()` for controller subscriptions — it collects unsubscribe closures and runs
them on `disconnectedCallback`, which is the template's established leak-avoidance pattern.

### Debounced editing

`CharacterSheetPanel` (610 lines) is mostly debounce plumbing for text fields. In Lit, a small
`debounce()` helper on `@input` handlers replaces it. Deferred to phase 6+, but note that the
*reason* for debouncing changes: legacy debounced to limit SignalR chatter, the port debounces to
stay under the **30 msg/s** intent budget. Same fix, same urgency.

## Rails: resize and collapse

`dndMapperRailResize.js` (153 lines) becomes a small Lit controller. Behaviour to preserve:

- Drag the divider to resize, **200–600 px**.
- **Click without dragging toggles collapse** — same 3 px dead zone idea as the canvas.
- Width persists per side *and per role* in **`sessionStorage`** (key `dndm.rail.{role}.{side}`),
  not `localStorage`. Legacy chose that deliberately — *"a non-critical, per-tab UI preference …
  widths reset when a new browser session starts."* Match it, or record the deviation.
- Rails **overlay** the canvas; they do not shrink it. The zoom anchor compensates
  (see [`05-rendering.md`](05-rendering.md)).
- Widths drive `--dndm-rail-w-left` / `--dndm-rail-w-right`, which the toolbar reads.

`dndMapperPanelCollapse.js` (50 lines) — clicking a panel header collapses it, **skipping clicks on
interactive descendants**. That last detail is easy to miss and annoying when wrong.

## DM vs player UI

Legacy gates on "is host". **In the port, gate on `isOwner`** — `isHost` is `false` for everyone
under server authority.

```ts
// dndm-app
@state() private isDm = false;

// from the controller's roster event
this.isDm = roster.isOwner;
```

`owner-changed` is **already wired** in the template (`src/net/authorityController.ts:56`, feeding
the `roster` event), so this costs nothing to honour — but legacy had no equivalent, because the
Blazor host owned a circuit and the room died with it. If DM succession is implemented
(see [`06-state-and-authority.md`](06-state-and-authority.md)), the left rail must appear for the
new DM without a reload, and the map scene must re-enable the DM-only tools.

Player-visible differences to preserve:

| | DM | Player |
| --- | --- | --- |
| Left rail | visible | hidden |
| Fog opacity | **0.45** | **1.0** |
| Hidden tokens | visible, marked | not rendered |
| **Tokens in fogged cells** | **visible** | **visible** — fog never conceals a token |
| Fog/markup/focus tools | yes | no |
| "Centre everyone here" | yes | no |

> **Fog hides terrain, not creatures.** Tokens draw above fog for everyone (legacy's
> `<TokenLayer>` renders after the fog `<path>`; the port's depth bands put tokens at 4000 over fog
> at 3000). A player looking at an opaque black region still sees any non-hidden token standing in
> it. Concealment is `Token.Hidden` alone. This is legacy behaviour and the port keeps it — but it
> is the kind of thing a DM discovers at the worst moment, so say it in the game's own help text.

## Boot and layout

`index.html` needs a `#map` container beneath the UI:

```html
<div id="map"></div>          <!-- Phaser map scene, z-index 1, pointer-events auto -->
<dndm-app></dndm-app>         <!-- Lit UI,          z-index 10, transparent to clicks
                                   except on actual panels -->
<div id="fx" aria-hidden="true"></div>   <!-- particles, z-index 15, pointer-events none -->
<div id="boot">…</div>
```

The critical CSS detail: `<dndm-app>` must be `pointer-events: none` on its **root**, with
`pointer-events: auto` restored on the rails, toolbar and modals. Otherwise a full-window UI layer
swallows every map click. This is the inverse of the template's arrangement and the single most
likely "why can't I click the map" bug.

Keep the `#boot` splash and its removal in `main.ts` — first paint matters more here than in the
template, because a map scene plus textures takes longer to become interactive.

## Accessibility and input notes

- Legacy has **no keyboard shortcuts** beyond Space/Ctrl/Shift modifiers. The port need not add
  any, but if it does, they must not fight the Space-to-pan behaviour.
- The canvas is not keyboard-navigable in legacy. Panels are ordinary DOM and remain so in Lit —
  keep buttons as `<button>`, and keep focus visible.
- **Touch needs more than fidelity.** Legacy supports single-touch drag for tokens and images and
  nothing else: `dndMapperViewport.js` binds only `wheel` and the `mouse*` events, so there is no
  pinch-zoom **and no touch pan or zoom of any kind**. Reproducing that exactly ships a build that
  cannot navigate a map on the tablet a DM is most likely to have at the table.

  Treat two-finger pan and pinch-zoom as **in scope for phase 3**, recorded as a deliberate
  deviation. Phaser's pointer events make it small, and it must respect the same `MIN_ZOOM`/
  `MAX_ZOOM` clamps and the same cursor-anchored (here: midpoint-anchored) rule as the wheel.
