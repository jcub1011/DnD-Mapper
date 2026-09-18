/**
 * Pure client-side exporter for Virtual Table Format (.vtf v1.0.0) archives.
 *
 * Uses web standard CompressionStream("deflate-raw") for JSON files and
 * STORED (method 0) for pre-compressed images.
 * Packages without slurping entire archives into contiguous buffers.
 */

import type { DndMapperState, GameMap, MapImage } from "../game/domain.js";
import { isFullMap } from "../game/domain.js";
import { generateGuid } from "../game/maps.js";
import type { LibraryService } from "../storage/libraryService.js";
import { crc32 } from "./crc32.js";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const VENDOR_KEY = "knockbox_dnd_mapper";
const MANIFEST_NAME = "manifest.json";
const GLOBAL_STATE_NAME = "global_state.json";
const EXTENSION_NAME = `extensions/${VENDOR_KEY}.json`;

export interface ExportVtfOptions {
  slotTitle?: string;
  getImageBlob?: (imageId: string) => Promise<Blob | null>;
}

interface ZipEntryInput {
  name: string;
  data: Uint8Array | Blob;
  compress: boolean;
}

interface CentralDirectoryEntry {
  name: string;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dosTime: number;
  dosDate: number;
}

function getDosTimeAndDate(date: Date): { dosTime: number; dosDate: number } {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | ((seconds >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0xf) << 5) | (day & 0x1f);

  return { dosTime, dosDate };
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error(
      "CompressionStream('deflate-raw') is required to export VTF archives but is not supported in this environment.",
    );
  }

  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  // Safe write of payload
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.length;
    }
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function getImageExt(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower === "image/png") return "png";
  if (lower === "image/webp") return "webp";
  if (lower === "image/jpeg" || lower === "image/jpg") return "jpg";
  return "bin";
}

/**
 * Builds a ZIP Blob from an array of entry inputs.
 */
async function buildZipBlob(entries: readonly ZipEntryInput[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const blobParts: (Uint8Array | Blob)[] = [];
  const cdEntries: CentralDirectoryEntry[] = [];
  let currentOffset = 0;

  const now = new Date();
  const { dosTime, dosDate } = getDosTimeAndDate(now);

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    let uncompressedBytes: Uint8Array;

    if (entry.data instanceof Uint8Array) {
      uncompressedBytes = entry.data;
    } else {
      uncompressedBytes = new Uint8Array(await entry.data.arrayBuffer());
    }

    const uncompressedSize = uncompressedBytes.byteLength;
    const checksum = crc32(uncompressedBytes);

    let compressedBytes: Uint8Array;
    let compressionMethod: number;

    if (entry.compress) {
      compressedBytes = await deflateRaw(uncompressedBytes);
      compressionMethod = 8;
    } else {
      compressedBytes = uncompressedBytes;
      compressionMethod = 0;
    }

    const compressedSize = compressedBytes.byteLength;
    const localHeaderOffset = currentOffset;

    // Local file header (30 bytes + name length)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);

    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true); // version needed to extract (2.0)
    lv.setUint16(6, 0, true); // general purpose bit flag
    lv.setUint16(8, compressionMethod, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);

    blobParts.push(localHeader);
    blobParts.push(compressedBytes);

    currentOffset += localHeader.byteLength + compressedSize;

    cdEntries.push({
      name: entry.name,
      compressionMethod,
      crc32: checksum,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dosTime,
      dosDate,
    });
  }

  // Central Directory
  const cdOffset = currentOffset;
  let cdSize = 0;

  for (const cd of cdEntries) {
    const nameBytes = encoder.encode(cd.name);
    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdHeader.buffer);

    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flag
    cv.setUint16(10, cd.compressionMethod, true);
    cv.setUint16(12, cd.dosTime, true);
    cv.setUint16(14, cd.dosDate, true);
    cv.setUint32(16, cd.crc32, true);
    cv.setUint32(20, cd.compressedSize, true);
    cv.setUint32(24, cd.uncompressedSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal file attributes
    cv.setUint32(38, 0, true); // external file attributes
    cv.setUint32(42, cd.localHeaderOffset, true);
    cdHeader.set(nameBytes, 46);

    blobParts.push(cdHeader);
    cdSize += cdHeader.byteLength;
    currentOffset += cdHeader.byteLength;
  }

  // End of Central Directory (EOCD)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);

  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // start disk
  ev.setUint16(8, cdEntries.length, true); // records on disk
  ev.setUint16(10, cdEntries.length, true); // total records
  ev.setUint32(12, cdSize, true); // size of CD
  ev.setUint32(16, cdOffset, true); // offset of CD
  ev.setUint16(20, 0, true); // comment length

  blobParts.push(eocd);

  return new Blob(blobParts as BlobPart[], { type: "application/zip" });
}

/**
 * Packages a complete DndMapperState into a valid VTF v1.0.0 ZIP archive.
 */
export async function exportVtf(
  state: DndMapperState,
  options?: ExportVtfOptions,
): Promise<Blob> {
  const encoder = new TextEncoder();
  const entries: ZipEntryInput[] = [];

  const slotTitle = options?.slotTitle?.trim() || "Campaign";
  const campaignId = generateGuid();
  const nowIso = new Date().toISOString();

  // Find full maps
  const fullMaps: GameMap[] = state.maps.filter(isFullMap);
  const activeMapId = state.activeMapId || (fullMaps.length > 0 ? fullMaps[0].id : null);

  // 1. manifest.json
  const manifest = {
    vtfVersion: "1.0.0",
    campaign: {
      id: campaignId,
      title: slotTitle,
      author: null,
      lastModified: nowIso,
    },
    system: { core: "dnd5e" },
    dependencies: [{ name: VENDOR_KEY, minVersion: "1" }],
    entryState: {
      activeScene: activeMapId ? `scenes/${activeMapId}.json` : null,
    },
  };
  entries.push({
    name: MANIFEST_NAME,
    data: encoder.encode(JSON.stringify(manifest, null, 2)),
    compress: true,
  });

  // 2. global_state.json
  const globalState = {
    campaignTime: {},
    playlist: [],
    vendorData: {
      [VENDOR_KEY]: {
        settings: state.settings,
        attributeSchema: state.attributeSchema,
        activeSchemaTemplateId: state.activeSchemaTemplateId,
        initiativeAttributeName: state.initiativeAttributeName,
        customTemplates: Object.values(state.customTemplates),
        globalRollTemplates: state.globalRollTemplates,
        loadedDiceRules: state.loadedDiceRules,
        mapOrder: state.maps.map((m) => m.id),
        sheetOrder: Object.keys(state.sheets),
      },
    },
  };
  entries.push({
    name: GLOBAL_STATE_NAME,
    data: encoder.encode(JSON.stringify(globalState, null, 2)),
    compress: true,
  });

  // 3. scenes/{mapId}.json and collect images
  const collectedImages = new Map<string, MapImage>();

  for (const map of fullMaps) {
    // Layers projection
    const layers = (map.images || []).map((img) => {
      collectedImages.set(img.id, img);
      const ext = getImageExt(img.contentType);
      return {
        id: img.id,
        name: img.name,
        type: "image",
        assetRef: `assets/images/${img.id}.${ext}`,
        zIndex: img.layerOrder,
        opacity: img.opacity,
        vendorData: {
          [VENDOR_KEY]: img,
        },
      };
    });

    // Entity instances projection
    const entityInstances = (map.tokens || []).map((tok) => ({
      instanceId: tok.id,
      entityRef: tok.sheetId ? `entities/sheet_${tok.sheetId}.json` : null,
      transform: {
        gridPosition: { x: tok.x, y: tok.y },
        pixelOffset: { x: 0, y: 0 },
        rotation: 0,
        scale: 1,
      },
      vendorData: {
        [VENDOR_KEY]: {
          id: tok.id,
          type: tok.type,
          ownerUserId: tok.ownerUserId,
          representsUserId: tok.representsUserId,
          name: tok.name,
          color: tok.color,
          iconKind: tok.iconKind,
          mapId: tok.mapId,
          x: tok.x,
          y: tok.y,
          sheetId: tok.sheetId,
          hidden: tok.hidden,
        },
      },
    }));

    const sceneDoc = {
      sceneId: map.id,
      dimensions: {
        width: map.grid.widthCells * map.grid.cellPixels,
        height: map.grid.heightCells * map.grid.cellPixels,
      },
      grid: {
        type: "square",
        size: map.grid.cellPixels,
        offsetX: 0,
        offsetY: 0,
        color: map.grid.lineColor,
        visible: map.grid.showGridLines,
        measurement: {
          distance: 5,
          unit: "ft",
        },
      },
      ambience: [],
      layers,
      entityInstances,
      vendorData: {
        [VENDOR_KEY]: {
          id: map.id,
          name: map.name,
          listOrder: map.listOrder,
          createdUtc: map.createdUtc,
          grid: map.grid,
          defaultSpawnX: map.defaultSpawnPosition?.x ?? null,
          defaultSpawnY: map.defaultSpawnPosition?.y ?? null,
          fogMask: map.fogMask || "",
        },
      },
    };

    entries.push({
      name: `scenes/${map.id}.json`,
      data: encoder.encode(JSON.stringify(sceneDoc, null, 2)),
      compress: true,
    });
  }

  // 4. entities/sheet_{sheetId}.json
  for (const sheet of Object.values(state.sheets)) {
    const sheetDoc = {
      entityId: `sheet_${sheet.id}`,
      name: sheet.characterName,
      assetRef: null,
      vendorData: {
        [VENDOR_KEY]: sheet,
      },
    };

    entries.push({
      name: `entities/sheet_${sheet.id}.json`,
      data: encoder.encode(JSON.stringify(sheetDoc, null, 2)),
      compress: true,
    });
  }

  // 5. assets/images/{imageId}.{ext} (STORED - method 0)
  if (options?.getImageBlob && collectedImages.size > 0) {
    for (const [imgId, img] of collectedImages) {
      const blob = await options.getImageBlob(imgId);
      if (blob) {
        const ext = getImageExt(img.contentType);
        entries.push({
          name: `assets/images/${imgId}.${ext}`,
          data: blob,
          compress: false, // STORED
        });
      }
    }
  }

  // 6. extensions/knockbox_dnd_mapper.json
  const extDoc = {
    activeCombat: state.activeCombat ?? null,
    phase: state.phase,
  };
  entries.push({
    name: EXTENSION_NAME,
    data: encoder.encode(JSON.stringify(extDoc, null, 2)),
    compress: true,
  });

  return await buildZipBlob(entries);
}

/**
 * Exports a saved slot from LibraryService into a VTF Blob.
 */
export async function exportCampaignSlot(
  libraryService: LibraryService,
  slotId: string,
): Promise<{ blob: Blob; fileName: string }> {
  const loaded = await libraryService.loadSlot(slotId);
  if (!loaded) {
    throw new Error(`Failed to load slot '${slotId}' for export.`);
  }

  const slots = await libraryService.listSlots();
  const slotInfo = slots.find((s) => s.id === slotId);
  const title = slotInfo?.name || "Campaign";

  const blob = await exportVtf(loaded, {
    slotTitle: title,
    getImageBlob: (id) => libraryService.getImage(id),
  });

  const fileName = formatVtfFileName(title);
  return { blob, fileName };
}

/**
 * Sanitizes a campaign name and formats standard VTF filename:
 * {CampaignName}_{yyyyMMdd_HHmm}.vtf
 */
export function formatVtfFileName(title: string, date: Date = new Date()): string {
  const clean = title.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "Campaign";
  const yyyy = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const HH = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${clean}_${yyyy}${MM}${dd}_${HH}${mm}.vtf`;
}

/**
 * Triggers a browser download for a Blob with delayed URL revocation
 * to prevent race condition 0-byte download corruption.
 */
export function triggerVtfDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
