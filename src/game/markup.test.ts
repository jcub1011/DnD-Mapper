import { describe, expect, it } from "vitest";
import { applyIntent, createState, validateMarkupSvg } from "./rules";
import { MatchView } from "./view";

const ROSTER = [
  { id: "dm-1", displayName: "Dungeon Master" },
  { id: "player-1", displayName: "Player One" },
];

describe("Markup Authority Rules & SVG Sanitization (Phase 10)", () => {
  const setupStateWithMap = () => {
    let state = createState(ROSTER);
    const createRes = applyIntent(state, "dm-1", { kind: "createMap", name: "Dungeon" }, 1000);
    expect(createRes).not.toBeNull();
    state = createRes!.state;
    const mapId = state.activeMapId!;
    return { state, mapId };
  };

  const VALID_SVG = `<g stroke="#c0392b" stroke-width="0.08" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <path d="M 12.5 8.2 Q 13.1 8.9 14.0 9.5" />
</g>`;

  it("updateMarkup applies SVG string to the specified map when requested by DM", () => {
    const { state, mapId } = setupStateWithMap();

    const res = applyIntent(
      state,
      "dm-1",
      {
        kind: "updateMarkup",
        mapId,
        markupSvg: VALID_SVG,
      },
      1100,
    );

    expect(res).not.toBeNull();
    expect(res!.patch).toEqual({
      kind: "markup",
      mapId,
      markupSvg: VALID_SVG,
    });
    const map = res!.state.maps.find((m) => m.id === mapId);
    expect("markupSvg" in map!).toBe(true);
    expect((map as { markupSvg: string | null }).markupSvg).toBe(VALID_SVG);
  });

  it("rejects updateMarkup if caller is not DM", () => {
    const { state, mapId } = setupStateWithMap();

    const res = applyIntent(
      state,
      "player-1",
      {
        kind: "updateMarkup",
        mapId,
        markupSvg: VALID_SVG,
      },
      1100,
    );

    expect(res).toBeNull();
  });

  it("rejects clearMarkup if caller is not DM", () => {
    const { state, mapId } = setupStateWithMap();

    const res = applyIntent(
      state,
      "player-1",
      {
        kind: "clearMarkup",
        mapId,
      },
      1100,
    );

    expect(res).toBeNull();
  });

  it("clearMarkup clears markupSvg to null", () => {
    const { state: initialState, mapId } = setupStateWithMap();
    const state = applyIntent(
      initialState,
      "dm-1",
      { kind: "updateMarkup", mapId, markupSvg: VALID_SVG },
      1100,
    )!.state;

    const clearRes = applyIntent(
      state,
      "dm-1",
      { kind: "clearMarkup", mapId },
      1200,
    );

    expect(clearRes).not.toBeNull();
    expect(clearRes!.patch).toEqual({
      kind: "markup",
      mapId,
      markupSvg: null,
    });
    const map = clearRes!.state.maps.find((m) => m.id === mapId);
    expect((map as { markupSvg: string | null }).markupSvg).toBeNull();
  });

  it("enforces 200 KB size ceiling guard on markupSvg", () => {
    const { state, mapId } = setupStateWithMap();
    const oversizedSvg = `<svg>` + "M 0 0 L 1 1 ".repeat(18000) + `</svg>`;
    expect(oversizedSvg.length).toBeGreaterThan(200_000);

    const res = applyIntent(
      state,
      "dm-1",
      {
        kind: "updateMarkup",
        mapId,
        markupSvg: oversizedSvg,
      },
      1100,
    );

    expect(res).toBeNull();
    expect(validateMarkupSvg(oversizedSvg)).toBe(false);
  });

  describe("validateMarkupSvg", () => {
    it("accepts valid SVG elements and harmless attributes", () => {
      expect(validateMarkupSvg(VALID_SVG)).toBe(true);
      expect(validateMarkupSvg("<svg><path d=\"M 0 0\" stroke=\"#000\" stroke-width=\"0.04\" /></svg>")).toBe(true);
      expect(validateMarkupSvg("<circle cx=\"10\" cy=\"10\" r=\"5\" fill=\"#fff\" />")).toBe(true);
      expect(validateMarkupSvg("<rect x=\"1\" y=\"2\" width=\"3\" height=\"4\" opacity=\"0.5\" />")).toBe(true);
    });

    it("rejects malicious SVG containing script tags", () => {
      expect(validateMarkupSvg("<svg><script>alert('xss')</script></svg>")).toBe(false);
      expect(validateMarkupSvg("<SCRIPT>fetch('evil.com')</SCRIPT>")).toBe(false);
    });

    it("rejects SVG containing event handlers (onload, onerror, onclick)", () => {
      expect(validateMarkupSvg("<svg onload=\"alert(1)\"></svg>")).toBe(false);
      expect(validateMarkupSvg("<circle r=\"5\" onclick=\"steal()\" />")).toBe(false);
      expect(validateMarkupSvg("<path d=\"M 0 0\" onerror=\"bad()\" />")).toBe(false);
    });

    it("rejects SVG with href / xlink:href / src attributes", () => {
      expect(validateMarkupSvg("<a href=\"javascript:alert(1)\">test</a>")).toBe(false);
      expect(validateMarkupSvg("<image xlink:href=\"evil.png\" />")).toBe(false);
      expect(validateMarkupSvg("<image src=\"evil.png\" />")).toBe(false);
    });

    it("rejects dangerous elements (foreignObject, iframe, embed, object, style)", () => {
      expect(validateMarkupSvg("<foreignObject><div>x</div></foreignObject>")).toBe(false);
      expect(validateMarkupSvg("<iframe src=\"evil.html\"></iframe>")).toBe(false);
      expect(validateMarkupSvg("<style>body { display: none; }</style>")).toBe(false);
      expect(validateMarkupSvg("<use xlink:href=\"#id\" />")).toBe(false);
    });

    it("rejects external resource url references", () => {
      expect(validateMarkupSvg("<path fill=\"url(https://evil.com/leak)\" />")).toBe(false);
    });

    it("rejects unbalanced or malformed tags", () => {
      expect(validateMarkupSvg("<svg><path d=\"M 0 0\"")).toBe(false);
    });
  });

  it("MatchView applies markup patch properly to active map", () => {
    const { state, mapId } = setupStateWithMap();
    const view = new MatchView();
    view.applySnapshot(state);

    view.applyPatch({
      kind: "markup",
      mapId,
      markupSvg: VALID_SVG,
    });

    const active = view.state.maps.find((m) => m.id === mapId);
    expect((active as { markupSvg: string | null }).markupSvg).toBe(VALID_SVG);
  });
});
