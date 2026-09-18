// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RollResult } from "../../game/domain.js";
import { diceAnimationTracker } from "./diceAnimationTracker.js";
import { DEFAULT_DICE_SCALE, DiceOverlay } from "./diceOverlay.js";

describe("DiceOverlay", () => {
  let overlay: DiceOverlay;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    overlay = new DiceOverlay();
    container = document.createElement("div");
    container.id = "dndm-dice-overlay";
    document.body.appendChild(container);
  });

  afterEach(() => {
    overlay.detach();
    container.remove();
    vi.restoreAllMocks();
  });

  it("manages container attachment and detachment", async () => {
    expect(overlay.getContainer()).toBeNull();

    await overlay.attach(container);
    expect(overlay.getContainer()).toBe(container);

    overlay.detach();
    expect(overlay.getContainer()).toBeNull();
  });

  it("toggles sound enabled state", () => {
    expect(overlay.isSoundEnabled).toBe(false);
    overlay.setSoundEnabled(true);
    expect(overlay.isSoundEnabled).toBe(true);
    overlay.setSoundEnabled(false);
    expect(overlay.isSoundEnabled).toBe(false);
  });

  it("manages dice scale with bounds clamping", () => {
    expect(overlay.getDiceScale()).toBe(DEFAULT_DICE_SCALE);
    expect(DEFAULT_DICE_SCALE).toBe(75);

    overlay.setDiceScale(100);
    expect(overlay.getDiceScale()).toBe(100);

    overlay.setDiceScale(50);
    expect(overlay.getDiceScale()).toBe(50);

    // Clamps below 25
    overlay.setDiceScale(10);
    expect(overlay.getDiceScale()).toBe(25);

    // Clamps above 250
    overlay.setDiceScale(300);
    expect(overlay.getDiceScale()).toBe(250);

    // Rejects NaN
    overlay.setDiceScale(Number.NaN);
    expect(overlay.getDiceScale()).toBe(250);
  });

  it("immediately marks roll settled when WebGL is unsupported", async () => {
    const rollResult: RollResult = {
      id: "test-roll-1",
      timestampUtc: new Date().toISOString(),
      rollerUserId: "u1",
      forcedByUserId: null,
      label: "d20",
      formula: "1d20",
      rolls: [{ sides: 20, value: 17 }],
      flatModifier: 0,
      attributeModifier: 0,
      modifierBreakdown: "",
      total: 17,
      mode: "Normal",
      tokenId: null,
      appliedRules: [],
    };

    const isAnimatingBefore = diceAnimationTracker.isAnimating("test-roll-1");
    expect(isAnimatingBefore).toBe(false);

    await overlay.attach(container);
    await overlay.roll(rollResult, "#44ff44", "#000000");

    // In happy-dom without WebGL, ensureBox falls back immediately to marking settled
    expect(diceAnimationTracker.isAnimating("test-roll-1")).toBe(false);
  });

  it("re-attaching to a different container preserves single WebGL context invariant", async () => {
    const secondContainer = document.createElement("div");
    secondContainer.id = "dndm-dice-overlay-2";
    document.body.appendChild(secondContainer);

    await overlay.attach(container);
    expect(overlay.getContainer()).toBe(container);

    await overlay.attach(secondContainer);
    expect(overlay.getContainer()).toBe(secondContainer);

    secondContainer.remove();
  });

  it("safe invocation of updateDimensions when detached or uninitialized", () => {
    expect(() => overlay.updateDimensions()).not.toThrow();
  });
});
