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

// `deposit_applied` (added Wave C, 2026-07-31 — see docs/adr/0001 and
// shared/accrual.ts) is the NINTH tender: how a folio settles a
// มัดจำล่วงหน้า it takes at the stay ("ตัดยอดมัดจำ", iHOTEL's own word) under
// the accrual rule — it IS how the folio settled, so it belongs on the
// tender record like every other payment method, never as a side flag. It
// shares the booking grid's `deposit` COLUMN SLOT with the pre-cutover
// `deposit` tender (see `visibleTendersForDate()` in accrual.ts) — only one
// of the two is ever visible for a given day, but BOTH are always present
// on `Tender`/`TENDERS`/every `Record<Tender, ...>` so money already in
// either column can never silently vanish from a sum on a day using the
// other.
export type Tender =
  | "deposit"
  | "deposit_applied"
  | "cash"
  | "credit_kbank"
  | "credit_icbc"
  | "transfer_kbank"
  | "transfer_icbc"
  | "web"
  | "other";

/** Paper column order. Iterate this — never `Object.keys()` on a
 * `Record<Tender, ...>` — anywhere the order must match the printed sheet.
 * `deposit_applied` sits immediately after `deposit` (the shared column
 * slot — see the `Tender` doc comment above and `visibleTendersForDate()`
 * in accrual.ts, which filters this down to the 8 actually shown for a
 * given date). */
export const TENDERS: readonly Tender[] = [
  "deposit",
  "deposit_applied",
  "cash",
  "credit_kbank",
  "credit_icbc",
  "transfer_kbank",
  "transfer_icbc",
  "web",
  "other",
];

/** Thai labels, verbatim from the paper booking-sheet header (`deposit`) or
 * iHOTEL's own wording (`deposit_applied` — "ตัดยอดมัดจำ", see docs/adr/0001). */
export const TENDER_LABELS_TH: Record<Tender, string> = {
  deposit: "มัดจำค่าห้อง โอน/เครดิต",
  deposit_applied: "ตัดยอดมัดจำ",
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
 *
 * `deposit_credit`/`other_credit`/`bar_credit` (added 2026-07-31, see
 * docs/plan-unify-exports-tender-split.md item 2) are the split-off เครดิต
 * halves of `deposit`/`other_transfer`/`bar_transfer` — those three paper
 * categories used to combine โอน+เครดิต in one input cell; going forward
 * they are โอน-only and their เครดิต money enters through the new sibling
 * key instead. Existing key strings/history are untouched (no retro-split).
 *
 * `deposit_applied` (added Wave C, 2026-07-31 — see docs/adr/0001) is the
 * accrual-era counterpart of `deposit`/`deposit_credit`: a มัดจำล่วงหน้า
 * applied against the stay it was taken for, recognised as revenue on the
 * stay's day with no money movement. `deposit`/`deposit_credit` KEEP their
 * key + meaning after the cutover (history is not restated) but are
 * retired at the UI layer going forward — see DaySheetPage.tsx.
 */
export type CategoryKey =
  | "deposit"
  | "deposit_credit"
  | "deposit_applied"
  | "room_cash"
  | "credit_kbank"
  | "credit_icbc"
  | "transfer_kbank"
  | "transfer_icbc"
  | "web"
  | "other_cash"
  | "other_transfer"
  | "other_credit"
  | "bar_cash"
  | "bar_transfer"
  | "bar_credit";

/**
 * The eight tenders that map straight onto a seeded income-category cell —
 * see `deriveIncomeFromBookings()` in `bookings.ts`. Tender `"other"` is
 * deliberately absent: on the paper it becomes an itemized
 * `OtherIncomeItem` entry, not a derived category cell, so it has no
 * `CategoryKey` counterpart. `deposit_applied` maps onto its own
 * same-named CategoryKey (Wave C) — it IS how the folio settled, so it
 * derives a category cell exactly like every other tender, never a side
 * flag.
 */
export const TENDER_TO_CATEGORY_KEY: Partial<Record<Tender, CategoryKey>> = {
  deposit: "deposit",
  deposit_applied: "deposit_applied",
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
 * The owner's deposit-machine reconciliation rows (docs/plan-unify-exports-
 * tender-split.md item 6, Wave C, 2026-07-31): small change/coins can't
 * always go into the deposit machine, so ยอดฝากจริง legitimately differs from
 * the day's raw cash total. Layered on top of `CashBlockAmounts.bankedSatang`
 * inside `deriveCashBlock()` (`bankedSatang = roomCash + otherCash + barCash
 * - heldBackSatang + broughtForwardSatang`) — unlike the four
 * `CashBlockAmounts` fields, these two have no `derived` counterpart of
 * their own: there is nothing in the day's income/expense data to derive
 * them FROM, they are always a direct manual entry. Used as the PUT
 * .../cash-block body's optional extra fields (a plain `number` there, same
 * as `CashBlockAmounts` fields) — `CashBlock`'s own copies are individually
 * nullable instead (see below).
 */
export interface CashAdjustmentAmounts {
  heldBackSatang: number;
  broughtForwardSatang: number;
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
 *
 * `heldBackSatang`/`broughtForwardSatang` (see `CashAdjustmentAmounts`) are
 * persisted and audited the SAME way (same endpoint, same `sheet_days` row,
 * NOT gated by month close), but sit outside the derived/entered pair since
 * they have no `derived` fallback of their own: `null` = not recorded, an
 * explicit `0` is meaningful (never collapsed to `null` — same
 * `AmountInput` `zeroIsMeaningful` convention as the four fields above).
 * They already participate in `derived.bankedSatang` (and therefore in
 * `entered.bankedSatang` whenever that field itself isn't separately
 * overridden) by the time this reaches a consumer — nothing downstream
 * needs to apply the formula itself.
 */
export interface CashBlock {
  derived: CashBlockAmounts;
  entered: CashBlockAmounts | null;
  heldBackSatang: number | null;
  broughtForwardSatang: number | null;
  /**
   * Always-derived (Wave C, docs/adr/0001) sums of this day's cash-tender
   * `deposit_events` rows — see `depositCashTotals()`/`deriveCashBlock()` in
   * bookings.ts. NOT part of `CashBlockAmounts`/the override pair: a
   * deposit event is itemized and hand-editable at its own source (the
   * event itself), so a correction happens there, never via an aggregate
   * override here. Already folded into `derived.bankedSatang` (and
   * therefore `entered.bankedSatang` whenever that field itself isn't
   * separately overridden) by the time this reaches a consumer — a cash
   * deposit received reaches ยอดฝากจริง while staying excluded from
   * `รวมรายรับทั้งวัน`; a cash refund of a cash deposit reduces it back;
   * transfer/credit deposit tenders never touch either field. */
  depositCashInSatang: number;
  depositCashOutSatang: number;
}

// ── Deposit events (Wave C, docs/adr/0001-accrual-recognition-for-deposits.md) ──
// A มัดจำล่วงหน้า has exactly two possible endings under accrual: applied to
// a stay (recognised as revenue there — see the `deposit_applied` Tender/
// CategoryKey above) or refunded (money leaves, revenue never recognised).
// The RECEIVED/REFUNDED moments themselves are a separate, day-scoped table
// (modelled on `OtherIncomeItem`, never a BookingLine flag — a forgotten
// filter on a flag would book a received deposit as invisible revenue,
// exactly ADR-0001's failure mode; a missing cash-block entry from a
// separate table surfaces same-day as a bank mismatch instead).

export type DepositEventKind = "received" | "refunded";

/** Bank-agnostic on purpose (unlike the booking-grid Tender columns, which
 * are bank-specific) — a มัดจำล่วงหน้า can arrive/leave by any of these, and
 * iHOTEL's own ledger does not always resolve which bank a transfer/credit
 * used. */
export type DepositTender = "cash" | "transfer" | "credit" | "web" | "other";

export const DEPOSIT_TENDERS: readonly DepositTender[] = ["cash", "transfer", "credit", "web", "other"];

export const DEPOSIT_TENDER_LABELS_TH: Record<DepositTender, string> = {
  cash: "เงินสด",
  transfer: "โอน",
  credit: "บัตรเครดิต",
  web: "เว็บไซต์/OTA",
  other: "อื่นๆ",
};

/**
 * One received-or-refunded มัดจำล่วงหน้า moment. `amountSatang` is always a
 * `>0` MAGNITUDE — `kind` carries the sign (received = money in, refunded =
 * money out) rather than a signed amount, so every consumer that just wants
 * "how much" never has to re-derive a sign convention.
 *
 * `bookingNo` is the R-number iHOTEL's own จ่ายล่วงหน้า/คืนเงินจองห้อง rows
 * key to (`ledger_cin_no` for those ds_names — see pms-prefill.ts) — an
 * R-number pairs with its deposit for life (docs/adr/0001: the booking is
 * moved, never replaced). `source`/`pmsRef` mirror `BookingLine`'s own
 * manual-vs-imported provenance pair; a manual (hand-entered) event carries
 * `pmsRef: null`.
 */
export interface DepositEvent {
  id: number;
  property: Property;
  date: string;
  kind: DepositEventKind;
  bookingNo: string | null;
  guestName: string | null;
  tender: DepositTender;
  amountSatang: number;
  note: string | null;
  source: "manual" | "pms";
  pmsRef: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

// ── Deposit notes (Wave D, office deposit register — issue #5 / the
// R015834-style reconciliation requirement) ────────────────────────────
// ONE note thread per (property, R-number) — an R-number pairs with its
// deposit for life (docs/adr/0001: the booking is moved, never replaced),
// so a note is keyed to the R-number, never to a specific exception kind
// (a deposit can be BOTH "aging" and "mismatched" at once — the note is
// the same conversation either way). "Explained" = `resolvedAt` explicitly
// non-null — mirrors `sheet_days.verified_at`'s convention: a note saying
// "waiting on reception" must keep shouting until someone deliberately
// marks it resolved, not silently count as handled just because text
// exists.

export interface DepositNote {
  property: Property;
  rNumber: string;
  note: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  updatedAt: string;
  updatedBy: string;
}

// ── Payment audits (Wave 1, the office audit hub — docs/plan-audit-hub-
// slips.md) ─────────────────────────────────────────────────────────────
// The office audits EVERY payment of a day (not just deposits), one row per
// STAY SETTLEMENT (see CONTEXT.md's ตรวจสอบ entry). A tick is independent of
// `sheet_days.verified_at`/month-close — its OWN small audit trail, keyed by
// the settlement's own reference rather than a date: `auditKey` is the CH
// (check-in) number for a เช็คอิน row, or the receipt's `pay_no` for a
// รับมัดจำ/คืนเงิน row. Absence of a row = pending (never a stored "false" —
// mirrors `deposit_notes`'s "explained = resolved_at IS NOT NULL" convention
// of using presence/absence rather than a boolean column). `date` records
// the audited DAY (the ตรวจรายวัน tab's selected date at tick time) — kept
// for the day-scoped listing query (`listPaymentAudits(property, date)`),
// even though `auditKey` alone is the table's real identity (PK is
// `(property, auditKey)`, not `(property, auditKey, date)` — a settlement
// has exactly one audit_key for life, so re-ticking always targets the same
// row regardless of which day's queue view the tick was pressed from).
export interface PaymentAudit {
  property: Property;
  auditKey: string;
  date: string;
  checkedAt: string;
  checkedBy: string;
}

/**
 * A deposit thread's (R-number's) lifecycle state — owner ask (2026-08-01,
 * register mapability): the register must make a deposit's STATE
 * unambiguous, not just its outstanding balance. Derived purely from a
 * `DepositThread`'s own received/applied/refunded/outstanding figures
 * (`deriveDepositThreadStatus()`, `src/server/deposit-register.ts`) —
 * never a stored value, always recomputed from the same numbers the
 * register already carries.
 *
 * - `"waitingCheckin"` — received only, nothing applied or refunded yet
 *   (`outstandingSatang > 0`, `appliedSatang === 0`, `refundedSatang ===
 *   0`). The register's aging list IS this bucket (`outstandingSatang >
 *   0` is its filter) plus `"partial"` below.
 * - `"partial"` — still holding a balance, but SOME of it has already
 *   moved (`outstandingSatang > 0` with `appliedSatang > 0` or
 *   `refundedSatang > 0`).
 * - `"applied"` — fully absorbed into a stay (`outstandingSatang <= 0`,
 *   `appliedSatang > 0`) — the ตัดยอดแล้ว case, including the R015834-style
 *   over-applied mismatch (still separately flagged via
 *   `buildDepositExceptions`; the two are complementary, not exclusive).
 * - `"refunded"` — closed out purely by a refund, no application involved
 *   (`outstandingSatang <= 0`, `refundedSatang > 0`, `appliedSatang ===
 *   0`).
 *
 * Deliberately does NOT cover `voided` — that stays an event-level, greyed
 * "ยกเลิก" treatment (see `DepositLedgerEvent.voided` /
 * `VoidedDepositEventSummary`), never a thread-level status: a thread can
 * hold a mix of voided and active events, and voiding one event never
 * changes what the thread's ACTIVE money is doing.
 */
export type DepositThreadStatus = "waitingCheckin" | "applied" | "refunded" | "partial";

/** Canonical Thai labels for `DepositThreadStatus` — the ONLY vocabulary
 * the register UI may use for a thread's state. _Avoid_: "ใช้แล้ว" (used),
 * "จ่ายแล้ว" (paid) — both are ambiguous about whether money moved or was
 * merely applied, exactly the distinction this whole feature exists to
 * make unambiguous. See CONTEXT.md's มัดจำล่วงหน้า entry for the full
 * definitions. */
export const DEPOSIT_THREAD_STATUS_LABELS_TH: Record<DepositThreadStatus, string> = {
  waitingCheckin: "รอเช็คอิน",
  applied: "ตัดยอดแล้ว",
  refunded: "คืนเงินแล้ว",
  partial: "บางส่วน",
};

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
 *
 * Wave C addition: `deposits` — this day's `DepositEvent` rows (received
 * and refunded มัดจำล่วงหน้า moments), additive alongside every field above.
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
  deposits: DepositEvent[];
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
/** Bound for `DepositNote.note` (Wave D deposit register) — deliberately
 * more generous than `NOTE_MAX_LEN`: this is the office's ONLY durable
 * record of *why* a deposit exception exists (e.g. the R015834-style
 * 395->790 gap), so it needs room for a real explanation, not a one-line
 * tag. */
export const DEPOSIT_NOTE_MAX_LEN = 1000;
