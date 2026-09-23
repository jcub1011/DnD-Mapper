# Phase 2 — True Per-Player Projection

Goal: implement the issue's "projected data" promise; resolve open Q1.

Authority is `src/game/rules.ts:94-117`; client mirrors in
`src/game/visibility.ts:61,76-85` are prediction-only and must not win.

## Steps

1. Add host-side pure `projectForPlayer(state, playerId)` +
   `projectPatchForPlayer(patch, playerId, state)` beside
   `projectSnapshot` (`src/game/rules.ts:553-566`). DM fast path returns the
   snapshot unchanged.
2. Implement filtering: hidden tokens → `tokenRemoved` tombstone; hidden images
   → `imageRemoved` (new `isImageVisibleToPlayer` — none exists today); sheets
   failing `mayViewSheet:94-99` → `sheetRemoved`, else redact `notes`/`hp` per
   `mayViewSheetNotesAndHp:102-104`; rolls gated on `rollsVisibleToPlayers`
   (`domain.ts:528,540`); combat strips hidden-token combatants +
   `pendingInitiative` (DM-only); `loadedDiceRules` gated when
   visibility=`Hidden` (`domain.ts:533-546`). Fog stays broadcast (legacy
   parity — document the leak).
3. Fan out per recipient with per-recipient `guardSize`
   (`src/game/wire.ts:41-50`, `types.ts:305-308`): `full`/`map`/`token`/
   `sheet`/`combat`/`roll`/`image` project; all other patch kinds broadcast
   as-is.
4. Remove client hiding branches (or keep as defense-in-depth):
   `tokenLayer.ts:102-173`, `token-rail.ts:74-76`,
   `character-sheet.ts:627,1048,1064,1571`, `dndm-app.ts:791-810`,
   `roll-ticker.ts:32-38`, `displayProjection.ts:30-93`.

## Completion checklist

- [ ] `projectForPlayer` + `projectPatchForPlayer` implemented (strict-JSON,
      per-recipient `guardSize` passes)
- [ ] Tombstone semantics verified (`setTokenHidden(true)` → `tokenRemoved`
      for players who had it, `null` for those who didn't; same for images)
- [ ] Sheet redaction verified (`notes`/`hp` withheld unless owner/DM)
- [ ] Roll/combat/loaded-dice gating verified per settings
- [ ] Permission-matrix unit tests pass (DM/owner/stranger × hidden/private)
- [ ] Leak test passes: guest snapshot contains no hidden bytes
- [ ] Fog-broadcast leak documented for DMs
