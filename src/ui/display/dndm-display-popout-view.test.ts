// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultDndMapperState,
  type GameMap,
  type RollResult,
  type Token,
} from "../../game/domain";
import type { MatchState } from "../../game/types";
import { fx } from "../fx/fx";
import type { MapScene } from "../map/MapScene";
import { DISPLAY_CHANNEL } from "./displayPopout";
import { DEFAULT_DISPLAY_SETTINGS, DISPLAY_SETTINGS_STORAGE_KEY } from "./displaySettings";
import "./dndm-display-popout-view";
import type { DndmDisplayPopoutView } from "./dndm-display-popout-view";

function makeFakeMap(): MapScene & Record<string, ReturnType<typeof vi.fn>> {
  const names = [
    "setDm",
    "setProjectorMode",
    "setViewOnly",
    "setRailInsets",
    "setViewerUserId",
    "setAssetSource",
    "setMap",
    "updateGrid",
    "updateTokens",
    "updateImages",
    "updateFog",
    "updateMarkup",
    "updateSheets",
    "setActiveTurnTokenId",
    "frameBox",
    "setGridSuppressed",
    "setOutsideMask",
    "setNavigationLocked",
  ];
  return Object.fromEntries(names.map((n) => [n, vi.fn()])) as unknown as MapScene &
    Record<string, ReturnType<typeof vi.fn>>;
}

function makeToken(id: string, x: number): Token {
  return {
    id,
    type: "NPCToken",
    ownerUserId: null,
    representsUserId: null,
    name: id,
    color: "#f00",
    iconKind: "Initial",
    mapId: "map-1",
    x,
    y: 1.5,
    sheetId: null,
    hidden: false,
  };
}

function makeRoll(id: string): RollResult {
  return {
    id,
    rollerUserId: "u1",
    forcedByUserId: null,
    rolls: [{ sides: 20, value: 11 }],
    total: 11,
    mode: "Normal",
    flatModifier: 0,
    attributeModifier: 0,
    label: "Check",
    timestampUtc: "2026-09-28T12:00:00.000Z",
    formula: "1d20",
    modifierBreakdown: "",
    tokenId: null,
    appliedRules: [],
  };
}

function makeState(tokens: Token[], focusRect: MatchState["focusRect"] = null): MatchState {
  const map: GameMap = {
    id: "map-1",
    name: "Dungeon",
    grid: {
      widthCells: 20,
      heightCells: 10,
      cellPixels: 50,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#000000",
    },
    images: [],
    tokens,
    createdUtc: new Date().toISOString(),
    listOrder: 0,
    defaultSpawnPosition: null,
    markupSvg: null,
    fogMask: "",
  };
  return {
    ...createDefaultDndMapperState(),
    phase: "Playing",
    maps: [map],
    activeMapId: "map-1",
    focusRect,
  };
}

describe("<dndm-display-popout-view>", () => {
  let opener: Window & { postMessage: ReturnType<typeof vi.fn> };
  let fakeMap: ReturnType<typeof makeFakeMap>;
  let view: DndmDisplayPopoutView;

  function deliver(data: unknown): void {
    window.dispatchEvent(
      new MessageEvent("message", { data, origin: window.location.origin, source: opener }),
    );
  }

  async function mount(): Promise<void> {
    view = document.createElement("dndm-display-popout-view") as DndmDisplayPopoutView;
    document.body.appendChild(view);
    await view.updateComplete;
  }

  function pushState(focus: MatchState["focusRect"] = null, rollLog: RollResult[] = []): void {
    deliver({
      channel: DISPLAY_CHANNEL,
      type: "display-state",
      state: { ...makeState([makeToken("tok-1", 1.5)], focus), rollLog },
      roster: [],
    });
  }

  function storeSettings(patch: Partial<typeof DEFAULT_DISPLAY_SETTINGS>): void {
    window.localStorage.setItem(
      DISPLAY_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_DISPLAY_SETTINGS, ...patch }),
    );
  }

  const focus = { mapId: "map-1", x: 2, y: 2, width: 4, height: 3 };

  beforeEach(() => {
    window.localStorage.clear();
    opener = { closed: false, postMessage: vi.fn() } as unknown as Window & {
      postMessage: ReturnType<typeof vi.fn>;
    };
    Object.defineProperty(window, "opener", { value: opener, configurable: true });
    fakeMap = makeFakeMap();
    vi.spyOn(fx, "map").mockReturnValue(fakeMap);
  });

  afterEach(() => {
    view?.remove();
    Object.defineProperty(window, "opener", { value: null, configurable: true });
    vi.restoreAllMocks();
  });

  it("joins its opener and waits for state", async () => {
    await mount();
    expect(opener.postMessage).toHaveBeenCalledWith(
      { channel: DISPLAY_CHANNEL, type: "display-join", hasState: false },
      window.location.origin,
    );
    expect(view.textContent).toContain("Waiting for the DM window");
  });

  it("explains itself when opened without the DM window", async () => {
    Object.defineProperty(window, "opener", { value: null, configurable: true });
    await mount();
    expect(view.textContent).toContain("Open the projector from the DM's window");
  });

  it("renders pushed state as a view-only projector", async () => {
    await mount();
    deliver({
      channel: DISPLAY_CHANNEL,
      type: "display-state",
      state: makeState([makeToken("tok-1", 1.5)]),
      roster: [],
    });
    await view.updateComplete;

    expect(view.textContent).not.toContain("Waiting");
    expect(fakeMap.setDm).toHaveBeenCalledWith(false);
    expect(fakeMap.setProjectorMode).toHaveBeenCalledWith(true);
    expect(fakeMap.setRailInsets).toHaveBeenCalledWith(0, 0);
    expect(fakeMap.setViewOnly).toHaveBeenCalledWith(true);
    expect(fakeMap.setMap).toHaveBeenCalledTimes(1);
    // No focus rect: frame the whole map.
    expect(fakeMap.frameBox).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 20, height: 10 },
      400,
      "fit",
    );
  });

  it("updates in place and re-frames only when the framing target changes", async () => {
    await mount();
    deliver({
      channel: DISPLAY_CHANNEL,
      type: "display-state",
      state: makeState([makeToken("tok-1", 1.5)]),
      roster: [],
    });
    // A token move: same map, same framing.
    deliver({
      channel: DISPLAY_CHANNEL,
      type: "display-state",
      state: makeState([makeToken("tok-1", 3.5)]),
      roster: [],
    });
    expect(fakeMap.setMap).toHaveBeenCalledTimes(1);
    expect(fakeMap.updateTokens).toHaveBeenCalled();
    expect(fakeMap.frameBox).toHaveBeenCalledTimes(1);

    // The DM sets a focus rect: the camera follows it.
    const focus = { mapId: "map-1", x: 2, y: 2, width: 4, height: 3 };
    deliver({
      channel: DISPLAY_CHANNEL,
      type: "display-state",
      state: makeState([makeToken("tok-1", 3.5)], focus),
      roster: [],
    });
    expect(fakeMap.frameBox).toHaveBeenLastCalledWith(focus, 400, "fit");
  });

  it("ignores messages that don't come from its opener", async () => {
    await mount();
    const stranger = { closed: false, postMessage: vi.fn() } as unknown as Window;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          channel: DISPLAY_CHANNEL,
          type: "display-state",
          state: makeState([]),
          roster: [],
        },
        origin: window.location.origin,
        source: stranger,
      }),
    );
    await view.updateComplete;
    expect(fakeMap.setMap).not.toHaveBeenCalled();
    expect(view.textContent).toContain("Waiting for the DM window");
  });

  it("locks manual navigation only while a focus box is set on the active map", async () => {
    await mount();
    pushState();
    expect(fakeMap.setNavigationLocked).toHaveBeenLastCalledWith(false);
    pushState(focus);
    expect(fakeMap.setNavigationLocked).toHaveBeenLastCalledWith(true);
    pushState({ ...focus, mapId: "other-map" });
    expect(fakeMap.setNavigationLocked).toHaveBeenLastCalledWith(false);
  });

  it("masks outside the focus box only when enabled and a box exists", async () => {
    storeSettings({ hideOutsideFocus: true });
    await mount();
    pushState();
    expect(fakeMap.setOutsideMask).toHaveBeenLastCalledWith(null);
    pushState(focus);
    expect(fakeMap.setOutsideMask).toHaveBeenLastCalledWith(focus);
  });

  it("re-frames with fill when the framing setting changes, and persists it", async () => {
    await mount();
    pushState(focus);
    await view.updateComplete;
    const fill = [...view.querySelectorAll<HTMLButtonElement>(".dndm-pillgroup button")].find(
      (b) => b.textContent?.trim() === "Fill",
    );
    fill!.click();
    expect(fakeMap.frameBox).toHaveBeenLastCalledWith(focus, 400, "fill");
    const stored = JSON.parse(window.localStorage.getItem(DISPLAY_SETTINGS_STORAGE_KEY)!);
    expect(stored.framing).toBe("fill");
  });

  it("suppresses the grid when the grid toggle is turned off", async () => {
    await mount();
    pushState();
    expect(fakeMap.setGridSuppressed).toHaveBeenLastCalledWith(false);
    await view.updateComplete;
    const input = view.querySelector<HTMLInputElement>('input[data-setting="showGrid"]')!;
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    expect(fakeMap.setGridSuppressed).toHaveBeenLastCalledWith(true);
  });

  it("blacks out the map when no focus box is set and showing without one is off", async () => {
    storeSettings({ showWithoutFocus: false });
    await mount();
    pushState();
    await view.updateComplete;
    expect(view.querySelector(".dndm-display-blank")?.textContent).toContain("No focus box set...");
    pushState(focus);
    await view.updateComplete;
    expect(view.querySelector(".dndm-display-blank")).toBeNull();
  });

  it("toggles the roll history panel and frames the map beside it", async () => {
    await mount();
    pushState(focus, [makeRoll("r1")]);
    await view.updateComplete;
    // Hidden by default.
    expect(view.querySelector("dndm-display-roll-history")).toBeNull();
    expect(fakeMap.setRailInsets).toHaveBeenLastCalledWith(0, 0);

    view.querySelector<HTMLButtonElement>(".dndm-display-corner button")!.click();
    await view.updateComplete;
    const panel = view.querySelector("dndm-display-roll-history");
    expect(panel).not.toBeNull();
    const width = panel!.widthPx;
    expect(width).toBeGreaterThan(0);
    // Panel sits on the left: the map frames into the space to its right.
    expect(fakeMap.setRailInsets).toHaveBeenLastCalledWith(width, 0);
    // The inset changes the visible area, so the focus box is re-framed.
    expect(fakeMap.frameBox).toHaveBeenCalledTimes(2);

    view.querySelector<HTMLButtonElement>(".dndm-display-corner button")!.click();
    await view.updateComplete;
    expect(view.querySelector("dndm-display-roll-history")).toBeNull();
    expect(fakeMap.setRailInsets).toHaveBeenLastCalledWith(0, 0);
  });

  it("reveals the controls near their edges and hides them when the pointer leaves", async () => {
    await mount();
    const bar = () => view.querySelector(".dndm-display-bar")!;
    const corner = () => view.querySelector(".dndm-display-corner")!;
    expect(bar().classList.contains("is-visible")).toBe(false);

    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 400, clientY: window.innerHeight - 10 }),
    );
    await view.updateComplete;
    expect(bar().classList.contains("is-visible")).toBe(true);
    expect(corner().classList.contains("is-visible")).toBe(false);

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 20, clientY: 20 }));
    await view.updateComplete;
    expect(bar().classList.contains("is-visible")).toBe(false);
    expect(corner().classList.contains("is-visible")).toBe(true);

    window.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null }));
    await view.updateComplete;
    expect(corner().classList.contains("is-visible")).toBe(false);
  });

  it("keeps the roll panel hidden until there is a roll to show", async () => {
    storeSettings({ showRollHistory: true });
    await mount();
    pushState(focus);
    await view.updateComplete;
    expect(view.querySelector("dndm-display-roll-history")).toBeNull();
    expect(fakeMap.setRailInsets).toHaveBeenLastCalledWith(0, 0);

    // A new roll is held back while its dice tumble; the panel appears once they settle.
    pushState(focus, [makeRoll("r1")]);
    await vi.waitFor(() => expect(view.querySelector("dndm-display-roll-history")).not.toBeNull());
    expect(fakeMap.setRailInsets).not.toHaveBeenLastCalledWith(0, 0);

    // The DM clears the log: the panel goes away again.
    pushState(focus);
    await view.updateComplete;
    expect(view.querySelector("dndm-display-roll-history")).toBeNull();
    expect(fakeMap.setRailInsets).toHaveBeenLastCalledWith(0, 0);
  });
});
