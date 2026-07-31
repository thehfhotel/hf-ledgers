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
  DepositEvent,
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
 * simply absent from the result, not present with a 0. Loops `TENDERS`
 * generically, so `deposit_applied` (Wave C) maps onto its own CategoryKey
 * exactly like every other tender, with no code change needed here.
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
 * Sums of a day's `deposit_events` rows that touch the CASH till only
 * (`tender === "cash"`) — transfer/credit/web/other deposit tenders never
 * move cash, so they never reach `bankedSatang` (docs/adr/0001: a cash
 * มัดจำล่วงหน้า enters the till and so reaches ยอดฝากจริง; a non-cash one
 * doesn't touch it either way). Exported so `CashBlock.depositCashInSatang/
 * depositCashOutSatang` (server.ts's `buildCashBlock`) and `deriveCashBlock`
 * below share the exact same figures rather than two independent sums that
 * could drift.
 */
export function depositCashTotals(depositEvents: DepositEvent[]): {
  depositCashInSatang: number;
  depositCashOutSatang: number;
} {
  let depositCashInSatang = 0;
  let depositCashOutSatang = 0;
  for (const event of depositEvents) {
    if (event.tender !== "cash") continue;
    if (event.kind === "received") depositCashInSatang += event.amountSatang;
    else depositCashOutSatang += event.amountSatang;
  }
  return { depositCashInSatang, depositCashOutSatang };
}

/**
 * Reproduces the paper's `**หมายเหตุ` cash block from the day's income
 * cells and its itemized other-income entries (their own `isCash` flag).
 * This replaces the old approach of reading a single cash-flagged
 * "รายการอื่นๆ" category, which measurably produced the wrong bank-deposit
 * figure (933,090 THB computed vs 871,102 actually banked, wrong on 75
 * days) because that one paper column mixes cash and transfer/credit.
 *
 * Bucket selection is by `category.isCash` (never `nameTh`, see
 * `CategoryKey`), not by an enumerated list of keys: `room_cash` and
 * `bar_cash` each keep their own bucket by `categoryKey`; every OTHER
 * `isCash` category — the seeded `other_cash` key AND any custom
 * manager-created cash category (`categoryKey: null`) — sums into the
 * `otherCash` bucket. The seed makes `isCash` true for exactly those three
 * keys today, so this is a pure generalization, not a behavior change for
 * existing data.
 *
 * The `other_cash` cell specifically gets the SAME "items-else-cell" rule
 * as `getEffectiveIncomeForDay` (src/server/db.ts) — mirrored here exactly
 * (including what counts as "has items": `otherIncomeItems.length > 0`,
 * regardless of any item's own `isCash`) rather than assumed from the
 * caller's `income` already being the effective view, so this function is
 * correct even when it isn't: zero itemized other-income rows -> the day's
 * typed `other_cash` cell reaches `otherCashSatang` (previously silently
 * dropped — a latent, UI-reachable trap with zero live instances); one or
 * more itemized rows -> the cell is ignored and the cash items' sum is used
 * instead, unchanged from before.
 *
 * `heldBackSatang`/`broughtForwardSatang` (docs/plan-unify-exports-tender-
 * split.md item 6, Wave C — see `CashAdjustmentAmounts` in types.ts) fold
 * into `bankedSatang` here: small change that couldn't go into the deposit
 * machine today is SUBTRACTED, and a prior round's held-back cash deposited
 * today is ADDED. `null` (not recorded) reads as 0 in the formula, same as
 * every other omitted-adjustment day. Both default to `null` so every
 * pre-existing call site (no adjustment recorded) derives the exact same
 * `bankedSatang` it always has.
 *
 * `depositEvents` (Wave C, docs/adr/0001) folds in the same way, through
 * `depositCashTotals()` above: a cash มัดจำล่วงหน้า received today reaches
 * `bankedSatang` (it entered the till) while staying entirely OUT of every
 * income cell above (it is not `รวมรายรับทั้งวัน` — the accrual rule's whole
 * point); a cash refund of a cash deposit reduces `bankedSatang` back down.
 * Transfer/credit/web/other deposit tenders never touch this figure either
 * way. Defaults to `[]` so every pre-existing call site (no deposit events
 * ever passed) derives the exact same `bankedSatang` it always has — the
 * full formula is `bankedSatang = roomCash + otherCash + barCash +
 * depositCashIn - depositCashOut - heldBackSatang + broughtForwardSatang`.
 * This total can legitimately go negative (a large refund on a light cash
 * day) — the formula never clamps; `PUT .../cash-block`'s own bounds reject
 * a negative EXPLICIT override, but the derived figure itself is not an
 * override.
 *
 * Returns the `derived` half of a CashBlock; the caller layers a manager
 * `entered` override of `bankedSatang` itself on top (see api.md
 * `PUT .../cash-block`) — that override still wins regardless of what this
 * function computes. `CashBlockAmounts` itself stays exactly 4 fields —
 * deposit terms are itemized and hand-editable at their own source (the
 * event), so a correction happens there, never via a fifth aggregate
 * override field here (see `CashBlock.depositCashInSatang`/
 * `depositCashOutSatang` in types.ts for the always-derived display figures).
 */
export function deriveCashBlock(
  categories: Category[],
  income: Record<number, IncomeCell>,
  otherIncomeItems: OtherIncomeItem[],
  heldBackSatang: number | null = null,
  broughtForwardSatang: number | null = null,
  depositEvents: DepositEvent[] = [],
): CashBlockAmounts {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const hasOtherIncomeItems = otherIncomeItems.length > 0;

  let roomCashSatang = 0;
  let barCashSatang = 0;
  let otherCashSatang = 0;

  for (const cell of Object.values(income)) {
    const category = categoryById.get(cell.categoryId);
    if (!category?.isCash) continue;

    if (category.categoryKey === "room_cash") {
      roomCashSatang += cell.amountSatang;
    } else if (category.categoryKey === "bar_cash") {
      barCashSatang += cell.amountSatang;
    } else if (category.categoryKey === "other_cash") {
      // Items win when they exist (below) — the cell is only the fallback
      // for a day with zero itemized other-income rows.
      if (!hasOtherIncomeItems) otherCashSatang += cell.amountSatang;
    } else {
      // Any other isCash category — a custom manager-created one — always
      // counts by its typed cell, independent of otherIncomeItems.
      otherCashSatang += cell.amountSatang;
    }
  }

  if (hasOtherIncomeItems) {
    otherCashSatang += otherIncomeItems
      .filter((item) => item.isCash)
      .reduce((sum, item) => sum + item.amountSatang, 0);
  }

  const { depositCashInSatang, depositCashOutSatang } = depositCashTotals(depositEvents);

  return {
    roomCashSatang,
    otherCashSatang,
    barCashSatang,
    bankedSatang:
      roomCashSatang +
      otherCashSatang +
      barCashSatang +
      depositCashInSatang -
      depositCashOutSatang -
      (heldBackSatang ?? 0) +
      (broughtForwardSatang ?? 0),
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
