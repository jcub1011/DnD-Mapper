# Phase 10 — Freehand Canvas Markup Overlay & Projector Mode

## 1. Executive Summary & Scope

Phase 10 implements two critical visual systems for in-person and digital tabletop play: freehand vector markup drawing directly onto maps, and the dedicated Display / Projector Theater view.

Tabletop DMs frequently need to sketch temporary walls, tactical arrows, spell radii, or hazard notes directly onto the battlemap. Phase 10 provides an interactive drawing canvas with Bezier stroke smoothing, stroke erasure, and undo/redo stacks, storing clean SVG paths in cell-unit coordinates. Additionally, it implements the projector presentation mode designed for physical TV gaming tables and external secondary monitors, featuring pitch-black fog of war, automatic camera framing, fog entity culling, and animated roll tickers.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Visual Surface Features                         │
├─────────────────────────┬────────────────────────┬─────────────────────┤
│   Freehand SVG Markup   │  Display / Projector   │   Phaser / Viewport │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ • Bezier stroke fitting │ • In-app theater mode  │ • Cell-unit SVG     │
│ • Eraser & Undo / Redo  │ • Detached popup sync  │   scaling (1/50)    │
│ • Color / width palette │ • 100% pitch-black fog │ • Space-to-pan pass │
│ • Commit on pointerup   │ • Auto-frame focusRect │ • 250ms token ease  │
│   (no network flooding) │ • Fog entity culling   │ • Golden halo ring  │
└─────────────────────────┴────────────────────────┴─────────────────────┘
```

---

## 2. Legacy Codebase References

Ported directly from `KnockBox.DndMapper`:
- **Canvas Markup**:
  - `Pages/Components/MarkupOverlay.razor` (and `.cs`, `.css`)
  - `MapCanvas.razor:35-42`, `MapCanvas.razor.cs:780-840`
  - `GameMap.MarkupSvg` property
  - `DndMapperGameEngine.cs:2094-2120` (`UpdateMapMarkupAsync`)
- **Display / Projector View**:
  - `Pages/DndMapperDisplay.razor` (and `.cs`, `.css` — 513 lines CSS)
  - `Helpers/DisplayProjection.cs` (92 lines) — Fog culling and display-specific visibility filters.
  - `wwwroot/js/dndMapperDisplayTokens.js` (121 lines) — 250ms ease-out token tweening.
  - `wwwroot/js/dndMapperDisplayImageFallback.js` (42 lines)

---

## 3. Subsystem A: Freehand Canvas Markup Overlay

### 3.1 Architecture & Coordinate Normalization
- **The Cell-Unit Invariant**:
  - The drawing canvas overlays the Phaser viewport, taking user pointer input in screen/pixel space.
  - During drawing, points are collected in map pixel space (`cellPixels = 50`).
  - Upon commit (`pointerup`), the accumulated SVG paths are scaled by `1 / cellPixels` and stored in `GameMap.markupSvg` as pure cell-unit paths:
    ```xml
    <g stroke="#c0392b" stroke-width="0.08" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M 12.5 8.2 Q 13.1 8.9 14.0 9.5 ..." />
    </g>
    ```
  - **Why this matters**: As the camera zooms between `0.01` and `10.0`, markup scales with millimeter precision alongside the grid, images, and tokens without fractional pixel drift.

### 3.2 Tool Controls & Interactions
- **Toolbar Trigger**: `✎ Markup` button in `<dndm-toolbar>` (DM only).
- **Tool Palette**:
  - **Pen**: Smooth freehand drawing with Catmull-Rom or Quadratic Bezier curve fitting.
  - **Eraser**: Hit-test individual strokes by distance threshold to delete whole paths.
  - **Palette**: Copper (`#d35400`), Crimson (`#c0392b`), Emerald (`#27ae60`), Gold (`#f39c12`), White (`#ffffff`), Black (`#000000`).
  - **Width Presets**: Thin (`0.02` cells / 1px), Medium (`0.04` cells / 2px), Thick (`0.08` cells / 4px), Marker (`0.16` cells / 8px).
  - **Actions**: Local Undo (`Ctrl+Z`), Redo (`Ctrl+Y`), Clear All (with confirmation dialog).
- **Space-to-Pan Passthrough**:
  - When the markup tool is active, holding `Space` applies `pointer-events: none` to the drawing surface, delegating pointer drag to Phaser camera pan. Releasing `Space` re-arms the drawing tool instantly.

### 3.3 Rate Limit Defense
- **The 30 msg/s Protection**:
  - Stroke points are strictly buffered in local memory during `pointermove`.
  - An intent is ONLY emitted on `pointerup` after completing a stroke, or on Undo/Redo/Clear.
  - Never emit intents during pointer movement.

---

## 4. Subsystem B: Display / Projector Theater Mode

### 4.1 Platform Hosting Model
In KnockBox-Games, the application runs inside an authenticated, sandboxed iframe connected via a single session ticket. To support external projector displays:
- **Mode 1: In-App Theater Mode (Primary Architecture)**:
  - Fullscreen action toggles the viewport within the existing authenticated session to hide all rails, toolbars, and UI chrome, rendering pure map with 100% pitch-black fog and projector rules.
  - Recommended for single-screen casting and physical TV tables.
- **Mode 2: Detached Window (Experimental / Deferred)**:
  - Detached popups (`window.open('?view=display')`) require local cross-window synchronization via `BroadcastChannel("dndm-display-sync")` because KnockBox single-ticket auth prevents opening parallel WebSocket client sessions without host platform support.

### 4.2 Display Projection Rules (`DisplayProjection`)
1. **Fog of War**:
   - Renders at **1.0 opacity (100% pitch black)**. Unlike the DM's 0.45 translucent overlay, unrevealed areas on the projector are completely opaque.
2. **Hidden Entities**:
   - Tokens with `hidden === true` and images with `hidden === true` are completely excluded.
3. **Fog Culling**:
   - Tokens standing on fogged cells are not rendered.
   - Images completely shrouded by fog are culled from rendering to avoid revealing bounds.
4. **Auto-Framing (`FocusRect`)**:
   - If `state.focusRect` is non-null, the camera smoothly animates to frame the focus box.
   - If `state.focusRect` is null, the camera frames the entire active map bounds.
5. **Token Animation Easing**:
   - When a token moves, instead of instantly snapping, the display interpolates position smoothly over **250ms** with an ease-out curve.
6. **Active Combatant Indicator**:
   - During combat, the active combatant displays an animated golden glow ring.
7. **Roll Result Ticker**:
   - Floating banner in the bottom-right showing the latest 10 rolls (filtered by visibility, unveiled only after dice settle).

---

## 5. Domain Models & Wire Contract

### 5.1 Domain Types (`src/game/domain.ts`)

`GameMap` already contains:
```ts
export interface GameMap {
  // ...
  readonly markupSvg: string | null;
}
```

### 5.2 Wire Intents (`src/game/types.ts`)

```ts
export type Intent =
  // ... existing intents ...
  | { readonly kind: "updateMarkup"; readonly mapId: string; readonly markupSvg: string | null }
  | { readonly kind: "clearMarkup"; readonly mapId: string };
```

### 5.3 Narrowed Patches (`src/game/types.ts`)

```ts
export type Patch =
  // ... existing patches ...
  | { readonly kind: "markup"; readonly mapId: string; readonly markupSvg: string | null };
```

---

## 6. Authority Engine & Rules (`src/game/rules.ts`)

### 6.1 Permission & Validation
- Only the DM (`isDm(state, fromId)`) may call `updateMarkup` or `clearMarkup`.
- Non-DM attempts are silently dropped.
- **Sandbox-Safe SVG Sanitization**:
  - The authority operates in a deterministic JS sandbox without `DOMParser`, `document`, or `window`.
  - SVG validation must use pure string/regex allowlisting:
    - Enforces `<svg>`, `<g>`, `<path>`, `<circle>`, `<rect>` elements and harmless attributes (`stroke`, `stroke-width`, `fill`, `d`, `r`, `cx`, `cy`, `x`, `y`).
    - Strictly rejects any `<script>`, `href`, `xlink:href`, `onload`, or external resource references.
- `markupSvg` string length is capped at **200,000 characters** to protect WebSocket frame budgets.
- Updates emit `{ kind: "markup", mapId, markupSvg }`.

---

## 7. Client Replica & Phaser Scene Integration

### 7.1 `MatchView.applyPatch`
```ts
case "markup": {
  const nextMaps = this._state.maps.map((m) => {
    if (!isFullMap(m) || m.id !== patch.mapId) return m;
    return { ...m, markupSvg: patch.markupSvg };
  });
  this._state = { ...this._state, maps: nextMaps };
  break;
}
```

### 7.2 Phaser Render Hook
In `MapScene.ts`:
- Maintain an SVG rendering layer or dynamic texture between the image layers and token containers.
- Re-render SVG whenever `markupSvg` changes.

---

## 8. Scoped CSS Migration

Create `src/ui/styles/markup.css` and `src/ui/styles/display.css`:

```css
/* src/ui/styles/markup.css */
.dndm-markup-canvas {
  position: absolute;
  inset: 0;
  cursor: crosshair;
  z-index: 70;
  touch-action: none;
}

.dndm-markup-canvas--panning {
  pointer-events: none !important;
}

.dndm-markup-palette {
  position: absolute;
  top: var(--dndm-spacing-md);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--dndm-spacing-xs);
  background: var(--dndm-color-surface-translucent);
  backdrop-filter: blur(8px);
  padding: var(--dndm-spacing-xs) var(--dndm-spacing-sm);
  border-radius: var(--dndm-radius-pill);
  border: 1px solid var(--dndm-color-border);
  z-index: 100;
}

/* src/ui/styles/display.css */
.dndm-display-view {
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
  user-select: none;
}

.dndm-display-roll-ticker {
  position: absolute;
  bottom: var(--dndm-spacing-lg);
  right: var(--dndm-spacing-lg);
  display: flex;
  flex-direction: column-reverse;
  gap: var(--dndm-spacing-xs);
  max-width: 320px;
  pointer-events: none;
  z-index: 120;
}
```

---

## 9. Verification & Acceptance Criteria

### Automated Unit Tests
1. **`src/game/markup.test.ts`**:
   - `updateMarkup` applies SVG string to specified map.
   - Rejects payload if caller is not DM.
   - Enforces 200 KB size ceiling guard.
2. **`src/ui/display/displayProjection.test.ts`**:
   - Filters out hidden tokens and hidden images.
   - Culls tokens that fall on fogged cells according to bitset.
   - Resolves focus rectangle framing coordinates accurately.
3. **`src/ui/markup/bezier.test.ts`**:
   - Catmull-Rom / Bezier smoothing accurately generates smooth quadratic curves from raw pointer input.
   - Eraser distance calculation detects path hits within radius.

### Acceptance Checklist ("Done when")
- [ ] DM can arm Markup tool from toolbar and draw smooth vector lines.
- [ ] Holding `Space` allows panning without exiting the markup tool.
- [ ] Drawing commits cleanly on pointerup and synchronizes to player tabs.
- [ ] Eraser tool deletes individual strokes.
- [ ] Undo and Redo work locally during active drawing session.
- [ ] In Projector View, fog of war renders at 100% pitch black.
- [ ] Hidden tokens and fog-shrouded tokens are invisible in Projector View.
- [ ] Moving tokens in Projector View animate smoothly over 250ms.
- [ ] `npm test && npm run typecheck && npm run lint` pass cleanly.
