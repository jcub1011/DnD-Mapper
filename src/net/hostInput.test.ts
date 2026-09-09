// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostInputTracker, isEditableElement, normalizeKey } from "./hostInput.js";

describe("HostInputTracker Key Normalization & Editable Guard", () => {
  it("normalizes space and key names to uppercase", () => {
    expect(normalizeKey(" ")).toBe("SPACE");
    expect(normalizeKey("space")).toBe("SPACE");
    expect(normalizeKey("Space")).toBe("SPACE");
    expect(normalizeKey("h")).toBe("H");
    expect(normalizeKey("H")).toBe("H");
    expect(normalizeKey("1")).toBe("1");
    expect(normalizeKey("Enter")).toBe("ENTER");
  });

  it("identifies editable elements", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const divEditable = document.createElement("div");
    divEditable.contentEditable = "true";
    const divNormal = document.createElement("div");

    expect(isEditableElement(input)).toBe(true);
    expect(isEditableElement(textarea)).toBe(true);
    expect(isEditableElement(select)).toBe(true);
    expect(isEditableElement(divEditable)).toBe(true);
    expect(isEditableElement(divNormal)).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

describe("HostInputTracker Event Streaming & Rate Limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keydown and keyup accurately maintain active held key set", () => {
    const dispatches: string[][] = [];
    const target = new EventTarget();
    const tracker = new HostInputTracker({
      target,
      throttleMs: 50,
      onKeysChanged: (keys) => dispatches.push([...keys]),
    });
    tracker.attach();

    // Keydown 'h' -> leading edge dispatches immediately
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "h" }));
    expect(tracker.getHeldKeys()).toEqual(["H"]);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toEqual(["H"]);

    // Keydown ' ' (space) within throttle period -> scheduled for trailing edge
    target.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(tracker.getHeldKeys()).toEqual(["H", "SPACE"]);
    expect(dispatches).toHaveLength(1); // not dispatched yet due to throttle

    // Advance 50ms
    vi.advanceTimersByTime(50);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]).toEqual(["H", "SPACE"]);

    // Keyup 'h'
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "h" }));
    expect(tracker.getHeldKeys()).toEqual(["SPACE"]);
    vi.advanceTimersByTime(50);
    expect(dispatches).toHaveLength(3);
    expect(dispatches[2]).toEqual(["SPACE"]);

    // Keyup ' '
    target.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
    expect(tracker.getHeldKeys()).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(dispatches).toHaveLength(4);
    expect(dispatches[3]).toEqual([]);

    tracker.detach();
  });

  it("flushes all held keys on window blur", () => {
    const dispatches: string[][] = [];
    const target = new EventTarget();
    const tracker = new HostInputTracker({
      target,
      throttleMs: 50,
      onKeysChanged: (keys) => dispatches.push([...keys]),
    });
    tracker.attach();

    target.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(tracker.getHeldKeys()).toEqual(["A"]);
    expect(dispatches).toHaveLength(1);

    // Blur event fires
    target.dispatchEvent(new Event("blur"));
    expect(tracker.getHeldKeys()).toEqual([]);

    vi.advanceTimersByTime(50);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]).toEqual([]);

    tracker.detach();
  });

  it("ignores keystrokes inside inputs and textareas", () => {
    const dispatches: string[][] = [];
    const tracker = new HostInputTracker({
      target: window,
      throttleMs: 50,
      onKeysChanged: (keys) => dispatches.push([...keys]),
    });
    tracker.attach();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    // Event on input element
    const event = new KeyboardEvent("keydown", { key: "x", bubbles: true });
    input.dispatchEvent(event);

    expect(tracker.getHeldKeys()).toEqual([]);
    expect(dispatches).toHaveLength(0);

    input.remove();
    tracker.detach();
  });

  it("ignores repeat keydown events", () => {
    const dispatches: string[][] = [];
    const target = new EventTarget();
    const tracker = new HostInputTracker({
      target,
      throttleMs: 50,
      onKeysChanged: (keys) => dispatches.push([...keys]),
    });
    tracker.attach();

    target.dispatchEvent(new KeyboardEvent("keydown", { key: "z", repeat: false }));
    expect(dispatches).toHaveLength(1);

    // Repeated keydown
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "z", repeat: true }));
    expect(dispatches).toHaveLength(1);

    tracker.detach();
  });

  it("key stream debouncer does not exceed 30 msg/s under rapid keystrokes", () => {
    const dispatches: string[][] = [];
    const target = new EventTarget();
    const tracker = new HostInputTracker({
      target,
      throttleMs: 50, // 20 msg/s max
      onKeysChanged: (keys) => dispatches.push([...keys]),
    });
    tracker.attach();

    // Simulate 100 rapid key events over 1000ms (1 every 10ms)
    for (let i = 0; i < 100; i++) {
      const key = `k${i % 10}`;
      if (i % 2 === 0) {
        target.dispatchEvent(new KeyboardEvent("keydown", { key }));
      } else {
        target.dispatchEvent(new KeyboardEvent("keyup", { key }));
      }
      vi.advanceTimersByTime(10);
    }

    // Flush any pending trailing timer
    vi.advanceTimersByTime(100);

    // In 1 second (1000ms) with 50ms throttle, total dispatches must be <= 21, well below 30 ceiling
    expect(dispatches.length).toBeLessThanOrEqual(22);

    tracker.detach();
  });
});
