// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import "./dndm-display-roll-ticker";
import type { DndmDisplayRollTicker } from "./dndm-display-roll-ticker";
import type { RollResult } from "../../game/domain";

describe("<dndm-display-roll-ticker> Component", () => {
  const ROLLS: RollResult[] = [
    {
      id: "r1",
      rollerUserId: "player-1",
      forcedByUserId: null,
      rolls: [{ sides: 20, value: 15 }],
      total: 18,
      mode: "Normal",
      flatModifier: 3,
      attributeModifier: 0,
      label: "Athletics",
      timestampUtc: "2026-09-11T12:00:00Z",
      formula: "1d20+3",
      modifierBreakdown: "+3 Flat",
      tokenId: null,
      appliedRules: [],
    },
    {
      id: "r2",
      rollerUserId: "player-2",
      forcedByUserId: null,
      rolls: [{ sides: 20, value: 20 }],
      total: 25,
      mode: "Normal",
      flatModifier: 5,
      attributeModifier: 0,
      label: "Attack",
      timestampUtc: "2026-09-11T12:01:00Z",
      formula: "1d20+5",
      modifierBreakdown: "+5 Flat",
      tokenId: null,
      appliedRules: [],
    },
    {
      id: "r3",
      rollerUserId: "player-2",
      forcedByUserId: null,
      rolls: [{ sides: 20, value: 1 }],
      total: 3,
      mode: "Normal",
      flatModifier: 2,
      attributeModifier: 0,
      label: "Stealth",
      timestampUtc: "2026-09-11T12:02:00Z",
      formula: "1d20+2",
      modifierBreakdown: "+2 Flat",
      tokenId: null,
      appliedRules: [],
    },
  ];

  it("renders roll cards with roller, formula, label, and total", async () => {
    const el = document.createElement("dndm-display-roll-ticker") as DndmDisplayRollTicker;
    el.rolls = ROLLS;
    el.isDm = true;
    document.body.appendChild(el);
    await el.updateComplete;

    const cards = el.querySelectorAll(".dndm-display-roll-card");
    expect(cards.length).toBe(3);

    const totals = Array.from(el.querySelectorAll(".dndm-display-roll-total")).map(
      (t) => t.textContent?.trim(),
    );
    expect(totals).toEqual(["18", "25", "3"]);

    el.remove();
  });

  it("applies crit-success on natural 20 and crit-failure on natural 1", async () => {
    const el = document.createElement("dndm-display-roll-ticker") as DndmDisplayRollTicker;
    el.rolls = ROLLS;
    el.isDm = true;
    document.body.appendChild(el);
    await el.updateComplete;

    const totalElements = el.querySelectorAll(".dndm-display-roll-total");
    expect(totalElements[1].classList.contains("crit-success")).toBe(true);
    expect(totalElements[2].classList.contains("crit-failure")).toBe(true);

    el.remove();
  });

  it("filters out other players' rolls when rollsVisibleToPlayers is false", async () => {
    const el = document.createElement("dndm-display-roll-ticker") as DndmDisplayRollTicker;
    el.rolls = ROLLS;
    el.isDm = false;
    el.currentUserId = "player-1";
    el.rollsVisibleToPlayers = false;
    document.body.appendChild(el);
    await el.updateComplete;

    const cards = el.querySelectorAll(".dndm-display-roll-card");
    expect(cards.length).toBe(1);

    el.remove();
  });
});
