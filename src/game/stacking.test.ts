import { describe, expect, it } from "vitest";
import type { GridConfig, Token } from "./domain.js";
import { getStackChipPositions, groupTokensIntoStacks, tokenCellOf } from "./stacking.js";

function makeToken(id: string, x: number, y: number, name = "Goblin"): Token {
  return {
    id,
    type: "NPCToken",
    ownerUserId: null,
    representsUserId: null,
    name,
    color: "#ff0000",
    iconKind: "Initial",
    mapId: "map-1",
    x,
    y,
    sheetId: null,
    hidden: false,
  };
}

describe("stacking", () => {
  it("tokenCellOf returns floored cell coordinate", () => {
    expect(tokenCellOf(3.5, 4.5)).toEqual({ cellX: 3, cellY: 4 });
    expect(tokenCellOf(0.1, 0.9)).toEqual({ cellX: 0, cellY: 0 });
    expect(tokenCellOf(5.0, 7.0)).toEqual({ cellX: 5, cellY: 7 });
  });

  it("groups multiple tokens in the same cell into a single stack", () => {
    const t1 = makeToken("t1", 2.5, 3.5, "Orc 1");
    const t2 = makeToken("t2", 2.5, 3.5, "Orc 2");
    const t3 = makeToken("t3", 2.8, 3.2, "Orc 3"); // Non-snapped but same cell!
    const t4 = makeToken("t4", 5.5, 1.5, "Archer");

    const stacks = groupTokensIntoStacks([t1, t2, t3, t4]);
    expect(stacks.length).toBe(2);

    // Sorted by cellY then cellX: (5, 1) comes before (2, 3)
    expect(stacks[0].cell).toEqual({ cellX: 5, cellY: 1 });
    expect(stacks[0].tokens.length).toBe(1);

    expect(stacks[1].cell).toEqual({ cellX: 2, cellY: 3 });
    expect(stacks[1].tokens.length).toBe(3);
    expect(stacks[1].tokens.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("calculates chip fan-out layout correctly", () => {
    const grid: GridConfig = {
      widthCells: 20,
      heightCells: 20,
      cellPixels: 50,
      showGridLines: true,
      snapToGrid: true,
      lineColor: "#222",
    };

    const tokens = [
      makeToken("t1", 5.5, 5.5, "A"),
      makeToken("t2", 5.5, 5.5, "B"),
      makeToken("t3", 5.5, 5.5, "C"),
    ];
    const [stack] = groupTokensIntoStacks(tokens);
    const layout = getStackChipPositions(stack, grid);

    expect(layout.anchorX).toBe(5.5);
    expect(layout.anchorY).toBe(5.5);
    // Above cell when cellY >= 1: 5 - 0.7 = 4.3
    expect(layout.rowCy).toBeCloseTo(4.3);
    expect(layout.chips.length).toBe(3);
    // 3 chips: i = 0, 1, 2. Spacing = 1.0, centred at rowCx = 5.5: 4.5, 5.5, 6.5
    expect(layout.chips[0].x).toBeCloseTo(4.5);
    expect(layout.chips[1].x).toBeCloseTo(5.5);
    expect(layout.chips[2].x).toBeCloseTo(6.5);

    // Below cell when cellY < 1 (e.g. cellY = 0)
    const topStack = groupTokensIntoStacks([
      makeToken("t4", 2.5, 0.5, "TopA"),
      makeToken("t5", 2.5, 0.5, "TopB"),
    ])[0];
    const topLayout = getStackChipPositions(topStack, grid);
    // Below cell: cellY + 1.7 = 1.7
    expect(topLayout.rowCy).toBeCloseTo(1.7);
  });
});
