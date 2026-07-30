// Local parse-output types for the Excel import layer.
//
// Deliberately independent from src/shared/** — this is a pure parse layer.
// A later wave maps these shapes onto the application's own contract.

/** The two physical properties the workbooks report on. */
export type PropertyCode = "hf" | "hfville";

/** A calendar date already converted to the Christian Era (CE), 1-indexed month. */
export interface PlainDate {
  year: number;
  month: number;
  day: number;
}

/** Which of the three date sources a candidate date came from. */
export type DateSourceName = "sheetName" | "dateCell" | "header";

/** One source's reading, or null when that source is absent/unparseable on this sheet. */
export interface DateSourceReading {
  source: DateSourceName;
  date: PlainDate | null;
}

/** A candidate discarded before voting because it fell outside the
 *  plausible-year window (e.g. a sheet-name typo like "8568" parsing to
 *  Buddhist year 8568 / CE 8025) — never counted as a disagreeing vote. */
export interface DiscardedDateCandidate {
  source: DateSourceName;
  date: PlainDate;
}

/**
 * Result of the three-source majority vote (sheet name / date cell /
 * header). Candidates outside the plausible-year window are discarded
 * before voting (see `discarded`) so an implausible parse never counts as a
 * disagreeing source. `date` is null only when two or more surviving
 * candidates genuinely disagree, or when none survive — callers must treat
 * that as a hard failure requiring manual review, never guess a fallback.
 */
export interface DateResolution {
  date: PlainDate | null;
  sources: DateSourceReading[];
  /** How many surviving sources agree with the resolved date (0 when unresolved). */
  agreementCount: number;
  /** True whenever a surviving source disagreed with the resolved date. */
  hasDisagreement: boolean;
  /** True when the vote could not settle on a date (0 survivors, or 2+ survivors that disagree). */
  unresolved: boolean;
  /** True when exactly one candidate survived plausibility filtering and
   *  resolved the date on its own — worth listing separately in a report. */
  singleSource: boolean;
  /** Candidates discarded for falling outside the plausible-year window. */
  discarded: DiscardedDateCandidate[];
}

// ---------------------------------------------------------------------------
// Summary-sheet ("สรุปยอด") category keys
// ---------------------------------------------------------------------------

export type SummaryCategoryKey =
  | "depositAdvance"
  | "roomCash"
  | "creditKbank"
  | "creditIcbc"
  | "transferKbank"
  | "transferIcbc"
  | "website"
  | "otherItems"
  | "waterBarCash"
  | "waterBarTransferCredit";

/** The cash-only reconciliation block printed below the `**หมายเหตุ` marker. */
export type CashBlockKey =
  | "hotelRevenueCash"
  | "otherItemsCash"
  | "waterBarCashBlock"
  | "bankedTotal";

export interface OtherIncomeItem {
  /** Verbatim Thai free text, never invented or corrected. */
  text: string;
  amountSatang: number;
  /** Best-effort tender inference from the free text; undefined when neither cash nor transfer/credit wording is present. */
  isCash: boolean | undefined;
  cellAddress: string;
}

export interface UnknownLabelEntry {
  label: string;
  amountSatang: number;
  cellAddress: string;
  /**
   * Which side of the `**หมายเหตุ` marker this label came from. Genuinely
   * different in kind, not just location: a `"main"` label can be new,
   * previously-uncaptured income (the "7th layout variant" — see
   * scripts/import-xls/import.ts). A `"cashBlock"` label is always a
   * restatement of an amount already counted somewhere in the main block
   * (the office annotating "how much of the total was cash") — verified
   * against three real sheets via the grand-total reconciliation: folding a
   * cashBlock label on top of its main-block counterpart double-counts real
   * money by exactly the cashBlock amount every time. A cashBlock label must
   * therefore never be folded into other_income_items.
   */
  section: "main" | "cashBlock";
}

export interface SummaryDayRecord {
  sheetName: string;
  property: PropertyCode;
  dateResolution: DateResolution;
  categories: Partial<Record<SummaryCategoryKey, number>>;
  otherIncomeItems: OtherIncomeItem[];
  cashBlock: Partial<Record<CashBlockKey, number>>;
  /** The sheet's own printed grand total ("รวม" row), in satang, or null if not found. */
  printedTotalSatang: number | null;
  unknownLabels: UnknownLabelEntry[];
}

export interface SummaryWorkbookResult {
  filePath: string;
  property: PropertyCode;
  sheetsParsed: number;
  days: SummaryDayRecord[];
  dateFailures: Array<{ sheetName: string; dateResolution: DateResolution }>;
}

// ---------------------------------------------------------------------------
// Per-booking ("รายงานรายรับ") row keys
// ---------------------------------------------------------------------------

export interface BookingTenders {
  depositSatang: number;
  cashSatang: number;
  creditKbankSatang: number;
  creditIcbcSatang: number;
  transferKbankSatang: number;
  transferIcbcSatang: number;
  appWebsiteSatang: number;
  otherSatang: number;
}

export interface BookingRow {
  rowIndex: number;
  seq: number | null;
  bookingNo: string | null;
  guestName: string;
  roomRaw: string;
  roomTokens: string[];
  /** Best-effort property from this row's own room tokens; undefined when the tokens are unclassifiable or disagree with each other. */
  property: PropertyCode | undefined;
  roomCount: number | null;
  nights: number | null;
  grossRoomSatang: number;
  grossOtherSatang: number;
  discountSatang: number;
  tenders: BookingTenders;
  remark: string | null;
  /** True when this row had financial data but no seq number — a real anomaly worth flagging. */
  missingSeqAnomaly: boolean;
}

/** The report sheet's own bottom totals row (columns c0..c17 aggregated by the sheet author). */
export interface ReportTotalsRow {
  roomCount: number | null;
  nights: number | null;
  grossRoomSatang: number;
  grossOtherSatang: number;
  discountSatang: number;
  tenders: BookingTenders;
}

/** One raw line captured from the sheet's own "สรุปยอดรายรับ" recap block, kept only for reconciliation. */
export interface OwnSummaryLine {
  label: string;
  amountSatang: number | null;
  rowIndex: number;
}

export interface OwnSummaryBlock {
  lines: OwnSummaryLine[];
  /** The block's own printed grand total ("รวม"), in satang, if found. */
  reconciliationTotalSatang: number | null;
}

// A quarantine means the two signals genuinely DISAGREE, or BOTH are
// uninformative — never that just one of them happened to be missing. When
// only one signal resolves (room confident + title missing, or title
// confident + room absent/tied), that is a confident classification, not a
// quarantine.
export type QuarantineReason = "room-title-mismatch" | "no-signal";

export interface ReportSheetRecord {
  sheetName: string;
  dateResolution: DateResolution;
  /** null when the sheet was quarantined — see quarantineReason/quarantineDetail. */
  property: PropertyCode | null;
  quarantineReason: QuarantineReason | null;
  quarantineDetail: string | null;
  bookingRows: BookingRow[];
  totalsRow: ReportTotalsRow | null;
  ownSummaryBlock: OwnSummaryBlock;
  skippedBlankRowCount: number;
  unclassifiedRows: Array<{ rowIndex: number; raw: string }>;
}

export interface ReportWorkbookResult {
  filePath: string;
  sheetsParsed: number;
  days: ReportSheetRecord[];
  dateFailures: Array<{ sheetName: string; dateResolution: DateResolution }>;
  quarantinedSheets: Array<{ sheetName: string; reason: QuarantineReason; detail: string }>;
}

/** Convert a baht amount (as read from a cell) to integer satang. Never sum in baht then round. */
export function toSatang(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.round(value * 100);
}
