/**
 * IndexedDB schema, store names, and key builders for DnD Mapper.
 *
 * Layout:
 *   Database "DnDMapper", version 1
 *     stores:
 *       library      JSON - sharded slot data ({slotId}:core, {slotId}:map:{mapId}, {slotId}:sheet:{sheetId})
 *       slots_index  JSON - the slot list ("singleton")
 *       images       Blob - keyed by image ID
 */

import type {
  CharacterSheet,
  DndMapperSettings,
  GameMap,
  LoadedDiceRule,
  NamedTemplate,
  RollTemplate,
} from "../game/domain.js";
import type { AttributeSchema } from "../game/domain.js";

export const DB_NAME = "DnDMapper";
export const DB_VERSION = 1;

export const STORE_LIBRARY = "library";
export const STORE_SLOTS_INDEX = "slots_index";
export const STORE_IMAGES = "images";

export const AUTO_SLOT_ID = "__auto__";
export const AUTO_SLOT_NAME = "Auto Save";
export const SLOTS_INDEX_KEY = "singleton";

export function coreKey(slotId: string): string {
  return `${slotId}:core`;
}

export function mapKey(slotId: string, mapId: string): string {
  return `${slotId}:map:${mapId}`;
}

export function sheetKey(slotId: string, sheetId: string): string {
  return `${slotId}:sheet:${sheetId}`;
}

export type SlotKind = "Auto" | "Manual";

export interface SlotIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: SlotKind;
  readonly updatedUtc: string; // ISO 8601 string
}

export interface SlotsIndex {
  readonly slots: readonly SlotIndexEntry[];
}

export interface SlotInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: SlotKind;
  readonly updatedUtc: string;
}

export interface LibraryCoreSnapshot {
  readonly schemaVersion: number;
  readonly settings: DndMapperSettings;
  readonly attributeSchema: AttributeSchema;
  readonly activeSchemaTemplateId: string | null;
  readonly initiativeAttributeName: string | null;
  readonly customTemplates: readonly NamedTemplate[];
  readonly globalRollTemplates: readonly RollTemplate[];
  readonly loadedDiceRules: readonly LoadedDiceRule[];
  readonly mapIds: readonly string[];
  readonly sheetIds: readonly string[];
}

export type MapShard = GameMap;
export type SheetShard = CharacterSheet;
