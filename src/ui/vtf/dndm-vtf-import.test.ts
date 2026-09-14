// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../storage/db.js";
import { LibraryService } from "../../storage/libraryService.js";
import "./dndm-vtf-import.js";
import type { DndmVtfImport, VtfErrorDetail, VtfImportedDetail } from "./dndm-vtf-import.js";

// Minimal valid zip builder
async function buildMinimalZip(): Promise<Blob> {
  const manifest = JSON.stringify({
    vtfVersion: "1.0.0",
    campaign: { id: "ui-camp", title: "UI Test Campaign", lastModified: "" },
    system: { core: "dnd5e" },
    dependencies: [{ name: "knockbox_dnd_mapper" }],
  });
  const globalState = JSON.stringify({
    vendorData: { knockbox_dnd_mapper: {} },
  });

  const utf8 = (s: string) => new TextEncoder().encode(s);
  const files = [
    { name: "manifest.json", bytes: utf8(manifest) },
    { name: "global_state.json", bytes: utf8(globalState) },
  ];

  const localChunks: Uint8Array[] = [];
  const cdChunks: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = utf8(f.name);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(18, f.bytes.length, true);
    lv.setUint32(22, f.bytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    localChunks.push(local, f.bytes);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint32(20, f.bytes.length, true);
    cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdChunks.push(cd);

    offset += local.length + f.bytes.length;
  }

  let cdSize = 0;
  for (const c of cdChunks) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...localChunks, ...cdChunks, eocd] as unknown as BlobPart[], {
    type: "application/zip",
  });
}

describe("<dndm-vtf-import> component", () => {
  it("renders import button", async () => {
    const el = document.createElement("dndm-vtf-import") as DndmVtfImport;
    document.body.appendChild(el);
    await el.updateComplete;

    const btn = el.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("title")).toBe("Import .vtf");
    expect(btn?.querySelector("svg")).not.toBeNull();

    el.remove();
  });

  it("dispatches 'vtf-imported' event on successful file processing", async () => {
    const el = document.createElement("dndm-vtf-import") as DndmVtfImport;
    document.body.appendChild(el);
    await el.updateComplete;

    let importedDetail: VtfImportedDetail | null = null;
    el.addEventListener("vtf-imported", (e: Event) => {
      importedDetail = (e as CustomEvent<VtfImportedDetail>).detail;
    });

    const zipBlob = await buildMinimalZip();
    const result = await el.processFile(zipBlob);

    expect(result).not.toBeNull();
    expect(importedDetail).not.toBeNull();
    const detail = importedDetail as VtfImportedDetail | null;
    expect(detail?.result.slotTitle).toBe("UI Test Campaign");

    el.remove();
  });

  it("dispatches 'vtf-error' and displays error message on invalid file", async () => {
    const el = document.createElement("dndm-vtf-import") as DndmVtfImport;
    document.body.appendChild(el);
    await el.updateComplete;

    let errorDetail: VtfErrorDetail | null = null;
    el.addEventListener("vtf-error", (e: Event) => {
      errorDetail = (e as CustomEvent<VtfErrorDetail>).detail;
    });

    const corruptBlob = new Blob(["not a zip"], { type: "application/zip" });
    const result = await el.processFile(corruptBlob);

    expect(result).toBeNull();
    expect(errorDetail).not.toBeNull();
    const err = errorDetail as VtfErrorDetail | null;
    expect(err?.error.message).toContain("Invalid ZIP");

    await el.updateComplete;
    const errorEl = el.querySelector(".dndm-import-error");
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain("Invalid ZIP");

    el.remove();
  });

  it("automatically saves slot into LibraryService when autoSaveSlot is enabled", async () => {
    const db = await openDatabase();
    const libraryService = new LibraryService();
    libraryService.attach(db);

    const el = document.createElement("dndm-vtf-import") as DndmVtfImport;
    el.libraryService = libraryService;
    el.autoSaveSlot = true;
    document.body.appendChild(el);
    await el.updateComplete;

    let importedDetail: VtfImportedDetail | null = null;
    el.addEventListener("vtf-imported", (e: Event) => {
      importedDetail = (e as CustomEvent<VtfImportedDetail>).detail;
    });

    const zipBlob = await buildMinimalZip();
    await el.processFile(zipBlob);

    expect(importedDetail).not.toBeNull();
    const detail = importedDetail as VtfImportedDetail | null;
    expect(detail?.slotId).toBeTruthy();

    const loaded = await libraryService.loadSlot(detail!.slotId!);
    expect(loaded).not.toBeNull();

    el.remove();
  });
});
