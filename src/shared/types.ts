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

export interface Category {
  id: number;
  property: Property;
  kind: CategoryKind;
  nameTh: string;
  sort: number;
  isCash: boolean;
  archivedAt: string | null;
  createdAt: string;
}

/** One income cell for a (property, date, category). Keyed by categoryId in
 * DaySheet.income — see api.md endpoint 7/8. */
export interface IncomeCell {
  categoryId: number;
  amountSatang: number;
  note: string | null;
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

export interface DayTotals {
  incomeSatang: number;
  expenseSatang: number;
  cashIncomeSatang: number;
  cashExpenseSatang: number;
  /** cashIncomeSatang - cashExpenseSatang — what front desk deposits to the bank. */
  cashToDepositSatang: number;
  netSatang: number;
}

/**
 * The full day sheet as returned by GET /api/:property/day/:date — see
 * api.md. `categories` is active categories of both kinds for the property,
 * plus any archived category referenced by this day's data (archivedAt
 * non-null flags it). Totals are ALWAYS server-computed via
 * computeDayTotals() in totals.ts — the client imports the SAME function so
 * UI and API can never disagree.
 */
export interface DaySheet {
  categories: Category[];
  income: Record<number, IncomeCell>;
  expenses: ExpenseItem[];
  note: string | null;
  totals: DayTotals;
  updatedAt: string;
  updatedBy: string;
}

/** One row in the /:property/history month view. */
export interface DaySummary {
  date: string;
  incomeSatang: number;
  expenseSatang: number;
  cashToDepositSatang: number;
}

export interface Me {
  email: string;
  isManager: boolean;
}

// ── Server-enforced bounds (validated server-side; see api.md) ────────────
export const AMOUNT_SATANG_MIN = 0;
export const AMOUNT_SATANG_MAX = 99_999_999_999;
export const NOTE_MAX_LEN = 200;
export const NAME_TH_MIN_LEN = 1;
export const NAME_TH_MAX_LEN = 80;
