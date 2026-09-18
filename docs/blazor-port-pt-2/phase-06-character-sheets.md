# Phase 6 — Character Sheets, Attribute Schemas & Status Effects

## 1. Executive Summary & Scope

Phase 6 implements the core RPG character representation layer in `DnD-Mapper`, unlocking character attributes, ability scores, hit point tracking, conditions/status effects, and sheet-to-token linkage.

This subsystem provides the foundation upon which combat initiative (Phase 9) and roll modifiers (Phase 7) depend. It transitions character sheets from forward-compatible stub DTOs in [`src/game/domain.ts`](../../src/game/domain.ts) into full authority-governed entities with strict validation, real-time multi-client synchronization, permission-gated editing, and a rich Lit UI in the right rail.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Character Sheet Subsystem                       │
├─────────────────────────┬────────────────────────┬─────────────────────┤
│   Domain & Authority    │    Client Replica      │       Lit UI        │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ • 22 sandboxed verbs    │ • Narrowed patch merge │ • <dndm-character-  │
│ • Effective HP resolver │ • Debounced intent     │   sheet>            │
│ • Attribute schemas     │   emission (300ms)     │ • Presets modal     │
│ • Permission policies   │ • Right-rail routing   │ • Cascade warning   │
│ • Status effect library │ • Token double-click   │ • Status badges     │
│ • Custom templates      │ • Client-side hiding   │ • Template manager  │
└─────────────────────────┴────────────────────────┴─────────────────────┘
```

---

## 2. Legacy Codebase References

Ported directly from `KnockBox.DndMapper`:
- **Data Models**:
  - `Services/State/Games/Data/CharacterSheet.cs`
  - `Services/State/Games/Data/AttributeSchema.cs`, `AttributeRow.cs`, `AttributeValue.cs`, `AttributeDelta.cs`, `AttributeRef.cs`
  - `Models/AttributePreset.cs`, `Models/AttributeValueType.cs`, `Models/SheetEditPolicy.cs`
  - `Services/State/Games/Data/StatusEffect.cs`, `StatusEffectTemplate.cs`, `NamedTemplate.cs`, `CustomTemplate.cs`
- **Logic & Calculators**:
  - `Helpers/AttributeContributionResolver.cs` — Combines base sheet values with active status effect deltas.
  - `Helpers/EffectiveMaxHpResolver.cs` — Computes effective maximum HP (`baseMaxHp + sum(effect.maxHpDelta)`).
  - `Helpers/SheetVisibilityHelper.cs` — Enforces visibility filters (`playersCanSeeOtherSheets`, DM bypass).
  - `Helpers/NotesMarkdownRenderer.cs` — Converts markdown notes to HTML.
- **UI Components & Styles**:
  - `Pages/Components/CharacterSheetPanel.razor` (and `.cs`, `.css` — 610 lines C#, 490 lines CSS)
  - `Pages/Components/SheetSettingsModal.razor` (and `.cs`, `.css`)
  - `Pages/Components/SchemaPresetSelector.razor` (and `.cs`, `.css`)
  - `Pages/Components/SchemaCascadeWarningModal.razor` (and `.cs`, `.css`)
  - `Pages/Components/StatusEffectsPanel.razor` (and `.cs`, `.css` — 216 lines CSS)
  - `Pages/Components/StatusEffectTemplateLibraryModal.razor` (and `.cs`, `.css`)

---

## 3. Domain Models & Wire Contract

### 3.1 Domain Types (`src/game/domain.ts`)

The domain models defined in `src/game/domain.ts` are expanded and finalized:

```ts
export type AttributeValue =
  | { readonly kind: "Score"; readonly value: number }
  | { readonly kind: "Modifier"; readonly value: number }
  | { readonly kind: "Text"; readonly value: string };

export function getModifier(v: AttributeValue): number {
  if (v.kind === "Modifier") return v.value;
  if (v.kind === "Score") return Math.floor((v.value - 10) / 2);
  return 0;
}

export type AttributePreset = "DnD5eCore" | "DnD5ePlusCommonSkills" | "SimpleD20" | "Custom";

export interface AttributeRow {
  readonly name: string;
  readonly type: "Score" | "Modifier" | "Text";
  readonly default: AttributeValue;
}

export interface AttributeSchema {
  readonly preset: AttributePreset;
  readonly rows: readonly AttributeRow[];
}

export interface AttributeDelta {
  readonly attributeName: string;
  readonly delta: number;
}

export interface StatusEffect {
  readonly id: string;
  readonly name: string;
  readonly appliedUtc: string; // ISO 8601 string
  readonly attributeDeltas: readonly AttributeDelta[];
  readonly maxHpDelta: number | null;
  readonly onApplyHpDelta: number | null;
  readonly notes: string;
}

export interface StatusEffectTemplate {
  readonly id: string;
  readonly name: string;
  readonly attributeDeltas: readonly AttributeDelta[];
  readonly maxHpDelta: number | null;
  readonly onApplyHpDelta: number | null;
  readonly notes: string;
}

export interface CustomTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly values: Readonly<Record<string, AttributeValue>>;
  readonly maxHp: number | null;
  readonly armorClass: number | null;
  readonly color: string;
  readonly notes: string;
  readonly statusEffectTemplates: readonly StatusEffectTemplate[];
  readonly rollTemplates: readonly RollTemplate[];
}

export interface CharacterSheet {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly representsUserId: string | null;
  readonly characterName: string;
  readonly values: Readonly<Record<string, AttributeValue>>;
  readonly notes: string; // Markdown formatted
  readonly hp: number | null;
  readonly maxHp: number | null;
  readonly armorClass: number | null;
  readonly color: string; // Hex color string, e.g. "#4a90e2"
  readonly scopedMapId: string | null; // Filter sheets by active map
  readonly statusEffects: readonly StatusEffect[];
  readonly rollTemplates: readonly RollTemplate[];
}
```

### 3.2 Wire Intents (`src/game/types.ts`)

Add 22 intents to the `Intent` discriminated union:

```ts
export type Intent =
  // ... existing intents ...
  // sheets (9 intents; assignCharacterToPlayer in Phase 11)
  | { readonly kind: "createSheet"; readonly characterName: string; readonly scopedMapId?: string | null }
  | { readonly kind: "updateSheet"; readonly sheetId: string; readonly patch: Partial<Pick<CharacterSheet, "characterName" | "color" | "scopedMapId" | "notes">> }
  | { readonly kind: "deleteSheet"; readonly sheetId: string }
  | { readonly kind: "duplicateSheet"; readonly sheetId: string }
  | { readonly kind: "assignSheetOwner"; readonly sheetId: string; readonly ownerUserId: string | null }
  | { readonly kind: "setSheetHp"; readonly sheetId: string; readonly hp: number | null }
  | { readonly kind: "setSheetMaxHp"; readonly sheetId: string; readonly maxHp: number | null }
  | { readonly kind: "setSheetAc"; readonly sheetId: string; readonly ac: number | null }
  | { readonly kind: "updateAttributeValues"; readonly sheetId: string; readonly values: Readonly<Record<string, AttributeValue>> }
  // schemas (3 intents)
  | { readonly kind: "setSchemaPreset"; readonly preset: AttributePreset }
  | { readonly kind: "updateSchemaRows"; readonly rows: readonly AttributeRow[]; readonly initiativeAttributeName?: string | null }
  | { readonly kind: "setInitiativeAttribute"; readonly attributeName: string | null }
  // status effects (5 intents)
  | { readonly kind: "applyStatusEffect"; readonly sheetId: string; readonly effect: Omit<StatusEffect, "id" | "appliedUtc"> }
  | { readonly kind: "updateStatusEffect"; readonly sheetId: string; readonly effectId: string; readonly patch: Partial<Omit<StatusEffect, "id" | "appliedUtc">> }
  | { readonly kind: "removeStatusEffect"; readonly sheetId: string; readonly effectId: string }
  | { readonly kind: "createEffectTemplate"; readonly template: Omit<StatusEffectTemplate, "id"> }
  | { readonly kind: "updateEffectTemplate"; readonly templateId: string; readonly patch: Partial<Omit<StatusEffectTemplate, "id">> }
  | { readonly kind: "deleteEffectTemplate"; readonly templateId: string }
  // custom templates (6 intents)
  | { readonly kind: "createCustomTemplate"; readonly template: Omit<CustomTemplate, "id"> }
  | { readonly kind: "updateCustomTemplate"; readonly templateId: string; readonly patch: Partial<Omit<CustomTemplate, "id">> }
  | { readonly kind: "deleteCustomTemplate"; readonly templateId: string }
  | { readonly kind: "applyCustomTemplate"; readonly templateId: string; readonly characterName?: string; readonly scopedMapId?: string | null }
  | { readonly kind: "duplicateCustomTemplate"; readonly templateId: string }
  | { readonly kind: "reorderCustomTemplates"; readonly templateIds: readonly string[] };
```

### 3.3 Narrowed Patches (`src/game/types.ts`)

To strictly protect the **512 KiB WebSocket frame ceiling**, sheets are NEVER broadcast as the entire dictionary. Individual sheet lifecycle changes produce narrowed patches:

```ts
export type Patch =
  // ... existing patches ...
  | { readonly kind: "sheet"; readonly sheet: CharacterSheet }
  | { readonly kind: "sheetRemoved"; readonly sheetId: string }
  | { readonly kind: "schema"; readonly schema: AttributeSchema; readonly initiativeAttributeName: string | null }
  | { readonly kind: "effectTemplate"; readonly template: StatusEffectTemplate }
  | { readonly kind: "effectTemplateRemoved"; readonly templateId: string }
  | { readonly kind: "customTemplate"; readonly template: CustomTemplate }
  | { readonly kind: "customTemplateRemoved"; readonly templateId: string };
```

- **Frame Size Budget**: A single `CharacterSheet` with 20 attributes, notes, and 5 status effects consumes ~1.2 KiB JSON. This is < 0.3% of the 400 KiB `MAX_FRAME_BYTES` limit.

---

## 4. Authority Engine & Pure Rules (`src/game/rules.ts`)

### 4.1 Permission Policies
Add helper checks respecting `DndMapperSettings.sheetEditByOthers`:

```ts
export function mayViewSheet(state: DndMapperState, fromId: string, sheet: CharacterSheet): boolean {
  if (isDm(state, fromId)) return true;
  if (sheet.ownerUserId === fromId) return true;
  return state.settings.playersCanSeeOtherSheets;
}

export function mayEditSheet(state: DndMapperState, fromId: string, sheet: CharacterSheet): boolean {
  if (isDm(state, fromId)) return true;
  switch (state.settings.sheetEditByOthers) {
    case "HostOnly":
      return false;
    case "Anyone":
      return true;
    case "OwnersAndHost":
      return sheet.ownerUserId === fromId;
  }
}
```

### 4.2 Attribute & HP Resolvers
Implement pure calculation functions in `src/game/domain.ts`:

- **`resolveEffectiveMaxHp(sheet: CharacterSheet): number | null`**:
  - If `sheet.maxHp === null`, returns `null`.
  - Calculates `baseMaxHp + sum(effect.maxHpDelta ?? 0)`.
  - Invariant from legacy `EffectiveMaxHpResolver.cs`: Does not clamp to 1, and there is no temporary HP in the domain model.
- **`onApplyHpDelta` Handling**:
  - When `applyStatusEffect` is executed, if `effect.onApplyHpDelta !== null`:
    - The sheet's current `hp` is immediately adjusted: `sheet.hp = Math.min((sheet.hp ?? effectiveMaxHp) + effect.onApplyHpDelta, effectiveMaxHp)` (and clamped >= 0).
    - This is applied once during the engine transaction.
    - When `removeStatusEffect` is executed, `onApplyHpDelta` is **not reversed** (matching legacy `DndMapperGameEngine.cs:1776-1793`).
- **`resolveAttributeValue(sheet: CharacterSheet, attributeName: string): AttributeValue`**:
  - Retrieves base attribute value from `sheet.values[attributeName]`.
  - For `Modifier` or `Score`, sums all matching `attributeDeltas` from active `statusEffects`.
- **Schema Cascade Invariant**:
  - When the DM updates schema rows (`updateSchemaRows` or `setSchemaPreset`), the authority reconciles existing sheets:
    - Removes values for attributes that no longer exist in the new schema.
    - Injects default values for newly added attributes.

### 4.3 Snapshot & Replica Visibility Filtering
In KnockBox server authority (`ServerAuthority.cs`), delta patches (`perRecipient: false`) are broadcast to all connected clients (`"all"`). To enforce `settings.playersCanSeeOtherSheets`:
- In `MatchView` and the `<dndm-character-sheet>` component:
  - If `!isDm(state, localUserId)` and `!state.settings.playersCanSeeOtherSheets`:
    - The client UI strictly filters the visible sheet list to sheets where `sheet.ownerUserId === localUserId`.
    - Sheets belonging to other players or unowned NPC sheets are hidden from player view.
- In initial snapshot projection (if `perRecipient` snapshot is configured), omit sheets where `sheet.ownerUserId !== playerId`.

---

## 5. Client Replica & Replication (`src/game/view.ts`)

Extend `MatchView.applyPatch`:

```ts
case "sheet": {
  const nextSheets = { ...this._state.sheets, [patch.sheet.id]: patch.sheet };
  this._state = { ...this._state, sheets: nextSheets };
  break;
}

case "sheetRemoved": {
  const nextSheets = { ...this._state.sheets };
  delete nextSheets[patch.sheetId];
  this._state = { ...this._state, sheets: nextSheets };
  break;
}

case "schema": {
  this._state = {
    ...this._state,
    attributeSchema: patch.schema,
    initiativeAttributeName: patch.initiativeAttributeName,
  };
  break;
}

case "effectTemplate": {
  // Update or append status effect template in custom templates / library
  break;
}

case "customTemplate": {
  const nextTemplates = { ...this._state.customTemplates, [patch.template.id]: patch.template };
  this._state = { ...this._state, customTemplates: nextTemplates };
  break;
}

case "customTemplateRemoved": {
  const nextTemplates = { ...this._state.customTemplates };
  delete nextTemplates[patch.templateId];
  this._state = { ...this._state, customTemplates: nextTemplates };
  break;
}
```

---

## 6. Lit Components & UI Architecture

### 6.1 Component Hierarchy
```
<dndm-app>
 └── <aside class="dndm-rail dndm-rail--right">
      └── <dndm-character-sheet>
           ├── Roster Header (Map-scoped vs All filter, Search, Create Button)
           ├── Sheet Selector Dropdown / Chips
           ├── Combat Vitality Bar (HP / Effective Max HP, AC, Dead Indicator)
           ├── Ability Scores Grid (STR, DEX, CON, INT, WIS, CHA with +/- Modifiers)
           ├── Skills & Custom Attributes List
           ├── <dndm-status-effects> (Badge list + Apply Condition modal trigger)
           └── Notes Markdown Editor / Previewer
```

### 6.2 Modals
1. `<dndm-sheet-settings-modal>`:
   - Configure sheet permissions, ownership assignment, token color override, delete sheet.
2. `<dndm-schema-preset-modal>`:
   - Switch between **DnD5eCore**, **DnD5ePlusCommonSkills**, **SimpleD20**, and **Custom**.
3. `<dndm-schema-cascade-warning>`:
   - Warns DM if switching schema will prune attributes currently populated on existing sheets.
4. `<dndm-status-effect-library-modal>`:
   - 16 standard conditions with preconfigured attribute and HP deltas (e.g. *Exhaustion*, *Paralyzed*, *Poisoned*, *Concentrating*).

### 6.3 Input Debouncing & Rate Limit Defense
- Sheet text inputs (`characterName`, `notes`, attribute text fields) must be debounced by **`300 ms`** before emitting `updateSheet` or `updateAttributeValues` intents.
- Stepper buttons for HP/AC emit immediate intents.

### 6.4 Notes Markdown Renderer
- Zero-dependency client-side parser converting Markdown formatting (`**bold**`, `*italic*`, `[links](url)`, `# headers`, `- lists`, `> quotes`) safely to sanitized HTML.

---

## 7. Canvas & Engine Integration (Phaser 4)

1. **Token Color Inheritance**:
   - In [`src/ui/map/tokenLayer.ts`](../../src/ui/map/tokenLayer.ts), when creating/updating a token:
     - Check `token.sheetId`. If linked, resolve color from `CharacterSheet.color`. If sheet has no color, fall back to `token.color`.
2. **Double-Click Navigation**:
   - In `tokenLayer.ts`: Double-clicking any token on the Phaser canvas checks `token.sheetId`.
   - Dispatches a custom DOM event `dndm-open-sheet` with `{ sheetId }`.
   - `<dndm-app>` catches this event, expands the right rail if collapsed, and selects the sheet.

---

## 8. Scoped CSS Migration

Create `src/ui/styles/sheet.css` and `src/ui/styles/status-effects.css` ported from legacy `CharacterSheetPanel.razor.css` and `StatusEffectsPanel.razor.css`:

```css
/* src/ui/styles/sheet.css */
.dndm-sheet-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: var(--dndm-spacing-md);
  color: var(--dndm-color-text);
}

.dndm-sheet-vitals {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--dndm-spacing-sm);
  background: var(--dndm-color-surface-elevated);
  padding: var(--dndm-spacing-md);
  border-radius: var(--dndm-radius-md);
}

.dndm-sheet-hp-bar {
  position: relative;
  height: 12px;
  background: var(--dndm-color-surface-sunken);
  border-radius: var(--dndm-radius-pill);
  overflow: hidden;
}

.dndm-sheet-hp-fill {
  height: 100%;
  background: var(--dndm-color-crimson);
  transition: width 200ms ease-out;
}

.dndm-sheet-hp-fill--bloodied {
  background: var(--dndm-color-bloodied);
}

.dndm-sheet-scores-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--dndm-spacing-xs);
}

.dndm-score-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--dndm-spacing-xs);
  background: var(--dndm-color-surface);
  border: 1px solid var(--dndm-color-border);
  border-radius: var(--dndm-radius-sm);
}

.dndm-score-value {
  font-size: 1.25rem;
  font-weight: bold;
}

.dndm-score-modifier {
  font-size: 0.85rem;
  color: var(--dndm-color-accent);
}
```

---

## 9. Verification & Acceptance Criteria

### Automated Unit Tests
1. **`src/game/characterSheet.test.ts`**:
   - `createSheet` initializes default schema values and null HP/AC.
   - `getModifier` accurately computes `Math.floor((score - 10) / 2)` for odd and even scores (e.g. 10 -> 0, 11 -> 0, 12 -> +1, 9 -> -1).
   - `resolveEffectiveMaxHp` applies positive and negative status effect deltas (`baseMaxHp + sum(effect.maxHpDelta ?? 0)`).
   - `onApplyHpDelta` adjusts current HP upon applying status effect and is not reversed upon removal.
   - `updateAttributeValues` updates scores and recomputes effective modifiers.
   - `duplicateSheet` generates fresh GUIDs and clones attribute values cleanly.
   - `deleteSheet` removes sheet and unlinks any tokens referencing `sheetId`.
2. **`src/game/rules.test.ts` (Permission suite)**:
   - Players cannot edit sheets owned by others when `sheetEditByOthers` is `HostOnly` or `OwnersAndHost`.
   - DM can edit any sheet regardless of settings.
   - Client-side visibility filtering hides unowned sheets when `playersCanSeeOtherSheets` is false for non-DM players.
3. **`src/ui/panels/dndm-character-sheet.test.ts`**:
   - Renders vital stats, ability cards, and status effects.
   - Fast typing does not saturate intent channel (verifying 300ms debounce).

### Acceptance Checklist ("Done when")
- [ ] DM can create, edit, delete, and duplicate character sheets.
- [ ] Switching attribute schema presets updates the sheet grid without unhandled exceptions.
- [ ] Changing sheet color dynamically updates the linked token's color on the Phaser canvas.
- [ ] Double-clicking a token on the map opens its linked character sheet in the right rail.
- [ ] Applying a status effect (e.g. *Exhaustion*) modifies effective stats and displays a badge.
- [ ] Character sheet notes support markdown formatting and display rendered preview.
- [ ] `npm test && npm run typecheck && npm run lint` pass without errors or regressions.
