import { beforeEach, afterEach, describe, test, expect } from 'bun:test';
import * as ap from './apStore.ts';
import { reconcileSnapshot, reimbursementRowView, validateSnapshot, type SourceReceipt } from './reimbursement-sync.ts';
import { fetchHandler } from './server.ts';

const SINCE = '2026-09-15T00:00:00.000Z';
const receipt = (id: string, extra: Partial<SourceReceipt> = {}): SourceReceipt => ({
  id, bundleId: 'request-sample', status: 'PENDING', submittedAt: '2026-09-15T18:00:00.000Z', paidAt: null,
  paymentMatchesReceipts: true, merchant: 'ร้านทดสอบ', claimant: 'พนักงานทดสอบ', category: 'ต้นทุนอาหารเช้า HF',
  property: 'hf-hotel', amountSatang: 12345, date: '2026-09-10', note: 'ตัวอย่าง', photoCount: 2, ...extra,
});
const snapshot = (items: SourceReceipt[]) => ({ version: 1, complete: true, since: SINCE, generatedAt: '2026-09-16T00:00:00.000Z', items });
let posts: string[], recovered: string | null;
const deps = {
  post: async (p: { apRowId: string }) => { posts.push(p.apRowId); return 'engine-sample'; },
  find: async () => recovered,
  enqueue: (_: string) => {},
};
let originalPath: string | undefined;
beforeEach(() => { originalPath = process.env.AP_DB_PATH; ap._resetForTests(); process.env.AP_DB_PATH = ':memory:'; posts = []; recovered = null; });
afterEach(() => { ap._resetForTests(); if (originalPath === undefined) delete process.env.AP_DB_PATH; else process.env.AP_DB_PATH = originalPath; });

describe('reimbursement reconciliation', () => {
  test('one request with two receipts creates two unpaid AP rows, repeated snapshots create none', async () => {
    const s = snapshot([receipt('a'), receipt('b', { property: 'hf-ville' })]);
    await reconcileSnapshot(s, SINCE, deps); await reconcileSnapshot(s, SINCE, deps);
    const rows = ap.listApRows({ mode: 'all' });
    expect(rows).toHaveLength(2); expect(posts).toHaveLength(0);
    expect(rows.reduce((n, r) => n + r.outstandingSatang, 0)).toBe(24690);
    expect(rows.every(r => r.filedDate === '2026-09-16')).toBe(true); // Bangkok, not UTC/purchase date
    const view = reimbursementRowView(rows[0]!);
    expect(view.reimbursement?.bundleId).toBe('request-sample'); expect(view.photos).toHaveLength(2);
  });
  test('paid status settles the SAME rows once using paid date and keeps filing month', async () => {
    await reconcileSnapshot(snapshot([receipt('a'), receipt('b')]), SINCE, deps);
    const paid = { status: 'PAID' as const, paidAt: '2026-10-01T01:00:00.000Z' };
    const s = snapshot([receipt('a', paid), receipt('b', paid)]);
    await reconcileSnapshot(s, SINCE, deps); await reconcileSnapshot(s, SINCE, deps);
    const rows = ap.listApRows({ mode: 'all' });
    expect(rows).toHaveLength(2); expect(posts).toHaveLength(2);
    for (const r of rows) { expect(r.outstandingSatang).toBe(0); expect(r.settledAt).toBe('2026-10-01'); expect(r.filedDate).toBe('2026-09-16'); expect(r.payments).toHaveLength(1); }
  });
  test('concurrent passes cannot post twice', async () => {
    const s = snapshot([receipt('a', { status: 'PAID', paidAt: '2026-09-17T01:00:00.000Z' })]);
    await Promise.all([reconcileSnapshot(s, SINCE, deps), reconcileSnapshot(s, SINCE, deps)]);
    expect(posts).toHaveLength(1);
  });
  test('lost POST response never triggers another POST; durable engine match completes it', async () => {
    const s = snapshot([receipt('a', { status: 'PAID', paidAt: '2026-09-17T01:00:00.000Z' })]);
    let calls = 0;
    const uncertain = { ...deps, post: async () => { calls++; throw new Error('lost response'); } };
    expect((await reconcileSnapshot(s, SINCE, uncertain)).issues).toBe(1);
    expect((await reconcileSnapshot(s, SINCE, uncertain)).issues).toBe(1); expect(calls).toBe(1);
    recovered = 'durable-engine-id';
    expect((await reconcileSnapshot(s, SINCE, uncertain)).issues).toBe(0); expect(calls).toBe(1);
    expect(ap.getApRow('reimbursement-a')!.payments[0]!.transactionId).toBe('durable-engine-id');
  });
  test('withdrawal removes only the synced unpaid row; a paid row is preserved for review', async () => {
    await reconcileSnapshot(snapshot([receipt('a'), receipt('b', { status: 'PAID', paidAt: '2026-09-17T01:00:00.000Z' })]), SINCE, deps);
    expect((await reconcileSnapshot(snapshot([]), SINCE, deps)).issues).toBe(1);
    expect(ap.getApRow('reimbursement-a')).toBeNull(); expect(ap.getApRow('reimbursement-b')!.payments).toHaveLength(1);
  });
  test('partial, duplicate, invalid and wrong-scope snapshots cannot remove existing rows', async () => {
    await reconcileSnapshot(snapshot([receipt('a')]), SINCE, deps);
    for (const s of [{ ...snapshot([]), complete: false }, snapshot([receipt('a'), receipt('a')]),
      snapshot([receipt('bad', { amountSatang: 0.1 })]), snapshot([receipt('bad', { paidAt: 'bad' })])]) {
      await expect(reconcileSnapshot(s, SINCE, deps)).rejects.toThrow();
      expect(ap.getApRow('reimbursement-a')).not.toBeNull();
    }
    await expect(reconcileSnapshot({ ...snapshot([]), since: '2026-09-16T00:00:00.000Z' }, '2026-09-16T00:00:00.000Z', deps)).rejects.toThrow('start changed');
  });
  test('unknown categories and mismatched payments stay unpaid and visible as issues', async () => {
    const paid = { status: 'PAID' as const, paidAt: '2026-09-17T01:00:00.000Z' };
    const result = await reconcileSnapshot(snapshot([receipt('a', { ...paid, category: 'หมวดใหม่' }), receipt('b', { ...paid, paymentMatchesReceipts: false })]), SINCE, deps);
    expect(result.issues).toBe(2); expect(posts).toHaveLength(0);
    expect(reimbursementRowView(ap.getApRow('reimbursement-a')!).reimbursement?.error).toBe(true);
  });
  test('changed paid financial content is flagged without rewriting payment', async () => {
    const paid = { status: 'PAID' as const, paidAt: '2026-09-17T01:00:00.000Z' };
    await reconcileSnapshot(snapshot([receipt('a', paid)]), SINCE, deps);
    expect((await reconcileSnapshot(snapshot([receipt('a', { ...paid, amountSatang: 50000 })]), SINCE, deps)).issues).toBe(1);
    expect(ap.getApRow('reimbursement-a')!.grossSatang).toBe(12345); expect(posts).toHaveLength(1);
  });
  test('manual edit, delete, payment and photo writes to synced rows are rejected', async () => {
    await reconcileSnapshot(snapshot([receipt('a')]), SINCE, deps);
    const old = { node: process.env.NODE_ENV, user: process.env.DEV_USER };
    process.env.NODE_ENV = 'development'; process.env.DEV_USER = 'test@example.com';
    try {
      for (const [method, suffix] of [['PATCH', ''], ['DELETE', ''], ['POST', '/payments'], ['DELETE', '/payments/test'], ['POST', '/photos'], ['DELETE', '/photos/test']]) {
        const res = await fetchHandler(new Request(`http://localhost/api/ap/rows/reimbursement-a${suffix}`, { method }));
        expect(res.status).toBe(409);
      }
    } finally {
      if (old.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old.node;
      if (old.user === undefined) delete process.env.DEV_USER; else process.env.DEV_USER = old.user;
    }
  });
});
