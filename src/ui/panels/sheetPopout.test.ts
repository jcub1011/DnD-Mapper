import { describe, expect, it } from "vitest";
import {
  SHEET_SYNC_CHANNEL,
  buildSheetPopoutUrl,
  isSheetPopoutLocation,
  parseSheetPopoutParams,
} from "./sheetPopout";

describe("sheetPopout protocol", () => {
  it("exposes a dedicated sync channel", () => {
    expect(SHEET_SYNC_CHANNEL).toBe("dndm-sheet-sync");
  });

  it("builds the sheet popout route", () => {
    expect(buildSheetPopoutUrl("sheet-1")).toBe("?view=sheet&sheetId=sheet-1");
    expect(buildSheetPopoutUrl("a b/c")).toBe("?view=sheet&sheetId=a%20b%2Fc");
  });

  it("parses the sheet popout params", () => {
    expect(parseSheetPopoutParams("?view=sheet&sheetId=sheet-1")).toEqual({
      isSheetPopout: true,
      sheetId: "sheet-1",
    });
    expect(parseSheetPopoutParams("?view=display")).toEqual({
      isSheetPopout: false,
      sheetId: null,
    });
    expect(parseSheetPopoutParams("?view=sheet")).toEqual({
      isSheetPopout: true,
      sheetId: null,
    });
    expect(parseSheetPopoutParams("")).toEqual({ isSheetPopout: false, sheetId: null });
  });

  it("detects sheet popout locations defensively", () => {
    expect(isSheetPopoutLocation({ search: "?view=sheet&sheetId=x" })).toBe(true);
    expect(isSheetPopoutLocation({ search: "?view=display" })).toBe(false);
    expect(isSheetPopoutLocation(undefined)).toBe(false);
  });
});
