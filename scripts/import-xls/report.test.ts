import { describe, expect, test } from "bun:test";
import {
  formatBaht,
  renderDaysCsv,
  renderGrandTotalCheckCsv,
  renderMarkdownReport,
  renderQuarantineCsv,
  renderVarianceCsv,
} from "./report.ts";
import type { ImportRunSummary } from "./report.ts";

function baseSummary(overrides: Partial<ImportRunSummary> = {}): ImportRunSummary {
  return {
    generatedAt: "2026-07-29T00:00:00.000Z",
    apply: false,
    dbPath: "/tmp/ledger.db",
    onlyDate: null,
    onlyProperty: null,
    totalSheetsAcrossWorkbooks: 1000,
    days: [],
    quarantine: [],
    skippedCopies: [],
    variance: [],
    grandTotalCheck: {
      toleranceSatang: 100,
      daysChecked: 0,
      daysMatching: 0,
      daysMismatching: 0,
      totalAbsoluteDiscrepancySatangByProperty: {},
      worstOffenders: [],
    },
    unknownLabels: [],
    tenderCounts: [],
    monthlyTotals: [],
    warnings: [],
    resolutions: [],
    humanCellSkips: [],
    humanDaySkips: [],
    idempotencyNote: "replace: rows this importer previously created (created_by = import:excel) are deleted before re-inserting for a given (property, date).",
    ...overrides,
  };
}

describe("formatBaht", () => {
  test("converts satang to a two-decimal baht string with thousands separators", () => {
    expect(formatBaht(123_456_78)).toBe("123,456.78");
  });
  test("handles zero and negative values", () => {
    expect(formatBaht(0)).toBe("0.00");
    expect(formatBaht(-500)).toBe("-5.00");
  });
});

describe("renderDaysCsv", () => {
  test("emits a header and one row per day, quoting embedded commas", () => {
    const csv = renderDaysCsv(
      baseSummary({
        days: [
          {
            property: "hf",
            date: "2026-01-15",
            provenance: "transcribed",
            storedProvenance: "transcribed",
            sourceSummarySheet: "15-1-69",
            sourceBookingWorkbook: "HF per-booking",
            sourceBookingSheet: "15-1-69",
            bookingLineCount: 12,
            incomeCategoriesWritten: 7,
            otherIncomeItemsWritten: 2,
            cashBlockOverrideWritten: true,
            contradictsSourceMap: null,
          },
        ],
      }),
    );
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("property,date,provenance");
    expect(lines[1]).toContain("hf,2026-01-15,transcribed,transcribed,15-1-69,HF per-booking,15-1-69,12,7,2,true,");
  });
});

describe("renderQuarantineCsv", () => {
  test("joins multiple sheet names with a semicolon", () => {
    const csv = renderQuarantineCsv(
      baseSummary({
        quarantine: [
          {
            property: "hf",
            date: "2026-01-15",
            kind: "duplicate-date",
            workbookLabel: "HF summary",
            sheetNames: ["15-1-69", "15-1-69 (2)"],
            detail: "2 sheets resolve to 2026-01-15",
          },
        ],
      }),
    );
    expect(csv).toContain("15-1-69; 15-1-69 (2)");
  });
});

describe("renderVarianceCsv", () => {
  test("formats satang totals as baht strings", () => {
    const csv = renderVarianceCsv(
      baseSummary({
        variance: [
          {
            property: "hf",
            categoryKey: "room_cash",
            daysCompared: 10,
            daysExceedingTolerance: 2,
            totalTypedSatang: 100_000,
            totalDerivedSatang: 95_000,
            totalVarianceSatang: 5_000,
            worstOffenders: [],
          },
        ],
      }),
    );
    // totalTypedSatang (100_000 satang = 1,000.00 THB) contains a comma, so
    // the CSV cell is correctly quoted per RFC 4180.
    expect(csv).toContain('hf,room_cash,10,2,"1,000.00",950.00,50.00');
  });
});

describe("renderGrandTotalCheckCsv", () => {
  test("emits one row per worst offender", () => {
    const csv = renderGrandTotalCheckCsv(
      baseSummary({
        grandTotalCheck: {
          toleranceSatang: 100,
          daysChecked: 1,
          daysMatching: 0,
          daysMismatching: 1,
          totalAbsoluteDiscrepancySatangByProperty: { hf: 129_000 },
          worstOffenders: [
            {
              property: "hf",
              date: "2025-04-01",
              sheetName: "1",
              importedTotalSatang: 1_524_520,
              printedTotalSatang: 1_653_520,
              varianceSatang: -129_000,
              categoryBreakdown: {},
              otherIncomeSatang: 0,
            },
          ],
        },
      }),
    );
    expect(csv).toContain("hf,2025-04-01,1");
    expect(csv).toContain("-1,290.00");
  });
});

describe("renderMarkdownReport", () => {
  test("includes the mode, filters, and every section heading", () => {
    const md = renderMarkdownReport(
      baseSummary({
        apply: true,
        onlyProperty: "hf",
        onlyDate: "2026-01-15",
        days: [
          {
            property: "hf",
            date: "2026-01-15",
            provenance: "transcribed",
            storedProvenance: "transcribed",
            sourceSummarySheet: "15-1-69",
            sourceBookingWorkbook: null,
            sourceBookingSheet: null,
            bookingLineCount: 0,
            incomeCategoriesWritten: 5,
            otherIncomeItemsWritten: 0,
            cashBlockOverrideWritten: false,
            contradictsSourceMap: null,
          },
        ],
      }),
    );
    expect(md).toContain("APPLY (committed)");
    expect(md).toContain("Filter: property=hf");
    expect(md).toContain("Filter: date=2026-01-15");
    expect(md).toContain("## Days imported per property");
    expect(md).toContain("## Ville copy-window (skipped-as-copy) check");
    expect(md).toContain("## Quarantined and unresolved");
    expect(md).toContain("## Typed vs. derived-from-bookings variance");
    expect(md).toContain("## Unknown labels");
    expect(md).toContain("## Booking-line tender counts");
    expect(md).toContain("## Monthly totals per property");
    expect(md).toContain("## Idempotency");
    expect(md).toContain("## Source-map contradictions");
    expect(md).toContain("## Grand-total reconciliation");
  });

  test("grand-total section reports a clean match and lists worst offenders with their category breakdown", () => {
    const clean = renderMarkdownReport(
      baseSummary({
        grandTotalCheck: {
          toleranceSatang: 100,
          daysChecked: 5,
          daysMatching: 5,
          daysMismatching: 0,
          totalAbsoluteDiscrepancySatangByProperty: {},
          worstOffenders: [],
        },
      }),
    );
    expect(clean).toContain("Every checked day matched — the import is faithful");

    const withMismatch = renderMarkdownReport(
      baseSummary({
        grandTotalCheck: {
          toleranceSatang: 100,
          daysChecked: 5,
          daysMatching: 4,
          daysMismatching: 1,
          totalAbsoluteDiscrepancySatangByProperty: { hf: 129_000 },
          worstOffenders: [
            {
              property: "hf",
              date: "2025-04-01",
              sheetName: "1",
              importedTotalSatang: 1_523_520,
              printedTotalSatang: 1_653_520,
              varianceSatang: -129_000,
              categoryBreakdown: { room_cash: 485_300, deposit: 100_000 },
              otherIncomeSatang: 0,
            },
          ],
        },
      }),
    );
    expect(withMismatch).toContain("1 do not");
    expect(withMismatch).toContain("hf: 1,290.00 THB");
    expect(withMismatch).toContain("hf 2025-04-01 (sheet `1`)");
    expect(withMismatch).toContain("room_cash=4,853.00");
    expect(withMismatch).toContain("deposit=1,000.00");
  });

  test("groups source-map contradictions into consecutive-date runs, and reports none cleanly", () => {
    const clean = renderMarkdownReport(baseSummary());
    expect(clean).toContain("None — every imported day's shape matched the source map.");

    const withContradictions = renderMarkdownReport(
      baseSummary({
        days: ["2025-03-01", "2025-03-02", "2025-03-03", "2025-09-18"].map((date) => ({
          property: "hf" as const,
          date,
          provenance: "reconstructed" as const,
          storedProvenance: "reconstructed" as const,
          sourceSummarySheet: null,
          sourceBookingWorkbook: "Ville per-booking",
          sourceBookingSheet: date,
          bookingLineCount: 3,
          incomeCategoriesWritten: 2,
          otherIncomeItemsWritten: 0,
          cashBlockOverrideWritten: false,
          contradictsSourceMap: `HF day ${date} has booking rows but no typed summary`,
        })),
      }),
    );
    expect(withContradictions).toContain("2025-03-01 to 2025-03-03 (3 days)");
    expect(withContradictions).toContain("- 2025-09-18");
  });

  test("dry-run mode is labeled as rolled back, not committed", () => {
    const md = renderMarkdownReport(baseSummary({ apply: false }));
    expect(md).toContain("dry-run (rolled back)");
  });

  test("surfaces copy-assumption violations prominently", () => {
    const md = renderMarkdownReport(
      baseSummary({
        skippedCopies: [
          {
            date: "2025-06-01",
            villeSheetName: "1-6-68",
            hasHfCounterpart: true,
            identicalToHf: false,
            diffDetail: "categories differ: ville=[roomCash=100] hf=[roomCash=200]",
            reconstructedFromBookings: false,
          },
        ],
      }),
    );
    expect(md).toContain("Violations — a human must look");
    expect(md).toContain("categories differ");
  });
});
