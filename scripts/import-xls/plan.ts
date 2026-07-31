// Pure planning logic for the Excel importer: date/property grouping, the
// source-map decision tree, the copy-assumption check, and category/tender
// mapping tables. Deliberately free of disk I/O and database access so every
// rule from the source map can be unit tested without a workbook or a DB.
//
// See import.ts for how these functions are wired into the actual write
// path, and src/shared/api.md for the app-side contract these map onto.

import type {
  CashBlockKey,
  DateResolution,
  OwnSummaryLine,
  PlainDate,
  PropertyCode,
  ReportSheetRecord,
  SummaryCategoryKey,
  SummaryDayRecord,
} from "./types.ts";
import type { BookingRow, BookingTenders } from "./types.ts";
import { inferIsCashFromFreeText, resolveCategoryLabel, stripWhitespace } from "./normalize.ts";
import type { BookingLine, CashBlockAmounts, CategoryKey, DayProvenance, Tender } from "../../src/shared/types.ts";
import { TENDER_TO_CATEGORY_KEY } from "../../src/shared/types.ts";

// ── date formatting ────────────────────────────────────────────────────────

export function plainDateToIso(d: PlainDate): string {
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Human-readable candidate summary for a date-resolution failure, used in
 *  the quarantine report — the two (or more) disagreeing candidates, plus
 *  anything discarded as implausible before voting. */
export function describeDateResolution(res: DateResolution): string {
  const candidates = res.sources
    .filter((s) => s.date !== null)
    .map((s) => `${s.source}=${plainDateToIso(s.date!)}`)
    .join(", ");
  const discarded =
    res.discarded.length > 0
      ? ` [discarded: ${res.discarded.map((c) => `${c.source}=${plainDateToIso(c.date)}`).join(", ")}]`
      : "";
  return `${candidates || "(no candidate survives)"}${discarded}`;
}

// ── the Ville copy window ───────────────────────────────────────────────────

/** Ville-summary sheets dated before this are stale copies of the HF
 *  workbook (measured: identical values 2025-04-01..2025-12-11) — see
 *  CLAUDE.md-equivalent task brief "THE SOURCE MAP". ISO YYYY-MM-DD strings
 *  compare lexicographically the same as chronologically. */
export const VILLE_COPY_WINDOW_END_EXCLUSIVE = "2025-12-12";

export function isInVilleCopyWindow(isoDate: string): boolean {
  return isoDate < VILLE_COPY_WINDOW_END_EXCLUSIVE;
}

// ── provenance decision tree ────────────────────────────────────────────────

export type DayProvenancePlan = "transcribed" | "reconstructed" | "summary_only";

/**
 * The general form of rules 2-4 from the source map: a typed summary always
 * wins when present; with no summary but real booking rows, reconstruct;
 * with a summary but no booking rows, the day is summary-only. Returns null
 * only when neither source has anything for the day (caller should never
 * reach this — it would mean the day was invented from nothing).
 */
export function classifyDayProvenance(hasSummary: boolean, hasBookings: boolean): DayProvenancePlan | null {
  if (hasSummary && hasBookings) return "transcribed";
  if (hasSummary && !hasBookings) return "summary_only";
  if (!hasSummary && hasBookings) return "reconstructed";
  return null;
}

// ── copy-assumption verification ───────────────────────────────────────────

function sortedEntries(obj: Record<string, number | undefined>): string {
  return Object.keys(obj)
    .sort()
    .map((k) => `${k}=${obj[k]}`)
    .join(",");
}

export interface SummaryComparisonResult {
  identical: boolean;
  detail: string;
}

/** Compares a Ville summary day against its same-date HF counterpart on the
 *  fields that carry the day's money — see task rule 1 ("verify the
 *  assumption as you go"). Any difference is reported, never silently
 *  accepted. */
export function compareSummaryDays(ville: SummaryDayRecord, hf: SummaryDayRecord): SummaryComparisonResult {
  const diffs: string[] = [];

  const villeCategories = sortedEntries(ville.categories);
  const hfCategories = sortedEntries(hf.categories);
  if (villeCategories !== hfCategories) {
    diffs.push(`categories differ: ville=[${villeCategories}] hf=[${hfCategories}]`);
  }

  const villeCashBlock = sortedEntries(ville.cashBlock);
  const hfCashBlock = sortedEntries(hf.cashBlock);
  if (villeCashBlock !== hfCashBlock) {
    diffs.push(`cashBlock differs: ville=[${villeCashBlock}] hf=[${hfCashBlock}]`);
  }

  if (ville.printedTotalSatang !== hf.printedTotalSatang) {
    diffs.push(`printedTotal differs: ville=${ville.printedTotalSatang} hf=${hf.printedTotalSatang}`);
  }

  return { identical: diffs.length === 0, detail: diffs.length === 0 ? "identical" : diffs.join("; ") };
}

// ── grouping: summary sheets by resolved date ──────────────────────────────

export interface SummaryDateGroups {
  /** isoDate -> every sheet that resolved to that date. Length > 1 means a
   *  genuine (property, date) collision — quarantine, never merge. */
  byDate: Map<string, SummaryDayRecord[]>;
  unresolved: SummaryDayRecord[];
}

export function groupSummaryDaysByDate(days: SummaryDayRecord[]): SummaryDateGroups {
  const byDate = new Map<string, SummaryDayRecord[]>();
  const unresolved: SummaryDayRecord[] = [];
  for (const day of days) {
    if (day.dateResolution.unresolved || day.dateResolution.date === null) {
      unresolved.push(day);
      continue;
    }
    const iso = plainDateToIso(day.dateResolution.date);
    const arr = byDate.get(iso);
    if (arr) arr.push(day);
    else byDate.set(iso, [day]);
  }
  return { byDate, unresolved };
}

/** Keeps only the dates with exactly one resolved sheet — the safe subset to
 *  import. Duplicates are surfaced separately by the caller for quarantine. */
export function singleSheetByDate<T>(byDate: Map<string, T[]>): Map<string, T> {
  const out = new Map<string, T>();
  for (const [date, arr] of byDate) {
    if (arr.length === 1) out.set(date, arr[0]!);
  }
  return out;
}

// ── grouping: per-booking sheets by (property, resolved date) ──────────────

export interface LabeledReportSheet {
  /** Which physical workbook this sheet came from, for traceability in the
   *  report (e.g. "HF per-booking" vs "Ville per-booking") — a sheet's
   *  resolved property is independent of which file it lives in (the Ville
   *  per-booking workbook holds both properties' sheets). */
  workbookLabel: string;
  record: ReportSheetRecord;
}

export interface ReportDateGroups {
  byPropertyDate: Map<string, LabeledReportSheet[]>;
  unresolvedDate: LabeledReportSheet[];
  propertyQuarantined: LabeledReportSheet[];
}

export function reportGroupKey(property: PropertyCode, date: string): string {
  return `${property}\u0000${date}`;
}

export function splitReportGroupKey(key: string): [PropertyCode, string] {
  const [property, date] = key.split("\u0000") as [PropertyCode, string];
  return [property, date];
}

export function groupReportSheetsByPropertyDate(sheets: LabeledReportSheet[]): ReportDateGroups {
  const byPropertyDate = new Map<string, LabeledReportSheet[]>();
  const unresolvedDate: LabeledReportSheet[] = [];
  const propertyQuarantined: LabeledReportSheet[] = [];

  for (const labeled of sheets) {
    const { record } = labeled;
    if (record.dateResolution.unresolved || record.dateResolution.date === null) {
      unresolvedDate.push(labeled);
      continue;
    }
    if (record.property === null) {
      propertyQuarantined.push(labeled);
      continue;
    }
    const key = reportGroupKey(record.property, plainDateToIso(record.dateResolution.date));
    const arr = byPropertyDate.get(key);
    if (arr) arr.push(labeled);
    else byPropertyDate.set(key, [labeled]);
  }

  return { byPropertyDate, unresolvedDate, propertyQuarantined };
}

// ── category / tender mapping tables ───────────────────────────────────────

/**
 * Every SummaryCategoryKey the summary sheet writes maps onto a stable app
 * CategoryKey, EXCEPT `otherItems` — the paper's single mixed อื่นๆ column has
 * no direct category counterpart in the split-cash/transfer app model; it is
 * imported as itemized other_income_items instead (src/shared/api.md
 * "รายการอื่นๆ — RESOLVED").
 */
export const SUMMARY_CATEGORY_TO_APP_KEY: Partial<Record<SummaryCategoryKey, CategoryKey>> = {
  depositAdvance: "deposit",
  roomCash: "room_cash",
  creditKbank: "credit_kbank",
  creditIcbc: "credit_icbc",
  transferKbank: "transfer_kbank",
  transferIcbc: "transfer_icbc",
  website: "web",
  waterBarCash: "bar_cash",
  waterBarTransferCredit: "bar_transfer",
};

export const CASH_BLOCK_KEY_TO_APP_FIELD: Record<CashBlockKey, keyof CashBlockAmounts> = {
  hotelRevenueCash: "roomCashSatang",
  otherItemsCash: "otherCashSatang",
  waterBarCashBlock: "barCashSatang",
  bankedTotal: "bankedSatang",
};

/** The CategoryKeys that a booking line can derive an amount for — same set
 *  `deriveIncomeFromBookings` produces, reused here so the variance report
 *  never drifts from the app's own tender->category mapping. */
export const VARIANCE_CATEGORY_KEYS: readonly CategoryKey[] = Object.values(TENDER_TO_CATEGORY_KEY) as CategoryKey[];

export function toAppTenders(t: BookingTenders): Record<Tender, number> {
  return {
    deposit: t.depositSatang,
    // Wave C (docs/adr/0001): the accrual-era tender didn't exist when any
    // of this importer's historical Excel data was recorded — always 0.
    deposit_applied: 0,
    cash: t.cashSatang,
    credit_kbank: t.creditKbankSatang,
    credit_icbc: t.creditIcbcSatang,
    transfer_kbank: t.transferKbankSatang,
    transfer_icbc: t.transferIcbcSatang,
    web: t.appWebsiteSatang,
    other: t.otherSatang,
  };
}

/**
 * Adapts a parsed BookingRow into the app's BookingLine shape purely so it
 * can be fed to the shared `deriveIncomeFromBookings`/`computeBookingTotals`
 * functions (src/shared/bookings.ts) — never persisted itself, so the audit
 * fields are placeholders. Reused for both reconstructing a day's income
 * from bookings and computing the typed-vs-derived variance on days that
 * have both sources.
 */
export function toDerivationBookingLine(
  row: BookingRow,
  property: PropertyCode,
  date: string,
  seq: number,
): BookingLine {
  return {
    id: 0,
    property,
    date,
    seq,
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
    sourceSheet: null,
    createdAt: "",
    createdBy: "",
    updatedAt: "",
    updatedBy: "",
  };
}

// ── reconstructed-day non-booking income (bar water + itemized อื่นๆ) ──────

/** One itemized รายการอื่นๆ entry read from a per-booking sheet's own recap
 *  block — same shape as a typed summary's own OtherIncomeItem (free text +
 *  amount + best-effort cash/transfer inference), just sourced from a
 *  different document (see deriveNonBookingIncomeFromRecap below). */
export interface RecapOtherIncomeItem {
  text: string;
  amountSatang: number;
  isCash: boolean | undefined;
}

export interface RecapNonBookingIncome {
  /** bar_cash / bar_transfer only, and only when the recap block prints a
   *  positive amount — same "no positive evidence, no entry" convention as
   *  deriveIncomeFromBookings. Never other_cash/other_transfer: those are
   *  computed from `otherIncomeItems` below once at least one item exists,
   *  exactly like a typed summary's own itemized อื่นๆ (src/shared/api.md
   *  "รายการอื่นๆ — RESOLVED" point 3) — writing them directly here would
   *  fight that same computation. */
  categories: Partial<Record<CategoryKey, number>>;
  otherIncomeItems: RecapOtherIncomeItem[];
}

const OTHER_ITEMS_STRIPPED_PREFIX = stripWhitespace("รายการ อื่นๆ");
const BARE_TRANSFER_LABEL = "โอน";
const BARE_CREDIT_LABEL = "เครดิต";

function stripOtherItemsPrefix(label: string): string {
  return label.replace(/^\s*รายการ\s*อื่นๆ\s*/, "").trim();
}

/**
 * Reads the four categories a booking row can never produce — bar_cash,
 * bar_transfer, other_cash, other_transfer — from a per-booking
 * ("รายงานรายรับ") sheet's own "สรุปยอดรายรับ" recap block
 * (ReportSheetRecord.ownSummaryBlock). Used only for a RECONSTRUCTED day
 * (no typed summary at all) — see import.ts writeDay.
 *
 * WHY THIS IS SAFE DESPITE "NEVER TRUST A RECAP BLOCK": that rule (see
 * api.md, and this report's own variance section) protects the SEVEN
 * tenders a booking row CAN produce, because the recap disagrees with the
 * rows above it on a large fraction of sheets (the office hand-adjusts it).
 * Bar-water sales and itemized other-income have no booking row to disagree
 * WITH in the first place — on a day with no typed summary, this recap
 * block is the only record of that money anywhere, so reading it is not
 * trusting a redundant figure, it is the only way not to lose it.
 *
 * LAYOUT (verified against both real report workbooks, all 656 sheets that
 * carry one): the recap mirrors the typed summary sheet's own category
 * order — ส่วนลด, มัดจำล่วงหน้า, ค่าห้องเงินสด, บัตรเครดิตx2, โอนx2, one or
 * more web lines (Agoda/booking.com/Trip.com print as separate rows),
 * รายการอื่นๆ (+ up to a few itemized continuation rows — same shape as the
 * summary sheet's own continuation rows), บาร์น้ำ เงินสด, then its
 * transfer/credit split printed as two BARE lines "โอน"/"เครดิต" — never one
 * combined line like the summary sheet's "บาร์น้ำ โอน/เครดิต" — before the
 * block's own รวม (where parseOwnSummaryBlock already stops). Validated
 * empirically across every day carrying BOTH a typed summary and a
 * per-booking sheet (614 comparable days): the recap's own บาร์น้ำ เงินสด
 * line matches the typed summary's within 1 THB on 540/614, and โอน+เครดิต
 * matches the typed summary's บาร์น้ำ โอน/เครดิต on 584/614 — the remainder
 * are days where the recap block itself is genuinely blank for bar income
 * (verified: both lines read exactly zero), never a parsing disagreement,
 * which reading it verbatim faithfully reproduces.
 */
export function deriveNonBookingIncomeFromRecap(lines: readonly OwnSummaryLine[]): RecapNonBookingIncome {
  const categories: Partial<Record<CategoryKey, number>> = {};

  const barCashIdx = lines.findIndex((l) => resolveCategoryLabel(l.label) === "waterBarCash");
  if (barCashIdx !== -1) {
    const barCashSatang = lines[barCashIdx]!.amountSatang ?? 0;
    if (barCashSatang > 0) categories.bar_cash = barCashSatang;

    let barTransferSatang = 0;
    for (const line of lines.slice(barCashIdx + 1)) {
      const stripped = stripWhitespace(line.label);
      if (stripped === BARE_TRANSFER_LABEL || stripped === BARE_CREDIT_LABEL) {
        barTransferSatang += line.amountSatang ?? 0;
      }
    }
    if (barTransferSatang > 0) categories.bar_transfer = barTransferSatang;
  }

  const otherIncomeItems: RecapOtherIncomeItem[] = [];
  const otherItemsIdx = lines.findIndex(
    (l) =>
      resolveCategoryLabel(l.label) === "otherItems" || stripWhitespace(l.label).startsWith(OTHER_ITEMS_STRIPPED_PREFIX),
  );
  if (otherItemsIdx !== -1) {
    const endIdx = barCashIdx !== -1 ? barCashIdx : lines.length;
    for (let i = otherItemsIdx; i < endIdx; i++) {
      const line = lines[i]!;
      const isMarkerRow = i === otherItemsIdx;
      // A later row matching a KNOWN category label (verified real case: a
      // stray zero-valued bare "เว็บไซด์" template row between the อื่นๆ
      // continuation and บาร์น้ำ) is not a continuation item — stop, same
      // rule parse-summary.ts uses for its own continuation-row scan.
      if (!isMarkerRow && resolveCategoryLabel(line.label)) break;
      const text = isMarkerRow ? stripOtherItemsPrefix(line.label) : line.label;
      const amountSatang = line.amountSatang ?? 0;
      if (!text && amountSatang === 0) continue; // genuine blank spacer row
      otherIncomeItems.push({ text, amountSatang, isCash: inferIsCashFromFreeText(text) });
    }
  }

  return { categories, otherIncomeItems };
}

// ── variance aggregation ────────────────────────────────────────────────────

export interface VarianceSample {
  property: PropertyCode;
  categoryKey: CategoryKey;
  date: string;
  typedSatang: number;
  derivedSatang: number;
}

export interface VarianceOffender {
  date: string;
  typedSatang: number;
  derivedSatang: number;
  varianceSatang: number;
}

export interface CategoryVarianceStat {
  property: PropertyCode;
  categoryKey: CategoryKey;
  daysCompared: number;
  daysExceedingTolerance: number;
  totalTypedSatang: number;
  totalDerivedSatang: number;
  totalVarianceSatang: number;
  worstOffenders: VarianceOffender[];
}

/**
 * Groups per-day per-category variance samples into a report-ready stat per
 * (property, categoryKey), sorted by whichever category carries the biggest
 * absolute total variance first. `toleranceSatang` matches
 * RECONCILE_TOLERANCE_SATANG from src/shared/bookings.ts (1 THB) — a sample
 * within tolerance still counts toward the totals but never toward
 * `daysExceedingTolerance` or `worstOffenders`.
 */
export function aggregateVariance(
  samples: VarianceSample[],
  toleranceSatang: number,
  worstOffenderCount = 5,
): CategoryVarianceStat[] {
  const groups = new Map<string, VarianceSample[]>();
  for (const sample of samples) {
    const key = `${sample.property}\u0000${sample.categoryKey}`;
    const arr = groups.get(key);
    if (arr) arr.push(sample);
    else groups.set(key, [sample]);
  }

  const stats: CategoryVarianceStat[] = [];
  for (const [key, arr] of groups) {
    const [property, categoryKey] = key.split("\u0000") as [PropertyCode, CategoryKey];
    let totalTypedSatang = 0;
    let totalDerivedSatang = 0;
    let totalVarianceSatang = 0;
    let daysExceedingTolerance = 0;

    const offenders: VarianceOffender[] = arr.map((sample) => {
      const varianceSatang = sample.typedSatang - sample.derivedSatang;
      totalTypedSatang += sample.typedSatang;
      totalDerivedSatang += sample.derivedSatang;
      totalVarianceSatang += varianceSatang;
      if (Math.abs(varianceSatang) > toleranceSatang) daysExceedingTolerance++;
      return { date: sample.date, typedSatang: sample.typedSatang, derivedSatang: sample.derivedSatang, varianceSatang };
    });

    offenders.sort((a, b) => Math.abs(b.varianceSatang) - Math.abs(a.varianceSatang));

    stats.push({
      property,
      categoryKey,
      daysCompared: arr.length,
      daysExceedingTolerance,
      totalTypedSatang,
      totalDerivedSatang,
      totalVarianceSatang,
      worstOffenders: offenders.filter((o) => Math.abs(o.varianceSatang) > toleranceSatang).slice(0, worstOffenderCount),
    });
  }

  stats.sort((a, b) => Math.abs(b.totalVarianceSatang) - Math.abs(a.totalVarianceSatang));
  return stats;
}

// ── bounds checking (report-only; never truncates real data) ──────────────

export interface LengthBoundCheck {
  field: string;
  value: string;
  maxLen: number;
}

/** Flags fields that would fail the app's own API-layer bounds — informative
 *  only, since a direct DB write has no CHECK constraint on string length and
 *  this importer must never truncate or otherwise invent/correct real data. */
export function fieldsExceedingLength(fields: LengthBoundCheck[]): LengthBoundCheck[] {
  return fields.filter((f) => f.value.length > f.maxLen);
}

export function tenderColumnCount(tenders: Record<Tender, number>): number {
  return Object.values(tenders).filter((v) => v !== 0).length;
}

// ── consecutive-date run grouping (for compact report display) ────────────

export interface DateRun {
  start: string;
  end: string;
  count: number;
}

function nextCalendarDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${next.getUTCFullYear()}-${mm}-${dd}`;
}

/** Collapses a list of ISO dates into runs of consecutive calendar days, so
 *  e.g. 31 individual dates in a row render as one line instead of 31 —
 *  used for the source-map-contradiction section, where an expected
 *  month-long gap (before a summary workbook's own start date) should read
 *  as one run rather than drowning out genuine one-off gaps. */
export function groupConsecutiveDates(dates: string[]): DateRun[] {
  const sorted = [...new Set(dates)].sort();
  const runs: DateRun[] = [];
  for (const date of sorted) {
    const last = runs[runs.length - 1];
    if (last && nextCalendarDate(last.end) === date) {
      last.end = date;
      last.count += 1;
    } else {
      runs.push({ start: date, end: date, count: 1 });
    }
  }
  return runs;
}

// ── report row shapes (owned here; report.ts only renders them) ───────────

export interface SkippedCopyRow {
  date: string;
  villeSheetName: string;
  hasHfCounterpart: boolean;
  identicalToHf: boolean | null;
  diffDetail: string | null;
  reconstructedFromBookings: boolean;
}

export interface UnknownLabelRow {
  property: PropertyCode;
  date: string;
  sheetName: string;
  label: string;
  amountSatang: number;
  folded: boolean;
  reason: string;
}

export interface TenderRowCounts {
  property: PropertyCode;
  totalRows: number;
  multiTenderRows: number;
  zeroTenderRows: number;
}

export interface MonthlyTotal {
  property: PropertyCode;
  month: string;
  incomeSatang: number;
  dayCount: number;
}

export type QuarantineKind = "duplicate-date" | "unresolved-date" | "property-quarantine";

export interface QuarantineRow {
  property: PropertyCode | null;
  date: string | null;
  kind: QuarantineKind;
  workbookLabel: string;
  sheetNames: string[];
  detail: string;
}

export interface DayRow {
  property: PropertyCode;
  date: string;
  /** The source-map-classified SHAPE of this day's data (transcribed /
   *  reconstructed / summary_only) — this is what the importer WANTED to
   *  stamp, not necessarily what sheet_days.provenance actually holds after
   *  this run. See storedProvenance below; never conflate the two. */
  provenance: DayProvenancePlan;
  sourceSummarySheet: string | null;
  sourceBookingWorkbook: string | null;
  sourceBookingSheet: string | null;
  bookingLineCount: number;
  incomeCategoriesWritten: number;
  otherIncomeItemsWritten: number;
  cashBlockOverrideWritten: boolean;
  contradictsSourceMap: string | null;
  /** What sheet_days.provenance ACTUALLY holds for this day after this run.
   *  Equal to `provenance` unless a human owns the day's sheet_days row (see
   *  human-edits.ts importerMayWriteDayLevel) — the importer's provenance
   *  stamp is then skipped and the day keeps whatever was already stored
   *  (often "app", from the live app), rather than being upgraded. A report
   *  must never claim a provenance the database doesn't hold — see the
   *  human-edit guard section of the reconciliation report. */
  storedProvenance: DayProvenance;
}

// ── the day-level decision tree (rules 1-4 of the source map) ─────────────

export interface DayImportPlan {
  property: PropertyCode;
  date: string;
  provenance: DayProvenancePlan;
  /** The typed summary to write income/other-income/cash-block from, or null
   *  for a day reconstructed purely from booking rows. */
  summary: SummaryDayRecord | null;
  reportSheet: ReportSheetRecord | null;
  reportWorkbookLabel: string | null;
  /** Set when this day's shape wasn't predicted by the source map (e.g. a
   *  property/date with booking rows but no typed summary, outside the
   *  Ville copy window) — always reported, never silently absorbed. */
  contradictsSourceMap: string | null;
}

export interface BuildDayPlansInput {
  /** Deduplicated (single-sheet) HF summary days, keyed by ISO date. */
  hfSummaryByDate: Map<string, SummaryDayRecord>;
  /** Deduplicated (single-sheet) Ville summary days, keyed by ISO date —
   *  includes copy-window dates too; the copy-window rule is applied here,
   *  not by the caller pre-filtering. */
  villeSummaryByDate: Map<string, SummaryDayRecord>;
  /** Deduplicated (single-sheet) per-booking sheets, keyed by
   *  reportGroupKey(property, date). */
  reportByPropertyDate: Map<string, LabeledReportSheet>;
  /** ISO dates whose Ville summary sheet a human explicitly ruled on (see
   *  scripts/import-xls/resolutions.ts). The copy window is a heuristic
   *  about a whole date range; an owner-approved ruling about one specific
   *  sheet outranks it, so such a date is treated normally even when it
   *  falls inside the window. Empty by default — unlisted dates keep the
   *  copy-window behaviour exactly. */
  resolvedVilleSummaryDates?: ReadonlySet<string>;
}

export interface BuildDayPlansResult {
  dayPlans: DayImportPlan[];
  skippedCopies: SkippedCopyRow[];
}

function datesForProperty(reportByPropertyDate: Map<string, LabeledReportSheet>, property: PropertyCode): Set<string> {
  const dates = new Set<string>();
  for (const key of reportByPropertyDate.keys()) {
    const [keyProperty, date] = splitReportGroupKey(key);
    if (keyProperty === property) dates.add(date);
  }
  return dates;
}

/**
 * Applies the source map's four rules to every date either summary source
 * mentions, for both properties:
 *
 * 1. Ville-summary dates before the copy window are never imported as
 *    Ville — verified against the HF summary of the same date instead
 *    (see compareSummaryDays / skippedCopies). Exception: a date listed in
 *    `resolvedVilleSummaryDates`, i.e. one whose sheet a human explicitly
 *    ruled on, takes the general path instead — an owner-approved ruling
 *    about one sheet outranks a range-wide heuristic.
 * 2. Ville dates in the copy window that DO have booking rows are
 *    reconstructed from them (provenance "reconstructed").
 * 3/4. Everywhere else: a typed summary always wins when present
 *    ("transcribed" with bookings, "summary_only" without); no summary but
 *    real booking rows reconstructs from them — flagged as a source-map
 *    contradiction outside the Ville copy window, since the map didn't
 *    predict that shape there.
 */
export function buildDayPlans(input: BuildDayPlansInput): BuildDayPlansResult {
  const { hfSummaryByDate, villeSummaryByDate, reportByPropertyDate } = input;
  const resolvedVilleSummaryDates = input.resolvedVilleSummaryDates ?? new Set<string>();
  const dayPlans: DayImportPlan[] = [];
  const skippedCopies: SkippedCopyRow[] = [];

  function reportEntryFor(property: PropertyCode, date: string): LabeledReportSheet | null {
    return reportByPropertyDate.get(reportGroupKey(property, date)) ?? null;
  }

  // --- HF: summary spans the full range per the source map; any HF day
  // reconstructed purely from bookings (no typed summary) is unpredicted. ---
  const hfDates = new Set([...hfSummaryByDate.keys(), ...datesForProperty(reportByPropertyDate, "hf")]);
  for (const date of hfDates) {
    const summary = hfSummaryByDate.get(date) ?? null;
    const reportEntry = reportEntryFor("hf", date);
    const provenance = classifyDayProvenance(summary !== null, reportEntry !== null);
    if (!provenance) continue; // unreachable: date came from one of the two maps

    const contradictsSourceMap =
      provenance === "reconstructed"
        ? `HF day ${date} has booking rows but no typed summary — the source map states the HF summary workbook spans the full range; needs human review.`
        : null;

    dayPlans.push({
      property: "hf",
      date,
      provenance,
      summary,
      reportSheet: reportEntry?.record ?? null,
      reportWorkbookLabel: reportEntry?.workbookLabel ?? null,
      contradictsSourceMap,
    });
  }

  // --- Ville: copy window first, then the general rules. ---
  const villeReportDates = datesForProperty(reportByPropertyDate, "hfville");
  const allVilleDates = new Set([...villeSummaryByDate.keys(), ...villeReportDates]);

  for (const date of allVilleDates) {
    const reportEntry = reportEntryFor("hfville", date);

    if (isInVilleCopyWindow(date) && !resolvedVilleSummaryDates.has(date)) {
      const villeSummary = villeSummaryByDate.get(date) ?? null;
      if (villeSummary) {
        const hfCounterpart = hfSummaryByDate.get(date) ?? null;
        const comparison = hfCounterpart ? compareSummaryDays(villeSummary, hfCounterpart) : null;
        skippedCopies.push({
          date,
          villeSheetName: villeSummary.sheetName,
          hasHfCounterpart: hfCounterpart !== null,
          identicalToHf: comparison ? comparison.identical : null,
          diffDetail: comparison ? comparison.detail : "no HF summary sheet found for this date to compare against",
          reconstructedFromBookings: reportEntry !== null,
        });
      }
      if (reportEntry) {
        dayPlans.push({
          property: "hfville",
          date,
          provenance: "reconstructed",
          summary: null,
          reportSheet: reportEntry.record,
          reportWorkbookLabel: reportEntry.workbookLabel,
          contradictsSourceMap: null,
        });
      }
      // else: a genuine gap before Ville had any records at all — nothing to import.
      continue;
    }

    const summary = villeSummaryByDate.get(date) ?? null;
    const provenance = classifyDayProvenance(summary !== null, reportEntry !== null);
    if (!provenance) continue; // unreachable: date came from one of the two maps

    const contradictsSourceMap =
      provenance === "reconstructed"
        ? `Ville day ${date} (after the copy window) has booking rows but no typed summary — unexpected per the source map; needs human review.`
        : null;

    dayPlans.push({
      property: "hfville",
      date,
      provenance,
      summary,
      reportSheet: reportEntry?.record ?? null,
      reportWorkbookLabel: reportEntry?.workbookLabel ?? null,
      contradictsSourceMap,
    });
  }

  dayPlans.sort((a, b) => (a.property === b.property ? a.date.localeCompare(b.date) : a.property.localeCompare(b.property)));
  return { dayPlans, skippedCopies };
}

// ── grand-total reconciliation (imported total vs the sheet's own printed รวม) ─

/**
 * One day's comparison of what this importer actually wrote against the
 * summary sheet's own printed grand total — the single most convincing proof
 * that nothing was silently dropped. `categoryBreakdown` and
 * `otherIncomeSatang` are carried along purely so a mismatched day's report
 * entry can show WHERE the money went, not just that it's off.
 */
export interface GrandTotalCheckSample {
  property: PropertyCode;
  date: string;
  sheetName: string;
  /** Sum of every income cell this importer wrote for the day: the direct
   *  category cells plus everything landed in other_income_items (itemized
   *  rows, folded unknown labels, and/or the deterministic cash/transfer
   *  split — see import.ts writeDay). */
  importedTotalSatang: number;
  printedTotalSatang: number;
  categoryBreakdown: Partial<Record<CategoryKey, number>>;
  otherIncomeSatang: number;
}

export interface GrandTotalCheckRow extends GrandTotalCheckSample {
  varianceSatang: number;
}

export interface GrandTotalCheckResult {
  toleranceSatang: number;
  daysChecked: number;
  daysMatching: number;
  daysMismatching: number;
  totalAbsoluteDiscrepancySatangByProperty: Partial<Record<PropertyCode, number>>;
  worstOffenders: GrandTotalCheckRow[];
}

export function checkGrandTotals(
  samples: GrandTotalCheckSample[],
  toleranceSatang: number,
  worstOffenderCount = 20,
): GrandTotalCheckResult {
  const rows: GrandTotalCheckRow[] = samples.map((s) => ({
    ...s,
    varianceSatang: s.importedTotalSatang - s.printedTotalSatang,
  }));

  const mismatching = rows.filter((r) => Math.abs(r.varianceSatang) > toleranceSatang);

  const totalAbsoluteDiscrepancySatangByProperty: Partial<Record<PropertyCode, number>> = {};
  for (const row of mismatching) {
    totalAbsoluteDiscrepancySatangByProperty[row.property] =
      (totalAbsoluteDiscrepancySatangByProperty[row.property] ?? 0) + Math.abs(row.varianceSatang);
  }

  const worstOffenders = [...mismatching]
    .sort((a, b) => Math.abs(b.varianceSatang) - Math.abs(a.varianceSatang))
    .slice(0, worstOffenderCount);

  return {
    toleranceSatang,
    daysChecked: rows.length,
    daysMatching: rows.length - mismatching.length,
    daysMismatching: mismatching.length,
    totalAbsoluteDiscrepancySatangByProperty,
    worstOffenders,
  };
}
