// The office deposit register (Wave D, issue #5 / the R015834-style
// reconciliation requirement — docs/adr/0001, the "make-a-plan-to-cryptic-
// comet" plan's Wave D section). Mirrors pms-prefill.ts's shape exactly:
// pure mapping fns + a thin network shim + an `_internal` test override.
// This is a SEPARATE, direct-to-PMS code path that does NOT depend on Wave
// C's importer or the accrual cutover — it exists so the office can see a
// deposit's FULL lifecycle (received -> applied/refunded) across its whole
// history, which the day-scoped, opt-in `pull-from-pms` imports can never
// show on their own.
//
// REUSE, never a second connection pool: `getPmsClient()` (pms-prefill.ts)
// shares that module's per-property client cache — the plan's open item on
// this point is resolved in favor of sharing, since both modules query the
// exact same PMS Postgres database, just with different SQL.
//
// ENV read lazily via `pmsConfigured()`/`getPmsClient()` (pms-prefill.ts) —
// same lesson as analytics-push.ts/pms-prefill.ts: never capture env at
// import time.

import type { Property } from "../shared/types.ts";
import { RECONCILE_TOLERANCE_SATANG } from "../shared/bookings.ts";
import {
  DEPOSIT_APPLIED_PREFIX,
  DS_NAME_DEPOSIT_RECEIVED,
  DS_NAME_DEPOSIT_REFUND,
  getPmsClient,
  parseAppliedBookingNo,
  parseLedgerSatang,
  pmsConfigured,
} from "./pms-prefill.ts";

/**
 * One raw `ht_payment_ledger` row from the three deposit-lifecycle ds_names
 * only (see `DEPOSIT_LEDGER_QUERY`'s WHERE). Deliberately narrower than
 * pms-prefill.ts's `RawLedgerRow` — no customer join (guest name is not
 * part of this register per the plan), no `ledger_ds_label`/`ledger_ds_id`
 * (never read here). `ledger_pay_date` is typed defensively as
 * `string | Date` — Bun's Postgres driver's exact return shape for a
 * TIMESTAMP column selected for the first time in this codebase is
 * unverified, so `paymentDateBangkok()` below accepts either.
 */
export interface RawDepositLedgerRow {
  ledger_legacy_id: number | string;
  ledger_pay_no: string | null;
  ledger_cin_no: string | null;
  ledger_ds_name: string | null;
  ledger_pay_date: string | Date | null;
  ledger_status: string | null;
  ledger_cash: string | null;
  ledger_credit: string | null;
  ledger_tran: string | null;
  ledger_web: string | null;
  ledger_amount: string | null;
  ledger_free: string | null;
  ledger_note: string | null;
}

/**
 * Full deposit-lifecycle history, no date window (unlike pms-prefill.ts's
 * `LEDGER_QUERY`, which is day-scoped) — the register must be able to
 * answer "is this R-number's deposit still outstanding" regardless of when
 * it was received. Exactly the three deposit-lifecycle ds_names (D1):
 * `จ่ายล่วงหน้า` (received, exact), the ตัดยอดล่วงหน้า prefix family
 * (applied), `คืนเงินจองห้อง` (refunded, exact). Voided rows are NOT
 * filtered out here (unlike `LEDGER_QUERY`) — they are RETURNED, tagged via
 * `ledger_status`, so the pure layer can show them (greyed, excluded from
 * every sum) rather than making them invisible. `ledger_amount` is selected
 * for completeness/future tripwires (mirrors `RawLedgerRow`'s full column
 * set) even though today's classification reads only `ledger_free` for an
 * applied line's amount (same V1 rule as pms-prefill.ts).
 */
export const DEPOSIT_LEDGER_QUERY = `
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
    l.ledger_note
  FROM ht_payment_ledger l
  WHERE l.ledger_ds_name = '${DS_NAME_DEPOSIT_RECEIVED}'
     OR l.ledger_ds_name = '${DS_NAME_DEPOSIT_REFUND}'
     OR l.ledger_ds_name LIKE '${DEPOSIT_APPLIED_PREFIX}%'
  ORDER BY l.ledger_pay_date, l.ledger_legacy_id
`;

export type DepositLedgerEventKind = "received" | "applied" | "refunded";

/** iHOTEL's R-number shape — a fixed "R" followed by 6 digits, identical
 * across both properties (C0-verified). Exported for `server.ts`'s
 * `:rNumber` path-param validation on the note endpoints (`PUT`/`DELETE
 * .../deposits/:rNumber/note`) so the route-level bound and this module's
 * own vocabulary can never drift apart. Deliberately a SEPARATE literal
 * from pms-prefill.ts's own `APPLIED_R_NUMBER_RE` (same pattern, not the
 * same object) — importing from pms-prefill.ts here is fine, but the
 * reverse would invert this module's natural dependency direction. */
export const DEPOSIT_R_NUMBER_RE = /^R\d{6}$/;

/** One classified deposit-lifecycle moment, independent of which raw
 * ledger row(s) produced it. `amountSatang` is always a `>0` magnitude
 * (`kind` carries the sign/meaning), mirroring `DepositEvent`. `rNumber` is
 * `null` only for an applied row whose label didn't parse (see
 * `classifyDepositRow`) — such an event is still returned, just excluded
 * from `buildDepositThreads`' grouping (nothing to group it BY), and
 * counted via the caller's `unparsedAppliedRows` tripwire. */
export interface DepositLedgerEvent {
  legacyId: number | string;
  pmsRef: string;
  kind: DepositLedgerEventKind;
  rNumber: string | null;
  /** Bangkok calendar date ("YYYY-MM-DD") the payment was recorded, or
   * `null` if `ledger_pay_date` failed to parse (never expected in
   * practice — defensive only). */
  dateBangkok: string | null;
  amountSatang: number;
  /** `true` for `ledger_status = 'ยกเลิก'` — excluded from every sum in
   * `buildDepositThreads`/`buildMonthlyReconciliation`, but never dropped:
   * present in `DepositThread.events` for display. */
  voided: boolean;
}

/** COALESCE(NULLIF(pay_no, ''), 'lid:'||legacy_id) — same payment-grouping
 * key pms-prefill.ts uses, carried here purely for traceability (this
 * module never groups BY it — that's pms-prefill.ts's job — it only
 * carries it through onto `DepositLedgerEvent.pmsRef` for reference). */
function paymentKey(row: RawDepositLedgerRow): string {
  const payNo = (row.ledger_pay_no ?? "").trim();
  return payNo !== "" ? payNo : `lid:${row.ledger_legacy_id}`;
}

/**
 * Normalizes `ledger_pay_date` to a Bangkok calendar date string, the same
 * `Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", ... })`
 * formatter `todayBangkok()` (shared/date.ts) uses, applied to an arbitrary
 * instant rather than "now". Accepts either a JS `Date` (the likely shape
 * for a Postgres TIMESTAMP column) or a string (defensive — same driver-
 * uncertainty reasoning as `RawDepositLedgerRow`'s field typing). `null` for
 * a missing or unparseable value.
 */
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

/** Sums the four raw tender columns (cash/credit/tran/web) — a
 * received/refunded deposit row is a SINGLE-LINE group with exactly one
 * non-zero column in practice (C0-verified), so summing is equivalent to
 * "the one populated column" without needing to know which. A refund row
 * carries its tender as a NEGATIVE value in the same column the deposit
 * used (C0's "refund column" finding) — `Math.abs` in `classifyDepositRow`
 * recovers the magnitude every `DepositLedgerEvent` carries. */
function sumTenderColumns(row: RawDepositLedgerRow): number {
  return (
    parseLedgerSatang(row.ledger_cash) +
    parseLedgerSatang(row.ledger_credit) +
    parseLedgerSatang(row.ledger_tran) +
    parseLedgerSatang(row.ledger_web)
  );
}

/** One classified row, plus tripwires the caller (`buildDepositRegisterData`)
 * turns into counters. `unparsedAppliedBookingNo` — an applied row whose
 * R-number failed to parse. `zeroTenderRow` (review fix, money-tripwire
 * gap (a)) — a received/refunded row whose four tender columns summed to
 * ZERO despite a nonzero `ledger_amount`: money exists on the row that this
 * classifier isn't capturing into `amountSatang`. `ledger_amount` is
 * selected "for completeness/future tripwires" (see `DEPOSIT_LEDGER_QUERY`'s
 * doc comment) — this is that future. */
export interface ClassifiedDepositRow {
  event: DepositLedgerEvent;
  unparsedAppliedBookingNo: boolean;
  zeroTenderRow: boolean;
}

/**
 * Classifies ONE raw ledger row into a `DepositLedgerEvent`. PURE — no I/O.
 * Re-asserts the ds_name filter `DEPOSIT_LEDGER_QUERY`'s WHERE already
 * applies (same fixture-provable defense-in-depth pattern as
 * pms-prefill.ts's `mapLedgerRows`): returns `null` for a row matching none
 * of the three known shapes, which should never happen against the real
 * query but must never crash if it somehow does.
 *
 * received/refunded: single-line groups (C0-verified) — the amount is the
 * abs of the summed tender columns (`sumTenderColumns`), and the R-number
 * comes from `ledger_cin_no` (trimmed, `null` if blank) — NEVER regex-
 * validated against `R\d{6}` here, mirroring pms-prefill.ts's
 * `buildDepositCandidates`, which reads the SAME column the SAME way
 * without validation (C0 verified it always holds the plain R-number for
 * these two ds_names in practice). A blank `ledger_cin_no` is NOT flagged
 * via `unparsedAppliedBookingNo` (that field is applied-row-only by name and
 * by contract) — the caller (`buildDepositRegisterData`) derives its own
 * `blankBookingNoRows` tripwire directly from `event.kind !== "applied" &&
 * event.rNumber === null`, since both pieces of information (`kind`,
 * `rNumber`) already live on the returned event with nothing extra needed
 * here. `zeroTenderRow` flags the money-tripwire gap: all four tender
 * columns zero (so `amountSatang` is 0) while `ledger_amount` is nonzero —
 * never invented into a figure, only flagged.
 *
 * applied: the amount lives in `ledger_free` (V1, same rule pms-prefill.ts
 * uses — NEVER `ledger_amount`, which on this SAME line equals the same
 * figure but is not read here since nothing in this register ever needs a
 * "gross" total). The R-number is parsed from the ds_name's own
 * system-templated suffix via `parseAppliedBookingNo` (shared with
 * pms-prefill.ts) — `null` when unparseable, flagged via
 * `unparsedAppliedBookingNo` (never dropped: the event itself is still
 * returned with `rNumber: null`, simply excluded from `buildDepositThreads`'
 * grouping since there is nothing to group it by). `zeroTenderRow` is always
 * `false` here — that tripwire is scoped to received/refunded rows only
 * (an applied row's money lives in `ledger_free`, not the tender columns).
 */
export function classifyDepositRow(row: RawDepositLedgerRow): ClassifiedDepositRow | null {
  const dsName = (row.ledger_ds_name ?? "").trim();
  const voided = (row.ledger_status ?? null) === "ยกเลิก";
  const dateBangkok = paymentDateBangkok(row.ledger_pay_date);
  const pmsRef = paymentKey(row);

  if (dsName === DS_NAME_DEPOSIT_RECEIVED || dsName === DS_NAME_DEPOSIT_REFUND) {
    const kind: DepositLedgerEventKind = dsName === DS_NAME_DEPOSIT_REFUND ? "refunded" : "received";
    const rNumber = (row.ledger_cin_no ?? "").trim() || null;
    const amountSatang = Math.abs(sumTenderColumns(row));
    const zeroTenderRow = amountSatang === 0 && parseLedgerSatang(row.ledger_amount) !== 0;
    return {
      event: { legacyId: row.ledger_legacy_id, pmsRef, kind, rNumber, dateBangkok, amountSatang, voided },
      unparsedAppliedBookingNo: false,
      zeroTenderRow,
    };
  }

  if (dsName.startsWith(DEPOSIT_APPLIED_PREFIX)) {
    const rNumber = parseAppliedBookingNo(dsName);
    const amountSatang = Math.abs(parseLedgerSatang(row.ledger_free));
    return {
      event: { legacyId: row.ledger_legacy_id, pmsRef, kind: "applied", rNumber, dateBangkok, amountSatang, voided },
      unparsedAppliedBookingNo: rNumber === null,
      zeroTenderRow: false,
    };
  }

  return null;
}

/** One R-number's whole deposit thread — an R-number pairs with its
 * deposit for life (docs/adr/0001: the booking is moved, never replaced),
 * so grouping by it is exact, never a free-text join. `receivedSatang`/
 * `appliedSatang`/`refundedSatang` EXCLUDE voided events; `outstandingSatang
 * = received - applied - refunded` can legitimately go negative (the
 * R015834 case: applied > received) — that is exactly what flags it as a
 * `mismatched` exception rather than aging (see `buildDepositExceptions`).
 * `firstEventDate` is the earliest ACTIVE (non-voided) event's date across
 * the whole thread, regardless of kind — the aging list's "oldest first"
 * anchor. `events` carries EVERY event for this R-number, voided included,
 * for display (never excluded from the array itself, only from the sums). */
export interface DepositThread {
  rNumber: string;
  receivedSatang: number;
  appliedSatang: number;
  refundedSatang: number;
  outstandingSatang: number;
  firstEventDate: string | null;
  events: DepositLedgerEvent[];
}

/**
 * Groups classified events by R-number into `DepositThread`s. Events with
 * `rNumber === null` (an unparseable applied label, or — never expected in
 * practice — a received/refunded row with a blank `ledger_cin_no`) are
 * excluded from every thread: there is nothing to group them by. They still
 * count toward `buildMonthlyReconciliation` (which needs no R-number),
 * and toward the caller's `unparsedAppliedRows` tripwire — never silently
 * vanish from money, only from this particular per-deposit view.
 */
export function buildDepositThreads(events: DepositLedgerEvent[]): DepositThread[] {
  const byR = new Map<string, DepositLedgerEvent[]>();
  for (const event of events) {
    if (event.rNumber === null) continue;
    const existing = byR.get(event.rNumber);
    if (existing) existing.push(event);
    else byR.set(event.rNumber, [event]);
  }

  const threads: DepositThread[] = [];
  for (const [rNumber, threadEvents] of byR) {
    let receivedSatang = 0;
    let appliedSatang = 0;
    let refundedSatang = 0;
    let firstEventDate: string | null = null;

    for (const event of threadEvents) {
      if (event.voided) continue;
      if (event.kind === "received") receivedSatang += event.amountSatang;
      else if (event.kind === "applied") appliedSatang += event.amountSatang;
      else refundedSatang += event.amountSatang;

      if (event.dateBangkok !== null && (firstEventDate === null || event.dateBangkok < firstEventDate)) {
        firstEventDate = event.dateBangkok;
      }
    }

    threads.push({
      rNumber,
      receivedSatang,
      appliedSatang,
      refundedSatang,
      outstandingSatang: receivedSatang - appliedSatang - refundedSatang,
      firstEventDate,
      events: threadEvents,
    });
  }

  threads.sort((a, b) => (a.rNumber < b.rNumber ? -1 : a.rNumber > b.rNumber ? 1 : 0));
  return threads;
}

/** One month's reconciliation row: `openingSatang` (= the PRIOR month's
 * `closingSatang`; `0` for the very first month with any activity —
 * OWNER-DECIDED, plan D-open-items: pre-feature มัดจำ history is out of
 * scope and the register states its own start date honestly rather than
 * pretending to know an opening balance it can't verify) through
 * `closingSatang = opening + received - applied - refunded`. */
export interface MonthlyDepositReconciliation {
  /** Bangkok "YYYY-MM". */
  month: string;
  openingSatang: number;
  receivedSatang: number;
  appliedSatang: number;
  refundedSatang: number;
  closingSatang: number;
}

/**
 * Builds the monthly opening/closing reconciliation, independent of R-number
 * pairing (unlike `buildDepositThreads`) — this answers "how much deposit
 * money is the estate holding in total", not "which specific deposit". Only
 * months with at least one ACTIVE (non-voided) event appear — this is the
 * property's own "Bangkok months" set, not a filled calendar range; skipping
 * a zero-activity month never breaks the opening/closing chain, since the
 * next month-with-data's opening is still exactly the prior data-month's
 * closing regardless of how many empty months sit between them. Returned in
 * CHRONOLOGICAL (ascending) order — reversing for "newest first" display is
 * the client's job (see api.md / DepositRegisterPage.tsx).
 */
export function buildMonthlyReconciliation(events: DepositLedgerEvent[]): MonthlyDepositReconciliation[] {
  const byMonth = new Map<string, { received: number; applied: number; refunded: number }>();
  for (const event of events) {
    if (event.voided || event.dateBangkok === null) continue;
    const month = event.dateBangkok.slice(0, 7);
    const bucket = byMonth.get(month) ?? { received: 0, applied: 0, refunded: 0 };
    if (event.kind === "received") bucket.received += event.amountSatang;
    else if (event.kind === "applied") bucket.applied += event.amountSatang;
    else bucket.refunded += event.amountSatang;
    byMonth.set(month, bucket);
  }

  const months = [...byMonth.keys()].sort();
  let openingSatang = 0;
  const out: MonthlyDepositReconciliation[] = [];
  for (const month of months) {
    const { received, applied, refunded } = byMonth.get(month)!;
    const closingSatang = openingSatang + received - applied - refunded;
    out.push({ month, openingSatang, receivedSatang: received, appliedSatang: applied, refundedSatang: refunded, closingSatang });
    openingSatang = closingSatang;
  }
  return out;
}

/** A thread flagged `mismatched` — `received > 0 && applied > 0 &&
 * |applied - received| > RECONCILE_TOLERANCE_SATANG`. `diffSatang =
 * applied - received` (never abs'd — the sign says which direction the gap
 * runs). The proven live case: R015834 received 39_500 satang (395.00),
 * applied 79_000 satang (790.00) -> `diffSatang: 39_500`. */
export interface MismatchedDepositException {
  rNumber: string;
  receivedSatang: number;
  appliedSatang: number;
  diffSatang: number;
}

/** A thread flagged `orphanApplied` — money was applied against an
 * R-number with NO recorded receipt at all (`applied > 0 && received ===
 * 0`) — distinct from `mismatched` (which requires SOME receipt to compare
 * against). */
export interface OrphanAppliedDepositException {
  rNumber: string;
  appliedSatang: number;
}

export interface DepositExceptions {
  mismatched: MismatchedDepositException[];
  orphanApplied: OrphanAppliedDepositException[];
}

/**
 * Classifies every thread into the two exception buckets. Runs over ALL
 * threads (not just the aging-filtered outstanding>0 subset, which the
 * endpoint computes separately) — a `mismatched` thread commonly has
 * applied > received, which makes `outstandingSatang` NEGATIVE and so it
 * never appears in the aging list; a thread can therefore be an exception
 * without ever being "outstanding" in the aging sense. Deliberately does
 * NOT special-case "applied is anomalously small vs. anomalously large" —
 * both directions trip the same `|diff| > tolerance` rule, per the plan.
 */
export function buildDepositExceptions(threads: DepositThread[]): DepositExceptions {
  const mismatched: MismatchedDepositException[] = [];
  const orphanApplied: OrphanAppliedDepositException[] = [];

  for (const thread of threads) {
    const { rNumber, receivedSatang, appliedSatang } = thread;
    if (receivedSatang > 0 && appliedSatang > 0) {
      const diffSatang = appliedSatang - receivedSatang;
      if (Math.abs(diffSatang) > RECONCILE_TOLERANCE_SATANG) {
        mismatched.push({ rNumber, receivedSatang, appliedSatang, diffSatang });
      }
    } else if (appliedSatang > 0 && receivedSatang === 0) {
      orphanApplied.push({ rNumber, appliedSatang });
    }
  }

  return { mismatched, orphanApplied };
}

/** One voided event, for the register page's collapsed "ไม่รวมในยอดข้างต้น"
 * footnote (D4) — never included in any sum above, but never hidden from
 * view either. `rNumber` is nullable (review fix): a voided row can itself
 * be one with an unparseable/blank R-number, which never joins ANY thread
 * (see `buildDepositThreads`) — the footnote must still be able to show it,
 * rather than silently losing exactly the rows most worth a second look. */
export interface VoidedDepositEventSummary {
  rNumber: string | null;
  kind: DepositLedgerEventKind;
  amountSatang: number;
  dateBangkok: string | null;
}

/**
 * Flattens every voided event straight out of the classified EVENT list —
 * review fix: this used to walk `DepositThread[]`, which silently dropped a
 * voided event whose `rNumber` was `null` (unparseable applied label, or a
 * blank `ledger_cin_no`), since `buildDepositThreads` never groups such an
 * event into any thread at all. Walking events directly means the footnote
 * is complete regardless of whether an event could be threaded.
 */
export function collectVoidedEvents(events: DepositLedgerEvent[]): VoidedDepositEventSummary[] {
  return events
    .filter((event) => event.voided)
    .map((event) => ({
      rNumber: event.rNumber,
      kind: event.kind,
      amountSatang: event.amountSatang,
      dateBangkok: event.dateBangkok,
    }));
}

/**
 * The full classified register, PURE (no I/O) — the row-level counterpart
 * of pms-prefill.ts's `mapLedgerRows`. Four tripwire counters, none of which
 * ever invent or drop money — each just names a way a row can otherwise
 * leave with zero signal:
 *
 * - `unparsedAppliedRows` (D1): an applied row whose R-number failed to
 *   parse — still classified and counted in `monthly`, excluded from
 *   `threads` (nothing to group it by).
 * - `zeroTenderRows` (review fix, gap (a)): a received/refunded row whose
 *   four tender columns summed to zero despite a nonzero `ledger_amount` —
 *   `amountSatang` is 0, so the row's money is effectively invisible
 *   everywhere downstream unless a human goes and looks at the folio.
 * - `blankBookingNoRows` (review fix, gap (b)): a received/refunded row
 *   with a blank `ledger_cin_no` — `rNumber: null`, so the event can never
 *   join a thread (no aging row, no exception, no note ever sees it), even
 *   though it still fully participates in `monthly`.
 * - `undatedRows` (review fix, gap (c)): an event whose `ledger_pay_date`
 *   failed to parse — dropped from `monthly` (which needs a month to bucket
 *   by) while still fully counted in whichever thread it belongs to.
 *
 * `voided` is computed here too (via `collectVoidedEvents`) so the caller
 * never has to re-derive it from `threads` — see that function's own doc
 * comment for why walking the flat `events` list (not `threads`) is the fix
 * that makes the voided footnote complete.
 */
export interface DepositRegisterData {
  threads: DepositThread[];
  monthly: MonthlyDepositReconciliation[];
  unparsedAppliedRows: number;
  zeroTenderRows: number;
  blankBookingNoRows: number;
  undatedRows: number;
  voided: VoidedDepositEventSummary[];
}

export function buildDepositRegisterData(rows: RawDepositLedgerRow[]): DepositRegisterData {
  const events: DepositLedgerEvent[] = [];
  let unparsedAppliedRows = 0;
  let zeroTenderRows = 0;
  let blankBookingNoRows = 0;
  let undatedRows = 0;

  for (const row of rows) {
    const classified = classifyDepositRow(row);
    if (!classified) continue; // defensive — the SQL WHERE already restricts to the 3 known shapes
    const { event, unparsedAppliedBookingNo, zeroTenderRow } = classified;
    events.push(event);
    if (unparsedAppliedBookingNo) unparsedAppliedRows += 1;
    if (zeroTenderRow) zeroTenderRows += 1;
    if (event.kind !== "applied" && event.rNumber === null) blankBookingNoRows += 1;
    if (event.dateBangkok === null) undatedRows += 1;
  }

  return {
    threads: buildDepositThreads(events),
    monthly: buildMonthlyReconciliation(events),
    unparsedAppliedRows,
    zeroTenderRows,
    blankBookingNoRows,
    undatedRows,
    voided: collectVoidedEvents(events),
  };
}

let fetchOverride: typeof fetchDepositRegister | null = null;

/**
 * Fetches + classifies the FULL deposit-lifecycle history for a property.
 * Consults the test override first (`_internal.setFetchDepositRegisterForTests`,
 * same pattern as pms-prefill.ts/analytics-push.ts). Otherwise requires
 * `pmsConfigured` — the route checks this itself before calling (503
 * without ever reaching here), so this throw is a plain defensive backstop.
 * A real PMS query failure rejects and the caller (the route) turns that
 * into a 502 with no partial data returned.
 */
export async function fetchDepositRegister(property: Property): Promise<DepositRegisterData> {
  if (fetchOverride) return fetchOverride(property);
  if (!pmsConfigured(property)) {
    throw new Error(`deposit-register: property "${property}" is not configured`);
  }
  const client = getPmsClient(property);
  const rows = (await client.unsafe(DEPOSIT_LEDGER_QUERY, [])) as unknown as RawDepositLedgerRow[];
  return buildDepositRegisterData(rows);
}

// Test-only handle — same shape as pms-prefill.ts's `_internal`.
export const _internal = {
  setFetchDepositRegisterForTests(fn: typeof fetchDepositRegister | null): void {
    fetchOverride = fn;
  },
};
