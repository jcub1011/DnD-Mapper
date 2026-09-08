/*
 * Wire guardrails and length calculation.
 *
 * Hand-computed UTF-8 byte counting without DOM globals (TextEncoder) or Node buffers.
 * Runs in the bare Jint sandbox and in tests.
 */

import type { Patch } from "./types.js";
import { MAX_FRAME_BYTES } from "./types.js";

/**
 * UTF-8 byte length, computed by hand.
 *
 * `TextEncoder` is a Web API, not ECMAScript: the Jint sandbox does not provide it, and
 * eslint.config.js bans DOM globals in `src/game/` and `src/authority/` anyway. `String.length`
 * is wrong in the other direction — it counts UTF-16 code units, so a map named "Ténèbres"
 * or any CJK label under-reports, and the server counts BYTES.
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
