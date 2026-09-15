import { beforeEach, afterEach, describe, test, expect } from 'bun:test';
import * as ap from './apStore.ts';
import { reconcilePayrollSnapshot, payrollRowView, payrollExpenseView, payrollSyncStatus, validatePayrollSnapshot, type SourcePayrollRun } from './payroll-sync.ts';
import { reconcileSnapshot, type SourceReceipt } from './reimbursement-sync.ts';
import { type CreateApPaymentTransactionInput } from './engine.ts';
import { fetchHandler } from './server.ts';
import { computeExpenseLedgerRollup } from '../shared/rollup.ts';

const SINCE = '2025-09-15T00:00:00.000Z';
const run = (id = 'batch-sample', extra: Partial<SourcePayrollRun> = {}): SourcePayrollRun => ({
  id, period: '2025-09', submittedAt: '2025-09-30T18:00:00.000Z', effectiveDate: '2025-10-02',
  amountSatang: 6000000, employeeCount: 3, status: 'PENDING', paidDate: null, ...extra,
});
const snapshot = (items: SourcePayrollRun[]) => ({ version: 1, complete: true, since: SINCE, generatedAt: '2025-11-02T05:00:00.000Z', items });
let posts: CreateApPaymentTransactionInput[], recovered: string | null, months: string[];
const deps = {
  post: async (payment: CreateApPaymentTransactionInput) => { posts.push(payment); return `engine-${payment.apRowId}`; },
  find: async () => recovered,
  enqueue: (month: string) => { months.push(month); },
};
let originalEnv: Record<string, string | undefined>;
const envKeys = ['AP_DB_PATH', 'NODE_ENV', 'DEV_USER', 'PAYROLL_FEED_URL', 'PAYROLL_FEED_TOKEN', 'PAYROLL_SYNC_SINCE'];
beforeEach(() => {
  originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  ap._resetForTests(); process.env.AP_DB_PATH = ':memory:';
  posts = []; recovered = null; months = [];
});
afterEach(() => {
  ap._resetForTests();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('payroll reconciliation', () => {
  test('one aggregate batch creates one payable, and bank upload/scheduling never books cash', async () => {
    for (const status of ['PENDING', 'APPROVED', 'SCHEDULED'] as const) {
      await reconcilePayrollSnapshot(snapshot([run('sample', { status })]), SINCE, deps);
    }
    const rows = ap.listApRows({ mode: 'all' });
    expect(rows).toHaveLength(1); expect(posts).toHaveLength(0);
    expect(rows[0]!.filedDate).toBe('2025-10-01'); // Bangkok submission day, not UTC or payroll period
    expect(rows[0]!.dueDate).toBe('2025-10-02');
    expect(rows[0]!.categoryCode).toBe('salary'); expect(rows[0]!.outstandingSatang).toBe(6000000);
    expect(rows[0]!.creditor).toBe('เงินเดือนพนักงาน'); expect(rows[0]!.entity).toBe('รวมทุกโรงแรม');
    const rollup = computeExpenseLedgerRollup('2025-10', [], new Set(), rows, '2025-10-02T05:00:00.000Z');
    expect(rollup.filedByEntity.unknown?.grossSatang).toBe(6000000);
    expect(rollup.filedByEntity.hf).toBeUndefined();
    expect(rollup.filedByEntity.hfville).toBeUndefined();
    expect(payrollRowView(rows[0]!).payroll).toMatchObject({ runId: 'sample', employeeCount: 3, status: 'SCHEDULED', error: false });
    months = [];
    await reconcilePayrollSnapshot(snapshot([run('sample', { status: 'SCHEDULED' })]), SINCE, deps);
    expect(months).toEqual([]); // unchanged polling does not fan out analytics work
  });
  test('verified bank settlement pays the same row once using actual payment date', async () => {
    await reconcilePayrollSnapshot(snapshot([run()]), SINCE, deps);
    const paid = snapshot([run('batch-sample', { status: 'PAID', paidDate: '2025-11-01' })]);
    await reconcilePayrollSnapshot(paid, SINCE, deps); await reconcilePayrollSnapshot(paid, SINCE, deps);
    const row = ap.getApRow('payroll-batch-sample')!;
    expect(posts).toHaveLength(1); expect(row.payments).toHaveLength(1); expect(row.outstandingSatang).toBe(0);
    expect(row.filedDate).toBe('2025-10-01'); expect(row.settledAt).toBe('2025-11-01');
    expect(posts[0]).toMatchObject({ amountSatang: 6000000, date: '2025-11-01', paymentMethod: 'bank', categoryCode: 'salary' });
    expect(months).toContain('2025-10'); expect(months).toContain('2025-11');
    const view = payrollExpenseView({ id: row.payments[0]!.transactionId, date: '2025-11-01', amountSatang: 6000000,
      categoryCode: 'salary', paymentMethod: 'bank', comment: 'ตัวอย่าง', by: null, photos: [] });
    expect(view.payrollRowId).toBe(row.id); expect(view.reimbursementRowId).toBeUndefined();
  });
  test('concurrent snapshots share the AP lock and cannot double-post', async () => {
    const paid = snapshot([run('batch-sample', { status: 'PAID', paidDate: '2025-10-02' })]);
    await Promise.all([reconcilePayrollSnapshot(paid, SINCE, deps), reconcilePayrollSnapshot(paid, SINCE, deps)]);
    expect(posts).toHaveLength(1); expect(ap.getApRow('payroll-batch-sample')!.payments).toHaveLength(1);
  });
  test('a lost engine response journals intent and only exact recovery can settle later', async () => {
    const paid = snapshot([run('batch-sample', { status: 'PAID', paidDate: '2025-10-02' })]);
    let calls = 0;
    const uncertain = { ...deps, post: async () => { calls++; throw new Error('sample lost response'); } };
    expect((await reconcilePayrollSnapshot(paid, SINCE, uncertain)).issues).toBe(1);
    expect((await reconcilePayrollSnapshot(paid, SINCE, uncertain)).issues).toBe(1);
    expect(calls).toBe(1); expect(ap.getApRow('payroll-batch-sample')!.payments).toHaveLength(0);
    recovered = 'sample-recovered-payment';
    expect((await reconcilePayrollSnapshot(paid, SINCE, uncertain)).issues).toBe(0);
    expect(calls).toBe(1); expect(ap.getApRow('payroll-batch-sample')!.payments[0]!.transactionId).toBe(recovered);
  });
  test('changed settled or attempted financial data stays intact and needs review', async () => {
    const paid = run('batch-sample', { status: 'PAID', paidDate: '2025-10-02' });
    await reconcilePayrollSnapshot(snapshot([paid]), SINCE, deps);
    for (const patch of [{ amountSatang: 9000000 }, { paidDate: '2025-10-03' }, { period: '2025-08' },
      { effectiveDate: '2025-10-05' }, { employeeCount: 4 }, { status: 'REJECTED' as const, paidDate: null }]) {
      expect((await reconcilePayrollSnapshot(snapshot([{ ...paid, ...patch }]), SINCE, deps)).issues).toBe(1);
      expect(ap.getApRow('payroll-batch-sample')!.grossSatang).toBe(6000000);
      expect(payrollRowView(ap.getApRow('payroll-batch-sample')!).payroll?.paidDate).toBe('2025-10-02');
    }
    expect(posts).toHaveLength(1);
  });
  test('only explicit rejection removes unpaid rows; omission or failed upload retains a visible issue', async () => {
    await reconcilePayrollSnapshot(snapshot([run('missing'), run('rejected'), run('failed')]), SINCE, deps);
    const result = await reconcilePayrollSnapshot(snapshot([run('rejected', { status: 'REJECTED' }), run('failed', { status: 'FAILED' })]), SINCE, deps);
    expect(result.issues).toBe(2); expect(ap.getApRow('payroll-rejected')).toBeNull();
    for (const id of ['missing', 'failed']) {
      const row = ap.getApRow(`payroll-${id}`)!;
      expect(row.outstandingSatang).toBe(6000000); expect(payrollRowView(row).payroll?.error).toBe(true);
    }
    expect(posts).toHaveLength(0);
    await reconcilePayrollSnapshot(snapshot([run('missing'), run('failed', { status: 'SCHEDULED' })]), SINCE, deps);
    expect(payrollRowView(ap.getApRow('payroll-failed')!).payroll?.error).toBe(false);
  });
  test('invalid/partial/duplicate/wrong-scope data cannot change existing rows', async () => {
    await reconcilePayrollSnapshot(snapshot([run()]), SINCE, deps);
    const invalid = [
      { ...snapshot([]), complete: false }, snapshot([run(), run()]), snapshot([run('other', { amountSatang: 0.1 })]),
      snapshot([run('other', { amountSatang: 0 })]), snapshot([run('other', { employeeCount: 0 })]),
      snapshot([run('other', { period: '2025-13' })]), snapshot([run('other', { effectiveDate: '2025-02-30' })]),
      snapshot([run('other', { status: 'PAID', paidDate: null })]), snapshot([run('other', { status: 'SCHEDULED', paidDate: '2025-10-02' })]),
      snapshot([run('other', { status: 'PAID', paidDate: '2025-02-30' })]), snapshot([run('other', { submittedAt: '2025-09-14T00:00:00.000Z' })]),
      snapshot([run('other', { submittedAt: '2025-12-01T00:00:00.000Z' })]),
      snapshot([run('other', { status: 'PAID', paidDate: '2025-09-30' })]),
      snapshot([run('other', { status: 'PAID', paidDate: '2025-11-03' })]),
      { ...snapshot([]), generatedAt: new Date(Date.now() + 86_400_000).toISOString() },
    ];
    for (const value of invalid) {
      await expect(reconcilePayrollSnapshot(value, SINCE, deps)).rejects.toThrow();
      expect(ap.listApRows({ mode: 'all' })).toHaveLength(1);
    }
    const later = '2025-09-16T00:00:00.000Z';
    await expect(reconcilePayrollSnapshot({ ...snapshot([]), since: later }, later, deps)).rejects.toThrow('start changed');
    expect(posts).toHaveLength(0);
  });
  test('extra upstream employee information is discarded before it reaches the journal', async () => {
    const value = snapshot([{ ...run(), employeeNames: ['ชื่อทดสอบที่ไม่ควรถูกเก็บ'], accountNumber: 'SAMPLE-ACCOUNT' } as SourcePayrollRun]);
    expect(validatePayrollSnapshot(value, SINCE).items[0]).not.toHaveProperty('employeeNames');
    await reconcilePayrollSnapshot(value, SINCE, deps);
    const payload = (ap.getApDbForPayroll().query('SELECT payload FROM _payroll_runs').get() as { payload: string }).payload;
    expect(payload).not.toContain('employeeNames'); expect(payload).not.toContain('SAMPLE-ACCOUNT');
  });
  test('payroll never replaces reimbursement or manual rows, including matching source ids', async () => {
    const receipt: SourceReceipt = { id: 'same', bundleId: 'sample-request', requestName: 'ใบเสร็จตัวอย่าง', status: 'PENDING',
      submittedAt: '2025-09-30T18:00:00.000Z', paidAt: null, paymentMatchesReceipts: true,
      merchant: 'ร้านตัวอย่าง', claimant: 'ผู้ยื่นตัวอย่าง', category: 'อื่น ๆ', property: 'hf-hotel',
      amountSatang: 10000, date: '2025-09-30', note: '', photoCount: 0 };
    await reconcileSnapshot({ ...snapshot([]), items: [receipt] }, SINCE, deps);
    const manualId = ap.createApRow({ creditor: 'เจ้าหนี้ตัวอย่าง', item: 'รายการตัวอย่าง', amountSatang: 10000,
      vatSatang: null, whtSatang: null, discountSatang: 0, dueDate: null, entity: 'HF', categoryCode: 'other', note: '' }, 'sample@example.com');
    await reconcilePayrollSnapshot(snapshot([run('same')]), SINCE, deps);
    await reconcilePayrollSnapshot(snapshot([run('same', { status: 'REJECTED' })]), SINCE, deps);
    expect(ap.getApRow('payroll-same')).toBeNull(); expect(ap.getApRow('reimbursement-same')).not.toBeNull();
    expect(ap.getApRow(manualId)).not.toBeNull(); expect(payrollRowView(ap.getApRow(manualId)!).payroll).toBeUndefined();
  });
  test('payroll AP routes reject manual edits, deletion, payment and attachment writes', async () => {
    await reconcilePayrollSnapshot(snapshot([run()]), SINCE, deps);
    process.env.NODE_ENV = 'development'; process.env.DEV_USER = 'sample@example.com';
    for (const [method, suffix] of [['PATCH', ''], ['DELETE', ''], ['POST', '/payments'], ['DELETE', '/payments/sample'],
      ['POST', '/photos'], ['DELETE', '/photos/sample']]) {
      const response = await fetchHandler(new Request(`http://localhost/api/ap/rows/payroll-batch-sample${suffix}`, { method }));
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'payroll_managed' });
    }
    const list = await fetchHandler(new Request('http://localhost/api/ap/rows?f=all'));
    expect((await list.json()).rows[0].payroll.runId).toBe('batch-sample');
  });
  test('sync status exposes counts and failures without credentials and stays authenticated', async () => {
    delete process.env.PAYROLL_FEED_URL; expect(payrollSyncStatus()).toEqual({ enabled: false });
    process.env.PAYROLL_FEED_URL = 'http://example.invalid/payroll-feed';
    process.env.PAYROLL_FEED_TOKEN = 'example-test-only-token'; process.env.PAYROLL_SYNC_SINCE = SINCE;
    await reconcilePayrollSnapshot(snapshot([run('sample', { status: 'FAILED' })]), SINCE, deps);
    const status = payrollSyncStatus();
    expect(status).toMatchObject({ enabled: true, since: SINCE, runs: 1, issues: 1 });
    expect(JSON.stringify(status)).not.toContain('example-test-only-token');
    process.env.NODE_ENV = 'production'; delete process.env.DEV_USER;
    expect((await fetchHandler(new Request('http://localhost/api/payroll/status'))).status).toBe(401);
    process.env.NODE_ENV = 'development'; process.env.DEV_USER = 'sample@example.com';
    const response = await fetchHandler(new Request('http://localhost/api/payroll/status'));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(status);
  });
});
