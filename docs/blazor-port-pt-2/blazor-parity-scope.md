# DnD Mapper — Blazor Parity Scope (Part 2)

This document defines the complete scope, technical architecture, and implementation plan required to bring **`DnD-Mapper`** (TypeScript, Phaser 4, Lit 3) to 100% functional, visual, and behavioral parity with the legacy **`KnockBox.DndMapper`** Blazor Server plugin (~31,900 lines).

---

## 1. Executive Summary & Baseline

### The Port So Far (Part 1 Baseline)
Part 1 ([`docs/blazor-port/`](../blazor-port/README.md)) established the standalone KnockBox game and implemented the **Core Mapper (v1 / Phases 0–5 & 7–9)** with **245 passing automated tests**:
- **Rendering & Geometry**: Phaser 4 scene ([`MapScene.ts`](../../src/ui/map/MapScene.ts)) with strict cell-unit coordinates, camera midpoint correction, clamped grid rendering, 1-texel/cell fog of war bitset ([`fogLayer.ts`](../../src/ui/map/fogLayer.ts)), token layering & chip stacking ([`tokenLayer.ts`](../../src/ui/map/tokenLayer.ts)), Chebyshev ruler ([`rulerOverlay.ts`](../../src/ui/map/rulerOverlay.ts)), and focus box overlay ([`focusOverlay.ts`](../../src/ui/map/focusOverlay.ts)).
- **Asset Pipeline & Blob Share**: Image downscaler worker, WebGL2 texture size probe, `IdbBlobTransport` and `HttpBlobTransport` ([`blobTransport.ts`](../../src/assets/blobTransport.ts)), and image inspector transform handles ([`dndm-image-inspector.ts`](../../src/ui/canvas/dndm-image-inspector.ts)).
- **Persistence & VTF Import**: IndexedDB sharded auto-save with SHA-256 fingerprinting ([`libraryService.ts`](../../src/storage/libraryService.ts)), and `.vtf` ZIP import stream ([`import.ts`](../../src/vtf/import.ts)).
- **Authority & UI Shell**: Lit application shell ([`dndm-app.ts`](../../src/ui/app/dndm-app.ts)), DM/player rail gating, rail resizing/collapse with `sessionStorage` persistence, toolbar ([`dndm-toolbar.ts`](../../src/ui/canvas/dndm-toolbar.ts)), map list ([`dndm-map-list.ts`](../../src/ui/panels/dndm-map-list.ts)), layer panel ([`dndm-layer-panel.ts`](../../src/ui/panels/dndm-layer-panel.ts)), token panel ([`dndm-token-panel.ts`](../../src/ui/panels/dndm-token-panel.ts)), and saves panel ([`dndm-saves-panel.ts`](../../src/ui/panels/dndm-saves-panel.ts)).

### The Mission of Part 2
Part 1 deliberately deferred all non-mapper RPG subsystems to de-risk rendering, state synchronization, and platform asset sharing (Decision `D1` in [`00-decisions.md`](../blazor-port/00-decisions.md)). Part 2 covers everything remaining in `KnockBox.DndMapper`:
1. **Character Sheets & Attribute Schemas**
2. **3D Physics Dice Rolling, Roll Log & Roll Templates**
3. **Loaded Dice Engine & DM Secret Tampering**
4. **Initiative & Combat Tracker**
5. **Freehand Canvas Markup Overlay**
6. **Display / Projector Theater Mode**
7. **Campaign Exporter (.vtf Packager)**
8. **Player Lifecycle & Character Abandonment Reassignment**
9. **Remaining Sandboxed Authority Verbs (~40 Verbs)**
10. **Scoped CSS Migration & Light DOM Namespacing**

---

## 2. Baseline vs. Remaining Scope Matrix

| Subsystem | Legacy Implementation (`KnockBox.DndMapper`) | Current Port (`DnD-Mapper`) | Parity Status |
| :--- | :--- | :--- | :--- |
| **Grid & Viewport** | `SnapToGridHelper.cs`, `dndMapperViewport.js` | `snapping.ts`, `viewport.ts`, `MapScene.ts` | **Complete** |
| **Map Images** | `MapCanvas.razor`, `dndMapperBitmapCanvas.js`, `dndMapperImageDrag.js` | `imageLayer.ts`, `dndm-image-inspector.ts` | **Complete** |
| **Tokens & Stacking** | `TokenLayer.razor`, `TokenStackGrouper.cs`, `dndMapperTokenDrag.js` | `tokenLayer.ts`, `stacking.ts`, `dndm-token-panel.ts` | **Complete** |
| **Fog of War** | `FogPolygonBuilder.cs` (traced SVG path), `dndMapperFogPaint.js` | `fogLayer.ts` (1-texel canvas texture, brush radii 1–3) | **Complete** |
| **Ruler & Focus Box** | SVG overlays in `MapCanvas.razor`, `dndMapperFocusDrag.js` | `rulerOverlay.ts`, `focusOverlay.ts` | **Complete** |
| **Blob Sharing** | ASP.NET `/blob-share/{token}` endpoint | `IdbBlobTransport` & `HttpBlobTransport` | **Complete** |
| **Persistence & Auto-Save** | `DndMapperLibraryService.cs` (sharded IndexedDB v3) | `libraryService.ts` (sharded IndexedDB v1) | **Complete** |
| **VTF Import** | `VtfPackager.cs` (unpack), `VtfDocument.cs` | `vtf/import.ts`, `vtf/unzip.ts` | **Complete** |
| **UI Shell & Rails** | `DndMapperPlayingPhase.razor`, `dndMapperRailResize.js` | `dndm-app.ts`, `panels.css`, `shell.css` | **Complete** |
| **Character Sheets** | `CharacterSheetPanel.razor`, `AttributeSchema.cs`, `AttributeValue.cs` | Stubs in `domain.ts`, no UI or authority logic | **Pending (Phase 6)** |
| **Status Effects** | `StatusEffectsPanel.razor`, `StatusEffectTemplateLibraryModal.razor` | Stubs in `domain.ts`, no UI or authority logic | **Pending (Phase 6)** |
| **3D Dice Rolling** | `dice-box-threejs`, `DiceCanvas.razor`, `DiceAnimationTracker.cs` | Stubs in `dice.ts`, no 3D canvas, no audio/textures | **Pending (Phase 7)** |
| **Roll Log & Templates** | `QuickRollFooter.razor`, `RollLogPanel.razor`, `RollTemplate.cs` | Wire models exist in `types.ts`, no UI or log logic | **Pending (Phase 7)** |
| **Loaded Dice** | `LoadedDiceProcessor.cs`, `LoadedDiceRulesPanel.razor`, `dndMapperHostInput.js` | Domain records in `domain.ts`, no evaluation/UI | **Pending (Phase 8)** |
| **Initiative & Combat** | `HostInitiativePanel.razor`, `InitiativeBanner.razor`, `TurnOrderSorter.cs` | `CombatState` record stub, no tracker/turn logic | **Pending (Phase 9)** |
| **Canvas Markup** | `MarkupOverlay.razor`, `Map.MarkupSvg` | `markupSvg` field on `GameMap`, no drawing UI/scene | **Pending (Phase 10)** |
| **Projector View** | `DndMapperDisplay.razor` (dedicated route), `DisplayProjection.cs` | None (needs in-app theater mode / popup window) | **Pending (Phase 10)** |
| **VTF Export** | `VtfPackager.cs` (pack), `dndMapperVtfPackager.js` | None (import only) | **Pending (Phase 11)** |
| **Player Lifecycle** | `HandlePlayerLeft` -> convert to NPC, `RepresentsUserId` | Non-owner leave tolerated, but no token conversion | **Pending (Phase 11)** |

---

## 3. Subsystem Detailed Scopes

---

### Subsystem 1: Character Sheets, Attribute Schemas & Status Effects

#### 1. Legacy References
- `Services/State/Games/Data/CharacterSheet.cs`
- `Services/State/Games/Data/AttributeSchema.cs`, `AttributeRow.cs`, `AttributeValue.cs`, `AttributeDelta.cs`, `AttributeRef.cs`
- `Models/AttributePreset.cs`, `Models/AttributeValueType.cs`, `Models/SheetEditPolicy.cs`
- `Services/State/Games/Data/StatusEffect.cs`, `StatusEffectTemplate.cs`
- `Pages/Components/CharacterSheetPanel.razor` (and `.cs`, `.css` — 610 lines C#, 490 lines CSS)
- `Pages/Components/SheetSettingsModal.razor`, `SchemaPresetSelector.razor`, `SchemaCascadeWarningModal.razor`
- `Pages/Components/StatusEffectsPanel.razor`, `StatusEffectTemplateLibraryModal.razor`
- `Helpers/AttributeContributionResolver.cs`, `EffectiveMaxHpResolver.cs`, `NotesMarkdownRenderer.cs`, `SheetVisibilityHelper.cs`

#### 2. Domain & Mechanics Requirements
- **Sheet Entity**:
  ```ts
  export interface CharacterSheet {
    readonly id: string;
    readonly ownerUserId: string | null;
    readonly representsUserId: string | null; // Set when original player disconnects
    readonly characterName: string;
    readonly values: Readonly<Record<string, AttributeValue>>;
    readonly notes: string; // Markdown formatted
    readonly hp: number | null;
    readonly maxHp: number | null;
    readonly armorClass: number | null;
    readonly color: string; // Takes precedence over token color if non-empty
    readonly scopedMapId: string | null; // Filter sheets by active map
    readonly statusEffects: readonly StatusEffect[];
    readonly rollTemplates: readonly RollTemplate[];
  }
  ```
- **Attribute Value Types**:
  - `Score(value)`: Ability scores (e.g. 10..20). Standard 5e modifier calculation: `Math.floor((score - 10) / 2)`.
  - `Modifier(value)`: Direct modifier (e.g. +3).
  - `Text(value)`: Text field.
- **Attribute Presets**:
  - `DnD5eCore`: STR, DEX, CON, INT, WIS, CHA (Score).
  - `DnD5ePlusCommonSkills`: Core 6 + Athletics, Stealth, Perception, Persuasion, Investigation (Modifier).
  - `SimpleD20`: Single `Modifier` row.
  - `Custom`: Fully user-defined rows.
- **HP & Combat Calculations**:
  - `EffectiveMaxHpResolver`: Calculates effective maximum HP by summing base `maxHp` with all active `StatusEffect.maxHpDelta` values. Returns `null` when `sheet.maxHp` is `null`. Clamping to effective max occurs when HP updates, not inside the resolver itself; the resolver does not clamp to 1 and does not adjust for temporary HP (which is not in the domain model).
  - `StatusEffect.onApplyHpDelta`: One-time, non-reversing adjustment applied to current HP when the effect is added (inside the same engine transaction), clamped to effective max HP. It is not reversed on effect removal.
  - HP Bar rendering with current HP, max HP, and unconscious / dead indicator when HP ≤ 0.
- **Notes & Markdown**:
  - Embedded Markdown notes editor with rendered preview. Replace legacy Markdig with a client-side parser (e.g. `snarkdown` or lightweight zero-dependency parser).
- **Token Linkage**:
  - When `Token.sheetId` is set, token resolves its color from `CharacterSheet.color`.
  - Double-clicking a token on the Phaser canvas triggers `openSheet(token.sheetId)` in the right rail.

#### 3. Authority Verbs to Implement
- `createSheet(characterName, scopedMapId)`
- `updateSheet(sheetId, patch)` (name, color, scopedMapId, notes)
- `deleteSheet(sheetId)`
- `duplicateSheet(sheetId)`
- `assignSheetOwner(sheetId, ownerUserId)`
- `setSheetHp(sheetId, hp)`
- `setSheetMaxHp(sheetId, maxHp)`
- `setSheetAc(sheetId, ac)`
- `updateAttributeValues(sheetId, values)`
- `setSchemaPreset(preset)`
- `updateSchemaRows(rows, initiativeAttributeName)`
- `saveCustomTemplate(name)`
- `createCustomTemplate(template)`
- `deleteCustomTemplate(templateId)`
- `updateCustomTemplate(templateId, patch)`
- `renameCustomTemplate(templateId, name)`
- `applyCustomTemplate(templateId)`
- `applyStatusEffect(sheetId, effect)`
- `updateStatusEffect(sheetId, effectId, patch)`
- `removeStatusEffect(sheetId, effectId)`
- `createStatusEffectTemplate(template)`
- `updateStatusEffectTemplate(templateId, patch)`
- `deleteStatusEffectTemplate(templateId)`

#### 4. UI Components (Lit)
- `<dndm-character-sheet>`: Main right-rail container. Roster list (scoped to active map or all), active sheet details, ability stats, HP tracker, AC badge, color picker.
- `<dndm-sheet-settings-modal>`: Configure sheet permissions, delete sheet, change owner.
- `<dndm-schema-preset-modal>`: Switch between 5e Core, Skills, Simple d20, and Custom.
- `<dndm-schema-cascade-warning>`: Modal warning when schema changes would orphan existing sheet attribute values.
- `<dndm-status-effects>`: Badge list on character sheet with durations, notes, and quick remove.
- `<dndm-status-effect-library-modal>`: Preset effect conditions (Blinded, Charmed, Deafened, Frightened, Grappled, Incapacitated, Invisible, Paralyzed, Petrified, Poisoned, Prone, Restrained, Stunned, Unconscious, Exhaustion, Concentrating).

---

### Subsystem 2: 3D Physics Dice Rolling, Roll Log & Roll Templates

#### 1. Legacy References
- `Pages/Components/DiceCanvas.razor` (and `.cs`, `.css` — 265 lines C#)
- `Pages/Components/QuickRollFooter.razor` (and `.cs`, `.css` — 333 lines CSS)
- `Pages/Components/RollLogPanel.razor`, `RollLogEntry.razor`
- `Pages/Components/RollHistoryModal.razor`, `RollTemplateLibraryModal.razor`
- `Helpers/DiceNotationBuilder.cs`, `DiceRollSubmitter.cs`, `DiceColorResolver.cs`
- `Services/Logic/DiceAnimationTracker.cs`, `RollLogVisibilityFilter.cs`
- `wwwroot/lib/dice-box-threejs/dice-box.es.js` (17,248 lines)
- `wwwroot/js/dndMapperDiceBox.js` (198 lines)
- 38 `.webp` textures and 75 `.mp3` sounds in `wwwroot/dice/`

#### 2. 3D Dice Simulation & Assets
- **Asset Migration**:
  - Copy the **38 `.webp` textures** (`astral`, `bronze01..04`, `dragon`, `fire`, `ice`, `marble`, `metal`, `stone`, `tiger`, `wood`, etc.) to `public/assets/dice/textures/`.
  - Copy the **75 `.mp3` sound files** (`sounds/dicehit/` 45 + `sounds/surfaces/` 30) to `public/assets/dice/sounds/`.
  - Vendor `dice-box-threejs` (Three.js + Cannon-es physics) into `src/lib/dice-box/` or as an external script bundle.
- **Overlay Canvas & WebGL Context Safety**:
  - Component `<dndm-dice-canvas>`: Transparent overlay positioned over the viewport.
  - **Single WebGL Context**: Rather than allocating separate `DiceBox` instances per user/token (which exhausts the browser's 8–16 WebGL context ceiling and terminates Phaser's battlemap renderer), manage all active tumbling dice inside a **single shared transparent Three.js overlay canvas** with die pooling.
  - **Sound Configuration**: Audio defaults to disabled (`sounds: false`), matching legacy `dndMapperDiceBox.js:89` to prevent Web Audio buffer saturation during multi-die bursts and respect browser autoplay policies. Provide an optional UI audio toggle in settings.
- **Animation Gating (`DiceAnimationTracker`)**:
  - When a roll intent commits, the `RollResult` is broadcast to clients, but `<dndm-roll-log>` and display views **hide the result** until the local 3D dice finish tumbling (tracked by `rollId`).
  - Interrupt handling: If a new roll arrives for the same key while one is animating, instantly settle the previous roll so results are never permanently hidden.

#### 3. Roll Controls & Templates
- **Quick Roll Footer (`<dndm-quick-roll-footer>`)**:
  - Fixed footer on the canvas area.
  - Quick buttons for standard polyhedral dice: **d4, d6, d8, d10, d12, d20, d100**.
  - Count adjuster, flat modifier input (`+3`, `-2`), and custom notation formula input (`2d6 + 1d4 + 3`).
  - Roll mode buttons: **Normal**, **Advantage** (rolls 2d20, takes higher), **Disadvantage** (rolls 2d20, takes lower).
  - Hotkey modifiers: Holding `Shift` clicks with Advantage; holding `Ctrl` clicks with Disadvantage.
- **Roll Templates**:
  - Built-in templates: d4, d6, d8, d10, d12, d20, d100, 2d6, 4d6 (deterministic GUIDs `d0000000-...-0000000101..109`).
  - Global templates authored by the DM (e.g. standard attacks, spell saves).
  - Sheet-scoped templates (character-specific weapons, spells, skill checks with linked attribute modifiers like `DEX`).
  - Scope property: Each template carries `scope: RollTemplateScope` ("BuiltIn" | "Global" | "Sheet").
  - Modal `<dndm-roll-template-library>`: Author, edit, delete templates.

#### 4. Roll Log & History
- **Replicated Roll Log**:
  - Replicated in match state with a **cap of 50 rolls** (`RollLogCap = 50`).
  - Each `RollResult` stores: roller ID, forcedBy ID, timestamp, formula string, modifier breakdown, individual die results (`DieRoll` with `sides`, `value`, `discarded: boolean`), total, mode, flat modifier, attribute modifier, natural 20 / natural 1 flags, applied loaded-dice rules (`LoadedDiceRuleStamp[]`), original dice terms (`DiceTerm[]`), original attribute reference (`AttributeRef | null`), and linked token ID.
- **Visibility Filtering**:
  - `rollsVisibleToPlayers` session setting: Under KnockBox broadcast mode, delta patches are broadcast identically to all peers; when this setting is false, `MatchView` and the UI filter non-DM views so players only see their own rolls client-side (matching Part 1 Decision `D2`).
  - DM can toggle secret rolls.
- **Modal `<dndm-roll-history>`**: Searchable, filterable modal viewing all rolls from the session.

---

### Subsystem 3: Loaded Dice Engine & DM Secret Tampering

#### 1. Legacy References
- `Services/Logic/LoadedDice/LoadedDiceProcessor.cs` (91 lines)
- `Services/State/Games/Data/LoadedDice/LoadedDiceRule.cs`, `LoadedDiceCondition.cs`, `LoadedDiceModification.cs`, `LoadedDiceContext.cs`, `LoadedDiceRuleStamp.cs`
- `Models/LoadedDiceRuleVisibility.cs`, `Models/LoadedDicePlayerIndicator.cs`
- `Pages/Components/LoadedDice/LoadedDiceRulesPanel.razor` (and `.cs`, `.css`)
- `wwwroot/js/dndMapperHostInput.js` (138 lines)

#### 2. Sandboxed Rule Processor
- **Execution Hook**:
  - Evaluates rules purely inside the authority sandbox on every roll before committing the `RollResult`.
- **Target Filtering**:
  - Target character sheet IDs, or unattributed "GM" rolls (`Guid.Empty`), or all rolls.
- **Conditions**:
  - `currentMap`: Matches active map ID.
  - `diceTypeRolled`: Sides match (e.g. 20).
  - `rollerIs`: Matches character sheet ID (`rollerSheetId`), or `GmTarget` (`00000000-0000-0000-0000-000000000000`) for unattributed GM rolls.
  - `rollModeIs`: Normal, Advantage, Disadvantage.
  - `combatActive`: Parameterless flag condition (matches when active combat is in progress).
  - `rollLabelContains`: Substring match on roll label/name.
  - `hostKeyHeld`: DM holds a specific key on their keyboard (e.g. Space, 1, H) when the roll occurs.
  - Compound conditions: `allOf`, `anyOf`, `not`.
- **Modifications**:
  - `setResult`: Force die face to value (clamped to `[1, sides]`).
  - `clampMax`: Cap maximum face.
  - `clampMin`: Floor minimum face.
  - `biasLower`: Roll extra dice (`rerollCount`), keep minimum (or subtract bias).
  - `biasHigher`: Roll extra dice (`rerollCount`), keep maximum (or add bias).
  - `rerollOn`: Reroll once if face is in `values`.
- **Auditing & Stamping**:
  - Matched rule IDs and names are stamped on `RollResult.appliedRules` as `LoadedDiceRuleStamp` objects.
  - `LoadedDiceRuleVisibility`: Under broadcast mode, rule stamps are filtered client-side in player roll log views according to setting (`Hidden` = never shown to players, `VisibleToHostOnly` = rendered only in DM client, `VisibleToAll` = rendered for all players).
  - `LoadedDicePlayerIndicator`: Visual cue on player screen (`None`, `Subtle`, `Obvious`).

#### 3. Host Key Streaming (`dndMapperHostInput.js` Port)
- Track keys currently held by the DM using `keydown`/`keyup`/`blur` listeners on the host browser.
- Ignore key events when the active focused element is an input, textarea, or contenteditable field to prevent text entry from triggering loaded dice rules.
- Normalize key names (e.g. `" "` -> `"Space"`).
- Debounce and send `updateHostKeys` intents to the authority without exceeding the 30 msg/s rate limit.

#### 4. UI Components
- `<dndm-loaded-dice-panel>`:
  - In DM left rail (when `LoadedDiceEnabled` is true in settings): Rule list, enable/disable toggles, rule builder (conditions, modifications, targets).
  - In player right rail: Read-only rule list when `LoadedDiceRuleVisibility` is set to `VisibleToAll`.

---

### Subsystem 4: Initiative & Combat Tracker

#### 1. Legacy References
- `Pages/Components/HostInitiativePanel.razor` (and `.cs`, `.css` — 228 lines CSS)
- `Pages/Components/InitiativeBanner.razor` (and `.cs`, `.css`)
- `Services/State/Games/Data/CombatState.cs`, `CombatantEntry.cs`
- `Helpers/TurnOrderSorter.cs`, `InitiativeAnimationGate.cs`
- `DndMapperGameEngine.cs:1469-2093` (11 combat verbs)

#### 2. Combat State Machine & Rules
- **State Structure**:
  ```ts
  export type CombatPhase = "WaitingForRolls" | "Active";

  export interface CombatantEntry {
    readonly id: string;
    readonly tokenId: string;
    readonly name: string;
    readonly ownerUserId: string | null;
    readonly initiativeRoll: number | null;
    readonly isForceRolled: boolean;
    readonly pendingInitiative: number | null; // DM manual override holding buffer
  }

  export interface CombatState {
    readonly phase: CombatPhase;
    readonly roundNumber: number;
    readonly currentTurnIndex: number;
    readonly turnOrder: readonly CombatantEntry[];
  }
  ```
- **Lifecycle & Turn Order**:
  - `startCombat`: Accepts `npcTokenIds?: readonly string[]` (selected NPC tokens) and automatically pulls in all connected player tokens from the lobby roster, matching legacy `StartInitiativeAsync`. Phase becomes `WaitingForRolls`.
  - Rolling Initiative:
    - Players submit initiative via character sheet (using linked `initiativeAttributeName`, default DEX) or flat d20 via `SubmitInitiativeRollAsync`.
    - DM can force-roll for an unresponsive player via `forceInitiativeRoll(combatantId)`.
    - DM manual entry: `setNpcInitiative` sets `pendingInitiative` so manual scores can be staged without spoiling dice rolls.
    - DM can click **"Roll all unset NPCs"** (`rollAllNpcInitiative`) to flush all staged pending values (back-solving visible d20 faces via `Math.clamp(pending - mod, 1, 20)`) and roll fresh d20s for truly unset NPCs.
  - Sorting (`TurnOrderSorter`):
    - Primary: Descending by initiative score (`initiativeRoll ?? -Infinity`).
    - Secondary (Tie-breaker): Players before NPCs (`ownerUserId !== null ? 0 : 1`).
    - Tertiary (Tie-breaker): Alphabetical by name (`name.localeCompare(other.name, undefined, { sensitivity: "base" })`).
    - *(Note: DEX modifier is factored into the roll total, not used as a tie-breaker).*
  - Combat Execution:
    - Once all combatants have rolls (or DM forces start), phase transitions to `Active`.
    - **Next Turn (`>`)**: Advances `currentTurnIndex`. When reaching end of list, increments `roundNumber` and resets index to 0.
    - **Previous Turn (`<`)**: Reverses turn index; decrements `roundNumber` if wrapping backwards (clamped to minimum 1).
    - **Add Combatant**: Mid-encounter additions require `initiativeRoll: number` so `TurnOrderSorter.findInsertionIndex` inserts them in the correct position without breaking turn indexing.
    - **End Combat**: Resets `CombatState` to null.

#### 3. Map Canvas Integration
- **Active Turn Halo**:
  - The token whose turn is active displays an animated golden glow / selection ring on the Phaser map scene (`ResolveActiveTurnTokenId`).

#### 4. UI Components
- `<dndm-host-initiative>`: DM right-rail panel. Round counter, current turn indicator, next/previous buttons, list of combatants showing HP/MaxHP/AC, status effect chips, roll initiative button, and remove/add combatant controls.
- `<dndm-initiative-banner>`: Compact banner shown to players in the right rail or over canvas. In `WaitingForRolls`, displays "Roll Initiative!" button; in `Active`, highlights current combatant ("Your Turn!" or "Grog's Turn").

---

### Subsystem 5: Freehand Canvas Markup Overlay

#### 1. Legacy References
- `Pages/Components/MarkupOverlay.razor` (and `.cs`, `.css`)
- `MapCanvas.razor:35-42`, `MapCanvas.razor.cs:780-840`
- `Map.MarkupSvg`
- `DndMapperGameEngine.cs:2094-2120` (`UpdateMapMarkupAsync`)

#### 2. Interactive Drawing Surface
- **Overlay Layer**:
  - Interactive SVG/HTML5 canvas drawing overlay positioned over the Phaser map.
  - Toolbar button in `<dndm-toolbar>`: `✎ markup` (DM only).
- **Drawing Tools**:
  - Pen tool: Freehand smoothed SVG paths (Bezier curve fitting).
  - Eraser tool: Erase individual strokes.
  - Color palette: Copper, crimson, emerald, gold, white, black.
  - Stroke thickness presets: 1px, 2px, 4px, 8px.
  - Clear all markup button with confirmation.
  - Local Undo / Redo stack during active drawing session.
- **Coordinate Transformation**:
  - Drawing takes place in CSS pixel coordinates (`viewBox="0 0 W*CellPx H*CellPx"`).
  - On commit, paths are scaled by `1 / CellPixels` so the persisted string is stored in cell units in `GameMap.markupSvg`.
  - This ensures markup scales crisply across all zoom levels (`0.01` to `10.0`) and stays aligned with map coordinates.
- **Interaction Rules**:
  - Holding `Space` temporarily forces pointer-events to pass through, allowing the DM to pan the map while the markup tool is active.

---

### Subsystem 6: Display / Projector Theater Mode

#### 1. Legacy References
- `Pages/DndMapperDisplay.razor` (and `.cs`, `.css` — 513 lines CSS)
- `Helpers/DisplayProjection.cs` (92 lines)
- `wwwroot/js/dndMapperDisplayTokens.js` (121 lines)
- `wwwroot/js/dndMapperDisplayImageFallback.js` (42 lines)

#### 2. Platform Architecture Adaptation
- In legacy, this was a second URL route (`/room/dnd-mapper/{code}/display`).
- In KnockBox-Games, games run as single-entry-point bundles in an iframe.
- **Solution**: Port the display view as an **in-app Theater Mode** (fullscreen button) or **Detached Popup Window** (`window.open('', '_blank')` sharing client state via `BroadcastChannel` or second client instance).

#### 3. Display Projection Rules
- Uses `DisplayProjection`:
  - **Fog of War**: Renders at **1.0 opacity (100% pitch black)**. Unexplored areas are completely dark.
  - **Hidden Entities**: Tokens with `hidden: true` and images with `hidden: true` are completely excluded from rendering.
  - **Fog Culling**: Tokens standing on fogged cells are not rendered. Images completely shrouded in fog are culled.
  - **Focus Rect Framing**: If the DM has set a `FocusRect` (via the focus box tool), the display viewport automatically frames to that rectangle. If null, it fits the active map bounds.
  - **Token Animations**: Uses smooth 250ms ease-out transitions for token movement instead of instant snap.
  - **Active Combatant Indicator**: Golden ring/glow on the active combatant's token during combat.
  - **Roll Result Ticker**: Bottom-right floating ticker displaying the last 10 rolls (filtered by visibility, delayed until 3D dice settle).

---

### Subsystem 7: Campaign Exporter (.vtf Packager)

#### 1. Legacy References
- `Services/Library/Vtf/VtfPackager.cs` (599 lines)
- `Services/Library/Vtf/VtfDocument.cs`
- `wwwroot/js/dndMapperVtfPackager.js` (282 lines)

#### 2. Packaging Specification
- Generates a valid Virtual Table Format v1.0.0 ZIP archive:
  - `manifest.json`: Spec version 1.0.0, campaign metadata.
  - `global_state.json`: Custom templates, global roll templates, settings, attribute schema, and `vendorData.knockbox_dnd_mapper.loadedDiceRules` (matching legacy `VtfPackager.cs` and target `src/vtf/import.ts:504`).
  - `scenes/scene_{mapId}.json`: Grid config, fog bitset, token instances, image layer order.
  - `entities/entity_{tokenId}.json` & `entities/sheet_{sheetId}.json`: Token and sheet definitions.
  - `assets/images/{imageId}.[png|jpg|webp]`: Raw image blobs extracted from IndexedDB.
  - `extensions/knockbox_dnd_mapper.json`: Active combat state (`ActiveCombat`) and phase (`Phase`) only.
- Pure browser ZIP creation using `CompressionStream('deflate-raw')`, local headers, central directory, and EOCD (porting `dndMapperVtfPackager.js`).
- Triggers browser file download: `{CampaignName}_{yyyyMMdd_HHmm}.vtf`.
- **Delayed URL Revocation**: Must use `setTimeout(() => URL.revokeObjectURL(url), 1000)` (matching `dndMapperVtfPackager.js:280`) rather than synchronous cleanup to avoid race conditions causing 0-byte downloaded files.
- **UI**: Add an "Export" button to each slot row in `<dndm-saves-panel>`.

---

### Subsystem 8: Player Lifecycle & Abandonment Reassignment

#### 1. Legacy References
- `DndMapperGameEngine.cs:88-95` (`HandlePlayerLeft`)
- `DndMapperGameEngine.cs:3547-3600` (`ConvertAbandonedPlayerCharacterInternal`, `SpawnPlayerTokenInternal`)

#### 2. Lifecycle Behaviors
- **Session Start**:
  - Automatically spawn player tokens at `defaultSpawnPosition` (or map center) for all players present in the lobby.
- **Player Disconnect / Leave**:
  - When a non-DM player disconnects:
    - Their token is converted from `PlayerToken` to `NPCToken` so it remains on the board.
    - Set `Token.representsUserId` and `CharacterSheet.representsUserId` to the disconnected player's ID.
    - Display "(originally played by ...)" subtitle in the token and sheet UI.
- **DM Reassignment**:
  - Provide a "Reassign Character" action in `<dndm-token-panel>` and `<dndm-character-sheet>` allowing the DM to assign the abandoned token and sheet to any connected player.

---

### Subsystem 9: Sandboxed Authority Verbs (84 Total Verbs)

#### 1. Legacy References
- `Services/Logic/Games/DndMapperGameEngine.cs` (84 total verbs across 83 async methods, 3,703 lines)

#### 2. Master Verbs Accounting Table

The table below accounts for all 84 legacy verbs across Part 1 (already implemented) and Part 2 (Phases 6–11):

| Category | Verb / Intent | Status | Description |
| :--- | :--- | :--- | :--- |
| **Maps (8)** | `createMap` | Part 1 | Create a new map with dimensions and grid config |
| | `switchMap` | Part 1 | Switch active map for all connected clients |
| | `deleteMap` | Part 1 | Remove map and associated layers/tokens |
| | `renameMap` | Part 1 | Rename map in campaign list |
| | `reorderMaps` | Part 1 | Change display order of maps |
| | `setGridConfig` | Part 1 | Update grid type, size, offset, and color |
| | `duplicateMap` | Part 1 | Duplicate existing map with tokens/fog |
| | `exportMapImage` | Part 1 | Export rendered map snapshot |
| **Fog of War (5)** | `setFogBitset` | Part 1 | Update compressed fog bitset for current map |
| | `fillFog` | Part 1 | Fill entire map with fog |
| | `clearFog` | Part 1 | Clear all fog on current map |
| | `revealAllFog` | Part 1 | Reveal entire map |
| | `hideAllFog` | Part 1 | Hide entire map |
| **Tokens (8)** | `createToken` | Part 1 | Place new token on map |
| | `moveToken` | Part 1 | Move token to target coordinates |
| | `deleteToken` | Part 1 | Delete token from map |
| | `updateToken` | Part 1 | Update token size, elevation, tint, label |
| | `reorderTokens` | Part 1 | Reorder token z-index |
| | `duplicateToken` | Part 1 | Clone token on map |
| | `spawnPlayerToken` | Part 1 | Spawn default player token on lobby join |
| | `reassignTokenOwner` | Phase 11 | Reassign abandoned token to new player |
| **Images (5)** | `placeImage` | Part 1 | Add background/overlay image to map |
| | `transformImage` | Part 1 | Move, scale, or rotate image |
| | `deleteImage` | Part 1 | Remove image from map |
| | `reorderImages` | Part 1 | Change image layer order |
| | `lockImage` | Part 1 | Lock/unlock image against accidental edits |
| **Focus (2)** | `setFocusRect` | Part 1 | Set DM focus framing box |
| | `clearFocusRect` | Part 1 | Reset focus framing box |
| **Saves (3)** | `saveCampaign` | Part 1 | Persist campaign to local slot |
| | `loadCampaign` | Part 1 | Restore campaign from local slot |
| | `deleteCampaignSave` | Part 1 | Delete saved campaign slot |
| **Sheets (10)** | `createSheet` | Phase 6 | Create character sheet |
| | `updateSheet` | Phase 6 | Update name, color, notes, scopedMapId |
| | `deleteSheet` | Phase 6 | Delete character sheet |
| | `duplicateSheet` | Phase 6 | Clone existing sheet |
| | `assignSheetOwner` | Phase 6 | Set ownerUserId or clear to null |
| | `assignCharacterToPlayer` | Phase 11 | Reassign abandoned sheet to active player |
| | `setSheetHp` | Phase 6 | Set current HP |
| | `setSheetMaxHp` | Phase 6 | Set maximum base HP |
| | `setSheetAc` | Phase 6 | Set armor class |
| | `updateAttributeValues` | Phase 6 | Update map of attribute scores/modifiers |
| **Attributes (3)** | `setSchemaPreset` | Phase 6 | Switch preset (5e Core, Skills, d20, Custom) |
| | `updateSchemaRows` | Phase 6 | Add/edit/remove custom attribute rows |
| | `setInitiativeAttribute` | Phase 6 | Choose attribute key used for initiative |
| **Status Effects (6)** | `applyStatusEffect` | Phase 6 | Add status effect instance to sheet |
| | `updateStatusEffect` | Phase 6 | Modify active status effect on sheet |
| | `removeStatusEffect` | Phase 6 | Remove status effect instance from sheet |
| | `createEffectTemplate` | Phase 6 | Add reusable global status effect template |
| | `updateEffectTemplate` | Phase 6 | Update reusable status effect template |
| | `deleteEffectTemplate` | Phase 6 | Remove reusable status effect template |
| **Custom Templates (6)** | `createCustomTemplate` | Phase 6 | Create reusable character template |
| | `updateCustomTemplate` | Phase 6 | Update character template schema/defaults |
| | `deleteCustomTemplate` | Phase 6 | Remove character template |
| | `applyCustomTemplate` | Phase 6 | Instantiate sheet from custom template |
| | `duplicateCustomTemplate` | Phase 6 | Clone custom template |
| | `reorderCustomTemplates` | Phase 6 | Reorder template list |
| **Dice & Rolls (7)** | `rollDice` | Phase 7 | Execute standard dice roll with modifiers |
| | `rollTemplate` | Phase 7 | Roll using a defined RollTemplate |
| | `updateRollTemplate` | Phase 7 | Update sheet-scoped roll template |
| | `createGlobalRollTemplate` | Phase 7 | Create campaign-level global roll template |
| | `updateGlobalRollTemplate` | Phase 7 | Update campaign-level global roll template |
| | `deleteGlobalRollTemplate` | Phase 7 | Remove global roll template |
| | `clearRollLog` | Phase 7 | Clear roll history log (DM only) |
| **Loaded Dice (6)** | `createLoadedDiceRule` | Phase 8 | Create new loaded dice rule |
| | `updateLoadedDiceRule` | Phase 8 | Edit conditions/modifications/targets |
| | `deleteLoadedDiceRule` | Phase 8 | Delete loaded dice rule |
| | `toggleLoadedDiceRule` | Phase 8 | Enable / disable rule |
| | `reorderLoadedDiceRules` | Phase 8 | Change rule priority order |
| | `updateHostKeys` | Phase 8 | Stream DM held keys for condition match |
| **Combat Tracker (11)** | `startCombat` | Phase 9 | Enter WaitingForRolls, populate combatants |
| | `endCombat` | Phase 9 | Clear active combat |
| | `nextTurn` | Phase 9 | Advance turn pointer and round count |
| | `previousTurn` | Phase 9 | Step backwards in turn order (clamp round >= 1) |
| | `rollInitiative` | Phase 9 | Roll initiative for player combatant |
| | `forceInitiativeRoll` | Phase 9 | DM triggers roll for unrolled combatant |
| | `setNpcInitiative` | Phase 9 | Stage pending manual NPC initiative |
| | `rollAllUnsetNpcs` | Phase 9 | Batch roll for all unrolled NPCs |
| | `rollAllNpcInitiative` | Phase 9 | Batch re-roll for all NPCs in combat |
| | `addCombatant` | Phase 9 | Add ad-hoc combatant with initiative roll |
| | `removeCombatant` | Phase 9 | Drop combatant from active combat |
| **Markup Overlay (2)** | `updateMarkup` | Phase 10 | Commit new SVG markup to map |
| | `clearMarkup` | Phase 10 | Clear all SVG markup for current map |
| **Lifecycle (2)** | `endSession` | Phase 11 | Return match to lobby phase |
| | `syncClientState` | Phase 11 | Full state synchronization request |

#### 3. Wire Contract & 512 KiB Frame Protection
- Authority patches must remain **narrowed**:
  - `{ kind: "sheet", sheet: CharacterSheet }` (single sheet)
  - `{ kind: "sheetRemoved", sheetId: string }`
  - `{ kind: "roll", roll: RollResult }` (single roll result appended)
  - `{ kind: "combat", combat: CombatState | null }`
  - `{ kind: "markup", mapId: string, markupSvg: string | null }`
  - `{ kind: "loadedDiceRules", rules: readonly LoadedDiceRule[] }`
- **Rate Limit Defense**:
  - Debounce text input in character sheets (`300 ms`) before emitting intents.
  - Never emit intents on pointer-move (accumulate freehand markup strokes and commit on `pointerup`).

---

### Subsystem 10: Scoped CSS & Lit UI Migration

#### 1. Legacy References
- 34 `.razor.css` files (~4,658 lines)
- `wwwroot/css/panels.css` (634 lines — already ported to `src/ui/styles/panels.css`)

#### 2. CSS Re-namespacing Plan
Because `GameElement` renders into light DOM for global CSS access, all Blazor-scoped CSS must be stripped of `[b-xxxxxxxxxx]` attributes and given explicit `.dndm-*` namespace prefixes:

| Legacy Scoped File | Target CSS File | New Root Selector |
| :--- | :--- | :--- |
| `CharacterSheetPanel.razor.css` (490 lines) | `src/ui/styles/sheet.css` | `.dndm-sheet-panel` |
| `HostInitiativePanel.razor.css` (228 lines) | `src/ui/styles/initiative.css` | `.dndm-initiative-panel` |
| `InitiativeBanner.razor.css` | `src/ui/styles/initiative.css` | `.dndm-initiative-banner` |
| `QuickRollFooter.razor.css` (333 lines) | `src/ui/styles/dice.css` | `.dndm-quick-roll` |
| `DiceCanvas.razor.css` | `src/ui/styles/dice.css` | `.dndm-dice-canvas` |
| `RollLogPanel.razor.css` & `RollLogEntry.razor.css` | `src/ui/styles/dice.css` | `.dndm-roll-log` |
| `LoadedDiceRulesPanel.razor.css` | `src/ui/styles/loaded-dice.css` | `.dndm-loaded-dice` |
| `StatusEffectsPanel.razor.css` (216 lines) | `src/ui/styles/status-effects.css` | `.dndm-status-effects` |
| `MarkupOverlay.razor.css` | `src/ui/styles/markup.css` | `.dndm-markup-overlay` |
| `DndMapperDisplay.razor.css` (513 lines) | `src/ui/styles/display.css` | `.dndm-display-view` |

---

## 4. Phased Roadmap (Phases 6 – 11)

```mermaid
graph TD
    P6[Phase 6: Character Sheets & Schemas] --> P7[Phase 7: 3D Dice & Roll Log]
    P6 --> P9[Phase 9: Combat Tracker]
    P7 --> P8[Phase 8: Loaded Dice Engine]
    P9 --> P10[Phase 10: Canvas Markup & Display]
    P8 --> P11[Phase 11: VTF Export & Lifecycle]
    P10 --> P11
```

### [Phase 6: Character Sheets, Attribute Schemas, & Status Effects](phase-06-character-sheets.md)
*Detailed technical plan: [`phase-06-character-sheets.md`](phase-06-character-sheets.md)*
1. Authority types & rules: `CharacterSheet`, `AttributeSchema`, score-to-modifier formulas, effective HP calculation.
2. Authority intents, narrowed patches (`{ kind: "sheet" }`, `{ kind: "schema" }`), and tests.
3. Lit components: `<dndm-character-sheet>`, notes markdown renderer, `<dndm-sheet-settings-modal>`, `<dndm-schema-preset-modal>`, `<dndm-schema-cascade-warning>`.
4. Status effects: `<dndm-status-effects>`, template library modal.
5. Canvas hook: Token double-click opens linked character sheet.

### [Phase 7: 3D Physics Dice, Quick Roll Footer, & Roll Log](phase-07-dice-and-roll-log.md)
*Detailed technical plan: [`phase-07-dice-and-roll-log.md`](phase-07-dice-and-roll-log.md)*
1. Vendor `dice-box-threejs` with Three.js and Cannon-es; stage 38 textures and 75 sounds.
2. Authority dice rolling engine: formula parsing (`2d6 + 3`), advantage/disadvantage, deterministic roll resolution.
3. `<dndm-dice-canvas>`: Overlay, multi-box management, prewarming.
4. `DiceAnimationTracker`: Gating roll-log reveal until dice finish tumbling.
5. UI: `<dndm-quick-roll-footer>`, `<dndm-roll-log>`, `<dndm-roll-templates-modal>`, `<dndm-roll-history-modal>`.

### [Phase 8: Loaded Dice Engine & DM Secret Tampering](phase-08-loaded-dice.md)
*Detailed technical plan: [`phase-08-loaded-dice.md`](phase-08-loaded-dice.md)*
1. Sandboxed `LoadedDiceProcessor`: pure condition evaluator and modification applier.
2. Authority integration: intercept rolls, apply matched rules, stamp `appliedRules`.
3. Host key streaming: `keydown`/`keyup` tracking on DM client, debounced intent updates.
4. UI: `<dndm-loaded-dice-panel>` in DM left rail, player indicator indicators (`LoadedDicePlayerIndicator`).

### [Phase 9: Initiative & Combat Tracker](phase-09-combat-and-initiative.md)
*Detailed technical plan: [`phase-09-combat-and-initiative.md`](phase-09-combat-and-initiative.md)*
1. Combat state machine: `WaitingForRolls` -> `Active`, round counting, turn index tracking.
2. Turn order sorting: Descending initiative score -> Players before NPCs -> Alphabetical by name (DEX modifier is already factored into roll total, not evaluated as a separate tie-breaker).
3. Staggered batch NPC rolling & manual `PendingInitiative` staging.
4. UI: `<dndm-host-initiative>` in DM rail, `<dndm-initiative-banner>` for players.
5. Canvas integration: Active turn token highlight halo in Phaser scene.

### [Phase 10: Freehand Canvas Markup Overlay & Projector Mode](phase-10-markup-and-display.md)
*Detailed technical plan: [`phase-10-markup-and-display.md`](phase-10-markup-and-display.md)*
1. Interactive SVG drawing layer on Phaser stage, pen/eraser/color/width tools, undo/redo, clear all.
2. Pixel-to-cell transformation and storage in `GameMap.markupSvg`.
3. Spacebar bypass for panning.
4. Display theater mode: In-app fullscreen / detached window with 100% fog opacity, focus rect auto-framing, 250ms token animations, roll ticker.

### [Phase 11: Campaign Exporter (.vtf Packager) & Final Parity Polish](phase-11-vtf-export-and-lifecycle.md)
*Detailed technical plan: [`phase-11-vtf-export-and-lifecycle.md`](phase-11-vtf-export-and-lifecycle.md)*
1. Client-side `.vtf` ZIP packager (`CompressionStream('deflate-raw')`) packaging manifest, scenes, entities, images, and extensions.
2. "Export" button on save slots in `<dndm-saves-panel>`.
3. Disconnect handling: Player token -> NPC token conversion, `RepresentsUserId` preservation, and DM reassignment UI.
4. End-to-end parity audit against legacy Blazor app.

---

## 5. Architectural Invariants & Risk Register

| Risk / Invariant | Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **512 KiB WebSocket Frame Ceiling** | Broadcast dropped silently or 1009 socket kill | Always use narrowed patches (`kind: "sheet"`, `kind: "roll"`). Never broadcast full sheets dictionary. |
| **Intent Rate Limits (30 msg/s, 60 burst)** | 1008 terminal socket close | Debounce sheet text inputs (`300 ms`). Never send network intents on pointer-move during markup. |
| **Cell-Unit vs. Pixel Coordinates** | Silent half-cell alignment drift | Persist all geometry (tokens, images, fog, markup) in cell units. Scale markup by `1 / CellPixels` on commit. |
| **Three.js Main-Thread Jitter** | Rolling 10 NPC dice freezes frame rate | Prewarm dice boxes upon entering combat; stagger roll triggers across animation frames. |
| **WebGL Context Ceiling (8–16 max)** | Context loss crashes Phaser battlemap | Do NOT instantiate separate DiceBox/Three.js contexts per token or user. Use a single shared transparent Three.js overlay canvas across the entire viewport. |
| **KnockBox Delta Broadcast Mode** | Per-recipient delta filtering not supported by server | In KnockBox (`ServerAuthority.cs`), `perRecipient: false` broadcasts deltas to `"all"`. Secret data (rolls visible only to DM, hidden sheets, loaded dice stamps) must be filtered client-side in `MatchView` and Lit components (Decision D2). |
| **Authority Sandbox Restrictions** | Server runtime error | No DOM, no timers, no `Date` object in `src/game/` (use `kb.now()`). Pure deterministic functions only. |
| **Light DOM CSS Collisions** | Unintended global styling bleed | Prefix all ported CSS rules with `.dndm-*` component namespaces. |
| **Spoilers Before Dice Settle** | Results visible in log while dice roll | Use `DiceAnimationTracker` to hide roll log entry until 3D dice finish tumbling. |
