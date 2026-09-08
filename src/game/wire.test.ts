import { describe, expect, it, vi } from "vitest";
import { guardSize, utf8Length } from "./wire";
import type { Patch } from "./types";
import { MAX_FRAME_BYTES } from "./types";

describe("utf8Length", () => {
  it("computes exact byte length for ASCII", () => {
    const s = "Hello, World! 12345";
    expect(utf8Length(s)).toBe(Buffer.byteLength(s, "utf8"));
  });

  it("computes exact byte length for accented Latin characters (2 bytes)", () => {
    const s = "Ténèbres dans la forêt";
    expect(utf8Length(s)).toBe(Buffer.byteLength(s, "utf8"));
    // String.length undercounts bytes here
    expect(s.length).toBeLessThan(utf8Length(s));
  });

  it("computes exact byte length for CJK text (3 bytes)", () => {
    const s = "ダンジョンズ&ドラゴンズ ダンジョンマスター";
    expect(utf8Length(s)).toBe(Buffer.byteLength(s, "utf8"));
  });

  it("computes exact byte length for surrogate pairs / emojis (4 bytes)", () => {
    const s = "🎲🐉🗺️⚔️🛡️✨";
    expect(utf8Length(s)).toBe(Buffer.byteLength(s, "utf8"));
  });

  it("handles empty string", () => {
    expect(utf8Length("")).toBe(0);
  });
});

describe("guardSize", () => {
  it("allows patches under MAX_FRAME_BYTES", () => {
    const patch: Patch = { kind: "activeMap", mapId: "map-1" };
    expect(guardSize(patch)).toEqual(patch);
  });

  it("rejects and logs patches over MAX_FRAME_BYTES", () => {
    const largeMask = "A".repeat(MAX_FRAME_BYTES + 100);
    const patch: Patch = { kind: "fog", mapId: "map-1", mask: largeMask };
    const logError = vi.fn();

    const result = guardSize(patch, logError);
    expect(result).toBeNull();
    expect(logError).toHaveBeenCalledOnce();
    expect(logError.mock.calls[0][0]).toContain("patch fog is");
    expect(logError.mock.calls[0][0]).toContain("refusing to broadcast");
  });
});
