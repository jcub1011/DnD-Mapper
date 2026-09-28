/*
 * Campaign save/load helper.
 *
 * Save/load is a pure-local IndexedDB path with zero network: the host swaps
 * a loaded slot directly into its store (`MatchView.applyLoaded`) instead of
 * streaming it through intents. The old chunked `beginImport` / `importChunk`
 * / `commitImport` protocol was removed in Phase 03 — the host holds full
 * maps, so no chunk budget applies.
 */

import type { DndMapperState } from "./domain.js";

/**
 * True when the state holds any campaign content worth restoring or
 * protecting from an overwrite prompt (maps or character sheets).
 */
export function hasCampaignContent(state: DndMapperState): boolean {
  return state.maps.length > 0 || Object.keys(state.sheets).length > 0;
}
