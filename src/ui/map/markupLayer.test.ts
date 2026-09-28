// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { FALLBACK_MARKUP_COLOR, parseMarkupColor } from "./markupLayer";

describe("parseMarkupColor", () => {
  it("keeps black instead of falling back to red", () => {
    expect(parseMarkupColor("#000000")).toBe(0x000000);
    expect(parseMarkupColor("#000")).toBe(0x000000);
  });

  it("parses ordinary hex colors", () => {
    expect(parseMarkupColor("#c0392b")).toBe(0xc0392b);
    expect(parseMarkupColor("#ffffff")).toBe(0xffffff);
    expect(parseMarkupColor("#27ae60")).toBe(0x27ae60);
  });

  it("falls back only on genuinely unparseable input", () => {
    expect(parseMarkupColor("not-a-color")).toBe(FALLBACK_MARKUP_COLOR);
    expect(parseMarkupColor("")).toBe(FALLBACK_MARKUP_COLOR);
    expect(parseMarkupColor(null)).toBe(FALLBACK_MARKUP_COLOR);
    expect(parseMarkupColor(undefined)).toBe(FALLBACK_MARKUP_COLOR);
    expect(FALLBACK_MARKUP_COLOR).toBe(0xc0392b);
  });
});
