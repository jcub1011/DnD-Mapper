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

  it("emits immediate intent when HP stepper buttons are clicked", async () => {
    const sheet1 = makeSheet("sheet-1", "Thorin");
    const onSetSheetHp = vi.fn();

    el.sheets = { "sheet-1": sheet1 };
    el.selectedSheetId = "sheet-1";
    el.attributeSchema = createDefaultAttributeSchema("DnD5eCore");
    el.isDm = true;
    el.onSetSheetHp = onSetSheetHp;

    document.body.appendChild(el);
    await el.updateComplete;

    // Click +1 HP button
    const stepBtns = el.querySelectorAll(".dndm-sheet-step-btn");
    const plusOneBtn = Array.from(stepBtns).find((b) => b.textContent?.trim() === "+1") as HTMLButtonElement;
    expect(plusOneBtn).toBeDefined();

    plusOneBtn.click();
    // Immediate: called synchronously without waiting for debounce timer!
    expect(onSetSheetHp).toHaveBeenCalledTimes(1);
    expect(onSetSheetHp).toHaveBeenCalledWith("sheet-1", 25);
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
});
