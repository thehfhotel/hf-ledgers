// ดึงข้อมูล — pulls a day's payments from the PMS payment ledger
// (`ht_payment_ledger`, one Postgres database per property) into
// `PrefillCandidate`s (booking-sheet rows) and `DepositCandidate`s
// (มัดจำล่วงหน้า received/refunded moments — Wave C, docs/adr/0001). See
// docs/pms-prefill-plan.md for the original Wave 3 design and the plan doc
// at .claude/plans (section C0-C3) for the Wave C rewrite this module now
// implements; this module owns everything PURE (day-window math, the
// row->candidate mapping) plus the thin network shim that fetches raw rows.
//
// THE MONEY GOTCHA this module exists to fix (unchanged since Wave 3):
// iHOTEL replicates the whole tender split (cash/credit/tran/web) onto
// EVERY line of a multi-line receipt. Summing tenders raw across lines
// inflates money (a verified real case differed by 57%). mapLedgerRows()
// takes each raw tender value ONCE per payment — from the first line
// encountered for that payment key — never summed across lines. Line
// amounts (`ledger_amount`) are genuinely itemized per line and ARE summed
// raw, EXCEPT for the ตัดยอดล่วงหน้า line's own amount, which is excluded
// from gross entirely (see the classification section below — this is the
// Wave C fix for a second, distinct money bug).
//
// CLASSIFICATION IS BY ds_name, NEVER ds_id (C0 gate, verified 2026-07-31):
// `ds_id` is secondary/log-only. `ledger_free` is NOT deposit-exclusive — a
// ค่าห้อง line can carry a genuine discount/comp in it (~69,000 THB across
// both properties) — so keying anything on "free != 0" would invent
// revenue; only a line whose `ds_name` IS the ตัดยอดล่วงหน้า label ever has
// its `ledger_free` read as an applied-deposit amount.
//
// ENV read LAZILY (call-time), never at module load — same lesson as
// analytics-push.ts: bun test runs every file in one process, so capturing
// env at import time freezes the enabled/configured state for whichever
// test file happens to import first, and file discovery order differs
// between filesystems (passed locally, failed in CI once already for that
// exact reason). pmsConfigured() and fetchDayPayments() both re-read
// process.env on every call.

import { SQL } from "bun";
import { parseAmountToSatang } from "../shared/money.ts";
import type { DepositEventKind, DepositTender, Property } from "../shared/types.ts";

/** One row inserted onto the bookings sheet, derived from one PMS payment
 * (all lines sharing the same receipt/pay number, or the same ledger row
 * when the receipt number is blank). See docs/pms-prefill-plan.md and the
 * plan's C3 section for the Wave C reshaping. */
export interface PrefillCandidate {
  pmsRef: string;
  bookingNo: string | null;
  guestName: string | null;
  roomNo: string | null;
  roomCount: number | null;
  nights: number | null;
  grossRoomSatang: number;
  grossOtherSatang: number;
  cashSatang: number;
  webSatang: number;
  unplacedCreditSatang: number;
  unplacedTranSatang: number;
  /** Wave C: the ตัดยอดมัดจำ tender's amount, read from the ตัดยอดล่วงหน้า
   * line's `ledger_free` (V1) — NEVER from `ledger_amount`, which on that
   * SAME line equals the same figure but must never additionally reach
   * `grossRoomSatang` (the live double-booking bug this rewrite fixes).
   * `0` when the payment carries no ตัดยอดล่วงหน้า line. */
  appliedDepositSatang: number;
  /** The R-number(s) parsed from each ตัดยอดล่วงหน้า line's own
   * system-templated label ("ตัดยอดล่วงหน้า Booking No:R014843") — NEVER
   * from `ledger_cin_no`, which holds the CH-number on this scope of line.
   * Usually one entry; `insertPmsBookingLines` (db.ts) folds these into the
   * inserted row's `remark` so the office can trace which deposit(s) the
   * applied amount came from. Empty when the payment carries no
   * (parseable) ตัดยอดล่วงหน้า line. */
  appliedDepositBookingNos: string[];
  isRefund: boolean;
}

/**
 * One received-or-refunded มัดจำล่วงหน้า moment derived from an R-scoped PMS
 * payment (Wave C) — feeds `insertPmsDepositEvents()` (db.ts), which turns
 * it into a `deposit_events` row. `amountSatang` is always a `>0`
 * magnitude; `kind` carries the sign, mirroring `DepositEvent` itself
 * (shared/types.ts).
 */
export interface DepositCandidate {
  pmsRef: string;
  kind: DepositEventKind;
  bookingNo: string | null;
  guestName: string | null;
  tender: DepositTender;
  amountSatang: number;
  note: string | null;
}

/** One flagged-but-unbooked oddity from a pull — never money, always
 * reported back to the caller (`server.ts`'s pull-from-pms response) for a
 * human to look at. `reason` is a stable code:
 * - `mixed_scope`: a single PMS payment mixed an R-scoped deposit-lifecycle
 *   line (จ่ายล่วงหน้า/ตัดยอดล่วงหน้า/คืนเงินจองห้อง) with a CH-scoped
 *   booking-charge line (ค่าห้อง/ยกเลิกห้อง/คืนเงินส่วนเกิน/ค่าปรับ) — C0's
 *   V3 gate found zero of these live, so this is a pure safety net; the
 *   whole group is dropped (neither a PrefillCandidate nor a
 *   DepositCandidate is emitted for it).
 * - `unknown_ds_name`: a line whose `ds_name` matches none of the six known
 *   labels nor the ตัดยอดล่วงหน้า prefix — its `ledger_amount` never reaches
 *   any figure, so money is never invented from an unrecognized label.
 * - `free_without_applied`: a booking-scope line OTHER than ค่าห้อง (i.e.
 *   ยกเลิกห้อง/คืนเงินส่วนเกิน/ค่าปรับ — ค่าห้อง's own `ledger_free` is a
 *   known, expected discount/comp per V2 and never flagged) carries a
 *   nonzero `ledger_free` while the group has no ตัดยอดล่วงหน้า line to
 *   explain it — a genuine oddity worth a human look, never silently
 *   folded into any total.
 * - `applied_without_free` (Opus money-review F3, 2026-07-31): a
 *   ตัดยอดล่วงหน้า line whose OWN `ledger_free` is 0 while its
 *   `ledger_amount` isn't — the opposite failure mode from V1's usual
 *   double-booking bug: instead of the money reaching gross twice, it
 *   reaches nothing at all (the line is only ever read via `ledger_free`,
 *   see `buildBookingCandidate`), silently DROPPING real revenue. Flagged
 *   so a human can look at the folio directly; the amount never gets
 *   invented from `ledger_amount` here (classification stays ds_name/
 *   `ledger_free`-only, per V1/V2).
 * - `unparseable_applied_booking_no` (Opus money-review F4, 2026-07-31): a
 *   ตัดยอดล่วงหน้า line's own label doesn't parse to the expected `R\d{6}`
 *   shape (see `parseAppliedBookingNo`) — the applied money is still
 *   booked (V1's reading of `ledger_free` is unconditional), but silently
 *   losing the R-number means Wave D's future exception-list join can
 *   never find this deposit's receipt, so it must not vanish quietly.
 * - `pre_cutover_deposit`: a จ่ายล่วงหน้า/คืนเงินจองห้อง event, OR an applied
 *   (ตัดยอดล่วงหน้า) amount, landed on a date before this property's
 *   accrual cutover (shared/accrual.ts) — the importer refuses to write a
 *   `deposit_events` row, or an applied `t_deposit_applied` tender, for a
 *   date accrual hasn't started on yet (C7); the money is reported here,
 *   never dropped silently. Applied at the server route (pms-prefill.ts
 *   itself has no date to gate on — mapLedgerRows is pure and per-payment,
 *   not date-aware), so this reason is only ever added in server.ts.
 */
export type PrefillAnomalyReason =
  | "mixed_scope"
  | "unknown_ds_name"
  | "free_without_applied"
  | "applied_without_free"
  | "unparseable_applied_booking_no"
  | "pre_cutover_deposit";

export interface PrefillAnomaly {
  pmsRef: string;
  reason: PrefillAnomalyReason;
  /** Human-readable context (the offending ds_name(s), amounts, etc.) for
   * whoever reviews the pull result — never structured further than a
   * string, since this is a "look at this" flag, not a typed workflow. */
  detail: string;
}

export interface MapLedgerRowsResult {
  bookingCandidates: PrefillCandidate[];
  depositCandidates: DepositCandidate[];
  anomalies: PrefillAnomaly[];
}

/**
 * One line of `ht_payment_ledger`, LEFT JOINed to `ht_customers` for the
 * guest-name columns (title/prefix, first, last, and the secondary/
 * English-name column that doubles as a last-name fallback — see
 * `buildGuestName`), typed as the columns actually SELECTed by
 * `LEDGER_QUERY` arrive from Bun's Postgres driver. NUMERIC columns come
 * back as strings (never trust driver auto-coercion to `number` for
 * money) — see `parseLedgerSatang` below. `ledger_legacy_id` is typed
 * loosely (`number | string`) because it is only ever interpolated into a
 * string (the `lid:` fallback ref), never arithmetic'd.
 *
 * Wave C additions: `ledger_free` (the applied-deposit/discount-comp
 * column — see the module comment above), `ledger_status` (SELECTed so the
 * pure mapper can re-assert the void filter the SQL's WHERE already
 * applies — fixture-provable without a DB), `ledger_note` (free text,
 * carried onto a received/refunded DepositCandidate's own `note`).
 */
export interface RawLedgerRow {
  ledger_legacy_id: number | string;
  ledger_pay_no: string | null;
  ledger_cin_no: string | null;
  ledger_ds_label: string | null;
  ledger_ds_name: string | null;
  ledger_ds_id: string | null;
  ledger_ds_num: string | null;
  ledger_cash: string | null;
  ledger_credit: string | null;
  ledger_tran: string | null;
  ledger_web: string | null;
  ledger_amount: string | null;
  ledger_free: string | null;
  ledger_status: string | null;
  ledger_note: string | null;
  cust_title: string | null;
  cust_firstname: string | null;
  cust_lastname: string | null;
  cust_name2: string | null;
}

/**
 * The `ht_payment_ledger` -> `ht_customers` join condition, shared by
 * EVERY query in this feature that needs a guest name off a ledger row
 * (`LEDGER_QUERY` below; `DEPOSIT_LEDGER_QUERY`/`DAY_AUDIT_LEDGER_QUERY`/
 * `fetchReceivedLookup`'s own inline query in the sibling modules) — kept
 * as ONE exported fragment so those queries can never drift apart on it
 * again. They already did, silently: this fragment replaces a bug that
 * shipped identically copy-pasted into all four call sites.
 *
 * `ledger_cust_no` is a 'C'-prefixed string, but iHOTEL is NOT consistent
 * about zero-padding the digits: hotelnew (HF) mostly writes the bare
 * integer ('C720'), hotelville pads to 4 digits for ~37% of its rows
 * ('C0720') — confirmed live 2026-08-06, 1,105 of 2,995 hotelville
 * `ht_payment_ledger` rows match `^C0`. The original join compared by
 * STRING CONCATENATION (`'C' || legacy_id::text`), which only ever
 * produces the UNPADDED form, so every padded row silently failed to
 * match and `buildGuestName` fell back to "ไม่ทราบชื่อ" (owner-reported;
 * R2608-0036 / `ledger_cust_no='C0720'` was the confirmed case — its
 * customer, legacy_id=720, นาย ศตพล วรกำเเหง, exists and now resolves).
 *
 * Fixed by comparing NUMERICALLY instead: strip a leading C/c and cast the
 * remainder to `int`, which discards leading zeros for free
 * (`'0720'::int = 720`) — so padding can never matter again, in either
 * direction. The whole-string regex guard (`^[Cc]?[0-9]+$`) runs BEFORE
 * the cast so a non-numeric or empty remainder (a corrupt value, or NULL,
 * for which `~` yields NULL, not TRUE) falls through the `CASE` to NULL
 * instead of throwing `invalid input syntax for integer` and failing the
 * whole query — verified live against EVERY row on both properties
 * 2026-08-06 (zero cast errors across 28,779 + 2,995 rows) and by this
 * module's own tests (`'C0720'`, `'C720'`, `'720'` all match; `'CXYZ'`,
 * `''`, `null` all yield no match, never a throw). The bare-digit shape
 * (no C prefix at all) is folded into this SAME expression, not a second
 * OR branch — the optional `[Cc]?` in the guard means `regexp_replace` is
 * simply a no-op when there is no leading C to strip.
 *
 * `c.legacy_id` is compared BARE (never wrapped in an expression) so an
 * index on `ht_customers.legacy_id`, if one exists, stays usable.
 */
export const CUSTOMER_JOIN_ON = `
    ON c.legacy_id = CASE
      WHEN l.ledger_cust_no ~ '^[Cc]?[0-9]+$'
      THEN regexp_replace(l.ledger_cust_no, '^[Cc]', '')::int
      ELSE NULL
    END`;

/**
 * Pure-JS mirror of `CUSTOMER_JOIN_ON`'s `CASE` expression. SQL text has no
 * unit-test surface of its own in this repo — there is no local Postgres in
 * `bun test` and `fetchDayPayments` is only ever exercised through its
 * `_internal` override, never a real PMS connection (see this module's
 * top-of-file "no network" note) — so this function exists purely to pin
 * the join's INTENDED numeric-extraction rule behind a fast, deterministic
 * test (`pms-prefill.test.ts`). It is NEVER called from the SQL path; the
 * two are independent expressions of the same rule, kept in lockstep by
 * hand — changing one always means updating the other (and its fixtures)
 * to match. The claim that they agree is backed by live-DB verification
 * (2026-08-06: zero cast errors and identical match sets across every row
 * of both properties' `ht_payment_ledger`), not by this function calling
 * into the SQL or vice versa.
 *
 * Same guard order as the SQL: the whole-string regex test runs BEFORE any
 * parsing, so a non-numeric remainder ('CXYZ'), an empty string, or
 * null/undefined all return `null` rather than throwing or producing
 * `NaN` — mirroring `NULL ~ pattern` being NULL (falsy for `WHEN`), not an
 * error, in Postgres.
 */
export function extractLegacyIdFromCustNo(custNo: string | null | undefined): number | null {
  if (custNo == null) return null;
  if (!/^[Cc]?[0-9]+$/.test(custNo)) return null;
  const digits = custNo.replace(/^[Cc]/, "");
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The one query this whole feature depends on getting right, kept as a
 * single exported string so a review can read it end to end. Excludes
 * cancelled lines (`IS DISTINCT FROM`, not `<>`, so a NULL status — which
 * Postgres `<>` would otherwise silently drop — still counts as active).
 * `ledger_status` is ALSO selected (Wave C) purely so the pure mapper can
 * re-assert this same filter — a fixture-provable defense in depth, not a
 * change of what rows this query returns. Ordered by payment key (matching
 * `mapLedgerRows`'s own grouping key) then `ledger_legacy_id`, so within a
 * payment the lowest-legacy-id line is deterministically "first" for
 * tender/room/nights extraction.
 */
export const LEDGER_QUERY = `
  SELECT
    l.ledger_legacy_id,
    l.ledger_pay_no,
    l.ledger_cin_no,
    l.ledger_ds_label,
    l.ledger_ds_name,
    l.ledger_ds_id,
    l.ledger_ds_num,
    l.ledger_cash,
    l.ledger_credit,
    l.ledger_tran,
    l.ledger_web,
    l.ledger_amount,
    l.ledger_free,
    l.ledger_status,
    l.ledger_note,
    c.cust_title,
    c.cust_firstname,
    c.cust_lastname,
    c.cust_name2
  FROM ht_payment_ledger l
  LEFT JOIN ht_customers c
  ${CUSTOMER_JOIN_ON}
  WHERE l.ledger_pay_date >= $1
    AND l.ledger_pay_date < $2
    AND l.ledger_status IS DISTINCT FROM 'ยกเลิก'
  ORDER BY
    COALESCE(NULLIF(l.ledger_pay_no, ''), 'lid:' || l.ledger_legacy_id::text),
    l.ledger_legacy_id
`;

const PMS_URL_ENV: Record<Property, string> = {
  hf: "PMS_DB_URL_HF",
  hfville: "PMS_DB_URL_HFVILLE",
};

function pmsUrl(property: Property): string | undefined {
  const raw = process.env[PMS_URL_ENV[property]];
  return raw && raw.length > 0 ? raw : undefined;
}

/** True iff this property's PMS Postgres URL is set. Read lazily — see
 * top-of-file note. The route's capability flag (`pmsPull` on GET
 * .../bookings) and its 503 gate both call this directly. */
export function pmsConfigured(property: Property): boolean {
  return pmsUrl(property) !== undefined;
}

/**
 * The sheet date's Bangkok calendar day as two ISO instants, PURE (no
 * server-local-TZ dependence): `fromIso` is the date's own
 * `T00:00:00+07:00`, `toIso` is exactly 24h later. Thailand carries no DST,
 * so a fixed +07:00 offset plus plain ms arithmetic on the resulting
 * instant handles month/year rollover for free — no calendar-aware code
 * needed.
 */
export function bangkokDayWindow(date: string): { fromIso: string; toIso: string } {
  const from = new Date(`${date}T00:00:00+07:00`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/**
 * `parseAmountToSatang` (shared/money.ts) is deliberately non-negative-only
 * — a human never types a negative amount into an income cell. Raw PMS
 * ledger NUMERICs are not so constrained: a refund payment carries a
 * genuinely negative tender value (docs/pms-prefill-plan.md's "net-negative
 * payments (refunds)"), and `isRefund` detection depends on that sign
 * surviving. This thin wrapper strips a leading `-`, feeds the unsigned
 * magnitude through the shared parser (so scale/format rules stay in ONE
 * place), and reapplies the sign. Null, empty, or unparseable input is 0
 * satang — the null-safe rule the plan calls for.
 *
 * Exported (Wave D) so `deposit-register.ts` reuses this exact parser
 * rather than a second copy — both modules read raw `ht_payment_ledger`
 * NUMERIC columns the same way.
 */
export function parseLedgerSatang(raw: string | null | undefined): number {
  if (raw == null) return 0;
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const negative = trimmed.startsWith("-");
  const magnitude = negative ? trimmed.slice(1) : trimmed;
  const satang = parseAmountToSatang(magnitude);
  if (satang === null) return 0;
  return negative ? -satang : satang;
}

/** `ledger_ds_num` (nights/qty) is a NUMERIC-as-string, but it is a count,
 * not money — parsed as a plain rounded number, never through the satang
 * parser. Null/empty/unparseable is null (distinct from "0 nights"). */
function parseNights(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Assembles the guest-facing name from `ht_customers`, per the real data
 * shape (SSH-sampled 2026-07-31, both hotelnew and hotelville canonical
 * Postgres, names/prefixes only, dozens of rows plus aggregate counts):
 *
 * - `cust_title` is a genuinely separate prefix column (นาย, น.ส., นาง,
 *   Mr., Mrs., ...) and never carries its own leading/trailing whitespace
 *   in either database (0 of ~25,000 rows) — so it is glued directly onto
 *   the first name with NO inserted space. That matches Thai typographic
 *   convention (นายสมชาย, not นาย สมชาย) and is simply mirroring what the
 *   source itself stores rather than inventing spacing it doesn't have —
 *   including for Latin titles ("Mr.สมชาย"-style gluing is what the raw
 *   columns actually produce; there is nothing in the data to justify
 *   treating Latin titles differently).
 * - `cust_lastname` is the obvious "last name" column but is nearly DEAD
 *   on the hotelnew (HF) property — 1 of 22,956 rows non-blank, and that
 *   one is test junk ("ZZ"/"TEST"). HF's front desk instead routinely
 *   types the real surname into `cust_name2` (~55% of rows populated
 *   there), even though that column's original design intent was an
 *   "English/secondary name" for FrmReportRR4 (see
 *   sync/mappers/customer.rs). hotelville uses `cust_lastname` properly
 *   (1,626 of 2,596 rows, ~63%) and its `cust_name2` is usually just a
 *   mirror of it (1,240 of those 1,626 match exactly). So: prefer
 *   `cust_lastname` when it has content, else fall back to `cust_name2`
 *   — one rule that covers both properties' real behavior without
 *   per-property branching.
 * - Whitespace is collapsed and the whole string trimmed; null when
 *   nothing at all is present (no join match, or a customer with no name
 *   on file).
 *
 * Deliberately NOT attempted: unscrambling a first name that already
 * embeds a full name alongside a lastname/name2 that repeats the surname
 * (e.g. firstname "วิดาร์ ปัญญาวุธ" with lastname ALSO "ปัญญาวุธ", which
 * would double up as "วิดาร์ ปัญญาวุธ ปัญญาวุธ") — that is pre-existing
 * free-text mess in the legacy data (confirmed present in the sample),
 * not something to paper over with guessy heuristics. Hand edits on the
 * bookings sheet stay the correction path, same as every other prefilled
 * field.
 *
 * Exported (owner ask, 2026-08-01, deposit register guest name):
 * deposit-register.ts reuses this exact assembler for its own
 * `ht_customers` join — one name-building rule for both modules, never a
 * second copy that could drift.
 */
export function buildGuestName(
  prefix: string | null | undefined,
  first: string | null | undefined,
  last: string | null | undefined,
  name2: string | null | undefined,
): string | null {
  const p = (prefix ?? "").trim();
  const f = (first ?? "").trim();
  const lastTrimmed = (last ?? "").trim();
  const l = lastTrimmed !== "" ? lastTrimmed : (name2 ?? "").trim();
  const namePart = [f, l].filter((s) => s !== "").join(" ");
  const full = `${p}${namePart}`.replace(/\s+/g, " ").trim();
  return full === "" ? null : full;
}

/** COALESCE(NULLIF(pay_no, ''), 'lid:'||legacy_id) — the PMS's own
 * round-report dedup key, and this module's payment grouping key. */
function paymentKey(row: RawLedgerRow): string {
  const payNo = (row.ledger_pay_no ?? "").trim();
  return payNo !== "" ? payNo : `lid:${row.ledger_legacy_id}`;
}

// ── ds_name vocabulary (C0/C3 — the real six labels, never the invented
// "เงินจอง" marker the pre-Wave-C importer matched 0 of 5,714 rows with) ──

const DS_NAME_ROOM_CHARGE = "ค่าห้อง";
// Exported (Wave D): deposit-register.ts's DEPOSIT_LEDGER_QUERY filters on
// these same two exact labels (plus DEPOSIT_APPLIED_PREFIX below) — reusing
// the literal strings here means the two modules can never drift apart on
// the Thai vocabulary itself.
export const DS_NAME_DEPOSIT_RECEIVED = "จ่ายล่วงหน้า";
const DS_NAME_ROOM_CANCEL = "ยกเลิกห้อง";
const DS_NAME_EXCESS_REFUND = "คืนเงินส่วนเกิน";
export const DS_NAME_DEPOSIT_REFUND = "คืนเงินจองห้อง";
const DS_NAME_PENALTY = "ค่าปรับ";

/** The six exact `ds_name` labels this importer recognizes outside the
 * ตัดยอดล่วงหน้า prefix family (see `DEPOSIT_APPLIED_PREFIX`). Exported so
 * pms-prefill.test.ts's `row()` fixture helper can type `ledger_ds_name` as
 * `LedgerDsName | \`${typeof DEPOSIT_APPLIED_PREFIX}${string}\`` — inventing
 * a label becomes a compile error rather than a silently-ignored fixture,
 * the exact class of bug the pre-Wave-C `DEPOSIT_MARKER` was. */
export const LEDGER_DS_NAMES = [
  DS_NAME_ROOM_CHARGE,
  DS_NAME_DEPOSIT_RECEIVED,
  DS_NAME_ROOM_CANCEL,
  DS_NAME_EXCESS_REFUND,
  DS_NAME_DEPOSIT_REFUND,
  DS_NAME_PENALTY,
] as const;

export type LedgerDsName = (typeof LEDGER_DS_NAMES)[number];

/** iHOTEL's own system-templated label prefix for an applied-deposit line —
 * the full label is this prefix plus the R-number the deposit was taken
 * under, e.g. "ตัดยอดล่วงหน้า Booking No:R014843". `ds_label` is never
 * matched (room numbers get rewritten onto it); `ds_id` is log-only. */
export const DEPOSIT_APPLIED_PREFIX = "ตัดยอดล่วงหน้า Booking No:";

const APPLIED_R_NUMBER_RE = /^R\d{6}$/;

/** Parses the R-number out of an applied-deposit line's own label — NEVER
 * from `ledger_cin_no`, which holds the CH-number on this scope of line
 * (see `DepositCandidate`'s doc comment on why the R-number is
 * label-sourced, not column-sourced). `null` when the suffix doesn't match
 * the expected `R\d{6}` shape — surfaced as an anomaly by the caller,
 * never silently dropped.
 *
 * Exported (Wave D): deposit-register.ts's `classifyDepositRow` parses the
 * SAME applied-line label the SAME way — one parser, so the day-scoped
 * importer and the full-history register can never disagree on what an
 * applied deposit's R-number is. */
export function parseAppliedBookingNo(dsName: string): string | null {
  const suffix = dsName.slice(DEPOSIT_APPLIED_PREFIX.length).trim();
  return APPLIED_R_NUMBER_RE.test(suffix) ? suffix : null;
}

type LineScope = "deposit" | "booking" | "unknown";

/** Classifies one line's `ds_name` into which candidate type its payment
 * group can become. `จ่ายล่วงหน้า`/`คืนเงินจองห้อง` are R-scoped (deposit
 * received/refunded); `ค่าห้อง`/`ยกเลิกห้อง`/`คืนเงินส่วนเกิน`/`ค่าปรับ` AND
 * the ตัดยอดล่วงหน้า prefix are all CH-scoped (booking/folio charges) —
 * ตัดยอดล่วงหน้า belongs here, NOT with the deposit-received/refunded pair,
 * because applying a deposit happens AT the folio/stay, alongside (or
 * sometimes alone in its own single-line payment for) the room charge —
 * see PrefillCandidate.appliedDepositSatang. */
function lineScope(dsName: string): LineScope {
  if (dsName === DS_NAME_DEPOSIT_RECEIVED || dsName === DS_NAME_DEPOSIT_REFUND) return "deposit";
  if (
    dsName === DS_NAME_ROOM_CHARGE ||
    dsName === DS_NAME_ROOM_CANCEL ||
    dsName === DS_NAME_EXCESS_REFUND ||
    dsName === DS_NAME_PENALTY ||
    dsName.startsWith(DEPOSIT_APPLIED_PREFIX)
  ) {
    return "booking";
  }
  return "unknown";
}

const DEPOSIT_TENDER_COLUMN: ReadonlyArray<{ tender: DepositTender; raw: keyof RawLedgerRow }> = [
  { tender: "cash", raw: "ledger_cash" },
  { tender: "credit", raw: "ledger_credit" },
  { tender: "transfer", raw: "ledger_tran" },
  { tender: "web", raw: "ledger_web" },
];

/**
 * Builds one `DepositCandidate` per non-zero raw tender column for the
 * R-scoped payment group — read ONCE per payment, from the group's first
 * line, never summed/repeated across lines (Opus money-review F5,
 * 2026-07-31: the SAME money-gotcha `buildBookingCandidate`'s
 * cash/web/credit/tran dedup already guards against — iHOTEL replicates
 * the whole tender split onto every line of a multi-line receipt, so
 * reading per-LINE instead of per-PAYMENT double-counted a 2-line group's
 * replicated tender into two candidates, silently relying on the unique
 * index to swallow the duplicate — which also means a genuinely different
 * SECOND deposit sharing that tender would have been dropped, not just the
 * duplicate). V1 established every จ่ายล่วงหน้า/ตัดยอดล่วงหน้า payment group
 * is single-line in practice, so this is a correctness fix for the general
 * case, not a behavior change for real data. `kind` comes from the first
 * line's `ds_name` (จ่ายล่วงหน้า -> received, คืนเงินจองห้อง -> refunded); a
 * refund line's tender value is negative in the raw column (the "Refund
 * column" C0 finding: the same column the deposit used, magnitude only,
 * n=1 observed) — `Math.abs` recovers the magnitude `DepositEvent`/
 * `DepositCandidate` always carry.
 */
function buildDepositCandidates(pmsRef: string, lines: RawLedgerRow[]): DepositCandidate[] {
  const first = lines[0]!;
  const dsName = (first.ledger_ds_name ?? "").trim();
  const kind: DepositEventKind = dsName === DS_NAME_DEPOSIT_REFUND ? "refunded" : "received";
  const bookingNo = (first.ledger_cin_no ?? "").trim() || null;
  const guestName = buildGuestName(first.cust_title, first.cust_firstname, first.cust_lastname, first.cust_name2);
  const note = (first.ledger_note ?? "").trim() || null;

  const candidates: DepositCandidate[] = [];
  for (const { tender, raw } of DEPOSIT_TENDER_COLUMN) {
    const value = parseLedgerSatang(first[raw] as string | null);
    if (value === 0) continue;
    candidates.push({ pmsRef, kind, bookingNo, guestName, tender, amountSatang: Math.abs(value), note });
  }
  return candidates;
}

/**
 * Builds the one `PrefillCandidate` for a CH-scoped (booking/folio) payment
 * group. See the module comment + `PrefillCandidate`'s own doc comment for
 * the event-mapping table this implements. Returns every anomaly warranted
 * alongside the candidate (see `PrefillAnomaly`'s doc comment:
 * `free_without_applied`, `applied_without_free`,
 * `unparseable_applied_booking_no`) — never thrown, never blocks the
 * candidate itself from being built.
 */
function buildBookingCandidate(
  pmsRef: string,
  lines: RawLedgerRow[],
): { candidate: PrefillCandidate; anomalies: PrefillAnomaly[] } {
  const first = lines[0]!;
  const roomLines = lines.filter((l) => (l.ledger_ds_name ?? "").trim() === DS_NAME_ROOM_CHARGE);
  const firstRoom = roomLines[0] ?? null;
  const appliedLines = lines.filter((l) => (l.ledger_ds_name ?? "").trim().startsWith(DEPOSIT_APPLIED_PREFIX));

  let grossRoomSatang = 0;
  let grossOtherSatang = 0;
  let appliedDepositSatang = 0;
  const appliedDepositBookingNos: string[] = [];
  let unexplainedFreeDsName: string | null = null;
  let unexplainedFreeAmount = 0;
  const anomalies: PrefillAnomaly[] = [];

  for (const line of lines) {
    const dsName = (line.ledger_ds_name ?? "").trim();
    const amount = parseLedgerSatang(line.ledger_amount);
    const freeAmount = parseLedgerSatang(line.ledger_free);

    if (dsName === DS_NAME_ROOM_CHARGE) {
      grossRoomSatang += amount;
      // ledger_free on a ค่าห้อง line is a known, expected discount/comp
      // (V2 — ~69,000 THB across both properties) — never anomalous, never
      // read into any figure here.
    } else if (dsName === DS_NAME_ROOM_CANCEL) {
      // SIGN ANOMALY (live money bug in the pre-Wave-C importer, see the
      // C-contradictions note in the plan): a cancellation's `ledger_amount`
      // is stored with an unreliable sign — force the correction negative
      // regardless of the raw stored sign, so it always REDUCES gross.
      grossRoomSatang += -Math.abs(amount);
      if (freeAmount !== 0 && unexplainedFreeDsName === null) {
        unexplainedFreeDsName = dsName;
        unexplainedFreeAmount = freeAmount;
      }
    } else if (dsName.startsWith(DEPOSIT_APPLIED_PREFIX)) {
      // V1: the applied amount lives in ledger_free; this line's OWN
      // ledger_amount (even though its ds_id is typically P001, same as a
      // room line) must NEVER reach gross — that is the double-booking bug
      // this rewrite fixes (live case: 890 applied + 890 room -> 1,780
      // booked for an 890 stay).
      appliedDepositSatang += freeAmount;
      // F3 (Opus money-review, 2026-07-31): the OPPOSITE failure mode — a
      // 0 ledger_free with a nonzero ledger_amount currently books NOTHING
      // (this rewrite reads ONLY ledger_free here, by design — V1/V2 rule
      // out keying on ledger_amount or "free != 0"), silently DROPPING
      // real revenue rather than doubling it. Flag it; never invent the
      // figure from ledger_amount.
      if (freeAmount === 0 && amount !== 0) {
        anomalies.push({ pmsRef, reason: "applied_without_free", detail: `ledger_amount ${amount}` });
      }
      const rNumber = parseAppliedBookingNo(dsName);
      if (rNumber) {
        appliedDepositBookingNos.push(rNumber);
      } else {
        // F4 (Opus money-review, 2026-07-31): an unparseable R-number used
        // to book the money silently with an empty
        // appliedDepositBookingNos and no anomaly at all — losing the
        // R-number means Wave D's future exception-list join can never
        // find this deposit's receipt again, so it must not vanish quietly
        // even though the applied amount itself is still booked.
        anomalies.push({ pmsRef, reason: "unparseable_applied_booking_no", detail: `${dsName} (amount ${freeAmount})` });
      }
    } else if (dsName === DS_NAME_EXCESS_REFUND || dsName === DS_NAME_PENALTY) {
      grossOtherSatang += amount;
      if (freeAmount !== 0 && unexplainedFreeDsName === null) {
        unexplainedFreeDsName = dsName;
        unexplainedFreeAmount = freeAmount;
      }
    }
    // Any other (unknown-scope) line was already filtered out by the
    // caller before this function ever sees `lines` — its money never
    // reaches here, by construction.
  }

  const cashSatang = parseLedgerSatang(first.ledger_cash);
  const webSatang = parseLedgerSatang(first.ledger_web);
  const creditSatang = parseLedgerSatang(first.ledger_credit);
  const tranSatang = parseLedgerSatang(first.ledger_tran);

  const netTenderSatang = cashSatang + webSatang + creditSatang + tranSatang;
  // Any individually-negative WRITTEN column is treated as a refund-like
  // anomaly even when the net is non-negative — these four are exactly the
  // fields insertPmsBookingLines (db.ts) writes into CHECK(col >= 0) DB
  // columns (t_cash/t_web always; t_transfer_kbank on every property and
  // t_credit_kbank on hfville, per its AUTO-PLACEMENT POLICY).
  const anyWrittenTenderNegative = cashSatang < 0 || webSatang < 0 || tranSatang < 0 || creditSatang < 0;

  const roomLabels = new Set(roomLines.map((l) => (l.ledger_ds_label ?? "").trim()).filter((label) => label !== ""));

  const candidate: PrefillCandidate = {
    pmsRef,
    bookingNo: (first.ledger_cin_no ?? "").trim() || null,
    guestName: buildGuestName(first.cust_title, first.cust_firstname, first.cust_lastname, first.cust_name2),
    roomNo: firstRoom ? (firstRoom.ledger_ds_label ?? "").trim() || null : null,
    roomCount: roomLines.length > 0 ? roomLabels.size : null,
    nights: firstRoom ? parseNights(firstRoom.ledger_ds_num) : null,
    grossRoomSatang,
    grossOtherSatang,
    cashSatang,
    webSatang,
    unplacedCreditSatang: creditSatang,
    unplacedTranSatang: tranSatang,
    appliedDepositSatang,
    appliedDepositBookingNos,
    isRefund: netTenderSatang < 0 || anyWrittenTenderNegative,
  };

  if (appliedLines.length === 0 && unexplainedFreeDsName !== null) {
    anomalies.push({
      pmsRef,
      reason: "free_without_applied",
      detail: `${unexplainedFreeDsName} (ledger_free ${unexplainedFreeAmount})`,
    });
  }

  return { candidate, anomalies };
}

/**
 * The heart of the feature: groups raw ledger lines by payment key, then
 * routes each group to a `PrefillCandidate` (CH-scoped/booking), one or
 * more `DepositCandidate`s (R-scoped/deposit), or an anomaly (mixed scope,
 * or nothing recognized at all) — see the module comment and
 * `PrefillAnomaly`'s doc comment for the full classification table. PURE —
 * no I/O, safe to unit test exhaustively without a database.
 *
 * The void filter (`ledger_status = 'ยกเลิก'`) is re-asserted here even
 * though `LEDGER_QUERY`'s WHERE already excludes those rows — a NULL
 * status counts as active (only the literal string 'ยกเลิก' is dropped),
 * fixture-provable without a database (see the C-contradictions note in
 * the plan).
 *
 * Output candidates are each sorted by payment key for a deterministic
 * order; anomalies are appended in the order their groups were
 * encountered (payment-key order too, since `groups` iterates in
 * insertion order and rows already arrive payment-key-sorted from SQL).
 */
export function mapLedgerRows(rows: RawLedgerRow[]): MapLedgerRowsResult {
  const activeRows = rows.filter((r) => (r.ledger_status ?? null) !== "ยกเลิก");

  const groups = new Map<string, RawLedgerRow[]>();
  for (const row of activeRows) {
    const key = paymentKey(row);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  const bookingCandidates: PrefillCandidate[] = [];
  const depositCandidates: DepositCandidate[] = [];
  const anomalies: PrefillAnomaly[] = [];

  for (const [pmsRef, lines] of groups) {
    const depositLines: RawLedgerRow[] = [];
    const bookingLines: RawLedgerRow[] = [];
    const unknownLines: RawLedgerRow[] = [];
    for (const line of lines) {
      const scope = lineScope((line.ledger_ds_name ?? "").trim());
      if (scope === "deposit") depositLines.push(line);
      else if (scope === "booking") bookingLines.push(line);
      else unknownLines.push(line);
    }

    for (const line of unknownLines) {
      const dsName = (line.ledger_ds_name ?? "").trim();
      anomalies.push({
        pmsRef,
        reason: "unknown_ds_name",
        detail: `${dsName || "(blank)"} (ds_id=${line.ledger_ds_id ?? "null"}, amount ${parseLedgerSatang(line.ledger_amount)})`,
      });
    }

    if (depositLines.length > 0 && bookingLines.length > 0) {
      const names = [...new Set(lines.map((l) => (l.ledger_ds_name ?? "").trim() || "(blank)"))];
      anomalies.push({ pmsRef, reason: "mixed_scope", detail: names.join(", ") });
      continue; // emit nothing for this group — neither type, per C0's "zero live" safety net
    }

    if (depositLines.length > 0) {
      depositCandidates.push(...buildDepositCandidates(pmsRef, depositLines));
      continue;
    }

    if (bookingLines.length > 0) {
      const { candidate, anomalies: candidateAnomalies } = buildBookingCandidate(pmsRef, bookingLines);
      bookingCandidates.push(candidate);
      anomalies.push(...candidateAnomalies);
    }
    // else: every line in the group was unknown-scope — already anomaly'd
    // above, nothing else to emit.
  }

  bookingCandidates.sort((a, b) => (a.pmsRef < b.pmsRef ? -1 : a.pmsRef > b.pmsRef ? 1 : 0));
  depositCandidates.sort((a, b) => (a.pmsRef < b.pmsRef ? -1 : a.pmsRef > b.pmsRef ? 1 : 0));

  return { bookingCandidates, depositCandidates, anomalies };
}

// One lazily-created Bun.SQL client per property URL, cached for the life
// of the process — connecting is comparatively expensive and the URL is
// effectively fixed once the container's env is materialized.
const clients = new Map<Property, SQL>();

function getClient(property: Property): SQL {
  const cached = clients.get(property);
  if (cached) return cached;
  const url = pmsUrl(property);
  if (!url) {
    throw new Error(`pms-prefill: ${PMS_URL_ENV[property]} is not set for property "${property}"`);
  }
  const client = new SQL(url);
  clients.set(property, client);
  return client;
}

/**
 * Exported (Wave D, deposit-register.ts's open item, resolved this way):
 * the deposit register queries the SAME per-property PMS Postgres
 * database as this module, over a DIFFERENT query (full deposit-lifecycle
 * history, no date window) — reusing this cache avoids opening a second
 * connection pool per property for what is, underneath, the same database
 * connection. Throws the same "env var not set" error `getClient` does
 * when the property's PMS URL is unset; callers gate on `pmsConfigured()`
 * first, same as every other caller of this cache.
 */
export function getPmsClient(property: Property): SQL {
  return getClient(property);
}

let fetchOverride: typeof fetchDayPayments | null = null;

/**
 * Fetches + maps one day's PMS payments for a property. Consults the test
 * override first (see `_internal.setFetchDayPaymentsForTests`, same
 * pattern as analytics-push.ts). Otherwise requires `pmsConfigured` — the
 * route checks this itself before calling (503 without ever reaching
 * here), so this throw is a plain defensive backstop, not the primary
 * gate. On a real PMS query failure this rejects and the caller (the
 * route) turns that into a 502 with nothing inserted.
 */
export async function fetchDayPayments(property: Property, date: string): Promise<MapLedgerRowsResult> {
  if (fetchOverride) return fetchOverride(property, date);
  if (!pmsConfigured(property)) {
    throw new Error(`pms-prefill: property "${property}" is not configured`);
  }
  const { fromIso, toIso } = bangkokDayWindow(date);
  const client = getClient(property);
  const rows = (await client.unsafe(LEDGER_QUERY, [fromIso, toIso])) as unknown as RawLedgerRow[];
  return mapLedgerRows(rows);
}

// Test-only handle — same shape as analytics-push.ts's `_internal`.
export const _internal = {
  setFetchDayPaymentsForTests(fn: typeof fetchDayPayments | null): void {
    fetchOverride = fn;
  },
};
