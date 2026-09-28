// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultDndMapperState, type RollResult } from "../../game/domain";
import { diceAnimationTracker } from "../dice/diceAnimationTracker";
import "./dndm-display-roll-history";
import type { DndmDisplayRollHistory } from "./dndm-display-roll-history";

function makeRoll(id: string, total: number, label: string): RollResult {
  return {
    id,
    rollerUserId: "u1",
    forcedByUserId: null,
    rolls: [{ sides: 20, value: total }],
    total,
    mode: "Normal",
    flatModifier: 0,
    attributeModifier: 0,
    label,
    timestampUtc: "2026-09-28T12:00:00.000Z",
    formula: "1d20",
    modifierBreakdown: "",
    tokenId: null,
    appliedRules: [],
  };
}

describe("<dndm-display-roll-history>", () => {
  let panel: DndmDisplayRollHistory;

  async function mount(rolls: RollResult[], rollsVisibleToPlayers = true): Promise<void> {
    const base = createDefaultDndMapperState();
    panel = document.createElement("dndm-display-roll-history") as DndmDisplayRollHistory;
    panel.state = {
      ...base,
      rollLog: rolls,
      settings: { ...base.settings, rollsVisibleToPlayers },
    };
    panel.widthPx = 400;
    document.body.appendChild(panel);
    await panel.updateComplete;
  }

  const labels = () =>
    [...panel.querySelectorAll(".dndm-rolllog-label")].map((el) => el.textContent?.trim());

  afterEach(() => {
    panel?.remove();
    diceAnimationTracker.clear();
  });

  it("lists every roll newest first without re-roll controls", async () => {
    await mount([makeRoll("a", 5, "First"), makeRoll("b", 12, "Second")]);
    expect(labels()).toEqual(["Second", "First"]);
    expect(panel.querySelector(".dndm-rolllog-reroll")).toBeNull();
    expect(panel.querySelector<HTMLElement>(".dndm-display-rolls")!.style.width).toBe("400px");
  });

  it("holds back a roll until its 3D dice settle", async () => {
    diceAnimationTracker.markAnimating("b");
    await mount([makeRoll("a", 5, "First"), makeRoll("b", 12, "Second")]);
    expect(labels()).toEqual(["First"]);

    diceAnimationTracker.markSettled("b");
    await panel.updateComplete;
    expect(labels()).toEqual(["Second", "First"]);
  });

  it("shows nothing when rolls are hidden from players", async () => {
    await mount([makeRoll("a", 5, "First")], false);
    expect(panel.querySelector(".dndm-rolllog-entry")).toBeNull();
  });
});
