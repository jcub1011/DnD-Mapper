// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import "./dndm-sheet-popout-view";
import type { DndmSheetPopoutView } from "./dndm-sheet-popout-view";
import {
  createDefaultAttributeSchema,
  createDefaultDndMapperState,
  type CharacterSheet,
} from "../../game/domain";
import type { SheetStateMessage } from "./sheetPopout";

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly posted: unknown[] = [];
  closed = false;

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }

  close(): void {
    this.closed = true;
  }
}

function makeSheet(): CharacterSheet {
  return {
    id: "sheet-1",
    ownerUserId: null,
    representsUserId: null,
    characterName: "Thorin",
    values: {},
    notes: "Heroic adventurer notes",
    hp: 24,
    maxHp: 30,
    armorClass: 16,
    color: "#4a90e2",
    colorOverridden: false,
    scopedMapId: null,
    statusEffects: [],
    rollTemplates: [],
  };
}

function makeState(sheet: CharacterSheet | null): SheetStateMessage {
  return {
    type: "sheet-state",
    sheetId: "sheet-1",
    sheet,
    attributeSchema: createDefaultAttributeSchema("DnD5eCore"),
    statusEffectTemplates: {},
    settings: createDefaultDndMapperState().settings,
    isDm: true,
    currentUserId: "dm-1",
    roster: [],
    dmPlayerId: "dm-1",
    maps: [],
    activeMapId: null,
  };
}

describe("<dndm-sheet-popout-view>", () => {
  let el: DndmSheetPopoutView;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    el = document.createElement("dndm-sheet-popout-view") as DndmSheetPopoutView;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    el.remove();
  });

  function channelForView(): FakeBroadcastChannel {
    const found = FakeBroadcastChannel.instances.find((c) => c.name === "dndm-sheet-sync");
    if (!found) throw new Error("view did not open the sheet sync channel");
    return found;
  }

  function deliver(channel: FakeBroadcastChannel, msg: unknown): void {
    channel.onmessage?.({ data: msg });
  }

  it("joins the sheet channel on connect and waits for the main window", async () => {
    el.sheetId = "sheet-1";
    document.body.appendChild(el);
    await el.updateComplete;

    const channel = channelForView();
    expect(channel.posted).toEqual([{ type: "sheet-join", sheetId: "sheet-1" }]);
    expect(el.textContent).toContain("Waiting for the main window");
    expect(el.querySelector("dndm-character-sheet")).toBeNull();
  });

  it("renders the synced sheet and forwards edits as sheet-edit intents", async () => {
    el.sheetId = "sheet-1";
    document.body.appendChild(el);
    await el.updateComplete;
    const channel = channelForView();

    deliver(channel, makeState(makeSheet()));
    await el.updateComplete;
    const inner = el.querySelector("dndm-character-sheet") as unknown as {
      updateComplete: Promise<unknown>;
    } | null;
    expect(inner).not.toBeNull();
    await inner?.updateComplete;
    await el.updateComplete;

    // No faux window chrome — the sheet fills the popup; only the tab
    // title identifies it.
    expect(el.querySelector(".dndm-sheet-popout-bar")).toBeNull();
    expect(el.querySelector(".dndm-sheet-popout-body")).not.toBeNull();
    expect(document.title).toContain("Thorin");
    // Fill-height layout hooks for the notes-absorbs-remaining CSS.
    expect(el.querySelector(".dndm-sheet-popout-head")).not.toBeNull();
    expect(el.querySelector(".dndm-sheet-notes-container")).not.toBeNull();
    // The sheet must stay a direct child of the body: the
    // `.dndm-sheet-popout-body > dndm-character-sheet` height rule is what
    // keeps the fill chain definite.
    const body = el.querySelector(".dndm-sheet-popout-body");
    expect(body?.querySelector(":scope > dndm-character-sheet")).not.toBeNull();

    const nameInput = el.querySelector(".dndm-sheet-name-input") as HTMLInputElement;
    expect(nameInput.value).toBe("Thorin");

    // Typing notes flows through the debounced update path as a sheet-edit.
    const area = el.querySelector(
      ".dndm-sheet-notes-container > .dndm-sheet-notes-textarea",
    ) as HTMLTextAreaElement;
    expect(area).not.toBeNull();
    area.value = "Edited in popup";
    area.dispatchEvent(new Event("input"));
    // Debounced: nothing sent synchronously…
    expect(
      channel.posted.filter((m) => (m as { type?: string }).type === "sheet-edit"),
    ).toHaveLength(0);
    vi.advanceTimersByTime(300);
    const edits = channel.posted.filter((m) => (m as { type?: string }).type === "sheet-edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      type: "sheet-edit",
      sheetId: "sheet-1",
      intent: { kind: "updateSheet", patch: { notes: "Edited in popup" } },
    });
  });

  it("ignores state for other sheets", async () => {
    el.sheetId = "sheet-1";
    document.body.appendChild(el);
    await el.updateComplete;
    const channel = channelForView();

    deliver(channel, { ...makeState(makeSheet()), sheetId: "sheet-2" });
    await el.updateComplete;

    expect(el.querySelector("dndm-character-sheet")).toBeNull();
    expect(el.textContent).toContain("Waiting for the main window");
  });

  it("shows a closed message when the opener closes the sheet", async () => {
    el.sheetId = "sheet-1";
    document.body.appendChild(el);
    await el.updateComplete;
    const channel = channelForView();

    deliver(channel, makeState(makeSheet()));
    await el.updateComplete;
    expect(el.querySelector("dndm-character-sheet")).not.toBeNull();

    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    try {
      deliver(channel, { type: "sheet-close", sheetId: "sheet-1" });
      await el.updateComplete;
      expect(closeSpy).toHaveBeenCalled();
      expect(el.textContent).toContain("closed from the main window");
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("notifies the opener when unloaded", async () => {
    el.sheetId = "sheet-1";
    document.body.appendChild(el);
    await el.updateComplete;
    const channel = channelForView();

    el.remove();
    expect(channel.posted).toContainEqual({ type: "sheet-leave", sheetId: "sheet-1" });
    expect(channel.closed).toBe(true);
  });
});
