// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultDndMapperState,
  type LoadedDiceRule,
  type RollResult,
} from "../../game/domain.js";
import "./dndm-loaded-dice-panel.js";
import type { DndmLoadedDicePanel } from "./dndm-loaded-dice-panel.js";
import "../modals/dndm-roll-history.js";
import type { DndmRollHistory } from "../modals/dndm-roll-history.js";

describe("<dndm-loaded-dice-panel>", () => {
  const sampleRules: LoadedDiceRule[] = [
    {
      id: "rule-1",
      name: "Force 20 on Space",
      enabled: true,
      targetSheetIds: [],
      conditions: [{ $kind: "hostKeyHeld", key: "SPACE" }],
      modifications: [{ $kind: "setResult", value: 20 }],
    },
    {
      id: "rule-2",
      name: "Floor at 10",
      enabled: false,
      targetSheetIds: [],
      conditions: [],
      modifications: [{ $kind: "clampMin", min: 10 }],
    },
  ];

  it("renders rule cards and held keys", async () => {
    const el = document.createElement("dndm-loaded-dice-panel") as DndmLoadedDicePanel;
    el.rules = sampleRules;
    el.hostHeldKeys = ["SPACE", "H"];
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.innerHTML).toContain("Force 20 on Space");
    expect(el.innerHTML).toContain("Floor at 10");
    expect(el.innerHTML).toContain("SPACE");
    expect(el.innerHTML).toContain("H");

    el.remove();
  });

  it("toggles a rule via the checkbox", async () => {
    const el = document.createElement("dndm-loaded-dice-panel") as DndmLoadedDicePanel;
    const onToggle = vi.fn();
    el.rules = sampleRules;
    el.onToggleRule = onToggle;
    document.body.appendChild(el);
    await el.updateComplete;

    const checkboxes = el.querySelectorAll<HTMLInputElement>(".dndm-loaded-rule-actions input[type='checkbox']");
    expect(checkboxes.length).toBe(2);

    checkboxes[0].click();
    expect(onToggle).toHaveBeenCalledWith("rule-1", false);

    el.remove();
  });

  it("reorders rules via move buttons", async () => {
    const el = document.createElement("dndm-loaded-dice-panel") as DndmLoadedDicePanel;
    const onReorder = vi.fn();
    el.rules = sampleRules;
    el.onReorderRules = onReorder;
    document.body.appendChild(el);
    await el.updateComplete;

    // Rule 1 move down button
    const moveDownBtns = el.querySelectorAll<HTMLButtonElement>("button[title='Move down']");
    expect(moveDownBtns.length).toBe(2);
    moveDownBtns[0].click();

    expect(onReorder).toHaveBeenCalledWith(["rule-2", "rule-1"]);

    el.remove();
  });

  it("deletes a rule via delete button", async () => {
    const el = document.createElement("dndm-loaded-dice-panel") as DndmLoadedDicePanel;
    const onDelete = vi.fn();
    el.rules = sampleRules;
    el.onDeleteRule = onDelete;
    document.body.appendChild(el);
    await el.updateComplete;

    const deleteBtns = el.querySelectorAll<HTMLButtonElement>("button[title='Delete rule']");
    expect(deleteBtns.length).toBe(2);
    deleteBtns[0].click();

    expect(onDelete).toHaveBeenCalledWith("rule-1");

    el.remove();
  });
});

describe("<dndm-roll-history> Loaded Dice Visibility & Player Cues", () => {
  const tamperedRoll: RollResult = {
    id: "roll-tampered-1",
    rollerUserId: "player-1",
    forcedByUserId: null,
    rolls: [{ sides: 20, value: 20, discarded: false }],
    total: 20,
    mode: "Normal",
    flatModifier: 0,
    attributeModifier: 0,
    label: "Attack",
    timestampUtc: "2026-09-09T16:00:00.000Z",
    formula: "1d20",
    modifierBreakdown: "[20] = 20",
    tokenId: null,
    appliedRules: [
      {
        ruleId: "rule-1",
        ruleName: "Spacebar Force 20",
        modificationType: "setResult",
      },
    ],
  };

  it("strips rule stamps from player when loadedDiceRuleVisibility is Hidden", async () => {
    const state = {
      ...createDefaultDndMapperState(),
      rollLog: [tamperedRoll],
      settings: {
        ...createDefaultDndMapperState().settings,
        loadedDiceRuleVisibility: "Hidden",
        loadedDicePlayerIndicator: "None",
      },
    };

    const el = document.createElement("dndm-roll-history") as DndmRollHistory;
    el.state = state;
    el.isOpen = true;
    el.isDm = false;
    el.currentUserId = "player-1";
    document.body.appendChild(el);
    await el.updateComplete;

    // Player does NOT see stamps or badge
    expect(el.querySelector(".dndm-rolllog-stamps")).toBeNull();
    expect(el.innerHTML).not.toContain("Spacebar Force 20");
    expect(el.querySelector(".dndm-rolllog-cue--subtle")).toBeNull();
    expect(el.querySelector(".dndm-rolllog-cue--obvious")).toBeNull();

    el.remove();
  });

  it("shows rule stamps to DM even when loadedDiceRuleVisibility is Hidden", async () => {
    const state = {
      ...createDefaultDndMapperState(),
      rollLog: [tamperedRoll],
      settings: {
        ...createDefaultDndMapperState().settings,
        loadedDiceRuleVisibility: "Hidden",
        loadedDicePlayerIndicator: "None",
      },
    };

    const el = document.createElement("dndm-roll-history") as DndmRollHistory;
    el.state = state;
    el.isOpen = true;
    el.isDm = true;
    el.currentUserId = "dm-1";
    document.body.appendChild(el);
    await el.updateComplete;

    // DM sees stamps
    expect(el.querySelector(".dndm-rolllog-stamps")).not.toBeNull();
    expect(el.innerHTML).toContain("Spacebar Force 20");

    el.remove();
  });

  it("shows rule stamps to players when loadedDiceRuleVisibility is VisibleToAll", async () => {
    const state = {
      ...createDefaultDndMapperState(),
      rollLog: [tamperedRoll],
      settings: {
        ...createDefaultDndMapperState().settings,
        loadedDiceRuleVisibility: "VisibleToAll",
        loadedDicePlayerIndicator: "None",
      },
    };

    const el = document.createElement("dndm-roll-history") as DndmRollHistory;
    el.state = state;
    el.isOpen = true;
    el.isDm = false;
    el.currentUserId = "player-1";
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.querySelector(".dndm-rolllog-stamps")).not.toBeNull();
    expect(el.innerHTML).toContain("Spacebar Force 20");

    el.remove();
  });

  it("shows Subtle player cue dot when configured", async () => {
    const state = {
      ...createDefaultDndMapperState(),
      rollLog: [tamperedRoll],
      settings: {
        ...createDefaultDndMapperState().settings,
        loadedDiceRuleVisibility: "Hidden",
        loadedDicePlayerIndicator: "Subtle",
      },
    };

    const el = document.createElement("dndm-roll-history") as DndmRollHistory;
    el.state = state;
    el.isOpen = true;
    el.isDm = false;
    el.currentUserId = "player-1";
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.querySelector(".dndm-rolllog-stamps")).toBeNull();
    expect(el.querySelector(".dndm-rolllog-cue--subtle")).not.toBeNull();
    expect(el.querySelector(".dndm-rolllog-cue--obvious")).toBeNull();

    el.remove();
  });

  it("shows Obvious player cue banner when configured", async () => {
    const state = {
      ...createDefaultDndMapperState(),
      rollLog: [tamperedRoll],
      settings: {
        ...createDefaultDndMapperState().settings,
        loadedDiceRuleVisibility: "Hidden",
        loadedDicePlayerIndicator: "Obvious",
      },
    };

    const el = document.createElement("dndm-roll-history") as DndmRollHistory;
    el.state = state;
    el.isOpen = true;
    el.isDm = false;
    el.currentUserId = "player-1";
    document.body.appendChild(el);
    await el.updateComplete;

    expect(el.querySelector(".dndm-rolllog-stamps")).toBeNull();
    expect(el.querySelector(".dndm-rolllog-cue--obvious")).not.toBeNull();
    expect(el.innerHTML).toContain("Tampered by a divine hand");

    el.remove();
  });
});
