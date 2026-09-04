# 03 — Domain Model

The legacy C# records translated to TypeScript. Everything here crosses the authority boundary, so
everything here must be **strict JSON**.

## The two rules that govern this whole document

### 1. Cell units, everywhere

**1 unit = 1 grid cell.** Not pixels. `CellPixels` is a *rendering* concern and converts cells → px
at draw time only.

| Thing | Anchor | Example |
| --- | --- | --- |
| **Token** | **cell centre** | a token in cell (3,4) has `x: 3.5, y: 4.5` |
| **Image** | **corner** | an image at cell (3,4) has `x: 3, y: 4` |
| **Fog** | cell index | `bit = cy * widthCells + cx` |
| **Focus rect** | corner | `x, y, width, height` in cells |

Getting this wrong does not crash — it silently misplaces everything by half a cell and corrupts
every `.vtf` written. **Encode it in the type names and the tests.**

### 2. Strict JSON

No `undefined` (use `null`), no `Date`/`Map`/`Set`, no class instances, no functions, no cycles.
The C# side uses `ImmutableArray`/`ImmutableDictionary` and `init`-only records; in TypeScript use
`readonly` arrays and `Readonly<Record<…>>`, and treat every object as frozen.

> **The C# mutation discipline matters for a subtle reason.** Legacy mutates by wholesale
> replacement (`with`), because the auto-save dirty check compares object *references*. In-place
> mutation would silently drop saves. The port has the same hazard in a different place:
> `KBAuthority` deep-freezes the replicated view under dev checks, so mutating it throws — but only
> locally. Treat replicas as immutable everywhere.

## Core records

### `GridConfig`

```ts
/** Square grids only. There is no hex support in the legacy model. */
export interface GridConfig {
  widthCells: number;      // default 30
  heightCells: number;     // default 20
  cellPixels: number;      // default 50 — cells → CSS px
  showGridLines: boolean;  // default true
  snapToGrid: boolean;     // default true
  lineColor: string;       // default "#222"
}
```

5 ft per square (`MapCanvas.FeetPerSquare = 5.0`).

### `Map`

```ts
export interface GameMap {
  id: string;                       // Guid "D" format
  name: string;
  grid: GridConfig;
  images: readonly MapImage[];
  tokens: readonly Token[];
  createdUtc: string;               // ISO 8601 — NOT a Date
  listOrder: number;

  /** Where new tokens spawn. `null`, never undefined. */
  defaultSpawnPosition: { x: number; y: number } | null;

  /** Serialized SVG inner markup from the host's freehand drawing. */
  markupSvg: string | null;

  /** Packed row-major bitset, base64-encoded. Decoded length = ceil((w*h)/8). */
  fogMask: FogMaskB64;

  /** Memoization keys for marshalling — see below. */
  fogVersion: number;
  imagesVersion: number;
  imagesMembershipVersion: number;
}
```

**Fog has two representations, and mixing them up is a silent-corruption bug.** Name them:

```ts
/** Base64. The ONLY form that crosses the wire or lands in `.vtf` / IndexedDB. */
export type FogMaskB64 = string;

/** Decoded bytes. The ONLY form the bit maths operates on. */
export type FogMaskBytes = Uint8Array;

export function decodeFog(b64: FogMaskB64): FogMaskBytes { /* atob → Uint8Array */ }
export function encodeFog(bytes: FogMaskBytes): FogMaskB64 { /* → btoa */ }
```

**Fog bit layout — reproduce exactly.** Note the parameter type: this takes **decoded bytes**.
Indexing the base64 string directly yields a character, not a byte, and produces a plausible-looking
map with the wrong cells hidden.

```ts
export function isFogged(mask: FogMaskBytes, grid: GridConfig, cx: number, cy: number): boolean {
  if (mask.length === 0) return false;              // empty ⇒ all revealed (see below)
  const bit  = cy * grid.widthCells + cx;
  const byte = bit >> 3;
  return (mask[byte] & (1 << (bit & 7))) !== 0;
}
```

Verified against legacy (`Map.cs`), which does exactly this, guarded by
`if (mask.IsDefaultOrEmpty) return false;` and commented *"Default (empty) means 'all cells
revealed'"*.

> **An empty mask means "all revealed", not "all fogged".** A zero-length or all-zero array is the
> default state of a new map. Getting this backwards inverts fog for the whole campaign.

**A cell index is also the wire format for fog edits.** `06`'s `paintFog` intent carries
`cells: readonly number[]` of `cy * widthCells + cx` values — the same layout, so there is one
formula in the codebase and no `"cx,cy"` strings anywhere. See
[`05`](05-rendering.md#fog-painting).

The three `*Version` counters exist purely as memoization keys for the legacy JS marshalling layer.
**The port very likely does not need them** — Phaser holds live objects rather than re-marshalling
arrays each render. Keep them only if `.vtf` round-tripping needs them (it does not; they are not
persisted). Drop them and note the decision.

### `MapImage`

```ts
export interface MapImage {
  id: string;
  name: string;
  contentType: string;              // "image/png" | "image/jpeg" | "image/webp"

  /** Legacy: a Guid for /blob-share/{token}. NEVER persisted.
   *  In the port this becomes the blob-share handle — see 08 and 09. */
  shareToken: string | null;

  // Geometry, in CELL units, CORNER-anchored.
  x: number; y: number;
  width: number; height: number;
  originalWidth: number;            // intrinsic size, in cells
  originalHeight: number;
  rotation: number;                 // DEGREES (convert for Phaser)
  opacity: number;                  // 0..1, default 1

  /** Draw order. NOT a Phaser depth — it is an arbitrary integer and may exceed the
   *  scene's depth bands. Sort by it and use the rank; see 05-rendering.md. */
  layerOrder: number;
  locked: boolean;
  hidden: boolean;

  // Provenance for the downscale pipeline.
  byteSize: number;
  wasDownscaled: boolean;
  originalLongEdgePx: number;
  displayLongEdgePx: number;
}
```

`displayName` is derived: `name ?? "Layer #{layerOrder}"`.

### `Token`

```ts
export type TokenType = "PlayerToken" | "NPCToken";
export type TokenIconKind = "Initial" | "Solid";

export interface Token {
  id: string;
  type: TokenType;
  ownerUserId: string | null;       // not persisted
  representsUserId: string | null;  // not persisted
  name: string;
  color: string;
  iconKind: TokenIconKind;
  mapId: string;

  /** CELL units, at cell CENTRES (x.5, y.5). */
  x: number; y: number;

  sheetId: string | null;
  hidden: boolean;
}
```

Render geometry, in cells: **radius `0.45`**, owner halo `0.55`, stack chips `0.4`.

### `MapSummary`, `NewToken`, `NewMapImage`

Referenced by [`06`](06-state-and-authority.md)'s `Intent` and `Patch` unions, so they are v1 types,
not phase-6 stubs.

```ts
/** What a client holds for a map it is NOT currently rendering. Metadata only —
 *  no tokens, no images, no fog. This is what bounds the snapshot. */
export interface MapSummary {
  id: string;
  name: string;
  listOrder: number;
  widthCells: number;
  heightCells: number;
}

/** A spawn request. The authority mints the id, so the client cannot choose one. */
export type NewToken = Omit<Token, "id" | "mapId" | "ownerUserId" | "representsUserId">;

/** An image the DM has already stored locally; only metadata crosses the wire.
 *  `shareToken` is filled in by the authority once the blob is registered. */
export type NewMapImage = Omit<MapImage, "id" | "shareToken" | "layerOrder">;
```

### `FocusRect` and `CenterViewportRequest`

```ts
/** Transient — never persisted. Drives the display view's viewBox. */
export interface FocusRect {
  mapId: string;
  x: number; y: number; width: number; height: number;   // cells, corner-anchored
}

/** Transient. The nonce is what makes a repeat request to the same cell take effect. */
export interface CenterViewportRequest {
  mapId: string;
  x: number; y: number;
  nonce: string;
}
```

## Character sheets and attributes (phase 6+)

Recorded now so the `.vtf` importer can round-trip them even while the UI is deferred.

```ts
export interface CharacterSheet {
  id: string;
  ownerUserId: string | null;       // not persisted
  representsUserId: string | null;
  characterName: string;
  values: Readonly<Record<string, AttributeValue>>;
  notes: string;                    // markdown (legacy renders via Markdig)
  hp: number | null;
  maxHp: number | null;
  armorClass: number | null;
  color: string;
  scopedMapId: string | null;
  statusEffects: readonly StatusEffect[];
  rollTemplates: readonly RollTemplate[];
}

/** Factory-only in C#: Score(int) | Modifier(int) | Text(string). */
export type AttributeValue =
  | { kind: "Score";    value: number }
  | { kind: "Modifier"; value: number }
  | { kind: "Text";     value: string };

/** For Score: floor((score - 10) / 2). */
export function getModifier(v: AttributeValue): number { /* … */ }

export type AttributePreset =
  | "DnD5eCore"                // STR DEX CON INT WIS CHA
  | "DnD5ePlusCommonSkills"    // + Athletics Stealth Perception Persuasion Investigation
  | "SimpleD20"                // a single "Modifier"
  | "Custom";
```

## Dice and combat (phase 6+)

```ts
export interface DiceTerm { count: number; sides: number }
// Allowed sides: 4, 6, 8, 10, 12, 20, 100.  Max 20 dice per roll.

export type RollMode = "Normal" | "Advantage" | "Disadvantage";

export interface RollResult {
  id: string;
  rollerUserId: string;
  forcedByUserId: string | null;
  rolls: readonly DieRoll[];
  total: number;
  mode: RollMode;
  flatModifier: number;
  attributeModifier: number;
  label: string;
  timestampUtc: string;
  formula: string;
  modifierBreakdown: string;
  tokenId: string | null;
  appliedRules: readonly string[];
  // originalDice / originalAttributeRef preserved for loaded-dice auditing
}

export type RollTemplateScope = "BuiltIn" | "Global" | "Sheet";
// 9 built-ins carry deterministic GUIDs d0000000-…-0000000101..109.

export type CombatPhase = "…";
export interface CombatState {
  phase: CombatPhase;
  roundNumber: number;
  currentTurnIndex: number;
  turnOrder: readonly CombatantEntry[];
}
```

### Loaded dice — polymorphic, `$kind`-discriminated

```ts
export interface LoadedDiceRule {
  id: string; name: string; enabled: boolean;
  targetSheetIds: readonly string[];   // Guid.Empty is the "GM" sentinel
  conditions: readonly LoadedDiceCondition[];
  modifications: readonly LoadedDiceModification[];
}
```

Conditions: `currentMap`, `diceTypeRolled`, `rollerIs`, `rollModeIs`, `hostKeyHeld`,
`combatActive`, `rollLabelContains`, `allOf`, `anyOf`, `not`.
Modifications: `setResult`, `clampMax`, `clampMin`, `biasLower`, `biasHigher`, `rerollOn`.

The `$kind` discriminator maps cleanly onto a TS discriminated union — keep the same literal
strings so `.vtf` payloads deserialize unchanged.

## Session settings

```ts
export interface DndMapperSettings {
  tokenMovement: "OwnerOrHost" | "Anyone" | "HostOnly";
  sheetEditByOthers: "HostOnly" | "OwnersAndHost" | "Anyone";
  rollsVisibleToPlayers: boolean;
  playersCanCreateNPCs: boolean;
  hpTrackingEnabled: boolean;
  playersCanSeeOtherSheets: boolean;
  loadedDiceEnabled: boolean;
  loadedDiceRuleVisibility: string;
  loadedDicePlayerIndicator: string;
}
```

> **"Host" in these enums means the DM**, which in the port is the lobby **owner** (`isOwner`), not
> `isHost` — see [`02-target-platform.md`](02-target-platform.md). Consider renaming the variants to
> `OwnerOrDm` / `DmOnly` during the port and mapping the old names on `.vtf` import, so no
> downstream code is tempted to reach for `isHost`.

## Top-level state

```ts
export interface DndMapperState {
  phase: DndMapperPhase;
  settings: DndMapperSettings;
  attributeSchema: AttributeSchema;
  maps: readonly GameMap[];
  activeMapId: string | null;
  sheets: Readonly<Record<string, CharacterSheet>>;
  customTemplates: Readonly<Record<string, NamedTemplate>>;
  rollLog: readonly RollResult[];          // capped at 50
  globalRollTemplates: readonly RollTemplate[];
  activeSchemaTemplateId: string | null;
  initiativeAttributeName: string | null;
  activeCombat: CombatState | null;
  pendingCenterRequest: CenterViewportRequest | null;
  focusRect: FocusRect | null;
  bytesUsed: number;
  loadedDiceRules: readonly LoadedDiceRule[];
  hostHeldKeys: readonly string[];         // a Set in C#; an array on the wire

  /** The DM. Seeded from `init(players)[0].id`, and changed ONLY when this module
   *  calls `kb.setOwner` — nothing else can tell us. Explicit in state so every
   *  permission check and DM succession is testable. See 06. */
  dmPlayerId: string | null;
}
```

> **`bytesUsed` is DM-local accounting, not shared state.** It tracks the DM's own IndexedDB usage
> against legacy's 1 GB/room cap ([`08`](08-assets-pipeline.md#storage-pressure)) and means nothing
> to a player. Keep it out of the replicated state and off
> [`06`](06-state-and-authority.md#strategy--three-rules)'s wire; it is listed here only because the
> legacy record carries it.

**This is not `MatchState`.** Sending all of it on every change would blow the 512 KiB ceiling.
See [`06-state-and-authority.md`](06-state-and-authority.md) for how it is partitioned, and which
parts stay client-local.

## Pure helpers worth porting verbatim

`Helpers/` is 1,432 lines across 19 static classes (21 files; two are records). Pure functions with no Blazor
dependency — the cheapest, highest-confidence part of the whole port, and they belong in
`src/game/` where the authority can share them.

| Helper | Why it matters |
| --- | --- |
| `SnapToGridHelper` | The centre-vs-corner distinction lives here. Port first, test first. |
| `FogPolygonBuilder` | **Do not port** — see [`05-rendering.md`](05-rendering.md). Superseded by a texture. |
| Dice notation parse/format | Exact formula strings appear in the roll log |
| Colour contrast | Picks readable token label colours |
| Token stacking | Decides when tokens collapse into a stack and how chips fan out |
| Visibility filters | Who may see which token/sheet — becomes authority-side logic |

### Snapping, in TypeScript

```ts
/**
 * Tokens are ALWAYS clamped to the map — but to a different range depending on snapping,
 * which is easy to miss. Legacy's SnapToGridHelper.Snap has both branches:
 *   snapping ON  → round to a cell centre, clamp to [0.5, W - 0.5]
 *   snapping OFF → no rounding, but still clamp, to [0, W]
 * Dropping the second branch lets a token be dragged off the map, which legacy prevents.
 */
export function snapToken(x: number, y: number, grid: GridConfig) {
  if (!grid.snapToGrid) {
    return {
      x: clamp(x, 0, grid.widthCells),
      y: clamp(y, 0, grid.heightCells),
    };
  }
  return {
    x: clamp(Math.round(x - 0.5) + 0.5, 0.5, Math.max(0.5, grid.widthCells  - 0.5)),
    y: clamp(Math.round(y - 0.5) + 0.5, 0.5, Math.max(0.5, grid.heightCells - 0.5)),
  };
}

/**
 * Images snap to CORNERS and are deliberately NOT clamped — they may sit off-map.
 * With snapping off, legacy returns the raw position unchanged.
 */
export function snapCorner(x: number, y: number, grid: GridConfig) {
  if (!grid.snapToGrid) return { x, y };
  return { x: Math.round(x), y: Math.round(y) };
}
```

The asymmetry is deliberate in legacy and commented there: tokens are creatures on a battlefield and
belong on it; images are scenery and may hang off the edge. Test both branches of both functions.

Resize snaps *both* the anchor corner and the drag corner, then recomputes width/height. Minimum
dimension `0.1` cells.

## Ranges and invariants to assert in tests

| Invariant | Value |
| --- | --- |
| Zoom | `0.01 … 10.0` |
| Fog brush radius | `1 … 3` |
| Token radius | `0.45` cells |
| Image minimum dimension | `0.1` cells |
| Roll log cap | 50 entries |
| Dice sides | `{4, 6, 8, 10, 12, 20, 100}` |
| Max dice per roll | 20 |
| Feet per square | 5 |
| Image upload cap | 100 MB/file, 1 GB/room |
| Image long edge | ≤ `min(WebGL2 MAX_TEXTURE_SIZE, 8192)` px |
| Ruler distance | **Chebyshev** for 5e squares; Euclidean shown alongside |
