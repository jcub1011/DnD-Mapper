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

export const DEFAULT_GRID_CONFIG: GridConfig = {
  widthCells: 30,
  heightCells: 20,
  cellPixels: 50,
  showGridLines: true,
  snapToGrid: true,
  lineColor: "#222",
};

export function createDefaultGridConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    ...DEFAULT_GRID_CONFIG,
    ...overrides,
  };
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

/** Derived display name: name ?? "Layer #{layerOrder}". */
export function getMapImageDisplayName(img: Pick<MapImage, "name" | "layerOrder">): string {
  if (img.name && img.name.trim().length > 0) {
    return img.name;
  }
  return `Layer #${img.layerOrder}`;
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

/** Extracts minimal metadata summary from a GameMap. */
export function toMapSummary(map: GameMap): MapSummary {
  return {
    id: map.id,
    name: map.name,
    listOrder: map.listOrder,
    widthCells: map.grid.widthCells,
    heightCells: map.grid.heightCells,
  };
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

export function getModifier(v: AttributeValue): number {
  if (v.kind === "Modifier") return v.value;
  if (v.kind === "Score") return Math.floor((v.value - 10) / 2);
  return 0;
}

/** Backward-compatible alias for getModifier. */
export const getAttributeModifier = getModifier;

export type AttributePreset = "DnD5eCore" | "DnD5ePlusCommonSkills" | "SimpleD20" | "Custom";

export interface AttributeRow {
  readonly name: string;
  readonly type: "Score" | "Modifier" | "Text";
  readonly default: AttributeValue;
}

export interface AttributeSchema {
  readonly preset: AttributePreset;
  readonly rows: readonly AttributeRow[];
}

export const DND_5E_CORE_ATTRIBUTES: readonly AttributeRow[] = [
  { name: "Strength", type: "Score", default: { kind: "Score", value: 10 } },
  { name: "Dexterity", type: "Score", default: { kind: "Score", value: 10 } },
  { name: "Constitution", type: "Score", default: { kind: "Score", value: 10 } },
  { name: "Intelligence", type: "Score", default: { kind: "Score", value: 10 } },
  { name: "Wisdom", type: "Score", default: { kind: "Score", value: 10 } },
  { name: "Charisma", type: "Score", default: { kind: "Score", value: 10 } },
];

export const DND_5E_COMMON_SKILLS: readonly AttributeRow[] = [
  { name: "Athletics", type: "Modifier", default: { kind: "Modifier", value: 0 } },
  { name: "Stealth", type: "Modifier", default: { kind: "Modifier", value: 0 } },
  { name: "Perception", type: "Modifier", default: { kind: "Modifier", value: 0 } },
  { name: "Persuasion", type: "Modifier", default: { kind: "Modifier", value: 0 } },
  { name: "Investigation", type: "Modifier", default: { kind: "Modifier", value: 0 } },
];

export const SIMPLE_D20_ATTRIBUTES: readonly AttributeRow[] = [
  { name: "Modifier", type: "Modifier", default: { kind: "Modifier", value: 0 } },
];

export function createDefaultAttributeSchema(
  preset: AttributePreset = "DnD5eCore",
): AttributeSchema {
  switch (preset) {
    case "DnD5eCore":
      return { preset, rows: DND_5E_CORE_ATTRIBUTES };
    case "DnD5ePlusCommonSkills":
      return { preset, rows: [...DND_5E_CORE_ATTRIBUTES, ...DND_5E_COMMON_SKILLS] };
    case "SimpleD20":
      return { preset, rows: SIMPLE_D20_ATTRIBUTES };
    case "Custom":
      return { preset, rows: [] };
  }
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

export interface CustomTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly values: Readonly<Record<string, AttributeValue>>;
  readonly maxHp: number | null;
  readonly armorClass: number | null;
  readonly color: string;
  readonly notes: string;
  readonly statusEffectTemplates: readonly StatusEffectTemplate[];
  readonly rollTemplates: readonly RollTemplate[];
}

export function isCustomTemplate(template: NamedTemplate | CustomTemplate): template is CustomTemplate {
  return "values" in template;
}

export const STANDARD_STATUS_EFFECT_TEMPLATES: readonly StatusEffectTemplate[] = [
  { id: "cond-blinded", name: "Blinded", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Can't see. Attack rolls against have advantage; attacks have disadvantage. Automatically fails ability checks requiring sight." },
  { id: "cond-charmed", name: "Charmed", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Can't attack charmer. Charmer has advantage on social ability checks against creature." },
  { id: "cond-deafened", name: "Deafened", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Can't hear. Automatically fails ability checks requiring hearing." },
  { id: "cond-frightened", name: "Frightened", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Disadvantage on ability checks and attack rolls while source of fear is in line of sight. Can't willingly move closer." },
  { id: "cond-grappled", name: "Grappled", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Speed becomes 0. Ends if grappler is incapacitated or moved away." },
  { id: "cond-incapacitated", name: "Incapacitated", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Can't take actions or reactions." },
  { id: "cond-invisible", name: "Invisible", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Impossible to see without special senses. Attack rolls against have disadvantage; attacks have advantage." },
  { id: "cond-paralyzed", name: "Paralyzed", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Incapacitated and can't move or speak. Automatically fails STR and DEX saves. Attacks against have advantage; melee within 5 ft is critical hit." },
  { id: "cond-petrified", name: "Petrified", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Transformed into solid inanimate substance. Incapacitated, resistance to all damage, immune to poison/disease." },
  { id: "cond-poisoned", name: "Poisoned", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Disadvantage on attack rolls and ability checks." },
  { id: "cond-prone", name: "Prone", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Can only crawl. Disadvantage on attack rolls. Attacks against within 5 ft have advantage, otherwise disadvantage." },
  { id: "cond-restrained", name: "Restrained", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Speed 0. Attack rolls against have advantage; attacks have disadvantage. Disadvantage on DEX saves." },
  { id: "cond-stunned", name: "Stunned", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Incapacitated, can't move, speak falteringly. Automatically fails STR and DEX saves. Attacks against have advantage." },
  { id: "cond-unconscious", name: "Unconscious", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Incapacitated, can't move or speak, unaware of surroundings. Drops held items, falls prone. Attacks against have advantage; within 5 ft critical." },
  { id: "cond-exhaustion", name: "Exhaustion", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Disadvantage on ability checks; speed halved (Lv 2); disadvantage on attacks/saves (Lv 3); max HP halved (Lv 4); speed 0 (Lv 5); death (Lv 6)." },
  { id: "cond-concentrating", name: "Concentrating", attributeDeltas: [], maxHpDelta: null, onApplyHpDelta: null, notes: "Concentrating on a spell or magical effect. Taking damage requires a CON save (DC 10 or half damage)." },
];

export function resolveEffectiveMaxHp(sheet: CharacterSheet): number | null {
  if (sheet.maxHp === null) return null;
  let delta = 0;
  for (const effect of sheet.statusEffects) {
    delta += effect.maxHpDelta ?? 0;
  }
  return sheet.maxHp + delta;
}

export interface ContributionEntry {
  readonly source: string;
  readonly delta: number;
}

export interface AttributeContribution {
  readonly effectiveValue: AttributeValue;
  readonly effectiveModifier: number;
  readonly valueBreakdown: readonly ContributionEntry[];
}

export function resolveAttributeContribution(
  sheet: CharacterSheet,
  attributeName: string,
  baseValue: AttributeValue,
): AttributeContribution {
  const entries: ContributionEntry[] = [
    { source: attributeName, delta: baseValue.kind !== "Text" ? baseValue.value : 0 },
  ];
  let deltaSum = 0;
  for (const effect of sheet.statusEffects) {
    for (const d of effect.attributeDeltas) {
      if (d.attributeName === attributeName) {
        entries.push({ source: effect.name, delta: d.delta });
        deltaSum += d.delta;
      }
    }
  }

  let effectiveValue: AttributeValue = baseValue;
  if (baseValue.kind === "Score") {
    effectiveValue = { kind: "Score", value: baseValue.value + deltaSum };
  } else if (baseValue.kind === "Modifier") {
    effectiveValue = { kind: "Modifier", value: baseValue.value + deltaSum };
  }

  return {
    effectiveValue,
    effectiveModifier: getModifier(effectiveValue),
    valueBreakdown: entries,
  };
}

export function resolveAttributeValue(
  sheet: CharacterSheet,
  attributeName: string,
): AttributeValue {
  const baseValue = sheet.values[attributeName] ?? { kind: "Score", value: 10 };
  return resolveAttributeContribution(sheet, attributeName, baseValue).effectiveValue;
}

export function clampHpToEffectiveMax(sheet: CharacterSheet): CharacterSheet {
  const effectiveMax = resolveEffectiveMaxHp(sheet);
  if (effectiveMax !== null && sheet.hp !== null && sheet.hp > effectiveMax) {
    return { ...sheet, hp: effectiveMax };
  }
  return sheet;
}

export function reconcileSheetValues(
  sheet: CharacterSheet,
  schema: AttributeSchema,
): CharacterSheet {
  const allowed = new Map<string, AttributeRow>();
  for (const row of schema.rows) {
    allowed.set(row.name, row);
  }

  const nextValues: Record<string, AttributeValue> = {};
  for (const [name, val] of Object.entries(sheet.values)) {
    const row = allowed.get(name);
    if (row && row.type === val.kind) {
      nextValues[name] = val;
    }
  }
  for (const row of schema.rows) {
    if (!(row.name in nextValues)) {
      nextValues[row.name] = row.default;
    }
  }
  return { ...sheet, values: nextValues };
}

export interface DiceTerm {
  readonly count: number;
  readonly sides: number;
}

export type RollMode = "Normal" | "Advantage" | "Disadvantage";

export interface DieRoll {
  readonly sides: number;
  readonly value: number;
  readonly discarded?: boolean;
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
  readonly scope?: RollTemplateScope;
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
  readonly originalDice?: readonly DiceTerm[];
  readonly originalAttributeRef?: { readonly sheetId: string; readonly attributeName: string | null } | null;
  readonly total: number;
  readonly mode: RollMode;
  readonly flatModifier: number;
  readonly attributeModifier: number;
  readonly label: string;
  readonly timestampUtc: string;
  readonly formula: string;
  readonly modifierBreakdown: string;
  readonly tokenId: string | null;
  readonly appliedRules: readonly (string | LoadedDiceRuleStamp)[];
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
  /**
   * True once the color was explicitly chosen by a user (sheet/token editor or
   * create intent with an explicit color). While false, the color is seeded
   * from the character name and re-seeds automatically on rename.
   */
  readonly colorOverridden: boolean;
  readonly scopedMapId: string | null;
  readonly statusEffects: readonly StatusEffect[];
  readonly rollTemplates: readonly RollTemplate[];
}

// ── Combat ────────────────────────────────────────────────────────────────────

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

// ── Loaded Dice ───────────────────────────────────────────────────────────────

export const GM_TARGET_ID = "00000000-0000-0000-0000-000000000001";

export type LoadedDiceCondition =
  | { readonly $kind: "currentMap"; readonly mapId: string }
  | { readonly $kind: "diceTypeRolled"; readonly sides: number }
  | { readonly $kind: "rollerIs"; readonly sheetId: string } // CharacterSheet.id or GM_TARGET_ID for unlinked GM rolls
  | { readonly $kind: "rollModeIs"; readonly mode: RollMode }
  | { readonly $kind: "hostKeyHeld"; readonly key: string }
  | { readonly $kind: "combatActive" } // Parameterless flag
  | { readonly $kind: "rollLabelContains"; readonly substring: string }
  | { readonly $kind: "allOf"; readonly conditions: readonly LoadedDiceCondition[] }
  | { readonly $kind: "anyOf"; readonly conditions: readonly LoadedDiceCondition[] }
  | { readonly $kind: "not"; readonly condition: LoadedDiceCondition };

export type LoadedDiceModification =
  | { readonly $kind: "setResult"; readonly value: number }
  | { readonly $kind: "clampMax"; readonly max: number }
  | { readonly $kind: "clampMin"; readonly min: number }
  | { readonly $kind: "biasLower"; readonly rerollCount: number }
  | { readonly $kind: "biasHigher"; readonly rerollCount: number }
  | { readonly $kind: "rerollOn"; readonly values: readonly number[] };

export interface LoadedDiceRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly targetSheetIds: readonly string[]; // Empty means all sheets / unattributed GM rolls
  readonly conditions: readonly LoadedDiceCondition[];
  readonly modifications: readonly LoadedDiceModification[];
}

export interface LoadedDiceContext {
  readonly roll: {
    readonly sides: number;
    readonly mode: RollMode;
    readonly label: string;
    readonly sheetId: string | null;
    readonly rollerUserId: string;
  };
  readonly activeMapId: string | null;
  readonly isCombatActive: boolean;
  readonly hostHeldKeys: readonly string[];
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

export const DEFAULT_SETTINGS: DndMapperSettings = {
  tokenMovement: "OwnerOrHost",
  sheetEditByOthers: "HostOnly",
  rollsVisibleToPlayers: true,
  playersCanCreateNPCs: false,
  hpTrackingEnabled: true,
  playersCanSeeOtherSheets: false,
  loadedDiceEnabled: false,
  loadedDiceRuleVisibility: "Hidden",
  loadedDicePlayerIndicator: "None",
};

export function createDefaultSettings(overrides?: Partial<DndMapperSettings>): DndMapperSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

export function isFullMap(map: GameMap | MapSummary): map is GameMap {
  return "tokens" in map && "grid" in map && "fogMask" in map;
}

export interface CampaignHeader {
  readonly title?: string;
  readonly settings?: DndMapperSettings;
  readonly attributeSchema?: AttributeSchema;
  readonly activeMapId?: string | null;
  readonly sheets?: Readonly<Record<string, CharacterSheet>>;
  readonly customTemplates?: Readonly<Record<string, CustomTemplate | NamedTemplate>>;
  readonly statusEffectTemplates?: Readonly<Record<string, StatusEffectTemplate>>;
  readonly globalRollTemplates?: readonly RollTemplate[];
  readonly activeSchemaTemplateId?: string | null;
  readonly initiativeAttributeName?: string | null;
  readonly activeCombat?: CombatState | null;
  readonly loadedDiceRules?: readonly LoadedDiceRule[];
}

export type DndMapperPhase = "Lobby" | "Playing";

export interface DndMapperState {
  readonly phase: DndMapperPhase;
  readonly settings: DndMapperSettings;
  readonly attributeSchema: AttributeSchema;
  readonly maps: readonly (GameMap | MapSummary)[];
  readonly activeMapId: string | null;
  readonly sheets: Readonly<Record<string, CharacterSheet>>;
  readonly customTemplates: Readonly<Record<string, CustomTemplate | NamedTemplate>>;
  readonly statusEffectTemplates: Readonly<Record<string, StatusEffectTemplate>>;
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

export function createDefaultDndMapperState(dmPlayerId: string | null = null): DndMapperState {
  return {
    phase: "Lobby",
    settings: DEFAULT_SETTINGS,
    attributeSchema: createDefaultAttributeSchema("DnD5eCore"),
    maps: [],
    activeMapId: null,
    sheets: {},
    customTemplates: {},
    statusEffectTemplates: Object.fromEntries(
      STANDARD_STATUS_EFFECT_TEMPLATES.map((t) => [t.id, t]),
    ),
    rollLog: [],
    globalRollTemplates: [],
    activeSchemaTemplateId: null,
    initiativeAttributeName: null,
    activeCombat: null,
    pendingCenterRequest: null,
    focusRect: null,
    loadedDiceRules: [],
    hostHeldKeys: [],
    dmPlayerId,
  };
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
export const ZOOM_MIN = 0.01;
export const ZOOM_MAX = 10.0;
export const FOG_BRUSH_RADIUS_MIN = 1;
export const FOG_BRUSH_RADIUS_MAX = 3;
export const MAX_TEXTURE_SIZE = 8192;
