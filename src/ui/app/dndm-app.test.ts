// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../game/emitter";
import { createDefaultDndMapperState, type GameMap } from "../../game/domain";
import type { ControllerEvents, GameController } from "../../net/controller";
import type { MatchState } from "../../game/types";
import type { KBPlayer } from "../../../addons/knockbox/knockbox-phaser";
import "./dndm-app";
import type { DndmApp } from "./dndm-app";
import { fx } from "../fx/fx";
import type { MapScene } from "../map/MapScene";
import { LibraryService } from "../../storage/libraryService";
import type { DndmConfirm } from "../modals/dndm-confirm";

function createMockController(options: {
  playerId?: string;
  isOwner?: boolean;
  state?: Partial<MatchState>;
}): GameController & { mockSendIntent: ReturnType<typeof vi.fn> } {
  const events = new Emitter<ControllerEvents>();
  const mockSendIntent = vi.fn();
  const mockSetLobbyOpen = vi.fn();
  const mockKickPlayer = vi.fn();
  const mockDestroy = vi.fn();

  const defaultState = createDefaultDndMapperState();
  const state: MatchState = {
    ...defaultState,
    ...options.state,
  };

  return {
    playerId: options.playerId ?? "dm-user",
    isOwner: options.isOwner ?? true,
    view: { state },
    events,
    sendIntent: mockSendIntent,
    setLobbyOpen: mockSetLobbyOpen,
    kickPlayer: mockKickPlayer,
    destroy: mockDestroy,
    mockSendIntent,
  };
}

function makeMap(id: string, name: string): GameMap {
  return {
    id,
    name,
    grid: {
      widthCells: 20,
      heightCells: 20,
      cellPixels: 50,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#000000",
    },
    images: [],
    tokens: [],
    createdUtc: new Date().toISOString(),
    listOrder: 0,
    defaultSpawnPosition: null,
    markupSvg: null,
    fogMask: "",
  };
}

describe("<dndm-app> Application Shell", () => {
  let app: DndmApp;

  beforeEach(() => {
    window.sessionStorage.clear();
    app = document.createElement("dndm-app") as DndmApp;
    document.body.appendChild(app);
  });

  afterEach(() => {
    app.remove();
    window.sessionStorage.clear();
  });

  describe("Phase Switching", () => {
    it("renders <dndm-lobby> in Lobby phase", async () => {
      const controller = createMockController({
        state: { phase: "Lobby" },
      });
      app.attach(controller);
      await app.updateComplete;

      const lobby = app.querySelector("dndm-lobby");
      expect(lobby).not.toBeNull();
      expect(app.querySelector(".dnd-mapper-playing")).toBeNull();
    });

    it("renders playing layout in Playing phase", async () => {
      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      const lobby = app.querySelector("dndm-lobby");
      expect(lobby).toBeNull();
      const playing = app.querySelector(".dnd-mapper-playing");
      expect(playing).not.toBeNull();
    });
  });

  describe("DM vs Player Rail Gating", () => {
    it("renders left rail for the DM/Owner", async () => {
      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
          dmPlayerId: "dm-user",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      expect(app.isDm).toBe(true);
      const leftRail = app.querySelector(".dndm-rail--left");
      expect(leftRail).not.toBeNull();
      const playingEl = app.querySelector(".dnd-mapper-playing");
      expect(playingEl?.classList.contains("dnd-mapper-playing--host")).toBe(true);
    });

    it("does NOT render left rail for regular players", async () => {
      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        playerId: "player-2",
        isOwner: false,
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
          dmPlayerId: "dm-user",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      expect(app.isDm).toBe(false);
      const leftRail = app.querySelector(".dndm-rail--left");
      expect(leftRail).toBeNull();
      const playingEl = app.querySelector(".dnd-mapper-playing");
      expect(playingEl?.classList.contains("dnd-mapper-playing--host")).toBe(false);

      // Player gets my-token panel in right rail
      const myTokenPanel = app.querySelector("dndm-my-token");
      expect(myTokenPanel).not.toBeNull();
    });

    it("reacts dynamically to roster ownership transfer", async () => {
      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        playerId: "user-bob",
        isOwner: false,
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
          dmPlayerId: null, // ownership determines DM
        },
      });
      app.attach(controller);
      await app.updateComplete;

      expect(app.isDm).toBe(false);
      expect(app.querySelector(".dndm-rail--left")).toBeNull();

      // Emit roster event transferring ownership to user-bob
      const updatedRoster: readonly KBPlayer[] = [{ id: "user-bob", displayName: "Bob" }];
      controller.events.emit("roster", {
        players: updatedRoster,
        ownerId: "user-bob",
        isOwner: true,
      });

      await app.updateComplete;
      expect(app.isDm).toBe(true);
      expect(app.querySelector(".dndm-rail--left")).not.toBeNull();
    });
  });

  describe("Rail Resizing & SessionStorage Persistence", () => {
    it("clamps rail width between 200px and 600px and saves to sessionStorage on drag", async () => {
      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
          dmPlayerId: "dm-user",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      const rightHandle = app.querySelector(".dndm-rail-resize--right") as HTMLElement;
      expect(rightHandle).not.toBeNull();

      // 1. Simulate drag to expand right rail: start at 500, move left by 100 -> delta = +100 -> 320 + 100 = 420
      rightHandle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 500, button: 0, bubbles: true }),
      );
      rightHandle.dispatchEvent(new PointerEvent("pointermove", { clientX: 400, bubbles: true }));
      rightHandle.dispatchEvent(new PointerEvent("pointerup", { clientX: 400, bubbles: true }));

      await app.updateComplete;
      expect(window.sessionStorage.getItem("dndm.rail.dm.right")).toBe("420");
      expect(app.style.getPropertyValue("--dndm-rail-w-right")).toBe("420px");

      // 2. Simulate drag exceeding max 600px: start at 500, move left by 400 -> 420 + 400 = 820 -> clamped to 600
      rightHandle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 500, button: 0, bubbles: true }),
      );
      rightHandle.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, bubbles: true }));
      rightHandle.dispatchEvent(new PointerEvent("pointerup", { clientX: 100, bubbles: true }));

      await app.updateComplete;
      expect(window.sessionStorage.getItem("dndm.rail.dm.right")).toBe("600");
      expect(app.style.getPropertyValue("--dndm-rail-w-right")).toBe("600px");

      // 3. Simulate drag below min 200px (above collapse threshold 140px): move right by 420 -> 600 - 420 = 180 -> clamped to 200
      rightHandle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 500, button: 0, bubbles: true }),
      );
      rightHandle.dispatchEvent(new PointerEvent("pointermove", { clientX: 920, bubbles: true }));
      rightHandle.dispatchEvent(new PointerEvent("pointerup", { clientX: 920, bubbles: true }));

      await app.updateComplete;
      expect(window.sessionStorage.getItem("dndm.rail.dm.right")).toBe("200");
      expect(app.style.getPropertyValue("--dndm-rail-w-right")).toBe("200px");

      // 4. Simulate drag below collapse threshold (<140px): auto-collapses and preserves starting width (200)
      rightHandle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 500, button: 0, bubbles: true }),
      );
      rightHandle.dispatchEvent(new PointerEvent("pointermove", { clientX: 1000, bubbles: true }));
      rightHandle.dispatchEvent(new PointerEvent("pointerup", { clientX: 1000, bubbles: true }));

      await app.updateComplete;
      const playingEl = app.querySelector(".dnd-mapper-playing");
      expect(playingEl?.classList.contains("dnd-mapper-playing--right-collapsed")).toBe(true);
      // Persisted width remembers where pointer started (200), avoiding uncollapsing to narrowest width
      expect(window.sessionStorage.getItem("dndm.rail.dm.right")).toBe("200");
      expect(app.style.getPropertyValue("--dndm-rail-w-right")).toBe("200px");

      // 5. Uncollapsing restores back to the drag start width (200px)
      rightHandle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 500, button: 0, bubbles: true }),
      );
      rightHandle.dispatchEvent(new PointerEvent("pointerup", { clientX: 500, bubbles: true }));
      await app.updateComplete;
      expect(playingEl?.classList.contains("dnd-mapper-playing--right-collapsed")).toBe(false);
      expect(app.style.getPropertyValue("--dndm-rail-w-right")).toBe("200px");
    });

    it("restores previously saved rail widths from sessionStorage on attach", async () => {
      window.sessionStorage.setItem("dndm.rail.dm.left", "380");
      window.sessionStorage.setItem("dndm.rail.dm.right", "440");

      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      expect(app.style.getPropertyValue("--dndm-rail-w-left")).toBe("380px");
      expect(app.style.getPropertyValue("--dndm-rail-w-right")).toBe("440px");
    });

    it("toggles rail collapse on click without drag (<4px threshold)", async () => {
      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      const leftHandle = app.querySelector(".dndm-rail-resize--left") as HTMLElement;
      expect(leftHandle).not.toBeNull();

      // Click with 2px jitter (<4px threshold)
      leftHandle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 200, button: 0, bubbles: true }),
      );
      leftHandle.dispatchEvent(new PointerEvent("pointermove", { clientX: 202, bubbles: true }));
      leftHandle.dispatchEvent(new PointerEvent("pointerup", { clientX: 202, bubbles: true }));

      await app.updateComplete;
      const playingEl = app.querySelector(".dnd-mapper-playing");
      expect(playingEl?.classList.contains("dnd-mapper-playing--left-collapsed")).toBe(true);

      // Click again collapses/expands back
      leftHandle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 200, button: 0, bubbles: true }),
      );
      leftHandle.dispatchEvent(new PointerEvent("pointerup", { clientX: 200, bubbles: true }));

      await app.updateComplete;
      expect(playingEl?.classList.contains("dnd-mapper-playing--left-collapsed")).toBe(false);
    });

    it("uncollapses and resizes when dragging outward past threshold from collapsed state", async () => {
      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      const leftHandle = app.querySelector(".dndm-rail-resize--left") as HTMLElement;
      const playingEl = app.querySelector(".dnd-mapper-playing");

      // First, collapse the rail
      leftHandle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 200, button: 0, bubbles: true }),
      );
      leftHandle.dispatchEvent(new PointerEvent("pointerup", { clientX: 200, bubbles: true }));
      await app.updateComplete;
      expect(playingEl?.classList.contains("dnd-mapper-playing--left-collapsed")).toBe(true);

      // Drag outward from collapsed state past threshold: start at 28px, drag right by 250px
      leftHandle.dispatchEvent(
        new PointerEvent("pointerdown", { clientX: 28, button: 0, bubbles: true }),
      );
      leftHandle.dispatchEvent(new PointerEvent("pointermove", { clientX: 278, bubbles: true }));
      leftHandle.dispatchEvent(new PointerEvent("pointerup", { clientX: 278, bubbles: true }));

      await app.updateComplete;
      expect(playingEl?.classList.contains("dnd-mapper-playing--left-collapsed")).toBe(false);
      expect(window.sessionStorage.getItem("dndm.rail.dm.left")).toBe("250");
      expect(app.style.getPropertyValue("--dndm-rail-w-left")).toBe("250px");
    });
  });

  describe("Global Panel Collapse", () => {
    it("collapses panel on header click but ignores clicks on buttons inside header", async () => {
      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      const mapList = app.querySelector("dndm-map-list");
      expect(mapList).not.toBeNull();

      const panel = mapList?.querySelector(".dndm-panel") as HTMLElement;
      const header = mapList?.querySelector(".dndm-panel-header") as HTMLElement;
      const titleSpan = header?.querySelector("span") as HTMLElement;
      const createButton = header?.querySelector("button") as HTMLElement;

      expect(panel).not.toBeNull();
      expect(header).not.toBeNull();
      expect(titleSpan).not.toBeNull();
      expect(createButton).not.toBeNull();

      // 1. Click on header title text -> toggles .dndm-panel--collapsed
      titleSpan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(panel.classList.contains("dndm-panel--collapsed")).toBe(true);

      titleSpan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(panel.classList.contains("dndm-panel--collapsed")).toBe(false);

      // 2. Click on the '+' button inside header -> MUST NOT toggle collapsed
      createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(panel.classList.contains("dndm-panel--collapsed")).toBe(false);
    });

    it("renders settings button in session panel header and upload button in map layers panel header", async () => {
      const map1 = makeMap("map-1", "Dungeon");
      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: {
          phase: "Playing",
          maps: [map1],
          activeMapId: "map-1",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      // 1. Session panel header contains the Settings button
      const sessionPanel = app.querySelector(".dndm-session-panel") as HTMLElement;
      expect(sessionPanel).not.toBeNull();
      const sessionHeader = sessionPanel.querySelector(".dndm-panel-header") as HTMLElement;
      expect(sessionHeader).not.toBeNull();
      const settingsBtn = sessionHeader.querySelector('button[title="Session Settings"]') as HTMLButtonElement;
      expect(settingsBtn).not.toBeNull();

      // Clicking settings button opens settings modal without collapsing session panel
      settingsBtn.click();
      await app.updateComplete;
      expect(sessionPanel.classList.contains("dndm-panel--collapsed")).toBe(false);

      // 2. Map layers panel header contains the upload button
      const layerPanel = app.querySelector("dndm-layer-panel") as HTMLElement;
      expect(layerPanel).not.toBeNull();
      const layerHeader = layerPanel.querySelector(".dndm-panel-header") as HTMLElement;
      expect(layerHeader).not.toBeNull();
      const uploadComponent = layerHeader.querySelector("dndm-image-upload");
      expect(uploadComponent).not.toBeNull();
      const uploadBtn = uploadComponent?.querySelector('label[aria-label="Upload images"]');
      expect(uploadBtn).not.toBeNull();
    });
  });

  describe("Auto-save restore prompt", () => {
    function findRestorePrompt(): DndmConfirm | null {
      // Other panels (map list, saves, …) render their own dndm-confirms, so
      // scope by title instead of matching the first confirm in the DOM.
      const confirms = [...app.querySelectorAll("dndm-confirm")] as DndmConfirm[];
      return confirms.find((c) => c.modalTitle === "Restore auto-save?") ?? null;
    }
    async function seedAutoSave(): Promise<void> {
      const seeder = new LibraryService(10);
      await seeder.attach();
      const seedState: MatchState = {
        ...createDefaultDndMapperState("dm-user"),
        phase: "Playing",
        maps: [makeMap("saved-1", "Saved Dungeon")],
        activeMapId: "saved-1",
      };
      await seeder.flushAutoSave(seedState);
      await seeder.detach();
    }

    afterEach(async () => {
      // Scrub the seeded auto-save shards so later tests start clean. Each
      // test re-seeds deterministically; the app's own instance only reads.
      const scrubber = new LibraryService(10);
      await scrubber.attach();
      const db = (scrubber as unknown as { db: IDBDatabase }).db;
      const { STORE_LIBRARY } = await import("../../storage/schema");
      const { deleteBatch } = await import("../../storage/db");
      const keys = await new Promise<string[]>((resolve, reject) => {
        try {
          const tx = db.transaction(STORE_LIBRARY, "readonly");
          const req = tx.objectStore(STORE_LIBRARY).getAllKeys();
          req.onsuccess = () => resolve((req.result as string[]).map(String));
          req.onerror = () => reject(req.error);
        } catch (err) {
          reject(err);
        }
      });
      await deleteBatch(
        db,
        STORE_LIBRARY,
        keys.filter((k) => k.startsWith("__auto__")),
      );
      await scrubber.detach();
    });

    it("offers the auto-save after the lobby starts when the boot began empty", async () => {
      await seedAutoSave();

      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: { phase: "Lobby", dmPlayerId: "dm-user" },
      });
      app.attach(controller);
      await app.updateComplete;

      // Boot in the lobby: no prompt yet.
      controller.events.emit("roster", {
        players: [{ id: "dm-user", displayName: "DM" }],
        ownerId: "dm-user",
        isOwner: true,
      });
      controller.events.emit("changed", { state: controller.view.state });
      await app.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await app.updateComplete;
      expect(app.querySelector("dndm-lobby")).not.toBeNull();
      expect(findRestorePrompt()).toBeNull();

      // Lobby starts (still an empty campaign): the prompt appears.
      controller.events.emit("changed", {
        state: { ...controller.view.state, phase: "Playing" },
      });
      await app.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await app.updateComplete;

      const confirm = findRestorePrompt();
      expect(confirm).not.toBeNull();
      expect(confirm?.isOpen).toBe(true);
    });

    it("never prompts when the first snapshot already has campaign content", async () => {
      await seedAutoSave();

      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: {
          phase: "Playing",
          maps: [makeMap("room-1", "Room Map")],
          activeMapId: "room-1",
          dmPlayerId: "dm-user",
        },
      });
      app.attach(controller);
      await app.updateComplete;

      controller.events.emit("roster", {
        players: [{ id: "dm-user", displayName: "DM" }],
        ownerId: "dm-user",
        isOwner: true,
      });
      controller.events.emit("changed", { state: controller.view.state });
      await app.updateComplete;
      await new Promise((r) => setTimeout(r, 50));
      await app.updateComplete;

      // The prompt element exists in the Playing shell but stays closed.
      expect(findRestorePrompt()?.isOpen).toBe(false);
    });

    it("a boot-time empty lobby flush never wipes a populated auto-save", async () => {
      await seedAutoSave();

      // Fresh boot: roster ownership resolves, then the empty lobby snapshot
      // arrives while already counting as DM state. The debounced flush of
      // that empty state must not clobber the seeded campaign.
      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: { phase: "Lobby", dmPlayerId: "dm-user" },
      });
      app.attach(controller);
      await app.updateComplete;

      controller.events.emit("roster", {
        players: [{ id: "dm-user", displayName: "DM" }],
        ownerId: "dm-user",
        isOwner: true,
      });
      controller.events.emit("changed", { state: controller.view.state });
      await app.updateComplete;

      // Past the 500 ms auto-save debounce: the empty flush has fired (and
      // must have been refused by the refresh-wipe guard).
      await new Promise((r) => setTimeout(r, 800));
      await app.updateComplete;

      const reader = new LibraryService(10);
      await reader.attach();
      try {
        const loaded = await reader.loadSlot("__auto__");
        expect(loaded).not.toBeNull();
        expect(loaded!.maps.map((m) => m.name)).toContain("Saved Dungeon");
      } finally {
        await reader.detach();
      }
    });

    it("auto-saves live DM edits to the __auto__ slot after the debounce", async () => {
      const controller = createMockController({
        playerId: "dm-user",
        isOwner: true,
        state: { phase: "Lobby", dmPlayerId: "dm-user" },
      });
      app.attach(controller);
      await app.updateComplete;

      controller.events.emit("roster", {
        players: [{ id: "dm-user", displayName: "DM" }],
        ownerId: "dm-user",
        isOwner: true,
      });
      // DM creates a map: new state object, as the authority would publish.
      const liveWithMap: MatchState = {
        ...controller.view.state,
        phase: "Playing",
        maps: [makeMap("live-1", "Live Dungeon")],
        activeMapId: "live-1",
      };
      controller.events.emit("changed", { state: liveWithMap });
      await app.updateComplete;

      // Scrub any prompt candidacy: this test is about the write path.
      // Wait past the 500 ms debounce for the flush to land.
      await new Promise((r) => setTimeout(r, 800));
      await app.updateComplete;

      const reader = new LibraryService(10);
      await reader.attach();
      try {
        const loaded = await reader.loadSlot("__auto__");
        expect(loaded).not.toBeNull();
        expect(loaded!.maps.map((m) => m.name)).toContain("Live Dungeon");
      } finally {
        await reader.detach();
      }
    });
  });

  describe("Deferred MapScene wiring", () => {
    function makeFakeMap(): MapScene & Record<string, unknown> {
      return {
        setDm: vi.fn(),
        setAssetSource: vi.fn(),
        setTokenMovePolicy: vi.fn(),
        setMap: vi.fn(),
        updateSheets: vi.fn(),
        setActiveTurnTokenId: vi.fn(),
        setFocusRect: vi.fn(),
        setRailInsets: vi.fn(),
        setProjectorMode: vi.fn(),
        updateGrid: vi.fn(),
        updateTokens: vi.fn(),
        updateImages: vi.fn(),
        updateFog: vi.fn(),
        updateMarkup: vi.fn(),
      } as unknown as MapScene & Record<string, unknown>;
    }

    it("wires canvas callbacks and pushes rail insets once the map boots after attach", async () => {
      const mapSpy = vi.spyOn(fx, "map");
      try {
        // Phaser hasn't booted when attach() runs: wiring must not crash.
        mapSpy.mockReturnValue(undefined);
        const map1 = makeMap("map-1", "Dungeon");
        const controller = createMockController({
          playerId: "user-bob",
          isOwner: false,
          state: {
            phase: "Playing",
            maps: [map1],
            activeMapId: "map-1",
            dmPlayerId: "dm-user",
          },
        });
        app.attach(controller);
        await app.updateComplete;

        // Map boots later; the next state change picks up the wiring.
        const fakeMap = makeFakeMap();
        mapSpy.mockReturnValue(fakeMap);
        controller.events.emit("changed", { state: controller.view.state });
        await app.updateComplete;

        expect(typeof fakeMap.onTokenMoveEnd).toBe("function");
        // Player has no left rail; right rail open at the default 320px.
        expect(fakeMap.setRailInsets).toHaveBeenCalledWith(0, 320);

        // A canvas drag now produces a moveToken intent for the authority.
        (fakeMap.onTokenMoveEnd as (e: unknown) => void)({
          tokenId: "tok-1",
          x: 5.5,
          y: 5.5,
        });
        expect(controller.mockSendIntent).toHaveBeenCalledWith({
          kind: "moveToken",
          tokenId: "tok-1",
          x: 5.5,
          y: 5.5,
        });
      } finally {
        mapSpy.mockRestore();
      }
    });
  });
});
