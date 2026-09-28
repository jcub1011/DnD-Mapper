/**
 * CRC32 checksum calculation matching standard ZIP ISO 3309 / ITU-T V.42.
 * Uses polynomial 0xEDB88320 with precomputed lookup table.
 */

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c >>> 0;
}

/**
 * Computes the CRC32 checksum of a byte array.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Streaming CRC32 calculator for chunked processing.
 */
export class Crc32Stream {
  private crc = 0xffffffff;

  public append(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.crc = (this.crc >>> 8) ^ CRC32_TABLE[(this.crc ^ data[i]) & 0xff];
    }
  }

  public finish(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}
