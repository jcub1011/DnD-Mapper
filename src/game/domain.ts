/*
 * Game domain models.
 *
 * Rules:
 *   1. Cell coordinates everywhere. 1 unit = 1 grid cell. Tokens anchor at cell
 *      centres (x.5, y.5); images anchor at corners (x, y).
 *   2. Strict JSON only. No `undefined` (use `null`), no `Date`, `Map`, `Set`,
 *      classes, functions, or circular references.
 *   3. Shared between client and server authority sandbox.
 */

import type { FogMaskB64 } from "./fog.js";

/** Square grids only. */
export interface GridConfig {
  readonly widthCells: number;
  readonly heightCells: number;
  readonly cellPixels: number;
  readonly showGridLines: boolean;
  readonly snapToGrid: boolean;
  readonly lineColor: string;
}

export interface MapImage {
  readonly id: string;
  readonly name: string;
  readonly contentType: string; // "image/png" | "image/jpeg" | "image/webp"
  readonly shareToken: string | null;

  // Geometry in CELL units, CORNER-anchored.
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly rotation: number; // Degrees
  readonly opacity: number; // 0..1

  readonly layerOrder: number;
  readonly locked: boolean;
  readonly hidden: boolean;

  // Provenance
  readonly byteSize: number;
  readonly wasDownscaled: boolean;
  readonly originalLongEdgePx: number;
  readonly displayLongEdgePx: number;
}

export type TokenType = "PlayerToken" | "NPCToken";
export type TokenIconKind = "Initial" | "Solid";

export interface Token {
  readonly id: string;
  readonly type: TokenType;
  readonly ownerUserId: string | null;
  readonly representsUserId: string | null;
  readonly name: string;
  readonly color: string;
  readonly iconKind: TokenIconKind;
  readonly mapId: string;

  /** CELL units at cell CENTRES (x.5, y.5). */
  readonly x: number;
  readonly y: number;

  readonly sheetId: string | null;
  readonly hidden: boolean;
}

export interface GameMap {
  readonly id: string;
  readonly name: string;
  readonly grid: GridConfig;
  readonly images: readonly MapImage[];
  readonly tokens: readonly Token[];
  readonly createdUtc: string; // ISO 8601 string
  readonly listOrder: number;

  /** Where new tokens spawn. `null`, never undefined. */
  readonly defaultSpawnPosition: { readonly x: number; readonly y: number } | null;

  /** Serialized SVG inner markup from freehand drawing. */
  readonly markupSvg: string | null;

  /** Packed row-major bitset, base64-encoded. Length = ceil((w * h) / 8). */
  readonly fogMask: FogMaskB64;

  readonly fogVersion?: number;
  readonly imagesVersion?: number;
  readonly imagesMembershipVersion?: number;
}

/** Summarized map metadata for maps not actively rendering. */
export interface MapSummary {
  readonly id: string;
  readonly name: string;
  readonly listOrder: number;
  readonly widthCells: number;
  readonly heightCells: number;
}

export type NewToken = Omit<Token, "id" | "mapId" | "ownerUserId" | "representsUserId">;
export type NewMapImage = Omit<MapImage, "id" | "shareToken" | "layerOrder">;

export interface FocusRect {
  readonly mapId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CenterViewportRequest {
  readonly mapId: string;
  readonly x: number;
  readonly y: number;
  readonly nonce: string;
}

// ── Character Sheets & Attributes (forward-compatible DTOs) ───────────────────

export type AttributeValue =
  | { readonly kind: "Score"; readonly value: number }
  | { readonly kind: "Modifier"; readonly value: number }
  | { readonly kind: "Text"; readonly value: string };

export function getAttributeModifier(v: AttributeValue): number {
  if (v.kind === "Modifier") return v.value;
  if (v.kind === "Score") return Math.floor((v.value - 10) / 2);
  return 0;
}

export type AttributePreset =
  | "DnD5eCore"
  | "DnD5ePlusCommonSkills"
  | "SimpleD20"
  | "Custom";

export interface AttributeRow {
  readonly name: string;
  readonly type: "Score" | "Modifier" | "Text";
  readonly default: AttributeValue;
}

export interface AttributeSchema {
  readonly preset: AttributePreset;
  readonly rows: readonly AttributeRow[];
}

export interface AttributeDelta {
  readonly attributeName: string;
  readonly delta: number;
}

export interface StatusEffectTemplate {
  readonly id: string;
  readonly name: string;
  readonly attributeDeltas: readonly AttributeDelta[];
  readonly maxHpDelta: number | null;
  readonly onApplyHpDelta: number | null;
  readonly notes: string;
}

export interface StatusEffect {
  readonly id: string;
  readonly name: string;
  readonly appliedUtc: string;
  readonly attributeDeltas: readonly AttributeDelta[];
  readonly maxHpDelta: number | null;
  readonly onApplyHpDelta: number | null;
  readonly notes: string;
}

export interface NamedTemplate {
  readonly id: string;
  readonly name: string;
  readonly isBuiltIn: boolean;
  readonly rows: readonly AttributeRow[];
  readonly statusEffectTemplates: readonly StatusEffectTemplate[];
  readonly initiativeAttributeName: string | null;
}

export interface DiceTerm {
  readonly count: number;
  readonly sides: number;
}

export type RollMode = "Normal" | "Advantage" | "Disadvantage";

export interface DieRoll {
  readonly sides: number;
  readonly value: number;
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
}

export interface RollResult {
  readonly id: string;
  readonly rollerUserId: string;
  readonly forcedByUserId: string | null;
  readonly rolls: readonly DieRoll[];
  readonly total: number;
  readonly mode: RollMode;
  readonly flatModifier: number;
  readonly attributeModifier: number;
  readonly label: string;
  readonly timestampUtc: string;
  readonly formula: string;
  readonly modifierBreakdown: string;
  readonly tokenId: string | null;
  readonly appliedRules: readonly string[];
}

export interface CharacterSheet {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly representsUserId: string | null;
  readonly characterName: string;
  readonly values: Readonly<Record<string, AttributeValue>>;
  readonly notes: string;
  readonly hp: number | null;
  readonly maxHp: number | null;
  readonly armorClass: number | null;
  readonly color: string;
  readonly scopedMapId: string | null;
  readonly statusEffects: readonly StatusEffect[];
  readonly rollTemplates: readonly RollTemplate[];
}

// ── Combat ────────────────────────────────────────────────────────────────────

export type CombatPhase = "Inactive" | "Initiative" | "Active" | "RoundEnd";

export interface CombatantEntry {
  readonly id: string;
  readonly sheetId: string | null;
  readonly tokenId: string | null;
  readonly name: string;
  readonly initiative: number;
  readonly tieBreaker: number;
  readonly hp: number | null;
  readonly maxHp: number | null;
  readonly isNpc: boolean;
  readonly hidden: boolean;
}

export interface CombatState {
  readonly phase: CombatPhase;
  readonly roundNumber: number;
  readonly currentTurnIndex: number;
  readonly turnOrder: readonly CombatantEntry[];
}

// ── Loaded Dice ───────────────────────────────────────────────────────────────

export type LoadedDiceCondition =
  | { readonly $kind: "currentMap"; readonly mapId: string }
  | { readonly $kind: "diceTypeRolled"; readonly sides: number }
  | { readonly $kind: "rollerIs"; readonly userId: string }
  | { readonly $kind: "rollModeIs"; readonly mode: RollMode }
  | { readonly $kind: "hostKeyHeld"; readonly key: string }
  | { readonly $kind: "combatActive"; readonly active: boolean }
  | { readonly $kind: "rollLabelContains"; readonly substring: string }
  | { readonly $kind: "allOf"; readonly conditions: readonly LoadedDiceCondition[] }
  | { readonly $kind: "anyOf"; readonly conditions: readonly LoadedDiceCondition[] }
  | { readonly $kind: "not"; readonly condition: LoadedDiceCondition };

export type LoadedDiceModification =
  | { readonly $kind: "setResult"; readonly targetTotal: number }
  | { readonly $kind: "clampMax"; readonly max: number }
  | { readonly $kind: "clampMin"; readonly min: number }
  | { readonly $kind: "biasLower"; readonly strength: number }
  | { readonly $kind: "biasHigher"; readonly strength: number }
  | { readonly $kind: "rerollOn"; readonly triggerValues: readonly number[] };

export interface LoadedDiceRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly targetSheetIds: readonly string[];
  readonly conditions: readonly LoadedDiceCondition[];
  readonly modifications: readonly LoadedDiceModification[];
}

// ── Session Settings & Top-Level State ────────────────────────────────────────

export interface DndMapperSettings {
  readonly tokenMovement: "OwnerOrHost" | "Anyone" | "HostOnly";
  readonly sheetEditByOthers: "HostOnly" | "OwnersAndHost" | "Anyone";
  readonly rollsVisibleToPlayers: boolean;
  readonly playersCanCreateNPCs: boolean;
  readonly hpTrackingEnabled: boolean;
  readonly playersCanSeeOtherSheets: boolean;
  readonly loadedDiceEnabled: boolean;
  readonly loadedDiceRuleVisibility: string;
  readonly loadedDicePlayerIndicator: string;
}

export type DndMapperPhase = "Lobby" | "Playing";

export interface DndMapperState {
  readonly phase: DndMapperPhase;
  readonly settings: DndMapperSettings;
  readonly attributeSchema: AttributeSchema;
  readonly maps: readonly GameMap[];
  readonly activeMapId: string | null;
  readonly sheets: Readonly<Record<string, CharacterSheet>>;
  readonly customTemplates: Readonly<Record<string, NamedTemplate>>;
  readonly rollLog: readonly RollResult[];
  readonly globalRollTemplates: readonly RollTemplate[];
  readonly activeSchemaTemplateId: string | null;
  readonly initiativeAttributeName: string | null;
  readonly activeCombat: CombatState | null;
  readonly pendingCenterRequest: CenterViewportRequest | null;
  readonly focusRect: FocusRect | null;
  readonly loadedDiceRules: readonly LoadedDiceRule[];
  readonly hostHeldKeys: readonly string[];
  readonly dmPlayerId: string | null;
}

// ── Invariants & Constants ────────────────────────────────────────────────────

export const TOKEN_RADIUS = 0.45;
export const TOKEN_OWNER_HALO_RADIUS = 0.55;
export const TOKEN_STACK_CHIP_RADIUS = 0.4;
export const MIN_IMAGE_DIMENSION = 0.1;
export const FEET_PER_SQUARE = 5.0;
export const MAX_ROLL_LOG = 50;
export const ALLOWED_DICE_SIDES = [4, 6, 8, 10, 12, 20, 100] as const;
export const MAX_DICE_PER_ROLL = 20;
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB per image
export const MAX_ROOM_STORAGE_BYTES = 1024 * 1024 * 1024; // 1 GB aggregate
export const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024; // 500 MB browser archive ceiling
