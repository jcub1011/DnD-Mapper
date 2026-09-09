# Phase 8 — Loaded Dice Engine & DM Secret Tampering

## 1. Executive Summary & Scope

Phase 8 implements the Loaded Dice engine, allowing the Dungeon Master to author secret, conditional rules that manipulate dice roll outcomes in real time.

In the legacy Blazor application, the Loaded Dice system was a signature feature: DMs could set subtle cinematic interventions (e.g. "if the dragon rolls a natural 20 against level 1 PCs, reroll it", "floor player rolls at 5 during boss fight", or "when the DM holds the Spacebar, force roll to 18"). The engine operates entirely within the sandboxed authority, evaluating complex compound conditions and applying dice modifications before committing results.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Loaded Dice Architecture                        │
├─────────────────────────┬────────────────────────┬─────────────────────┤
│   Domain & Authority    │   DM Host Streaming    │       Lit UI        │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ • Pure condition eval   │ • keydown / keyup /    │ • <dndm-loaded-     │
│ • Pure modifications    │   blur listeners       │   dice-panel>       │
│ • Rule stamping audit   │ • Key normalization    │ • Rule builder modal│
│ • Visibility policies   │ • 30 msg/s debounced   │ • Player indicators │
│   (Hidden / Host / All) │   key state streaming  │   (Subtle/Obvious)  │
└─────────────────────────┴────────────────────────┴─────────────────────┘
```

---

## 2. Legacy Codebase References

Ported directly from `KnockBox.DndMapper`:
- **Core Processor**:
  - `Services/Logic/LoadedDice/LoadedDiceProcessor.cs` (91 lines) — Pure rule evaluation and modification logic.
- **Data Models**:
  - `Services/State/Games/Data/LoadedDice/LoadedDiceRule.cs`
  - `Services/State/Games/Data/LoadedDice/LoadedDiceCondition.cs`
  - `Services/State/Games/Data/LoadedDice/LoadedDiceModification.cs`
  - `Services/State/Games/Data/LoadedDice/LoadedDiceContext.cs`
  - `Services/State/Games/Data/LoadedDice/LoadedDiceRuleStamp.cs`
  - `Models/LoadedDiceRuleVisibility.cs` (`Hidden`, `VisibleToHostOnly`, `VisibleToAll`)
  - `Models/LoadedDicePlayerIndicator.cs` (`None`, `Subtle`, `Obvious`)
- **UI Components & Styles**:
  - `Pages/Components/LoadedDice/LoadedDiceRulesPanel.razor` (and `.cs`, `.css`)
  - `Pages/Components/LoadedDice/LoadedDiceRuleModal.razor`
- **Host Input Streaming**:
  - `wwwroot/js/dndMapperHostInput.js` (138 lines) — Tracks keys held by the DM and synchronizes them with the server.

---

## 3. Domain Models & Wire Contract

### 3.1 Domain Types (`src/game/domain.ts`)

Building upon existing stubs in `src/game/domain.ts`:

```ts
export const GM_TARGET_ID = "00000000-0000-0000-0000-000000000001";

export type LoadedDiceCondition =
  | { readonly $kind: "currentMap"; readonly mapId: string }
  | { readonly $kind: "diceTypeRolled"; readonly sides: number }
  | { readonly $kind: "rollerIs"; readonly sheetId: string } // CharacterSheet.id or GM_TARGET_ID for unlinked GM rolls
  | { readonly $kind: "rollModeIs"; readonly mode: RollMode }
  | { readonly $kind: "hostKeyHeld"; readonly key: string }
  | { readonly $kind: "combatActive" } // Parameterless flag
  | { readonly $kind: "rollLabelContains"; readonly substring: string }
  | { readonly $kind: "allOf"; readonly conditions: readonly LoadedDiceCondition[] }
  | { readonly $kind: "anyOf"; readonly conditions: readonly LoadedDiceCondition[] }
  | { readonly $kind: "not"; readonly condition: LoadedDiceCondition };

export type LoadedDiceModification =
  | { readonly $kind: "setResult"; readonly value: number }
  | { readonly $kind: "clampMax"; readonly max: number }
  | { readonly $kind: "clampMin"; readonly min: number }
  | { readonly $kind: "biasLower"; readonly rerollCount: number }
  | { readonly $kind: "biasHigher"; readonly rerollCount: number }
  | { readonly $kind: "rerollOn"; readonly values: readonly number[] };

export interface LoadedDiceRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly targetSheetIds: readonly string[]; // Empty means all sheets / unattributed GM rolls
  readonly conditions: readonly LoadedDiceCondition[];
  readonly modifications: readonly LoadedDiceModification[];
}

export interface LoadedDiceContext {
  readonly roll: {
    readonly sides: number;
    readonly mode: RollMode;
    readonly label: string;
    readonly sheetId: string | null;
    readonly rollerUserId: string;
  };
  readonly activeMapId: string | null;
  readonly isCombatActive: boolean;
  readonly hostHeldKeys: readonly string[];
}
```

### 3.2 Wire Intents (`src/game/types.ts`)

Add loaded dice intents:

```ts
export type Intent =
  // ... existing intents ...
  | { readonly kind: "createLoadedDiceRule"; readonly rule: Omit<LoadedDiceRule, "id"> }
  | { readonly kind: "updateLoadedDiceRule"; readonly ruleId: string; readonly patch: Partial<LoadedDiceRule> }
  | { readonly kind: "deleteLoadedDiceRule"; readonly ruleId: string }
  | { readonly kind: "toggleLoadedDiceRule"; readonly ruleId: string; readonly enabled: boolean }
  | { readonly kind: "reorderLoadedDiceRules"; readonly ruleIds: readonly string[] }
  | { readonly kind: "updateHostKeys"; readonly heldKeys: readonly string[] };
```

### 3.3 Narrowed Patches (`src/game/types.ts`)

```ts
export type Patch =
  // ... existing patches ...
  | { readonly kind: "loadedDiceRules"; readonly rules: readonly LoadedDiceRule[] }
  | { readonly kind: "hostKeys"; readonly keys: readonly string[] };
```

---

## 4. Pure Authority Rule Processor (`src/game/loadedDice.ts`)

### 4.1 Condition Evaluation
The processor evaluates conditions in a purely deterministic, recursive function:

```ts
export function evaluateCondition(cond: LoadedDiceCondition, ctx: LoadedDiceContext): boolean {
  switch (cond.$kind) {
    case "currentMap":
      return ctx.activeMapId === cond.mapId;
    case "diceTypeRolled":
      return ctx.roll.sides === cond.sides;
    case "rollerIs":
      return ctx.roll.sheetId === cond.sheetId || (ctx.roll.sheetId === null && cond.sheetId === GM_TARGET_ID);
    case "rollModeIs":
      return ctx.roll.mode === cond.mode;
    case "combatActive":
      return ctx.isCombatActive;
    case "rollLabelContains":
      return ctx.roll.label.toLowerCase().includes(cond.substring.toLowerCase());
    case "hostKeyHeld":
      return ctx.hostHeldKeys.includes(cond.key.toUpperCase());
    case "allOf":
      return cond.conditions.every((c) => evaluateCondition(c, ctx));
    case "anyOf":
      return cond.conditions.some((c) => evaluateCondition(c, ctx));
    case "not":
      return !evaluateCondition(cond.condition, ctx);
  }
}
```

### 4.2 Modification Pipeline
Modifications are applied sequentially to die values:

- **`setResult(value)`**: Overrides die face value to target value (clamped between 1 and `sides`).
- **`clampMax(max)`**: Caps the face value at `min(face, max)`.
- **`clampMin(min)`**: Floors the face value at `max(face, min)`.
- **`biasLower(rerollCount)`**: Roll additional dice equal to rerollCount, take lowest.
- **`biasHigher(rerollCount)`**: Roll additional dice equal to rerollCount, take highest.
- **`rerollOn(values)`**: If the natural roll is in `values`, rerolls the die once.

### 4.3 Auditing & Stamping
- When one or more rules modify a roll:
  - Rule stamps (`LoadedDiceRuleStamp`: ruleId, ruleName, modificationType) are recorded on `RollResult.appliedRules`.
  - In KnockBox server authority (`ServerAuthority.cs`), delta patches are broadcast to `"all"`. Therefore, secret visibility filtering is enforced **client-side in `MatchView` and the `<dndm-roll-log>` component**:
    - `Hidden`: Player clients strip and never render `appliedRules`.
    - `VisibleToHostOnly`: Only the DM client renders `appliedRules`; player clients suppress it.
    - `VisibleToAll`: `appliedRules` is displayed in the roll breakdown for all clients.

---

## 5. DM Host Key Streaming (`src/net/hostInput.ts`)

Porting `dndMapperHostInput.js`:
1. **Window Event Listeners**:
   - Only attached when the local client is the DM (`isOwner === true` and `settings.loadedDiceEnabled === true`).
   - Listen for `keydown`, `keyup`, and `blur`.
   - **Input Focus Guard**: Explicitly ignore keystrokes when the active focus is inside an editable text element (`HTMLInputElement`, `HTMLTextAreaElement`, or `isContentEditable`) to prevent typing in chat or notes from streaming held keys or triggering loaded dice rules.
2. **Key Normalization**:
   - Convert `" "` to `"SPACE"`.
   - Convert keys to uppercase (`"H"` -> `"H"`, `"1"` -> `"1"`).
   - Ignore repeated auto-fire `keydown` events (`event.repeat === true`).
   - On window `blur`, clear all held keys to prevent sticky keys.
3. **Rate-Limited Intent Dispatch**:
   - Debounce intent dispatches using a trailing-edge throttle (max 1 intent per 50ms = 20 msg/s, safely below the 30 msg/s ceiling).
   - Only emit `updateHostKeys` if the active set of held keys has genuinely changed.

---

## 6. Lit Components & UI Architecture

### 6.1 `<dndm-loaded-dice-panel>`
- Displayed in the DM's left rail when `settings.loadedDiceEnabled` is enabled.
- **Rule List**:
  - Drag-and-drop reordering for rule precedence.
  - Quick toggle switch to enable/disable rules on the fly.
  - Badge showing target scope ("All", or specific character name).
- **Rule Editor Modal**:
  - Name, enabled checkbox, target character selector.
  - Condition builder with dropdowns for condition types (including compound All/Any/Not groups).
  - Modification picker: Set Result, Clamp, Bias, Reroll.

### 6.2 Player Cues (`LoadedDicePlayerIndicator`)
Configurable in session settings:
- `None`: No indication given.
- `Subtle`: A discreet glyph appears next to the roll in the log.
- `Obvious`: A prominent banner / callout informs players that the roll was tampered with by a divine hand.

---

## 7. Scoped CSS Migration (`src/ui/styles/loaded-dice.css`)

Ported from `LoadedDiceRulesPanel.razor.css`:

```css
/* src/ui/styles/loaded-dice.css */
.dndm-loaded-dice {
  display: flex;
  flex-direction: column;
  gap: var(--dndm-spacing-sm);
}

.dndm-loaded-rule-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--dndm-spacing-xs) var(--dndm-spacing-sm);
  background: var(--dndm-color-surface-elevated);
  border: 1px solid var(--dndm-color-border);
  border-radius: var(--dndm-radius-sm);
}

.dndm-loaded-rule-card--disabled {
  opacity: 0.5;
}

.dndm-loaded-rule-badge {
  font-size: 0.75rem;
  padding: 2px 6px;
  border-radius: var(--dndm-radius-pill);
  background: var(--dndm-color-accent-dim);
  color: var(--dndm-color-accent);
}

.dndm-held-key-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: monospace;
  background: var(--dndm-color-surface-sunken);
  padding: 2px 6px;
  border-radius: var(--dndm-radius-sm);
  border: 1px solid var(--dndm-color-border-subtle);
}
```

---

## 8. Verification & Acceptance Criteria

### Automated Unit Tests
1. **`src/game/loadedDice.test.ts`**:
   - `evaluateCondition` handles all condition variants: `currentMap`, `diceTypeRolled`, `rollerIs`, `combatActive`, `hostKeyHeld`, and nested `allOf`/`anyOf`/`not`.
   - `setResult` forces total and respects clamping to `[1, sides]`.
   - `clampMin` and `clampMax` bound face values correctly.
   - `rerollOn` rerolls when matching trigger and preserves non-trigger rolls.
   - Multiple rules execute in priority order.
2. **`src/game/rules.test.ts` (Loaded Dice Suite)**:
   - Non-DM cannot create, edit, or delete loaded dice rules.
   - Non-DM cannot stream host keys (`updateHostKeys` ignored).
   - Rule stamps are stripped from player UI displays when `loadedDiceRuleVisibility === "Hidden"`.
   - Rule stamps are displayed in player UI displays when `loadedDiceRuleVisibility === "VisibleToAll"`.
3. **`src/net/hostInput.test.ts`**:
   - Keydown and keyup accurately maintain active held key set.
   - Window blur flushes all held keys.
   - Keystrokes inside inputs and textareas are ignored.
   - Key stream debouncer does not exceed 30 msg/s under rapid keystrokes.

### Acceptance Checklist ("Done when")
- [ ] DM can create a rule (e.g. "Spacebar forces d20 to 20") and toggle it on/off.
- [ ] Holding the configured host key while rolling forces the specified result.
- [ ] Rules accurately target specific character sheets while leaving others untouched.
- [ ] Window blur or tab switch clears held keys so rules don't get stuck on.
- [ ] Typing inside text inputs does not trigger loaded dice host keys.
- [ ] Rule stamps are hidden from players when visibility is set to Hidden.
- [ ] `npm test && npm run typecheck && npm run lint` pass without errors.
