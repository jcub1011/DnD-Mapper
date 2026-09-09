import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiceAnimationTracker } from "./diceAnimationTracker.js";

describe("DiceAnimationTracker", () => {
  let tracker: DiceAnimationTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new DiceAnimationTracker();
  });

  afterEach(() => {
    tracker.clearAll();
    vi.restoreAllMocks();
  });

  it("tracks roll animation lifecycle from start to settle", () => {
    expect(tracker.isAnimating("r1")).toBe(false);
    expect(tracker.isAnyAnimating()).toBe(false);

    tracker.start("r1");
    expect(tracker.isAnimating("r1")).toBe(true);
    expect(tracker.isAnyAnimating()).toBe(true);

    tracker.settle("r1");
    expect(tracker.isAnimating("r1")).toBe(false);
    expect(tracker.isAnyAnimating()).toBe(false);
  });

  it("notifies subscribers when animation state changes", () => {
    const subscriber = vi.fn();
    const unsub = tracker.subscribe(subscriber);

    tracker.start("r1");
    expect(subscriber).toHaveBeenCalledTimes(1);

    tracker.settle("r1");
    expect(subscriber).toHaveBeenCalledTimes(2);

    unsub();
    tracker.start("r2");
    expect(subscriber).toHaveBeenCalledTimes(2);
  });

  it("automatically settles after 3.5s timeout safety fallback", () => {
    const subscriber = vi.fn();
    tracker.subscribe(subscriber);

    tracker.start("r1");
    expect(tracker.isAnimating("r1")).toBe(true);
    expect(subscriber).toHaveBeenCalledTimes(1);

    // Advance 3400ms - still animating
    vi.advanceTimersByTime(3400);
    expect(tracker.isAnimating("r1")).toBe(true);

    // Advance past 3500ms - should auto settle
    vi.advanceTimersByTime(200);
    expect(tracker.isAnimating("r1")).toBe(false);
    expect(subscriber).toHaveBeenCalledTimes(2);
  });

  it("interrupts previous roll when settleAll is called", () => {
    tracker.start("r1");
    tracker.start("r2");
    expect(tracker.isAnimating("r1")).toBe(true);
    expect(tracker.isAnimating("r2")).toBe(true);

    tracker.settleAll();
    expect(tracker.isAnimating("r1")).toBe(false);
    expect(tracker.isAnimating("r2")).toBe(false);
    expect(tracker.isAnyAnimating()).toBe(false);
  });
});
