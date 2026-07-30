#!/usr/bin/env bun
// Parse all four real workbooks and print a summary. Read-only, no writes,
// no database access — this is purely a verification CLI for the parse
// layer in this directory.
//
// Usage: bun scripts/import-xls/parse-only.ts

import { parseSummaryWorkbook } from "./parse-summary.ts";
import { parseReportWorkbook } from "./parse-report.ts";
import type { DateResolution, PlainDate, ReportWorkbookResult, SummaryWorkbookResult } from "./types.ts";

const HF_SUMMARY_PATH = "/Users/nut/Downloads/สรุปยอด(รายวัน).xls";
const HF_REPORT_PATH = "/Users/nut/Downloads/รายงานรายรับโรงแรม(รายวัน).xlsx";
const VILLE_SUMMARY_PATH = "/Users/nut/Downloads/สรุปยอดรายวัน - HF-Ville.xls";
const VILLE_REPORT_PATH = "/Users/nut/Downloads/รายงานรายรับโรงแรมรายวัน HF-VILLE.xls";

function formatPlainDate(date: PlainDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/**
 * Prints the date-resolution breakdown shared by both workbook kinds:
 * resolved (via majority or a single surviving candidate), discarded
 * implausible candidates, and every GENUINE conflict listed with all its
 * surviving candidates (never sliced — these are meant to be reviewed).
 */
function printDateResolutionReport(days: Array<{ sheetName: string; dateResolution: DateResolution }>): void {
  const resolved = days.filter((d) => !d.dateResolution.unresolved);
  const singleSource = days.filter((d) => d.dateResolution.singleSource);
  const majorityDespiteOutlier = days.filter(
    (d) => !d.dateResolution.unresolved && d.dateResolution.hasDisagreement,
  );
  const withDiscardedCandidates = days.filter((d) => d.dateResolution.discarded.length > 0);
  const failures = days.filter((d) => d.dateResolution.unresolved);

  console.log(`dates resolved: ${resolved.length}/${days.length}`);
  console.log(`  resolved from a single surviving candidate (nothing else to contradict it): ${singleSource.length}`);
  console.log(`  resolved via majority despite one disagreeing candidate: ${majorityDespiteOutlier.length}`);
  console.log(`  sheets with an implausible candidate discarded before voting: ${withDiscardedCandidates.length}`);
  console.log(`date failures (genuine conflict among survivors, or no candidate survives): ${failures.length}`);
  for (const d of failures) {
    const candidates = d.dateResolution.sources
      .filter((s) => s.date !== null)
      .map((s) => `${s.source}=${formatPlainDate(s.date!)}`)
      .join(", ");
    const discardedNote =
      d.dateResolution.discarded.length > 0
        ? ` [discarded: ${d.dateResolution.discarded.map((c) => `${c.source}=${formatPlainDate(c.date)}`).join(", ")}]`
        : "";
    console.log(`  ${d.sheetName}: ${candidates || "(no candidate survives)"}${discardedNote}`);
  }
}

function printSummaryWorkbookReport(label: string, result: SummaryWorkbookResult): void {
  console.log(`\n=== ${label} (summary) ===`);
  console.log(`file: ${result.filePath}`);
  console.log(`sheets parsed: ${result.sheetsParsed}`);

  printDateResolutionReport(result.days);

  const totalUnknownLabels = result.days.reduce((sum, d) => sum + d.unknownLabels.length, 0);
  console.log(`unknown labels (non-zero amount, reportable): ${totalUnknownLabels}`);
  if (totalUnknownLabels > 0) {
    const examples = result.days
      .flatMap((d) => d.unknownLabels.map((u) => `${d.sheetName}:${u.label}=${u.amountSatang}`))
      .slice(0, 10);
    console.log(`  examples: ${examples.join(" | ")}`);
  }

  const totalOtherIncomeItems = result.days.reduce((sum, d) => sum + d.otherIncomeItems.length, 0);
  console.log(`itemized other-income entries: ${totalOtherIncomeItems}`);

  const daysWithPrintedTotal = result.days.filter((d) => d.printedTotalSatang !== null).length;
  console.log(`sheets with a printed grand total: ${daysWithPrintedTotal}/${result.days.length}`);
}

function printReportWorkbookReport(label: string, result: ReportWorkbookResult): void {
  console.log(`\n=== ${label} (per-booking) ===`);
  console.log(`file: ${result.filePath}`);
  console.log(`sheets parsed: ${result.sheetsParsed}`);

  printDateResolutionReport(result.days);

  console.log(`quarantined sheets (property unresolved): ${result.quarantinedSheets.length}/${result.sheetsParsed}`);
  const byReason = new Map<string, number>();
  for (const q of result.quarantinedSheets) {
    byReason.set(q.reason, (byReason.get(q.reason) ?? 0) + 1);
  }
  for (const [reason, count] of byReason) {
    console.log(`  ${reason}: ${count}`);
  }
  if (result.quarantinedSheets.length > 0) {
    console.log(
      `  examples: ${result.quarantinedSheets
        .slice(0, 5)
        .map((q) => `${q.sheetName} (${q.reason})`)
        .join(", ")}`,
    );
  }

  const allBookingRows = result.days.flatMap((d) => d.bookingRows);
  console.log(`total booking rows: ${allBookingRows.length}`);

  const tenderColumnCount = (tenders: (typeof allBookingRows)[number]["tenders"]) =>
    Object.values(tenders).filter((v) => v !== 0).length;
  const multiTenderRows = allBookingRows.filter((r) => tenderColumnCount(r.tenders) >= 2);
  const zeroTenderRows = allBookingRows.filter((r) => tenderColumnCount(r.tenders) === 0);
  console.log(`multi-tender rows (>=2 tender columns populated): ${multiTenderRows.length}`);
  console.log(`zero-tender rows (coupon/comp, amount in discount): ${zeroTenderRows.length}`);

  const anomalousSeqRows = allBookingRows.filter((r) => r.missingSeqAnomaly);
  console.log(`booking rows missing a seq number (anomaly): ${anomalousSeqRows.length}`);

  const rowsWithDiscount = allBookingRows.filter((r) => r.discountSatang !== 0);
  console.log(`rows carrying a discount: ${rowsWithDiscount.length}`);

  const totalSkippedBlank = result.days.reduce((sum, d) => sum + d.skippedBlankRowCount, 0);
  console.log(`skipped blank pre-formatted rows: ${totalSkippedBlank}`);

  const totalUnclassified = result.days.reduce((sum, d) => sum + d.unclassifiedRows.length, 0);
  console.log(`unclassified/stray rows (kept visible, not silently dropped): ${totalUnclassified}`);
  if (totalUnclassified > 0) {
    const examples = result.days
      .flatMap((d) => d.unclassifiedRows.map((u) => `${d.sheetName}#${u.rowIndex}: ${u.raw}`))
      .slice(0, 5);
    console.log(`  examples: ${examples.join("\n             ")}`);
  }

  const sheetsMissingTotalsRow = result.days.filter((d) => d.totalsRow === null && d.bookingRows.length > 0).length;
  console.log(`sheets with booking rows but no detected totals row: ${sheetsMissingTotalsRow}`);

  const sheetsWithOwnSummaryBlock = result.days.filter((d) => d.ownSummaryBlock.lines.length > 0).length;
  console.log(`sheets with a captured recap block: ${sheetsWithOwnSummaryBlock}/${result.sheetsParsed}`);

  const reconciliationMismatches = result.days.filter((d) => {
    if (d.totalsRow === null || d.ownSummaryBlock.reconciliationTotalSatang === null) return false;
    return d.totalsRow.grossRoomSatang !== d.ownSummaryBlock.reconciliationTotalSatang;
  }).length;
  const reconciliationComparable = result.days.filter(
    (d) => d.totalsRow !== null && d.ownSummaryBlock.reconciliationTotalSatang !== null,
  ).length;
  console.log(
    `sheets where the recap block's own total disagrees with the booking-row totals: ${reconciliationMismatches}/${reconciliationComparable}`,
  );
}

function main(): void {
  const startedAt = Date.now();

  const hfSummary = parseSummaryWorkbook(HF_SUMMARY_PATH, "hf");
  printSummaryWorkbookReport("HF summary", hfSummary);

  const villeSummary = parseSummaryWorkbook(VILLE_SUMMARY_PATH, "hfville");
  printSummaryWorkbookReport("Ville summary", villeSummary);

  const hfReport = parseReportWorkbook(HF_REPORT_PATH);
  printReportWorkbookReport("HF per-booking", hfReport);

  const villeReport = parseReportWorkbook(VILLE_REPORT_PATH);
  printReportWorkbookReport("Ville per-booking", villeReport);

  const totalSheets =
    hfSummary.sheetsParsed + villeSummary.sheetsParsed + hfReport.sheetsParsed + villeReport.sheetsParsed;
  console.log(`\n=== overall ===`);
  console.log(`total sheets across all four workbooks: ${totalSheets}`);
  console.log(`elapsed: ${Date.now() - startedAt}ms`);
}

main();
