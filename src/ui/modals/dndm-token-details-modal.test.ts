// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CharacterSheet, Token } from "../../game/domain.js";
import "./dndm-token-details-modal.js";
import type { DndmTokenDetailsModal } from "./dndm-token-details-modal.js";

function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: "t1",
    mapId: "m1",
    name: "Goblin",
    color: "#1e88e5",
    type: "NPCToken",
    iconKind: "Initial",
    x: 5.5,
    y: 8.5,
    hidden: false,
    ownerUserId: null,
    representsUserId: null,
    sheetId: null,
    ...overrides,
  };
}

function makeSheets(): Record<string, CharacterSheet> {
  return {
    s1: { id: "s1", characterName: "Aria" } as unknown as CharacterSheet,
    s2: { id: "s2", characterName: "Bob" } as unknown as CharacterSheet,
  };
}

async function sheetSelect(el: DndmTokenDetailsModal): Promise<HTMLSelectElement> {
  // GameElement renders in light DOM (see GameElement.createRenderRoot).
  await el.updateComplete;
  const modal = el.querySelector("dndm-modal") as unknown as {
    updateComplete: Promise<unknown>;
  } | null;
  expect(modal).not.toBeNull();
  await modal!.updateComplete;
  const selects = el.querySelectorAll("dndm-modal select");
  // First select is icon style, second is character sheet.
  expect(selects.length).toBe(2);
  return selects[1] as HTMLSelectElement;
}

describe("<dndm-token-details-modal> sheet assignment", () => {
  let el: DndmTokenDetailsModal;

  afterEach(() => {
    el?.remove();
  });

  it("applies the sheet choice immediately so closing without Save keeps it", async () => {
    el = document.createElement("dndm-token-details-modal") as DndmTokenDetailsModal;
    const onReassign = vi.fn();
    el.token = makeToken();
    el.sheets = makeSheets();
    el.isDm = true;
    el.isOpen = true;
    el.onReassignTokenSheet = onReassign;
    document.body.appendChild(el);

    const select = await sheetSelect(el);
    expect(select.value).toBe("");
    select.value = "s1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onReassign).toHaveBeenCalledWith("t1", "s1");
  });

  it("still shows the assigned sheet after close + reopen before the server echo", async () => {
    el = document.createElement("dndm-token-details-modal") as DndmTokenDetailsModal;
    el.token = makeToken();
    el.sheets = makeSheets();
    el.isDm = true;
    el.isOpen = true;
    el.onReassignTokenSheet = vi.fn();
    document.body.appendChild(el);

    const select = await sheetSelect(el);
    select.value = "s1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await el.updateComplete;

    // Close without Save (Cancel/X), then reopen with the STALE token
    // (server echo has not arrived yet).
    el.isOpen = false;
    el.token = null;
    await el.updateComplete;
    el.token = makeToken();
    el.isOpen = true;

    const reopened = await sheetSelect(el);
    expect(reopened.value).toBe("s1");
  });

  it("adopts the server echo once it arrives", async () => {    el = document.createElement("dndm-token-details-modal") as DndmTokenDetailsModal;
    el.token = makeToken();
    el.sheets = makeSheets();
    el.isDm = true;
    el.isOpen = true;
    el.onReassignTokenSheet = vi.fn();
    document.body.appendChild(el);

    const select = await sheetSelect(el);
    select.value = "s2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await el.updateComplete;

    // Server confirms: token now linked, renamed per sheet identity.
    el.token = makeToken({ sheetId: "s2", name: "Bob", type: "NPCToken" });
    const confirmed = await sheetSelect(el);
    expect(confirmed.value).toBe("s2");
  });

  it("shows the persisted sheet when the echo arrives while closed", async () => {
    el = document.createElement("dndm-token-details-modal") as DndmTokenDetailsModal;
    el.token = makeToken();
    el.sheets = makeSheets();
    el.isDm = true;
    el.isOpen = true;
    el.onReassignTokenSheet = vi.fn();
    document.body.appendChild(el);

    const select = await sheetSelect(el);
    select.value = "s1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await el.updateComplete;

    // Close, then the server echo lands while closed.
    el.isOpen = false;
    el.token = null;
    await el.updateComplete;

    // Reopen with the CONFIRMED server token.
    el.token = makeToken({ sheetId: "s1", name: "Aria", type: "NPCToken" });
    el.isOpen = true;

    const reopened = await sheetSelect(el);
    expect(reopened.value).toBe("s1");
  });
});
