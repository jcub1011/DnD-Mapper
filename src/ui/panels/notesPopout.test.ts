import { describe, expect, it } from "vitest";
import { NOTES_SYNC_CHANNEL, buildNotesPopoutHtml } from "./notesPopout";

describe("buildNotesPopoutHtml", () => {
  it("defaults to split view for editors", () => {
    const html = buildNotesPopoutHtml({
      sheetId: "sheet-1",
      sheetName: "Thorin",
      notes: "# Hello",
      editable: true,
    });
    expect(html).toContain('data-mode="split"');
    expect(html).toContain("Thorin — Notes");
    expect(html).toContain(NOTES_SYNC_CHANNEL);
    expect(html).toContain("notes-edit");
    expect(html).toContain("notes-state");
    expect(html).toContain("# Hello");
  });

  it("locks to preview for read-only viewers", () => {
    const html = buildNotesPopoutHtml({
      sheetId: "sheet-1",
      sheetName: "Thorin",
      notes: "lore",
      editable: false,
    });
    expect(html).toContain('data-mode="preview"');
    expect(html).toContain("editable = false");
  });

  it("embeds syntactically valid popup script", () => {
    const html = buildNotesPopoutHtml({
      sheetId: "sheet-1",
      sheetName: "Thorin",
      notes: "# Hi\n- a\n- b\n> quote\n`code` **bold**",
      editable: true,
    });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(1);
    expect(() => new Function(scripts[0] as string)).not.toThrow();
  });

  it("clears drag-sized columns when leaving split view", () => {
    const html = buildNotesPopoutHtml({
      sheetId: "sheet-1",
      sheetName: "Thorin",
      notes: "lore",
      editable: true,
    });
    // A stale inline 3-track template would keep a lone editor/preview pane
    // at a fraction of the window width in single-pane modes.
    expect(html).toContain('main.style.gridTemplateColumns = ""');
  });

  it("keeps local keystrokes instead of clobbering them with stale state", () => {
    const html = buildNotesPopoutHtml({
      sheetId: "sheet-1",
      sheetName: "Thorin",
      notes: "lore",
      editable: true,
    });
    // Dirty guard: focused editor with unacknowledged edits ignores older
    // incoming state and re-sends current text so the opener converges.
    expect(html).toContain("document.activeElement === editor");
    expect(html).toContain("scheduleSend");
  });

  it("sizes split panes in fr units so divider drags cannot overflow", () => {
    const html = buildNotesPopoutHtml({
      sheetId: "sheet-1",
      sheetName: "Thorin",
      notes: "lore",
      editable: true,
    });
    // Mixing % tracks with the fixed-px divider totals 100% + 7px and pins
    // a permanent window scrollbar after the first drag.
    expect(html).toContain('"fr 7px "');
    expect(html).not.toContain('"% 7px "');
  });

  it("neutralizes script-breaking notes content", () => {
    const html = buildNotesPopoutHtml({
      sheetId: "sheet-1",
      sheetName: "Thorin",
      notes: "</script><script>alert(1)</script>",
      editable: true,
    });
    // No raw closing script tag from the inlined notes value.
    expect(html).not.toContain("</script><script>");
    expect(html).toContain("<\\/script>");
  });
});
