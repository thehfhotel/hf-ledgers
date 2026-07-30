#!/usr/bin/env bun
// One-time Excel-to-database importer — wires the pure parse layer
// (parse-summary.ts / parse-report.ts) and the pure decision tree (plan.ts)
// to src/server/db.ts's exported write functions, then produces the
// reconciliation report a human reads to decide go/no-go (report.ts).
//
// Dry-run is the default: every day is written inside its own transaction
// that is rolled back unless --apply is passed, so a dry run exercises the
// EXACT same write path as a real run (see runDayTransaction below).
//
// Usage:
//   bun scripts/import-xls/import.ts [--apply] [--db <path>] [--out <dir>]
//     [--only-date YYYY-MM-DD] [--property hf|hfville]

import { parseArgs } from "node:util";
import type { Database } from "bun:sqlite";
import { parseSummaryWorkbook } from "./parse-summary.ts";
import { parseReportWorkbook } from "./parse-report.ts";
import { inferIsCashFromFreeText } from "./normalize.ts";
import type { BookingRow, CashBlockKey, PropertyCode, SummaryCategoryKey } from "./types.ts";
import {
  aggregateVariance,
  buildDayPlans,
  CASH_BLOCK_KEY_TO_APP_FIELD,
  checkGrandTotals,
  describeDateResolution,
  deriveNonBookingIncomeFromRecap,
  fieldsExceedingLength,
  groupReportSheetsByPropertyDate,
  groupSummaryDaysByDate,
  monthOf,
  singleSheetByDate,
  SUMMARY_CATEGORY_TO_APP_KEY,
  splitReportGroupKey,
  tenderColumnCount,
  toAppTenders,
  toDerivationBookingLine,
  VARIANCE_CATEGORY_KEYS,
} from "./plan.ts";
import type {
  DayImportPlan,
  DayRow,
  GrandTotalCheckSample,
  LabeledReportSheet,
  QuarantineRow,
  VarianceSample,
} from "./plan.ts";
import {
  acceptedSummaryDates,
  applyResolutionsToReportSheets,
  applyResolutionsToSummaryDays,
  assertEveryResolutionMatched,
} from "./resolutions.ts";
import type { AppliedResolutionRow, SheetResolution } from "./resolutions.ts";
import {
  IMPORT_ACTOR,
  importerMayWriteDayLevel,
  importerMayWriteIncomeCell,
} from "./human-edits.ts";
import type { HumanCellSkipRow, HumanDaySkipRow } from "./human-edits.ts";
import { writeReportFiles } from "./report.ts";
import type { ImportRunSummary, MonthlyTotal, TenderRowCounts, UnknownLabelRow } from "./report.ts";
import { deriveIncomeFromBookings, RECONCILE_TOLERANCE_SATANG } from "../../src/shared/bookings.ts";
import type { CashBlockAmounts, CategoryKey, DayProvenance } from "../../src/shared/types.ts";
import type * as DbModule from "../../src/server/db.ts";

// ── the source map's four fixed workbooks ──────────────────────────────────

const HF_SUMMARY_PATH = "/Users/nut/Downloads/สรุปยอด(รายวัน).xls";
const HF_REPORT_PATH = "/Users/nut/Downloads/รายงานรายรับโรงแรม(รายวัน).xlsx";
const VILLE_SUMMARY_PATH = "/Users/nut/Downloads/สรุปยอดรายวัน - HF-Ville.xls";
const VILLE_REPORT_PATH = "/Users/nut/Downloads/รายงานรายรับโรงแรมรายวัน HF-VILLE.xls";

const BOUND = {
  BOOKING_NO_MAX_LEN: 40,
  GUEST_NAME_MAX_LEN: 120,
  ROOM_NO_MAX_LEN: 40,
  COUNT_MAX: 999,
  DESCRIPTION_MAX_LEN: 200,
};

// ── CLI ─────────────────────────────────────────────────────────────────────

interface CliOptions {
  apply: boolean;
  dbPath: string;
  outDir: string;
  onlyDate: string | null;
  onlyProperty: PropertyCode | null;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: "boolean", default: false },
      db: { type: "string", default: "./data/ledger.db" },
      out: { type: "string", default: "./data/import-report" },
      "only-date": { type: "string" },
      property: { type: "string" },
    },
  });

  const onlyDate = values["only-date"] ?? null;
  if (onlyDate !== null && !ISO_DATE_PATTERN.test(onlyDate)) {
    throw new Error(`--only-date must be YYYY-MM-DD, got "${onlyDate}"`);
  }

  const propertyValue = values.property ?? null;
  if (propertyValue !== null && propertyValue !== "hf" && propertyValue !== "hfville") {
    throw new Error(`--property must be "hf" or "hfville", got "${propertyValue}"`);
  }

  return {
    apply: values.apply === true,
    dbPath: values.db ?? "./data/ledger.db",
    outDir: values.out ?? "./data/import-report",
    onlyDate,
    onlyProperty: propertyValue as PropertyCode | null,
  };
}

// ── transaction helper: one transaction per day, rolled back unless --apply ─

function runDayTransaction(database: Database, apply: boolean, work: () => void): void {
  database.exec("BEGIN");
  try {
    work();
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  database.exec(apply ? "COMMIT" : "ROLLBACK");
}

// ── raw-SQL helpers for the two things db.ts has no exported setter for ────
// (CLAUDE.md: src/** is read-only for this job — these mirror the exact
// upsert/delete shape of the neighboring functions already in db.ts).

function upsertSheetDayProvenance(
  database: Database,
  property: PropertyCode,
  date: string,
  provenance: DayImportPlan["provenance"],
  by: string,
): void {
  database
    .prepare(
      `INSERT INTO sheet_days (property, date, note, updated_at, updated_by, provenance)
       VALUES (?, ?, NULL, datetime('now'), ?, ?)
       ON CONFLICT (property, date) DO UPDATE SET
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by,
         provenance = excluded.provenance`,
    )
    .run(property, date, by, provenance);
}

/** Idempotent replace, keyed on (property, date): delete only the rows THIS
 *  importer previously created (created_by = import:excel) before
 *  re-inserting, so a second run reflects the source files exactly rather
 *  than accumulating duplicates — never touches a human's manually entered
 *  rows for the same day. */
function deletePriorImportRows(
  database: Database,
  table: "booking_lines" | "other_income_items",
  property: PropertyCode,
  date: string,
): void {
  database.prepare(`DELETE FROM ${table} WHERE property = ? AND date = ? AND created_by = ?`).run(
    property,
    date,
    IMPORT_ACTOR,
  );
}

// ── quarantine row builders ─────────────────────────────────────────────────

function summaryQuarantineRows(
  workbookLabel: string,
  property: PropertyCode,
  groups: ReturnType<typeof groupSummaryDaysByDate>,
): QuarantineRow[] {
  const rows: QuarantineRow[] = [];
  for (const [date, sheets] of groups.byDate) {
    if (sheets.length <= 1) continue;
    rows.push({
      property,
      date,
      kind: "duplicate-date",
      workbookLabel,
      sheetNames: sheets.map((s) => s.sheetName),
      detail: `${sheets.length} sheets resolve to the same date — refusing to merge`,
    });
  }
  for (const day of groups.unresolved) {
    rows.push({
      property,
      date: null,
      kind: "unresolved-date",
      workbookLabel,
      sheetNames: [day.sheetName],
      detail: describeDateResolution(day.dateResolution),
    });
  }
  return rows;
}

function reportQuarantineRows(groups: ReturnType<typeof groupReportSheetsByPropertyDate>): QuarantineRow[] {
  const rows: QuarantineRow[] = [];
  for (const [key, sheets] of groups.byPropertyDate) {
    if (sheets.length <= 1) continue;
    const [property, date] = splitReportGroupKey(key);
    rows.push({
      property,
      date,
      kind: "duplicate-date",
      workbookLabel: "per-booking",
      sheetNames: sheets.map((s) => `${s.workbookLabel}:${s.record.sheetName}`),
      detail: `${sheets.length} sheets resolve to the same (property, date) — refusing to merge`,
    });
  }
  for (const labeled of groups.unresolvedDate) {
    rows.push({
      property: null,
      date: null,
      kind: "unresolved-date",
      workbookLabel: labeled.workbookLabel,
      sheetNames: [labeled.record.sheetName],
      detail: describeDateResolution(labeled.record.dateResolution),
    });
  }
  for (const labeled of groups.propertyQuarantined) {
    const resolvedDate = labeled.record.dateResolution.date;
    const date = resolvedDate
      ? `${resolvedDate.year}-${String(resolvedDate.month).padStart(2, "0")}-${String(resolvedDate.day).padStart(2, "0")}`
      : null;
    rows.push({
      property: null,
      date,
      kind: "property-quarantine",
      workbookLabel: labeled.workbookLabel,
      sheetNames: [labeled.record.sheetName],
      detail: `${labeled.record.quarantineReason}: ${labeled.record.quarantineDetail}`,
    });
  }
  return rows;
}

// ── per-day write ────────────────────────────────────────────────────────────

export interface WriteDayOutcome {
  dayRow: DayRow;
  varianceSamples: VarianceSample[];
  unknownLabelRows: UnknownLabelRow[];
  warnings: string[];
  incomeSatangWritten: number;
  /** Every direct income-category cell actually written this day (never a
   *  key that failed to resolve to a category), for the grand-total
   *  reconciliation's per-day breakdown display. */
  categoryBreakdown: Partial<Record<CategoryKey, number>>;
  /** Total landed in other_income_items this day (itemized rows + folded
   *  unknown labels) — also for the grand-total breakdown. */
  otherIncomeSatang: number;
  /** The summary sheet's own printed รวม, or null when this day has no typed
   *  summary to compare against (a reconstructed day) — see checkGrandTotals. */
  printedTotalSatang: number | null;
  /** Income cells left alone because a human owns them — see human-edits.ts. */
  humanCellSkips: HumanCellSkipRow[];
  /** At most one row: the day-level write skipped because a human owns the
   *  day's sheet_days row. */
  humanDaySkips: HumanDaySkipRow[];
}

function checkBookingRowBounds(row: BookingRow, sheetName: string, property: PropertyCode, date: string): string[] {
  const warnings: string[] = [];
  const fields = fieldsExceedingLength([
    { field: "bookingNo", value: row.bookingNo ?? "", maxLen: BOUND.BOOKING_NO_MAX_LEN },
    { field: "guestName", value: row.guestName, maxLen: BOUND.GUEST_NAME_MAX_LEN },
    { field: "roomRaw", value: row.roomRaw, maxLen: BOUND.ROOM_NO_MAX_LEN },
  ]);
  for (const f of fields) {
    warnings.push(
      `${property} ${date} (sheet ${sheetName}): ${f.field} is ${f.value.length} chars, exceeds the app's ${f.maxLen}-char bound — imported verbatim, never truncated.`,
    );
  }
  if ((row.roomCount ?? 0) > BOUND.COUNT_MAX || (row.nights ?? 0) > BOUND.COUNT_MAX) {
    warnings.push(`${property} ${date} (sheet ${sheetName}): roomCount/nights exceeds ${BOUND.COUNT_MAX} — imported verbatim.`);
  }
  return warnings;
}

export function writeDay(dbModule: typeof DbModule, plan: DayImportPlan, apply: boolean): WriteDayOutcome {
  const { db } = dbModule;
  const categories = dbModule.listCategories(plan.property, false);
  const categoryIdByKey = new Map<CategoryKey, number>();
  for (const c of categories) if (c.categoryKey) categoryIdByKey.set(c.categoryKey, c.id);

  const warnings: string[] = [];
  const unknownLabelRows: UnknownLabelRow[] = [];
  const varianceSamples: VarianceSample[] = [];
  const categoryBreakdown: Partial<Record<CategoryKey, number>> = {};
  const humanCellSkips: HumanCellSkipRow[] = [];
  const humanDaySkips: HumanDaySkipRow[] = [];
  let incomeCategoriesWritten = 0;
  let otherIncomeItemsWritten = 0;
  let otherIncomeSatang = 0;
  let cashBlockOverrideWritten = false;
  let bookingLineCount = 0;
  let incomeSatangWritten = 0;
  // Fix: the report must never claim a provenance the database doesn't
  // hold (see human-edits.ts) — defaults to the planned value and is
  // corrected to the actually-stored one below when the day-level guard
  // skips the provenance stamp.
  let storedProvenance: DayProvenance = plan.provenance;

  runDayTransaction(db, apply, () => {
    // 0. Ownership snapshot, taken before this day is touched: the human-edit
    // guard (human-edits.ts) may only ever let the importer overwrite what
    // the importer itself wrote. Read once per day, never re-read mid-write,
    // so the decision cannot be influenced by this run's own writes.
    const existingIncome = dbModule.getIncomeForDay(plan.property, plan.date);
    const existingSheetDay = dbModule.getSheetDay(plan.property, plan.date);
    const dayLevelWritable = importerMayWriteDayLevel(existingSheetDay);
    const dayLevelSkippedFields: string[] = [];

    /** Writes one income cell unless a human owns it. A skipped cell still
     *  counts its stored (human) amount toward the day's total, because that
     *  IS what the ledger holds for the day — the grand-total reconciliation
     *  would otherwise compare the paper against a number nothing has. */
    function writeIncomeCell(key: CategoryKey, categoryId: number, amountSatang: number): void {
      const existing = existingIncome[categoryId];
      if (!importerMayWriteIncomeCell(existing)) {
        const owned = existing!;
        humanCellSkips.push({
          property: plan.property,
          date: plan.date,
          categoryId,
          categoryKey: key,
          workbookSatang: amountSatang,
          existingSatang: owned.amountSatang,
          existingSource: owned.source,
          existingUpdatedBy: owned.updatedBy,
        });
        incomeSatangWritten += owned.amountSatang;
        categoryBreakdown[key] = owned.amountSatang;
        return;
      }
      dbModule.saveIncomeCell(plan.property, plan.date, categoryId, amountSatang, null, IMPORT_ACTOR, "import", true);
      incomeCategoriesWritten++;
      incomeSatangWritten += amountSatang;
      categoryBreakdown[key] = amountSatang;
    }

    // 1. Income vector: typed summary wins; a reconstructed day derives from
    // its booking rows instead (see plan.ts buildDayPlans). A reconstructed
    // day ALSO reads its per-booking sheet's own recap block for the four
    // categories no booking row can ever produce — bar_cash, bar_transfer,
    // other_cash, other_transfer (deriveNonBookingIncomeFromRecap) — that
    // recap is the only record of this money anywhere on a day with no
    // typed summary, unlike the seven booking-derivable tenders this
    // importer otherwise never trusts a recap block for (see plan.ts).
    let incomeByKey: Partial<Record<CategoryKey, number>>;
    let recapNonBookingIncome: ReturnType<typeof deriveNonBookingIncomeFromRecap> | null = null;
    if (plan.provenance === "reconstructed") {
      const rows = plan.reportSheet?.bookingRows ?? [];
      const lines = rows.map((row, i) => toDerivationBookingLine(row, plan.property, plan.date, i + 1));
      const derivedFromBookings = deriveIncomeFromBookings(lines);
      recapNonBookingIncome = plan.reportSheet
        ? deriveNonBookingIncomeFromRecap(plan.reportSheet.ownSummaryBlock.lines)
        : { categories: {}, otherIncomeItems: [] };
      incomeByKey = { ...derivedFromBookings, ...recapNonBookingIncome.categories };
    } else if (plan.summary) {
      incomeByKey = {};
      for (const [summaryKey, amount] of Object.entries(plan.summary.categories)) {
        const appKey = SUMMARY_CATEGORY_TO_APP_KEY[summaryKey as SummaryCategoryKey];
        if (appKey && amount !== undefined) incomeByKey[appKey] = amount;
      }
    } else {
      incomeByKey = {};
    }

    for (const [key, amountSatang] of Object.entries(incomeByKey) as Array<[CategoryKey, number]>) {
      const categoryId = categoryIdByKey.get(key);
      if (categoryId === undefined) {
        warnings.push(`no active category for key=${key} property=${plan.property} date=${plan.date} — cell skipped`);
        continue;
      }
      writeIncomeCell(key, categoryId, amountSatang);
      if (recapNonBookingIncome && key in recapNonBookingIncome.categories) {
        // Auditable-not-silent: this category has no booking row to derive
        // from, so this figure came only from the sheet's own recap block.
        warnings.push(
          `${plan.property} ${plan.date} (reconstructed day, sheet ${plan.reportSheet?.sheetName ?? "?"}): ` +
            `${key} = ${amountSatang} satang read from the per-booking sheet's own recap block (no booking row can ` +
            "ever produce this category) — written.",
        );
      }
    }

    // 2. Variance: only meaningful when both a typed summary AND booking
    // rows exist for the day (transcribed days) — compare the same 7
    // CategoryKeys a booking line can ever derive.
    if (plan.provenance === "transcribed" && plan.reportSheet) {
      const rows = plan.reportSheet.bookingRows;
      const lines = rows.map((row, i) => toDerivationBookingLine(row, plan.property, plan.date, i + 1));
      const derived = deriveIncomeFromBookings(lines);
      for (const key of VARIANCE_CATEGORY_KEYS) {
        const typedSatang = incomeByKey[key] ?? 0;
        const derivedSatang = derived[key] ?? 0;
        if (typedSatang === 0 && derivedSatang === 0) continue;
        varianceSamples.push({ property: plan.property, categoryKey: key, date: plan.date, typedSatang, derivedSatang });
      }
    }

    // 3. Itemized other-income + unknown-label folding. Typed-summary days:
    // unchanged below. Reconstructed days: the recap block's own itemized
    // รายการอื่นๆ rows (recapNonBookingIncome, computed in step 1 above) are
    // the day's only other-income source — a per-booking sheet carries no
    // unknownLabels or cashBlock concept at all, only a typed summary does,
    // so those two sub-steps and the cash-block override stay summary-only.
    deletePriorImportRows(db, "other_income_items", plan.property, plan.date);

    if (plan.summary) {
      const summary = plan.summary;

      for (const item of summary.otherIncomeItems) {
        // other_income_items.amount_satang has a CHECK (> 0) — matches the
        // app's own "zero/empty lines simply aren't created" convention
        // (src/shared/api.md endpoint 17). A parsed description with a
        // blank/zero amount is not a real entry; skip it but say so.
        if (item.amountSatang <= 0) {
          warnings.push(
            `${plan.property} ${plan.date} (sheet ${summary.sheetName}): other-income item "${item.text}" has amount ${item.amountSatang} satang (not > 0) — skipped, not written.`,
          );
          continue;
        }
        const isCash = item.isCash ?? true;
        if (item.text.length > BOUND.DESCRIPTION_MAX_LEN) {
          warnings.push(
            `${plan.property} ${plan.date} (sheet ${summary.sheetName}): other-income description exceeds ${BOUND.DESCRIPTION_MAX_LEN} chars — imported verbatim.`,
          );
        }
        if (item.text === "") {
          // Verified real case (sheet "31-8-2568"): a continuation row can
          // carry a genuine non-zero amount with no text anywhere — the
          // parse layer keeps it (never invents a description), so the
          // description here is genuinely absent, not merely empty.
          warnings.push(
            `${plan.property} ${plan.date} (sheet ${summary.sheetName}): other-income item of ${item.amountSatang} satang has no description anywhere on its row — imported with a null description.`,
          );
        }
        dbModule.createOtherIncomeItem(plan.property, plan.date, item.text || null, item.amountSatang, isCash, IMPORT_ACTOR);
        otherIncomeItemsWritten++;
        incomeSatangWritten += item.amountSatang;
        otherIncomeSatang += item.amountSatang;
      }

      // A day with a typed อื่นๆ total but no itemized rows behind it is not
      // a gap to leave unwritten — the summary's own **หมายเหตุ block gives
      // the cash portion (otherItemsCash / รายการอื่นๆเงินสด), and
      // total-minus-cash is deterministically the transfer/credit portion.
      // This is exactly the split the two-category model exists for, and
      // exactly how a "no items => cells directly editable" historical day
      // is meant to import (src/shared/api.md "รายการอื่นๆ — RESOLVED" point
      // 3). Measured across the Ville summary book alone: the อื่นๆ line
      // differs from its cash portion on 57 of 410 sheets, so both cells
      // genuinely get used — this is the norm, not a rare edge case.
      if (summary.otherIncomeItems.length === 0 && summary.categories.otherItems) {
        const totalOtherSatang = summary.categories.otherItems;
        const cashPortionSatang = summary.cashBlock.otherItemsCash;
        const splittable = cashPortionSatang !== undefined && cashPortionSatang >= 0 && cashPortionSatang <= totalOtherSatang;

        if (splittable) {
          const transferPortionSatang = totalOtherSatang - cashPortionSatang;
          const otherCashCategoryId = categoryIdByKey.get("other_cash");
          const otherTransferCategoryId = categoryIdByKey.get("other_transfer");

          if (otherCashCategoryId !== undefined) {
            writeIncomeCell("other_cash", otherCashCategoryId, cashPortionSatang);
          } else {
            warnings.push(`no active other_cash category for property=${plan.property} date=${plan.date} — cell skipped`);
          }
          if (otherTransferCategoryId !== undefined) {
            writeIncomeCell("other_transfer", otherTransferCategoryId, transferPortionSatang);
          } else {
            warnings.push(`no active other_transfer category for property=${plan.property} date=${plan.date} — cell skipped`);
          }

          warnings.push(
            `${plan.property} ${plan.date} (sheet ${summary.sheetName}): un-itemized other-income total ${totalOtherSatang} satang had no itemized rows — split deterministically via the cash-block into ${cashPortionSatang} cash / ${transferPortionSatang} transfer, written directly to other_cash/other_transfer (no items exist for this day, so the cells stay directly editable per the app's own contract).`,
          );
        } else {
          warnings.push(
            `${plan.property} ${plan.date} (sheet ${summary.sheetName}): un-itemized other-income total ${totalOtherSatang} satang has no itemized rows and no usable cash-block figure to split by (otherItemsCash=${cashPortionSatang ?? "absent"}) — left unwritten, needs manual review.`,
          );
        }
      }

      const hasRecognizedOtherItems = summary.categories.otherItems !== undefined;
      for (const unknown of summary.unknownLabels) {
        // A cash-block label (below **หมายเหตุ) is NEVER eligible to fold —
        // verified against real sheets via the grand-total check: it is
        // always a restatement of an amount already counted in the main
        // block (the office annotating "how much of the total was cash"),
        // and folding it on top of its main-block counterpart double-counts
        // real money by exactly that amount, every time (see types.ts
        // UnknownLabelEntry.section and parse-summary.ts). A main-block
        // label folds only when this sheet has no recognized อื่นๆ line at
        // all AND the amount is actually positive (same > 0 CHECK as above —
        // the parse layer only guarantees non-zero, not positive).
        const eligibleToFold = unknown.section === "main" && !hasRecognizedOtherItems;
        const folded = eligibleToFold && unknown.amountSatang > 0;
        if (folded) {
          const isCash = inferIsCashFromFreeText(unknown.label) ?? true;
          dbModule.createOtherIncomeItem(plan.property, plan.date, unknown.label, unknown.amountSatang, isCash, IMPORT_ACTOR);
          otherIncomeItemsWritten++;
          incomeSatangWritten += unknown.amountSatang;
          otherIncomeSatang += unknown.amountSatang;
        }
        unknownLabelRows.push({
          property: plan.property,
          date: plan.date,
          sheetName: summary.sheetName,
          label: unknown.label,
          amountSatang: unknown.amountSatang,
          folded,
          reason: folded
            ? "no recognized อื่นๆ line on this sheet — folded as itemized other-income"
            : unknown.section === "cashBlock"
              ? "cash-block annotation (below **หมายเหตุ) — restates money already counted above, never folded"
              : eligibleToFold
                ? `eligible to fold but amount ${unknown.amountSatang} satang is not > 0 — left unwritten, needs manual review`
                : "sheet already has a recognized อื่นๆ line — left unfolded for manual review",
        });
      }

      // 4. Cash-block override — the office's own typed control figures.
      // setCashBlockOverride REPLACES all four fields in one shot, so a
      // human-owned day must skip it wholesale (human-edits.ts): partially
      // merging the workbook into a manager's own cash block would invent a
      // combination neither source ever stated.
      if (Object.keys(summary.cashBlock).length > 0) {
        if (dayLevelWritable) {
          const patch: Partial<CashBlockAmounts> = {};
          for (const [cashKey, amount] of Object.entries(summary.cashBlock)) {
            if (amount === undefined) continue;
            patch[CASH_BLOCK_KEY_TO_APP_FIELD[cashKey as CashBlockKey]] = amount;
          }
          dbModule.setCashBlockOverride(plan.property, plan.date, patch, IMPORT_ACTOR);
          cashBlockOverrideWritten = true;
        } else {
          dayLevelSkippedFields.push("cash-block override");
        }
      }
    } else if (recapNonBookingIncome) {
      // Reconstructed day: itemize the recap block's own รายการอื่นๆ rows —
      // same shape and the same non-positive-amount skip as a typed
      // summary's own otherIncomeItems above, just sourced from the
      // per-booking sheet's recap instead of a day-summary sheet.
      for (const item of recapNonBookingIncome.otherIncomeItems) {
        if (item.amountSatang <= 0) {
          warnings.push(
            `${plan.property} ${plan.date} (reconstructed day, sheet ${plan.reportSheet?.sheetName ?? "?"}): ` +
              `other-income item "${item.text}" from the recap block has amount ${item.amountSatang} satang (not > 0) — skipped, not written.`,
          );
          continue;
        }
        const isCash = item.isCash ?? true;
        dbModule.createOtherIncomeItem(plan.property, plan.date, item.text || null, item.amountSatang, isCash, IMPORT_ACTOR);
        otherIncomeItemsWritten++;
        incomeSatangWritten += item.amountSatang;
        otherIncomeSatang += item.amountSatang;
        warnings.push(
          `${plan.property} ${plan.date} (reconstructed day, sheet ${plan.reportSheet?.sheetName ?? "?"}): ` +
            `other-income item "${item.text}" = ${item.amountSatang} satang read from the per-booking sheet's own ` +
            "recap block (never derivable from booking rows) — imported.",
        );
      }
    }

    // 5. Booking lines — idempotent replace, dense 1-based seq matching
    // print order (the parsed array's own order, not the sheet's own
    // often-missing seq column — see parse-report.ts module notes).
    if (plan.reportSheet) {
      const reportSheet = plan.reportSheet;
      deletePriorImportRows(db, "booking_lines", plan.property, plan.date);
      reportSheet.bookingRows.forEach((row, index) => {
        warnings.push(...checkBookingRowBounds(row, reportSheet.sheetName, plan.property, plan.date));
        dbModule.createBookingLine(
          plan.property,
          plan.date,
          {
            seq: index + 1,
            bookingNo: row.bookingNo,
            guestName: row.guestName || null,
            roomNo: row.roomRaw || null,
            roomCount: row.roomCount,
            nights: row.nights,
            grossRoomSatang: row.grossRoomSatang,
            grossOtherSatang: row.grossOtherSatang,
            discountSatang: row.discountSatang,
            tenders: toAppTenders(row.tenders),
            remark: row.remark,
            source: "import",
            draft: false,
            pmsRef: null,
            sourceSheet: reportSheet.sheetName,
          },
          IMPORT_ACTOR,
        );
        bookingLineCount++;
      });
    }

    // 6. Provenance stamp — same sheet_days row, same guard. Skipping it on a
    // human-owned day is what keeps the guard STABLE across runs: stamping
    // updated_by = import:excel here would erase the evidence that a person
    // owns this day, and the next run would clobber their cash block and note.
    if (dayLevelWritable) {
      upsertSheetDayProvenance(db, plan.property, plan.date, plan.provenance, IMPORT_ACTOR);
    } else {
      dayLevelSkippedFields.push(`provenance stamp (${plan.provenance})`);
      // Fix: the run report must state what the database actually holds, not
      // what this run wanted to stamp — a human owns this day's sheet_days
      // row, so its provenance stays whatever was already there (existing
      // non-null per importerMayWriteDayLevel's own contract).
      storedProvenance = existingSheetDay!.provenance;
    }

    if (!dayLevelWritable && existingSheetDay) {
      // The note and the verification stamp are covered by the same skip: no
      // write in this function touches them, and none may start to.
      humanDaySkips.push({
        property: plan.property,
        date: plan.date,
        existingUpdatedBy: existingSheetDay.updatedBy,
        skippedFields: dayLevelSkippedFields,
      });
    }
  });

  const dayRow: DayRow = {
    property: plan.property,
    date: plan.date,
    provenance: plan.provenance,
    sourceSummarySheet: plan.summary?.sheetName ?? null,
    sourceBookingWorkbook: plan.reportWorkbookLabel,
    sourceBookingSheet: plan.reportSheet?.sheetName ?? null,
    bookingLineCount,
    incomeCategoriesWritten,
    otherIncomeItemsWritten,
    cashBlockOverrideWritten,
    contradictsSourceMap: plan.contradictsSourceMap,
    storedProvenance,
  };

  return {
    dayRow,
    varianceSamples,
    unknownLabelRows,
    warnings,
    incomeSatangWritten,
    categoryBreakdown,
    otherIncomeSatang,
    printedTotalSatang: plan.summary?.printedTotalSatang ?? null,
    humanCellSkips,
    humanDaySkips,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));

  // db.ts reads DB_PATH at module-import time (opens the database and runs
  // migrate() immediately) — must be set before this dynamic import.
  process.env.DB_PATH = opts.dbPath;
  const dbModule: typeof DbModule = await import("../../src/server/db.ts");

  console.log(`[import-xls] mode=${opts.apply ? "APPLY" : "dry-run"} db=${opts.dbPath}`);
  console.log("[import-xls] parsing all four workbooks (always full — the Ville per-booking workbook holds HF sheets too)...");

  const hfSummary = parseSummaryWorkbook(HF_SUMMARY_PATH, "hf");
  const villeSummary = parseSummaryWorkbook(VILLE_SUMMARY_PATH, "hfville");
  const hfReport = parseReportWorkbook(HF_REPORT_PATH);
  const villeReport = parseReportWorkbook(VILLE_REPORT_PATH);

  const totalSheetsAcrossWorkbooks =
    hfSummary.sheetsParsed + villeSummary.sheetsParsed + hfReport.sheetsParsed + villeReport.sheetsParsed;

  // The owner-approved resolutions for the sheets the first run quarantined
  // (resolutions.ts). Applied here, between parsing and grouping, so a listed
  // sheet reaches the grouping stage already carrying its approved property
  // and date — and therefore never hits the collision or the date vote that
  // quarantined it. An ignored sheet is dropped before grouping, which is
  // what dissolves a duplicate pair. Anything unlisted is untouched.
  const hfSummaryResolved = applyResolutionsToSummaryDays("hf-summary", hfSummary.days);
  const villeSummaryResolved = applyResolutionsToSummaryDays("ville-summary", villeSummary.days);
  const hfReportResolved = applyResolutionsToReportSheets("hf-booking", hfReport.days);
  const villeReportResolved = applyResolutionsToReportSheets("ville-booking", villeReport.days);

  const unmatchedResolutions: SheetResolution[] = [
    ...hfSummaryResolved.unmatched,
    ...villeSummaryResolved.unmatched,
    ...hfReportResolved.unmatched,
    ...villeReportResolved.unmatched,
  ];
  assertEveryResolutionMatched(unmatchedResolutions);

  const appliedResolutions: AppliedResolutionRow[] = [
    ...hfSummaryResolved.applied,
    ...villeSummaryResolved.applied,
    ...hfReportResolved.applied,
    ...villeReportResolved.applied,
  ];
  console.log(
    `[import-xls] resolutions applied: ${appliedResolutions.filter((r) => r.action === "accept").length} accepted, ` +
      `${appliedResolutions.filter((r) => r.action === "ignore").length} ignored.`,
  );

  // A resolution may move a summary sheet ACROSS workbooks: the HF summary
  // book holds the first HF Ville day. Group by each record's own resolved
  // property, never by which file it came from — the same rule the
  // per-booking layer has always used. (The workbook labels below stay
  // property-shaped because only accepted sheets can move, and an accepted
  // sheet can no longer be quarantined.)
  const allSummaryDays = [...hfSummaryResolved.records, ...villeSummaryResolved.records];
  const hfSummaryGroups = groupSummaryDaysByDate(allSummaryDays.filter((d) => d.property === "hf"));
  const villeSummaryGroups = groupSummaryDaysByDate(allSummaryDays.filter((d) => d.property === "hfville"));

  const labeledReportSheets: LabeledReportSheet[] = [
    ...hfReportResolved.records.map((record) => ({ workbookLabel: "HF per-booking", record })),
    ...villeReportResolved.records.map((record) => ({ workbookLabel: "Ville per-booking", record })),
  ];
  const reportGroups = groupReportSheetsByPropertyDate(labeledReportSheets);

  const quarantine: QuarantineRow[] = [
    ...summaryQuarantineRows("HF summary", "hf", hfSummaryGroups),
    ...summaryQuarantineRows("Ville summary", "hfville", villeSummaryGroups),
    ...reportQuarantineRows(reportGroups),
  ];

  const reportByPropertyDate = new Map<string, LabeledReportSheet>();
  for (const [key, sheets] of reportGroups.byPropertyDate) {
    if (sheets.length === 1) reportByPropertyDate.set(key, sheets[0]!);
  }

  const { dayPlans, skippedCopies } = buildDayPlans({
    hfSummaryByDate: singleSheetByDate(hfSummaryGroups.byDate),
    villeSummaryByDate: singleSheetByDate(villeSummaryGroups.byDate),
    reportByPropertyDate,
    resolvedVilleSummaryDates: acceptedSummaryDates("hfville"),
  });

  const selectedDayPlans = dayPlans.filter(
    (p) =>
      (opts.onlyProperty === null || p.property === opts.onlyProperty) &&
      (opts.onlyDate === null || p.date === opts.onlyDate),
  );
  const selectedQuarantine = quarantine.filter(
    (q) => opts.onlyProperty === null || q.property === null || q.property === opts.onlyProperty,
  );
  const selectedSkippedCopies = opts.onlyProperty === "hf" ? [] : skippedCopies;

  console.log(`[import-xls] ${selectedDayPlans.length} day(s) selected for writing (of ${dayPlans.length} planned).`);

  const days: DayRow[] = [];
  const varianceSamples: VarianceSample[] = [];
  const grandTotalSamples: GrandTotalCheckSample[] = [];
  const unknownLabelRows: UnknownLabelRow[] = [];
  const warnings: string[] = [];
  const monthlyByKey = new Map<string, MonthlyTotal>();
  const tenderRowsByProperty = new Map<PropertyCode, BookingRow[]>();
  const humanCellSkips: HumanCellSkipRow[] = [];
  const humanDaySkips: HumanDaySkipRow[] = [];

  for (const plan of selectedDayPlans) {
    const outcome = writeDay(dbModule, plan, opts.apply);
    days.push(outcome.dayRow);
    varianceSamples.push(...outcome.varianceSamples);
    unknownLabelRows.push(...outcome.unknownLabelRows);
    warnings.push(...outcome.warnings);
    humanCellSkips.push(...outcome.humanCellSkips);
    humanDaySkips.push(...outcome.humanDaySkips);

    if (outcome.printedTotalSatang !== null) {
      grandTotalSamples.push({
        property: plan.property,
        date: plan.date,
        sheetName: plan.summary?.sheetName ?? "",
        importedTotalSatang: outcome.incomeSatangWritten,
        printedTotalSatang: outcome.printedTotalSatang,
        categoryBreakdown: outcome.categoryBreakdown,
        otherIncomeSatang: outcome.otherIncomeSatang,
      });
    }

    const monthKey = `${plan.property} ${monthOf(plan.date)}`;
    const existing = monthlyByKey.get(monthKey);
    if (existing) {
      existing.incomeSatang += outcome.incomeSatangWritten;
      existing.dayCount += 1;
    } else {
      monthlyByKey.set(monthKey, {
        property: plan.property,
        month: monthOf(plan.date),
        incomeSatang: outcome.incomeSatangWritten,
        dayCount: 1,
      });
    }

    if (plan.reportSheet) {
      const arr = tenderRowsByProperty.get(plan.property) ?? [];
      arr.push(...plan.reportSheet.bookingRows);
      tenderRowsByProperty.set(plan.property, arr);
    }
  }

  const tenderCounts: TenderRowCounts[] = [...tenderRowsByProperty.entries()].map(([property, rows]) => ({
    property,
    totalRows: rows.length,
    multiTenderRows: rows.filter((r) => tenderColumnCount(toAppTenders(r.tenders)) >= 2).length,
    zeroTenderRows: rows.filter((r) => tenderColumnCount(toAppTenders(r.tenders)) === 0).length,
  }));

  const variance = aggregateVariance(varianceSamples, RECONCILE_TOLERANCE_SATANG);
  const grandTotalCheck = checkGrandTotals(grandTotalSamples, RECONCILE_TOLERANCE_SATANG, 20);

  if (warnings.some((w) => w.includes("roomRaw is"))) {
    warnings.push(
      "roomRaw overflow rows, verified against src/server/server.ts and src/client/pages/BookingDayPage.tsx: the server's " +
        "PATCH /bookings/:id validates ROOM_NO_MAX_LEN (40) only when roomNo is present in that request's body, so editing " +
        "an unrelated field (guestName, tenders, remark, ...) on one of these rows is NOT blocked. The client's own roomNo " +
        "input, however, clamps to 40 chars on blur (`value.slice(0, maxLen)`) and resubmits whenever the field differs from " +
        "the stored value — so the moment anyone focuses and blurs that field in the UI (even without intending a change), " +
        "the overlong roomNo is SILENTLY TRUNCATED to 40 characters, not rejected. An explicit attempt to save a still-too-long " +
        "roomNo (e.g. a direct API call) is rejected by the server's own bound check. Net effect: these rows are safe to view " +
        "and edit everywhere except that one field, which truncates on touch rather than erroring — worth knowing before a " +
        "manager tabs through a booking row expecting no-op behavior.",
    );
  }

  const summary: ImportRunSummary = {
    generatedAt: new Date().toISOString(),
    apply: opts.apply,
    dbPath: opts.dbPath,
    onlyDate: opts.onlyDate,
    onlyProperty: opts.onlyProperty,
    totalSheetsAcrossWorkbooks,
    days,
    quarantine: selectedQuarantine,
    skippedCopies: selectedSkippedCopies,
    variance,
    grandTotalCheck,
    unknownLabels: unknownLabelRows,
    tenderCounts,
    monthlyTotals: [...monthlyByKey.values()],
    warnings,
    resolutions: appliedResolutions,
    humanCellSkips,
    humanDaySkips,
    idempotencyNote:
      "Replace, keyed on (property, date): booking_lines and other_income_items rows this importer previously created " +
      `(created_by = '${IMPORT_ACTOR}') are deleted before re-inserting for that day, so a second run reflects the ` +
      "source workbooks exactly rather than accumulating duplicates. income_amounts is a natural upsert on " +
      "(property, date, category_id) via saveIncomeCell, so it never duplicates either. A human's manually entered " +
      "rows (any other created_by) for the same day are never touched, and — since the human-edit guard landed — " +
      "neither is an income cell, day note, cash-block field or verification stamp a human owns: the importer only " +
      "overwrites what the importer itself wrote (see human-edits.ts and the Human-edit guard section above). " +
      "Known side effect, verified empirically by " +
      "running --apply twice against a scratch copy: income_amounts/booking_lines/other_income_items/sheet_days row " +
      "counts were identical after the second run, but income_amount_history grew by one row per re-written cell " +
      "(saveIncomeCell always appends a history row, even when old===new) — this is an accurate audit trail of " +
      "'the importer touched this cell again', not duplicated income data, and matches saveIncomeCell's existing " +
      "behavior everywhere else in the app.",
  };

  const written = writeReportFiles(opts.outDir, summary);
  console.log(`[import-xls] report written: ${written.markdownPath}`);
  console.log(
    `[import-xls] days written: ${days.length}, quarantined: ${selectedQuarantine.length}, skipped-as-copy: ${selectedSkippedCopies.length}`,
  );
  console.log(
    `[import-xls] human-edit guard: ${humanCellSkips.length} income cell(s) and ${humanDaySkips.length} day-level ` +
      "write(s) left alone because a human owns them.",
  );
  if (!opts.apply) {
    console.log("[import-xls] dry-run: every transaction was rolled back — the database is unchanged.");
  }
}

// Only when executed as a script: writeDay is exported above so the
// human-edit guard can be tested against a real database without main()
// parsing four workbooks on import.
if (import.meta.main) {
  main().catch((err) => {
    console.error("[import-xls] failed:", err);
    process.exitCode = 1;
  });
}
