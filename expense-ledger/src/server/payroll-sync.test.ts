import { beforeEach, afterEach, describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ap from './apStore.ts';
import { reconcilePayrollSnapshot, payrollRowView, payrollExpenseView, payrollSyncStatus, validatePayrollSnapshot,
  validatePayrollBackfillManifest, payrollRetrievalSince, type SourcePayrollRun } from './payroll-sync.ts';
import { startPayrollSync } from './payroll-sync.ts';
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
const envKeys = ['AP_DB_PATH', 'NODE_ENV', 'DEV_USER', 'PAYROLL_FEED_URL', 'PAYROLL_FEED_TOKEN', 'PAYROLL_SYNC_SINCE', 'PAYROLL_BACKFILL_MANIFEST'];
beforeEach(() => {
  originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  ap._resetForTests(); process.env.AP_DB_PATH = ':memory:';
  posts = []; recovered = null; months = [];
});

// Deliberately synthetic aggregates; production approvals live only in secret
// configuration, never in this public repository or its fixtures.
const APPROVED_HISTORY: SourcePayrollRun[] = [
  { id: 'sample-historical-a', period: '2025-07', submittedAt: '2025-07-30T18:00:00.000Z',
    effectiveDate: '2025-08-01', amountSatang: 120000, employeeCount: 2, status: 'PAID', paidDate: '2025-08-01' },
  { id: 'sample-historical-b', period: '2025-08', submittedAt: '2025-08-30T18:00:00.000Z',
    effectiveDate: '2025-09-01', amountSatang: 230000, employeeCount: 3, status: 'PAID', paidDate: '2025-09-01' },
];
const historicalSnapshot = (items: SourcePayrollRun[], manifest = APPROVED_HISTORY) => ({
  ...snapshot(items), since: payrollRetrievalSince(SINCE, manifest),
});
const approval = { backfillManifest: APPROVED_HISTORY };
function durableState() {
  const d = ap.getApDbForPayroll();
  return {
    rows: ap.listApRows({ mode: 'all' }),
    links: d.query('SELECT * FROM _payroll_runs ORDER BY run_id').all(),
    meta: d.query('SELECT * FROM _payroll_meta ORDER BY key').all(),
  };
}

describe('approved historical payroll backfill', () => {
  test('only approved paid batches settle once across replay and database reopen; manual salary remains separate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'payroll-approved-backfill-'));
    ap._resetForTests(); process.env.AP_DB_PATH = join(directory, 'ap.db');
    try {
      const manualId = ap.createApRow({ creditor: 'เจ้าหนี้ตัวอย่าง', item: 'ค่าบริการตัวอย่าง', amountSatang: 95000,
        vatSatang: null, whtSatang: null, discountSatang: 0, dueDate: null, entity: 'HF Ville', categoryCode: 'salary', note: '', billDate: '2025-07-12' },
      'sample@example.com', { id: 'sample-manual-salary', filedDate: '2025-07-12' });
      const manualBefore = ap.getApRow(manualId);
      const excluded: SourcePayrollRun[] = ['FAILED', 'REJECTED', 'SCHEDULED', 'PAID'].map((status, index) => ({
        ...APPROVED_HISTORY[0]!, id: `sample-unselected-retry-${index}`, status: status as SourcePayrollRun['status'],
        paidDate: status === 'PAID' ? '2025-08-01' : null,
      }));
      const source = historicalSnapshot([...APPROVED_HISTORY, ...excluded]);
      expect(await reconcilePayrollSnapshot(source, SINCE, deps, approval)).toEqual({ runs: 2, issues: 0 });
      await reconcilePayrollSnapshot(source, SINCE, deps, approval);
      ap._resetForTests(); // the journal and approval must survive a worker restart
      await reconcilePayrollSnapshot(source, SINCE, deps, { backfillManifest: [...APPROVED_HISTORY].reverse()
        .map(item => Object.fromEntries(Object.entries(item).reverse())) });
      expect(posts).toHaveLength(2); expect(ap.listApRows({ mode: 'all' })).toHaveLength(3);
      expect(ap.getApRow(manualId)).toEqual(manualBefore);
      for (const approved of APPROVED_HISTORY) {
        const row = ap.getApRow(`payroll-${approved.id}`)!;
        expect(row.payments).toHaveLength(1); expect(row.settledAt).toBe(approved.paidDate);
        expect(row.outstandingSatang).toBe(0); expect(row.grossSatang).toBe(approved.amountSatang);
      }
      for (const skipped of excluded) expect(ap.getApRow(`payroll-${skipped.id}`)).toBeNull();
      expect((ap.getApDbForPayroll().query("SELECT value FROM _payroll_meta WHERE key='since'").get() as { value: string }).value).toBe(SINCE);
    } finally {
      ap._resetForTests(); rmSync(directory, { recursive: true, force: true });
    }
  });

  test('missing or changed approved source data prevents every historical and automatic write, including first pin', async () => {
    await reconcilePayrollSnapshot(snapshot([run()]), SINCE, deps);
    const before = durableState();
    const changedAuto = run('batch-sample', { amountSatang: 7000000 });
    const changedSources = [
      [APPROVED_HISTORY[0]!],
      APPROVED_HISTORY.map((item, index) => index === 0 ? { ...item, amountSatang: item.amountSatang + 1 } : item),
      APPROVED_HISTORY.map((item, index) => index === 0 ? { ...item, employeeCount: 5 } : item),
      APPROVED_HISTORY.map((item, index) => index === 0 ? { ...item, period: '2025-06' } : item),
      APPROVED_HISTORY.map((item, index) => index === 0 ? { ...item, submittedAt: '2025-07-30T19:00:00.000Z' } : item),
      APPROVED_HISTORY.map((item, index) => index === 0 ? { ...item, effectiveDate: '2025-08-02' } : item),
      APPROVED_HISTORY.map((item, index) => index === 0 ? { ...item, paidDate: '2025-08-02' } : item),
      APPROVED_HISTORY.map((item, index) => index === 0 ? { ...item, status: 'FAILED' as const, paidDate: null } : item),
    ];
    for (const items of changedSources) {
      await expect(reconcilePayrollSnapshot(historicalSnapshot([changedAuto, ...items]), SINCE, deps, approval)).rejects.toThrow('missing or changed');
      expect(durableState()).toEqual(before); expect(posts).toHaveLength(0);
    }
    // Full source validation includes even excluded historical records.
    const invalidUnselected = { ...APPROVED_HISTORY[0]!, id: 'sample-malformed-unselected', amountSatang: 0.001 };
    await expect(reconcilePayrollSnapshot(historicalSnapshot([...APPROVED_HISTORY, invalidUnselected, changedAuto]), SINCE, deps, approval)).rejects.toThrow();
    expect(durableState()).toEqual(before);
  });

  test('pinned approval cannot be removed, reduced or changed even when replacement source data matches', async () => {
    await reconcilePayrollSnapshot(historicalSnapshot(APPROVED_HISTORY), SINCE, deps, approval);
    const before = durableState();
    const future = run('sample-future');
    for (const manifest of [undefined, [], [APPROVED_HISTORY[1]!],
      APPROVED_HISTORY.map((item, index) => index === 0 ? { ...item, amountSatang: item.amountSatang + 1 } : item)]) {
      await expect(reconcilePayrollSnapshot(historicalSnapshot([...(manifest ?? []), future], manifest ?? []), SINCE, deps,
        { backfillManifest: manifest })).rejects.toThrow('approval changed or removed');
      expect(durableState()).toEqual(before); expect(posts).toHaveLength(2);
    }
    const laterCutoff = '2025-09-16T00:00:00.000Z';
    await expect(reconcilePayrollSnapshot(historicalSnapshot([...APPROVED_HISTORY, future]), laterCutoff, deps, approval)).rejects.toThrow('start changed');
    expect(durableState()).toEqual(before);
  });

  test('omitting an approved batch after successful backfill fails before updating an automatic row', async () => {
    await reconcilePayrollSnapshot(historicalSnapshot([...APPROVED_HISTORY, run()]), SINCE, deps, approval);
    const before = durableState();
    await expect(reconcilePayrollSnapshot(historicalSnapshot([APPROVED_HISTORY[0]!, run('batch-sample', { amountSatang: 8000000 })]),
      SINCE, deps, approval)).rejects.toThrow('missing or changed');
    expect(durableState()).toEqual(before); expect(posts).toHaveLength(2);
  });

  test('future automatic rows continue their normal lifecycle while historical approvals stay pinned', async () => {
    const pending = historicalSnapshot([...APPROVED_HISTORY, run('sample-future')]);
    await reconcilePayrollSnapshot(pending, SINCE, deps, approval);
    expect(ap.getApRow('payroll-sample-future')!.outstandingSatang).toBe(6000000);
    expect(posts).toHaveLength(2);
    const paid = historicalSnapshot([...APPROVED_HISTORY, run('sample-future', { status: 'PAID', paidDate: '2025-10-02' })]);
    await reconcilePayrollSnapshot(paid, SINCE, deps, approval); await reconcilePayrollSnapshot(paid, SINCE, deps, approval);
    expect(posts).toHaveLength(3); expect(ap.getApRow('payroll-sample-future')!.payments).toHaveLength(1);
    expect(ap.getApRow('payroll-sample-future')!.filedDate).toBe('2025-10-01');
    expect((await reconcilePayrollSnapshot(historicalSnapshot(APPROVED_HISTORY), SINCE, deps, approval)).issues).toBe(1);
    expect(ap.getApRow('payroll-sample-future')!.payments).toHaveLength(1);
  });

  test('historical payment response loss uses the same durable recovery without another POST', async () => {
    const source = historicalSnapshot(APPROVED_HISTORY);
    const calls: string[] = [];
    const uncertain = { ...deps, post: async (payment: CreateApPaymentTransactionInput) => {
      calls.push(payment.apRowId);
      if (payment.apRowId === `payroll-${APPROVED_HISTORY[0]!.id}`) throw new Error('sample lost response');
      return 'sample-other-confirmed-payment';
    } };
    expect((await reconcilePayrollSnapshot(source, SINCE, uncertain, approval)).issues).toBe(1);
    expect((await reconcilePayrollSnapshot(source, SINCE, uncertain, approval)).issues).toBe(1);
    expect(calls).toHaveLength(2);
    recovered = 'sample-recovered-historical-payment';
    expect((await reconcilePayrollSnapshot(source, SINCE, uncertain, approval)).issues).toBe(0);
    expect(calls).toHaveLength(2);
    expect(ap.getApRow(`payroll-${APPROVED_HISTORY[0]!.id}`)!.payments[0]!.transactionId).toBe(recovered);
  });

  test('competing first approval configurations serialize and only the pinned one can write', async () => {
    const changed = APPROVED_HISTORY.map((item, index) => index === 0 ? { ...item, amountSatang: item.amountSatang + 1 } : item);
    const outcomes = await Promise.allSettled([
      reconcilePayrollSnapshot(historicalSnapshot(APPROVED_HISTORY), SINCE, deps, approval),
      reconcilePayrollSnapshot(historicalSnapshot([...changed, run('sample-new')], changed), SINCE, deps, { backfillManifest: changed }),
    ]);
    expect(outcomes[0]!.status).toBe('fulfilled'); expect(outcomes[1]!.status).toBe('rejected');
    expect(posts).toHaveLength(2); expect(ap.getApRow('payroll-sample-new')).toBeNull();
    expect(ap.getApRow(`payroll-${APPROVED_HISTORY[0]!.id}`)!.grossSatang).toBe(APPROVED_HISTORY[0]!.amountSatang);
  });

  test('manifest schema is aggregate-only, paid-only, historical-only and duplicate-free', () => {
    for (const manifest of [null, {}, [APPROVED_HISTORY[0], APPROVED_HISTORY[0]],
      [{ ...APPROVED_HISTORY[0], status: 'PENDING', paidDate: null }],
      [{ ...APPROVED_HISTORY[0], extraApprovalField: true }],
      [{ ...APPROVED_HISTORY[0], amountSatang: 0.1 }],
      [run('sample-future', { status: 'PAID', paidDate: '2025-10-02' })]]) {
      expect(() => validatePayrollBackfillManifest(manifest, SINCE)).toThrow();
    }
    expect(validatePayrollBackfillManifest(undefined, SINCE)).toEqual([]);
    expect(payrollRetrievalSince(SINCE, APPROVED_HISTORY)).toBe(APPROVED_HISTORY[0]!.submittedAt);
  });

  test('status reports only approved historical count, never the manifest or its financial fields', async () => {
    process.env.PAYROLL_FEED_URL = 'http://example.invalid/payroll-feed';
    process.env.PAYROLL_FEED_TOKEN = 'example-test-only-token'; process.env.PAYROLL_SYNC_SINCE = SINCE;
    process.env.PAYROLL_BACKFILL_MANIFEST = JSON.stringify(APPROVED_HISTORY);
    await reconcilePayrollSnapshot(historicalSnapshot(APPROVED_HISTORY), SINCE, deps, approval);
    const status = payrollSyncStatus();
    expect(status).toMatchObject({ enabled: true, since: SINCE, backfillRunCount: 2, runs: 2, issues: 0 });
    for (const forbidden of ['sample-historical', 'amountSatang', 'employeeCount', 'example-test-only-token', 'backfillManifest']) {
      expect(JSON.stringify(status)).not.toContain(forbidden);
    }
  });

  test('invalid backfill configuration cannot crash startup or AP status and never fetches or posts', async () => {
    process.env.PAYROLL_FEED_URL = 'http://example.invalid/payroll-feed';
    process.env.PAYROLL_FEED_TOKEN = 'example-test-only-token'; process.env.PAYROLL_SYNC_SINCE = SINCE;
    process.env.NODE_ENV = 'development'; process.env.DEV_USER = 'sample@example.com';
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (() => { requests++; throw new Error('Unexpected request for invalid configuration'); }) as unknown as typeof fetch;
    try {
      for (const invalid of ['PRIVATE-SAMPLE-INVALID-JSON', JSON.stringify([{ ...APPROVED_HISTORY[0], privateField: 'PRIVATE-SAMPLE' }])]) {
        process.env.PAYROLL_BACKFILL_MANIFEST = invalid;
        expect(() => startPayrollSync()).not.toThrow();
        expect(payrollSyncStatus()).toEqual({ enabled: true, lastSuccess: null, error: 'Payroll sync configuration is invalid' });
        const response = await fetchHandler(new Request('http://localhost/api/ap/rows?f=all'));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.payrollSync.error).toBe('Payroll sync configuration is invalid');
        expect(JSON.stringify(body)).not.toContain('PRIVATE-SAMPLE');
        expect((await fetchHandler(new Request('http://localhost/healthz'))).status).toBe(200);
      }
      delete process.env.PAYROLL_BACKFILL_MANIFEST; process.env.PAYROLL_SYNC_SINCE = 'PRIVATE-SAMPLE-INVALID-DATE';
      expect(() => startPayrollSync()).not.toThrow();
      expect(payrollSyncStatus().error).toBe('Payroll sync configuration is invalid');
      expect(requests).toBe(0); expect(posts).toHaveLength(0);
    } finally { globalThis.fetch = originalFetch; }
  });
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
    // วันที่ลงบิล = the last day of the period the batch PAID (ADR-0001), so
    // a September batch submitted on 1 October is งวด 2025-09 ต้นทุน.
    expect(rows[0]!.billDate).toBe('2025-09-30');
    expect(rows[0]!.dueDate).toBe('2025-10-02');
    expect(rows[0]!.categoryCode).toBe('salary'); expect(rows[0]!.outstandingSatang).toBe(6000000);
    expect(rows[0]!.creditor).toBe('เงินเดือนพนักงาน'); expect(rows[0]!.entity).toBe('รวมทุกโรงแรม');
    // The งวด the analytics rollup counts it in is 2025-09 — never 2025-10,
    // the month it was filed in.
    expect(computeExpenseLedgerRollup('2025-10', [], new Set(), rows, '2025-10-02T05:00:00.000Z').filedGrossSatang).toBe(0);
    expect(months).toContain('2025-09'); expect(months).not.toContain('2025-10');
    const rollup = computeExpenseLedgerRollup('2025-09', [], new Set(), rows, '2025-10-02T05:00:00.000Z');
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
    expect(row.billDate).toBe('2025-09-30'); // paying in November never moves the September งวด
    expect(posts[0]).toMatchObject({ amountSatang: 6000000, date: '2025-11-01', paymentMethod: 'bank', categoryCode: 'salary' });
    // The row's own งวด (2025-09) plus the month the payment transaction
    // itself lands in (2025-11) — never the filing month.
    expect(months).toContain('2025-09'); expect(months).toContain('2025-11');
    expect(months).not.toContain('2025-10');
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
      vatSatang: null, whtSatang: null, discountSatang: 0, dueDate: null, entity: 'HF', categoryCode: 'other', note: '', billDate: '2025-09-30' }, 'sample@example.com');
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
