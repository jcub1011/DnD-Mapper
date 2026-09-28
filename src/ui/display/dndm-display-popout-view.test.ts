// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultDndMapperState, type GameMap, type Token } from "../../game/domain";
import type { MatchState } from "../../game/types";
import { fx } from "../fx/fx";
import type { MapScene } from "../map/MapScene";
import { DISPLAY_CHANNEL } from "./displayPopout";
import "./dndm-display-popout-view";
import type { DndmDisplayPopoutView } from "./dndm-display-popout-view";

function makeFakeMap(): MapScene & Record<string, ReturnType<typeof vi.fn>> {
  const names = [
    "setDm",
    "setProjectorMode",
    "setTokenMovePolicy",
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

  beforeEach(() => {
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
    const policy = vi.mocked(fakeMap.setTokenMovePolicy).mock.calls[0]?.[0] as (t: Token) => boolean;
    expect(policy(makeToken("tok-1", 1.5))).toBe(false);
    expect(fakeMap.setMap).toHaveBeenCalledTimes(1);
    // No focus rect: frame the whole map.
    expect(fakeMap.frameBox).toHaveBeenCalledWith({ x: 0, y: 0, width: 20, height: 10 }, 400);
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
    expect(fakeMap.frameBox).toHaveBeenLastCalledWith(focus, 400);
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
});
