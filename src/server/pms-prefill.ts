// ดึงข้อมูล — pulls a day's payments from the PMS payment ledger
// (`ht_payment_ledger`, one Postgres database per property) into
// `PrefillCandidate`s that `db.ts#insertPmsBookingLines` turns into
// `booking_lines` rows. See docs/pms-prefill-plan.md for the full design;
// this module owns everything PURE (day-window math, the row->candidate
// mapping) plus the thin network shim that fetches raw rows.
//
// THE MONEY GOTCHA this module exists to fix: iHOTEL replicates the whole
// tender split (cash/credit/tran/web) onto EVERY line of a multi-line
// receipt. Summing tenders raw across lines inflates money (a verified
// real case differed by 57%). mapLedgerRows() takes each tender value
// ONCE per payment — from the first line encountered for that payment key
// — never summed across lines. Line amounts (`ledger_amount`) are
// genuinely itemized per line and ARE summed raw.
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
import type { Property } from "../shared/types.ts";

/** One row inserted onto the bookings sheet, derived from one PMS payment
 * (all lines sharing the same receipt/pay number, or the same ledger row
 * when the receipt number is blank). See docs/pms-prefill-plan.md. */
export interface PrefillCandidate {
  pmsRef: string;
  bookingNo: string | null;
  guestName: string | null;
  roomNo: string | null;
  roomCount: number | null;
  nights: number | null;
  grossRoomSatang: number;
  grossOtherSatang: number;
  depositSatang: number;
  cashSatang: number;
  webSatang: number;
  unplacedCreditSatang: number;
  unplacedTranSatang: number;
  isRefund: boolean;
  isDeposit: boolean;
}

/**
 * One line of `ht_payment_ledger`, LEFT JOINed to `ht_customers` for the
 * two name columns, typed as the columns actually SELECTed by
 * `LEDGER_QUERY` arrive from Bun's Postgres driver. NUMERIC columns come
 * back as strings (never trust driver auto-coercion to `number` for
 * money) — see `parseLedgerSatang` below. `ledger_legacy_id` is typed
 * loosely (`number | string`) because it is only ever interpolated into a
 * string (the `lid:` fallback ref), never arithmetic'd.
 *
 * Deliberately NOT selected/typed here: `ledger_id`, `ledger_cust_no`,
 * `ledger_pay_date`, `ledger_status` (all consumed only by the SQL's
 * JOIN/WHERE/ORDER BY, never by `mapLedgerRows`), and `ledger_free` (one
 * of the PMS's five tender columns, but not represented anywhere in
 * `PrefillCandidate` — the locked interface has no slot for a
 * complimentary/comp tender, so it is left unselected rather than
 * silently dropped after the fact).
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
  cust_firstname: string | null;
  cust_lastname: string | null;
}

/**
 * The one query this whole feature depends on getting right, kept as a
 * single exported string so a review can read it end to end. Excludes
 * cancelled lines (`IS DISTINCT FROM`, not `<>`, so a NULL status — which
 * Postgres `<>` would otherwise silently drop — still counts as active).
 * Ordered by payment key (matching `mapLedgerRows`'s own grouping key)
 * then `ledger_legacy_id`, so within a payment the lowest-legacy-id line
 * is deterministically "first" for tender/room/nights extraction.
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
    c.cust_firstname,
    c.cust_lastname
  FROM ht_payment_ledger l
  LEFT JOIN ht_customers c
    -- ledger_cust_no is a C-prefixed string ('C22006'); legacy_id is the bare
    -- integer (22006). Verified against live data 2026-07-30 (183/183 of a
    -- week's payments join); the naive equality is a type error in Postgres.
    ON l.ledger_cust_no = 'C' || c.legacy_id::text
    OR l.ledger_cust_no = c.legacy_id::text
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
 */
function parseLedgerSatang(raw: string | null | undefined): number {
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

/** "first last", collapsing either half being blank/null; null when both
 * are blank (no join match, or a customer with no name on file). */
function buildGuestName(first: string | null | undefined, last: string | null | undefined): string | null {
  const name = [first, last]
    .map((s) => (s ?? "").trim())
    .filter((s) => s !== "")
    .join(" ");
  return name === "" ? null : name;
}

/** COALESCE(NULLIF(pay_no, ''), 'lid:'||legacy_id) — the PMS's own
 * round-report dedup key, and this module's payment grouping key. */
function paymentKey(row: RawLedgerRow): string {
  const payNo = (row.ledger_pay_no ?? "").trim();
  return payNo !== "" ? payNo : `lid:${row.ledger_legacy_id}`;
}

const ROOM_CATEGORY_ID = "P001";
const DEPOSIT_MARKER = "เงินจอง";

/**
 * The heart of the feature: groups raw ledger lines by payment key, then
 * derives one `PrefillCandidate` per group. PURE — no I/O, safe to unit
 * test exhaustively without a database.
 *
 * Per group:
 * - tenders (cash/web/credit/tran) are read ONCE, from the first line
 *   encountered for that key (never summed across lines — see the
 *   top-of-file money gotcha note);
 * - `ledger_amount` IS summed across lines, split by category:
 *   `ds_id === 'P001'` -> grossRoomSatang, everything else ->
 *   grossOtherSatang;
 * - `isDeposit` is true if ANY line's `ds_name` contains "เงินจอง"; for a
 *   deposit payment, credit+tran land in `depositSatang` (the มัดจำ column
 *   is bank-agnostic by design); for a non-deposit payment they land in
 *   `unplacedCreditSatang`/`unplacedTranSatang` instead (amount known, bank
 *   unknown — the PMS records no acquiring bank at all);
 * - `isRefund` is true when the net of cash+web+deposit-or-unplaced totals
 *   is negative, OR when any one of cash/web/deposit is individually
 *   negative even while the net is not — those three are the columns
 *   `insertPmsBookingLines` actually writes (`t_cash`/`t_web`/`t_deposit`,
 *   each `CHECK (col IS NULL OR col >= 0)`), and iHOTEL can replicate a
 *   corrections/adjustment line that makes one tender negative while a
 *   larger positive one elsewhere nets the payment positive overall. Without
 *   this, such a candidate would sail through as "not a refund" and then
 *   crash the whole insert transaction on the CHECK constraint;
 * - room/nights fields come from the first `P001` line; `roomCount` is the
 *   number of distinct (trimmed, non-blank) `ds_label`s across all `P001`
 *   lines, or null when the payment has no room line at all.
 *
 * Output is sorted by payment key for a deterministic order.
 */
export function mapLedgerRows(rows: RawLedgerRow[]): PrefillCandidate[] {
  const groups = new Map<string, RawLedgerRow[]>();
  for (const row of rows) {
    const key = paymentKey(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const candidates: PrefillCandidate[] = [];
  for (const [pmsRef, lines] of groups) {
    const first = lines[0]!;
    const roomLines = lines.filter((l) => l.ledger_ds_id === ROOM_CATEGORY_ID);
    const firstRoom = roomLines[0] ?? null;

    let grossRoomSatang = 0;
    let grossOtherSatang = 0;
    for (const line of lines) {
      const amount = parseLedgerSatang(line.ledger_amount);
      if (line.ledger_ds_id === ROOM_CATEGORY_ID) grossRoomSatang += amount;
      else grossOtherSatang += amount;
    }

    const isDeposit = lines.some((l) => (l.ledger_ds_name ?? "").includes(DEPOSIT_MARKER));

    const cashSatang = parseLedgerSatang(first.ledger_cash);
    const webSatang = parseLedgerSatang(first.ledger_web);
    const creditSatang = parseLedgerSatang(first.ledger_credit);
    const tranSatang = parseLedgerSatang(first.ledger_tran);

    const depositSatang = isDeposit ? creditSatang + tranSatang : 0;
    const unplacedCreditSatang = isDeposit ? 0 : creditSatang;
    const unplacedTranSatang = isDeposit ? 0 : tranSatang;

    const netTenderSatang = cashSatang + webSatang + depositSatang + unplacedCreditSatang + unplacedTranSatang;
    // Any individually-negative WRITTEN column (cash/web/deposit) is treated
    // as a refund-like anomaly even when the net is non-negative — those are
    // the three fields insertPmsBookingLines writes into CHECK(>= 0) columns.
    const anyWrittenTenderNegative = cashSatang < 0 || webSatang < 0 || depositSatang < 0;

    const roomLabels = new Set(
      roomLines.map((l) => (l.ledger_ds_label ?? "").trim()).filter((label) => label !== ""),
    );

    candidates.push({
      pmsRef,
      bookingNo: (first.ledger_cin_no ?? "").trim() || null,
      guestName: buildGuestName(first.cust_firstname, first.cust_lastname),
      roomNo: firstRoom ? (firstRoom.ledger_ds_label ?? "").trim() || null : null,
      roomCount: roomLines.length > 0 ? roomLabels.size : null,
      nights: firstRoom ? parseNights(firstRoom.ledger_ds_num) : null,
      grossRoomSatang,
      grossOtherSatang,
      depositSatang,
      cashSatang,
      webSatang,
      unplacedCreditSatang,
      unplacedTranSatang,
      isRefund: netTenderSatang < 0 || anyWrittenTenderNegative,
      isDeposit,
    });
  }

  return candidates.sort((a, b) => (a.pmsRef < b.pmsRef ? -1 : a.pmsRef > b.pmsRef ? 1 : 0));
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
export async function fetchDayPayments(property: Property, date: string): Promise<PrefillCandidate[]> {
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
