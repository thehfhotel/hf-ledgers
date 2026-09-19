// Pure computation of the expense-ledger -> hf-analytics monthly rollup
// payload (the locked hf-analytics ingest interface: POST
// /api/ingest/expense-ledger — see src/server/analytics-push.ts for the
// outbox/network side that wraps this). Kept as a standalone pure function
// so it is testable without a server, a live engine, or a live AP-register
// database, same philosophy as the income ledger's src/shared/rollup.ts:
// never reimplement this arithmetic elsewhere.
//
// MONEY IS INTEGER SATANG ON THIS PAYLOAD, same as everywhere else in this
// app (1 baht = 100 satang) — never floats.
//
// `month` is a Bangkok calendar "YYYY-MM" string — the งวด. `entered` is
// scoped by a transaction's own (Bangkok) date; `filed`/`filedByEntity`/
// `filedBySource` are scoped by an AP row's `billDate` (วันที่ลงบิล — the
// date the accountant assigned the bill to, src/server/apStore.ts's
// `bill_date` column, exposed on `ApRow.billDate`), never its `filedDate`
// (วันที่ยื่นบิล, record metadata) and never its `dueDate`. Both `transactions` and
// `apRows` may carry rows OUTSIDE `month` (the caller is not required to
// pre-filter — see src/server/analytics-push.ts, which passes a whole
// month's engine transactions and the AP register's entire row set) —
// this function does the month-scoping itself, which is also what lets it
// run directly against src/shared/rollup.fixtures/ (a raw, unscoped dump)
// with no test-side date filtering.
//
// SOURCE OF TRUTH (owner decision, 2026-09-15): expense.thehfhotel.org is
// the source of truth for every company bill. A bill counts once, in the
// งวด its วันที่ลงบิล falls in (`filed`), regardless of when it was entered
// into the register and of when or whether it's later paid
// (`filedOutstandingSatang` tracks what's still owed, but does not gate
// whether the bill counts this month). RECOGNITION CHANGED 2026-09-19
// (owner; docs/adr/0001-cost-recognised-in-its-period.md): these buckets
// used to be keyed by `filedDate` (the month the bill was filed), which put
// July's payroll in August and August's electricity in September. The
// `basis` field below is how a reader tells the two meanings apart.
// `entered` is every
// OTHER expense transaction — one entered directly, never through the AP
// register — identified by NOT carrying an `ap:<rowId>` tag (see
// src/server/engine.ts's isApManagedTransaction). The two are disjoint by
// construction: an AP payment always posts a tagged transaction, and
// `apManagedIds` is exactly the set of tagged transaction ids for the
// month, so `entered` excludes every transaction an AP payment created.

import {
  type ExpenseCategoryCode,
  RECURRING_CATEGORY_CODES,
  RECURRING_CATEGORY_COUNT,
} from "./categories.ts";

/** The exact JSON body POSTed to hf-analytics'
 * POST /api/ingest/expense-ledger (locked interface — see the contract).
 * Every count/amount bucket below is OMITTED (never an explicit 0) when
 * empty, same convention as the income ledger's payload. */
export interface ExpenseLedgerRollup {
  month: string;
  generatedAt: string;
  /** LOCKED CONTRACT EXTENSION (2026-09-19, additive): which meaning
   * `month` and the `filed*` buckets carry — THREE states, never a guess:
   *
   * - `"bill-date"`: `month` is the งวด. `filed` = AP rows whose วันที่ลงบิล
   *   falls in `month`; `entered` = engine transactions whose transaction
   *   date falls in `month` (unchanged — that date already IS the document
   *   date).
   * - `"filed-month"`: the OLD meaning — AP rows keyed by `filedDate`, the
   *   month the bill was entered into the register.
   * - ABSENT: a payload from a pusher that predates this field. A reader
   *   MUST treat an absent `basis` as `"filed-month"` and SAY SO rather
   *   than silently presenting it as a งวด.
   *
   * Optional on the type only so hf-analytics' receiver tolerates that
   * older pusher; computeExpenseLedgerRollup below ALWAYS sets
   * `"bill-date"`. */
  basis?: "filed-month" | "bill-date";
  /** Ledger transactions dated in `month` that are NOT AP-managed (no
   * `ap:` tag on the engine transaction) — expenses entered directly.
   * Keyed by ExpenseCategoryCode. */
  entered: Partial<Record<string, { count: number; amountSatang: number }>>;
  /** AP register rows whose วันที่ลงบิล (`billDate`) falls in `month` — a
   * bill counts ONCE, in its own งวด, whether or not it has been paid.
   * Keyed by ExpenseCategoryCode, plus "uncategorized". */
  filed: Partial<Record<string, { count: number; grossSatang: number; outstandingSatang: number }>>;
  /** The same AP rows by normalised entity. */
  filedByEntity: Partial<Record<"hf" | "hfville" | "unknown", { count: number; grossSatang: number; outstandingSatang: number }>>;
  /** LOCKED CONTRACT EXTENSION (2026-09-17, additive): the same AP rows by
   * WHO FILED them — see apRowSource() below for the exact rule. Optional
   * on the type only so hf-analytics' receiver tolerates an OLDER pusher's
   * payload that omits this field entirely; THIS function always computes
   * it (never omits the key, same convention as `filed`/`filedByEntity`
   * above — an empty month is `{}`, not a missing field). A zero-count
   * source key is omitted, same convention as every other bucket here.
   * When present, Σ grossSatang over sources === filedGrossSatang and
   * Σ outstandingSatang over sources === filedOutstandingSatang, to the
   * satang — enforced by the "three totals foot" test below. */
  filedBySource?: Partial<Record<ApRowSource, { count: number; grossSatang: number; outstandingSatang: number }>>;
  /** Of the 17 recurring leaves (RECURRING_CATEGORY_CODES), those with
   * >= 1 entered tx OR >= 1 filed AP row this month. */
  recurringFiled: string[];
  recurringTotal: number;
  enteredTotalSatang: number;
  filedGrossSatang: number;
  filedOutstandingSatang: number;
}

/** The subset of ExpenseTransaction (src/shared/types.ts) this function
 * needs — deliberately structural rather than importing that type
 * directly, so a caller can pass either the real engine-resolved shape or
 * a fixture-derived one without an intermediate cast. `categoryCode` is
 * ALREADY RESOLVED (src/server/engine.ts resolves it from the engine's raw
 * category id at fetch time — see EXPENSE_CATEGORIES/categoryCodeForEngineNames
 * for how a caller without a live engine, e.g. a test, derives it from raw
 * category names instead); this function does no category lookups of its
 * own. */
export interface RollupTransactionInput {
  id: string;
  /** Bangkok calendar "YYYY-MM-DD". */
  date: string;
  amountSatang: number;
  categoryCode: ExpenseCategoryCode;
}

/** The subset of ApRow (src/shared/apTypes.ts) this function needs.
 * `grossSatang`/`outstandingSatang` are taken AS ALREADY COMPUTED by
 * apStore.ts's mapRow (via apTypes.ts's computeGross/computeOutstanding) —
 * never recomputed here from amount/vat/wht/paid, so this function cannot
 * drift from that arithmetic. `outstandingSatang` here is UNFLOORED (an
 * overpaid/heavily-discounted row can compute negative); this function
 * floors it at 0 per the wire contract before summing. */
export interface RollupApRowInput {
  id: string;
  entity: string;
  categoryCode: ExpenseCategoryCode | null;
  /** Bangkok calendar "YYYY-MM-DD" — the row's `bill_date` (วันที่ลงบิล,
   * `ApRow.billDate`), never its `filedDate` (วันที่ยื่นบิล) and never its
   * `dueDate`. Its month is the งวด this row's cost is recognised in. */
  billDate: string;
  grossSatang: number;
  outstandingSatang: number;
  /** Presence (not shape) is what matters here — see apRowSource(). Typed
   * `unknown` rather than importing ApRow's full `payroll`/`reimbursement`
   * shape (src/shared/apTypes.ts), same "deliberately structural" reasoning
   * as the rest of this interface: a real ApRow (which has these as real
   * objects when synced) satisfies this without a cast, and a test fixture
   * only needs to set the key to a truthy placeholder. */
  payroll?: unknown;
  reimbursement?: unknown;
}

export type NormalizedApEntity = "hf" | "hfville" | "unknown";

/** LOCKED CONTRACT (2026-09-17): who filed an AP row, decided by presence
 * of ApRow.payroll / ApRow.reimbursement (never by categoryCode, entity or
 * any other heuristic) — src/server/payroll-sync.ts's payrollRowView and
 * src/server/reimbursement-sync.ts's reimbursementRowView are the only
 * writers of those two fields, and a row can carry at most one of them (a
 * payroll batch and a reimbursement receipt are disjoint sync sources).
 * Every other row — including a manually-filed salary or social-security
 * row that merely LOOKS like payroll by category — is "manual". */
export type ApRowSource = "manual" | "payroll" | "reimbursement";

export function apRowSource(row: Pick<RollupApRowInput, "payroll" | "reimbursement">): ApRowSource {
  if (row.payroll) return "payroll";
  if (row.reimbursement) return "reimbursement";
  return "manual";
}

/**
 * AP `entity` is free text (src/server/apStore.ts) and already drifts
 * across real rows (`HF`, `HF Ville`, `บจก.สายชล เฮอริเทจ`, a bare vendor
 * name, empty). Lower-cased, `ville` -> hfville; else `hf` / `สายชล` /
 * `hop` -> hf; else unknown. NEVER add a third branch — hf-analytics'
 * receiver keys `filedByEntity` on exactly these three strings.
 */
export function normalizeApEntity(entity: string): NormalizedApEntity {
  const lower = entity.toLowerCase();
  if (lower.includes("ville")) return "hfville";
  if (lower.includes("hf") || lower.includes("สายชล") || lower.includes("hop")) return "hf";
  return "unknown";
}

/**
 * Builds the rollup for one Bangkok calendar month (the งวด).
 * `transactions` and `apRows` need not be pre-scoped to `month` (see the
 * file header); this scopes them itself by `date`/`billDate`. `apManagedIds` is the set of
 * transaction ids (from among `transactions`) that carry an `ap:<rowId>`
 * tag — src/server/analytics-push.ts computes this from the engine's own
 * tag list ONCE per month rather than one isApManagedTransaction() call
 * per transaction (see src/server/engine.ts's
 * getMonthExpenseTransactionsWithApManaged). `generatedAt` is threaded
 * straight into the output rather than read from the clock here, so this
 * function stays fully deterministic/pure for testing.
 */
export function computeExpenseLedgerRollup(
  month: string,
  transactions: readonly RollupTransactionInput[],
  apManagedIds: ReadonlySet<string>,
  apRows: readonly RollupApRowInput[],
  generatedAt: string,
): ExpenseLedgerRollup {
  const entered: ExpenseLedgerRollup["entered"] = {};
  let enteredTotalSatang = 0;
  for (const tx of transactions) {
    if (tx.date.slice(0, 7) !== month) continue;
    if (apManagedIds.has(tx.id)) continue;
    const bucket = entered[tx.categoryCode] ?? { count: 0, amountSatang: 0 };
    bucket.count += 1;
    bucket.amountSatang += tx.amountSatang;
    entered[tx.categoryCode] = bucket;
    enteredTotalSatang += tx.amountSatang;
  }

  const filed: ExpenseLedgerRollup["filed"] = {};
  const filedByEntity: ExpenseLedgerRollup["filedByEntity"] = {};
  const filedBySource: NonNullable<ExpenseLedgerRollup["filedBySource"]> = {};
  let filedGrossSatang = 0;
  let filedOutstandingSatang = 0;
  for (const row of apRows) {
    if (row.billDate.slice(0, 7) !== month) continue;
    const outstanding = Math.max(0, row.outstandingSatang);

    const categoryKey = row.categoryCode ?? "uncategorized";
    const categoryBucket = filed[categoryKey] ?? { count: 0, grossSatang: 0, outstandingSatang: 0 };
    categoryBucket.count += 1;
    categoryBucket.grossSatang += row.grossSatang;
    categoryBucket.outstandingSatang += outstanding;
    filed[categoryKey] = categoryBucket;

    const entityKey = normalizeApEntity(row.entity);
    const entityBucket = filedByEntity[entityKey] ?? { count: 0, grossSatang: 0, outstandingSatang: 0 };
    entityBucket.count += 1;
    entityBucket.grossSatang += row.grossSatang;
    entityBucket.outstandingSatang += outstanding;
    filedByEntity[entityKey] = entityBucket;

    const sourceKey = apRowSource(row);
    const sourceBucket = filedBySource[sourceKey] ?? { count: 0, grossSatang: 0, outstandingSatang: 0 };
    sourceBucket.count += 1;
    sourceBucket.grossSatang += row.grossSatang;
    sourceBucket.outstandingSatang += outstanding;
    filedBySource[sourceKey] = sourceBucket;

    filedGrossSatang += row.grossSatang;
    filedOutstandingSatang += outstanding;
  }

  const recurringFiled = RECURRING_CATEGORY_CODES.filter(
    (code) => (entered[code]?.count ?? 0) > 0 || (filed[code]?.count ?? 0) > 0,
  );

  return {
    month,
    generatedAt,
    // Always explicit: this function has only ever one meaning, and a
    // reader must never have to infer it (see `basis` on the interface).
    basis: "bill-date",
    entered,
    filed,
    filedByEntity,
    filedBySource,
    recurringFiled,
    recurringTotal: RECURRING_CATEGORY_COUNT,
    enteredTotalSatang,
    filedGrossSatang,
    filedOutstandingSatang,
  };
}
