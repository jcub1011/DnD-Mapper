/**
 * DTOs for the Virtual Table Format (.vtf) spec, v1.0.0.
 *
 * Unknown fields from newer minor revisions are captured in `extra` so they
 * survive without data loss.
 */

import type {
  AttributeSchema,
  CharacterSheet,
  CombatState,
  DndMapperPhase,
  DndMapperSettings,
  DndMapperState,
  GameMap,
  GridConfig,
  LoadedDiceRule,
  NamedTemplate,
  RollTemplate,
} from "../game/domain.js";

export interface VtfManifest {
  readonly vtfVersion: string;
  readonly campaign: VtfCampaign;
  readonly system: VtfSystem;
  readonly dependencies: readonly VtfDependency[];
  readonly entryState?: VtfEntryState | null;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfCampaign {
  readonly id: string;
  readonly title: string;
  readonly author?: string | null;
  readonly lastModified: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfSystem {
  readonly core: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfDependency {
  readonly name: string;
  readonly minVersion?: string | null;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfEntryState {
  readonly activeScene?: string | null;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfGlobalState {
  readonly campaignTime?: Readonly<Record<string, unknown>>;
  readonly playlist?: readonly unknown[];
  readonly vendorData?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfDimensions {
  readonly width: number;
  readonly height: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfGridMeasurement {
  readonly distance: number;
  readonly unit: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfGrid {
  readonly type: string;
  readonly size: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly color?: string | null;
  readonly visible: boolean;
  readonly measurement?: VtfGridMeasurement | null;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfLayer {
  readonly id: string;
  readonly name?: string | null;
  readonly type: string;
  readonly assetRef?: string | null;
  readonly zIndex: number;
  readonly opacity: number;
  readonly vendorData?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfGridPosition {
  readonly x: number;
  readonly y: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfPixelOffset {
  readonly x: number;
  readonly y: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfTransform {
  readonly gridPosition?: VtfGridPosition | null;
  readonly pixelOffset?: VtfPixelOffset | null;
  readonly rotation: number;
  readonly scale: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfEntityInstance {
  readonly instanceId: string;
  readonly entityRef?: string | null;
  readonly transform: VtfTransform;
  readonly localOverrides?: Readonly<Record<string, unknown>>;
  readonly vendorData?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfScene {
  readonly sceneId: string;
  readonly dimensions: VtfDimensions;
  readonly grid: VtfGrid;
  readonly ambience?: readonly unknown[];
  readonly layers: readonly VtfLayer[];
  readonly entityInstances: readonly VtfEntityInstance[];
  readonly vendorData?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfEntity {
  readonly entityId: string;
  readonly name: string;
  readonly assetRef?: string | null;
  readonly vendorData?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

// ── DnD Mapper vendor blocks ──────────────────────────────────────────────────

export interface DndMapperGlobalVendor {
  readonly settings?: DndMapperSettings;
  readonly attributeSchema?: AttributeSchema;
  readonly activeSchemaTemplateId?: string | null;
  readonly initiativeAttributeName?: string | null;
  readonly customTemplates?: readonly NamedTemplate[];
  readonly globalRollTemplates?: readonly RollTemplate[];
  readonly loadedDiceRules?: readonly LoadedDiceRule[];
  readonly mapOrder?: readonly string[];
  readonly sheetOrder?: readonly string[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface DndMapperSceneVendor {
  readonly id: string;
  readonly name: string;
  readonly listOrder: number;
  readonly createdUtc: string;
  readonly grid: GridConfig;
  readonly defaultSpawnX?: number | null;
  readonly defaultSpawnY?: number | null;
  readonly fogMask?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface VtfExtensionPayload {
  readonly activeCombat: CombatState | null;
  readonly phase: DndMapperPhase;
  readonly extra?: Readonly<Record<string, unknown>>;
}

// ── Storage and Unpack models ─────────────────────────────────────────────────

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

export interface VtfImageAsset {
  readonly id: string;
  readonly contentType: string;
  readonly blob: Blob;
  readonly fileName: string;
}

export interface UnpackResult {
  readonly slotTitle: string;
  readonly core: LibraryCoreSnapshot;
  readonly maps: readonly GameMap[];
  readonly sheets: readonly CharacterSheet[];
  readonly images: ReadonlyMap<string, VtfImageAsset>;
  readonly extension: VtfExtensionPayload;
  readonly warnings: readonly string[];
  readonly state: DndMapperState;
}

/**
 * Extracts unknown properties into the `extra` field of an object,
 * matching C#'s [JsonExtensionData] behavior so foreign/future fields survive round-trips.
 */
export function withExtra<T extends object>(data: unknown, knownKeys: readonly string[]): T {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return data as T;
  }
  const obj = data as Record<string, unknown>;
  const knownSet = new Set<string>(knownKeys);
  const extra: Record<string, unknown> = {
    ...((obj.extra as Record<string, unknown> | undefined) || {}),
  };
  let hasExtra = Object.keys(extra).length > 0;

  for (const [key, val] of Object.entries(obj)) {
    if (!knownSet.has(key) && key !== "extra") {
      extra[key] = val;
      hasExtra = true;
    }
  }

  return {
    ...obj,
    ...(hasExtra ? { extra } : {}),
  } as T;
}
