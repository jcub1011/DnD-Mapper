/*
 * Campaign chunked import protocol helper.
 *
 * Implements the safe streaming import per 06-state-and-authority.md:
 * packs maps by measured UTF-8 byte size to guarantee no frame exceeds CHUNK_BUDGET,
 * preventing 1009 socket close loops.
 */

import type { CampaignHeader, GameMap } from "./domain.js";
import type { Intent } from "./types.js";
import { CHUNK_BUDGET } from "./types.js";
import { utf8Length } from "./wire.js";
import { generateGuid } from "./maps.js";

/**
 * Partitions maps into chunks where each chunk's JSON representation stays under maxBytes.
 * Throws an Error if a single map exceeds maxBytes on its own.
 */
export function packCampaignChunks(
  maps: readonly GameMap[],
  maxBytes = CHUNK_BUDGET,
): readonly (readonly GameMap[])[] {
  const chunks: Array<readonly GameMap[]> = [];
  let currentChunk: GameMap[] = [];

  for (const map of maps) {
    const singleMapBytes = utf8Length(JSON.stringify([map]));
    if (singleMapBytes > maxBytes) {
      throw new Error(
        `Map "${map.name}" (${map.id}) is ${singleMapBytes} bytes, which exceeds the chunk limit of ${maxBytes} bytes.`,
      );
    }

    const candidate = [...currentChunk, map];
    const candidateBytes = utf8Length(JSON.stringify(candidate));
    if (candidateBytes > maxBytes && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [map];
    } else {
      currentChunk.push(map);
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Executes a chunked import sequence by emitting beginImport, importChunk (x N), and commitImport intents.
 */
export function sendChunkedImport(
  sendIntent: (intent: Intent) => void,
  campaign: CampaignHeader,
  maps: readonly GameMap[],
  importToken = generateGuid(),
): string {
  const chunks = packCampaignChunks(maps, CHUNK_BUDGET);

  sendIntent({
    kind: "beginImport",
    token: importToken,
    campaign,
    chunkCount: chunks.length,
  });

  for (let i = 0; i < chunks.length; i++) {
    sendIntent({
      kind: "importChunk",
      token: importToken,
      index: i,
      maps: chunks[i],
    });
  }

  sendIntent({
    kind: "commitImport",
    token: importToken,
  });

  return importToken;
}
