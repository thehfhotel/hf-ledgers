import type { ExpenseTransaction } from './types.ts';

export type ExpenseOrigin = 'manual' | 'payroll' | 'reimbursement';

/** The source link is authoritative once the AP journal is complete. A bank
 * expense can exist before that local link is recovered after a lost engine
 * response. Its exact reserved system attribution keeps it read-only and out
 * of manual-entry suggestions during that window, without inventing a row id. */
export function expenseOrigin(
  row: Pick<ExpenseTransaction, 'by' | 'payrollRowId' | 'reimbursementRowId'>,
): ExpenseOrigin {
  if (row.payrollRowId) return 'payroll';
  if (row.reimbursementRowId) return 'reimbursement';
  if (row.by === 'payroll@system.thehfhotel.org') return 'payroll';
  if (row.by === 'reimbursement@system.thehfhotel.org') return 'reimbursement';
  return 'manual';
}
