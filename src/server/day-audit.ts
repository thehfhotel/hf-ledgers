// ตรวจรายวัน — the office day-audit hub (Wave 1, docs/plan-audit-hub-slips.md).
// A day-scoped PMS query, reshaped into ONE ROW PER STAY SETTLEMENT (see
// CONTEXT.md's ตรวจสอบ entry) rather than one row per raw ledger line — the
// core reshaping this module exists for is the STAY MERGE: a check-in's
// ค่าห้อง payment and its ตัดยอดมัดจำ line (which may arrive on the SAME
// receipt or a DIFFERENT one, but always share the same CH/`ledger_cin_no`)
// collapse into ONE เช็คอิน row, never two (the "R014843 shape" the tests
// name it after).
//
// REUSE, never a second money-parsing rulebook: `getPmsClient()`/
// `pmsConfigured()`/`bangkokDayWindow()`/`parseLedgerSatang()`/
// `buildGuestName()`/`LEDGER_DS_NAMES`/`DEPOSIT_APPLIED_PREFIX`/
// `parseAppliedBookingNo()`/`DS_NAME_DEPOSIT_RECEIVED`/`DS_NAME_DEPOSIT_REFUND`
// all come straight from pms-prefill.ts. `classifyDepositRow()` — deposit-
// register.ts's own pure classifier for the three deposit-lifecycle ds_names
// (received/applied/refunded) — is reused DIRECTLY for those same three
// shapes here rather than re-derived, so this module and the full-history
// register can never disagree on what a จ่ายล่วงหน้า/ตัดยอดล่วงหน้า/
// คืนเงินจองห้อง row means; `RawDepositLedgerRow` (its row shape) is reused as
// this module's OWN query row type for the same reason.
//
// Two NEW ds_name shapes deposit-register.ts never had to classify —
// `ค่าห้อง` (room charge, feeds the เช็คอิน row's gross/composition),
// `ยกเลิกห้อง` (room-charge cancellation, SIGN ANOMALY like pms-prefill.ts's
// own buildBookingCandidate — forced negative regardless of the raw stored
// sign), `ค่าปรับ` (penalty, its own composition bucket), and `คืนเงินส่วนเกิน`
// (excess refund — its OWN คืนเงิน row here, unlike pms-prefill.ts, which
// folds it into the SAME booking candidate as the room charge; this hub
// wants every settlement independently auditable) — are classified fresh in
// this file, mirroring pms-prefill.ts's OWN money-safety rules: `ledger_amount`
// is itemized per line and safe to sum raw; the four raw tender columns are
// REPLICATED across every line of a multi-line receipt and must be read
// ONCE per payment group, never summed per line (the same "57% inflation"
// gotcha pms-prefill.ts's module comment documents).
//
// Voided rows never reach this module's day-scoped query at all (the SQL's
// own `ledger_status IS DISTINCT FROM 'ยกเลิก'`, same as pms-prefill.ts's
// day-scoped `LEDGER_QUERY` — unlike deposit-register.ts's full-history
// `DEPOSIT_LEDGER_QUERY`, which returns them tagged for the register's own
// greyed display) — this is a work queue, not the reconciliation, so a
// voided line simply never produces a row here (the register's own voided
// footnote already covers completeness).
//
// The receipt PAIRING (a เช็คอิน row's applied deposit -> the R's own
// received event, and a คืนเงินจองห้อง row's own R -> whether its receipt is
// voided) needs to see across the R's WHOLE history, not just this day —
// `fetchReceivedLookup()` runs a second, narrow, no-date-window query
// (`ledger_ds_name = 'จ่ายล่วงหน้า'` only, `ledger_cin_no IN (...)` the exact
// R-refs this day's rows need) and reuses `classifyDepositRow()` on its rows
// too, so pairing NEVER re-derives tender/amount/voided logic a third time.
//
// `checked`/`checkedAt`/`checkedBy` (this row's OWN audit state) and the
// depositApplied pairing's `receivedChecked` (the OTHER row's audit state)
// are DELIBERATELY NOT computed here — this module has zero knowledge of
// `payment_audits` (SQLite), mirroring deposit-register.ts's own strict
// separation from `deposit_notes`. server.ts merges both on, the same way
// it already merges `deposit_notes` onto deposit-register.ts's pure output.

import { RECONCILE_TOLERANCE_SATANG } from "../shared/bookings.ts";
import type { DepositTender, Property } from "../shared/types.ts";
import {
  DEPOSIT_APPLIED_PREFIX,
  DS_NAME_DEPOSIT_RECEIVED,
  DS_NAME_DEPOSIT_REFUND,
  LEDGER_DS_NAMES,
  bangkokDayWindow,
  buildGuestName,
  getPmsClient,
  parseAppliedBookingNo,
  parseLedgerSatang,
  pmsConfigured,
} from "./pms-prefill.ts";
import { classifyDepositRow, type DepositLedgerEvent, type RawDepositLedgerRow } from "./deposit-register.ts";

// ── the day-scoped query ──────────────────────────────────────────────────

// LEDGER_DS_NAMES (pms-prefill.ts) is [ค่าห้อง, จ่ายล่วงหน้า, ยกเลิกห้อง,
// คืนเงินส่วนเกิน, คืนเงินจองห้อง, ค่าปรับ] — the SIX exact labels; the seventh
// recognized shape is the ตัดยอดล่วงหน้า prefix family, ORed in separately
// below (mirrors DEPOSIT_LEDGER_QUERY's own inlined-literal style, never a
// bound array parameter — these are fixed compile-time Thai strings, not
// user input, so string-building the WHERE clause is exactly as safe as
// deposit-register.ts's own precedent and avoids depending on Bun.SQL's
// array-parameter binding, which this module has no live PMS connection to
// verify against).
const DAY_AUDIT_DS_NAME_CONDITIONS = LEDGER_DS_NAMES.map((name) => `l.ledger_ds_name = '${name}'`).join("\n      OR ");

/**
 * Day-scoped (via `bangkokDayWindow()`, same Bangkok-midnight window
 * pms-prefill.ts's own `LEDGER_QUERY` uses), restricted to the seven
 * recognized ds_name shapes this hub audits — unlike `LEDGER_QUERY`, which
 * returns every ds_name for the day and lets the pure mapper flag anything
 * unrecognized. Adds `ledger_free`/`ledger_note` to the SELECT list beyond
 * what this module strictly reads, purely so every row's shape matches
 * `RawDepositLedgerRow` exactly and can be handed straight to
 * `classifyDepositRow()` for the three ds_names it already knows.
 */
export const DAY_AUDIT_LEDGER_QUERY = `
  SELECT
    l.ledger_legacy_id,
    l.ledger_pay_no,
    l.ledger_cin_no,
    l.ledger_ds_name,
    l.ledger_pay_date,
    l.ledger_status,
    l.ledger_cash,
    l.ledger_credit,
    l.ledger_tran,
    l.ledger_web,
    l.ledger_amount,
    l.ledger_free,
    l.ledger_note,
    c.cust_title,
    c.cust_firstname,
    c.cust_lastname,
    c.cust_name2
  FROM ht_payment_ledger l
  LEFT JOIN ht_customers c
    ON l.ledger_cust_no = 'C' || c.legacy_id::text
    OR l.ledger_cust_no = c.legacy_id::text
  WHERE l.ledger_pay_date >= $1
    AND l.ledger_pay_date < $2
    AND l.ledger_status IS DISTINCT FROM 'ยกเลิก'
    AND (
      ${DAY_AUDIT_DS_NAME_CONDITIONS}
      OR l.ledger_ds_name LIKE '${DEPOSIT_APPLIED_PREFIX}%'
    )
  ORDER BY
    COALESCE(NULLIF(l.ledger_pay_no, ''), 'lid:' || l.ledger_legacy_id::text),
    l.ledger_legacy_id
`;

// The four ds_names DEPOSIT-REGISTER'S classifyDepositRow() does NOT know
// (it only recognizes จ่ายล่วงหน้า/คืนเงินจองห้อง/the ตัดยอด prefix) — declared
// as separate literals here rather than importing pms-prefill.ts's own
// private copies (they aren't exported, and even if they were, each module
// keeps its own literal by this codebase's established convention — see
// deposit-register.ts's DEPOSIT_R_NUMBER_RE doc comment for the same
// "never invert the natural dependency direction" reasoning).
const DS_NAME_ROOM_CHARGE = "ค่าห้อง";
const DS_NAME_ROOM_CANCEL = "ยกเลิกห้อง";
const DS_NAME_EXCESS_REFUND = "คืนเงินส่วนเกิน";
const DS_NAME_PENALTY = "ค่าปรับ";

/** COALESCE(NULLIF(pay_no, ''), 'lid:'||legacy_id) — same payment-grouping
 * key every sibling module (pms-prefill.ts, deposit-register.ts) computes;
 * kept as this module's OWN copy rather than imported (neither sibling
 * exports theirs). */
function paymentKey(row: RawDepositLedgerRow): string {
  const payNo = (row.ledger_pay_no ?? "").trim();
  return payNo !== "" ? payNo : `lid:${row.ledger_legacy_id}`;
}

const TENDER_COLUMNS: ReadonlyArray<{ tender: DepositTender; raw: keyof RawDepositLedgerRow }> = [
  { tender: "cash", raw: "ledger_cash" },
  { tender: "credit", raw: "ledger_credit" },
  { tender: "transfer", raw: "ledger_tran" },
  { tender: "web", raw: "ledger_web" },
];

/** The first non-zero raw tender column on a row — used only for a
 * `คืนเงินส่วนเกิน` (excess refund) row's own `tender` label, since that
 * ds_name is outside `classifyDepositRow()`'s vocabulary. Mirrors deposit-
 * register.ts's own private `dominantTender()` (not exported — this is this
 * module's own copy, same "never invert the dependency direction" reason). */
function dominantTenderRaw(row: RawDepositLedgerRow): DepositTender | null {
  for (const { tender, raw } of TENDER_COLUMNS) {
    if (parseLedgerSatang(row[raw] as string | null) !== 0) return tender;
  }
  return null;
}

function paymentDateBangkok(raw: string | Date | null | undefined): string | null {
  if (raw == null) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** SQL-escapes and quotes a list of plain-text values for an inlined `IN
 * (...)` clause — used for the two cross-history lookups below, whose
 * R-ref lists are runtime DATA (parsed off today's ตัดยอด/คืนเงินจองห้อง
 * lines), unlike `DAY_AUDIT_DS_NAME_CONDITIONS` above (a fixed compile-time
 * constant). Standard SQL single-quote doubling — safe for arbitrary text,
 * not just the `R\d{6}`-shaped refs expected in practice. Chosen over a
 * bound `= ANY($n::text[])` array parameter because this module has no live
 * PMS connection available to verify Bun.SQL's array-binding behavior
 * against (see fetchDayAudit's own doc comment on the ht_bookings lookup for
 * the same caution). */
function sqlStringList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
}

// ── the STAY-MERGED row model ──────────────────────────────────────────────

/** A stay's payment-method breakdown. `cashSatang`/`transferSatang`/
 * `creditSatang`/`webSatang` are TENDER totals (how the folio was PAID),
 * summed across however many receipts share this check-in, each read ONCE
 * per payment group (never per line — the tender-replication gotcha).
 * `penaltySatang` is a REVENUE-line breakdown instead (how much of
 * `grossSatang` came from a `ค่าปรับ` line) — an orthogonal axis, not a
 * fifth tender; do not sum all five fields expecting them to equal anything
 * in particular. */
export interface DayAuditComposition {
  cashSatang: number;
  transferSatang: number;
  creditSatang: number;
  webSatang: number;
  penaltySatang: number;
}

/** A เช็คอิน row's ตัดยอดมัดจำ chip — the deposit APPLIED against this stay,
 * paired with the R's own RECEIVED event across its whole history (never
 * just this day). `receivedAmountSatang`/`receivedPayNo`/`receivedTender`/
 * `receivedDateBangkok` are all `null` when the R has no ACTIVE (non-voided)
 * received event anywhere (the orphan-applied shape — the register's
 * `orphanApplied` exception already covers this globally); `mismatch` still
 * evaluates true in that case (`applied != 0`), same as the register's own
 * orphan-applied bucket effectively being a `received: 0` mismatch. */
export interface DayAuditDepositApplied {
  amountSatang: number;
  rRef: string;
  receivedDateBangkok: string | null;
  receivedPayNo: string | null;
  receivedTender: DepositTender | null;
  receivedAmountSatang: number | null;
  /** `|amountSatang - (receivedAmountSatang ?? 0)| > RECONCILE_TOLERANCE_SATANG`
   * — the row-level red-chip flag (owner ask: "amount mismatch (applied !=
   * received) -> flag on the row"). The register's own exception list
   * (`buildDepositExceptions`) already covers this globally across every
   * R-number; this is the SAME signal surfaced per-row for the office's
   * work queue. */
  mismatch: boolean;
}

/** One เช็คอิน row — a check-in's ค่าห้อง payment(s) and its (at most one)
 * ตัดยอดมัดจำ line merged, keyed by the CH number (never two rows for the
 * same stay, the "R014843 shape" the tests name this after). `auditKey`
 * equals `chRef` (kept as a separate field so every `DayAuditRow` variant
 * carries `auditKey` uniformly). */
export interface DayAuditCheckinRow {
  kind: "checkin";
  auditKey: string;
  chRef: string;
  guestName: string | null;
  /** Every distinct receipt (payment key) contributing a ค่าห้อง/ยกเลิกห้อง/
   * ค่าปรับ/ตัดยอด line to this check-in — usually one, more than one when
   * the room charge and its deposit application landed on separate
   * receipts. */
  receiptPayNos: string[];
  /** ค่าห้อง + ยกเลิกห้อง (forced negative) + ค่าปรับ, summed across every
   * contributing receipt — NEVER includes the ตัดยอด line's own amount
   * (V1: that money lives in `depositApplied`, not gross — the same
   * double-booking-bug fix pms-prefill.ts's own `grossRoomSatang` makes),
   * and never includes a คืนเงินส่วนเกิน line (that is its own `DayAuditRefundRow`
   * here, out of this stay's gross entirely). */
  grossSatang: number;
  composition: DayAuditComposition;
  /** `null` when this stay carries no ตัดยอดมัดจำ line at all (a plain cash-
   * on-arrival stay), or when its line's own R-ref label failed to parse
   * (the register's `unparsedAppliedRows` tripwire already covers that
   * globally — this hub simply omits the chip rather than guessing). */
  depositApplied: DayAuditDepositApplied | null;
}

/** One รับมัดจำ row — a จ่ายล่วงหน้า receipt received THIS day. `auditKey`
 * equals `payNo` (the receipt's own reference IS its settlement identity —
 * a received deposit has no CH yet). */
export interface DayAuditDepositRow {
  kind: "deposit";
  auditKey: string;
  rRef: string;
  guestName: string | null;
  payNo: string;
  tender: DepositTender | null;
  amountSatang: number;
  /** Best-effort forward reference to the eventual stay's check-in date,
   * via `ht_bookings` (see `fetchCheckinDateLookup`'s own doc comment for
   * why this is UNVERIFIED and degrades to `null` on any schema/grant
   * mismatch). Client renders the forward-check-in text itself when
   * present; `null` is a normal, expected value, not an error state. */
  checkinDateBangkok: string | null;
}

/** One คืนเงิน row (negative) — either a คืนเงินจองห้อง (a มัดจำล่วงหน้า
 * refunded, `refundOf: "deposit"`, `ref` = the R-number) or a คืนเงินส่วนเกิน
 * (a folio's excess-payment refund, `refundOf: "excess"`, `ref` = the CH
 * number when known, else its own `payNo`) — kept as ONE row kind with a
 * discriminant rather than two, since both render identically (negative
 * amount, guest, ref, tender) and only the ref's MEANING differs. */
export interface DayAuditRefundRow {
  kind: "refund";
  auditKey: string;
  refundOf: "deposit" | "excess";
  ref: string;
  guestName: string | null;
  payNo: string;
  tender: DepositTender | null;
  /** Always `<= 0` — the money leaving. */
  amountSatang: number;
  /** The R015832-shape warning (owner fix round, 2026-08-01, live มัดจำ
   * register, reused here as a CHEAP per-row signal): true when this
   * `refundOf: "deposit"` row's own R has AT LEAST ONE received event
   * anywhere in its history but NONE of them are active (every one is
   * voided) — the exact live shape where a cancelled receipt's refund line
   * stayed active, reversing the same money twice. Always `false` for
   * `refundOf: "excess"` (no R-number pairing applies) and for a
   * `refundOf: "deposit"` row whose R has NO received event at all (a
   * plain orphan refund — a different, rarer shape the register's own
   * `overRefunded` bucket still catches globally, just not flagged with
   * THIS specific wording here). This is a narrower, per-row-cheap proxy —
   * NOT a re-run of the register's full thread-level `refundedSatang >
   * receivedSatang` computation, which needs the R's applied history too. */
  overRefundedWarning: boolean;
}

export type DayAuditRow = DayAuditCheckinRow | DayAuditDepositRow | DayAuditRefundRow;

/**
 * True iff this settlement carries a nonzero TRANSFER component anywhere —
 * a เช็คอิน row's own transfer tender, or a รับมัดจำ/คืนเงิน row whose own
 * `tender` is `"transfer"`. Wave 2 (docs/plan-audit-hub-slips.md): "only
 * TRANSFER payments queue for slips (cash needs no slip; include transfer-
 * tendered รับมัดจำ and refunds)" — this is that predicate, exported so BOTH
 * src/server/server.ts (the ledger's own day-audit route, deciding which
 * auditKeys are even worth asking the slips service about) and
 * src/slips/queue.ts (ส่งสลิป's own queue filter) share ONE rule rather than
 * two copies that could drift — this file already owns the row shape both
 * sides read, so it is the natural home, not either caller. PURE.
 */
export function needsSlipProof(row: DayAuditRow): boolean {
  if (row.kind === "checkin") return row.composition.transferSatang !== 0;
  return row.tender === "transfer";
}

/** One booking-scope (ค่าห้อง/ยกเลิกห้อง/ค่าปรับ/ตัดยอด) payment group's
 * running aggregate, keyed by payment key while grouping, then re-grouped by
 * `cinNo` to build the merged เช็คอิน rows. Internal to `buildDayAuditRows`. */
interface BookingPaymentGroupAgg {
  pmsRef: string;
  cinNo: string | null;
  guestName: string | null;
  tenderRead: boolean;
  cashSatang: number;
  transferSatang: number;
  creditSatang: number;
  webSatang: number;
  roomSatang: number;
  cancelSatang: number;
  penaltySatang: number;
  appliedAmountSatang: number;
  appliedRRef: string | null;
  hasApplied: boolean;
}

/**
 * Builds the day's STAY-MERGED audit rows from the day-scoped query's rows
 * plus a cross-history received-event lookup (see `fetchReceivedLookup`) and
 * a best-effort check-in-date lookup (see `fetchCheckinDateLookup`) — PURE,
 * no I/O, both maps are plain data by the time this runs. Returns pending-
 * vs-checked-UNAWARE rows (this module has no knowledge of `payment_audits`
 * — see this file's own module doc comment) in a stable, deterministic order
 * (checkin rows by `chRef`, then deposit rows by `payNo`, then refund rows
 * by `payNo`) — server.ts merges checked state and re-sorts pending-first on
 * top of this.
 *
 * Re-asserts the voided filter `DAY_AUDIT_LEDGER_QUERY`'s WHERE already
 * applies (`activeRows`, below) — same fixture-provable defense-in-depth
 * pattern as pms-prefill.ts's `mapLedgerRows`/deposit-register.ts's
 * `classifyDepositRow` doc comments: a voided row must never produce a
 * เช็คอิน/รับมัดจำ/คืนเงิน row here at all (this is a work queue, not the
 * reconciliation — the register's own voided footnote already covers
 * completeness), and this makes that rule provable without a live database.
 */
export function buildDayAuditRows(
  rows: RawDepositLedgerRow[],
  receivedByRRef: ReadonlyMap<string, readonly DepositLedgerEvent[]>,
  checkinDateByRRef: ReadonlyMap<string, string>,
): DayAuditRow[] {
  const activeRows = rows.filter((row) => (row.ledger_status ?? null) !== "ยกเลิก");

  const groups = new Map<string, BookingPaymentGroupAgg>();
  const depositRows: DayAuditDepositRow[] = [];
  const refundRows: DayAuditRefundRow[] = [];

  for (const row of activeRows) {
    const dsName = (row.ledger_ds_name ?? "").trim();

    if (dsName === DS_NAME_DEPOSIT_RECEIVED) {
      const classified = classifyDepositRow(row);
      const rNumber = classified?.event.rNumber ?? null;
      if (!classified || rNumber === null) continue;
      const { event } = classified;
      depositRows.push({
        kind: "deposit",
        auditKey: event.pmsRef,
        rRef: rNumber,
        guestName: event.guestName,
        payNo: event.pmsRef,
        tender: event.tender,
        amountSatang: event.amountSatang,
        checkinDateBangkok: checkinDateByRRef.get(rNumber) ?? null,
      });
      continue;
    }

    if (dsName === DS_NAME_DEPOSIT_REFUND) {
      const classified = classifyDepositRow(row);
      const rNumber = classified?.event.rNumber ?? null;
      if (!classified || rNumber === null) continue;
      const { event } = classified;
      const lookup = receivedByRRef.get(rNumber) ?? [];
      const hasAnyReceived = lookup.length > 0;
      const hasActiveReceived = lookup.some((e) => !e.voided);
      refundRows.push({
        kind: "refund",
        auditKey: event.pmsRef,
        refundOf: "deposit",
        ref: rNumber,
        guestName: event.guestName,
        payNo: event.pmsRef,
        tender: event.tender,
        amountSatang: -event.amountSatang,
        overRefundedWarning: hasAnyReceived && !hasActiveReceived,
      });
      continue;
    }

    if (dsName === DS_NAME_EXCESS_REFUND) {
      const pmsRef = paymentKey(row);
      const chRef = (row.ledger_cin_no ?? "").trim() || null;
      refundRows.push({
        kind: "refund",
        auditKey: pmsRef,
        refundOf: "excess",
        ref: chRef ?? pmsRef,
        guestName: buildGuestName(row.cust_title, row.cust_firstname, row.cust_lastname, row.cust_name2),
        payNo: pmsRef,
        tender: dominantTenderRaw(row),
        amountSatang: -Math.abs(parseLedgerSatang(row.ledger_amount)),
        overRefundedWarning: false,
      });
      continue;
    }

    const isRoom = dsName === DS_NAME_ROOM_CHARGE;
    const isCancel = dsName === DS_NAME_ROOM_CANCEL;
    const isPenalty = dsName === DS_NAME_PENALTY;
    const isApplied = dsName.startsWith(DEPOSIT_APPLIED_PREFIX);
    if (!isRoom && !isCancel && !isPenalty && !isApplied) continue; // unrecognized ds_name — out of scope for this hub

    const pmsRef = paymentKey(row);
    let agg = groups.get(pmsRef);
    if (!agg) {
      agg = {
        pmsRef,
        cinNo: null,
        guestName: null,
        tenderRead: false,
        cashSatang: 0,
        transferSatang: 0,
        creditSatang: 0,
        webSatang: 0,
        roomSatang: 0,
        cancelSatang: 0,
        penaltySatang: 0,
        appliedAmountSatang: 0,
        appliedRRef: null,
        hasApplied: false,
      };
      groups.set(pmsRef, agg);
    }
    if (agg.cinNo === null) agg.cinNo = (row.ledger_cin_no ?? "").trim() || null;
    if (agg.guestName === null) {
      agg.guestName = buildGuestName(row.cust_title, row.cust_firstname, row.cust_lastname, row.cust_name2);
    }
    // Tender columns are REPLICATED across every line of a multi-line
    // receipt (pms-prefill.ts's module-level money gotcha) — read ONCE,
    // from the first line encountered for this payment group, never summed
    // per line.
    if (!agg.tenderRead) {
      agg.cashSatang = parseLedgerSatang(row.ledger_cash);
      agg.creditSatang = parseLedgerSatang(row.ledger_credit);
      agg.transferSatang = parseLedgerSatang(row.ledger_tran);
      agg.webSatang = parseLedgerSatang(row.ledger_web);
      agg.tenderRead = true;
    }
    if (isRoom) {
      agg.roomSatang += parseLedgerSatang(row.ledger_amount);
    } else if (isCancel) {
      // SIGN ANOMALY (same fix as pms-prefill.ts's buildBookingCandidate):
      // force negative regardless of the raw stored sign.
      agg.cancelSatang += -Math.abs(parseLedgerSatang(row.ledger_amount));
    } else if (isPenalty) {
      agg.penaltySatang += parseLedgerSatang(row.ledger_amount);
    } else if (isApplied && !agg.hasApplied) {
      const classified = classifyDepositRow(row);
      if (classified && classified.event.rNumber !== null) {
        agg.appliedAmountSatang = classified.event.amountSatang;
        agg.appliedRRef = classified.event.rNumber;
        agg.hasApplied = true;
      }
      // An unparseable applied R-ref (classified.event.rNumber === null) is
      // simply not adopted as this stay's depositApplied — the register's
      // own unparsedAppliedRows tripwire already covers that globally; this
      // hub just omits the chip rather than guessing.
    }
  }

  // Re-group the booking-scope payment aggregates by cinNo — the STAY
  // MERGE: a room charge and its deposit application sharing a CH but NOT a
  // payment key still land in ONE เช็คอิน row.
  const byCinNo = new Map<string, BookingPaymentGroupAgg[]>();
  for (const agg of groups.values()) {
    if (agg.cinNo === null) continue; // nothing to key a เช็คอิน row on
    const existing = byCinNo.get(agg.cinNo);
    if (existing) existing.push(agg);
    else byCinNo.set(agg.cinNo, [agg]);
  }

  const checkinRows: DayAuditCheckinRow[] = [];
  for (const [cinNo, aggs] of byCinNo) {
    const guestName = aggs.find((a) => a.guestName !== null)?.guestName ?? null;
    const receiptPayNos = aggs.map((a) => a.pmsRef);
    let grossSatang = 0;
    let cashSatang = 0;
    let transferSatang = 0;
    let creditSatang = 0;
    let webSatang = 0;
    let penaltySatang = 0;
    let appliedAgg: BookingPaymentGroupAgg | null = null;
    for (const agg of aggs) {
      grossSatang += agg.roomSatang + agg.cancelSatang + agg.penaltySatang;
      cashSatang += agg.cashSatang;
      transferSatang += agg.transferSatang;
      creditSatang += agg.creditSatang;
      webSatang += agg.webSatang;
      penaltySatang += agg.penaltySatang;
      if (agg.hasApplied && appliedAgg === null) appliedAgg = agg;
    }

    let depositApplied: DayAuditDepositApplied | null = null;
    if (appliedAgg !== null && appliedAgg.appliedRRef !== null) {
      const rRef = appliedAgg.appliedRRef;
      const lookup = receivedByRRef.get(rRef) ?? [];
      const active = lookup.filter((e) => !e.voided);
      const receivedAmountSatang = active.length > 0 ? active.reduce((sum, e) => sum + e.amountSatang, 0) : null;
      const canonical = active[0] ?? null;
      const appliedAmountSatang = appliedAgg.appliedAmountSatang;
      depositApplied = {
        amountSatang: appliedAmountSatang,
        rRef,
        receivedDateBangkok: canonical?.dateBangkok ?? null,
        receivedPayNo: canonical?.pmsRef ?? null,
        receivedTender: canonical?.tender ?? null,
        receivedAmountSatang,
        mismatch: Math.abs(appliedAmountSatang - (receivedAmountSatang ?? 0)) > RECONCILE_TOLERANCE_SATANG,
      };
    }

    checkinRows.push({
      kind: "checkin",
      auditKey: cinNo,
      chRef: cinNo,
      guestName,
      receiptPayNos,
      grossSatang,
      composition: { cashSatang, transferSatang, creditSatang, webSatang, penaltySatang },
      depositApplied,
    });
  }

  checkinRows.sort((a, b) => (a.chRef < b.chRef ? -1 : a.chRef > b.chRef ? 1 : 0));
  depositRows.sort((a, b) => (a.payNo < b.payNo ? -1 : a.payNo > b.payNo ? 1 : 0));
  refundRows.sort((a, b) => (a.payNo < b.payNo ? -1 : a.payNo > b.payNo ? 1 : 0));

  return [...checkinRows, ...depositRows, ...refundRows];
}

// ── network shim ────────────────────────────────────────────────────────

/**
 * Cross-history received-event lookup for the exact R-refs this day's rows
 * need pairing for (a ตัดยอด line's own parsed ref, or a คืนเงินจองห้อง row's
 * own R) — no date window (an R's deposit may have been received months
 * earlier), restricted to `ledger_ds_name = 'จ่ายล่วงหน้า'` only (this lookup
 * answers "what did this R receive", never "what happened to it later").
 * Reuses `classifyDepositRow()` on every returned row — the SAME shape/
 * columns as `DEPOSIT_LEDGER_QUERY` (deposit-register.ts) so pairing never
 * re-derives tender/amount/voided logic a third time. Voided rows are NOT
 * filtered out here (unlike the day-scoped query above) — a voided received
 * event is exactly the signal `overRefundedWarning` needs to see.
 */
async function fetchReceivedLookup(
  client: { unsafe: (query: string, params: unknown[]) => Promise<unknown> },
  rRefs: readonly string[],
): Promise<Map<string, DepositLedgerEvent[]>> {
  const map = new Map<string, DepositLedgerEvent[]>();
  if (rRefs.length === 0) return map;

  const query = `
    SELECT
      l.ledger_legacy_id,
      l.ledger_pay_no,
      l.ledger_cin_no,
      l.ledger_ds_name,
      l.ledger_pay_date,
      l.ledger_status,
      l.ledger_cash,
      l.ledger_credit,
      l.ledger_tran,
      l.ledger_web,
      l.ledger_amount,
      l.ledger_free,
      l.ledger_note,
      c.cust_title,
      c.cust_firstname,
      c.cust_lastname,
      c.cust_name2
    FROM ht_payment_ledger l
    LEFT JOIN ht_customers c
      ON l.ledger_cust_no = 'C' || c.legacy_id::text
      OR l.ledger_cust_no = c.legacy_id::text
    WHERE l.ledger_ds_name = '${DS_NAME_DEPOSIT_RECEIVED}'
      AND l.ledger_cin_no IN (${sqlStringList(rRefs)})
    ORDER BY l.ledger_pay_date, l.ledger_legacy_id
  `;
  const rows = (await client.unsafe(query, [])) as unknown as RawDepositLedgerRow[];
  for (const row of rows) {
    const classified = classifyDepositRow(row);
    if (!classified || classified.event.rNumber === null) continue;
    const rRef = classified.event.rNumber;
    const existing = map.get(rRef);
    if (existing) existing.push(classified.event);
    else map.set(rRef, [classified.event]);
  }
  return map;
}

/**
 * Best-effort forward-check-in-date lookup for a รับมัดจำ row (owner ask:
 * "the booking's check-in date if cheaply available from the mirror").
 *
 * UNVERIFIED SCHEMA/GRANT — this build has no live PMS connection to run the
 * `SET ROLE ledger_ro` probe the task calls for before trusting this join:
 * `ht_bookings.book_no` is ASSUMED (not confirmed against live evergreen
 * data) to hold the SAME R-number iHOTEL writes onto `ledger_cin_no` for a
 * จ่ายล่วงหน้า row (docs/adr/0001's "the booking is moved, never replaced"
 * implies `book_no` is the persistent booking identifier an R-number
 * names), and `ledger_ro` is ASSUMED to be granted SELECT on
 * `ht_bookings.book_no`/`book_checkin` at all. Wrapped in try/catch
 * SPECIFICALLY so a wrong column name or a missing grant degrades to
 * "omit the field" (every รับมัดจำ row's `checkinDateBangkok` stays `null`,
 * a normal value, never an error) rather than 502ing the whole endpoint —
 * this satisfies the task's own "if not granted, omit the field" instruction
 * by making that the code's actual runtime behavior, since a manual probe
 * could not be run here. MUST be verified against live evergreen data
 * (or this try/catch simply observed firing in production logs) before this
 * lookup is trusted to ever return anything.
 */
async function fetchCheckinDateLookup(
  client: { unsafe: (query: string, params: unknown[]) => Promise<unknown> },
  rRefs: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (rRefs.length === 0) return map;

  const query = `
    SELECT book_no, book_checkin
    FROM ht_bookings
    WHERE book_no IN (${sqlStringList(rRefs)})
  `;
  try {
    const rows = (await client.unsafe(query, [])) as unknown as Array<{
      book_no: string | null;
      book_checkin: string | Date | null;
    }>;
    for (const row of rows) {
      const ref = (row.book_no ?? "").trim();
      const dateBangkok = paymentDateBangkok(row.book_checkin);
      if (ref !== "" && dateBangkok !== null) map.set(ref, dateBangkok);
    }
  } catch (err) {
    console.warn(
      `day-audit: ht_bookings check-in lookup unavailable (unverified schema/grant — degrading to omitted field): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return map;
}

let fetchOverride: typeof fetchDayAudit | null = null;

/**
 * Fetches + builds one day's audit rows for a property. Consults the test
 * override first (`_internal.setFetchDayAuditForTests`, same pattern as
 * every sibling module). Otherwise requires `pmsConfigured` — the route
 * checks this itself before calling (503 without ever reaching here), so
 * this throw is a plain defensive backstop. A real PMS query failure
 * rejects and the caller (the route) turns that into a 502.
 */
export async function fetchDayAudit(property: Property, date: string): Promise<DayAuditRow[]> {
  if (fetchOverride) return fetchOverride(property, date);
  if (!pmsConfigured(property)) {
    throw new Error(`day-audit: property "${property}" is not configured`);
  }
  const { fromIso, toIso } = bangkokDayWindow(date);
  const client = getPmsClient(property);
  const rows = (await client.unsafe(DAY_AUDIT_LEDGER_QUERY, [fromIso, toIso])) as unknown as RawDepositLedgerRow[];

  // Gather every R-ref this day's rows need cross-history pairing for: a
  // ตัดยอด line's own parsed ref (depositApplied pairing), and a
  // คืนเงินจองห้อง row's own ledger_cin_no (the overRefundedWarning check).
  const rRefs = new Set<string>();
  for (const row of rows) {
    const dsName = (row.ledger_ds_name ?? "").trim();
    if (dsName.startsWith(DEPOSIT_APPLIED_PREFIX)) {
      const parsed = parseAppliedBookingNo(dsName);
      if (parsed) rRefs.add(parsed);
    } else if (dsName === DS_NAME_DEPOSIT_REFUND) {
      const ref = (row.ledger_cin_no ?? "").trim();
      if (ref !== "") rRefs.add(ref);
    }
  }
  const rRefList = [...rRefs];

  const [receivedByRRef, checkinDateByRRef] = await Promise.all([
    fetchReceivedLookup(client, rRefList),
    fetchCheckinDateLookup(client, rRefList),
  ]);

  return buildDayAuditRows(rows, receivedByRRef, checkinDateByRRef);
}

// Test-only handle — same shape as every sibling module's `_internal`.
export const _internal = {
  setFetchDayAuditForTests(fn: typeof fetchDayAudit | null): void {
    fetchOverride = fn;
  },
};
