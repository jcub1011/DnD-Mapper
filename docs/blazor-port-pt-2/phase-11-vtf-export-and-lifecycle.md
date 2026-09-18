# Phase 11 — Campaign Exporter (.vtf Packager) & Final Parity Polish

## 1. Executive Summary & Scope

Phase 11 completes the journey to 100% functional and behavioral parity with the legacy `KnockBox.DndMapper` Blazor application.

This phase implements two vital capabilities:
1. **The Campaign Exporter**: A pure client-side packager that bundles maps, fog bitsets, tokens, character sheets, loaded dice rules, and image binary blobs into standard Virtual Table Format (`.vtf` v1.0.0) ZIP archives.
2. **Player Lifecycle & Abandonment Reassignment**: Robust handling for players disconnecting during long campaigns, ensuring their tokens and character sheets remain on the board as NPCs and can be reassigned by the DM to other players.
3. **End-to-End Parity Audit**: Final verification across all ~84 legacy engine verbs, all 34 ported CSS styles, performance baselines, and WebSocket frame safety budgets.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Phase 11 Final Parity Capstone                    │
├─────────────────────────┬────────────────────────┬─────────────────────┤
│   .vtf ZIP Exporter     │    Player Lifecycle    │   End-to-End Audit  │
├─────────────────────────┼────────────────────────┼─────────────────────┤
│ • Pure browser ZIP      │ • Auto-spawn on start  │ • 84 verbs verified │
│ • Deflate-raw stream    │ • Player -> NPC on     │ • 512 KiB guards    │
│ • IndexedDB blob dump   │   disconnect           │ • Snapshot budget   │
│ • manifest & entities   │ • representsUserId     │ • Rate-limit stress │
│ • 1-click slot download │ • DM reassignment UI   │ • Strict JSON audit │
└─────────────────────────┴────────────────────────┴─────────────────────┘
```

---

## 2. Legacy Codebase References

Ported directly from `KnockBox.DndMapper`:
- **VTF Exporter**:
  - `Services/Library/Vtf/VtfPackager.cs` (599 lines) — C# ZIP packager.
  - `Services/Library/Vtf/VtfDocument.cs`
  - `wwwroot/js/dndMapperVtfPackager.js` (282 lines) — Browser-side ZIP generation using raw deflate.
- **Player Lifecycle**:
  - `DndMapperGameEngine.cs:88-95` (`HandlePlayerLeft`)
  - `DndMapperGameEngine.cs:3547-3600` (`ConvertAbandonedPlayerCharacterInternal`, `SpawnPlayerTokenInternal`)
- **Authority Engine Complete Audit**:
  - `DndMapperGameEngine.cs` (~84 verbs, 3,703 lines)

---

## 3. Subsystem A: Campaign Exporter (.vtf Packager)

### 3.1 Spec Specification (VTF v1.0.0 Archive)
The `.vtf` file is a standard ZIP archive containing:
```
{CampaignName}_{yyyyMMdd_HHmm}.vtf
 ├── manifest.json                        # Spec version "1.0.0", campaign title, timestamp
 ├── global_state.json                    # Settings, custom templates, roll templates, schema, and vendorData.knockbox_dnd_mapper.loadedDiceRules
 ├── scenes/
 │    └── scene_{mapId}.json              # Grid config, fog bitset, list order, token refs
 ├── entities/
 │    ├── entity_{tokenId}.json           # Token definitions (x, y, color, sheetId)
 │    └── sheet_{sheetId}.json            # Character sheet (scores, HP, notes, status effects)
 ├── assets/
 │    └── images/
 │         └── {imageId}.[png|jpg|webp]   # Binary image blobs extracted from IndexedDB
 └── extensions/
      └── knockbox_dnd_mapper.json        # Active combat state (ActiveCombat) and phase (Phase) only
```

### 3.2 Pure Browser Packaging (`src/vtf/export.ts`)
Porting `dndMapperVtfPackager.js`:
- Uses the web standard `CompressionStream("deflate-raw")` available natively in all modern browsers.
- Constructs:
  - Local file header (`0x04034b50`) for each file entry.
  - File payload with CRC32 checksum and uncompressed/compressed sizes.
  - Central directory file headers (`0x02014b50`).
  - End of Central Directory (EOCD) record (`0x06054b50`).
- **Memory Safety**: Streams file by file without loading the entire archive into a single continuous memory buffer, staying safely under the browser memory cap for archives up to 500 MB.
- **Blob Retrieval**: Queries `LibraryService` (IndexedDB) to extract original image blobs by `imageId`.
- **Browser Download Trigger & Delayed URL Revocation**:
  ```ts
  const blob = new Blob([zipBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeName(campaign.title)}_${formatDate(now)}.vtf`;
  a.click();
  // Must delay URL revocation to prevent race-condition 0-byte download corruption
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  ```

### 3.3 UI Integration
In [`src/ui/panels/dndm-saves-panel.ts`](../../src/ui/panels/dndm-saves-panel.ts):
- Add an `"Export"` button alongside each saved campaign slot.
- Disables button and displays a progress spinner while packing large image assets.

---

## 4. Subsystem B: Player Lifecycle & Disconnect Handling

### 4.1 Auto-Spawn on Session Start
When the DM clicks `"Start Session"` (`phase = "Playing"`):
- Iterate through connected players in `match.roster`.
- For each player lacking an active token on the active map:
  - Spawn a `PlayerToken` at `map.defaultSpawnPosition` (or map midpoint).
  - Assign `token.ownerUserId = player.id`.

### 4.2 Disconnect & Abandonment Conversion
In `src/game/rules.ts` when a player leaves (`onPlayerLeft`):
- If the disconnecting player is the DM, succession promotes the oldest connected peer.
- If a non-DM player disconnects:
  - Find all tokens where `token.ownerUserId === leavingPlayerId`.
  - Convert `token.type = "NPCToken"`.
  - Clear `token.ownerUserId = null`.
  - Set `token.representsUserId = leavingPlayerId`.
  - On any linked `CharacterSheet`:
    - Set `sheet.ownerUserId = null`.
    - Set `sheet.representsUserId = leavingPlayerId`.
- **Visual Distinction**:
  - Tokens and character sheets show a subtitle: `"(originally played by <PlayerName>)"`.
  - Prevents the character from vanishing from the board or combat tracker mid-fight.

### 4.3 DM Reassignment Action
- In `<dndm-token-panel>` and `<dndm-character-sheet>`:
  - For any token or sheet where `ownerUserId === null` (including abandoned characters):
    - DM sees an **"Assign Owner"** dropdown listing all currently connected lobby players.
    - Selecting a player emits `assignSheetOwner` and `updateToken`, converting the token back to a `PlayerToken` owned by the new player.

---

## 5. Subsystem C: Comprehensive Parity Verification

### 5.1 Authority Verbs Final Accounting (84 Verbs)
Verify that all 84 legacy verbs are handled in `src/game/rules.ts`:

| Category | Verbs | Phase |
| :--- | :--- | :--- |
| **Maps (8)** | `createMap`, `switchMap`, `deleteMap`, `renameMap`, `reorderMaps`, `setGridConfig`, `duplicateMap`, `exportMapImage` | Part 1 |
| **Fog of War (5)** | `setFogBitset`, `fillFog`, `clearFog`, `revealAllFog`, `hideAllFog` | Part 1 |
| **Tokens (8)** | `createToken`, `moveToken`, `deleteToken`, `updateToken`, `reorderTokens`, `duplicateToken`, `spawnPlayerToken`, `reassignTokenOwner` | Part 1 / Phase 11 |
| **Images (5)** | `placeImage`, `transformImage`, `deleteImage`, `reorderImages`, `lockImage` | Part 1 |
| **Focus (2)** | `setFocusRect`, `clearFocusRect` | Part 1 |
| **Saves (3)** | `saveCampaign`, `loadCampaign`, `deleteCampaignSave` | Part 1 |
| **Sheets (10)** | `createSheet`, `updateSheet`, `deleteSheet`, `duplicateSheet`, `assignSheetOwner`, `assignCharacterToPlayer`, `setSheetHp`, `setSheetMaxHp`, `setSheetAc`, `updateAttributeValues` | Phase 6 / Phase 11 |
| **Schemas (3)** | `setSchemaPreset`, `updateSchemaRows`, `setInitiativeAttribute` | Phase 6 |
| **Status Effects (6)** | `applyStatusEffect`, `updateStatusEffect`, `removeStatusEffect`, `createEffectTemplate`, `updateEffectTemplate`, `deleteEffectTemplate` | Phase 6 |
| **Custom Templates (6)** | `createCustomTemplate`, `updateCustomTemplate`, `deleteCustomTemplate`, `applyCustomTemplate`, `duplicateCustomTemplate`, `reorderCustomTemplates` | Phase 6 |
| **Dice & Rolls (7)** | `rollDice`, `rollTemplate`, `updateRollTemplate`, `createGlobalRollTemplate`, `updateGlobalRollTemplate`, `deleteGlobalRollTemplate`, `clearRollLog` | Phase 7 |
| **Loaded Dice (6)** | `createLoadedDiceRule`, `updateLoadedDiceRule`, `deleteLoadedDiceRule`, `toggleLoadedDiceRule`, `reorderLoadedDiceRules`, `updateHostKeys` | Phase 8 |
| **Combat Tracker (11)** | `startCombat`, `endCombat`, `nextTurn`, `previousTurn`, `rollInitiative`, `forceInitiativeRoll`, `setNpcInitiative`, `rollAllUnsetNpcs`, `rollAllNpcInitiative`, `addCombatant`, `removeCombatant` | Phase 9 |
| **Markup Overlay (2)** | `updateMarkup`, `clearMarkup` | Phase 10 |
| **Lifecycle & Sync (2)** | `endSession`, `syncClientState` | Phase 11 |

### 5.2 Strict JSON & Sandbox Guard Verification
Run automated sandbox linter and serialization checks:
- No `undefined` across state or any patch.
- No `Date`, `Map`, `Set`, or circular object graphs.
- No DOM references in `src/game/` or `src/authority/`.
- All timestamps use `kb.now()` clock injection.

---

## 6. Verification & Acceptance Criteria

### Automated Unit Tests
1. **`src/vtf/export.test.ts`**:
   - Packages valid `.vtf` archive from in-memory state.
   - ZIP structure matches spec v1.0.0 with manifest, global state, scenes, entities, and extensions.
   - Exported archive re-imports cleanly through `importVtf` with 100% round-trip fidelity (fog bitsets, grid dimensions, token positions, sheet attributes match byte-for-byte).
2. **`src/game/playerLifecycle.test.ts`**:
   - `onPlayerLeft` converts player tokens to NPC tokens and sets `representsUserId`.
   - Character sheets clear `ownerUserId` and record `representsUserId`.
   - DM can reassign abandoned sheet and token to a new player ID.
3. **`src/authority/snapshotBudget.test.ts`**:
   - Campaign with 24 maps, 50 sheets, 100 tokens, and full roll log projects active map snapshot under **400 KiB**.

### Acceptance Checklist ("Done when")
- [ ] DM can click "Export" on any save slot to download a valid `.vtf` ZIP file.
- [ ] Exported `.vtf` can be imported into another browser or fresh session without data loss.
- [ ] When a player leaves the room, their token turns into an NPC and stays on the board.
- [ ] DM can reassign the abandoned token/sheet to another connected player.
- [ ] All 84 legacy verbs are functional and covered by automated tests.
- [ ] `npm test && npm run typecheck && npm run lint && npm run build` pass with zero errors.
