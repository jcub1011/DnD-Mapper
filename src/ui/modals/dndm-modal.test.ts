// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html } from "lit";
import "./dndm-modal.js";
import type { DndmModal } from "./dndm-modal.js";
import "./dndm-confirm.js";
import type { DndmConfirm } from "./dndm-confirm.js";
import "./dndm-loaded-dice-modal.js";
import type { DndmLoadedDiceModal } from "./dndm-loaded-dice-modal.js";
import "./dndm-map-settings.js";
import type { DndmMapSettings } from "./dndm-map-settings.js";
import "./dndm-schema-preset-modal.js";
import type { DndmSchemaPresetModal } from "./dndm-schema-preset-modal.js";
import "./dndm-schema-cascade-warning.js";
import type { DndmSchemaCascadeWarning } from "./dndm-schema-cascade-warning.js";
import "./dndm-status-effect-library-modal.js";
import type { DndmStatusEffectLibraryModal } from "./dndm-status-effect-library-modal.js";
import "./dndm-sheet-settings-modal.js";
import type { DndmSheetSettingsModal } from "./dndm-sheet-settings-modal.js";
import "./dndm-permissions.js";
import type { DndmPermissions } from "./dndm-permissions.js";
import "./dndm-roll-template-library.js";
import type { DndmRollTemplateLibrary } from "./dndm-roll-template-library.js";

describe("<dndm-modal>", () => {
  let modal: DndmModal;

  beforeEach(() => {
    modal = document.createElement("dndm-modal") as DndmModal;
  });

  afterEach(() => {
    modal.remove();
  });

  it("does not render dialog when isOpen is false", async () => {
    modal.isOpen = false;
    modal.modalTitle = "Test Modal";
    document.body.appendChild(modal);
    await modal.updateComplete;

    const dialog = modal.querySelector("dialog");
    expect(dialog).toBeNull();
  });

  it("renders dialog and calls showModal() when isOpen is true", async () => {
    modal.isOpen = true;
    modal.modalTitle = "Test Modal";
    document.body.appendChild(modal);
    await modal.updateComplete;

    const dialog = modal.querySelector<HTMLDialogElement>("dialog.dndm-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.open).toBe(true);

    const title = modal.querySelector(".dndm-modal-title");
    expect(title?.textContent?.trim()).toBe("Test Modal");
  });

  it("renders body and footer content", async () => {
    modal.isOpen = true;
    modal.modalTitle = "Content Test";
    modal.body = html`<p class="test-body-content">Body Paragraph</p>`;
    modal.footer = html`<button class="test-footer-btn" type="button">Action</button>`;
    document.body.appendChild(modal);
    await modal.updateComplete;

    const bodyEl = modal.querySelector(".test-body-content");
    expect(bodyEl).not.toBeNull();
    expect(bodyEl!.textContent).toBe("Body Paragraph");

    const footerBtn = modal.querySelector(".test-footer-btn");
    expect(footerBtn).not.toBeNull();
    expect(footerBtn!.textContent).toBe("Action");
  });

  it("renders a centered SVG icon inside close button", async () => {
    modal.isOpen = true;
    modal.modalTitle = "Icon Test";
    document.body.appendChild(modal);
    await modal.updateComplete;

    const closeBtn = modal.querySelector<HTMLButtonElement>(".dndm-modal-close-btn");
    expect(closeBtn).not.toBeNull();
    const svg = closeBtn?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg?.querySelector("path")).not.toBeNull();
  });

  it("sets isOpen to false, dispatches close & cancel events, and invokes callbacks on close button click", async () => {
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    const closeEventSpy = vi.fn();
    const cancelEventSpy = vi.fn();

    modal.isOpen = true;
    modal.modalTitle = "Close Button Test";
    modal.onClose = onCloseSpy;
    modal.onCancel = onCancelSpy;
    modal.addEventListener("close", closeEventSpy);
    modal.addEventListener("cancel", cancelEventSpy);
    document.body.appendChild(modal);
    await modal.updateComplete;

    const closeBtn = modal.querySelector<HTMLButtonElement>(".dndm-modal-close-btn");
    expect(closeBtn).not.toBeNull();

    closeBtn!.click();
    expect(modal.isOpen).toBe(false);
    expect(closeEventSpy).toHaveBeenCalledTimes(1);
    expect(cancelEventSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
  });

  it("handles Escape key cancel event", async () => {
    const onCloseSpy = vi.fn();
    modal.isOpen = true;
    modal.modalTitle = "Escape Test";
    modal.onClose = onCloseSpy;
    document.body.appendChild(modal);
    await modal.updateComplete;

    const dialog = modal.querySelector<HTMLDialogElement>("dialog.dndm-dialog");
    expect(dialog).not.toBeNull();

    const cancelEvent = new Event("cancel", { bubbles: true, cancelable: true });
    dialog!.dispatchEvent(cancelEvent);

    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  it("closes when clicking outside the modal card (on the dialog backdrop)", async () => {
    const onCloseSpy = vi.fn();
    modal.isOpen = true;
    modal.modalTitle = "Backdrop Click Test";
    modal.onClose = onCloseSpy;
    document.body.appendChild(modal);
    await modal.updateComplete;

    const dialog = modal.querySelector<HTMLDialogElement>("dialog.dndm-dialog");
    expect(dialog).not.toBeNull();

    // Mock bounding box for card
    const card = modal.querySelector<HTMLElement>(".dndm-modal-card");
    vi.spyOn(card!, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 300,
      left: 100,
      right: 400,
      width: 300,
      height: 200,
      x: 100,
      y: 100,
      toJSON: () => {},
    });

    // Click at coordinate (50, 50) outside the card
    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      clientX: 50,
      clientY: 50,
    });
    dialog!.dispatchEvent(clickEvent);

    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT close when clicking inside the modal card", async () => {
    const onCloseSpy = vi.fn();
    modal.isOpen = true;
    modal.modalTitle = "Card Click Test";
    modal.onClose = onCloseSpy;
    document.body.appendChild(modal);
    await modal.updateComplete;

    const card = modal.querySelector<HTMLElement>(".dndm-modal-card");
    const clickEvent = new MouseEvent("click", { bubbles: true });
    card!.dispatchEvent(clickEvent);

    expect(onCloseSpy).not.toHaveBeenCalled();
  });

  it("respects dismissible=false by hiding close button and ignoring cancel", async () => {
    const onCloseSpy = vi.fn();
    modal.isOpen = true;
    modal.modalTitle = "Non-dismissible";
    modal.dismissible = false;
    modal.onClose = onCloseSpy;
    document.body.appendChild(modal);
    await modal.updateComplete;

    const closeBtn = modal.querySelector(".dndm-modal-close-btn");
    expect(closeBtn).toBeNull();

    const dialog = modal.querySelector<HTMLDialogElement>("dialog.dndm-dialog");
    dialog!.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
    expect(onCloseSpy).not.toHaveBeenCalled();
  });

  it("applies custom cardClass and cardStyle", async () => {
    modal.isOpen = true;
    modal.modalTitle = "Styling Test";
    modal.cardClass = "custom-card-class";
    modal.cardStyle = "max-width: 700px;";
    document.body.appendChild(modal);
    await modal.updateComplete;

    const card = modal.querySelector(".dndm-modal-card");
    expect(card?.classList.contains("custom-card-class")).toBe(true);
    expect(card?.getAttribute("style")).toContain("max-width: 700px");
  });

  it("<dndm-confirm> cancel button closes dialog, sets isOpen to false, and emits both cancel and close", async () => {
    const confirmEl = document.createElement("dndm-confirm") as DndmConfirm;
    confirmEl.isOpen = true;
    confirmEl.modalTitle = "Delete Item?";
    const onCancelSpy = vi.fn();
    const onCloseSpy = vi.fn();
    const cancelEvtSpy = vi.fn();
    const closeEvtSpy = vi.fn();
    confirmEl.onCancel = onCancelSpy;
    confirmEl.onClose = onCloseSpy;
    confirmEl.addEventListener("cancel", cancelEvtSpy);
    confirmEl.addEventListener("close", closeEvtSpy);
    document.body.appendChild(confirmEl);
    await confirmEl.updateComplete;

    const buttons = Array.from(confirmEl.querySelectorAll<HTMLButtonElement>("button.dndm-btn"));
    const cancelBtn = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).toBeDefined();

    cancelBtn!.click();
    await confirmEl.updateComplete;

    expect(confirmEl.isOpen).toBe(false);
    expect(cancelEvtSpy).toHaveBeenCalledTimes(1);
    expect(closeEvtSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    confirmEl.remove();
  });

  it("<dndm-loaded-dice-modal> cancel button closes dialog, sets isOpen to false, and emits both events", async () => {
    const diceModal = document.createElement("dndm-loaded-dice-modal") as DndmLoadedDiceModal;
    diceModal.isOpen = true;
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    const cancelEvtSpy = vi.fn();
    const closeEvtSpy = vi.fn();
    diceModal.onClose = onCloseSpy;
    diceModal.onCancel = onCancelSpy;
    diceModal.addEventListener("cancel", cancelEvtSpy);
    diceModal.addEventListener("close", closeEvtSpy);
    document.body.appendChild(diceModal);
    await diceModal.updateComplete;

    // Find the cancel button in footer
    const buttons = Array.from(diceModal.querySelectorAll<HTMLButtonElement>("button.dndm-btn"));
    const cancelBtn = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).toBeDefined();

    cancelBtn!.click();
    await diceModal.updateComplete;

    expect(diceModal.isOpen).toBe(false);
    expect(cancelEvtSpy).toHaveBeenCalledTimes(1);
    expect(closeEvtSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
    diceModal.remove();
  });

  it("<dndm-map-settings> cancel button closes dialog, sets isOpen to false, and emits both events", async () => {
    const mapSettings = document.createElement("dndm-map-settings") as DndmMapSettings;
    mapSettings.map = {
      id: "map-1",
      name: "Battlefield",
      grid: {
        widthCells: 20,
        heightCells: 20,
        cellPixels: 50,
        showGridLines: true,
        snapToGrid: true,
        lineColor: "#000000",
      },
    } as any;
    mapSettings.isOpen = true;
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    const cancelEvtSpy = vi.fn();
    const closeEvtSpy = vi.fn();
    mapSettings.onClose = onCloseSpy;
    mapSettings.onCancel = onCancelSpy;
    mapSettings.addEventListener("cancel", cancelEvtSpy);
    mapSettings.addEventListener("close", closeEvtSpy);
    document.body.appendChild(mapSettings);
    await mapSettings.updateComplete;

    const buttons = Array.from(mapSettings.querySelectorAll<HTMLButtonElement>("button.dndm-btn"));
    const cancelBtn = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).toBeDefined();

    cancelBtn!.click();
    await mapSettings.updateComplete;

    expect(mapSettings.isOpen).toBe(false);
    expect(cancelEvtSpy).toHaveBeenCalledTimes(1);
    expect(closeEvtSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
    mapSettings.remove();
  });

  it("<dndm-schema-preset-modal> cancel button closes dialog, sets isOpen to false, and emits both events", async () => {
    const presetModal = document.createElement("dndm-schema-preset-modal") as DndmSchemaPresetModal;
    presetModal.isOpen = true;
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    const cancelEvtSpy = vi.fn();
    const closeEvtSpy = vi.fn();
    presetModal.onClose = onCloseSpy;
    presetModal.onCancel = onCancelSpy;
    presetModal.addEventListener("cancel", cancelEvtSpy);
    presetModal.addEventListener("close", closeEvtSpy);
    document.body.appendChild(presetModal);
    await presetModal.updateComplete;

    const buttons = Array.from(presetModal.querySelectorAll<HTMLButtonElement>("button.dndm-btn"));
    const cancelBtn = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).toBeDefined();

    cancelBtn!.click();
    await presetModal.updateComplete;

    expect(presetModal.isOpen).toBe(false);
    expect(cancelEvtSpy).toHaveBeenCalledTimes(1);
    expect(closeEvtSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
    presetModal.remove();
  });

  it("<dndm-schema-cascade-warning> cancel button closes dialog, sets isOpen to false, and emits both events", async () => {
    const warningModal = document.createElement("dndm-schema-cascade-warning") as DndmSchemaCascadeWarning;
    warningModal.isOpen = true;
    warningModal.prunedAttributes = ["strength", "dexterity"];
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    const cancelEvtSpy = vi.fn();
    const closeEvtSpy = vi.fn();
    warningModal.onClose = onCloseSpy;
    warningModal.onCancel = onCancelSpy;
    warningModal.addEventListener("cancel", cancelEvtSpy);
    warningModal.addEventListener("close", closeEvtSpy);
    document.body.appendChild(warningModal);
    await warningModal.updateComplete;

    const buttons = Array.from(warningModal.querySelectorAll<HTMLButtonElement>("button.dndm-btn"));
    const cancelBtn = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).toBeDefined();

    cancelBtn!.click();
    await warningModal.updateComplete;

    expect(warningModal.isOpen).toBe(false);
    expect(cancelEvtSpy).toHaveBeenCalledTimes(1);
    expect(closeEvtSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
    warningModal.remove();
  });

  it("<dndm-status-effect-library-modal> cancel button closes dialog, sets isOpen to false, and emits both events", async () => {
    const effectModal = document.createElement("dndm-status-effect-library-modal") as DndmStatusEffectLibraryModal;
    effectModal.isOpen = true;
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    const cancelEvtSpy = vi.fn();
    const closeEvtSpy = vi.fn();
    effectModal.onClose = onCloseSpy;
    effectModal.onCancel = onCancelSpy;
    effectModal.addEventListener("cancel", cancelEvtSpy);
    effectModal.addEventListener("close", closeEvtSpy);
    document.body.appendChild(effectModal);
    await effectModal.updateComplete;

    const buttons = Array.from(effectModal.querySelectorAll<HTMLButtonElement>("button.dndm-btn"));
    const cancelBtn = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).toBeDefined();

    cancelBtn!.click();
    await effectModal.updateComplete;

    expect(effectModal.isOpen).toBe(false);
    expect(cancelEvtSpy).toHaveBeenCalledTimes(1);
    expect(closeEvtSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
    effectModal.remove();
  });

  it("<dndm-sheet-settings-modal> cancel button closes dialog, sets isOpen to false, and emits both events", async () => {
    const sheetModal = document.createElement("dndm-sheet-settings-modal") as DndmSheetSettingsModal;
    sheetModal.sheet = {
      id: "s-1",
      characterName: "Test Char",
      color: "#ff0000",
      ownerUserId: null,
      representsUserId: null,
      scopedMapId: null,
    } as any;
    sheetModal.isOpen = true;
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    const cancelEvtSpy = vi.fn();
    const closeEvtSpy = vi.fn();
    sheetModal.onClose = onCloseSpy;
    sheetModal.onCancel = onCancelSpy;
    sheetModal.addEventListener("cancel", cancelEvtSpy);
    sheetModal.addEventListener("close", closeEvtSpy);
    document.body.appendChild(sheetModal);
    await sheetModal.updateComplete;

    const buttons = Array.from(sheetModal.querySelectorAll<HTMLButtonElement>("button.dndm-btn"));
    const cancelBtn = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).toBeDefined();

    cancelBtn!.click();
    await sheetModal.updateComplete;

    expect(sheetModal.isOpen).toBe(false);
    expect(cancelEvtSpy).toHaveBeenCalledTimes(1);
    expect(closeEvtSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
    sheetModal.remove();
  });

  it("<dndm-permissions> close button closes dialog, sets isOpen to false, and emits events", async () => {
    const permModal = document.createElement("dndm-permissions") as DndmPermissions;
    permModal.isOpen = true;
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    const cancelEvtSpy = vi.fn();
    const closeEvtSpy = vi.fn();
    permModal.onClose = onCloseSpy;
    permModal.onCancel = onCancelSpy;
    permModal.addEventListener("cancel", cancelEvtSpy);
    permModal.addEventListener("close", closeEvtSpy);
    document.body.appendChild(permModal);
    await permModal.updateComplete;

    const buttons = Array.from(permModal.querySelectorAll<HTMLButtonElement>("button.dndm-btn"));
    const closeBtn = buttons.find((b) => b.textContent?.trim() === "Close");
    expect(closeBtn).toBeDefined();

    closeBtn!.click();
    await permModal.updateComplete;

    expect(permModal.isOpen).toBe(false);
    expect(cancelEvtSpy).toHaveBeenCalledTimes(1);
    expect(closeEvtSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
    permModal.remove();
  });

  it("<dndm-roll-template-library> done button closes dialog, sets isOpen to false, and emits events", async () => {
    const libModal = document.createElement("dndm-roll-template-library") as DndmRollTemplateLibrary;
    libModal.state = {
      globalRollTemplates: [],
      sheets: {},
      attributeSchema: { rows: [] },
    } as any;
    libModal.isOpen = true;
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    const cancelEvtSpy = vi.fn();
    const closeEvtSpy = vi.fn();
    libModal.onClose = onCloseSpy;
    libModal.onCancel = onCancelSpy;
    libModal.addEventListener("cancel", cancelEvtSpy);
    libModal.addEventListener("close", closeEvtSpy);
    document.body.appendChild(libModal);
    await libModal.updateComplete;

    const buttons = Array.from(libModal.querySelectorAll<HTMLButtonElement>("button.dndm-btn"));
    const doneBtn = buttons.find((b) => b.textContent?.trim() === "Done");
    expect(doneBtn).toBeDefined();

    doneBtn!.click();
    await libModal.updateComplete;

    expect(libModal.isOpen).toBe(false);
    expect(cancelEvtSpy).toHaveBeenCalledTimes(1);
    expect(closeEvtSpy).toHaveBeenCalledTimes(1);
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(onCancelSpy).toHaveBeenCalledTimes(1);
    libModal.remove();
  });

  it("supports modalTitle via attribute as well as property", async () => {
    const attrModal = document.createElement("dndm-modal") as DndmModal;
    attrModal.setAttribute("modaltitle", "Attribute Title");
    attrModal.isOpen = true;
    document.body.appendChild(attrModal);
    await attrModal.updateComplete;

    const titleEl = attrModal.querySelector(".dndm-modal-title");
    expect(titleEl?.textContent?.trim()).toBe("Attribute Title");
    attrModal.remove();
  });

  it("<dndm-roll-template-library> displays 'Roll Template Library' title in modal header", async () => {
    const libModal = document.createElement("dndm-roll-template-library") as DndmRollTemplateLibrary;
    libModal.state = {
      globalRollTemplates: [],
      sheets: {},
      attributeSchema: { rows: [] },
    } as any;
    libModal.isOpen = true;
    document.body.appendChild(libModal);
    await libModal.updateComplete;

    const titleEl = libModal.querySelector(".dndm-modal-title");
    expect(titleEl).not.toBeNull();
    expect(titleEl?.textContent?.trim()).toBe("Roll Template Library");
    libModal.remove();
  });
});
