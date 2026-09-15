import { describe, expect, test } from 'bun:test';
import { expenseOrigin } from './expenseOrigin.ts';

describe('expense source during journal recovery', () => {
  test('a posted payroll or reimbursement expense stays source-managed before its AP payment link exists', () => {
    expect(expenseOrigin({ by: 'payroll@system.thehfhotel.org' })).toBe('payroll');
    expect(expenseOrigin({ by: 'reimbursement@system.thehfhotel.org' })).toBe('reimbursement');
  });

  test('authoritative source links keep the correct source even when actor is absent or differs', () => {
    expect(expenseOrigin({ payrollRowId: 'payroll-sample', by: null })).toBe('payroll');
    expect(expenseOrigin({ reimbursementRowId: 'receipt-sample', by: 'payroll@system.thehfhotel.org' })).toBe('reimbursement');
  });

  test('ordinary and legacy salary expenses remain manual; reserved attribution must match exactly', () => {
    for (const by of [null, 'sample@example.com', 'payroll@example.com',
      'payroll@system.thehfhotel.org.attacker.invalid', ' payroll@system.thehfhotel.org']) {
      expect(expenseOrigin({ by })).toBe('manual');
    }
  });

  test('manual reuse skips imported payments even when the payroll journal is not yet linked', () => {
    const newestFirst = [
      { id: 'sample-payroll', categoryCode: 'salary', by: 'payroll@system.thehfhotel.org', amountSatang: 6000000 },
      { id: 'sample-manual', categoryCode: 'salary', by: 'sample@example.com', amountSatang: 10000 },
    ];
    const suggestion = newestFirst.find(row => row.categoryCode === 'salary' && expenseOrigin(row) === 'manual');
    expect(suggestion?.id).toBe('sample-manual');
    expect(suggestion?.amountSatang).toBe(10000);
  });
});
