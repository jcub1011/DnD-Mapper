// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { GameMap, MapImage, Token } from "../../game/domain";
import "../canvas/dndm-toolbar";
import type { DndmToolbar } from "../canvas/dndm-toolbar";
import "../canvas/dndm-image-inspector";
import type { DndmImageInspector } from "../canvas/dndm-image-inspector";
import "../panels/dndm-map-list";
import type { DndmMapList } from "../panels/dndm-map-list";
import "../panels/dndm-token-panel";
import type { DndmTokenPanel } from "../panels/dndm-token-panel";
import "../panels/dndm-my-token";
import type { DndmMyToken } from "../panels/dndm-my-token";
import "../lobby/dndm-lobby";
import type { DndmLobby } from "../lobby/dndm-lobby";

function makeMap(id: string, name: string, tokens: readonly Token[] = []): GameMap {
  return {
    id,
    name,
    grid: {
      widthCells: 30,
      heightCells: 20,
      cellPixels: 50,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    },
    images: [],
    tokens,
    createdUtc: new Date().toISOString(),
    listOrder: 0,
    defaultSpawnPosition: null,
    markupSvg: null,
    fogMask: "",
  };
}

describe("UI Panels and Canvas Controls (07 — UI Shell)", () => {
  describe("<dndm-toolbar>", () => {
    it("fires zoom in, zoom out, and reset callbacks", async () => {
      const el = document.createElement("dndm-toolbar") as DndmToolbar;
      const onZoomIn = vi.fn();
      const onZoomOut = vi.fn();
      const onResetView = vi.fn();

      el.isDm = true;
      el.zoom = 1.0;
      el.onZoomIn = onZoomIn;
      el.onZoomOut = onZoomOut;
      el.onResetView = onResetView;

      document.body.appendChild(el);
      await el.updateComplete;

      const zoomInBtn = el.querySelector('button[title="Zoom in"]') as HTMLButtonElement;
      const zoomOutBtn = el.querySelector('button[title="Zoom out"]') as HTMLButtonElement;
      const resetBtn = el.querySelector('button[title="Reset view"]') as HTMLButtonElement;

      expect(zoomInBtn).not.toBeNull();
      expect(zoomOutBtn).not.toBeNull();
      expect(resetBtn).not.toBeNull();

      zoomInBtn.click();
      expect(onZoomIn).toHaveBeenCalledTimes(1);

      zoomOutBtn.click();
      expect(onZoomOut).toHaveBeenCalledTimes(1);

      resetBtn.click();
      expect(onResetView).toHaveBeenCalledTimes(1);

      el.remove();
    });

    it("switches tool modes (fog, focus, ruler)", async () => {
      const el = document.createElement("dndm-toolbar") as DndmToolbar;
      const onSetToolMode = vi.fn();

      el.isDm = true;
      el.toolMode = "none";
      el.onSetToolMode = onSetToolMode;

      document.body.appendChild(el);
      await el.updateComplete;

      const fogBtn = el.querySelector('button[title*="Paint fog"]') as HTMLButtonElement;
      const rulerBtn = el.querySelector('button[title*="Ruler"]') as HTMLButtonElement;
      const focusBtn = el.querySelector('button[title*="Focus box"]') as HTMLButtonElement;

      expect(fogBtn).not.toBeNull();
      expect(rulerBtn).not.toBeNull();
      expect(focusBtn).not.toBeNull();

      fogBtn.click();
      expect(onSetToolMode).toHaveBeenCalledWith("fog");

      rulerBtn.click();
      expect(onSetToolMode).toHaveBeenCalledWith("ruler");

      focusBtn.click();
      expect(onSetToolMode).toHaveBeenCalledWith("focus");

      el.remove();
    });

    it("hides DM-only buttons (fog, center everyone) for regular players", async () => {
      const el = document.createElement("dndm-toolbar") as DndmToolbar;
      el.isDm = false;

      document.body.appendChild(el);
      await el.updateComplete;

      const fogBtn = el.querySelector('button[title*="Paint fog"]');
      const centerAllBtn = el.querySelector('button[title*="Center all players"]');

      expect(fogBtn).toBeNull();
      expect(centerAllBtn).toBeNull();

      el.remove();
    });
  });

  describe("<dndm-map-list>", () => {
    it("renders map items and activates on click", async () => {
      const el = document.createElement("dndm-map-list") as DndmMapList;
      const map1 = makeMap("m1", "Dungeon");
      const map2 = makeMap("m2", "Town");
      const onSelectMap = vi.fn();

      el.maps = [map1, map2];
      el.activeMapId = "m1";
      el.onSelectMap = onSelectMap;

      document.body.appendChild(el);
      await el.updateComplete;

      const rows = el.querySelectorAll(".dndm-mapsw-row");
      expect(rows.length).toBe(2);
      expect(rows[0].classList.contains("dndm-mapsw-row--active")).toBe(true);
      expect(rows[1].classList.contains("dndm-mapsw-row--active")).toBe(false);

      (rows[1] as HTMLElement).click();
      expect(onSelectMap).toHaveBeenCalledWith("m2");

      el.remove();
    });

    it("triggers onCreateMap on plus button click", async () => {
      const el = document.createElement("dndm-map-list") as DndmMapList;
      const onCreateMap = vi.fn();
      el.maps = [];
      el.onCreateMap = onCreateMap;

      document.body.appendChild(el);
      await el.updateComplete;

      const addBtn = el.querySelector('header button[title="New map"]') as HTMLButtonElement;
      expect(addBtn).not.toBeNull();
      addBtn.click();

      expect(onCreateMap).toHaveBeenCalledTimes(1);
      el.remove();
    });
  });

  describe("<dndm-token-panel>", () => {
    it("renders tokens and forwards double-click / center event", async () => {
      const el = document.createElement("dndm-token-panel") as DndmTokenPanel;
      const token1: Token = {
        id: "t1",
        mapId: "m1",
        name: "Aragorn",
        color: "#1e88e5",
        type: "PlayerToken",
        iconKind: "Initial",
        x: 5,
        y: 8,
        hidden: false,
        ownerUserId: "u1",
        representsUserId: "u1",
        sheetId: null,
      };

      const map = makeMap("m1", "Dungeon", [token1]);

      const onCenterOnToken = vi.fn();
      const onToggleHidden = vi.fn();
      const onToggleIcon = vi.fn();

      el.activeMap = map;
      el.onCenterOnToken = onCenterOnToken;
      el.onToggleHidden = onToggleHidden;
      el.onToggleIcon = onToggleIcon;

      document.body.appendChild(el);
      await el.updateComplete;

      const item = el.querySelector(".dndm-tokenp-row") as HTMLElement;
      expect(item).not.toBeNull();
      expect(item.textContent).toContain("Aragorn");

      item.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(onCenterOnToken).toHaveBeenCalledWith(5, 8);

      const hideBtn = el.querySelector('button[title*="hide" i]') as HTMLButtonElement;
      expect(hideBtn).not.toBeNull();
      hideBtn.click();
      expect(onToggleHidden).toHaveBeenCalledWith("t1", true);

      el.remove();
    });
  });

  describe("<dndm-my-token>", () => {
    it("renders token details and lets player change color", async () => {
      const el = document.createElement("dndm-my-token") as DndmMyToken;
      const onChangeColor = vi.fn();

      el.token = {
        id: "t1",
        mapId: "m1",
        name: "Legolas",
        color: "#e53935",
        type: "PlayerToken",
        iconKind: "Initial",
        x: 2,
        y: 2,
        hidden: false,
        ownerUserId: "u1",
        representsUserId: "u1",
        sheetId: null,
      };
      el.onChangeColor = onChangeColor;

      document.body.appendChild(el);
      await el.updateComplete;

      expect(el.textContent).toContain("Legolas");

      const colorInput = el.querySelector('input[type="color"]') as HTMLInputElement;
      expect(colorInput).not.toBeNull();

      colorInput.value = "#43a047";
      colorInput.dispatchEvent(new Event("change"));

      expect(onChangeColor).toHaveBeenCalledTimes(1);
      expect(onChangeColor).toHaveBeenCalledWith("t1", "#43a047");

      el.remove();
    });
  });

  describe("<dndm-image-inspector>", () => {
    it("renders image inspector controls, lock toggle, and close", async () => {
      const el = document.createElement("dndm-image-inspector") as DndmImageInspector;
      const onSetLocked = vi.fn();
      const onClose = vi.fn();

      const image: MapImage = {
        id: "img1",
        name: "Floor Plan",
        contentType: "image/png",
        shareToken: null,
        x: 2,
        y: 4,
        width: 10,
        height: 8,
        originalWidth: 500,
        originalHeight: 400,
        rotation: 0,
        opacity: 1,
        layerOrder: 0,
        locked: false,
        hidden: false,
        byteSize: 1024,
        wasDownscaled: false,
        originalLongEdgePx: 500,
        displayLongEdgePx: 500,
      };

      el.image = image;
      el.maxLayerOrder = 2;
      el.onSetLocked = onSetLocked;
      el.onClose = onClose;

      document.body.appendChild(el);
      await el.updateComplete;

      expect(el.textContent).toContain("Image");

      const lockInput = el.querySelector('.dndm-imgi-lock input[type="checkbox"]') as HTMLInputElement;
      expect(lockInput).not.toBeNull();
      lockInput.checked = true;
      lockInput.dispatchEvent(new Event("change"));
      expect(onSetLocked).toHaveBeenCalledWith(true);

      const closeBtn = el.querySelector('button[title="Close inspector"]') as HTMLButtonElement;
      expect(closeBtn).not.toBeNull();
      closeBtn.click();
      expect(onClose).toHaveBeenCalledTimes(1);

      el.remove();
    });
  });

  describe("<dndm-lobby>", () => {
    it("renders player roster and restricts start session / kick to DM and owner", async () => {
      const el = document.createElement("dndm-lobby") as DndmLobby;
      const onStartSession = vi.fn();
      const onKickPlayer = vi.fn();

      el.isDm = true;
      el.isOwner = true;
      el.localPlayerId = "p1";
      el.roster = [
        { id: "p1", displayName: "Dungeon Master" },
        { id: "p2", displayName: "Gimli" },
      ];
      el.onStartSession = onStartSession;
      el.onKickPlayer = onKickPlayer;

      document.body.appendChild(el);
      await el.updateComplete;

      // 1. DM sees Start Session button enabled
      const startBtn = el.querySelector("button.dndm-btn--primary") as HTMLButtonElement;
      expect(startBtn).not.toBeNull();
      expect(startBtn.textContent?.trim()).toBe("Start Session");

      startBtn.click();
      expect(onStartSession).toHaveBeenCalledTimes(1);

      // 2. Owner sees kick button for other player p2
      const kickBtn = el.querySelector("button.player-chip") as HTMLButtonElement;
      expect(kickBtn).not.toBeNull();
      expect(kickBtn.textContent).toContain("Gimli");

      kickBtn.click();
      expect(onKickPlayer).toHaveBeenCalledWith("p2");

      el.remove();
    });

    it("disables start session for regular players", async () => {
      const el = document.createElement("dndm-lobby") as DndmLobby;
      el.isDm = false;
      el.isOwner = false;
      el.localPlayerId = "p2";
      el.roster = [
        { id: "p1", displayName: "Dungeon Master" },
        { id: "p2", displayName: "Gimli" },
      ];

      document.body.appendChild(el);
      await el.updateComplete;

      // Regular players do not see the Start Session button; they see the waiting message
      const startBtn = el.querySelector("button.dndm-btn--primary");
      expect(startBtn).toBeNull();
      expect(el.textContent).toContain("Waiting for DM to start session…");

      // Player p2 cannot kick DM p1 (DM is rendered as span, not button)
      const kickButtons = el.querySelectorAll("button.player-chip");
      expect(kickButtons.length).toBe(0);

      el.remove();
    });
  });
});
