/**
 * Whole-character-sheet popout window protocol.
 *
 * The opener (main window) launches a popup at `?view=sheet&sheetId=<id>`.
 * The popup boots the same bundle but skips Phaser/network (see main.ts) and
 * renders a single `<dndm-character-sheet>` as a pure BroadcastChannel client
 * (mirrors the `dndm-display-sync` projector pattern):
 *
 * - opener -> popup: `{ type: "sheet-state", ... }` (full sheet snapshot +
 *   the context the sheet component needs: schema, templates, settings,
 *   roster, map summaries, identity flags)
 * - popup  -> opener: `{ type: "sheet-join", sheetId }` on connect
 * - popup  -> opener: `{ type: "sheet-edit", sheetId, intent }` (allowed
 *   intents only — delete, duplicate, and place-token are main-window-only)
 * - opener -> popup: `{ type: "sheet-close", sheetId }` on teardown/delete
 * - popup  -> opener: `{ type: "sheet-leave", sheetId }` on beforeunload
 *
 * All payloads are strict JSON (structured-clone safe, no functions).
 */

import type {
  AttributeSchema,
  AttributeValue,
  CharacterSheet,
  DndMapperSettings,
  MapSummary,
  StatusEffect,
  StatusEffectTemplate,
} from "../../game/domain";

export const SHEET_SYNC_CHANNEL = "dndm-sheet-sync";

export type SheetPatch = Partial<
  Pick<CharacterSheet, "characterName" | "color" | "scopedMapId" | "notes">
>;

/**
 * Edit intents a sheet popout may send. Deliberately a subset of the
 * authority `Intent` union: destructive/canvas-coupled actions
 * (deleteSheet, duplicateSheet, place-token/spawnToken, createSheet,
 * setSchemaPreset) are main-window-only and rejected by the opener.
 */
export type SheetEditIntent =
  | { readonly kind: "updateSheet"; readonly patch: SheetPatch }
  | { readonly kind: "assignSheetOwner"; readonly ownerUserId: string | null }
  | { readonly kind: "setSheetHp"; readonly hp: number | null }
  | { readonly kind: "setSheetMaxHp"; readonly maxHp: number | null }
  | { readonly kind: "setSheetAc"; readonly ac: number | null }
  | {
      readonly kind: "updateAttributeValues";
      readonly values: Readonly<Record<string, AttributeValue>>;
    }
  | {
      readonly kind: "applyStatusEffect";
      readonly effect: Omit<StatusEffect, "id" | "appliedUtc">;
    }
  | { readonly kind: "removeStatusEffect"; readonly effectId: string };

export interface SheetStateMessage {
  type: "sheet-state";
  sheetId: string;
  /** Null when the sheet was deleted or is no longer visible to the viewer. */
  sheet: CharacterSheet | null;
  attributeSchema: AttributeSchema;
  statusEffectTemplates: Readonly<Record<string, StatusEffectTemplate>>;
  settings: DndMapperSettings;
  isDm: boolean;
  currentUserId: string | null;
  roster: readonly { readonly id: string; readonly name: string }[];
  dmPlayerId: string | null;
  /** Summaries only (never full maps with tokens/images/fog). */
  maps: readonly MapSummary[];
  activeMapId: string | null;
}

export interface SheetEditMessage {
  type: "sheet-edit";
  sheetId: string;
  intent: SheetEditIntent;
}

export interface SheetJoinMessage {
  type: "sheet-join";
  sheetId: string;
}

export interface SheetLeaveMessage {
  type: "sheet-leave";
  sheetId: string;
}

export interface SheetCloseMessage {
  type: "sheet-close";
  sheetId: string;
}

export type SheetSyncMessage =
  SheetStateMessage | SheetEditMessage | SheetJoinMessage | SheetLeaveMessage | SheetCloseMessage;

/** `?view=sheet&sheetId=<id>` — the popup route (same bundle, no net boot). */
export function buildSheetPopoutUrl(sheetId: string): string {
  return `?view=sheet&sheetId=${encodeURIComponent(sheetId)}`;
}

export function parseSheetPopoutParams(search: string): {
  isSheetPopout: boolean;
  sheetId: string | null;
} {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { isSheetPopout: false, sheetId: null };
  }
  if (params.get("view") !== "sheet") return { isSheetPopout: false, sheetId: null };
  const sheetId = params.get("sheetId");
  return { isSheetPopout: true, sheetId: sheetId && sheetId.length > 0 ? sheetId : null };
}

export function isSheetPopoutLocation(
  locationLike: { search?: string | null } | undefined,
): boolean {
  try {
    return parseSheetPopoutParams(locationLike?.search ?? "").isSheetPopout;
  } catch {
    return false;
  }
}
