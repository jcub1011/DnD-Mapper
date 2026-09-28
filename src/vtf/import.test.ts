import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFog, encodeFog, isFogged } from "../game/fog.js";
import { openDatabase } from "../storage/db.js";
import { LibraryService } from "../storage/libraryService.js";
import { importVtf } from "./import.js";
import { isSafeRelativePath } from "./safePath.js";
import { openZip } from "./unzip.js";

// Helper to calculate SHA-256 hex string of a Blob
async function hashBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Helper to build test ZIPs in memory
async function buildTestZip(
  entries: {
    name: string;
    content: string | Uint8Array | Blob;
    compress?: boolean;
    fakeUncompressedSize?: number;
    fakeCompressedSize?: number;
  }[],
  comment = "",
  options?: { insertZip64Locator?: boolean },
): Promise<Blob> {
  const localChunks: (Uint8Array | Blob)[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  function utf8(s: string): Uint8Array {
    return new TextEncoder().encode(s);
  }

  async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    writer.write(bytes as unknown as BufferSource);
    writer.close();
    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    let method = 0;
    let rawLength: number;
    let body: Uint8Array | Blob;

    if (typeof entry.content === "string") {
      const bytes = utf8(entry.content);
      rawLength = bytes.length;
      body = bytes;
    } else if (entry.content instanceof Uint8Array) {
      rawLength = entry.content.length;
      body = entry.content;
    } else {
      rawLength = entry.content.size;
      body = entry.content;
    }

    if (entry.compress && body instanceof Uint8Array) {
      method = 8;
      body = await deflateRaw(body);
    }

    const bodyLength = body instanceof Uint8Array ? body.length : body.size;
    const uncompressedSize = entry.fakeUncompressedSize ?? rawLength;
    const compressedSize = entry.fakeCompressedSize ?? bodyLength;

    // Local Header (30 bytes + name)
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, 0, true); // CRC ignored for test
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    localChunks.push(local, body);

    // Central Directory record (46 bytes + name)
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, 0, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    centralChunks.push(central);
    offset += local.length + bodyLength;
  }

  const commentBytes = utf8(comment);
  let cdSize = 0;
  for (const c of centralChunks) cdSize += c.length;

  const extraRecords: Uint8Array[] = [];
  if (options?.insertZip64Locator) {
    // 20-byte ZIP64 locator: sig 0x07064b50
    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    extraRecords.push(locator);
  }

  // EOCD (22 bytes + comment)
  const eocd = new Uint8Array(22 + commentBytes.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, commentBytes.length, true);
  if (commentBytes.length > 0) eocd.set(commentBytes, 22);

  return new Blob([
    ...localChunks,
    ...centralChunks,
    ...extraRecords,
    eocd,
  ] as unknown as BlobPart[]);
}

describe("VTF safePath", () => {
  it("rejects invalid or traversal paths", () => {
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath("   ")).toBe(false);
    expect(isSafeRelativePath("/abs/path")).toBe(false);
    expect(isSafeRelativePath("C:/win")).toBe(false);
    expect(isSafeRelativePath("a\\b")).toBe(false);
    expect(isSafeRelativePath("../escape")).toBe(false);
    expect(isSafeRelativePath("a/../b")).toBe(false);
    expect(isSafeRelativePath("./a/b")).toBe(false);
    expect(isSafeRelativePath("a/./b")).toBe(false);
  });

  it("accepts safe relative paths", () => {
    expect(isSafeRelativePath("manifest.json")).toBe(true);
    expect(isSafeRelativePath("scenes/abc-123.json")).toBe(true);
    expect(isSafeRelativePath("assets/images/66666666-6666-6666-6666-666666666666.png")).toBe(true);
    expect(isSafeRelativePath("extensions/knockbox_dnd_mapper.json")).toBe(true);
  });
});

describe("VTF Specification Requirements (04-vtf-format.md)", () => {
  it("Minimal valid archive round-trips to the expected state", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "camp-min", title: "Minimal Slot", lastModified: "2026-09-08T00:00:00Z" },
          system: { core: "dnd5e" },
          dependencies: [{ name: "knockbox_dnd_mapper" }],
        }),
      },
      {
        name: "global_state.json",
        content: JSON.stringify({
          vendorData: { knockbox_dnd_mapper: {} },
        }),
      },
    ]);

    const result = await importVtf(zipBlob);
    expect(result.slotTitle).toBe("Minimal Slot");
    expect(result.maps.length).toBe(0);
    expect(result.sheets.length).toBe(0);
    expect(result.images.size).toBe(0);
    expect(result.warnings.length).toBe(0);
  });

  it("vtfVersion: '2.0.0' throws and does not attempt best-effort", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "2.0.0",
          campaign: { id: "1", title: "Future Campaign", lastModified: "" },
        }),
      },
    ]);

    await expect(importVtf(zipBlob)).rejects.toThrow(/v2\.x; this build supports up to v1\.x/);
  });

  it("Entry named '../evil.json' is rejected (zip-slip)", async () => {
    const zipBlob = await buildTestZip([
      { name: "../evil.json", content: "{}" },
      { name: "manifest.json", content: '{"vtfVersion":"1.0.0"}' },
    ]);

    await expect(openZip(zipBlob)).rejects.toThrow(/Unsafe archive entry path/);
  });

  it("Base64 fog mask decodes to the right fogged cells, including non-byte-aligned widths", async () => {
    // Grid: 15 wide by 10 high (150 cells total -> ceil(150 / 8) = 19 bytes)
    const grid = {
      widthCells: 15,
      heightCells: 10,
      cellPixels: 50,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    };

    const rawBytes = new Uint8Array(19);
    // Fog cell (14, 0): bit index = 0 * 15 + 14 = 14 -> byte 1, bit 6
    rawBytes[1] |= 1 << 6;
    // Fog cell (0, 1): bit index = 1 * 15 + 0 = 15 -> byte 1, bit 7
    rawBytes[1] |= 1 << 7;
    // Fog cell (3, 2): bit index = 2 * 15 + 3 = 33 -> byte 4, bit 1
    rawBytes[4] |= 1 << 1;

    const b64 = encodeFog(rawBytes);

    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Fog Test", lastModified: "" },
        }),
      },
      {
        name: "scenes/scene-fog.json",
        content: JSON.stringify({
          sceneId: "scene-fog",
          dimensions: { width: 750, height: 500 },
          grid: { type: "square", size: 50, offsetX: 0, offsetY: 0, visible: true },
          layers: [],
          entityInstances: [],
          vendorData: {
            knockbox_dnd_mapper: {
              id: "scene-fog",
              name: "Foggy Map",
              listOrder: 0,
              grid,
              fogMask: b64,
            },
          },
        }),
      },
    ]);

    const result = await importVtf(zipBlob);
    expect(result.maps.length).toBe(1);
    const map = result.maps[0];
    const decoded = decodeFog(map.fogMask);
    expect(decoded.length).toBe(19);

    expect(isFogged(decoded, map.grid, 14, 0)).toBe(true);
    expect(isFogged(decoded, map.grid, 0, 1)).toBe(true);
    expect(isFogged(decoded, map.grid, 3, 2)).toBe(true);

    expect(isFogged(decoded, map.grid, 13, 0)).toBe(false);
    expect(isFogged(decoded, map.grid, 1, 1)).toBe(false);
    expect(isFogged(decoded, map.grid, 2, 2)).toBe(false);
  });

  it("Absent fog mask yields fully revealed, not fully fogged", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Revealed Campaign", lastModified: "" },
        }),
      },
      {
        name: "scenes/scene-revealed.json",
        content: JSON.stringify({
          sceneId: "scene-revealed",
          dimensions: { width: 1000, height: 1000 },
          grid: { type: "square", size: 50, offsetX: 0, offsetY: 0, visible: true },
          layers: [],
          entityInstances: [],
          vendorData: {
            knockbox_dnd_mapper: {
              id: "scene-revealed",
              name: "Sunny Meadows",
              listOrder: 0,
              grid: {
                widthCells: 20,
                heightCells: 20,
                cellPixels: 50,
                showGridLines: true,
                snapToGrid: true,
                lineColor: "#222",
              },
              // fogMask intentionally absent!
            },
          },
        }),
      },
    ]);

    const result = await importVtf(zipBlob);
    expect(result.maps.length).toBe(1);
    const map = result.maps[0];
    expect(map.fogMask).toBe("");
    const decoded = decodeFog(map.fogMask);
    expect(decoded.length).toBe(0);
    expect(isFogged(decoded, map.grid, 0, 0)).toBe(false);
    expect(isFogged(decoded, map.grid, 10, 10)).toBe(false);
  });

  it("Token with vendor data lands at a cell centre (x.5)", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Token Test", lastModified: "" },
        }),
      },
      {
        name: "scenes/scene-token.json",
        content: JSON.stringify({
          sceneId: "scene-token",
          dimensions: { width: 1000, height: 1000 },
          grid: { type: "square", size: 50, offsetX: 0, offsetY: 0, visible: true },
          layers: [],
          entityInstances: [
            {
              instanceId: "token-1",
              transform: { gridPosition: { x: 3.5, y: 4.5 }, rotation: 0, scale: 1 },
              vendorData: {
                knockbox_dnd_mapper: {
                  id: "token-1",
                  name: "Wizard",
                  x: 3.5,
                  y: 4.5,
                  color: "#3366cc",
                  iconKind: "Initial",
                  type: "PlayerToken",
                },
              },
            },
          ],
          vendorData: {
            knockbox_dnd_mapper: {
              id: "scene-token",
              name: "Token Scene",
              listOrder: 0,
              grid: {
                widthCells: 20,
                heightCells: 20,
                cellPixels: 50,
                showGridLines: true,
                snapToGrid: true,
                lineColor: "#222",
              },
            },
          },
        }),
      },
    ]);

    const result = await importVtf(zipBlob);
    const token = result.maps[0].tokens[0];
    expect(token.x).toBe(3.5);
    expect(token.y).toBe(4.5);
    expect(token.name).toBe("Wizard");
  });

  it("Token with no vendor data hits the synthesis fallback", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Fallback Slot", lastModified: "" },
        }),
      },
      {
        name: "scenes/scene-fallback.json",
        content: JSON.stringify({
          sceneId: "scene-fallback",
          dimensions: { width: 1000, height: 1000 },
          grid: { type: "square", size: 50, offsetX: 0, offsetY: 0, visible: true },
          layers: [],
          entityInstances: [
            {
              instanceId: "inst-synthetic-token",
              transform: { gridPosition: { x: 7.5, y: 8.5 }, rotation: 0, scale: 1 },
            },
          ],
          vendorData: {
            knockbox_dnd_mapper: {
              id: "scene-fallback",
              name: "Fallback Scene",
              listOrder: 0,
              grid: {
                widthCells: 20,
                heightCells: 20,
                cellPixels: 50,
                showGridLines: true,
                snapToGrid: true,
                lineColor: "#222",
              },
            },
          },
        }),
      },
    ]);

    const result = await importVtf(zipBlob);
    expect(result.maps[0].tokens.length).toBe(1);
    const token = result.maps[0].tokens[0];
    expect(token.id).toBe("inst-synthetic-token");
    expect(token.x).toBe(7.5);
    expect(token.y).toBe(8.5);
    expect(token.name).toBe("Token");
    expect(token.type).toBe("NPCToken");
  });

  it("Layer with no vendor data is skipped with a warning and import still succeeds", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Warning Slot", lastModified: "" },
        }),
      },
      {
        name: "scenes/scene-1.json",
        content: JSON.stringify({
          sceneId: "scene-1",
          dimensions: { width: 1000, height: 1000 },
          grid: { type: "square", size: 50, offsetX: 0, offsetY: 0, visible: true },
          layers: [
            { id: "layer-audio", type: "audio", zIndex: 0, opacity: 1 },
            { id: "layer-no-vendor", type: "image", zIndex: 1, opacity: 1 },
          ],
          entityInstances: [],
          vendorData: {
            knockbox_dnd_mapper: {
              id: "scene-1",
              name: "Map 1",
              listOrder: 0,
              grid: {
                widthCells: 20,
                heightCells: 20,
                cellPixels: 50,
                showGridLines: true,
                snapToGrid: true,
                lineColor: "#222",
              },
            },
          },
        }),
      },
    ]);

    const result = await importVtf(zipBlob);
    expect(result.maps[0].images.length).toBe(0);
    expect(result.warnings.some((w) => w.includes("unsupported type 'audio'"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("without DnD Mapper vendor data"))).toBe(true);
  });

  it("Unknown JSON field survives in extra", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Future Fields", lastModified: "" },
          futureSpecField: "preservedValue",
        }),
      },
      {
        name: "global_state.json",
        content: JSON.stringify({
          vendorData: {
            knockbox_dnd_mapper: {
              futureVendorSetting: 12345,
            },
          },
        }),
      },
      {
        name: "scenes/scene-extra.json",
        content: JSON.stringify({
          sceneId: "scene-extra",
          dimensions: { width: 500, height: 500 },
          grid: { type: "square", size: 50, offsetX: 0, offsetY: 0, visible: true },
          futureSceneField: "coolEffect",
          layers: [],
          entityInstances: [],
          vendorData: {
            knockbox_dnd_mapper: {
              id: "scene-extra",
              name: "Extra Scene",
              listOrder: 0,
              grid: {
                widthCells: 10,
                heightCells: 10,
                cellPixels: 50,
                showGridLines: true,
                snapToGrid: true,
                lineColor: "#222",
              },
              unknownSceneConfig: { deep: true },
            },
          },
        }),
      },
    ]);

    const zip = await openZip(zipBlob);
    const manifestEntry = zip.getEntry("manifest.json")!;
    const manifest = await zip.readJson<Record<string, unknown>>(manifestEntry);
    expect(manifest).not.toBeNull();
    expect(manifest?.futureSpecField).toBe("preservedValue");

    const result = await importVtf(zipBlob);
    expect(result.slotTitle).toBe("Future Fields");
    expect(result.maps.length).toBe(1);
  });

  it("Two imports of one file produce distinct image ids, identical blob hashes", async () => {
    const dummyImageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Dedup Test", lastModified: "" },
        }),
      },
      {
        name: "assets/images/12345678-1234-1234-1234-123456789abc.png",
        content: dummyImageBytes,
      },
      {
        name: "scenes/scene-img.json",
        content: JSON.stringify({
          sceneId: "scene-img",
          dimensions: { width: 500, height: 500 },
          grid: { type: "square", size: 50, offsetX: 0, offsetY: 0, visible: true },
          layers: [
            {
              id: "layer-1",
              type: "image",
              vendorData: {
                knockbox_dnd_mapper: {
                  id: "12345678-1234-1234-1234-123456789abc",
                  name: "Tile",
                  contentType: "image/png",
                  x: 0,
                  y: 0,
                  width: 5,
                  height: 5,
                  originalWidth: 500,
                  originalHeight: 500,
                  rotation: 0,
                  opacity: 1,
                  layerOrder: 0,
                  locked: false,
                  hidden: false,
                },
              },
            },
          ],
          entityInstances: [],
          vendorData: {
            knockbox_dnd_mapper: {
              id: "scene-img",
              name: "Image Scene",
              listOrder: 0,
              grid: {
                widthCells: 10,
                heightCells: 10,
                cellPixels: 50,
                showGridLines: true,
                snapToGrid: true,
                lineColor: "#222",
              },
            },
          },
        }),
      },
    ]);

    const res1 = await importVtf(zipBlob);
    const res2 = await importVtf(zipBlob);

    const [img1] = res1.images.values();
    const [img2] = res2.images.values();

    expect(img1.id).not.toBe(img2.id);

    const hash1 = await hashBlob(img1.blob);
    const hash2 = await hashBlob(img2.blob);
    expect(hash1).toBe(hash2);
  });

  it("Archive with a trailing comment still finds EOCD by signature scan", async () => {
    const zipBlob = await buildTestZip(
      [
        {
          name: "manifest.json",
          content: JSON.stringify({
            vtfVersion: "1.0.0",
            campaign: { id: "1", title: "Commented Campaign", lastModified: "" },
          }),
        },
      ],
      "This is a trailing archive comment that shifts EOCD offset.",
    );

    const result = await importVtf(zipBlob);
    expect(result.slotTitle).toBe("Commented Campaign");
  });

  it("ZIP64 EOCD record is rejected explicitly, not misread", async () => {
    const zipBlob = await buildTestZip(
      [
        {
          name: "manifest.json",
          content: JSON.stringify({
            vtfVersion: "1.0.0",
            campaign: { id: "1", title: "ZIP64 test", lastModified: "" },
          }),
        },
      ],
      "",
      { insertZip64Locator: true },
    );

    await expect(openZip(zipBlob)).rejects.toThrow(/ZIP64 archives are not supported/);
  });

  it("A 200 MB fixture imports without ever materialising the whole archive (assert peak slice size)", async () => {
    // 204 MB total across 3 STORED images of 68 MB each (each < 100 MB per-file cap)
    // using references to a 1 MB typed array (takes only 1 MB real RAM)
    const dummy1MB = new Uint8Array(1024 * 1024);
    const dummy68MBBlob = new Blob(new Array(68).fill(dummy1MB));

    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Large 200MB Campaign", lastModified: "" },
        }),
      },
      {
        name: "assets/images/11111111-1111-1111-1111-111111111111.png",
        content: dummy68MBBlob,
        compress: false, // STORED -> zero copy
      },
      {
        name: "assets/images/22222222-2222-2222-2222-222222222222.png",
        content: dummy68MBBlob,
        compress: false,
      },
      {
        name: "assets/images/33333333-3333-3333-3333-333333333333.png",
        content: dummy68MBBlob,
        compress: false,
      },
    ]);

    expect(zipBlob.size).toBeGreaterThanOrEqual(200 * 1024 * 1024);

    let peakSliceSize = 0;
    const origSlice = zipBlob.slice.bind(zipBlob);
    zipBlob.slice = (start?: number, end?: number, contentType?: string) => {
      const s = origSlice(start, end, contentType);
      if (s.size > peakSliceSize) {
        peakSliceSize = s.size;
      }
      return s;
    };

    const result = await importVtf(zipBlob);
    expect(result.slotTitle).toBe("Large 200MB Campaign");
    // Assert peak slice size is bounded by single-entry cap and never materialises whole archive
    expect(peakSliceSize).toBeLessThan(zipBlob.size / 2);
    expect(peakSliceSize).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it("DecompressionStream absent fails at import time with a clear message, not mid-entry", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "No DS Slot", lastModified: "" },
        }),
      },
    ]);

    const origDS = globalThis.DecompressionStream;
    try {
      // @ts-expect-error mutating global for test
      delete globalThis.DecompressionStream;

      await expect(importVtf(zipBlob)).rejects.toThrow(
        /DecompressionStream is not supported in this environment\. Modern browser required/,
      );
    } finally {
      globalThis.DecompressionStream = origDS;
    }
  });

  it("Per-file 100 MB cap is enforced on uncompressed image size", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Giant Image Slot", lastModified: "" },
        }),
      },
      {
        name: "assets/images/11111111-1111-1111-1111-111111111111.png",
        content: new Uint8Array(16),
        fakeUncompressedSize: 105 * 1024 * 1024, // 105 MB > 100 MB cap
      },
    ]);

    await expect(importVtf(zipBlob)).rejects.toThrow(/exceeds maximum allowed size of 100 MB/);
  });

  it("Room aggregate 1 GB cap is enforced on total uncompressed image size", async () => {
    // 11 images of 95 MB each = 1045 MB > 1024 MB (1 GB), while each individual image is < 100 MB cap
    const images = Array.from({ length: 11 }, (_, i) => ({
      name: `assets/images/${String(i).padStart(8, "0")}-0000-0000-0000-000000000000.png`,
      content: new Uint8Array(16),
      fakeUncompressedSize: 95 * 1024 * 1024,
    }));

    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Giant Room Slot", lastModified: "" },
        }),
      },
      ...images,
    ]);

    await expect(importVtf(zipBlob)).rejects.toThrow(
      /exceeds maximum allowed room storage of 1 GB/,
    );
  });

  it("Rejects files with disallowed MIME types", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "MIME test", lastModified: "" },
        }),
      },
    ]);

    const disallowedBlob = new Blob([await zipBlob.arrayBuffer()], { type: "application/pdf" });
    await expect(importVtf(disallowedBlob)).rejects.toThrow(
      /Unsupported archive MIME type 'application\/pdf'/,
    );
  });

  it("LibraryService.importSlot persists unpack result and images to IndexedDB", async () => {
    const db = await openDatabase();
    const service = new LibraryService();
    service.attach(db);

    const dummyImageBytes = new Uint8Array([1, 2, 3, 4]);
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Persist Slot", lastModified: "" },
        }),
      },
      {
        name: "assets/images/33333333-3333-3333-3333-333333333333.png",
        content: dummyImageBytes,
      },
      {
        name: "scenes/scene-p.json",
        content: JSON.stringify({
          sceneId: "scene-p",
          dimensions: { width: 500, height: 500 },
          grid: { type: "square", size: 50, offsetX: 0, offsetY: 0, visible: true },
          layers: [],
          entityInstances: [],
          vendorData: {
            knockbox_dnd_mapper: {
              id: "scene-p",
              name: "Persist Map",
              listOrder: 0,
              grid: {
                widthCells: 10,
                heightCells: 10,
                cellPixels: 50,
                showGridLines: true,
                snapToGrid: true,
                lineColor: "#222",
              },
            },
          },
        }),
      },
    ]);

    const unpackResult = await importVtf(zipBlob);
    const slotId = await service.importSlot(unpackResult, "slot-persist-test");
    expect(slotId).toBe("slot-persist-test");

    const loadedState = await service.loadSlot("slot-persist-test");
    expect(loadedState).not.toBeNull();
    expect(loadedState?.maps.length).toBe(1);
    expect(loadedState?.maps[0].name).toBe("Persist Map");

    const imageId = Array.from(unpackResult.images.keys())[0];
    const loadedBlob = await service.getImage(imageId);
    expect(loadedBlob).not.toBeNull();
    expect(loadedBlob?.size).toBe(4);
  });

  it("Imports the real legacy golden.vtf fixture with 100% fidelity", async () => {
    const fixturePath = path.resolve(__dirname, "../../test/fixtures/golden.vtf");
    const fileBuffer = await fs.readFile(fixturePath);
    const blob = new Blob([fileBuffer]);

    const result = await importVtf(blob);

    // 1. Slot Title
    expect(result.slotTitle).toBe("Rich golden slot");

    // 2. Maps & ordering
    expect(result.maps.length).toBe(2);
    // Global vendor mapOrder ordered mapB ("33333333...") before mapA ("22222222...")
    expect(result.maps[0].id.toLowerCase()).toBe("33333333-3333-3333-3333-333333333333");
    expect(result.maps[1].id.toLowerCase()).toBe("22222222-2222-2222-2222-222222222222");

    // Map A properties
    const mapA = result.maps[1];
    expect(mapA.name).toBe("Lair");
    expect(mapA.grid.widthCells).toBe(30);
    expect(mapA.grid.heightCells).toBe(20);
    expect(mapA.grid.cellPixels).toBe(50);
    expect(mapA.grid.snapToGrid).toBe(true);
    expect(mapA.defaultSpawnPosition).toEqual({ x: 1.5, y: 2.5 });

    // Fog mask on Map A
    const decodedFog = decodeFog(mapA.fogMask);
    expect(decodedFog.length).toBe(75); // 30 * 20 / 8 = 75
    for (let i = 0; i < 75; i++) {
      expect(decodedFog[i]).toBe((i * 7) % 256);
    }
    expect(isFogged(decodedFog, mapA.grid, 0, 0)).toBe((decodedFog[0] & 1) !== 0);

    // Map B fog mask was empty in legacy fixture -> all revealed
    const mapB = result.maps[0];
    expect(mapB.name).toBe("Tavern");
    const decodedFogB = decodeFog(mapB.fogMask);
    expect(decodedFogB.length).toBe(0);
    expect(isFogged(decodedFogB, mapB.grid, 5, 5)).toBe(false);

    // 3. Tokens
    expect(mapA.tokens.length).toBe(1);
    const token1 = mapA.tokens[0];
    expect(token1.name).toBe("Goblin");
    expect(token1.color).toBe("#669944");
    expect(token1.x).toBe(4.5);
    expect(token1.y).toBe(6.25);
    expect(token1.iconKind).toBe("Initial");

    expect(mapB.tokens.length).toBe(1);
    const token2 = mapB.tokens[0];
    expect(token2.name).toBe("Innkeeper");
    expect(token2.x).toBe(10);
    expect(token2.y).toBe(7);

    // 4. Images
    expect(mapA.images.length).toBe(2);
    expect(mapB.images.length).toBe(1);
    expect(result.images.size).toBe(3);

    const originalPngId = "66666666-6666-6666-6666-666666666666";
    expect(mapA.images.some((img) => img.id.toLowerCase() === originalPngId)).toBe(false);

    for (const img of mapA.images) {
      expect(result.images.has(img.id)).toBe(true);
      const asset = result.images.get(img.id)!;
      expect(asset.blob.size).toBeGreaterThan(0);
      expect(["image/png", "image/jpeg", "image/webp"]).toContain(asset.contentType);
    }

    // 5. Character Sheets & ordering
    expect(result.sheets.length).toBe(2);
    expect(result.sheets[0].id.toLowerCase()).toBe("55555555-5555-5555-5555-555555555555");
    expect(result.sheets[1].id.toLowerCase()).toBe("44444444-4444-4444-4444-444444444444");

    const sheet1 = result.sheets[1];
    expect(sheet1.characterName).toBe("Goblin scout");
    expect(sheet1.notes).toBe("Carries a rusty short sword.");
    expect(sheet1.hp).toBe(6);
    expect(sheet1.maxHp).toBe(12);
    expect(sheet1.statusEffects.length).toBe(1);
    expect(sheet1.statusEffects[0].name).toBe("Limping");
    expect(sheet1.rollTemplates.length).toBe(1);
    expect(sheet1.rollTemplates[0].name).toBe("Stab");

    // 6. Settings and Global Roll Templates
    expect(result.core.settings.tokenMovement).toBe("Anyone");
    expect(result.core.settings.rollsVisibleToPlayers).toBe(true);
    expect(result.core.globalRollTemplates.length).toBe(1);
    expect(result.core.globalRollTemplates[0].name).toBe("House attack");

    // 7. No warnings
    expect(result.warnings.length).toBe(0);
  });
});
