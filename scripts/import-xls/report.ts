// Renders the reconciliation report a human reads to decide go/no-go on the
// real import (see import.ts). Rendering is pure/testable; writeReportFiles
// is the one function here that touches disk.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PropertyCode } from "./types.ts";
import type { AppliedResolutionRow } from "./resolutions.ts";
import type { HumanCellSkipRow, HumanDaySkipRow } from "./human-edits.ts";
import { groupConsecutiveDates } from "./plan.ts";
import type {
  CategoryVarianceStat,
  DayProvenancePlan,
  DayRow,
  GrandTotalCheckResult,
  MonthlyTotal,
  QuarantineKind,
  QuarantineRow,
  SkippedCopyRow,
  TenderRowCounts,
  UnknownLabelRow,
} from "./plan.ts";

export type {
  AppliedResolutionRow,
  DayRow,
  GrandTotalCheckResult,
  HumanCellSkipRow,
  HumanDaySkipRow,
  MonthlyTotal,
  QuarantineKind,
  QuarantineRow,
  SkippedCopyRow,
  TenderRowCounts,
  UnknownLabelRow,
};

export interface ImportRunSummary {
  generatedAt: string;
  apply: boolean;
  dbPath: string;
  onlyDate: string | null;
  onlyProperty: PropertyCode | null;
  totalSheetsAcrossWorkbooks: number;
  days: DayRow[];
  quarantine: QuarantineRow[];
  skippedCopies: SkippedCopyRow[];
  variance: CategoryVarianceStat[];
  grandTotalCheck: GrandTotalCheckResult;
  unknownLabels: UnknownLabelRow[];
  tenderCounts: TenderRowCounts[];
  monthlyTotals: MonthlyTotal[];
  warnings: string[];
  /** Owner-approved sheet resolutions this run leaned on — see resolutions.ts. */
  resolutions: AppliedResolutionRow[];
  /** Income cells the human-edit guard refused to overwrite — see human-edits.ts. */
  humanCellSkips: HumanCellSkipRow[];
  /** Day-level (sheet_days) writes the human-edit guard refused. */
  humanDaySkips: HumanDaySkipRow[];
  /** How re-running this importer avoids double-importing — see import.ts. */
  idempotencyNote: string;
}

// ── small formatting helpers ────────────────────────────────────────────────

export function formatBaht(satang: number): string {
  return (satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dateRangeText(dates: string[]): string {
  if (dates.length === 0) return "(none)";
  const sorted = [...dates].sort();
  return `${sorted[0]} to ${sorted[sorted.length - 1]} (${dates.length} days)`;
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values: Array<string | number | boolean | null>): string {
  return values.map(csvCell).join(",");
}

// ── CSV renderers ───────────────────────────────────────────────────────────

export function renderDaysCsv(summary: ImportRunSummary): string {
  const header = csvRow([
    "property",
    "date",
    "provenance",
    "storedProvenance",
    "sourceSummarySheet",
    "sourceBookingWorkbook",
    "sourceBookingSheet",
    "bookingLineCount",
    "incomeCategoriesWritten",
    "otherIncomeItemsWritten",
    "cashBlockOverrideWritten",
    "contradictsSourceMap",
  ]);
  const rows = summary.days.map((d) =>
    csvRow([
      d.property,
      d.date,
      d.provenance,
      d.storedProvenance,
      d.sourceSummarySheet,
      d.sourceBookingWorkbook,
      d.sourceBookingSheet,
      d.bookingLineCount,
      d.incomeCategoriesWritten,
      d.otherIncomeItemsWritten,
      d.cashBlockOverrideWritten,
      d.contradictsSourceMap,
    ]),
  );
  return [header, ...rows].join("\n") + "\n";
}

export function renderQuarantineCsv(summary: ImportRunSummary): string {
  const header = csvRow(["property", "date", "kind", "workbookLabel", "sheetNames", "detail"]);
  const rows = summary.quarantine.map((q) =>
    csvRow([q.property, q.date, q.kind, q.workbookLabel, q.sheetNames.join("; "), q.detail]),
  );
  return [header, ...rows].join("\n") + "\n";
}

export function renderVarianceCsv(summary: ImportRunSummary): string {
  const header = csvRow([
    "property",
    "categoryKey",
    "daysCompared",
    "daysExceedingTolerance",
    "totalTypedBaht",
    "totalDerivedBaht",
    "totalVarianceBaht",
  ]);
  const rows = summary.variance.map((v) =>
    csvRow([
      v.property,
      v.categoryKey,
      v.daysCompared,
      v.daysExceedingTolerance,
      formatBaht(v.totalTypedSatang),
      formatBaht(v.totalDerivedSatang),
      formatBaht(v.totalVarianceSatang),
    ]),
  );
  return [header, ...rows].join("\n") + "\n";
}

// ── Markdown renderer ───────────────────────────────────────────────────────

function renderDayCountsSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Days imported per property", ""];
  const properties = [...new Set(summary.days.map((d) => d.property))].sort();
  for (const property of properties) {
    lines.push(`### ${property}`, "");
    for (const provenance of ["transcribed", "reconstructed", "summary_only"] as DayProvenancePlan[]) {
      const dates = summary.days
        .filter((d) => d.property === property && d.provenance === provenance)
        .map((d) => d.date);
      lines.push(`- **${provenance}**: ${dateRangeText(dates)}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * Every day whose shape wasn't predicted by the source map — i.e. booking
 * rows with no typed summary outside the Ville copy window (see plan.ts
 * buildDayPlans). Grouped into consecutive-date runs so an expected
 * month-long gap (before a summary workbook's own start date) reads as one
 * line instead of drowning out genuine one-off gaps that need a look.
 */
function renderSourceMapContradictionsSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Source-map contradictions", ""];
  const contradicting = summary.days.filter((d) => d.contradictsSourceMap !== null);
  if (contradicting.length === 0) {
    lines.push("None — every imported day's shape matched the source map.", "");
    return lines;
  }

  lines.push(
    `${contradicting.length} day(s) were reconstructed from booking rows with no typed summary, outside the Ville copy window ` +
      "— i.e. a shape the source map did not predict. A contiguous run at the very start of a property's range usually just " +
      "means booking data starts before its summary workbook does (expected); an isolated single-day run usually traces back " +
      "to a quarantined sheet for that date (see Quarantined and unresolved above) and is worth a look.",
    "",
  );

  const properties = [...new Set(contradicting.map((d) => d.property))].sort();
  for (const property of properties) {
    const dates = contradicting.filter((d) => d.property === property).map((d) => d.date);
    const runs = groupConsecutiveDates(dates);
    lines.push(`### ${property} (${dates.length} day(s))`, "");
    for (const run of runs) {
      lines.push(run.count === 1 ? `- ${run.start}` : `- ${run.start} to ${run.end} (${run.count} days)`);
    }
    lines.push("");
  }
  return lines;
}

function formatCategoryBreakdown(breakdown: Record<string, number | undefined>, otherIncomeSatang: number): string {
  const parts = Object.entries(breakdown)
    .filter((entry): entry is [string, number] => entry[1] !== undefined && entry[1] !== 0)
    .map(([key, amount]) => `${key}=${formatBaht(amount)}`);
  if (otherIncomeSatang !== 0) parts.push(`other_income_items=${formatBaht(otherIncomeSatang)}`);
  return parts.length > 0 ? parts.join(", ") : "(nothing written)";
}

/**
 * The single most convincing proof that nothing was silently dropped: every
 * summary sheet carries its own printed grand total (รวม); this compares it
 * against the day's total imported income (all category cells plus
 * everything landed in other_income_items) with the same 1 THB tolerance
 * used everywhere else in this report.
 */
function renderGrandTotalCheckSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Grand-total reconciliation (imported vs. the sheet's own printed รวม)", ""];
  const check = summary.grandTotalCheck;
  lines.push(
    `${check.daysChecked} day(s) had a printed total to compare against. ${check.daysMatching} match within ` +
      `${formatBaht(check.toleranceSatang)} THB; ${check.daysMismatching} do not.`,
    "",
  );

  const discrepancyEntries = Object.entries(check.totalAbsoluteDiscrepancySatangByProperty);
  if (discrepancyEntries.length > 0) {
    lines.push("Total absolute discrepancy per property:", "");
    for (const [property, satang] of discrepancyEntries) {
      lines.push(`- ${property}: ${formatBaht(satang ?? 0)} THB`);
    }
    lines.push("");
  }

  if (check.worstOffenders.length > 0) {
    lines.push(`**Worst ${check.worstOffenders.length} day(s) — imported vs. printed, with the category breakdown:**`, "");
    for (const row of check.worstOffenders) {
      lines.push(
        `- ${row.property} ${row.date} (sheet \`${row.sheetName}\`): imported ${formatBaht(row.importedTotalSatang)}, ` +
          `printed ${formatBaht(row.printedTotalSatang)}, variance ${formatBaht(row.varianceSatang)}`,
      );
      lines.push(`  - breakdown: ${formatCategoryBreakdown(row.categoryBreakdown, row.otherIncomeSatang)}`);
    }
    lines.push("");
  } else if (check.daysChecked > 0) {
    lines.push("Every checked day matched — the import is faithful to what each sheet itself claims to total.", "");
  }

  return lines;
}

export function renderGrandTotalCheckCsv(summary: ImportRunSummary): string {
  const header = csvRow(["property", "date", "sheetName", "importedTotalBaht", "printedTotalBaht", "varianceBaht"]);
  const rows = summary.grandTotalCheck.worstOffenders.map((r) =>
    csvRow([r.property, r.date, r.sheetName, formatBaht(r.importedTotalSatang), formatBaht(r.printedTotalSatang), formatBaht(r.varianceSatang)]),
  );
  return [header, ...rows].join("\n") + "\n";
}

function renderCopyAssumptionSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Ville copy-window (skipped-as-copy) check", ""];
  const total = summary.skippedCopies.length;
  const reconstructed = summary.skippedCopies.filter((s) => s.reconstructedFromBookings).length;
  const violations = summary.skippedCopies.filter((s) => s.identicalToHf === false);
  const noCounterpart = summary.skippedCopies.filter((s) => !s.hasHfCounterpart);

  lines.push(
    `Ville summary sheets dated before 2025-12-12: ${total} skipped as stale HF copies (never imported as Ville income).`,
    `Of those, ${reconstructed} had Ville booking rows and were reconstructed instead (provenance \`reconstructed\`).`,
    `Copy-assumption violations (Ville summary differs from its HF counterpart on the same date): ${violations.length}.`,
  );
  if (noCounterpart.length > 0) {
    lines.push(`Sheets with no HF summary sheet to compare against: ${noCounterpart.length}.`);
  }
  lines.push("");

  if (violations.length > 0) {
    lines.push("**Violations — a human must look:**", "");
    for (const v of violations) {
      lines.push(`- ${v.date} (sheet \`${v.villeSheetName}\`): ${v.diffDetail}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * The owner-approved resolutions this run applied (resolutions.ts). Printed
 * in full, with what each sheet's own signals had claimed, so the report
 * shows every place a human decision overrode the importer's own reading.
 */
function renderResolutionsSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Owner-approved sheet resolutions applied", ""];
  if (summary.resolutions.length === 0) {
    lines.push("None — no listed sheet was present in this run.", "");
    return lines;
  }
  const accepted = summary.resolutions.filter((r) => r.action === "accept");
  const ignored = summary.resolutions.filter((r) => r.action === "ignore");
  lines.push(
    `${summary.resolutions.length} sheet(s) carried an explicit human ruling: ${accepted.length} accepted under a ` +
      `given (property, date), ${ignored.length} ignored. Every other sheet went through the unchanged date vote ` +
      "and property classifier.",
    "",
  );

  if (accepted.length > 0) {
    lines.push("### Accepted", "");
    for (const r of accepted) {
      lines.push(`- **${r.property} ${r.date}** — ${r.workbook} \`${r.sheetName}\``);
      lines.push(`  - sheet itself said: ${r.originalDetail}`);
      lines.push(`  - why: ${r.rationale}`);
    }
    lines.push("");
  }
  if (ignored.length > 0) {
    lines.push("### Ignored", "");
    for (const r of ignored) {
      lines.push(`- ${r.workbook} \`${r.sheetName}\``);
      lines.push(`  - sheet itself said: ${r.originalDetail}`);
      lines.push(`  - why: ${r.rationale}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * What the human-edit guard refused to overwrite (human-edits.ts). An empty
 * section is the normal case on a fresh database; a non-empty one is the
 * audit trail proving hand-entered figures survived the run.
 */
function renderHumanEditGuardSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Human-edit guard (what the importer refused to overwrite)", ""];
  lines.push(
    "The rule: this importer only ever overwrites what this importer itself wrote. An income cell counts as " +
      "importer-owned only when `source = 'import'` AND `updated_by = 'import:excel'`; a day's `sheet_days` row " +
      "(note, the four cash-block override fields, verification stamp, provenance) only when its `updated_by` is " +
      "`import:excel`. Anything else belongs to a person and wins over the workbook, on this and every future run.",
    "",
    `Income cells skipped: **${summary.humanCellSkips.length}**. Day-level writes skipped: **${summary.humanDaySkips.length}**.`,
    "",
  );

  if (summary.humanCellSkips.length > 0) {
    lines.push("**Cells left as the human set them (workbook value NOT written):**", "");
    for (const s of summary.humanCellSkips) {
      lines.push(
        `- ${s.property} ${s.date} category ${s.categoryKey ?? s.categoryId}: kept ${formatBaht(s.existingSatang)} ` +
          `(source=${s.existingSource}, by ${s.existingUpdatedBy}); workbook wanted ${formatBaht(s.workbookSatang)}`,
      );
    }
    lines.push("");
  }
  if (summary.humanDaySkips.length > 0) {
    lines.push(
      "**Days whose day-level fields were left alone** (the day's own row below still states the provenance " +
        "actually stored, `storedProvenance` — never the planned one this run couldn't apply):",
      "",
    );
    for (const s of summary.humanDaySkips) {
      const dayRow = summary.days.find((d) => d.property === s.property && d.date === s.date);
      const storedProvenanceNote = dayRow ? ` (provenance actually stored: \`${dayRow.storedProvenance}\`)` : "";
      lines.push(
        `- ${s.property} ${s.date}: sheet_days last written by ${s.existingUpdatedBy}${storedProvenanceNote} — not applied: ` +
          `${s.skippedFields.length > 0 ? s.skippedFields.join(", ") : "(nothing this run wanted to write)"}`,
      );
    }
    lines.push("");
  }
  return lines;
}

function renderQuarantineSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Quarantined and unresolved", ""];
  if (summary.quarantine.length === 0) {
    lines.push("None.", "");
    return lines;
  }
  const byKind = new Map<QuarantineKind, QuarantineRow[]>();
  for (const q of summary.quarantine) {
    const arr = byKind.get(q.kind) ?? [];
    arr.push(q);
    byKind.set(q.kind, arr);
  }
  for (const [kind, rows] of byKind) {
    lines.push(`### ${kind} (${rows.length})`, "");
    for (const row of rows) {
      const label = row.property && row.date ? `${row.property} ${row.date}` : "(date unresolved)";
      lines.push(`- ${label} — ${row.workbookLabel}: ${row.sheetNames.join(", ")} — ${row.detail}`);
    }
    lines.push("");
  }
  lines.push("Full detail in `quarantine.csv`.", "");
  return lines;
}

function renderVarianceSection(summary: ImportRunSummary): string[] {
  const lines: string[] = [
    "## Typed vs. derived-from-bookings variance",
    "",
    "The typed summary always wins and is what gets written; this is purely diagnostic. " +
      "A day counts as exceeding tolerance only beyond 1 THB (RECONCILE_TOLERANCE_SATANG).",
    "",
  ];
  if (summary.variance.length === 0) {
    lines.push("No days had both a typed summary and booking rows to compare.", "");
    return lines;
  }
  lines.push("| property | category | days compared | days exceeding tolerance | total typed | total derived | total variance |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const v of summary.variance) {
    lines.push(
      `| ${v.property} | ${v.categoryKey} | ${v.daysCompared} | ${v.daysExceedingTolerance} | ${formatBaht(v.totalTypedSatang)} | ${formatBaht(v.totalDerivedSatang)} | ${formatBaht(v.totalVarianceSatang)} |`,
    );
  }
  lines.push("");

  const worstOverall = summary.variance.filter((v) => v.worstOffenders.length > 0);
  if (worstOverall.length > 0) {
    lines.push("**Worst offenders by category:**", "");
    for (const v of worstOverall) {
      lines.push(`- ${v.property} / ${v.categoryKey}:`);
      for (const offender of v.worstOffenders) {
        lines.push(
          `  - ${offender.date}: typed ${formatBaht(offender.typedSatang)}, derived ${formatBaht(offender.derivedSatang)}, variance ${formatBaht(offender.varianceSatang)}`,
        );
      }
    }
    lines.push("");
  }
  return lines;
}

function renderUnknownLabelsSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Unknown labels", ""];
  if (summary.unknownLabels.length === 0) {
    lines.push("None.", "");
    return lines;
  }
  const folded = summary.unknownLabels.filter((u) => u.folded);
  const notFolded = summary.unknownLabels.filter((u) => !u.folded);
  lines.push(
    `Total: ${summary.unknownLabels.length}. Folded into itemized other-income: ${folded.length}. Left unfolded (reported only): ${notFolded.length}.`,
    "",
  );
  for (const u of summary.unknownLabels) {
    lines.push(
      `- ${u.folded ? "[folded]" : "[NOT folded]"} ${u.property} ${u.date} (sheet \`${u.sheetName}\`): "${u.label}" = ${formatBaht(u.amountSatang)} THB — ${u.reason}`,
    );
  }
  lines.push("");
  return lines;
}

function renderTenderCountsSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Booking-line tender counts", ""];
  if (summary.tenderCounts.length === 0) {
    lines.push("No booking lines imported.", "");
    return lines;
  }
  lines.push("| property | total rows | multi-tender (>=2) | zero-tender (coupon/comp) |");
  lines.push("|---|---|---|---|");
  for (const t of summary.tenderCounts) {
    lines.push(`| ${t.property} | ${t.totalRows} | ${t.multiTenderRows} | ${t.zeroTenderRows} |`);
  }
  lines.push("");
  return lines;
}

function renderMonthlyTotalsSection(summary: ImportRunSummary): string[] {
  const lines: string[] = ["## Monthly totals per property", ""];
  if (summary.monthlyTotals.length === 0) {
    lines.push("No data.", "");
    return lines;
  }
  const properties = [...new Set(summary.monthlyTotals.map((m) => m.property))].sort();
  for (const property of properties) {
    lines.push(`### ${property}`, "", "| month | income (THB) | days |", "|---|---|---|");
    const rows = summary.monthlyTotals.filter((m) => m.property === property).sort((a, b) => a.month.localeCompare(b.month));
    for (const row of rows) {
      lines.push(`| ${row.month} | ${formatBaht(row.incomeSatang)} | ${row.dayCount} |`);
    }
    lines.push("");
  }
  return lines;
}

export function renderMarkdownReport(summary: ImportRunSummary): string {
  const lines: string[] = [
    "# Excel import reconciliation report",
    "",
    `Generated: ${summary.generatedAt}`,
    `Mode: ${summary.apply ? "**APPLY (committed)**" : "dry-run (rolled back)"}`,
    `Database: \`${summary.dbPath}\``,
    summary.onlyProperty ? `Filter: property=${summary.onlyProperty}` : null,
    summary.onlyDate ? `Filter: date=${summary.onlyDate}` : null,
    `Total sheets parsed across all four workbooks: ${summary.totalSheetsAcrossWorkbooks}`,
    "",
  ].filter((l): l is string => l !== null);

  lines.push(...renderDayCountsSection(summary));
  lines.push(...renderGrandTotalCheckSection(summary));
  lines.push(...renderSourceMapContradictionsSection(summary));
  lines.push(...renderCopyAssumptionSection(summary));
  lines.push(...renderResolutionsSection(summary));
  lines.push(...renderHumanEditGuardSection(summary));
  lines.push(...renderQuarantineSection(summary));
  lines.push(...renderVarianceSection(summary));
  lines.push(...renderUnknownLabelsSection(summary));
  lines.push(...renderTenderCountsSection(summary));
  lines.push(...renderMonthlyTotalsSection(summary));

  lines.push("## Idempotency", "", summary.idempotencyNote, "");

  if (summary.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const w of summary.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function renderResolutionsCsv(summary: ImportRunSummary): string {
  const header = csvRow(["workbook", "sheetName", "action", "property", "date", "originalDetail", "rationale"]);
  const rows = summary.resolutions.map((r) =>
    csvRow([r.workbook, r.sheetName, r.action, r.property, r.date, r.originalDetail, r.rationale]),
  );
  return [header, ...rows].join("\n") + "\n";
}

export function renderHumanEditSkipsCsv(summary: ImportRunSummary): string {
  const header = csvRow([
    "kind",
    "property",
    "date",
    "categoryKey",
    "keptBaht",
    "keptSource",
    "keptUpdatedBy",
    "workbookBaht",
    "skippedFields",
  ]);
  const cellRows = summary.humanCellSkips.map((s) =>
    csvRow([
      "income-cell",
      s.property,
      s.date,
      s.categoryKey ?? String(s.categoryId),
      formatBaht(s.existingSatang),
      s.existingSource,
      s.existingUpdatedBy,
      formatBaht(s.workbookSatang),
      "",
    ]),
  );
  const dayRows = summary.humanDaySkips.map((s) =>
    csvRow(["day-level", s.property, s.date, "", "", "", s.existingUpdatedBy, "", s.skippedFields.join("; ")]),
  );
  return [header, ...cellRows, ...dayRows].join("\n") + "\n";
}

export interface WrittenReportFiles {
  markdownPath: string;
  daysCsvPath: string;
  quarantineCsvPath: string;
  varianceCsvPath: string;
  grandTotalCheckCsvPath: string;
  resolutionsCsvPath: string;
  humanEditSkipsCsvPath: string;
}

export function writeReportFiles(outDir: string, summary: ImportRunSummary): WrittenReportFiles {
  mkdirSync(outDir, { recursive: true });
  const markdownPath = join(outDir, "report.md");
  const daysCsvPath = join(outDir, "days.csv");
  const quarantineCsvPath = join(outDir, "quarantine.csv");
  const varianceCsvPath = join(outDir, "variance.csv");
  const grandTotalCheckCsvPath = join(outDir, "grand-total-check.csv");
  const resolutionsCsvPath = join(outDir, "resolutions.csv");
  const humanEditSkipsCsvPath = join(outDir, "human-edit-skips.csv");

  writeFileSync(markdownPath, renderMarkdownReport(summary));
  writeFileSync(daysCsvPath, renderDaysCsv(summary));
  writeFileSync(quarantineCsvPath, renderQuarantineCsv(summary));
  writeFileSync(varianceCsvPath, renderVarianceCsv(summary));
  writeFileSync(grandTotalCheckCsvPath, renderGrandTotalCheckCsv(summary));
  writeFileSync(resolutionsCsvPath, renderResolutionsCsv(summary));
  writeFileSync(humanEditSkipsCsvPath, renderHumanEditSkipsCsv(summary));

  return {
    markdownPath,
    daysCsvPath,
    quarantineCsvPath,
    varianceCsvPath,
    grandTotalCheckCsvPath,
    resolutionsCsvPath,
    humanEditSkipsCsvPath,
  };
}
