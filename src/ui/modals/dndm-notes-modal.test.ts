// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./dndm-notes-modal";
import type { DndmNotesModal } from "./dndm-notes-modal";
import type { DndmModal } from "./dndm-modal";

describe("<dndm-notes-modal>", () => {
  let modal: DndmNotesModal;

  beforeEach(() => {
    modal = document.createElement("dndm-notes-modal") as DndmNotesModal;
  });

  afterEach(() => {
    modal.remove();
  });

  it("emits a single close (no cancel) per inner-modal dismissal", async () => {
    modal.isOpen = true;
    modal.sheetName = "Thorin";
    modal.notesValue = "lore";
    modal.editable = true;
    document.body.appendChild(modal);
    await modal.updateComplete;

    const closeSpy = vi.fn();
    const cancelSpy = vi.fn();
    const onCloseSpy = vi.fn();
    const onCancelSpy = vi.fn();
    modal.addEventListener("close", closeSpy);
    modal.addEventListener("cancel", cancelSpy);
    modal.onClose = onCloseSpy;
    modal.onCancel = onCancelSpy;

    // One dismissal gesture from the inner dndm-modal (which itself fires
    // both close+cancel and both callbacks) must collapse to one signal.
    const inner = modal.querySelector("dndm-modal") as DndmModal;
    expect(inner).not.toBeNull();
    inner.handleClose();
    await modal.updateComplete;

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
  });

  it("grows the editor to fit its content instead of user resizing", async () => {
    modal.isOpen = true;
    modal.sheetName = "Thorin";
    modal.notesValue = "lore";
    modal.editable = true;
    document.body.appendChild(modal);
    await modal.updateComplete;
    // The editor is stamped by the inner dndm-modal, so wait for the child
    // (autosize runs once the child has updated).
    const inner = modal.querySelector("dndm-modal") as unknown as {
      updateComplete: Promise<unknown>;
    };
    await inner.updateComplete;

    const area = modal.querySelector(
      ".dndm-notes-modal-textarea",
    ) as HTMLTextAreaElement;
    expect(area).not.toBeNull();

    // No layout engine: scrollHeight 0 leaves the stylesheet height alone.
    expect(area.style.height).toBe("auto");

    // With content to fit, the editor takes the content height via inline
    // style (capped by the CSS max-height, beyond which it scrolls).
    Object.defineProperty(area, "scrollHeight", { value: 500, configurable: true });
    area.value = "lore\nmore lore";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    expect(area.style.height).toBe("500px");
  });
});
