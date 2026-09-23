# Phase 3 — Save/Load Collapse

Goal: save is a pure-local IndexedDB write with zero network; loading applies
directly to the host store.

## Steps

1. `src/ui/app/dndm-app.ts:909-947` `applyLoadedCampaign` — replace
   `sendChunkedImport(beginImport→importChunk×N→commitImport)`
   (`src/game/campaignImport.ts:99-123`, intents `src/game/types.ts:148-159`)
   with direct `hostStore.applyLoaded(loaded)` + `ensureBoundPairs` normalize.
2. Delete host-side staging: `pendingImports` map/sweep/`fromId` checks
   (`src/game/rules.ts:570-601,1789-1846`) and `commitImport` rebuild+broadcast
   (`1859-1884`).
3. Host stops self `requestMissingMaps` / `selectMap` double-send
   (`dndm-app.ts:871-901`, `rules.ts:1774`) — keep for remote players only.
   Pass full host state (not projected `match`) to
   `libraryService.saveSlotInternal:370-494`; summary-guard +
   `lastSkippedMapIds` become backstop, not routine path.
4. Simplify `maybeOfferAutoRestore:955-974` + `bootLiveWasEmpty:681-683` +
   `shouldOfferAutoRestore` (`campaignImport.ts:87`) to a boot-local
   `__auto__` check with no lobby-phase coupling.
5. Keep unchanged: sharding, hashing, debounce, `pagehide` flush
   (`dndm-app.ts:1018`), `importSlot`, VTF import/export, upload pipeline
   (`putImage` + per-image `assetSource.publish` on load — blobs stay on the
   blob service).

## Completion checklist

- [ ] `sendChunkedImport` / `beginImport` / `importChunk` / `commitImport`
      removed from the load path
- [ ] `pendingImports` staging deleted (no sweep, no token/`fromId` checks)
- [ ] Load applies directly: filter `isFullMap` + toast dropped, normalize,
      set host state, re-`publish()` every image, fan out projected snapshot
- [ ] Save-after-load with unvisited maps persists a complete campaign
- [ ] No `beginImport` traffic in logs during save/load
- [ ] Autosave debounce, fingerprint, `pagehide` flush, VTF paths still green
