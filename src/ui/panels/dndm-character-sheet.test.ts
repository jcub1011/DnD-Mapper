// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import "./dndm-character-sheet";
import type { DndmCharacterSheet } from "./dndm-character-sheet";
import {
  createDefaultAttributeSchema,
  createDefaultDndMapperState,
  type CharacterSheet,
} from "../../game/domain";

function makeSheet(id: string, name: string, ownerUserId: string | null = null): CharacterSheet {
  return {
    id,
    ownerUserId,
    representsUserId: null,
    characterName: name,
    values: {
      Strength: { kind: "Score", value: 16 },
      Dexterity: { kind: "Score", value: 14 },
      Constitution: { kind: "Score", value: 12 },
      Intelligence: { kind: "Score", value: 10 },
      Wisdom: { kind: "Score", value: 8 },
      Charisma: { kind: "Score", value: 13 },
    },
    notes: "Heroic adventurer notes",
    hp: 24,
    maxHp: 30,
    armorClass: 16,
    color: "#4a90e2",
    colorOverridden: false,
    scopedMapId: null,
    statusEffects: [
      {
        id: "eff-1",
        name: "Blessed",
        attributeDeltas: [],
        maxHpDelta: 5,
        onApplyHpDelta: null,
        notes: "Granted divine favor",
        appliedUtc: "2026-09-09T00:00:00Z",
      },
    ],
    rollTemplates: [],
  };
}

describe("<dndm-character-sheet>", () => {
  let el: DndmCharacterSheet;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("dndm-character-sheet") as DndmCharacterSheet;
    el.currentUserId = "dm-1";
  });

  afterEach(() => {
    vi.useRealTimers();
    el.remove();
  });

  it("renders roster chips, vitals, ability cards, and status effects", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";

    document.body.appendChild(el);
    await el.updateComplete;

    // Renders character name
    const nameInput = el.querySelector(".dndm-sheet-name-input") as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe("Thorin");

    // Renders HP bar and text: 24 / 35 HP (30 base + 5 from Blessed)
    const hpText = el.querySelector(".dndm-sheet-hp-text");
    expect(hpText?.textContent).toContain("24 / 35 HP");

    // Renders AC: 16
    expect(el.textContent).toContain("16");

    // Renders ability cards (STR 16 -> +3, DEX 14 -> +2, etc.)
    const scoreCards = el.querySelectorAll(".dndm-score-card");
    expect(scoreCards.length).toBe(6);
    expect(el.textContent).toContain("STR");
    expect(el.textContent).toContain("+3");

    // Renders status effect badge
    const badge = el.querySelector(".dndm-status-badge");
    expect(badge?.textContent).toContain("Blessed");
  });

  it("wraps the sheet section in a collapsible side-rail panel", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";

    document.body.appendChild(el);
    await el.updateComplete;

    const panel = el.querySelector("dndm-collapsible-panel");
    expect(panel).not.toBeNull();
    await (panel as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    // Header shows the section title; sheet content lives in the panel body.
    expect(panel?.querySelector(".dndm-panel-title-text")?.textContent).toContain(
      "Character Sheet",
    );
    expect(el.querySelector(".dndm-sheet-name-input")).not.toBeNull();

    // Clicking the header collapses the section.
    const section = panel?.querySelector(".dndm-panel") as HTMLElement;
    expect(section.classList.contains("dndm-panel--collapsed")).toBe(false);
    const header = panel?.querySelector(".dndm-panel-header") as HTMLElement;
    header.click();
    await (panel as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(section.classList.contains("dndm-panel--collapsed")).toBe(true);

    // Clicking again expands it.
    header.click();
    await (panel as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(section.classList.contains("dndm-panel--collapsed")).toBe(false);
  });

  it("shows full attribute names as tooltips on hover", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";

    document.body.appendChild(el);
    await el.updateComplete;

    // Ability cards abbreviate (STR) but expose the full name on hover.
    const labels = Array.from(el.querySelectorAll(".dndm-score-label"));
    expect(labels.length).toBe(6);
    const strLabel = labels.find((l) => l.textContent?.trim() === "STR");
    expect(strLabel?.getAttribute("title")).toBe("Strength");

    // Attribute table rows expose their full name on hover as well.
    const rowName = el.querySelector(".dndm-sheet-attr-row span");
    expect(rowName?.getAttribute("title")).toBe(rowName?.textContent);
  });

  it("debounces rapid typing in characterName by 300ms without saturating intents", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    const onUpdateSheet = vi.fn();

    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.onUpdateSheet = onUpdateSheet;

    document.body.appendChild(el);
    await el.updateComplete;

    const nameInput = el.querySelector(".dndm-sheet-name-input") as HTMLInputElement;
    expect(nameInput).not.toBeNull();

    // Fast typing: 'T', 'Th', 'Thor', 'Thorin Oakenshield' at 50ms intervals
    nameInput.value = "T";
    nameInput.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(50);
    expect(onUpdateSheet).not.toHaveBeenCalled();

    nameInput.value = "Th";
    nameInput.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(50);
    expect(onUpdateSheet).not.toHaveBeenCalled();

    nameInput.value = "Thor";
    nameInput.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(50);
    expect(onUpdateSheet).not.toHaveBeenCalled();

    nameInput.value = "Thorin Oakenshield";
    nameInput.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(100);
    expect(onUpdateSheet).not.toHaveBeenCalled();

    // Now advance past 300ms since last keystroke
    vi.advanceTimersByTime(250);
    expect(onUpdateSheet).toHaveBeenCalledTimes(1);
    expect(onUpdateSheet).toHaveBeenCalledWith("sheet-1", { characterName: "Thorin Oakenshield" });
  });

  it("opens an HP popover from the vitals and steps +1 immediately", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    const onSetSheetHp = vi.fn();

    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.onSetSheetHp = onSetSheetHp;

    document.body.appendChild(el);
    await el.updateComplete;

    // No inline stepper buttons anymore; HP is edited via popover.
    expect(el.querySelector(".dndm-sheet-step-btn")).toBeNull();

    // Click the HP value button to open the popover.
    const hpBtn = Array.from(el.querySelectorAll(".dndm-sheet-value-btn")).find((b) =>
      b.textContent?.includes("/"),
    ) as HTMLButtonElement;
    expect(hpBtn).toBeDefined();
    hpBtn.click();
    await el.updateComplete;

    const popover = el.querySelector(".dndm-number-popover");
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain("Current");
    expect(popover?.textContent).toContain("Max");

    // Step current HP up via the increase button in the Current row.
    const rows = Array.from(popover!.querySelectorAll(".dndm-number-popover-row"));
    const currentRow = rows.find((r) => r.textContent?.includes("Current"))!;
    const upBtn = currentRow.querySelector(
      'button[title="Increase HP"]',
    ) as HTMLButtonElement;
    expect(upBtn).not.toBeNull();
    upBtn.click();
    // Immediate: called synchronously without waiting for debounce timer!
    expect(onSetSheetHp).toHaveBeenCalledTimes(1);
    expect(onSetSheetHp).toHaveBeenCalledWith("sheet-1", 25);
  });

  it("shows current and max HP to a viewer who cannot edit the sheet", async () => {
    // Owner viewing their own sheet under the default HostOnly edit policy:
    // can view HP but cannot edit it.
    const sheet1 = makeSheet("sheet-1", "Thorin", "player-1");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = false;
    el.currentUserId = "player-1";

    document.body.appendChild(el);
    await el.updateComplete;

    // Read-only: no edit popover buttons, but the HP stat still shows max.
    expect(el.querySelector(".dndm-sheet-value-btn")).toBeNull();
    expect(el.querySelector(".dndm-number-popover")).toBeNull();
    const statBox = Array.from(el.querySelectorAll(".dndm-sheet-stat-box")).find((b) =>
      b.textContent?.includes("HP:"),
    );
    expect(statBox).toBeDefined();
    // 24 current / 35 effective max (30 base + 5 from Blessed).
    expect(statBox?.textContent).toContain("24 / 35");
    // No stray template characters leak into the read-only text.
    expect(statBox?.textContent).not.toContain("}");
  });

  it("opens an AC popover and commits a typed custom number", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    const onSetSheetAc = vi.fn();

    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.onSetSheetAc = onSetSheetAc;

    document.body.appendChild(el);
    await el.updateComplete;

    const acBtn = el.querySelector(".dndm-sheet-value-btn--ac") as HTMLButtonElement;
    expect(acBtn).toBeDefined();
    acBtn.click();
    await el.updateComplete;

    const popover = el.querySelector(".dndm-number-popover");
    expect(popover).not.toBeNull();
    const input = popover!.querySelector(".dndm-number-popover-input") as HTMLInputElement;
    expect(input.value).toBe("16");

    input.value = "18";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("change"));
    expect(onSetSheetAc).toHaveBeenCalledTimes(1);
    expect(onSetSheetAc).toHaveBeenCalledWith("sheet-1", 18);
  });

  it("opens an attribute popover from an ability card and debounces typed input", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    const onUpdateAttributeValues = vi.fn();

    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.onUpdateAttributeValues = onUpdateAttributeValues;

    document.body.appendChild(el);
    await el.updateComplete;

    // Ability cards render value buttons instead of inline number inputs.
    expect(el.querySelector(".dndm-sheet-scores-grid input[type='number']")).toBeNull();
    const scoreBtn = el.querySelector(
      ".dndm-sheet-value-btn--score",
    ) as HTMLButtonElement;
    expect(scoreBtn).toBeDefined();
    expect(scoreBtn.textContent?.trim()).toBe("16");
    scoreBtn.click();
    await el.updateComplete;

    const popover = el.querySelector(".dndm-number-popover");
    expect(popover).not.toBeNull();
    const input = popover!.querySelector(".dndm-number-popover-input") as HTMLInputElement;
    expect(input.value).toBe("16");

    input.value = "18";
    input.dispatchEvent(new Event("input"));
    expect(onUpdateAttributeValues).not.toHaveBeenCalled();
    input.dispatchEvent(new Event("change"));
    await el.updateComplete;
    expect(onUpdateAttributeValues).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onUpdateAttributeValues).toHaveBeenCalledTimes(1);
    expect(onUpdateAttributeValues).toHaveBeenCalledWith(
      "sheet-1",
      expect.objectContaining({ Strength: { kind: "Score", value: 18 } }),
    );
  });

  it("commits max HP from the HP popover", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    const onSetSheetMaxHp = vi.fn();

    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.onSetSheetMaxHp = onSetSheetMaxHp;

    document.body.appendChild(el);
    await el.updateComplete;

    const hpBtn = Array.from(el.querySelectorAll(".dndm-sheet-value-btn")).find((b) =>
      b.textContent?.includes("/"),
    ) as HTMLButtonElement;
    hpBtn.click();
    await el.updateComplete;

    const popover = el.querySelector(".dndm-number-popover")!;
    const rows = Array.from(popover.querySelectorAll(".dndm-number-popover-row"));
    const maxRow = rows.find((r) => r.textContent?.includes("Max"))!;
    const input = maxRow.querySelector(".dndm-number-popover-input") as HTMLInputElement;
    expect(input.value).toBe("30");

    input.value = "40";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("change"));
    expect(onSetSheetMaxHp).toHaveBeenCalledTimes(1);
    expect(onSetSheetMaxHp).toHaveBeenCalledWith("sheet-1", 40);
  });

  it("hides unowned sheets and respects player visibility settings", async () => {
    const npcSheet = makeSheet("sheet-npc", "Goblin", null); // unassigned NPC
    const playerSheet = makeSheet("sheet-p1", "Alice Hero", "player-1");

    el.sheets = { "sheet-npc": npcSheet, "sheet-p1": playerSheet };
    el.isDm = false;
    el.currentUserId = "player-1";
    el.settings = { ...createDefaultDndMapperState().settings, playersCanSeeOtherSheets: false };

    document.body.appendChild(el);
    await el.updateComplete;

    // Player 1 sees Alice Hero chip
    expect(el.textContent).toContain("Alice Hero");
    // Player 1 cannot see NPC Goblin chip
    expect(el.textContent).not.toContain("Goblin");
  });

  it("closes the open sheet when map scope filters it out of the list", async () => {
    const scoped = { ...makeSheet("sheet-scoped", "Shopkeep"), scopedMapId: "map-a" };
    el.sheets = { "sheet-scoped": scoped };
    el.selectedSheetId = "sheet-scoped";
    el.activeMapId = "map-b";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;

    document.body.appendChild(el);
    await el.updateComplete;

    // Scoped to another map: no chip, no open body — but selection retained.
    expect(el.textContent).not.toContain("Shopkeep");
    expect(el.querySelector(".dndm-sheet-name-input")).toBeNull();
    expect(el.selectedSheetId).toBe("sheet-scoped");

    // Returning to the scoped map restores the open sheet.
    el.activeMapId = "map-a";
    await el.updateComplete;
    const nameInput = el.querySelector(".dndm-sheet-name-input") as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe("Shopkeep");
  });

  it("closes the open sheet while the search query excludes it", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;

    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.querySelector(".dndm-sheet-name-input")).not.toBeNull();

    const search = el.querySelector(".dndm-sheet-search") as HTMLInputElement;
    search.value = "zzz-no-match";
    search.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect(el.querySelector(".dndm-sheet-name-input")).toBeNull();
    expect(el.selectedSheetId).toBe("sheet-1");

    search.value = "";
    search.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect(el.querySelector(".dndm-sheet-name-input")).not.toBeNull();
  });

  it("keeps the side rail title bar minimal; owner + actions live in the settings modal", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin", null);
    const onPlaceToken = vi.fn();
    const onDuplicateSheet = vi.fn();
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.activeMapId = "map-a";
    el.dmPlayerId = "dm-1";
    // Roster as the app provides it: lobby players mapped to display entries.
    el.roster = [
      { id: "dm-1", name: "Dungeon Master" },
      { id: "player-1", name: "Alice" },
      { id: "player-2", name: "Bob" },
    ];
    el.onPlaceToken = onPlaceToken;
    el.onDuplicateSheet = onDuplicateSheet;

    document.body.appendChild(el);
    await el.updateComplete;

    // Side rail title bar: gear + name only — no owner dropdown, no action buttons.
    expect(el.querySelector('select[title="Assign Owner"]')).toBeNull();
    const titleBar = el.querySelector(".dndm-sheet-header-title-bar");
    expect(titleBar?.textContent).not.toContain("Place token");
    expect(titleBar?.textContent).not.toContain("Copy");

    // Open settings via the gear button.
    const gear = titleBar?.querySelector(
      'button[title="Sheet Settings"]',
    ) as HTMLButtonElement;
    expect(gear).toBeDefined();
    gear.click();
    await el.updateComplete;

    const modal = el.querySelector("dndm-sheet-settings-modal");
    expect(modal).not.toBeNull();
    // Flush nested modal renders (settings modal -> dndm-modal body).
    await (modal as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const inner = modal!.querySelector("dndm-modal");
    if (inner) {
      await (inner as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    }
    await el.updateComplete;

    // Owner assignment still available in the modal with player names only.
    const selects = Array.from(modal!.querySelectorAll("select"));
    const ownerOptions = Array.from(selects[0]?.querySelectorAll("option") ?? []).map((o) =>
      o.textContent?.trim(),
    );
    expect(ownerOptions).toContain("Alice");
    expect(ownerOptions).toContain("Bob");
    expect(ownerOptions).not.toContain("Dungeon Master");
    for (const text of ownerOptions) {
      expect(text).not.toBe("");
    }

    // Sheet actions in the modal forward to the sheet callbacks.
    const modalButtons = Array.from(modal!.querySelectorAll<HTMLButtonElement>("button"));
    const placeBtn = modalButtons.find((b) => b.textContent?.trim() === "Place token");
    const copyBtn = modalButtons.find((b) => b.textContent?.trim() === "Copy");
    expect(placeBtn).toBeDefined();
    expect(copyBtn).toBeDefined();

    placeBtn!.click();
    expect(onPlaceToken).toHaveBeenCalledTimes(1);
    expect(onPlaceToken).toHaveBeenCalledWith("sheet-1");

    copyBtn!.click();
    expect(onDuplicateSheet).toHaveBeenCalledTimes(1);
    expect(onDuplicateSheet).toHaveBeenCalledWith("sheet-1");
  });

  it("calls onCreateSheet with the active map scope when the + button is clicked", async () => {
    const onCreateSheet = vi.fn();
    el.sheets = {};
    el.selectedSheetId = null;
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";
    el.activeMapId = "map-a";
    el.onCreateSheet = onCreateSheet;

    document.body.appendChild(el);
    await el.updateComplete;
    const panel = el.querySelector(
      "dndm-collapsible-panel",
    ) as unknown as { updateComplete: Promise<unknown> } | null;
    if (panel) await panel.updateComplete;
    await el.updateComplete;

    const btn = el.querySelector(
      'button[title="New character sheet"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onCreateSheet).toHaveBeenCalledTimes(1);
    expect(onCreateSheet).toHaveBeenCalledWith("New Character", "map-a");
  });
});
