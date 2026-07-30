import { describe, expect, test } from "bun:test";
import {
  aggregateVariance,
  buildDayPlans,
  checkGrandTotals,
  classifyDayProvenance,
  compareSummaryDays,
  describeDateResolution,
  fieldsExceedingLength,
  groupConsecutiveDates,
  groupReportSheetsByPropertyDate,
  groupSummaryDaysByDate,
  isInVilleCopyWindow,
  monthOf,
  plainDateToIso,
  reportGroupKey,
  singleSheetByDate,
  splitReportGroupKey,
  tenderColumnCount,
  toAppTenders,
  toDerivationBookingLine,
} from "./plan.ts";
import type { DateResolution, ReportSheetRecord, SummaryDayRecord } from "./types.ts";
import type { LabeledReportSheet } from "./plan.ts";

function resolution(overrides: Partial<DateResolution> = {}): DateResolution {
  return {
    date: { year: 2026, month: 1, day: 15 },
    sources: [{ source: "sheetName", date: { year: 2026, month: 1, day: 15 } }],
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
    sheetName: "15-1-69",
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

describe("plainDateToIso / monthOf", () => {
  test("pads month and day", () => {
    expect(plainDateToIso({ year: 2026, month: 3, day: 5 })).toBe("2026-03-05");
  });

  test("monthOf slices the year-month prefix", () => {
    expect(monthOf("2026-03-05")).toBe("2026-03");
  });
});

describe("describeDateResolution", () => {
  test("lists surviving candidates and discarded ones", () => {
    const res = resolution({
      date: null,
      unresolved: true,
      singleSource: false,
      hasDisagreement: true,
      sources: [
        { source: "sheetName", date: { year: 2026, month: 1, day: 15 } },
        { source: "dateCell", date: { year: 2026, month: 1, day: 16 } },
      ],
      discarded: [{ source: "header", date: { year: 8025, month: 1, day: 1 } }],
    });
    const text = describeDateResolution(res);
    expect(text).toContain("sheetName=2026-01-15");
    expect(text).toContain("dateCell=2026-01-16");
    expect(text).toContain("discarded: header=8025-01-01");
  });

  test("reports no surviving candidate explicitly", () => {
    const res = resolution({ date: null, unresolved: true, singleSource: false, sources: [] });
    expect(describeDateResolution(res)).toBe("(no candidate survives)");
  });
});

describe("isInVilleCopyWindow", () => {
  test("dates before 2025-12-12 are in the copy window", () => {
    expect(isInVilleCopyWindow("2025-12-11")).toBe(true);
    expect(isInVilleCopyWindow("2025-04-01")).toBe(true);
  });

  test("2025-12-12 and later are not", () => {
    expect(isInVilleCopyWindow("2025-12-12")).toBe(false);
    expect(isInVilleCopyWindow("2026-01-01")).toBe(false);
  });
});

describe("classifyDayProvenance", () => {
  test("summary + bookings => transcribed", () => {
    expect(classifyDayProvenance(true, true)).toBe("transcribed");
  });
  test("summary only => summary_only", () => {
    expect(classifyDayProvenance(true, false)).toBe("summary_only");
  });
  test("bookings only => reconstructed", () => {
    expect(classifyDayProvenance(false, true)).toBe("reconstructed");
  });
  test("neither => null", () => {
    expect(classifyDayProvenance(false, false)).toBeNull();
  });
});

describe("compareSummaryDays", () => {
  test("identical categories/cashBlock/total => identical", () => {
    const a = summaryDay();
    const b = summaryDay({ sheetName: "different-name-ok" });
    expect(compareSummaryDays(a, b)).toEqual({ identical: true, detail: "identical" });
  });

  test("differing category amount is reported with both sides", () => {
    const a = summaryDay({ categories: { roomCash: 100_00 } });
    const b = summaryDay({ categories: { roomCash: 200_00 } });
    const result = compareSummaryDays(a, b);
    expect(result.identical).toBe(false);
    expect(result.detail).toContain("categories differ");
  });

  test("differing printed total is reported", () => {
    const a = summaryDay({ printedTotalSatang: 100_00 });
    const b = summaryDay({ printedTotalSatang: 999_00 });
    const result = compareSummaryDays(a, b);
    expect(result.identical).toBe(false);
    expect(result.detail).toContain("printedTotal differs");
  });
});

describe("groupSummaryDaysByDate / singleSheetByDate", () => {
  test("separates unresolved-date sheets from resolved ones", () => {
    const resolved = summaryDay({ sheetName: "15-1-69" });
    const unresolved = summaryDay({ sheetName: "junk", dateResolution: resolution({ date: null, unresolved: true }) });
    const { byDate, unresolved: unresolvedList } = groupSummaryDaysByDate([resolved, unresolved]);
    expect(byDate.get("2026-01-15")).toEqual([resolved]);
    expect(unresolvedList).toEqual([unresolved]);
  });

  test("two sheets resolving to the same date both land in that date's group", () => {
    const first = summaryDay({ sheetName: "15-1-69" });
    const second = summaryDay({ sheetName: "15-1-69 (2)" });
    const { byDate } = groupSummaryDaysByDate([first, second]);
    expect(byDate.get("2026-01-15")).toHaveLength(2);
  });

  test("singleSheetByDate keeps only unambiguous dates", () => {
    const byDate = new Map([
      ["2026-01-15", [summaryDay()]],
      ["2026-01-16", [summaryDay(), summaryDay()]],
    ]);
    const clean = singleSheetByDate(byDate);
    expect(clean.has("2026-01-15")).toBe(true);
    expect(clean.has("2026-01-16")).toBe(false);
  });
});

function reportSheet(overrides: Partial<ReportSheetRecord> = {}): ReportSheetRecord {
  return {
    sheetName: "15-1-69",
    dateResolution: resolution(),
    property: "hf",
    quarantineReason: null,
    quarantineDetail: null,
    bookingRows: [],
    totalsRow: null,
    ownSummaryBlock: { lines: [], reconciliationTotalSatang: null },
    skippedBlankRowCount: 0,
    unclassifiedRows: [],
    ...overrides,
  };
}

describe("groupReportSheetsByPropertyDate", () => {
  test("buckets unresolved-date and property-quarantined sheets separately", () => {
    const clean: LabeledReportSheet = { workbookLabel: "HF per-booking", record: reportSheet() };
    const badDate: LabeledReportSheet = {
      workbookLabel: "HF per-booking",
      record: reportSheet({ sheetName: "junk", dateResolution: resolution({ date: null, unresolved: true }) }),
    };
    const badProperty: LabeledReportSheet = {
      workbookLabel: "Ville per-booking",
      record: reportSheet({ property: null, quarantineReason: "no-signal", quarantineDetail: "neither signal resolves" }),
    };

    const { byPropertyDate, unresolvedDate, propertyQuarantined } = groupReportSheetsByPropertyDate([
      clean,
      badDate,
      badProperty,
    ]);

    expect(byPropertyDate.get(reportGroupKey("hf", "2026-01-15"))).toEqual([clean]);
    expect(unresolvedDate).toEqual([badDate]);
    expect(propertyQuarantined).toEqual([badProperty]);
  });

  test("two sheets resolving to the same (property, date) collide in one group", () => {
    const a: LabeledReportSheet = { workbookLabel: "HF per-booking", record: reportSheet({ sheetName: "15-1-69" }) };
    const b: LabeledReportSheet = { workbookLabel: "Ville per-booking", record: reportSheet({ sheetName: "dup" }) };
    const { byPropertyDate } = groupReportSheetsByPropertyDate([a, b]);
    expect(byPropertyDate.get(reportGroupKey("hf", "2026-01-15"))).toHaveLength(2);
  });

  test("reportGroupKey round-trips through splitReportGroupKey", () => {
    const key = reportGroupKey("hfville", "2026-02-03");
    expect(splitReportGroupKey(key)).toEqual(["hfville", "2026-02-03"]);
  });
});

describe("toAppTenders", () => {
  test("maps every parse-layer tender field to its app Tender key", () => {
    const mapped = toAppTenders({
      depositSatang: 1,
      cashSatang: 2,
      creditKbankSatang: 3,
      creditIcbcSatang: 4,
      transferKbankSatang: 5,
      transferIcbcSatang: 6,
      appWebsiteSatang: 7,
      otherSatang: 8,
    });
    expect(mapped).toEqual({
      deposit: 1,
      cash: 2,
      credit_kbank: 3,
      credit_icbc: 4,
      transfer_kbank: 5,
      transfer_icbc: 6,
      web: 7,
      other: 8,
    });
  });
});

describe("tenderColumnCount", () => {
  test("counts only non-zero tender columns", () => {
    const tenders = toAppTenders({
      depositSatang: 0,
      cashSatang: 100,
      creditKbankSatang: 0,
      creditIcbcSatang: 0,
      transferKbankSatang: 50,
      transferIcbcSatang: 0,
      appWebsiteSatang: 0,
      otherSatang: 0,
    });
    expect(tenderColumnCount(tenders)).toBe(2);
  });
});

describe("toDerivationBookingLine", () => {
  test("carries tenders and gross/discount amounts through for the shared derivation functions", () => {
    const line = toDerivationBookingLine(
      {
        rowIndex: 5,
        seq: 1,
        bookingNo: "B-1",
        guestName: "  Somchai  ",
        roomRaw: "301",
        roomTokens: ["301"],
        property: "hf",
        roomCount: 1,
        nights: 1,
        grossRoomSatang: 100_00,
        grossOtherSatang: 0,
        discountSatang: 0,
        tenders: {
          depositSatang: 0,
          cashSatang: 100_00,
          creditKbankSatang: 0,
          creditIcbcSatang: 0,
          transferKbankSatang: 0,
          transferIcbcSatang: 0,
          appWebsiteSatang: 0,
          otherSatang: 0,
        },
        remark: null,
        missingSeqAnomaly: false,
      },
      "hf",
      "2026-01-15",
      1,
    );
    expect(line.property).toBe("hf");
    expect(line.date).toBe("2026-01-15");
    expect(line.draft).toBe(false);
    expect(line.tenders.cash).toBe(100_00);
    expect(line.source).toBe("import");
  });

  test("empty guest name and room become null, never an empty string", () => {
    const line = toDerivationBookingLine(
      {
        rowIndex: 1,
        seq: null,
        bookingNo: null,
        guestName: "",
        roomRaw: "",
        roomTokens: [],
        property: undefined,
        roomCount: null,
        nights: null,
        grossRoomSatang: 0,
        grossOtherSatang: 0,
        discountSatang: 0,
        tenders: {
          depositSatang: 0,
          cashSatang: 0,
          creditKbankSatang: 0,
          creditIcbcSatang: 0,
          transferKbankSatang: 0,
          transferIcbcSatang: 0,
          appWebsiteSatang: 0,
          otherSatang: 0,
        },
        remark: null,
        missingSeqAnomaly: true,
      },
      "hf",
      "2026-01-15",
      1,
    );
    expect(line.guestName).toBeNull();
    expect(line.roomNo).toBeNull();
  });
});

describe("aggregateVariance", () => {
  const TOLERANCE = 100; // 1 THB, matches RECONCILE_TOLERANCE_SATANG

  test("groups by (property, categoryKey) and sums typed/derived/variance", () => {
    const stats = aggregateVariance(
      [
        { property: "hf", categoryKey: "room_cash", date: "2026-01-01", typedSatang: 1000, derivedSatang: 1000 },
        { property: "hf", categoryKey: "room_cash", date: "2026-01-02", typedSatang: 2000, derivedSatang: 1500 },
      ],
      TOLERANCE,
    );
    expect(stats).toHaveLength(1);
    expect(stats[0]!.daysCompared).toBe(2);
    expect(stats[0]!.totalTypedSatang).toBe(3000);
    expect(stats[0]!.totalDerivedSatang).toBe(2500);
    expect(stats[0]!.totalVarianceSatang).toBe(500);
  });

  test("a variance within tolerance does not count as exceeding or appear as a worst offender", () => {
    const stats = aggregateVariance(
      [{ property: "hf", categoryKey: "room_cash", date: "2026-01-01", typedSatang: 1000, derivedSatang: 1050 }],
      TOLERANCE,
    );
    expect(stats[0]!.daysExceedingTolerance).toBe(0);
    expect(stats[0]!.worstOffenders).toHaveLength(0);
  });

  test("a variance beyond tolerance counts and is ranked by absolute size", () => {
    const stats = aggregateVariance(
      [
        { property: "hf", categoryKey: "room_cash", date: "2026-01-01", typedSatang: 1000, derivedSatang: 1000 + 50_000 },
        { property: "hf", categoryKey: "room_cash", date: "2026-01-02", typedSatang: 1000, derivedSatang: 1000 + 5_000 },
      ],
      TOLERANCE,
    );
    expect(stats[0]!.daysExceedingTolerance).toBe(2);
    expect(stats[0]!.worstOffenders[0]!.date).toBe("2026-01-01");
  });

  test("categories are sorted by biggest absolute total variance first", () => {
    const stats = aggregateVariance(
      [
        { property: "hf", categoryKey: "web", date: "2026-01-01", typedSatang: 100, derivedSatang: 100 },
        { property: "hf", categoryKey: "room_cash", date: "2026-01-01", typedSatang: 100_000, derivedSatang: 0 },
      ],
      TOLERANCE,
    );
    expect(stats[0]!.categoryKey).toBe("room_cash");
  });
});

describe("buildDayPlans", () => {
  function labeled(workbookLabel: string, overrides: Partial<ReportSheetRecord> = {}): LabeledReportSheet {
    return { workbookLabel, record: reportSheet(overrides) };
  }

  test("HF day with a summary and booking rows is transcribed", () => {
    const hfSummary = summaryDay({ sheetName: "15-1-69" });
    const { dayPlans, skippedCopies } = buildDayPlans({
      hfSummaryByDate: new Map([["2026-01-15", hfSummary]]),
      villeSummaryByDate: new Map(),
      reportByPropertyDate: new Map([[reportGroupKey("hf", "2026-01-15"), labeled("HF per-booking")]]),
    });
    expect(dayPlans).toHaveLength(1);
    expect(dayPlans[0]!.provenance).toBe("transcribed");
    expect(dayPlans[0]!.contradictsSourceMap).toBeNull();
    expect(skippedCopies).toHaveLength(0);
  });

  test("HF day with only a summary is summary_only", () => {
    const { dayPlans } = buildDayPlans({
      hfSummaryByDate: new Map([["2026-01-15", summaryDay()]]),
      villeSummaryByDate: new Map(),
      reportByPropertyDate: new Map(),
    });
    expect(dayPlans[0]!.provenance).toBe("summary_only");
  });

  test("HF day with only booking rows is reconstructed and flagged as a source-map contradiction", () => {
    const { dayPlans } = buildDayPlans({
      hfSummaryByDate: new Map(),
      villeSummaryByDate: new Map(),
      reportByPropertyDate: new Map([[reportGroupKey("hf", "2026-01-15"), labeled("HF per-booking")]]),
    });
    expect(dayPlans[0]!.provenance).toBe("reconstructed");
    expect(dayPlans[0]!.contradictsSourceMap).toContain("HF day 2026-01-15");
  });

  test("Ville day before the copy window with no booking rows is skipped entirely, not imported", () => {
    const villeSummary = summaryDay({ property: "hfville", sheetName: "1-6-68" });
    const hfSummary = summaryDay({ sheetName: "1-6-68-hf" });
    const { dayPlans, skippedCopies } = buildDayPlans({
      hfSummaryByDate: new Map([["2025-06-01", hfSummary]]),
      villeSummaryByDate: new Map([["2025-06-01", villeSummary]]),
      reportByPropertyDate: new Map(),
    });
    // The HF counterpart is still legitimately imported as HF...
    expect(dayPlans.filter((p) => p.property === "hf")).toHaveLength(1);
    // ...but nothing is ever written for Ville on this date.
    expect(dayPlans.filter((p) => p.property === "hfville")).toHaveLength(0);
    expect(skippedCopies).toHaveLength(1);
    expect(skippedCopies[0]!.reconstructedFromBookings).toBe(false);
    expect(skippedCopies[0]!.identicalToHf).toBe(true);
  });

  test("Ville day in the copy window WITH booking rows is reconstructed, and the summary is still skipped", () => {
    const villeSummary = summaryDay({ property: "hfville", sheetName: "1-10-68" });
    const hfSummary = summaryDay({ sheetName: "1-10-68-hf" });
    const { dayPlans, skippedCopies } = buildDayPlans({
      hfSummaryByDate: new Map([["2025-10-01", hfSummary]]),
      villeSummaryByDate: new Map([["2025-10-01", villeSummary]]),
      reportByPropertyDate: new Map([[reportGroupKey("hfville", "2025-10-01"), labeled("Ville per-booking")]]),
    });
    const villePlans = dayPlans.filter((p) => p.property === "hfville");
    expect(villePlans).toHaveLength(1);
    expect(villePlans[0]!.provenance).toBe("reconstructed");
    expect(villePlans[0]!.summary).toBeNull(); // never the typed (copy) summary
    expect(skippedCopies[0]!.reconstructedFromBookings).toBe(true);
  });

  test("a copy-assumption violation is surfaced but the Ville sheet is still skipped either way", () => {
    const villeSummary = summaryDay({ property: "hfville", sheetName: "1-6-68", categories: { roomCash: 100_00 } });
    const hfSummary = summaryDay({ sheetName: "1-6-68-hf", categories: { roomCash: 200_00 } });
    const { dayPlans, skippedCopies } = buildDayPlans({
      hfSummaryByDate: new Map([["2025-06-01", hfSummary]]),
      villeSummaryByDate: new Map([["2025-06-01", villeSummary]]),
      reportByPropertyDate: new Map(),
    });
    // Never imported as Ville, violation or not.
    expect(dayPlans.filter((p) => p.property === "hfville")).toHaveLength(0);
    expect(skippedCopies[0]!.identicalToHf).toBe(false);
    expect(skippedCopies[0]!.diffDetail).toContain("categories differ");
  });

  test("Ville day with no HF counterpart to compare against is still reported, not silently accepted", () => {
    const villeSummary = summaryDay({ property: "hfville", sheetName: "1-6-68" });
    const { skippedCopies } = buildDayPlans({
      hfSummaryByDate: new Map(),
      villeSummaryByDate: new Map([["2025-06-01", villeSummary]]),
      reportByPropertyDate: new Map(),
    });
    expect(skippedCopies[0]!.hasHfCounterpart).toBe(false);
    expect(skippedCopies[0]!.identicalToHf).toBeNull();
  });

  test("Ville day after the copy window with summary and bookings is transcribed", () => {
    const villeSummary = summaryDay({ property: "hfville", sheetName: "20-12-68" });
    const { dayPlans } = buildDayPlans({
      hfSummaryByDate: new Map(),
      villeSummaryByDate: new Map([["2025-12-20", villeSummary]]),
      reportByPropertyDate: new Map([[reportGroupKey("hfville", "2025-12-20"), labeled("Ville per-booking")]]),
    });
    expect(dayPlans[0]!.provenance).toBe("transcribed");
    expect(dayPlans[0]!.summary).toBe(villeSummary);
  });

  test("Ville day after the copy window with only booking rows is reconstructed and flagged unexpected", () => {
    const { dayPlans } = buildDayPlans({
      hfSummaryByDate: new Map(),
      villeSummaryByDate: new Map(),
      reportByPropertyDate: new Map([[reportGroupKey("hfville", "2025-12-20"), labeled("Ville per-booking")]]),
    });
    expect(dayPlans[0]!.provenance).toBe("reconstructed");
    expect(dayPlans[0]!.contradictsSourceMap).toContain("after the copy window");
  });
});

describe("groupConsecutiveDates", () => {
  test("collapses a run of consecutive calendar days into one entry", () => {
    const runs = groupConsecutiveDates(["2025-03-01", "2025-03-02", "2025-03-03"]);
    expect(runs).toEqual([{ start: "2025-03-01", end: "2025-03-03", count: 3 }]);
  });

  test("a gap starts a new run", () => {
    const runs = groupConsecutiveDates(["2025-03-01", "2025-03-02", "2025-03-10"]);
    expect(runs).toEqual([
      { start: "2025-03-01", end: "2025-03-02", count: 2 },
      { start: "2025-03-10", end: "2025-03-10", count: 1 },
    ]);
  });

  test("handles a run crossing a month boundary", () => {
    const runs = groupConsecutiveDates(["2025-03-30", "2025-03-31", "2025-04-01"]);
    expect(runs).toEqual([{ start: "2025-03-30", end: "2025-04-01", count: 3 }]);
  });

  test("de-duplicates and sorts unordered input", () => {
    const runs = groupConsecutiveDates(["2025-03-02", "2025-03-01", "2025-03-01"]);
    expect(runs).toEqual([{ start: "2025-03-01", end: "2025-03-02", count: 2 }]);
  });

  test("empty input yields no runs", () => {
    expect(groupConsecutiveDates([])).toEqual([]);
  });
});

describe("checkGrandTotals", () => {
  function sample(overrides: Partial<import("./plan.ts").GrandTotalCheckSample> = {}): import("./plan.ts").GrandTotalCheckSample {
    return {
      property: "hf",
      date: "2026-01-15",
      sheetName: "15-1-69",
      importedTotalSatang: 100_000,
      printedTotalSatang: 100_000,
      categoryBreakdown: { room_cash: 100_000 },
      otherIncomeSatang: 0,
      ...overrides,
    };
  }

  const TOLERANCE = 100; // 1 THB

  test("an exact match counts toward daysMatching, not the worst offenders", () => {
    const result = checkGrandTotals([sample()], TOLERANCE);
    expect(result.daysChecked).toBe(1);
    expect(result.daysMatching).toBe(1);
    expect(result.daysMismatching).toBe(0);
    expect(result.worstOffenders).toHaveLength(0);
  });

  test("a variance within 1 THB tolerance still counts as matching", () => {
    const result = checkGrandTotals([sample({ importedTotalSatang: 100_050, printedTotalSatang: 100_000 })], TOLERANCE);
    expect(result.daysMatching).toBe(1);
    expect(result.daysMismatching).toBe(0);
  });

  test("a variance beyond tolerance is a mismatch, accumulates absolute discrepancy per property, and appears as a worst offender", () => {
    const result = checkGrandTotals(
      [
        sample({ property: "hf", importedTotalSatang: 90_000, printedTotalSatang: 100_000 }),
        sample({ property: "hfville", importedTotalSatang: 100_000, printedTotalSatang: 95_000 }),
      ],
      TOLERANCE,
    );
    expect(result.daysMismatching).toBe(2);
    expect(result.totalAbsoluteDiscrepancySatangByProperty).toEqual({ hf: 10_000, hfville: 5_000 });
    expect(result.worstOffenders).toHaveLength(2);
    expect(result.worstOffenders[0]!.property).toBe("hf"); // bigger absolute variance first
  });

  test("worst offenders are capped at worstOffenderCount", () => {
    const samples = Array.from({ length: 5 }, (_, i) =>
      sample({ date: `2026-01-${10 + i}`, importedTotalSatang: 100_000 + (i + 1) * 1_000, printedTotalSatang: 100_000 }),
    );
    const result = checkGrandTotals(samples, TOLERANCE, 3);
    expect(result.worstOffenders).toHaveLength(3);
    expect(result.worstOffenders[0]!.date).toBe("2026-01-14"); // biggest variance (5,000) first
  });
});

describe("fieldsExceedingLength", () => {
  test("flags only fields longer than their bound", () => {
    const result = fieldsExceedingLength([
      { field: "guestName", value: "a".repeat(121), maxLen: 120 },
      { field: "roomNo", value: "301", maxLen: 40 },
    ]);
    expect(result).toEqual([{ field: "guestName", value: "a".repeat(121), maxLen: 120 }]);
  });
});
