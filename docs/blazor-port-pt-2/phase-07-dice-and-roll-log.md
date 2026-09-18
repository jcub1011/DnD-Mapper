# Phase 7 — 3D Physics Dice, Quick Roll Footer & Roll Log

## 1. Executive Summary & Scope

Phase 7 brings high-fidelity 3D physics dice rolling, a quick-roll canvas footer, a replicated roll log, and roll template authoring to `DnD-Mapper`.

In tabletop RPGs, physical dice rolling is a core emotional anchor. The legacy Blazor implementation leveraged `dice-box-threejs` (Three.js + Cannon-es) rendering transparent WebGL dice onto the screen, accompanied by realistic impact audio and custom textures. Phase 7 ports this full audio-visual experience while maintaining strict multiplayer state synchronization: dice rolls are deterministically calculated and recorded in the authority state, but results are hidden on client screens until the local 3D dice finish tumbling.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Dice Rolling Architecture                       │
├─────────────────────────┬────────────────────────┬─────────────────────┤
│   Domain & Authority    │  Animation & Audio     │      Lit UI         │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ • Deterministic rolls   │ • 38 WebP textures     │ • <dndm-quick-roll- │
│ • Adv / Disadvantage    │ • 75 MP3 audio effects │   footer>           │
│ • Formula parser/eval   │ • dice-box-threejs     │ • <dndm-roll-log>   │
│ • Replicated roll log   │ • DiceAnimationTracker │ • Template library  │
│   (50 roll cap)         │ • Multi-box pooling    │ • History modal     │
└─────────────────────────┴────────────────────────┴─────────────────────┘
```

---

## 2. Legacy Codebase References

Ported directly from `KnockBox.DndMapper`:
- **Razor Components & Code**:
  - `Pages/Components/DiceCanvas.razor` (and `.cs`, `.css` — 265 lines C#)
  - `Pages/Components/QuickRollFooter.razor` (and `.cs`, `.css` — 333 lines CSS)
  - `Pages/Components/RollLogPanel.razor`, `RollLogEntry.razor` (and `.cs`, `.css`)
  - `Pages/Components/RollHistoryModal.razor`, `RollTemplateLibraryModal.razor`
- **Helpers & Services**:
  - `Helpers/DiceNotationBuilder.cs`, `DiceRollSubmitter.cs`, `DiceColorResolver.cs`
  - `Services/Logic/DiceAnimationTracker.cs` — Synchronizes UI result presentation with 3D animation completion.
  - `Services/Logic/RollLogVisibilityFilter.cs` — Hides rolls based on `rollsVisibleToPlayers` and secret roll flags.
- **Client Libraries & Media**:
  - `wwwroot/lib/dice-box-threejs/dice-box.es.js` (17,248 lines)
  - `wwwroot/js/dndMapperDiceBox.js` (198 lines)
  - 38 `.webp` textures (`astral`, `bronze01..04`, `dragon`, `fire`, `ice`, `marble`, `metal`, `stone`, `tiger`, `wood`, etc.) in `wwwroot/dice/`
  - 75 `.mp3` sound files (`sounds/dicehit/` 45 + `sounds/surfaces/` 30) in `wwwroot/dice/`

---

## 3. Asset Migration & Vendoring

### 3.1 Directory Structure
Place static dice assets into the public asset pipeline:
```
public/
 └── assets/
      └── dice/
           ├── textures/    # 38 .webp texture files
           └── sounds/      # 75 .mp3 files (dicehit 1..45, surfaces 1..30)
```

### 3.2 3D Library Integration & WebGL Context Ceiling
- Vendor `dice-box-threejs` under `src/lib/dice-box/` or configure an external module bundle.
- **WebGL Context Ceiling Invariant**: Browsers strictly limit simultaneous active WebGL contexts (typically 8–16 maximum across the entire page). Spawning multiple `DiceBox` instances per player or token rapidly triggers `contextlost` events and crashes Phaser 4's battlemap renderer.
- **Single Canvas Architecture**: All dice rolling must render to a **single, shared, transparent full-viewport Three.js canvas** overlaying the Phaser stage (`alpha: true`, `pointer-events: none`). Multiple dice rolls are pooled and managed within this single Three.js scene instance.
- **Audio Configuration**: Legacy `dndMapperDiceBox.js:89` explicitly set `sounds: false`. Default audio to disabled (`sounds: false`), providing an opt-in sound toggle in the quick-roll UI.

---

## 4. Domain Models & Wire Contract

### 4.1 Domain Types (`src/game/domain.ts`)

Building upon existing types in `src/game/domain.ts`:

```ts
export type RollMode = "Normal" | "Advantage" | "Disadvantage";

export interface DieRoll {
  readonly sides: number;
  readonly value: number;
  readonly discarded?: boolean; // True if dropped by advantage/disadvantage
}

export type RollTemplateScope = "BuiltIn" | "Global" | "Sheet";

export interface RollTemplate {
  readonly id: string;
  readonly name: string;
  readonly dice: readonly DiceTerm[];
  readonly flatModifier: number;
  readonly mode: RollMode;
  readonly attributeName: string | null;
  readonly label: string;
  readonly scope: RollTemplateScope;
}

export interface LoadedDiceRuleStamp {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly modificationType: string;
}

export interface RollResult {
  readonly id: string;
  readonly rollerUserId: string;
  readonly forcedByUserId: string | null;
  readonly rolls: readonly DieRoll[];
  readonly originalDice: readonly DieRoll[];
  readonly originalAttributeRef: string | null;
  readonly total: number;
  readonly mode: RollMode;
  readonly flatModifier: number;
  readonly attributeModifier: number;
  readonly label: string;
  readonly timestampUtc: string;
  readonly formula: string;
  readonly modifierBreakdown: string;
  readonly tokenId: string | null;
  readonly appliedRules: readonly LoadedDiceRuleStamp[];
}
```

### 4.2 Wire Intents (`src/game/types.ts`)

Add rolling and template authoring intents:

```ts
export type Intent =
  // ... existing intents ...
  | {
      readonly kind: "rollDice";
      readonly formula: string;
      readonly mode: RollMode;
      readonly label?: string;
      readonly tokenId?: string | null;
      readonly sheetId?: string | null;
      readonly attributeName?: string | null;
    }
  | {
      readonly kind: "rollTemplate";
      readonly templateId: string;
      readonly modeOverride?: RollMode;
      readonly tokenId?: string | null;
      readonly sheetId?: string | null;
    }
  | {
      readonly kind: "updateRollTemplate";
      readonly sheetId: string;
      readonly templateId: string;
      readonly patch: Partial<Omit<RollTemplate, "id" | "scope">>;
    }
  | {
      readonly kind: "createGlobalRollTemplate";
      readonly template: Omit<RollTemplate, "id" | "scope">;
    }
  | {
      readonly kind: "updateGlobalRollTemplate";
      readonly templateId: string;
      readonly patch: Partial<Omit<RollTemplate, "id" | "scope">>;
    }
  | {
      readonly kind: "deleteGlobalRollTemplate";
      readonly templateId: string;
    }
  | { readonly kind: "clearRollLog" };
```

### 4.3 Narrowed Patches (`src/game/types.ts`)

```ts
export type Patch =
  // ... existing patches ...
  | { readonly kind: "roll"; readonly roll: RollResult }
  | { readonly kind: "rollLogCleared" }
  | { readonly kind: "globalRollTemplates"; readonly templates: readonly RollTemplate[] };
```

- **Roll Log Capacity & Frame Ceiling**:
  - The authority limits `rollLog` to the **latest 50 rolls** (`MAX_ROLL_LOG = 50`).
  - Rolling emits a single `{ kind: "roll", roll: RollResult }` patch (~400 bytes), well within the frame ceiling.
  - A full snapshot with 50 rolls consumes ~20 KiB JSON.

---

## 5. Authority Roll Execution Engine (`src/game/dice.ts` & `src/game/rules.ts`)

### 5.1 Deterministic Resolution & Sandboxing
The authority evaluates rolls using a seeded or pseudo-random algorithm compatible with the sandbox:
- `executeRoll(formula, mode, rollerUserId, options)`:
  1. Parse formula via `parseDiceNotation(formula)`.
  2. Resolve attribute modifier if `attributeName` is supplied from linked sheet.
  3. Roll dice according to `mode`:
     - **Normal**: Roll each die once.
     - **Advantage (d20)**: Roll 2d20, take the higher face value.
     - **Disadvantage (d20)**: Roll 2d20, take the lower face value.
  4. Intercept with Loaded Dice rules (Phase 8 hook point).
  5. Calculate total: `sum(keptDice) + flatModifier + attributeModifier`.
  6. Generate `modifierBreakdown` string (e.g. `"[18] + 3 (DEX) + 2 (Proficiency) = 23"`).
  7. Construct immutable `RollResult`.

### 5.2 Visibility Filtering
In KnockBox server authority (`ServerAuthority.cs`), delta patches (`perRecipient: false`) are broadcast to all connected clients (`"all"`). To enforce `settings.rollsVisibleToPlayers`:
- In `MatchView` and `<dndm-roll-log>`:
  - If `!isDm(state, localUserId)` and `!state.settings.rollsVisibleToPlayers`:
    - The client UI strictly filters the roll log list to entries where `roll.rollerUserId === localUserId`.
    - Rolls by the DM or other players are hidden from player view.
- In initial snapshot projection (if `perRecipient` snapshot is configured), omit rolls by other users when `rollsVisibleToPlayers` is false.

---

## 6. Client Animation Synchronization (`DiceAnimationTracker`)

### 6.1 The Spoiler Problem
In multiplayer games, broadcasting a roll immediately displays the numerical total in the roll log before the 3D physics dice finish rolling, spoiling the suspense.

### 6.2 Solution: Client-Side Gating
```
Authority broadcasts RollResult
         │
         ▼
MatchView registers roll
         │
         ├──> Shared DiceCanvas spawns 3D tumbling dice
         │
         └──> RollLog suppresses display (marked as animating: rollId)
                    │
           (Physics settle ~1.8s)
                    │
                    ▼
         DiceCanvas fires onRollComplete(rollId)
                    │
                    ▼
         DiceAnimationTracker marks rollId as settled
                    │
                    ▼
         RollLog unveils result card with natural 20/1 animations
```

### 6.3 Interrupt & Fallback Handling
- **Concurrent Rolls**: Instead of allocating separate WebGL `DiceBox` instances per user/token (which exhausts browser WebGL contexts), all concurrent rolls are pooled and simulated within the **single shared Three.js overlay canvas**.
- **Roll Interrupts**: If a new roll arrives for the same key while one is animating, instantly settle the previous roll so results are never permanently hidden.
- **Animation Timeout Safety**: If the 3D simulation stalls or WebGL crashes, a fallback timeout (3.5s) forcibly settles the roll.

---

## 7. Lit Components & UI Architecture

### 7.1 `<dndm-quick-roll-footer>`
- Positioned along the bottom of the map viewport.
- Buttons for standard polyhedral dice: **d4, d6, d8, d10, d12, d20, d100**.
- Stepper controls for die count (1–20) and modifier (`-10` to `+20`).
- Custom formula input field (`"4d6kh3 + 5"`).
- Mode toggle chips: **Normal**, **Advantage**, **Disadvantage**.
- **Keyboard Modifiers**:
  - Clicking a die while holding `Shift` rolls with **Advantage**.
  - Clicking a die while holding `Ctrl` (or `Cmd`) rolls with **Disadvantage**.

### 7.2 `<dndm-roll-log>`
- Hosted in the right rail.
- Displays chronological list of latest 50 rolls.
- Visual distinctions:
  - **Natural 20**: Golden border glow with celebratory particle effect.
  - **Natural 1**: Crimson border glow with skull/fumble indicator.
  - Advantage/Disadvantage badges showing both rolled dice with the discarded die crossed out.
  - Linked token avatar / character name.
- DM action: "Clear Log" button.

### 7.3 Modals
- `<dndm-roll-template-library>`: Manage global, built-in, and sheet-specific roll templates (e.g. "Longsword Attack: 1d20+STR", "Fireball: 8d6").
- `<dndm-roll-history>`: Full-screen modal with searchable, filterable session roll audit.

---

## 8. Scoped CSS Migration (`src/ui/styles/dice.css`)

Ported from `QuickRollFooter.razor.css`, `RollLogPanel.razor.css`, and `DiceCanvas.razor.css`:

```css
/* src/ui/styles/dice.css */
.dndm-quick-roll {
  position: absolute;
  bottom: var(--dndm-spacing-md);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--dndm-spacing-xs);
  background: var(--dndm-color-surface-translucent);
  backdrop-filter: blur(8px);
  padding: var(--dndm-spacing-xs) var(--dndm-spacing-md);
  border-radius: var(--dndm-radius-pill);
  border: 1px solid var(--dndm-color-border);
  z-index: 100;
}

.dndm-dice-canvas-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 90;
}

.dndm-roll-log-entry {
  display: flex;
  flex-direction: column;
  padding: var(--dndm-spacing-sm);
  background: var(--dndm-color-surface);
  border-left: 4px solid var(--dndm-color-accent);
  border-radius: var(--dndm-radius-sm);
  margin-bottom: var(--dndm-spacing-xs);
}

.dndm-roll-log-entry--nat20 {
  border-left-color: var(--dndm-color-gold);
  box-shadow: 0 0 8px rgba(255, 215, 0, 0.4);
}

.dndm-roll-log-entry--nat1 {
  border-left-color: var(--dndm-color-crimson);
}
```

---

## 9. Verification & Acceptance Criteria

### Automated Unit Tests
1. **`src/game/dice.test.ts`**:
   - Parse valid and invalid formulas (`"1d20+5"`, `"2d6-1"`, `"10d10+100"`, `"d8"`, invalid sides like `"2d7"`).
   - Verify `validateDiceTerms` rejects rolls exceeding 20 total dice.
   - Advantage / Disadvantage roll evaluations correctly choose highest/lowest die.
   - Natural 20 and Natural 1 flags populate accurately.
2. **`src/game/rules.test.ts` (Dice Suite)**:
   - `rollDice` produces a valid `RollResult` and appends to `rollLog`.
   - `rollLog` caps at 50 entries, evicting the oldest entry on roll 51.
   - `clearRollLog` only permitted by DM; non-DM attempt is rejected.
   - Client-side visibility filtering conceals non-player rolls when `rollsVisibleToPlayers` is false.
3. **`src/ui/dice/diceAnimationTracker.test.ts`**:
   - Gating delays entry reveal until `markSettled(rollId)` is invoked.
   - Timeout fallback safely settles after 3.5s if no complete event fires.

### Acceptance Checklist ("Done when")
- [ ] Clicking a die in `<dndm-quick-roll-footer>` launches 3D tumbling dice on the shared Three.js overlay canvas.
- [ ] Shift-clicking rolls with Advantage; Ctrl-clicking rolls with Disadvantage.
- [ ] Result appears in `<dndm-roll-log>` only after the 3D dice finish tumbling.
- [ ] Roll log caps strictly at 50 rolls and updates across multiple browser tabs.
- [ ] Non-DM players only see their own rolls when `rollsVisibleToPlayers` is false.
- [ ] DM can clear the roll log.
- [ ] Natural 20s and Natural 1s have visual callouts.
- [ ] `npm test && npm run typecheck && npm run lint` pass cleanly.
