// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RollResult } from "../../game/domain.js";
import { diceAnimationTracker } from "./diceAnimationTracker.js";
import { DEFAULT_DICE_SCALE, DICE_FADE_DELAY_MS, DiceOverlay } from "./diceOverlay.js";

/** Minimal fake of the vendored DiceBox with controllable physics completion. */
class FakeBox {
  diceList: Array<{ value?: number }> = [];
  sounds = false;
  baseScale = DEFAULT_DICE_SCALE;
  onRollComplete: ((results: unknown) => void) | null = null;
  rollCalls: string[] = [];
  clearCount = 0;
  configCalls: Array<Record<string, unknown>> = [];
  private rollResolvers: Array<(value: unknown) => void> = [];

  async updateConfig(opts: Record<string, unknown>): Promise<void> {
    this.configCalls.push(opts);
    Object.assign(this, opts);
  }

  setDimensions(): void {}

  clearDice(): void {
    this.diceList = [];
    this.clearCount += 1;
  }

  private spawnCount(notation: string): number {
    const left = notation.split("@")[0];
    let count = 0;
    for (const group of left.split("+")) {
      const n = Number.parseInt(group.split("d")[0], 10);
      if (Number.isFinite(n)) count += n;
    }
    return count;
  }

  async roll(notation: string): Promise<unknown> {
    this.rollCalls.push(notation);
    this.clearDice();
    for (let i = 0; i < this.spawnCount(notation); i++) {
      this.diceList.push({ value: 0 });
    }
    return new Promise((resolve) => {
      this.rollResolvers.push(resolve);
    });
  }

  /** Completes the in-flight physics, firing every pending completion. */
  settlePhysics(): void {
    const resolvers = this.rollResolvers.splice(0, this.rollResolvers.length);
    for (const resolve of resolvers) resolve({});
  }
}

function makeSingleDieRoll(
  id: string,
  rollerUserId: string,
  sides: number,
  value: number,
): RollResult {
  return {
    id,
    timestampUtc: new Date().toISOString(),
    rollerUserId,
    forcedByUserId: null,
    label: `d${sides}`,
    formula: `1d${sides}`,
    rolls: [{ sides, value, discarded: false }],
    flatModifier: 0,
    attributeModifier: 0,
    modifierBreakdown: "",
    total: value,
    mode: "Normal",
    tokenId: null,
    appliedRules: [],
    originalDice: [{ count: 1, sides }],
    originalAttributeRef: null,
  };
}

function makeRoll(id: string, rollerUserId: string): RollResult {
  return makeSingleDieRoll(id, rollerUserId, 20, 17);
}

describe("DiceOverlay", () => {
  let overlay: DiceOverlay;
  let container: HTMLDivElement;
  let fake: FakeBox;

  function injectFake(): void {
    (overlay as unknown as { box: unknown }).box = fake;
  }

  function currentId(): string | null {
    return (overlay as unknown as { currentRollId: string | null }).currentRollId;
  }

  /** Flushes pending promise continuations (physics itself stays pending). */
  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    diceAnimationTracker.clearAll();
    overlay = new DiceOverlay();
    fake = new FakeBox();
    container = document.createElement("div");
    container.id = "dndm-dice-overlay";
    document.body.appendChild(container);
  });

  afterEach(() => {
    overlay.detach();
    container.remove();
    diceAnimationTracker.clearAll();
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
    const rollResult = makeRoll("test-roll-1", "u1");

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

  it("passes the authoritative notation to the stock throw", async () => {
    injectFake();

    await overlay.roll(makeSingleDieRoll("roll-a1", "player-a", 20, 17), "#ff0000", "#000000");

    expect(fake.rollCalls).toEqual(["1d20@17"]);
    expect(fake.diceList).toHaveLength(1);
    expect(currentId()).toBe("roll-a1");
  });

  it("a new roll makes the previous roll's dice disappear", async () => {
    injectFake();

    await overlay.roll(makeRoll("roll-a1", "player-a"), "#ff0000", "#000000");
    fake.settlePhysics();
    await flush();
    expect(fake.diceList).toHaveLength(1);

    await overlay.roll(makeRoll("roll-b1", "player-b"), "#0000ff", "#ffffff");

    // Only B's die is on the board; A's entry is settled immediately so its
    // log entry is revealed instead of hiding behind B's physics.
    expect(fake.diceList).toHaveLength(1);
    expect(fake.rollCalls).toEqual(["1d20@17", "1d20@17"]);
    expect(currentId()).toBe("roll-b1");
    expect(diceAnimationTracker.isAnimating("roll-a1")).toBe(false);
    expect(diceAnimationTracker.isAnimating("roll-b1")).toBe(true);

    fake.settlePhysics();
    await flush();

    expect(diceAnimationTracker.isAnimating("roll-b1")).toBe(false);
  });

  it("a re-roll while tumbling clears and re-throws", async () => {
    injectFake();

    await overlay.roll(makeRoll("roll-a1", "player-a"), "#ff0000", "#000000");
    expect(diceAnimationTracker.isAnimating("roll-a1")).toBe(true);

    await overlay.roll(makeRoll("roll-a2", "player-a"), "#ff0000", "#000000");

    expect(fake.diceList).toHaveLength(1);
    expect(currentId()).toBe("roll-a2");
    expect(diceAnimationTracker.isAnimating("roll-a1")).toBe(false);
    expect(diceAnimationTracker.isAnimating("roll-a2")).toBe(true);

    fake.settlePhysics();
    await flush();

    expect(diceAnimationTracker.isAnimating("roll-a2")).toBe(false);
  });

  it("the visible roll fades after its delay", async () => {
    injectFake();

    await overlay.roll(makeRoll("roll-a1", "player-a"), "#ff0000", "#000000");
    fake.settlePhysics();
    await flush();
    expect(fake.diceList).toHaveLength(1);

    vi.advanceTimersByTime(DICE_FADE_DELAY_MS + 100);
    await flush();

    expect(fake.diceList).toHaveLength(0);
    expect(currentId()).toBeNull();
  });

  it("a newer roll cancels the previous roll's fade", async () => {
    injectFake();

    await overlay.roll(makeRoll("roll-a1", "player-a"), "#ff0000", "#000000");
    fake.settlePhysics();
    await flush();

    // B arrives before A's fade fires: A's fade is cancelled, B takes the board.
    vi.advanceTimersByTime(DICE_FADE_DELAY_MS - 500);
    await overlay.roll(makeRoll("roll-b1", "player-b"), "#0000ff", "#ffffff");
    expect(fake.diceList).toHaveLength(1);

    // Past A's original deadline: B's die is untouched (its own fade is pending).
    vi.advanceTimersByTime(500 + 100);
    await flush();
    expect(fake.diceList).toHaveLength(1);
    expect(currentId()).toBe("roll-b1");
  });

  it("applies each roll's colors", async () => {
    injectFake();

    await overlay.roll(makeRoll("roll-a1", "player-a"), "#ff0000", "#000000");
    await overlay.roll(makeRoll("roll-b1", "player-b"), "#0000ff", "#ffffff");

    expect(fake.configCalls[0]?.["theme_customColorset"]).toMatchObject({
      background: "#ff0000",
    });
    const last = fake.configCalls[fake.configCalls.length - 1];
    expect(last?.["theme_customColorset"]).toMatchObject({ background: "#0000ff" });
  });

  it("detach settles the live roll and clears the board", async () => {
    injectFake();

    const pending = overlay.roll(makeRoll("roll-a1", "player-a"), "#ff0000", "#000000");
    overlay.detach();
    await pending;

    expect(diceAnimationTracker.isAnimating("roll-a1")).toBe(false);
    expect(currentId()).toBeNull();
    expect(fake.diceList).toHaveLength(0);
  });
});
