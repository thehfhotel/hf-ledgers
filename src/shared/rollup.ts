// Pure computation of the income-ledger -> hf-analytics daily rollup payload
// (the locked hf-analytics ingest interface: POST /api/ingest/income-ledger
// — see src/server/analytics-push.ts for the outbox/network side that wraps
// this). Kept as a standalone pure function so it is testable without a
// server or a live database, same philosophy as totals.ts/bookings.ts:
// never reimplement this arithmetic elsewhere.
//
// MONEY IS INTEGER SATANG ON THIS PAYLOAD, same as everywhere else in this
// app (1 baht = 100 satang) — never floats.
//
// `date` is the office REPORT day, not a calendar day: the office runs
// three cashier rounds per day and the last spans 22:00-07:00, counted as
// the same report day it started on. income-ledger already keys
// income_amounts/sheet_days this way (see src/shared/date.ts,
// src/shared/api.md), so this payload inherits that key unchanged — the
// PMS-ledger income series in hf-mcp groups by calendar time instead, so
// the two will legitimately disagree by one night at every month boundary.
// That is expected, not a bug to reconcile here.
//
// Built from computeDayTotals() (this app's single source of truth for day
// totals) rather than any new summation — see totals.ts.

import { computeDayTotals } from "./totals.ts";
import type { Category, CategoryKey, DayProvenance, DepositEvent, ExpenseItem, IncomeCell, Property } from "./types.ts";

/**
 * The exact JSON body POSTed to hf-analytics' POST /api/ingest/income-ledger
 * (locked interface). `generatedAt` is deliberately NOT produced here — it
 * is a push-time timestamp added by the caller (analytics-push.ts) so this
 * function stays pure and deterministic for testing.
 */
export interface IncomeLedgerRollup {
  property: Property;
  date: string;
  /** Keyed by the fifteen CategoryKey values (Wave C, docs/adr/0001, added
   * deposit_applied). A key with a zero amount is omitted entirely — the
   * wire contract never sends an explicit 0. */
  amounts: Partial<Record<CategoryKey, number>>;
  /** Satang landed on a manager-created category (category_key IS NULL
   * upstream) — these don't map to any of the fifteen CategoryKeys. */
  uncategorizedSatang: number;
  /** Always sum(amounts) + uncategorizedSatang. */
  totalSatang: number;
  expenseSatang: number;
  verified: boolean;
  provenance: DayProvenance;
  /**
   * Wave C (docs/adr/0001-accrual-recognition-for-deposits.md): this day's
   * total มัดจำล่วงหน้า received/refunded, across every DepositTender (not
   * cash-only — see `CashBlock.depositCashInSatang`/`depositCashOutSatang`,
   * shared/types.ts, for the cash-only figure that feeds the bank line).
   * Ride OUTSIDE `amounts` deliberately: under accrual this money is
   * received-but-not-earned / refunded-but-never-earned, so folding it into
   * the footing sum would silently overstate revenue — NEVER weaken the
   * footing rule by excluding a key from `amounts` instead of using this
   * separate top-level pair. Applied deposits are the opposite case: they
   * ARE revenue, and ride INSIDE `amounts` as the ordinary `deposit_applied`
   * key, footing normally. Omitted (not present, never an explicit 0) when
   * the respective total is zero — same convention as `amounts`.
   */
  depositReceivedSatang?: number;
  depositRefundedSatang?: number;
}

/**
 * Builds the rollup for one (property, date) from the same shapes
 * loadDayData() (server.ts) already assembles for the day-sheet API:
 * `categories` (for categoryKey lookup — categoriesForDay() output is
 * fine), the EFFECTIVE income view (getEffectiveIncomeForDay() — the two
 * รายการอื่นๆ cells already resolved to their computed values whenever the
 * day has other-income items, exactly like the day-sheet the office sees),
 * and the day's expense items. `verified`/`provenance` come from the day's
 * sheet_days row — pass `false`/`"app"` for a day with no such row.
 *
 * `income` is assumed to contain only income-kind category cells (true of
 * every value server.ts ever produces — saveIncomeCell() only ever writes
 * a category with kind "income"), so `totalSatang` always equals
 * sum(amounts) + uncategorizedSatang, matching the wire contract's stated
 * invariant. `deposit_applied` cells (Wave C) flow through this same loop
 * like any other keyed category — no special casing needed, since applied
 * deposits foot normally inside `amounts`.
 *
 * `depositEvents` (Wave C, defaulted to `[]` so every pre-existing call
 * site is unaffected) is this day's received/refunded มัดจำล่วงหน้า rows —
 * summed into the OUTSIDE-of-amounts `depositReceivedSatang`/
 * `depositRefundedSatang` pair (see `IncomeLedgerRollup`'s doc comment).
 */
export function computeIncomeLedgerRollup(
  property: Property,
  date: string,
  categories: Category[],
  income: Record<number, IncomeCell>,
  expenses: ExpenseItem[],
  verified: boolean,
  provenance: DayProvenance,
  depositEvents: DepositEvent[] = [],
): IncomeLedgerRollup {
  const categoryKeyByCategoryId = new Map(categories.map((c) => [c.id, c.categoryKey]));

  const amounts: Partial<Record<CategoryKey, number>> = {};
  let uncategorizedSatang = 0;
  for (const cell of Object.values(income)) {
    if (cell.amountSatang === 0) continue; // omit zero categories — see api contract
    const categoryKey = categoryKeyByCategoryId.get(cell.categoryId) ?? null;
    if (categoryKey) {
      amounts[categoryKey] = (amounts[categoryKey] ?? 0) + cell.amountSatang;
    } else {
      uncategorizedSatang += cell.amountSatang;
    }
  }

  // Single source of truth for incomeSatang/expenseSatang — never re-sum
  // independently (see totals.ts).
  const totals = computeDayTotals(categories, income, expenses);

  let depositReceivedSatang = 0;
  let depositRefundedSatang = 0;
  for (const event of depositEvents) {
    if (event.kind === "received") depositReceivedSatang += event.amountSatang;
    else depositRefundedSatang += event.amountSatang;
  }

  return {
    property,
    date,
    amounts,
    uncategorizedSatang,
    totalSatang: totals.incomeSatang,
    expenseSatang: totals.expenseSatang,
    verified,
    provenance,
    ...(depositReceivedSatang > 0 ? { depositReceivedSatang } : {}),
    ...(depositRefundedSatang > 0 ? { depositRefundedSatang } : {}),
  };
}
