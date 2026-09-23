// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DndMapperState } from "../../game/domain.js";
import { createDefaultDndMapperState } from "../../game/domain.js";
import "../panels/dndm-quick-roll-footer.js";
import type { DndmQuickRollFooter } from "../panels/dndm-quick-roll-footer.js";
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

    it("shows re-roll buttons for own rolls in the recent rolls popover", async () => {
      const footer = document.createElement("dndm-quick-roll-footer") as DndmQuickRollFooter;
      footer.state = state;
      footer.currentUserId = "player-1";
      const onReRoll = vi.fn();
      footer.onReRoll = onReRoll;
      document.body.appendChild(footer);
      await footer.updateComplete;

      // Open the recent rolls popover
      const logBtn = footer.querySelector<HTMLButtonElement>(".dndm-rollfooter__log");
      expect(logBtn).not.toBeNull();
      logBtn!.click();
      await footer.updateComplete;

      // Only player-1's own roll offers re-roll
      const rerollBtns = footer.querySelectorAll<HTMLButtonElement>(".dndm-rolllog-reroll");
      expect(rerollBtns).toHaveLength(1);

      rerollBtns[0].click();
      expect(onReRoll).toHaveBeenCalledTimes(1);
      expect(onReRoll.mock.calls[0][0].id).toBe("r-nat20");
      expect(onReRoll.mock.calls[0][1]).toBe("Normal");

      // Shift-click -> Advantage
      rerollBtns[0].dispatchEvent(
        new MouseEvent("click", { shiftKey: true, bubbles: true, composed: true }),
      );
      expect(onReRoll.mock.calls[1][1]).toBe("Advantage");

      footer.remove();
    });

    it("orders bar as roll, settings, log, sound, mode, dice select", async () => {
      const footer = document.createElement("dndm-quick-roll-footer") as DndmQuickRollFooter;
      footer.state = state;
      document.body.appendChild(footer);
      await footer.updateComplete;

      const bar = footer.querySelector(".dndm-rollfooter")!;
      const order = Array.from(bar.children)
        .map((el) => el.className)
        .filter((c) => c.includes("dndm-rollfooter__"));
      const idx = (frag: string) => order.findIndex((c) => c.includes(frag));
      expect(idx("__rollbtn")).toBeGreaterThanOrEqual(0);
      expect(idx("__rollbtn")).toBeLessThan(idx("__gear"));
      expect(idx("__gear")).toBeLessThan(idx("__log"));
      expect(idx("__log")).toBeLessThan(idx("__sound"));
      expect(idx("__sound")).toBeLessThan(idx("__select-wrap"));
      expect(idx("__select-wrap")).toBeLessThan(idx("__polygroup"));

      footer.remove();
    });

    it("collapses dice select to 3 and expands to full list with custom", async () => {
      const footer = document.createElement("dndm-quick-roll-footer") as DndmQuickRollFooter;
      footer.state = state;
      document.body.appendChild(footer);
      await footer.updateComplete;

      let dice = Array.from(footer.querySelectorAll<HTMLButtonElement>(".dndm-rollfooter__diebtn"));
      expect(dice.map((b) => b.textContent?.trim())).toEqual(["d20", "d6", "d12"]);

      const expand = footer.querySelector<HTMLButtonElement>(".dndm-rollfooter__expand")!;
      expand.click();
      await footer.updateComplete;

      dice = Array.from(footer.querySelectorAll<HTMLButtonElement>(".dndm-rollfooter__diebtn"));
      expect(dice.map((b) => b.textContent?.trim())).toEqual([
        "d4",
        "d6",
        "d8",
        "d10",
        "d12",
        "d20",
        "d100",
        "Custom",
      ]);

      // Custom button reveals formula input
      const customBtn = dice.find((b) => b.textContent?.trim() === "Custom")!;
      customBtn.click();
      await footer.updateComplete;
      expect(footer.querySelector(".dndm-rollfooter__custom-formula")).not.toBeNull();

      footer.remove();
    });

    it("deselects preset dice when custom is selected and vice versa", async () => {
      const footer = document.createElement("dndm-quick-roll-footer") as DndmQuickRollFooter;
      footer.state = state;
      const onRollDice = vi.fn();
      footer.onRollDice = onRollDice;
      document.body.appendChild(footer);
      await footer.updateComplete;

      // d20 starts selected
      expect(
        footer
          .querySelector(".dndm-rollfooter__polygroup")!
          .querySelector(".dndm-rollfooter__diebtn--active")?.textContent?.trim(),
      ).toBe("d20");

      // Expand and select Custom -> preset dice deselected
      footer.querySelector<HTMLButtonElement>(".dndm-rollfooter__expand")!.click();
      await footer.updateComplete;
      const customBtn = Array.from(
        footer.querySelectorAll<HTMLButtonElement>(".dndm-rollfooter__diebtn"),
      ).find((b) => b.textContent?.trim() === "Custom")!;
      customBtn.click();
      await footer.updateComplete;

      expect(customBtn.classList.contains("dndm-rollfooter__diebtn--active")).toBe(true);
      const activePresets = Array.from(
        footer.querySelectorAll<HTMLButtonElement>(".dndm-rollfooter__diebtn:not(.dndm-rollfooter__diebtn--custom)"),
      ).filter((b) => b.classList.contains("dndm-rollfooter__diebtn--active"));
      expect(activePresets).toHaveLength(0);

      // Roll button now rolls the custom formula instead of the preset die
      const input = footer.querySelector<HTMLInputElement>(".dndm-rollfooter__custom-formula")!;
      input.value = "4d6+5";
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      await footer.updateComplete;
      footer.querySelector<HTMLButtonElement>(".dndm-rollfooter__rollbtn")!.click();
      expect(onRollDice).toHaveBeenLastCalledWith("4d6+5", "Normal", "Custom Roll", null, null);

      // Selecting a preset die deselects custom
      const d6Btn = Array.from(
        footer.querySelectorAll<HTMLButtonElement>(".dndm-rollfooter__diebtn"),
      ).find((b) => b.textContent?.trim() === "d6")!;
      d6Btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      await footer.updateComplete;
      expect(customBtn.classList.contains("dndm-rollfooter__diebtn--active")).toBe(false);
      expect(d6Btn.classList.contains("dndm-rollfooter__diebtn--active")).toBe(true);

      footer.remove();
    });

    it("derives collapsed dice from most recent roll history", async () => {
      const footer = document.createElement("dndm-quick-roll-footer") as DndmQuickRollFooter;
      footer.state = {
        ...state,
        rollLog: [
          {
            id: "r-1",
            rollerUserId: "p1",
            forcedByUserId: null,
            rolls: [{ sides: 8, value: 4 }],
            total: 4,
            mode: "Normal",
            flatModifier: 0,
            attributeModifier: 0,
            label: "x",
            timestampUtc: "2026-09-09T12:00:00.000Z",
            formula: "1d8",
            modifierBreakdown: "",
            tokenId: null,
            appliedRules: [],
          },
          {
            id: "r-2",
            rollerUserId: "p1",
            forcedByUserId: null,
            rolls: [{ sides: 12, value: 7 }],
            total: 7,
            mode: "Normal",
            flatModifier: 0,
            attributeModifier: 0,
            label: "x",
            timestampUtc: "2026-09-09T12:01:00.000Z",
            formula: "1d12",
            modifierBreakdown: "",
            tokenId: null,
            appliedRules: [],
          },
        ],
      };
      document.body.appendChild(footer);
      await footer.updateComplete;

      const dice = Array.from(footer.querySelectorAll<HTMLButtonElement>(".dndm-rollfooter__diebtn"));
      // most recent first: d12, d8, then default fill d20
      expect(dice.map((b) => b.textContent?.trim())).toEqual(["d12", "d8", "d20"]);

      footer.remove();
    });

    it("roll button rolls the selected die and mode dropdown previews on Shift", async () => {
      const footer = document.createElement("dndm-quick-roll-footer") as DndmQuickRollFooter;
      footer.state = state;
      const onRollDice = vi.fn();
      footer.onRollDice = onRollDice;
      document.body.appendChild(footer);
      await footer.updateComplete;

      const rollBtn = footer.querySelector<HTMLButtonElement>(".dndm-rollfooter__rollbtn")!;
      rollBtn.click();
      expect(onRollDice).toHaveBeenCalledWith("1d20", "Normal", "d20 Roll", null, null);

      // Hold Shift -> preview Advantage in mode dropdown
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
      await footer.updateComplete;
      const modeBtn = footer.querySelector<HTMLButtonElement>(".dndm-rollfooter__select")!;
      expect(modeBtn.textContent).toContain("Advantage");
      expect(modeBtn.classList.contains("dndm-rollfooter__select--preview")).toBe(true);

      // Roll button uses previewed mode
      rollBtn.click();
      expect(onRollDice).toHaveBeenLastCalledWith("1d20", "Advantage", "d20 Roll", null, null);

      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", shiftKey: false }));
      await footer.updateComplete;
      expect(modeBtn.textContent).toContain("Normal");

      footer.remove();
    });
  });

  describe("<dndm-roll-history> entries", () => {
    it("renders Nat 20 and Nat 1 with distinct CSS classes", async () => {
      const historyPanel = document.createElement("dndm-roll-history") as DndmRollHistory;
      historyPanel.state = state;
      historyPanel.isDm = true;
      historyPanel.isOpen = true;
      document.body.appendChild(historyPanel);
      await historyPanel.updateComplete;

      const entries = historyPanel.querySelectorAll(".dndm-rolllog-entry");
      expect(entries).toHaveLength(2);

      const nat20Entry = historyPanel.querySelector(".dndm-rolllog-entry--nat20");
      const nat1Entry = historyPanel.querySelector(".dndm-rolllog-entry--nat1");
      expect(nat20Entry).not.toBeNull();
      expect(nat1Entry).not.toBeNull();

      historyPanel.remove();
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
