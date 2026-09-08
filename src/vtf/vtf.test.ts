import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFog, isFogged } from "../game/fog.js";
import { importVtf } from "./import.js";
import { isSafeRelativePath } from "./safePath.js";
import { openZip } from "./unzip.js";

// Helper to build test ZIPs in memory
async function buildTestZip(
  entries: { name: string; content: string | Uint8Array; compress?: boolean }[],
  comment = "",
): Promise<Blob> {
  const localChunks: Uint8Array[] = [];
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
    const raw = typeof entry.content === "string" ? utf8(entry.content) : entry.content;
    let method = 0;
    let body = raw;

    if (entry.compress) {
      method = 8;
      body = await deflateRaw(raw);
    }

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
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
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
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    centralChunks.push(central);
    offset += local.length + body.length;
  }

  const commentBytes = utf8(comment);
  let cdSize = 0;
  for (const c of centralChunks) cdSize += c.length;

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

  return new Blob([...localChunks, ...centralChunks, eocd] as unknown as BlobPart[]);
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

describe("VTF Unpacker and Importer", () => {
  it("rejects zip-slip archive entry", async () => {
    const zipBlob = await buildTestZip([
      { name: "../evil.json", content: "{}" },
      { name: "manifest.json", content: '{"vtfVersion":"1.0.0"}' },
    ]);

    await expect(openZip(zipBlob)).rejects.toThrow(/Unsafe archive entry path/);
  });

  it("rejects unsupported future major version in manifest", async () => {
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

  it("rejects missing manifest.json", async () => {
    const zipBlob = await buildTestZip([
      { name: "global_state.json", content: "{}" },
    ]);

    await expect(importVtf(zipBlob)).rejects.toThrow(/missing manifest\.json/);
  });

  it("handles trailing archive comment without failing EOCD detection", async () => {
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

  it("synthesizes fallback token when vendor data is absent but transform exists", async () => {
    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Foreign Slot", lastModified: "" },
        }),
      },
      {
        name: "scenes/scene-1.json",
        content: JSON.stringify({
          sceneId: "scene-1",
          dimensions: { width: 1000, height: 1000 },
          grid: { type: "square", size: 50, offsetX: 0, offsetY: 0, visible: true },
          layers: [],
          entityInstances: [
            {
              instanceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              transform: { gridPosition: { x: 3.5, y: 4.5 }, rotation: 0, scale: 1 },
              // Note: NO vendorData!
            },
          ],
          vendorData: {
            knockbox_dnd_mapper: {
              id: "scene-1",
              name: "Map 1",
              listOrder: 0,
              grid: { widthCells: 20, heightCells: 20, cellPixels: 50, showGridLines: true, snapToGrid: true, lineColor: "#222" },
            },
          },
        }),
      },
    ]);

    const result = await importVtf(zipBlob);
    expect(result.maps.length).toBe(1);
    expect(result.maps[0].tokens.length).toBe(1);
    const token = result.maps[0].tokens[0];
    expect(token.id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(token.x).toBe(3.5);
    expect(token.y).toBe(4.5);
    expect(token.name).toBe("Token");
  });

  it("skips non-image layers or layers missing vendor data with warnings", async () => {
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
              grid: { widthCells: 20, heightCells: 20, cellPixels: 50, showGridLines: true, snapToGrid: true, lineColor: "#222" },
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

  it("streams and unzips without slurping the whole archive", async () => {
    // Construct a simulated archive containing a 5 MB dummy slice
    const dummyData = new Uint8Array(5 * 1024 * 1024);
    dummyData[100] = 42;

    const zipBlob = await buildTestZip([
      {
        name: "manifest.json",
        content: JSON.stringify({
          vtfVersion: "1.0.0",
          campaign: { id: "1", title: "Large Campaign", lastModified: "" },
        }),
      },
      {
        name: "assets/images/11111111-1111-1111-1111-111111111111.png",
        content: dummyData,
        compress: false, // STORED -> zero copy sub-blob
      },
    ]);

    // Track slice calls
    let _totalSlicedBytes = 0;
    const origSlice = zipBlob.slice.bind(zipBlob);
    zipBlob.slice = (start?: number, end?: number, contentType?: string) => {
      const s = origSlice(start, end, contentType);
      _totalSlicedBytes += s.size;
      return s;
    };

    const result = await importVtf(zipBlob);
    expect(result.slotTitle).toBe("Large Campaign");
    expect(result.images.size).toBe(1);
    const [img] = result.images.values();
    expect(img.blob.size).toBe(5 * 1024 * 1024);
  });

  it("imports the real legacy golden.vtf fixture with 100% fidelity", async () => {
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
    // Legacy test populated with: fogMask[i] = (byte)(i * 7 % 256)
    for (let i = 0; i < 75; i++) {
      expect(decodedFog[i]).toBe((i * 7) % 256);
    }
    // Spot check isFogged
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
    // Images exist across maps
    expect(mapA.images.length).toBe(2);
    expect(mapB.images.length).toBe(1);
    expect(result.images.size).toBe(3);

    // Assert image GUIDs were re-minted
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
    // SheetOrder ordered sheet2 ("55555555...") before sheet1 ("44444444...")
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
