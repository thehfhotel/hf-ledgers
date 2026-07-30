import { describe, expect, test } from "bun:test";
import {
  SHEET_RESOLUTIONS,
  acceptedSummaryDates,
  applyResolutionsToReportSheets,
  applyResolutionsToSummaryDays,
  assertEveryResolutionMatched,
  forcedDateResolution,
  isoToPlainDate,
  layerOf,
  resolutionFor,
  validateResolutions,
} from "./resolutions.ts";
import type { SheetResolution } from "./resolutions.ts";
import type { DateResolution, ReportSheetRecord, SummaryDayRecord } from "./types.ts";

function resolution(overrides: Partial<DateResolution> = {}): DateResolution {
  return {
    date: { year: 2025, month: 9, day: 18 },
    sources: [{ source: "sheetName", date: { year: 2025, month: 9, day: 18 } }],
    agreementCount: 1,
    hasDisagreement: false,
    unresolved: false,
    singleSource: true,
    discarded: [],
    ...overrides,
  };
}

function summaryDay(overrides: Partial<SummaryDayRecord> = {}): SummaryDayRecord {
  return {
    sheetName: "18-9-2568          ",
    property: "hf",
    dateResolution: resolution(),
    categories: { roomCash: 100_00 },
    otherIncomeItems: [],
    cashBlock: {},
    printedTotalSatang: 100_00,
    unknownLabels: [],
    ...overrides,
  };
}

function reportSheet(overrides: Partial<ReportSheetRecord> = {}): ReportSheetRecord {
  return {
    sheetName: "Hf-ville18-9-68",
    dateResolution: resolution(),
    property: null,
    quarantineReason: "room-title-mismatch",
    quarantineDetail: "room majority=hfville title=hf",
    bookingRows: [],
    totalsRow: null,
    ownSummaryBlock: { lines: [], reconciliationTotalSatang: null },
    skippedBlankRowCount: 0,
    unclassifiedRows: [],
    ...overrides,
  };
}

describe("the approved table itself", () => {
  test("is structurally valid (no duplicate sheets, no two accepts on one target)", () => {
    expect(() => validateResolutions()).not.toThrow();
  });

  test("covers all 26 quarantined rows of the first run, as 39 sheet-level rulings", () => {
    expect(SHEET_RESOLUTIONS.length).toBe(39);
  });

  test("every entry carries a rationale a reviewer can read", () => {
    for (const r of SHEET_RESOLUTIONS) {
      expect(r.rationale.length).toBeGreaterThan(40);
    }
  });

  test("rejects a table where two sheets are accepted as the same property and date", () => {
    const clashing: SheetResolution[] = [
      { workbook: "hf-summary", sheetName: "a", action: "accept", property: "hf", date: "2025-01-01", rationale: "x" },
      { workbook: "hf-summary", sheetName: "b", action: "accept", property: "hf", date: "2025-01-01", rationale: "y" },
    ];
    expect(() => validateResolutions(clashing)).toThrow(/recreates the duplicate/);
  });

  test("rejects a duplicated (workbook, sheet) row", () => {
    const dupe: SheetResolution[] = [
      { workbook: "hf-summary", sheetName: "a", action: "ignore", rationale: "x" },
      { workbook: "hf-summary", sheetName: "a", action: "ignore", rationale: "y" },
    ];
    expect(() => validateResolutions(dupe)).toThrow(/duplicate entry/);
  });

  test("rejects a non-ISO date", () => {
    const bad: SheetResolution[] = [
      { workbook: "hf-summary", sheetName: "a", action: "accept", property: "hf", date: "18-9-2568", rationale: "x" },
    ];
    expect(() => validateResolutions(bad)).toThrow(/non-ISO date/);
  });

  test("layerOf separates the summary books from the per-booking books", () => {
    expect(layerOf("hf-summary")).toBe("summary");
    expect(layerOf("ville-summary")).toBe("summary");
    expect(layerOf("hf-booking")).toBe("booking");
    expect(layerOf("ville-booking")).toBe("booking");
  });

  test("sheet names are matched verbatim — trailing whitespace is significant", () => {
    expect(resolutionFor("hf-summary", "30-5-68   ")).not.toBeNull();
    expect(resolutionFor("hf-summary", "30-5-68")).toBeNull();
    // The 1 October Ville pair differs ONLY by a trailing space, and the two
    // halves get opposite rulings.
    expect(resolutionFor("ville-booking", "HF-Ville1-10-68")?.action).toBe("accept");
    expect(resolutionFor("ville-booking", "HF-Ville1-10-68 ")?.action).toBe("ignore");
    // As does the 13 July pair, by a single full stop.
    expect(resolutionFor("ville-booking", "HF-ViLLE 13-7-69.")?.action).toBe("accept");
    expect(resolutionFor("ville-booking", "HF-ViLLE 13-7-69")?.action).toBe("ignore");
  });

  test("the HF summary book carries the one Ville day, so 2025-09-18 exists for both properties", () => {
    const plain = resolutionFor("hf-summary", "18-9-2568          ");
    const ville = resolutionFor("hf-summary", "18-9-2568 FH-Ville   ");
    expect(plain).toMatchObject({ action: "accept", property: "hf", date: "2025-09-18" });
    expect(ville).toMatchObject({ action: "accept", property: "hfville", date: "2025-09-18" });
  });

  test("acceptedSummaryDates reports the dates whose copy-window verdict a human overrode", () => {
    const ville = acceptedSummaryDates("hfville");
    expect(ville.has("2025-09-18")).toBe(true);
    expect(ville.has("2025-12-13")).toBe(true);
    expect(ville.has("2025-10-01")).toBe(false); // resolved in the per-booking layer, not the summary layer
    expect(acceptedSummaryDates("hf").has("2025-04-30")).toBe(true);
  });
});

describe("forcedDateResolution", () => {
  test("overrides the date but keeps the sheet's own readings for the audit trail", () => {
    const original = resolution({
      date: null,
      unresolved: true,
      sources: [
        { source: "sheetName", date: { year: 2025, month: 5, day: 30 } },
        { source: "dateCell", date: { year: 2025, month: 4, day: 30 } },
      ],
    });
    const forced = forcedDateResolution(original, isoToPlainDate("2025-04-30"));
    expect(forced.date).toEqual({ year: 2025, month: 4, day: 30 });
    expect(forced.unresolved).toBe(false);
    expect(forced.agreementCount).toBe(1);
    expect(forced.hasDisagreement).toBe(true);
    expect(forced.sources).toEqual(original.sources);
  });
});

describe("applyResolutionsToSummaryDays", () => {
  test("an accepted sheet is rewritten to the approved property and date", () => {
    const days = [summaryDay({ sheetName: "18-9-2568 FH-Ville   " })];
    const { records, applied, unmatched } = applyResolutionsToSummaryDays("hf-summary", days);
    expect(records).toHaveLength(1);
    expect(records[0]!.property).toBe("hfville");
    expect(records[0]!.dateResolution.date).toEqual({ year: 2025, month: 9, day: 18 });
    expect(applied[0]).toMatchObject({ action: "accept", property: "hfville", date: "2025-09-18" });
    expect(applied[0]!.originalDetail).toContain("classified property=hf");
    // Only this workbook's own entries can be unmatched, and all the rest are.
    expect(unmatched.every((r) => r.workbook === "hf-summary")).toBe(true);
  });

  test("an ignored sheet is dropped before grouping — which is what dissolves a duplicate pair", () => {
    const days = [summaryDay({ sheetName: "Sheet5", property: "hfville" })];
    const { records, applied } = applyResolutionsToSummaryDays("ville-summary", days);
    expect(records).toHaveLength(0);
    expect(applied[0]).toMatchObject({ action: "ignore", property: null, date: null });
  });

  test("an unlisted sheet is passed through completely untouched", () => {
    const untouched = summaryDay({ sheetName: "1-1-69" });
    const { records, applied } = applyResolutionsToSummaryDays("hf-summary", [untouched]);
    expect(records[0]).toBe(untouched);
    expect(applied).toHaveLength(0);
  });

  test("the same sheet name in a different workbook gets that workbook's ruling, not this one's", () => {
    // '18-9-2568 FH-Ville   ' exists in BOTH summary books: accepted as the
    // Ville day in the HF book, ignored as a stale clone in the Ville book.
    const inVilleBook = summaryDay({ sheetName: "18-9-2568 FH-Ville   ", property: "hfville" });
    expect(applyResolutionsToSummaryDays("ville-summary", [inVilleBook]).records).toHaveLength(0);
    expect(applyResolutionsToSummaryDays("hf-summary", [inVilleBook]).records).toHaveLength(1);
  });
});

describe("applyResolutionsToReportSheets", () => {
  test("an accepted sheet loses its property quarantine and takes the approved date", () => {
    const { records, applied } = applyResolutionsToReportSheets("ville-booking", [reportSheet()]);
    expect(records[0]).toMatchObject({
      property: "hfville",
      quarantineReason: null,
      quarantineDetail: null,
    });
    expect(records[0]!.dateResolution.date).toEqual({ year: 2025, month: 9, day: 18 });
    expect(applied[0]!.originalDetail).toContain("classified property=quarantined");
  });

  test("the stale-in-sheet-date pair is split onto its two real days", () => {
    const seventh = reportSheet({ sheetName: "HF-Ville7-10-68 ", property: "hfville", quarantineReason: null, quarantineDetail: null });
    const eighth = reportSheet({ sheetName: "Hf-Ville8-10-68", property: "hfville", quarantineReason: null, quarantineDetail: null });
    const { records } = applyResolutionsToReportSheets("ville-booking", [seventh, eighth]);
    expect(records.map((r) => r.dateResolution.date!.day)).toEqual([7, 8]);
  });

  test("an unlisted sheet keeps its quarantine", () => {
    const other = reportSheet({ sheetName: "some-other-sheet" });
    const { records } = applyResolutionsToReportSheets("ville-booking", [other]);
    expect(records[0]).toBe(other);
    expect(records[0]!.quarantineReason).toBe("room-title-mismatch");
  });
});

describe("assertEveryResolutionMatched", () => {
  test("passes when nothing is left over", () => {
    expect(() => assertEveryResolutionMatched([])).not.toThrow();
  });

  test("fails loudly on a name that matched no sheet — the likely typo failure mode", () => {
    expect(() =>
      assertEveryResolutionMatched([{ workbook: "hf-summary", sheetName: "30-5-68", action: "ignore", rationale: "x" }]),
    ).toThrow(/matched no sheet/);
  });
});
