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

  it("shows header actions in the side rail; owner assignment lives in the settings modal", async () => {
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

    // Side rail title bar: color + name only — no owner dropdown.
    expect(el.querySelector('select[title="Assign Owner"]')).toBeNull();
    const titleBar = el.querySelector(".dndm-sheet-header-title-bar");
    expect(titleBar?.querySelector(".dndm-sheet-name-input")).not.toBeNull();
    expect(titleBar?.querySelector(".dndm-sheet-color-dot")).not.toBeNull();
    expect(titleBar?.textContent).not.toContain("Place token");
    expect(titleBar?.textContent).not.toContain("Copy");

    // Header action row: settings, add token, copy, scope toggle (icon buttons).
    const actionRow = el.querySelector(".dndm-sheet-header-actions");
    expect(actionRow).not.toBeNull();
    expect(actionRow?.querySelector('button[aria-label="Place token"]')).not.toBeNull();
    expect(actionRow?.querySelector('button[aria-label="Duplicate sheet"]')).not.toBeNull();
    expect(actionRow?.querySelector(".dndm-sheet-scope-toggle")).not.toBeNull();

    // Open settings via the gear button in the action row.
    const gear = actionRow?.querySelector(
      'button[aria-label="Sheet Settings"]',
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

  it("exposes color, header actions, and scope toggle in the side rail header", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin", null);
    const onUpdateSheet = vi.fn();
    const onPlaceToken = vi.fn();
    const onDuplicateSheet = vi.fn();
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";
    el.activeMapId = "map-a";
    el.onUpdateSheet = onUpdateSheet;
    el.onPlaceToken = onPlaceToken;
    el.onDuplicateSheet = onDuplicateSheet;

    document.body.appendChild(el);
    await el.updateComplete;

    // Color picker is left of the name line for editors.
    const colorInput = el.querySelector(
      ".dndm-sheet-header-title-bar .dndm-sheet-color-input",
    ) as HTMLInputElement;
    expect(colorInput).not.toBeNull();
    colorInput.value = "#ff0000";
    colorInput.dispatchEvent(new Event("input"));
    expect(onUpdateSheet).toHaveBeenCalledWith("sheet-1", { color: "#ff0000" });

    // Header action row forwards place-token and duplicate (icon buttons).
    const actionRow = el.querySelector(".dndm-sheet-header-actions");
    expect(actionRow).not.toBeNull();
    const addTokenBtn = actionRow!.querySelector(
      'button[aria-label="Place token"]',
    ) as HTMLButtonElement;
    expect(addTokenBtn).not.toBeNull();
    // Icon buttons carry an SVG, not a text label.
    expect(addTokenBtn.querySelector("svg")).not.toBeNull();
    addTokenBtn.click();
    expect(onPlaceToken).toHaveBeenCalledWith("sheet-1");

    const copyBtn = actionRow!.querySelector(
      'button[aria-label="Duplicate sheet"]',
    ) as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.querySelector("svg")).not.toBeNull();
    copyBtn.click();
    expect(onDuplicateSheet).toHaveBeenCalledWith("sheet-1");

    // DM-only scope toggle: global sheet scopes to the active map.
    const toggle = actionRow!.querySelector(
      ".dndm-sheet-scope-toggle",
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.textContent?.trim()).toBe("Global");
    // Text button: uses text-button styling, not icon-button sizing.
    expect(toggle.classList.contains("dndm-btn--icon")).toBe(false);
    toggle.click();
    expect(onUpdateSheet).toHaveBeenCalledWith("sheet-1", { scopedMapId: "map-a" });

    // Every header button explains itself via a tooltip.
    const headerButtons = Array.from(
      actionRow!.querySelectorAll<HTMLButtonElement>("button"),
    );
    expect(headerButtons.length).toBe(4);
    for (const btn of headerButtons) {
      expect(btn.getAttribute("title")?.trim().length).toBeGreaterThan(0);
    }
  });

  it("explains the disabled place-token button via its tooltip", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin", null);
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";
    el.activeMapId = null;
    el.maps = [];

    document.body.appendChild(el);
    await el.updateComplete;

    const addTokenBtn = el.querySelector(
      '.dndm-sheet-header-actions button[aria-label="Place token"]',
    ) as HTMLButtonElement;
    expect(addTokenBtn).not.toBeNull();
    expect(addTokenBtn.disabled).toBe(true);
    expect(addTokenBtn.getAttribute("title")).toContain("Open a map");
  });

  it("toggles notes between edit and preview with a single flipping button", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";

    document.body.appendChild(el);
    await el.updateComplete;

    const notesContainer = el.querySelector(".dndm-sheet-notes-container")!;
    expect(notesContainer).not.toBeNull();

    // Starts in edit mode: textarea visible, toggle offers Preview.
    expect(notesContainer.querySelector(".dndm-sheet-notes-textarea")).not.toBeNull();
    const toggle = notesContainer.querySelector(".dndm-notes-toggle") as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toContain("Preview");

    // Modal + popout icon buttons sit to the right of the toggle.
    expect(
      notesContainer.querySelector('button[aria-label="Open notes in modal"]'),
    ).not.toBeNull();
    expect(
      notesContainer.querySelector('button[aria-label="Open notes in new window"]'),
    ).not.toBeNull();

    toggle.click();
    await el.updateComplete;

    // Flipped to preview: rendered markdown visible, toggle offers Edit.
    expect(notesContainer.querySelector(".dndm-sheet-notes-textarea")).toBeNull();
    expect(notesContainer.querySelector(".dndm-sheet-notes-preview")).not.toBeNull();
    const flipped = notesContainer.querySelector(".dndm-notes-toggle") as HTMLButtonElement;
    expect(flipped.getAttribute("aria-pressed")).toBe("false");
    expect(flipped.textContent).toContain("Edit");

    flipped.click();
    await el.updateComplete;
    expect(notesContainer.querySelector(".dndm-sheet-notes-textarea")).not.toBeNull();
  });

  it("grows the rail notes editor to fit its content", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";

    document.body.appendChild(el);
    await el.updateComplete;

    const area = el.querySelector(
      ".dndm-sheet-notes-container > .dndm-sheet-notes-textarea",
    ) as HTMLTextAreaElement;
    expect(area).not.toBeNull();
    // happy-dom has no layout engine (scrollHeight 0), so simulate one.
    Object.defineProperty(area, "scrollHeight", { value: 200, configurable: true });

    area.value = "line1\nline2";
    area.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect(area.style.height).toBe("200px");

    // Shrinking content shrinks the editor back down.
    Object.defineProperty(area, "scrollHeight", { value: 60, configurable: true });
    area.value = "short";
    area.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect(area.style.height).toBe("60px");
  });

  it("opens the notes modal pinned to the sheet with live-synced edits", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    const onUpdateSheet = vi.fn();
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";
    el.onUpdateSheet = onUpdateSheet;

    document.body.appendChild(el);
    await el.updateComplete;

    const expandBtn = el.querySelector(
      '.dndm-sheet-notes-container button[aria-label="Open notes in modal"]',
    ) as HTMLButtonElement;
    expandBtn.click();
    await el.updateComplete;

    const modal = el.querySelector("dndm-notes-modal") as unknown as {
      updateComplete: Promise<unknown>;
    } & HTMLElement;
    expect(modal).not.toBeNull();
    await modal.updateComplete;
    const innerModal = modal.querySelector("dndm-modal") as unknown as {
      updateComplete: Promise<unknown>;
    } & HTMLElement;
    await innerModal.updateComplete;

    // Modal mirrors the sheet notes and offers its own edit/preview toggle.
    const modalTextarea = modal.querySelector(
      ".dndm-notes-modal-textarea",
    ) as HTMLTextAreaElement;
    expect(modalTextarea).not.toBeNull();
    expect(modalTextarea.value).toBe("Heroic adventurer notes");
    // Toggle lives in the modal header, next to the title — not the body.
    const headerToggle = modal.querySelector(
      ".dndm-modal-title .dndm-notes-toggle",
    ) as HTMLButtonElement;
    expect(headerToggle).not.toBeNull();

    // Typing in the modal flows through the same debounced update-sheet path.
    modalTextarea.value = "Updated from modal";
    modalTextarea.dispatchEvent(new Event("input"));
    expect(onUpdateSheet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onUpdateSheet).toHaveBeenCalledWith("sheet-1", { notes: "Updated from modal" });

    // Modal toggle flips to preview rendering the edited notes.
    const modalToggle = modal.querySelector(".dndm-notes-toggle") as HTMLButtonElement;
    modalToggle.click();
    await el.updateComplete;
    await modal.updateComplete;
    expect(modal.querySelector(".dndm-notes-modal-preview")).not.toBeNull();
  });

  it("locks read-only viewers to notes preview with a disabled toggle", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin", "player-1");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = false;
    el.currentUserId = "player-1";

    document.body.appendChild(el);
    await el.updateComplete;

    const notesContainer = el.querySelector(".dndm-sheet-notes-container")!;
    expect(notesContainer.querySelector(".dndm-sheet-notes-textarea")).toBeNull();
    expect(notesContainer.querySelector(".dndm-sheet-notes-preview")).not.toBeNull();
    const toggle = notesContainer.querySelector(".dndm-notes-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);

    // Modal opens locked to preview for viewers without edit permission.
    const expandBtn = notesContainer.querySelector(
      'button[aria-label="Open notes in modal"]',
    ) as HTMLButtonElement;
    expandBtn.click();
    await el.updateComplete;
    const modal = el.querySelector("dndm-notes-modal") as unknown as {
      updateComplete: Promise<unknown>;
    } & HTMLElement;
    expect(modal).not.toBeNull();
    await modal.updateComplete;
    expect(modal.querySelector(".dndm-notes-modal-textarea")).toBeNull();
    expect(modal.querySelector(".dndm-notes-modal-preview")).not.toBeNull();
    expect(
      (modal.querySelector(".dndm-notes-toggle") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("opens the notes popout window with the sheet content", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";

    document.body.appendChild(el);
    await el.updateComplete;

    const fakeDoc = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
    const fakeWindow = { closed: false, document: fakeDoc };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeWindow as unknown as Window);

    try {
      const popoutBtn = el.querySelector(
        '.dndm-sheet-notes-container button[aria-label="Open notes in new window"]',
      ) as HTMLButtonElement;
      popoutBtn.click();
      await el.updateComplete;

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(fakeDoc.write).toHaveBeenCalledTimes(1);
      const html = fakeDoc.write.mock.calls[0][0] as string;
      expect(html).toContain("Thorin");
      expect(html).toContain("dndm-notes-sync");
      expect(html).toContain("Heroic adventurer notes");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("acknowledges popout edits post-render instead of echoing mid-keystroke", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.currentUserId = "dm-1";

    document.body.appendChild(el);
    await el.updateComplete;

    const fakeDoc = { open: vi.fn(), write: vi.fn(), close: vi.fn() };
    const fakeWindow = { closed: false, document: fakeDoc };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeWindow as unknown as Window);

    try {
      const popoutBtn = el.querySelector(
        '.dndm-sheet-notes-container button[aria-label="Open notes in new window"]',
      ) as HTMLButtonElement;
      popoutBtn.click();
      await el.updateComplete;

      // Deterministic channel regardless of test-environment support.
      const inner = el as unknown as {
        notesChannel: { postMessage: (...args: unknown[]) => void; close: () => void } | null;
        handleNotesChannelMessage: (msg: unknown) => void;
      };
      const postMessage = vi.fn();
      inner.notesChannel = { postMessage, close: vi.fn() };

      // A fast-typed popout send must not be echoed back synchronously:
      // that echo carries older text than the popup holds and clobbers it.
      inner.handleNotesChannelMessage({
        type: "notes-edit",
        sheetId: "sheet-1",
        notes: "Typed fast",
      });
      expect(postMessage).not.toHaveBeenCalled();

      // The acknowledgement goes out once, post-render, with identical text.
      await el.updateComplete;
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "notes-state", notes: "Typed fast" }),
      );
    } finally {
      openSpy.mockRestore();
    }
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
