// Locked contract types. This file is READ-ONLY outside Phase 0 — see
// CLAUDE.md and src/shared/api.md (the contract of record). Any change here
// is a contract change: it lands in Phase 2 (serial), never hot-patched
// into the parallel work packages.
//
// Money = integer satang end to end (1 baht = 100 satang) — see money.ts
// for the only place baht<->satang conversion happens. Business dates are
// Bangkok calendar strings "YYYY-MM-DD" — see date.ts (todayBangkok()).
// UI language is Thai-only on every screen, including admin — there is NO
// name_en field anywhere in this contract.

export type Property = "hf" | "hfville";

export const PROPERTIES: readonly Property[] = ["hf", "hfville"];

export function isProperty(v: unknown): v is Property {
  return v === "hf" || v === "hfville";
}

/**
 * Full Thai/English hotel names. The UI renders Thai only (`th`) — `en` is
 * contract metadata for audit trails / future integrations, never shown
 * on screen.
 */
export const PROPERTY_LABELS: Record<Property, { th: string; en: string }> = {
  hf: { th: "โรงแรม HF", en: "The Harbour Front Hotel" },
  hfville: { th: "HF วิลล์", en: "HF Ville" },
};

export type CategoryKind = "income" | "expense";

// ── Tenders: the eight payment columns on a paper booking row ─────────────
// A booking can pay across more than one tender (measured: 216 of 4,720
// rows split across 2-3 tenders; 392 rows carry zero tenders — coupon/comp).
// BookingLine therefore carries a full record of all eight, never a single
// tender enum. See src/shared/bookings.ts for the functions that sum these.

export type Tender =
  | "deposit"
  | "cash"
  | "credit_kbank"
  | "credit_icbc"
  | "transfer_kbank"
  | "transfer_icbc"
  | "web"
  | "other";

/** Paper column order. Iterate this — never `Object.keys()` on a
 * `Record<Tender, ...>` — anywhere the order must match the printed sheet. */
export const TENDERS: readonly Tender[] = [
  "deposit",
  "cash",
  "credit_kbank",
  "credit_icbc",
  "transfer_kbank",
  "transfer_icbc",
  "web",
  "other",
];

/** Thai labels, verbatim from the paper booking-sheet header. */
export const TENDER_LABELS_TH: Record<Tender, string> = {
  deposit: "มัดจำค่าห้อง โอน/เครดิต",
  cash: "เงินสดค่าห้อง",
  credit_kbank: "บัตรเครดิต กสิกร",
  credit_icbc: "บัตรเครดิต ICBC",
  transfer_kbank: "โอน กสิกร",
  transfer_icbc: "โอน ICBC",
  web: "แอพฯ/เว็บไซด์",
  other: "อื่นๆ สด/โอน/เครดิต",
};

/**
 * Stable identity of a seeded income category, independent of its display
 * name — managers can rename categories (see api.md "Data model"), so any
 * logic that means "the cash room-income category" must key off this,
 * never match on `nameTh`. `null` = a manager-created category, never
 * derived from a tender.
 */
export type CategoryKey =
  | "deposit"
  | "room_cash"
  | "credit_kbank"
  | "credit_icbc"
  | "transfer_kbank"
  | "transfer_icbc"
  | "web"
  | "other_cash"
  | "other_transfer"
  | "bar_cash"
  | "bar_transfer";

/**
 * The seven tenders that map straight onto a seeded income-category cell —
 * see `deriveIncomeFromBookings()` in `bookings.ts`. Tender `"other"` is
 * deliberately absent: on the paper it becomes an itemized
 * `OtherIncomeItem` entry, not a derived category cell, so it has no
 * `CategoryKey` counterpart.
 */
export const TENDER_TO_CATEGORY_KEY: Partial<Record<Tender, CategoryKey>> = {
  deposit: "deposit",
  cash: "room_cash",
  credit_kbank: "credit_kbank",
  credit_icbc: "credit_icbc",
  transfer_kbank: "transfer_kbank",
  transfer_icbc: "transfer_icbc",
  web: "web",
};

export interface Category {
  id: number;
  property: Property;
  kind: CategoryKind;
  nameTh: string;
  sort: number;
  isCash: boolean;
  /** Stable identity for a seeded category (see `CategoryKey`); `null` for
   * a manager-created category. Never derive behavior from `nameTh`
   * instead — managers can rename freely. */
  categoryKey: CategoryKey | null;
  archivedAt: string | null;
  createdAt: string;
}

/** One income cell for a (property, date, category). Keyed by categoryId in
 * DaySheet.income — see api.md endpoint 7/8. */
export interface IncomeCell {
  categoryId: number;
  amountSatang: number;
  note: string | null;
  /** `"manual"` = typed by a human, `"import"` = one-time Excel backfill,
   * `"booking"` = written by `POST .../fill-from-bookings` (see api.md
   * "Planned endpoints"). */
  source: "manual" | "import" | "booking";
  /** True once a human has entered/edited this cell directly.
   * `fill-from-bookings` must skip any cell with `manual: true` rather
   * than overwrite it. */
  manual: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface ExpenseItem {
  id: number;
  property: Property;
  date: string;
  categoryId: number;
  note: string | null;
  amountSatang: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * One row of the per-booking daily income report — the paper's other half
 * beside the summary sheet (see CLAUDE.md/api.md background). A booking can
 * pay across more than one tender (measured: 216 of 4,720 rows split 2-3
 * ways; 392 rows carry zero tenders — coupon/comp), so `tenders` is a full
 * eight-column record, never a single tender enum.
 */
export interface BookingLine {
  id: number;
  property: Property;
  date: string;
  /** Row order within the day, as printed on the paper (1-based, dense). */
  seq: number;
  bookingNo: string | null;
  guestName: string | null;
  roomNo: string | null;
  roomCount: number | null;
  nights: number | null;
  grossRoomSatang: number;
  grossOtherSatang: number;
  discountSatang: number;
  /** Satang per payment column; 0 where the paper's column is blank. A
   * plain Record (not a sparse/partial map) keeps all eight columns
   * lossless and JSON-clean — see bookings.ts. */
  tenders: Record<Tender, number>;
  remark: string | null;
  /** `"manual"` = typed in this app, `"import"` = one-time Excel backfill,
   * `"pms"` = drafted from the future PMS feed (see `draft`). */
  source: "manual" | "import" | "pms";
  /** True for a PMS-drafted row awaiting confirmation. Excluded from
   * `computeBookingTotals()` and `deriveIncomeFromBookings()`
   * (bookings.ts). */
  draft: boolean;
  /** Which Excel workbook sheet/tab this row was imported from, for
   * traceability; null for rows the importer never touched. */
  sourceSheet: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * One itemized non-booking revenue entry — the paper's รายการอื่นๆ line
 * (breakfast, late checkout, parking, fines). Typically 2-4 entries a day
 * with free text; not derivable from booking rows. Shape mirrors
 * ExpenseItem.
 */
export interface OtherIncomeItem {
  id: number;
  property: Property;
  date: string;
  description: string | null;
  amountSatang: number;
  isCash: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** The four figures in a CashBlock, shared by its `derived` and `entered`. */
export interface CashBlockAmounts {
  roomCashSatang: number;
  otherCashSatang: number;
  barCashSatang: number;
  bankedSatang: number;
}

/**
 * The paper's `**หมายเหตุ` cash-banking block. `derived` is always computed
 * server-side from the day's income cells + itemized other-income (see
 * `deriveCashBlock()` in bookings.ts). `entered` is a manager's override of
 * any/all four figures for days where reality (a bank slip) differs from
 * what the categories imply — `null` when no override has been recorded.
 * Consumers read `entered ?? derived` per field (or treat a non-null
 * `entered` as authoritative wholesale); see api.md
 * `PUT /:property/day/:date/cash-block`.
 */
export interface CashBlock {
  derived: CashBlockAmounts;
  entered: CashBlockAmounts | null;
}

/**
 * How a day's data came to exist. `"app"` = entered live in this app;
 * `"transcribed"` = the one-time Excel importer matched the paper exactly;
 * `"reconstructed"` = the importer had to infer/reconcile a mismatch;
 * `"summary_only"` = a summary sheet exists but no per-booking backfill
 * reaches this day.
 */
export type DayProvenance = "app" | "transcribed" | "reconstructed" | "summary_only";

export interface DayTotals {
  incomeSatang: number;
  expenseSatang: number;
  /** Gross cash taken in — this is the paper's "สรุปเงินสดฝากเข้าบัญชี" line. */
  cashIncomeSatang: number;
  cashExpenseSatang: number;
  /** cashIncomeSatang - cashExpenseSatang. A useful figure, but NOT the
   * paper's line of that name: the paper banks gross cash and does not net
   * off same-day cash expenses. The report must show gross, deduction and
   * net as three labelled lines rather than printing this one under the
   * paper's label. */
  cashToDepositSatang: number;
  netSatang: number;
}

/**
 * Aggregate of a day's non-draft booking lines — see
 * `computeBookingTotals()` in bookings.ts. Draft lines (PMS-drafted, not
 * yet confirmed) are excluded from every figure here.
 */
export interface BookingTotals {
  lineCount: number;
  roomCount: number;
  nights: number;
  grossRoomSatang: number;
  grossOtherSatang: number;
  discountSatang: number;
  receivedSatang: number;
  byTender: Record<Tender, number>;
}

/**
 * The full day sheet as returned by GET /api/:property/day/:date — see
 * api.md. `categories` is active categories of both kinds for the property,
 * plus any archived category referenced by this day's data (archivedAt
 * non-null flags it). Totals are ALWAYS server-computed via
 * computeDayTotals() in totals.ts — the client imports the SAME function so
 * UI and API can never disagree.
 *
 * Wave 2 additions (see api.md "Planned endpoints"): `bookingLineCount` is
 * a cheap summary so the day view can show "N bookings" without fetching
 * the full booking-lines list; `otherIncome` is the day's itemized
 * non-booking revenue (paper's รายการอื่นๆ); `cashBlock` reproduces the
 * paper's `**หมายเหตุ` cash-banking block; `provenance` records how this
 * day's data came to exist (see DayProvenance); `verifiedAt`/`verifiedBy`
 * record a manager's explicit sign-off (see `PUT .../verify`);
 * `monthClosed` mirrors whether this day's month has been closed (see
 * `GET/PUT .../months/:month/close`) and is a hint for the client to
 * disable editing, not itself an enforcement mechanism.
 */
export interface DaySheet {
  categories: Category[];
  income: Record<number, IncomeCell>;
  expenses: ExpenseItem[];
  note: string | null;
  totals: DayTotals;
  bookingLineCount: number;
  otherIncome: OtherIncomeItem[];
  cashBlock: CashBlock;
  provenance: DayProvenance;
  verifiedAt: string | null;
  verifiedBy: string | null;
  monthClosed: boolean;
  updatedAt: string;
  updatedBy: string;
}

/** One row in the /:property/history month view. */
export interface DaySummary {
  date: string;
  incomeSatang: number;
  expenseSatang: number;
  cashToDepositSatang: number;
  verified: boolean;
  provenance: DayProvenance;
}

export interface Me {
  email: string;
  isManager: boolean;
}

// ── Server-enforced bounds (validated server-side; see api.md) ────────────
export const AMOUNT_SATANG_MIN = 0;
export const AMOUNT_SATANG_MAX = 99_999_999_999;
export const NOTE_MAX_LEN = 200;
/** Bound for `BookingLine.remark`. Settled at 200 to match `NOTE_MAX_LEN`
 * and the note convention: the client used to allow 500 while the server
 * validated 200, so a long remark 400'd on blur with the row's edit lost.
 * Both sides read THIS constant — never re-declare the number locally. */
export const REMARK_MAX_LEN = 200;
export const NAME_TH_MIN_LEN = 1;
export const NAME_TH_MAX_LEN = 80;
export const BOOKING_NO_MAX_LEN = 40;
export const GUEST_NAME_MAX_LEN = 120;
/** Room lists for large group bookings are genuinely long: the imported
 * 2025-10-10 HF sheet carries a 38-room booking whose list runs 125 chars
 * (it spanned several spreadsheet rows on the paper). 40 was too tight and
 * silently truncated 12 real rows on blur, since the client slices to this
 * bound and the server validates against it. Raised with headroom. */
export const ROOM_NO_MAX_LEN = 200;
export const COUNT_MAX = 999;
export const DESCRIPTION_MAX_LEN = 200;
