import type { Category, DayTotals, ExpenseItem, IncomeCell } from "./types.ts";

/**
 * Single source of truth for day-sheet totals. The server computes this on
 * every read/write (GET day, PUT income cell, expense CRUD) and the client
 * imports the SAME function so the UI and API can never disagree — see
 * src/shared/api.md.
 */
export function computeDayTotals(
  categories: Category[],
  income: Record<number, IncomeCell>,
  expenses: ExpenseItem[],
): DayTotals {
  const cashCategoryIds = new Set(
    categories.filter((c) => c.isCash).map((c) => c.id),
  );

  let incomeSatang = 0;
  let cashIncomeSatang = 0;
  for (const cell of Object.values(income)) {
    incomeSatang += cell.amountSatang;
    if (cashCategoryIds.has(cell.categoryId)) cashIncomeSatang += cell.amountSatang;
  }

  let expenseSatang = 0;
  let cashExpenseSatang = 0;
  for (const item of expenses) {
    expenseSatang += item.amountSatang;
    if (cashCategoryIds.has(item.categoryId)) cashExpenseSatang += item.amountSatang;
  }

  return {
    incomeSatang,
    expenseSatang,
    cashIncomeSatang,
    cashExpenseSatang,
    // cashIncomeSatang IS the paper's "สรุปเงินสดฝากเข้าบัญชี" line.
    // cashToDepositSatang additionally nets off same-day cash expenses —
    // a useful but DIFFERENT figure. The report must label the two
    // distinctly (see src/shared/api.md) rather than print this one under
    // the paper's label, as it does today.
    cashToDepositSatang: cashIncomeSatang - cashExpenseSatang,
    netSatang: incomeSatang - expenseSatang,
  };
}
