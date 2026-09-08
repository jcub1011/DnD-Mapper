/**
 * Importer for Virtual Table Format (.vtf) archives.
 *
 * Enforces:
 *   - Browser archive ceiling (500 MB)
 *   - Spec version check (major version <= 1)
 *   - Path safety / zip-slip rejection
 *   - Vendor data authority (spec projections ignored on import)
 *   - Foreign token fallback synthesis
 *   - Re-minting of image GUIDs to prevent cross-slot collision
 *   - Non-byte aligned fog mask and absent fog mask (all revealed)
 */

import type {
  CharacterSheet,
  DndMapperSettings,
  DndMapperState,
  GameMap,
  GridConfig,
  MapImage,
  NamedTemplate,
  Token,
  TokenIconKind,
  TokenType,
} from "../game/domain.js";
import { MAX_ARCHIVE_BYTES, MAX_FILE_SIZE_BYTES, MAX_ROOM_STORAGE_BYTES } from "../game/domain.js";
import type {
  DndMapperGlobalVendor,
  DndMapperSceneVendor,
  LibraryCoreSnapshot,
  UnpackResult,
  VtfEntity,
  VtfEntityInstance,
  VtfExtensionPayload,
  VtfGlobalState,
  VtfImageAsset,
  VtfLayer,
  VtfManifest,
  VtfScene,
} from "./types.js";
import { withExtra } from "./types.js";
import { openZip } from "./unzip.js";

const VENDOR_KEY = "knockbox_dnd_mapper";
const MANIFEST_ENTRY = "manifest.json";
const GLOBAL_STATE_ENTRY = "global_state.json";
const EXTENSION_ENTRY = `extensions/${VENDOR_KEY}.json`;
const SCENES_PREFIX = "scenes/";
const ENTITIES_PREFIX = "entities/";
const IMAGES_PREFIX = "assets/images/";

const ALLOWED_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
  "",
]);

function normalizeTokenIconKind(raw: unknown): TokenIconKind {
  return raw === 1 || raw === "Solid" ? "Solid" : "Initial";
}

function normalizeTokenType(raw: unknown): TokenType {
  return raw === 1 || raw === "NPCToken" ? "NPCToken" : "PlayerToken";
}

function normalizeSettings(raw: unknown): DndMapperSettings {
  if (!raw || typeof raw !== "object") return defaultSettings();
  const r = raw as Record<string, unknown>;

  let tokenMovement: "OwnerOrHost" | "Anyone" | "HostOnly" = "OwnerOrHost";
  if (r.tokenMovement === 1 || r.tokenMovement === "Anyone") {
    tokenMovement = "Anyone";
  } else if (r.tokenMovement === 2 || r.tokenMovement === "HostOnly") {
    tokenMovement = "HostOnly";
  }

  let sheetEditByOthers: "HostOnly" | "OwnersAndHost" | "Anyone" = "HostOnly";
  if (r.sheetEditByOthers === 1 || r.sheetEditByOthers === "OwnersAndHost") {
    sheetEditByOthers = "OwnersAndHost";
  } else if (r.sheetEditByOthers === 2 || r.sheetEditByOthers === "Anyone") {
    sheetEditByOthers = "Anyone";
  }

  let loadedDiceRuleVisibility = "HostOnly";
  if (r.loadedDiceRuleVisibility === 1 || r.loadedDiceRuleVisibility === "AllPlayers") {
    loadedDiceRuleVisibility = "AllPlayers";
  } else if (typeof r.loadedDiceRuleVisibility === "string") {
    loadedDiceRuleVisibility = r.loadedDiceRuleVisibility;
  }

  let loadedDicePlayerIndicator = "Hidden";
  if (r.loadedDicePlayerIndicator === 1 || r.loadedDicePlayerIndicator === "RedDotInLog") {
    loadedDicePlayerIndicator = "RedDotInLog";
  } else if (typeof r.loadedDicePlayerIndicator === "string") {
    loadedDicePlayerIndicator = r.loadedDicePlayerIndicator;
  }

  return {
    tokenMovement,
    sheetEditByOthers,
    rollsVisibleToPlayers: (r.rollsVisibleToPlayers as boolean | undefined) ?? true,
    playersCanCreateNPCs: (r.playersCanCreateNPCs as boolean | undefined) ?? false,
    hpTrackingEnabled: (r.hpTrackingEnabled as boolean | undefined) ?? true,
    playersCanSeeOtherSheets: (r.playersCanSeeOtherSheets as boolean | undefined) ?? true,
    loadedDiceEnabled: (r.loadedDiceEnabled as boolean | undefined) ?? false,
    loadedDiceRuleVisibility,
    loadedDicePlayerIndicator,
  };
}

function defaultSettings(): DndMapperSettings {
  return {
    tokenMovement: "OwnerOrHost",
    sheetEditByOthers: "HostOnly",
    rollsVisibleToPlayers: true,
    playersCanCreateNPCs: false,
    hpTrackingEnabled: true,
    playersCanSeeOtherSheets: true,
    loadedDiceEnabled: false,
    loadedDiceRuleVisibility: "Hidden",
    loadedDicePlayerIndicator: "None",
  };
}

function defaultGrid(): GridConfig {
  return {
    widthCells: 30,
    heightCells: 20,
    cellPixels: 50,
    showGridLines: true,
    snapToGrid: true,
    lineColor: "#222",
  };
}

function parseMajorVersion(versionStr: string): number {
  if (!versionStr) return 0;
  const dot = versionStr.indexOf(".");
  const head = dot < 0 ? versionStr : versionStr.slice(0, dot);
  const major = parseInt(head, 10);
  return Number.isFinite(major) ? major : 0;
}

function getContentType(ext: string): string | null {
  const lower = ext.toLowerCase();
  switch (lower) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

/**
 * Imports a .vtf archive from a Blob into a complete campaign state and image assets.
 */
export async function importVtf(blob: Blob): Promise<UnpackResult> {
  // Feature detection: DecompressionStream('deflate-raw')
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "DecompressionStream is not supported in this environment. Modern browser required (Safari 16.4+, Firefox 113+, Chrome 80+).",
    );
  }

  // MIME allow-list validation
  if (blob.type && !ALLOWED_MIME_TYPES.has(blob.type)) {
    throw new Error(
      `Unsupported archive MIME type '${blob.type}'. Expected a .vtf or zip archive.`,
    );
  }

  // 500 MB browser archive ceiling
  if (blob.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `Archive size (${Math.round(blob.size / (1024 * 1024))} MB) exceeds maximum allowed size of 500 MB.`,
    );
  }

  const zip = await openZip(blob);
  const warnings: string[] = [];

  // 1. Manifest version gate
  const manifestEntry = zip.getEntry(MANIFEST_ENTRY);
  if (!manifestEntry) {
    throw new Error("Invalid .vtf archive: missing manifest.json.");
  }
  const rawManifest = await zip.readJson<VtfManifest>(manifestEntry);
  if (!rawManifest || !rawManifest.vtfVersion) {
    throw new Error("Invalid .vtf archive: malformed manifest.json.");
  }
  const manifest = withExtra<VtfManifest>(rawManifest, [
    "vtfVersion",
    "campaign",
    "system",
    "dependencies",
    "entryState",
  ]);

  const major = parseMajorVersion(manifest.vtfVersion);
  if (major === 0) {
    throw new Error(`Unrecognized vtfVersion: '${manifest.vtfVersion}'.`);
  }
  if (major > 1) {
    throw new Error(`This .vtf was written for VTF v${major}.x; this build supports up to v1.x.`);
  }

  const slotTitle = manifest.campaign?.title?.trim() || "Imported slot";

  // 2. Global State
  const globalEntry = zip.getEntry(GLOBAL_STATE_ENTRY);
  let globalVendor: DndMapperGlobalVendor = {};
  if (globalEntry) {
    const rawGlobal = await zip.readJson<VtfGlobalState>(globalEntry);
    if (rawGlobal) {
      const globalState = withExtra<VtfGlobalState>(rawGlobal, [
        "campaignTime",
        "playlist",
        "vendorData",
      ]);
      if (globalState?.vendorData?.[VENDOR_KEY]) {
        globalVendor = withExtra<DndMapperGlobalVendor>(globalState.vendorData[VENDOR_KEY], [
          "settings",
          "attributeSchema",
          "activeSchemaTemplateId",
          "initiativeAttributeName",
          "customTemplates",
          "globalRollTemplates",
          "loadedDiceRules",
          "mapOrder",
          "sheetOrder",
        ]);
      }
    }
  }

  // 3. Images: read bytes, re-mint GUIDs to avoid cross-slot collisions
  const imageGuidMap = new Map<string, string>(); // oldGuidLower -> newGuid
  const images = new Map<string, VtfImageAsset>();
  let aggregateImageBytes = 0;

  for (const entry of zip.entries) {
    if (!entry.name.startsWith(IMAGES_PREFIX)) continue;
    const fileName = entry.name.slice(IMAGES_PREFIX.length);
    if (!fileName || fileName.endsWith("/")) continue;

    // Per-image file cap: 100 MB
    if (entry.uncompressedSize > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `Image '${fileName}' (${Math.round(entry.uncompressedSize / (1024 * 1024))} MB) exceeds maximum allowed size of 100 MB.`,
      );
    }

    // Room aggregate cap: 1 GB
    aggregateImageBytes += entry.uncompressedSize;
    if (aggregateImageBytes > MAX_ROOM_STORAGE_BYTES) {
      throw new Error(
        `Total uncompressed image size exceeds maximum allowed room storage of 1 GB.`,
      );
    }

    const dot = fileName.lastIndexOf(".");
    const stem = dot >= 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot >= 0 ? fileName.slice(dot) : "";

    const contentType = getContentType(ext);
    if (!contentType) {
      warnings.push(`Skipped image with unsupported extension: ${fileName}`);
      continue;
    }

    const newId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `img-${Math.random().toString(36).slice(2, 11)}`;
    imageGuidMap.set(stem.toLowerCase(), newId);

    const imageBlob = await zip.readBlob(entry);
    const asset: VtfImageAsset = {
      id: newId,
      contentType,
      blob: imageBlob,
      fileName: `${newId}${ext}`,
    };
    images.set(newId, asset);
  }

  // 4. Scenes -> Maps
  const maps: GameMap[] = [];
  for (const entry of zip.entries) {
    if (!entry.name.startsWith(SCENES_PREFIX)) continue;
    if (!entry.name.toLowerCase().endsWith(".json")) continue;

    const rawScene = await zip.readJson<VtfScene>(entry);
    if (!rawScene) continue;

    const scene = withExtra<VtfScene>(rawScene, [
      "sceneId",
      "dimensions",
      "grid",
      "ambience",
      "layers",
      "entityInstances",
      "vendorData",
    ]);

    const rawSceneVendor = scene.vendorData?.[VENDOR_KEY] as Record<string, unknown> | undefined;
    if (!rawSceneVendor || !rawSceneVendor.id) {
      warnings.push(`Skipped scene without DnD Mapper vendor data: ${scene.sceneId || entry.name}`);
      continue;
    }
    const sceneVendor = withExtra<DndMapperSceneVendor>(rawSceneVendor, [
      "id",
      "name",
      "listOrder",
      "createdUtc",
      "grid",
      "defaultSpawnX",
      "defaultSpawnY",
      "fogMask",
    ]);

    // Process Layers (Images)
    const imageList: MapImage[] = [];
    for (const rawLayer of scene.layers || []) {
      const layer = withExtra<VtfLayer>(rawLayer, [
        "id",
        "name",
        "type",
        "assetRef",
        "zIndex",
        "opacity",
        "vendorData",
      ]);

      if (layer.type?.toLowerCase() !== "image") {
        warnings.push(`Skipped layer with unsupported type '${layer.type}'.`);
        continue;
      }

      const layerVendor = layer.vendorData?.[VENDOR_KEY] as MapImage | undefined;
      if (!layerVendor || !layerVendor.id) {
        warnings.push(`Skipped layer without DnD Mapper vendor data: ${layer.id}`);
        continue;
      }

      const oldIdLower = layerVendor.id.toLowerCase();
      const remintedId = imageGuidMap.get(oldIdLower);
      if (!remintedId || !images.has(remintedId)) {
        warnings.push(`Skipped layer with missing image binary: ${layerVendor.id}`);
        continue;
      }

      imageList.push({
        ...layerVendor,
        id: remintedId,
        shareToken: null,
      });
    }

    // Process Entity Instances (Tokens)
    const tokenList: Token[] = [];
    for (const rawInst of scene.entityInstances || []) {
      const inst = withExtra<VtfEntityInstance>(rawInst, [
        "instanceId",
        "entityRef",
        "transform",
        "localOverrides",
        "vendorData",
      ]);

      const tokenVendor = inst.vendorData?.[VENDOR_KEY] as Record<string, unknown> | undefined;
      if (tokenVendor && tokenVendor.id) {
        tokenList.push({
          ...tokenVendor,
          id: String(tokenVendor.id),
          iconKind: normalizeTokenIconKind(tokenVendor.iconKind),
          type: normalizeTokenType(tokenVendor.type),
          ownerUserId: (tokenVendor.ownerUserId as string | null) ?? null,
          representsUserId: (tokenVendor.representsUserId as string | null) ?? null,
          name: (tokenVendor.name as string) || "Token",
          color: (tokenVendor.color as string) || "#e8b849",
          mapId: (tokenVendor.mapId as string) || sceneVendor.id,
          x: Number(tokenVendor.x),
          y: Number(tokenVendor.y),
          sheetId: (tokenVendor.sheetId as string | null) ?? null,
          hidden: Boolean(tokenVendor.hidden),
        });
      } else if (inst.transform?.gridPosition && inst.instanceId) {
        // Fallback synthesis for foreign/spec-only token instances
        tokenList.push({
          id: inst.instanceId,
          type: "NPCToken",
          ownerUserId: null,
          representsUserId: null,
          name: "Token",
          color: "#e8b849",
          iconKind: "Initial",
          mapId: sceneVendor.id,
          x: inst.transform.gridPosition.x,
          y: inst.transform.gridPosition.y,
          sheetId: inst.entityRef?.startsWith(ENTITIES_PREFIX)
            ? inst.entityRef
                .slice(ENTITIES_PREFIX.length)
                .replace(/^sheet_/, "")
                .replace(/\.json$/, "")
            : null,
          hidden: false,
        });
      }
    }

    const mapItem: GameMap = {
      id: sceneVendor.id,
      name: sceneVendor.name || "Untitled Map",
      listOrder: sceneVendor.listOrder ?? 0,
      createdUtc: sceneVendor.createdUtc || new Date(0).toISOString(),
      grid: sceneVendor.grid || defaultGrid(),
      defaultSpawnPosition:
        sceneVendor.defaultSpawnX != null && sceneVendor.defaultSpawnY != null
          ? { x: sceneVendor.defaultSpawnX, y: sceneVendor.defaultSpawnY }
          : null,
      markupSvg: null,
      images: imageList,
      tokens: tokenList,
      fogMask: sceneVendor.fogMask || "", // Empty base64 = all revealed
    };

    maps.push(mapItem);
  }

  // Order maps by MapOrder if available
  if (globalVendor.mapOrder && globalVendor.mapOrder.length > 0) {
    const mapRank = new Map<string, number>();
    globalVendor.mapOrder.forEach((id, i) => mapRank.set(id.toLowerCase(), i));
    maps.sort((a, b) => {
      const rankA = mapRank.get(a.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      const rankB = mapRank.get(b.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return a.listOrder - b.listOrder;
    });
  } else {
    maps.sort((a, b) => a.listOrder - b.listOrder);
  }

  // 5. Entities -> Character Sheets
  const sheets: CharacterSheet[] = [];
  for (const entry of zip.entries) {
    if (!entry.name.startsWith(ENTITIES_PREFIX)) continue;
    if (!entry.name.toLowerCase().endsWith(".json")) continue;

    const rawEntity = await zip.readJson<VtfEntity>(entry);
    if (!rawEntity) continue;

    const entity = withExtra<VtfEntity>(rawEntity, ["entityId", "name", "assetRef", "vendorData"]);

    const sheetVendor = entity.vendorData?.[VENDOR_KEY] as CharacterSheet | undefined;
    if (!sheetVendor || !sheetVendor.id) {
      warnings.push(`Skipped non-DnD-Mapper entity: ${entry.name}`);
      continue;
    }

    sheets.push(sheetVendor);
  }

  // Order sheets by SheetOrder if available
  if (globalVendor.sheetOrder && globalVendor.sheetOrder.length > 0) {
    const sheetRank = new Map<string, number>();
    globalVendor.sheetOrder.forEach((id, i) => sheetRank.set(id.toLowerCase(), i));
    sheets.sort((a, b) => {
      const rankA = sheetRank.get(a.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      const rankB = sheetRank.get(b.id.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
      return rankA - rankB;
    });
  }

  // 6. Extension payload
  let extension: VtfExtensionPayload = {
    activeCombat: null,
    phase: "Lobby",
  };
  const extensionEntry = zip.getEntry(EXTENSION_ENTRY);
  if (extensionEntry) {
    const rawExt = await zip.readJson<VtfExtensionPayload>(extensionEntry);
    if (rawExt) {
      extension = withExtra<VtfExtensionPayload>(rawExt, ["activeCombat", "phase"]);
    }
  }

  // 7. Core Spine
  const core: LibraryCoreSnapshot = {
    schemaVersion: 4,
    settings: normalizeSettings(globalVendor.settings),
    attributeSchema: globalVendor.attributeSchema || { preset: "DnD5eCore", rows: [] },
    activeSchemaTemplateId: globalVendor.activeSchemaTemplateId || null,
    initiativeAttributeName: globalVendor.initiativeAttributeName || null,
    customTemplates: globalVendor.customTemplates || [],
    globalRollTemplates: globalVendor.globalRollTemplates || [],
    loadedDiceRules: globalVendor.loadedDiceRules || [],
    mapIds: maps.map((m) => m.id),
    sheetIds: sheets.map((s) => s.id),
  };

  // 8. Construct DndMapperState
  const sheetsRecord: Record<string, CharacterSheet> = {};
  for (const s of sheets) sheetsRecord[s.id] = s;

  const templatesRecord: Record<string, NamedTemplate> = {};
  for (const t of core.customTemplates) templatesRecord[t.id] = t;

  const state: DndMapperState = {
    phase: extension.phase || "Lobby",
    settings: core.settings,
    attributeSchema: core.attributeSchema,
    maps,
    activeMapId: maps.length > 0 ? maps[0].id : null,
    sheets: sheetsRecord,
    customTemplates: templatesRecord,
    rollLog: [],
    globalRollTemplates: core.globalRollTemplates,
    activeSchemaTemplateId: core.activeSchemaTemplateId,
    initiativeAttributeName: core.initiativeAttributeName,
    activeCombat: extension.activeCombat || null,
    pendingCenterRequest: null,
    focusRect: null,
    loadedDiceRules: core.loadedDiceRules,
    hostHeldKeys: [],
    dmPlayerId: null,
  };

  return {
    slotTitle,
    core,
    maps,
    sheets,
    images,
    extension,
    warnings,
    state,
  };
}
