/**
 * Streaming, zero-slurp ZIP reader over a Blob.
 *
 * Designed specifically for large battlemap archives (~200MB+):
 *   1. Scans backwards for the EOCD record in the last 65 KB.
 *   2. Slices and reads only the Central Directory (a few KB).
 *   3. Evaluates safe paths before reading any data.
 *   4. Extracts entries lazily: STORED (method 0) entries return sliced Blobs
 *      without copy; DEFLATE (method 8) entries stream through DecompressionStream('deflate-raw').
 *   5. Never loads the entire archive into memory at once.
 */

import { isSafeRelativePath } from "./safePath.js";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number; // 0 = stored, 8 = deflate
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

export interface ZipArchiveReader {
  readonly entries: readonly ZipEntry[];
  getEntry(name: string): ZipEntry | undefined;
  readBlob(entry: ZipEntry): Promise<Blob>;
  readText(entry: ZipEntry): Promise<string>;
  readJson<T>(entry: ZipEntry): Promise<T | null>;
}

/**
 * Parses central directory records from a ZIP Blob.
 */
export async function openZip(blob: Blob): Promise<ZipArchiveReader> {
  const size = blob.size;
  if (size < 22) {
    throw new Error("Invalid ZIP: file too small.");
  }

  // Scan backwards for EOCD signature in the last 65,557 bytes (64 KB max comment + 22 bytes EOCD)
  const scanLength = Math.min(size, 65557);
  const scanStart = size - scanLength;
  const scanBuffer = await blob.slice(scanStart, size).arrayBuffer();
  const scanBytes = new Uint8Array(scanBuffer);
  const scanView = new DataView(scanBuffer);

  let eocdRelOffset = -1;
  for (let i = scanBytes.length - 22; i >= 0; i--) {
    if (scanView.getUint32(i, true) === SIG_EOCD) {
      eocdRelOffset = i;
      break;
    }
  }

  if (eocdRelOffset < 0) {
    throw new Error("Invalid ZIP: End of Central Directory signature not found.");
  }

  // Check for ZIP64 locator or EOCD preceding EOCD
  for (let i = 0; i <= eocdRelOffset - 4; i++) {
    const sig = scanView.getUint32(i, true);
    if (sig === SIG_ZIP64_LOCATOR || sig === SIG_ZIP64_EOCD) {
      throw new Error("ZIP64 archives are not supported.");
    }
  }

  const totalEntries = scanView.getUint16(eocdRelOffset + 10, true);
  const cdSize = scanView.getUint32(eocdRelOffset + 12, true);
  const cdOffset = scanView.getUint32(eocdRelOffset + 16, true);

  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported.");
  }

  if (cdOffset + cdSize > size) {
    throw new Error("Invalid ZIP: Central directory extends past file boundary.");
  }

  // Read Central Directory
  const cdBuffer = await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const cdView = new DataView(cdBuffer);
  const cdBytes = new Uint8Array(cdBuffer);

  const textDecoder = new TextDecoder("utf-8");
  const entryList: ZipEntry[] = [];
  const entryMap = new Map<string, ZipEntry>();

  let offset = 0;
  while (offset < cdBuffer.byteLength) {
    const sig = cdView.getUint32(offset, true);
    if (sig !== SIG_CENTRAL) break;

    const compressionMethod = cdView.getUint16(offset + 10, true);
    const crc = cdView.getUint32(offset + 16, true);
    const compressedSize = cdView.getUint32(offset + 20, true);
    const uncompressedSize = cdView.getUint32(offset + 24, true);
    const nameLen = cdView.getUint16(offset + 28, true);
    const extraLen = cdView.getUint16(offset + 30, true);
    const commentLen = cdView.getUint16(offset + 32, true);
    const localHeaderOffset = cdView.getUint32(offset + 42, true);

    const nameBytes = cdBytes.subarray(offset + 46, offset + 46 + nameLen);
    const name = textDecoder.decode(nameBytes);

    if (!isSafeRelativePath(name)) {
      throw new Error(`Unsafe archive entry path: ${name}`);
    }

    const entry: ZipEntry = {
      name,
      compressionMethod,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    };

    entryList.push(entry);
    entryMap.set(name, entry);

    offset += 46 + nameLen + extraLen + commentLen;
  }

  async function getDataSlice(entry: ZipEntry): Promise<{ slice: Blob; method: number }> {
    // Read the 30-byte local header
    const localHeaderBuf = await blob
      .slice(entry.localHeaderOffset, entry.localHeaderOffset + 30)
      .arrayBuffer();
    const localView = new DataView(localHeaderBuf);

    const sig = localView.getUint32(0, true);
    if (sig !== SIG_LOCAL) {
      throw new Error(`Invalid local header signature for entry ${entry.name}`);
    }

    const localNameLen = localView.getUint16(26, true);
    const localExtraLen = localView.getUint16(28, true);
    const dataOffset = entry.localHeaderOffset + 30 + localNameLen + localExtraLen;

    const slice = blob.slice(dataOffset, dataOffset + entry.compressedSize);
    return { slice, method: entry.compressionMethod };
  }

  async function readBlob(entry: ZipEntry): Promise<Blob> {
    const { slice, method } = await getDataSlice(entry);

    if (method === 0) {
      // STORED: zero-copy sub-blob
      return slice;
    }

    if (method === 8) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error(
          "DecompressionStream('deflate-raw') is required to decompress VTF entries but is not supported in this environment.",
        );
      }

      const ds = new DecompressionStream("deflate-raw");
      const decompressedStream = slice.stream().pipeThrough(ds);
      const response = new Response(decompressedStream);
      return await response.blob();
    }

    throw new Error(`Unsupported compression method (${method}) for entry ${entry.name}`);
  }

  async function readText(entry: ZipEntry): Promise<string> {
    const uncompressedBlob = await readBlob(entry);
    return await uncompressedBlob.text();
  }

  async function readJson<T>(entry: ZipEntry): Promise<T | null> {
    const text = await readText(entry);
    if (!text || text.trim().length === 0) return null;
    return JSON.parse(text) as T;
  }

  return {
    entries: entryList,
    getEntry: (name: string) => entryMap.get(name),
    readBlob,
    readText,
    readJson,
  };
}
