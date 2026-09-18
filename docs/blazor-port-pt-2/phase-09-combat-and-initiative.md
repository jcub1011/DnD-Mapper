# Phase 9 — Initiative & Combat Tracker

## 1. Executive Summary & Scope

Phase 9 implements the Combat and Initiative Tracker, coordinating turn order, round progression, combatant status, and visual map highlights during tactical encounters.

In tabletop roleplaying games, combat requires tight orchestration between the DM and players: rolling initiative, sorting turn order, resolving ties, advancing turns, tracking round counts, and maintaining awareness of whose turn is currently active on the map. Phase 9 binds character sheet attributes (Phase 6) and dice rolls (Phase 7) to tokens on the Phaser canvas, providing synchronized DM controls and player initiative banners.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Combat Tracker Pipeline                         │
├─────────────────────────┬────────────────────────┬─────────────────────┤
│   Domain & Authority    │    Phaser 4 Canvas     │       Lit UI        │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ • WaitingForRolls ->    │ • Active turn halo /   │ • <dndm-host-       │
│   Active state machine  │   golden glow ring     │   initiative> (DM)  │
│ • Turn order sorting    │ • Focus camera on      │ • <dndm-initiative- │
│ • Tie-breaking logic    │   active combatant     │   banner> (Players) │
│ • Batch NPC rolling     │ • Status effect chips  │ • HP & AC badges    │
└─────────────────────────┴────────────────────────┴─────────────────────┘
```

---

## 2. Legacy Codebase References

Ported directly from `KnockBox.DndMapper`:
- **Razor Components & Code**:
  - `Pages/Components/HostInitiativePanel.razor` (and `.cs`, `.css` — 228 lines CSS)
  - `Pages/Components/InitiativeBanner.razor` (and `.cs`, `.css`)
- **Domain State**:
  - `Services/State/Games/Data/CombatState.cs`
  - `Services/State/Games/Data/CombatantEntry.cs`
- **Helpers & Logic**:
  - `Helpers/TurnOrderSorter.cs` — Sorts combatants by initiative roll descending, players before NPCs, and alphabetical by name.
  - `Helpers/InitiativeAnimationGate.cs` — Delays banner updates until initiative dice finish rolling.
  - `DndMapperGameEngine.cs:1469-2093` (11 combat verbs)

---

## 3. Domain Models & Wire Contract

### 3.1 Domain Types (`src/game/domain.ts`)

Aligning with legacy Blazor parity:

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

### 3.2 Wire Intents (`src/game/types.ts`)

Add 11 combat verbs to `Intent`:

```ts
export type Intent =
  // ... existing intents ...
  | { readonly kind: "startCombat"; readonly mapId: string; readonly npcTokenIds?: readonly string[] }
  | { readonly kind: "endCombat" }
  | { readonly kind: "nextTurn" }
  | { readonly kind: "previousTurn" }
  | {
      readonly kind: "rollInitiative";
      readonly combatantId: string;
      readonly rollOverride?: number;
    }
  | {
      readonly kind: "forceInitiativeRoll";
      readonly combatantId: string;
      readonly score?: number;
    }
  | {
      readonly kind: "setNpcInitiative";
      readonly combatantId: string;
      readonly score: number;
    }
  | { readonly kind: "rollAllUnsetNpcs" }
  | { readonly kind: "rollAllNpcInitiative" }
  | { readonly kind: "addCombatant"; readonly tokenId: string; readonly initiativeRoll: number }
  | { readonly kind: "removeCombatant"; readonly combatantId: string };
```

### 3.3 Narrowed Patches (`src/game/types.ts`)

```ts
export type Patch =
  // ... existing patches ...
  | { readonly kind: "combat"; readonly combat: CombatState | null };
```

- **Frame Size Budget**: An entire `CombatState` with 20 combatants consumes ~2.5 KiB JSON, well within the 400 KiB broadcast limit.

---

## 4. Authority Combat Engine & Rules (`src/game/combat.ts` & `src/game/rules.ts`)

### 4.1 Combat State Machine
```
                     startCombat()
        [Inactive] ─────────────────> [WaitingForRolls]
            ▲                                │
            │                                │ All combatants have rolls
            │ endCombat()                    │ OR DM forces active
            │                                ▼
            └─────────────────────────── [Active]
                                         │  ▲
                              nextTurn() │  │ previousTurn()
                                         ▼  │
                                    (Turns cycle)
                                 (roundNumber updates)
```

### 4.2 Lifecycle Rules
1. **`startCombat(mapId, npcTokenIds?)`**:
   - Collects visible tokens on `mapId` (optionally filtered to `npcTokenIds` if provided).
   - Maps each token to a `CombatantEntry`. If token has a linked `CharacterSheet`, pulls name and owner.
   - Sets `phase = "WaitingForRolls"`, `roundNumber = 1`, `currentTurnIndex = 0`.
2. **`rollInitiative(combatantId)`**:
   - Evaluates a d20 roll + `initiativeAttribute` (e.g. DEX modifier) from linked character sheet.
   - Updates `initiativeRoll`.
   - If all combatants now have rolls, automatically advances phase to `Active` and sorts turn order.
3. **`rollAllUnsetNpcs()` & `rollAllNpcInitiative()`**:
   - Iterates through all combatants where `ownerUserId === null` (and `initiativeRoll === null` for unset).
   - Rolls d20 + DEX modifier for each NPC.
4. **`setNpcInitiative(combatantId, score)`**:
   - DM stages a manual score into `pendingInitiative`.
   - When committed or batch-rolled, the visible d20 face is back-solved: `face = Math.clamp(score - dexModifier, 1, 20)`.
5. **`addCombatant(tokenId, initiativeRoll)`**:
   - Inserts an ad-hoc combatant with the specified initiative score into the active combat encounter and re-sorts turn order.
6. **Turn Order Progression**:
   - **`nextTurn`**:
     - `currentTurnIndex = (currentTurnIndex + 1) % turnOrder.length`.
     - When index wraps to 0, `roundNumber` increments by 1.
   - **`previousTurn`**:
     - `currentTurnIndex = (currentTurnIndex - 1 + turnOrder.length) % turnOrder.length`.
     - If index was 0, decrements `roundNumber` clamped to minimum 1 (`Math.max(roundNumber - 1, 1)`).
7. **`endCombat()`**:
   - Resets `state.activeCombat = null`.

### 4.3 Turn Order Sorting (`sortTurnOrder`)
Pure sorting function matching legacy `TurnOrderSorter.cs:11-15`:
1. **Primary**: Descending by `initiativeRoll` (`null` / unset rolls sink to the bottom via `Number.NEGATIVE_INFINITY`).
2. **Secondary (Tie-breaker)**: Players before NPCs (`ownerUserId !== null ? 0 : 1`).
3. **Tertiary (Tie-breaker)**: Alphabetical by Name (`name.localeCompare(other.name, undefined, { sensitivity: "accent" })`).
*Note*: Character sheet DEX modifier is **not** evaluated as a separate tie-breaker because it was already incorporated into the roll total.

---

## 5. Map Canvas Integration (Phaser 4)

In [`src/ui/map/MapScene.ts`](../../src/ui/map/MapScene.ts) and [`src/ui/map/tokenLayer.ts`](../../src/ui/map/tokenLayer.ts):

1. **Active Turn Halo (`ResolveActiveTurnTokenId`)**:
   - Derive the active token ID from `state.activeCombat`:
     ```ts
     const activeTokenId = state.activeCombat?.phase === "Active"
       ? state.activeCombat.turnOrder[state.activeCombat.currentTurnIndex]?.tokenId
       : null;
     ```
   - If a token matches `activeTokenId`:
     - Render an animated golden selection ring (`0xffd700`) around the token with pulsing alpha (`0.4` to `0.9` over 800ms ease-in-out).
2. **Double-Click Combatant Focus**:
   - Clicking a combatant row in `<dndm-host-initiative>` pans the camera to center that token on the map using `fx.map()?.panToWorld(token.x * 50, token.y * 50)`.

---

## 6. Lit Components & UI Architecture

### 6.1 `<dndm-host-initiative>` (DM Right Rail)
- **Header Controls**:
  - Round counter display (`"Round 3"`).
  - Next Turn (`>`) and Previous Turn (`<`) buttons.
  - End Encounter button with confirmation.
- **Roll Actions** (in `WaitingForRolls`):
  - "Roll All Unset NPCs" action button.
  - Manual score input fields for staging pending NPC rolls.
- **Combatant Roster**:
  - Draggable or ordered list of combatants.
  - Active combatant row highlighted with golden accent bar.
  - Per-combatant cards showing:
    - Token avatar / color chip.
    - Combatant name.
    - Initiative score badge.
    - Quick HP editor (`Current / Max`) and AC badge.
    - Active status effect chips.
    - Remove from combat button (`✕`).
  - "Add Combatant" button to pull an ad-hoc token into the encounter.

### 6.2 `<dndm-initiative-banner>` (Player View)
- Positioned across the top of the canvas or top of the right rail.
- **Phase: `WaitingForRolls`**:
  - Prominently displays: `"Roll Initiative!"` with a direct roll button for the player's character.
- **Phase: `Active`**:
  - Displays:
    - `"YOUR TURN!"` (with golden pulse) if active combatant belongs to current player.
    - `"Grog's Turn (Round 2)"` if another combatant is active.
    - Next up indicator: `"Up Next: Vex'ahlia"`.

---

## 7. Scoped CSS Migration (`src/ui/styles/initiative.css`)

Ported from `HostInitiativePanel.razor.css` and `InitiativeBanner.razor.css`:

```css
/* src/ui/styles/initiative.css */
.dndm-initiative-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: var(--dndm-spacing-sm);
}

.dndm-initiative-round-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--dndm-color-surface-elevated);
  padding: var(--dndm-spacing-xs) var(--dndm-spacing-sm);
  border-radius: var(--dndm-radius-md);
  font-weight: bold;
}

.dndm-combatant-card {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: var(--dndm-spacing-xs);
  padding: var(--dndm-spacing-xs) var(--dndm-spacing-sm);
  background: var(--dndm-color-surface);
  border-left: 3px solid transparent;
  border-radius: var(--dndm-radius-sm);
  transition: all 150ms ease;
}

.dndm-combatant-card--active {
  background: var(--dndm-color-surface-elevated);
  border-left-color: var(--dndm-color-gold);
  box-shadow: inset 0 0 10px rgba(255, 215, 0, 0.15);
}

.dndm-initiative-banner {
  position: absolute;
  top: var(--dndm-spacing-md);
  left: 50%;
  transform: translateX(-50%);
  background: var(--dndm-color-surface-translucent);
  backdrop-filter: blur(8px);
  padding: var(--dndm-spacing-xs) var(--dndm-spacing-lg);
  border-radius: var(--dndm-radius-pill);
  border: 1px solid var(--dndm-color-border);
  z-index: 80;
  text-align: center;
}

.dndm-initiative-banner--my-turn {
  border-color: var(--dndm-color-gold);
  color: var(--dndm-color-gold);
  animation: pulseGlow 1.5s infinite alternate;
}
```

---

## 8. Verification & Acceptance Criteria

### Automated Unit Tests
1. **`src/game/combat.test.ts`**:
   - `startCombat` captures active map tokens and initializes `roundNumber: 1`, `phase: "WaitingForRolls"`.
   - `rollInitiative` assigns scores and transitions to `Active` when all rolls are in.
   - `sortTurnOrder` orders descending by score and breaks ties using players-before-NPCs, then alphabetical order.
   - `nextTurn` increments index and increments `roundNumber` upon completing a full cycle.
   - `previousTurn` decrements index and decrements `roundNumber` (clamped to minimum 1) when wrapping backwards.
   - `endCombat` cleans up state back to `null`.
2. **`src/game/rules.test.ts` (Combat Authorization)**:
   - Non-DM cannot call `startCombat`, `endCombat`, `nextTurn`, `previousTurn`, or `rollAllUnsetNpcs`.
   - Player can only call `rollInitiative` on a combatant they own.
3. **`src/ui/panels/initiative.test.ts`**:
   - Banner displays "YOUR TURN!" when the local user's token is active.
   - Clicking combatant row triggers viewport centering.

### Acceptance Checklist ("Done when")
- [ ] DM can start combat; all tokens on active map appear in the tracker.
- [ ] Players see the "Roll Initiative!" banner and can submit their roll.
- [ ] DM can click "Roll All Unset NPCs" to resolve NPC initiative in one action.
- [ ] Turn order sorts correctly (score descending, players first, alphabetical tie-break).
- [ ] The active combatant's token displays an animated golden halo on the Phaser canvas.
- [ ] Next/Previous buttons step through combatants and advance round numbers.
- [ ] DM can add and remove combatants dynamically.
- [ ] `npm test && npm run typecheck && npm run lint` pass cleanly.
