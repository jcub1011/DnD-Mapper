// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DndMapperState } from "../../game/domain.js";
import { createDefaultDndMapperState } from "../../game/domain.js";
import "../panels/dndm-quick-roll-footer.js";
import type { DndmQuickRollFooter } from "../panels/dndm-quick-roll-footer.js";
import "../panels/dndm-roll-log.js";
import type { DndmRollLog } from "../panels/dndm-roll-log.js";
import "../modals/dndm-roll-history.js";
import type { DndmRollHistory } from "../modals/dndm-roll-history.js";
import { diceAnimationTracker } from "./diceAnimationTracker.js";

describe("Dice UI Components", () => {
  let state: DndMapperState;

  beforeEach(() => {
    diceAnimationTracker.clearAll();
    state = {
      ...createDefaultDndMapperState(),
      rollLog: [
        {
          id: "r-nat20",
          rollerUserId: "player-1",
          forcedByUserId: null,
          rolls: [{ sides: 20, value: 20 }],
          total: 20,
          mode: "Normal",
          flatModifier: 0,
          attributeModifier: 0,
          label: "Attack",
          timestampUtc: "2026-09-09T12:00:00.000Z",
          formula: "1d20",
          modifierBreakdown: "",
          tokenId: null,
          appliedRules: [],
        },
        {
          id: "r-nat1",
          rollerUserId: "player-2",
          forcedByUserId: null,
          rolls: [{ sides: 20, value: 1 }],
          total: 1,
          mode: "Normal",
          flatModifier: 0,
          attributeModifier: 0,
          label: "Save",
          timestampUtc: "2026-09-09T12:01:00.000Z",
          formula: "1d20",
          modifierBreakdown: "",
          tokenId: null,
          appliedRules: [],
        },
      ],
    };
  });

  describe("<dndm-quick-roll-footer>", () => {
    it("renders polyhedral dice and dispatches onRollDice on click", async () => {
      const footer = document.createElement("dndm-quick-roll-footer") as DndmQuickRollFooter;
      footer.state = state;
      const onRollDice = vi.fn();
      footer.onRollDice = onRollDice;
      document.body.appendChild(footer);
      await footer.updateComplete;

      const d20Btn = Array.from(footer.renderRoot.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent?.trim() === "d20",
      );
      expect(d20Btn).toBeDefined();

      d20Btn!.click();
      expect(onRollDice).toHaveBeenCalledWith("1d20", "Normal", "d20 Roll", null, null);

      footer.remove();
    });

    it("triggers Advantage with Shift-click and Disadvantage with Ctrl-click", async () => {
      const footer = document.createElement("dndm-quick-roll-footer") as DndmQuickRollFooter;
      footer.state = state;
      const onRollDice = vi.fn();
      footer.onRollDice = onRollDice;
      document.body.appendChild(footer);
      await footer.updateComplete;

      const d20Btn = Array.from(footer.renderRoot.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent?.trim() === "d20",
      );

      // Shift-click -> Advantage
      d20Btn!.dispatchEvent(
        new MouseEvent("click", { shiftKey: true, bubbles: true, composed: true }),
      );
      expect(onRollDice).toHaveBeenLastCalledWith("1d20", "Advantage", "d20 Roll", null, null);

      // Ctrl-click -> Disadvantage
      d20Btn!.dispatchEvent(
        new MouseEvent("click", { ctrlKey: true, bubbles: true, composed: true }),
      );
      expect(onRollDice).toHaveBeenLastCalledWith("1d20", "Disadvantage", "d20 Roll", null, null);

      footer.remove();
    });

    it("renders dice size selector in options popover and triggers onChangeDiceScale", async () => {
      const footer = document.createElement("dndm-quick-roll-footer") as DndmQuickRollFooter;
      footer.state = state;
      footer.diceScale = 75;
      const onChangeDiceScale = vi.fn();
      footer.onChangeDiceScale = onChangeDiceScale;
      document.body.appendChild(footer);
      await footer.updateComplete;

      // Click gear button to open popover
      const gearBtn = footer.renderRoot.querySelector<HTMLButtonElement>(".dndm-rollfooter__gear");
      expect(gearBtn).not.toBeNull();
      gearBtn!.click();
      await footer.updateComplete;

      const sizeChips = Array.from(
        footer.renderRoot.querySelectorAll<HTMLButtonElement>(".dndm-rollfooter__size-chip"),
      );
      expect(sizeChips).toHaveLength(4);
      expect(sizeChips.map((c) => c.textContent?.trim())).toEqual(["50%", "75%", "100%", "125%"]);

      // 75% chip should be active
      const activeChip = footer.renderRoot.querySelector<HTMLButtonElement>(
        ".dndm-rollfooter__size-chip--active",
      );
      expect(activeChip?.textContent?.trim()).toBe("75%");

      // Click 100% chip
      const chip100 = sizeChips.find((c) => c.textContent?.trim() === "100%");
      expect(chip100).toBeDefined();
      chip100!.click();
      expect(onChangeDiceScale).toHaveBeenCalledWith(100);

      // Click 50% chip
      const chip50 = sizeChips.find((c) => c.textContent?.trim() === "50%");
      expect(chip50).toBeDefined();
      chip50!.click();
      expect(onChangeDiceScale).toHaveBeenCalledWith(50);

      footer.remove();
    });
  });

  describe("<dndm-roll-log>", () => {
    it("renders Nat 20 and Nat 1 with distinct CSS classes and hides animating rolls", async () => {
      const logPanel = document.createElement("dndm-roll-log") as DndmRollLog;
      logPanel.state = state;
      logPanel.isDm = true;
      document.body.appendChild(logPanel);
      await logPanel.updateComplete;

      let entries = logPanel.renderRoot.querySelectorAll(".dndm-rolllog-entry");
      expect(entries).toHaveLength(2);

      const nat20Entry = logPanel.renderRoot.querySelector(".dndm-rolllog-entry--nat20");
      const nat1Entry = logPanel.renderRoot.querySelector(".dndm-rolllog-entry--nat1");
      expect(nat20Entry).not.toBeNull();
      expect(nat1Entry).not.toBeNull();

      // Start animating r-nat20 -> should be hidden from roll log until settled
      diceAnimationTracker.start("r-nat20");
      await logPanel.updateComplete;

      entries = logPanel.renderRoot.querySelectorAll(".dndm-rolllog-entry");
      expect(entries).toHaveLength(1);

      // Settle r-nat20 -> should reappear
      diceAnimationTracker.settle("r-nat20");
      await logPanel.updateComplete;

      entries = logPanel.renderRoot.querySelectorAll(".dndm-rolllog-entry");
      expect(entries).toHaveLength(2);

      logPanel.remove();
    });
  });

  describe("<dndm-roll-history>", () => {
    it("renders modal dialog and filters by search query", async () => {
      const history = document.createElement("dndm-roll-history") as DndmRollHistory;
      history.state = state;
      history.isDm = true;
      history.isOpen = true;
      document.body.appendChild(history);
      await history.updateComplete;

      const dialog = history.renderRoot.querySelector(".dndm-roll-history-modal");
      expect(dialog).not.toBeNull();

      let entries = history.renderRoot.querySelectorAll(".dndm-rolllog-entry");
      expect(entries).toHaveLength(2);

      // Filter by "Attack"
      const searchInput = history.renderRoot.querySelector<HTMLInputElement>("input[type=text]");
      expect(searchInput).not.toBeNull();
      searchInput!.value = "Attack";
      searchInput!.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      await history.updateComplete;

      entries = history.renderRoot.querySelectorAll(".dndm-rolllog-entry");
      expect(entries).toHaveLength(1);

      history.remove();
    });
  });
});
