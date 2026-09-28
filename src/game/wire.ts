/*
 * Relay-frame guardrails and length calculation.
 *
 * The relay enforces its frame cap (MAX_FRAME_BYTES) on every host→guest frame.
 * Nothing on the live path calls these today — per-recipient mode sends full
 * per-player snapshots, and `snapshotBudget.test.ts` bounds their size — but
 * the per-recipient patch fan-out parked for KnockBox-Games#62 will guard each
 * projected patch with `guardSize` before it goes on the wire.
 */

import type { Patch } from "./types.js";
import { MAX_FRAME_BYTES } from "./types.js";

/**
 * UTF-8 byte length, computed by hand.
 *
 * Hand-counted so `src/game/` stays free of Web/Node APIs (`TextEncoder`, `Buffer`).
 * `String.length` is wrong — it counts UTF-16 code units, so a map named "Ténèbres"
 * or any CJK label under-reports, and the relay counts BYTES.
 */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++; // surrogate pair consumes 2 UTF-16 code units for 1 codepoint
    } else {
      n += 3;
    }
  }
  return n;
}

/**
 * Bounds outbound broadcast frames against the server's 512 KiB ceiling.
 * Returns null if the frame exceeds MAX_FRAME_BYTES (400 KB).
 */
export function guardSize(patch: Patch, logError?: (message: string) => void): Patch | null {
  const bytes = utf8Length(JSON.stringify(patch));
  if (bytes > MAX_FRAME_BYTES) {
    if (logError) {
      logError(`patch ${patch.kind} is ${bytes} bytes — refusing to broadcast`);
    }
    return null;
  }
  return patch;
}
