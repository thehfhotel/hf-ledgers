// Single source of truth for booking-line aggregates, tender -> category
// derivation, and the cash-banking block — same philosophy as totals.ts:
// the server computes with these functions and the client imports the SAME
// functions, so UI and API can never disagree. Never reimplement any of
// this arithmetic separately in a route handler or a component.

import { TENDERS, TENDER_TO_CATEGORY_KEY } from "./types.ts";
import type {
  BookingLine,
  BookingTotals,
  Category,
  CashBlockAmounts,
  CategoryKey,
  IncomeCell,
  OtherIncomeItem,
  Tender,
} from "./types.ts";

/** Sum of all eight tender columns on a single line. */
function sumTenders(tenders: Record<Tender, number>): number {
  return TENDERS.reduce((sum, tender) => sum + tenders[tender], 0);
}

/**
 * Aggregates a day's booking lines into the figures the day view and the
 * report need. Draft lines (PMS-drafted, not yet confirmed by front desk)
 * are excluded from every figure — a draft is a proposal, not yet income.
 */
export function computeBookingTotals(lines: BookingLine[]): BookingTotals {
  const confirmedLines = lines.filter((line) => !line.draft);

  const byTender = Object.fromEntries(TENDERS.map((tender) => [tender, 0])) as Record<Tender, number>;

  let roomCount = 0;
  let nights = 0;
  let grossRoomSatang = 0;
  let grossOtherSatang = 0;
  let discountSatang = 0;
  let receivedSatang = 0;

  for (const line of confirmedLines) {
    roomCount += line.roomCount ?? 0;
    nights += line.nights ?? 0;
    grossRoomSatang += line.grossRoomSatang;
    grossOtherSatang += line.grossOtherSatang;
    discountSatang += line.discountSatang;
    for (const tender of TENDERS) {
      const amount = line.tenders[tender];
      byTender[tender] += amount;
      receivedSatang += amount;
    }
  }

  return {
    lineCount: confirmedLines.length,
    roomCount,
    nights,
    grossRoomSatang,
    grossOtherSatang,
    discountSatang,
    receivedSatang,
    byTender,
  };
}

/**
 * Per-CategoryKey sums of non-draft booking lines, through
 * TENDER_TO_CATEGORY_KEY. Tender "other" is never included — it has no
 * CategoryKey counterpart (see types.ts), so it never appears in the
 * returned partial map. A category key with no matching amount anywhere is
 * simply absent from the result, not present with a 0.
 */
export function deriveIncomeFromBookings(lines: BookingLine[]): Partial<Record<CategoryKey, number>> {
  const confirmedLines = lines.filter((line) => !line.draft);
  const totals: Partial<Record<CategoryKey, number>> = {};

  for (const line of confirmedLines) {
    for (const tender of TENDERS) {
      const categoryKey = TENDER_TO_CATEGORY_KEY[tender];
      if (!categoryKey) continue; // "other" — itemized OtherIncomeItem territory, not a category cell
      const amount = line.tenders[tender];
      if (amount === 0) continue;
      totals[categoryKey] = (totals[categoryKey] ?? 0) + amount;
    }
  }

  return totals;
}

/**
 * Reproduces the paper's `**หมายเหตุ` cash block from the day's income
 * cells (room cash + bar cash, found by `categoryKey` — never by `nameTh`,
 * see CategoryKey) and its itemized other-income entries (their own
 * `isCash` flag). This replaces the old approach of reading a single
 * cash-flagged "รายการอื่นๆ" category, which measurably produced the wrong
 * bank-deposit figure (933,090 THB computed vs 871,102 actually banked,
 * wrong on 75 days) because that one paper column mixes cash and
 * transfer/credit.
 *
 * Returns the `derived` half of a CashBlock; the caller layers a manager
 * `entered` override on top (see api.md `PUT .../cash-block`).
 */
export function deriveCashBlock(
  categories: Category[],
  income: Record<number, IncomeCell>,
  otherIncomeItems: OtherIncomeItem[],
): CashBlockAmounts {
  const categoryKeyByCategoryId = new Map(categories.map((category) => [category.id, category.categoryKey]));

  let roomCashSatang = 0;
  let barCashSatang = 0;
  for (const cell of Object.values(income)) {
    const categoryKey = categoryKeyByCategoryId.get(cell.categoryId);
    if (categoryKey === "room_cash") roomCashSatang += cell.amountSatang;
    if (categoryKey === "bar_cash") barCashSatang += cell.amountSatang;
  }

  const otherCashSatang = otherIncomeItems
    .filter((item) => item.isCash)
    .reduce((sum, item) => sum + item.amountSatang, 0);

  return {
    roomCashSatang,
    otherCashSatang,
    barCashSatang,
    bankedSatang: roomCashSatang + otherCashSatang + barCashSatang,
  };
}

/**
 * A booking line's tender amounts carry two decimals same as the rest of
 * this app's money, but OTA-imported rows have already been observed to
 * accumulate float error before they ever reach this codebase — one real
 * cached workbook total reads 22066.739999999998. Exact equality between
 * `received` and `grossRoom + grossOther - discount` would flag that row
 * (and others like it) as broken when it isn't. RECONCILE_TOLERANCE_SATANG
 * (1 THB) absorbs that noise while still catching genuine data-entry
 * errors.
 */
export const RECONCILE_TOLERANCE_SATANG = 100;

/** True when a line's received tenders don't reconcile against its gross
 * room + gross other - discount, beyond RECONCILE_TOLERANCE_SATANG. */
export function lineArithmeticMismatch(line: BookingLine): boolean {
  const receivedSatang = sumTenders(line.tenders);
  const expectedSatang = line.grossRoomSatang + line.grossOtherSatang - line.discountSatang;
  return Math.abs(receivedSatang - expectedSatang) > RECONCILE_TOLERANCE_SATANG;
}
