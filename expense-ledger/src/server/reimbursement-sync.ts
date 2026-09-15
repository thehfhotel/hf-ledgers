import { isValidIso } from '@shared/date.ts';
import type { ApRow, ApRowInput } from '../shared/apTypes.ts';
import type { ExpenseTransaction } from '../shared/types.ts';
import type { ExpenseCategoryCode } from '../shared/categories.ts';
import * as ap from './apStore.ts';
import { createApPaymentTransaction, findReimbursementPayment, type CreateApPaymentTransactionInput } from './engine.ts';
import { enqueueAnalyticsPush } from './analytics-push.ts';
import { withApWriteLock } from './ap-write-lock.ts';

const ACTOR = 'reimbursement@system.thehfhotel.org';
const STATUSES = ['PENDING', 'APPROVED', 'PAYING', 'PAID'] as const;
export interface SourceReceipt {
  id: string; bundleId: string; status: typeof STATUSES[number]; submittedAt: string;
  paidAt: string | null; paymentMatchesReceipts: boolean; merchant: string; claimant: string;
  category: string; property: 'hf-hotel' | 'hf-ville'; amountSatang: number;
  date: string; note: string; photoCount: number;
}
interface Snapshot { version: 1; complete: true; since: string; generatedAt: string; items: SourceReceipt[] }
interface Link { receipt_id: string; row_id: string; payload: string; attempted: number; error: string | null }
const CATEGORY_MAP: Record<string, ExpenseCategoryCode> = {
  'ต้นทุนอาหารเช้า HF': 'breakfast', 'อุปกรณ์โรงแรม': 'supplies', 'อุปกรณ์แม่บ้าน': 'housekeeping',
  'อุปกรณ์ช่าง': 'supplies', 'บาร์น้ำ': 'water-bar', 'โรงซักผ้า': 'laundry',
  'อุปกรณ์สำนักงาน reception': 'supplies', 'อุปกรณ์สำนักงาน office': 'supplies',
  'ร้านอาทิตย์': 'other', 'อื่น ๆ': 'other',
};
const isoInstant = (s: unknown): s is string => typeof s === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const bangkokDate = (s: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(s));

export function validateSnapshot(value: unknown, since: string): Snapshot {
  const s = value as Snapshot;
  if (!isoInstant(since) || !s || s.version !== 1 || s.complete !== true || s.since !== since
    || !isoInstant(s.generatedAt) || !Array.isArray(s.items) || s.items.length > 5000) throw new Error('Invalid complete receipt snapshot');
  const ids = new Set<string>();
  for (const r of s.items) {
    if (!r || typeof r.id !== 'string' || typeof r.bundleId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(r.id) || !/^[A-Za-z0-9_-]{1,100}$/.test(r.bundleId)
      || ids.has(r.id) || !STATUSES.includes(r.status) || !isoInstant(r.submittedAt) || r.submittedAt < since
      || !isValidIso(r.date) || !Number.isSafeInteger(r.amountSatang) || r.amountSatang < 1 || r.amountSatang > 99_999_999_999
      || !['hf-hotel', 'hf-ville'].includes(r.property) || typeof r.paymentMatchesReceipts !== 'boolean'
      || !Number.isInteger(r.photoCount) || r.photoCount < 0 || r.photoCount > 100
      || ![r.merchant, r.claimant, r.category, r.note].every(v => typeof v === 'string' && v.length <= 10000)
      || (r.status === 'PAID' ? !isoInstant(r.paidAt) : r.paidAt !== null)) throw new Error('Invalid receipt in snapshot');
    ids.add(r.id);
  }
  return s;
}

function db() {
  const d = ap.getApDbForReimbursement();
  d.exec(`CREATE TABLE IF NOT EXISTS _reimbursement_receipts (
    receipt_id TEXT PRIMARY KEY, row_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
    attempted INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE IF NOT EXISTS _reimbursement_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return d;
}
function meta(key: string, value: string) { db().query('INSERT INTO _reimbursement_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
function links(): Link[] { return db().query('SELECT * FROM _reimbursement_receipts').all() as Link[]; }
export function isReimbursementRow(id: string): boolean { return !!db().query('SELECT 1 FROM _reimbursement_receipts WHERE row_id=?').get(id); }

export function reimbursementExpenseView(row: ExpenseTransaction): ExpenseTransaction {
  const match = db().query(`SELECT r.row_id FROM _reimbursement_receipts r JOIN ap_payment p ON p.row_id=r.row_id WHERE p.transaction_id=?`).get(row.id) as { row_id: string } | null;
  return match ? { ...row, reimbursementRowId: match.row_id } : row;
}

export function reimbursementRowView(row: ApRow): ApRow {
  const link = db().query('SELECT * FROM _reimbursement_receipts WHERE row_id=?').get(row.id) as Link | null;
  if (!link) return row;
  const r = JSON.parse(link.payload) as SourceReceipt;
  return { ...row, reimbursement: { receiptId: r.id, bundleId: r.bundleId, status: r.status, error: link.error !== null },
    photos: Array.from({ length: r.photoCount }, (_, i) => ({ id: `reimbursement-${r.id}-${i}`, url: `/api/reimbursement/photos/${r.id}/${i}` })) };
}

export function reimbursementSyncStatus() {
  if (!config()) return { enabled: false };
  const values = Object.fromEntries((db().query('SELECT key,value FROM _reimbursement_meta').all() as {key:string;value:string}[]).map(r => [r.key,r.value]));
  return { enabled: true, since: values.since ?? null, lastSuccess: values.lastSuccess ?? null,
    error: values.error || null, receipts: links().length, issues: links().filter(l => l.error).length };
}

export function receiptToAp(r: SourceReceipt): ApRowInput {
  return { creditor: r.claimant.slice(0, 200), item: r.merchant.slice(0, 200), amountSatang: r.amountSatang,
    vatSatang: null, whtSatang: null, discountSatang: 0, dueDate: null,
    entity: r.property === 'hf-hotel' ? 'HF' : 'HF Ville', categoryCode: Object.hasOwn(CATEGORY_MAP, r.category) ? CATEGORY_MAP[r.category]! : null,
    note: `เบิกจ่าย ${r.bundleId}\nใบเสร็จ ${r.id}\nวันที่ซื้อ ${r.date}\nหมวดเดิม ${r.category}\n${r.note}`.slice(0, 4000) };
}

interface SyncDeps {
  post: (p: CreateApPaymentTransactionInput) => Promise<string>;
  find: (p: CreateApPaymentTransactionInput) => Promise<string | null>;
  enqueue: (month: string) => void;
}
const defaultDeps: SyncDeps = { post: createApPaymentTransaction, find: findReimbursementPayment, enqueue: enqueueAnalyticsPush };

export async function reconcileSnapshot(value: unknown, since: string, deps: SyncDeps = defaultDeps) {
  const snapshot = validateSnapshot(value, since); // BEFORE any write or removal
  return withApWriteLock(async () => {
    const d = db();
    const scope = d.query("SELECT value FROM _reimbursement_meta WHERE key='since'").get() as { value: string } | null;
    if (scope && scope.value !== since) throw new Error('Receipt sync start changed; explicit reconciliation required');
    meta('since', since);
    let issues = 0;
    for (const r of snapshot.items) {
      const rowId = `reimbursement-${r.id}`;
      try {
        const existing = d.query('SELECT * FROM _reimbursement_receipts WHERE receipt_id=?').get(r.id) as Link | null;
        const before = ap.getApRow(rowId);
        if (existing && before && !existing.error && existing.payload === JSON.stringify(r)
          && (r.status !== 'PAID' || before.payments.length > 0)) continue;
        // Paid/attempted financial content is immutable. Never silently rewrite
        // a posted transaction when the upstream source changes or is repaired.
        if (existing && (existing.attempted || before?.payments.length)) {
          const old = JSON.parse(existing.payload) as SourceReceipt;
          if (old.amountSatang !== r.amountSatang || old.paidAt !== r.paidAt || old.category !== r.category
            || old.property !== r.property || old.bundleId !== r.bundleId || r.status !== 'PAID') throw new Error('Source changed after settlement began');
        }
        const input = receiptToAp(r);
        d.transaction(() => {
          if (!existing) {
            if (before) throw new Error('Receipt row identity already exists');
            ap.createApRow(input, ACTOR, { id: rowId, filedDate: bangkokDate(r.submittedAt) });
            d.query('INSERT INTO _reimbursement_receipts(receipt_id,row_id,payload) VALUES (?,?,?)').run(r.id, rowId, JSON.stringify(r));
          } else {
            if (!before) throw new Error('Linked receipt row is missing');
            if (!existing.attempted && !before.payments.length) ap.updateApRow(rowId, input);
            d.query('UPDATE _reimbursement_receipts SET payload=?,error=NULL WHERE receipt_id=?').run(JSON.stringify(r), r.id);
          }
        })();
        const row = ap.getApRow(rowId)!;
        deps.enqueue(row.filedDate.slice(0, 7));
        if (r.status !== 'PAID' || row.payments.length) continue;
        if (!r.paymentMatchesReceipts) throw new Error('Paid request total differs from receipt total');
        if (!input.categoryCode) throw new Error('Receipt category needs an explicit mapping');
        const payment: CreateApPaymentTransactionInput = {
          apRowId: rowId, date: bangkokDate(r.paidAt!), amountSatang: r.amountSatang,
          categoryCode: input.categoryCode, paymentMethod: 'bank', email: ACTOR,
          comment: `เบิกจ่าย ${r.bundleId} / ใบเสร็จ ${r.id}`,
        };
        let transactionId = await deps.find(payment);
        if (!transactionId) {
          if (existing?.attempted) throw new Error('Payment posting outcome unknown; review required before retry');
          // Durable intent BEFORE the network call. After a lost response or a
          // process restart, recover by tag; NEVER blindly post again.
          d.query('UPDATE _reimbursement_receipts SET attempted=1 WHERE receipt_id=?').run(r.id);
          transactionId = await deps.post(payment);
        }
        ap.addApPayment(rowId, { date: payment.date, amountSatang: payment.amountSatang, paymentMethod: 'bank',
          kind: 'full', installmentNumber: null, payerEmail: ACTOR, transactionId });
        deps.enqueue(row.filedDate.slice(0, 7));
        deps.enqueue(payment.date.slice(0, 7));
      } catch (error) {
        issues++;
        const message = error instanceof Error ? error.message : 'Receipt sync failed';
        d.query('UPDATE _reimbursement_receipts SET error=? WHERE receipt_id=?').run(message, r.id);
        console.error('[reimbursement-sync]', r.id, message);
      }
    }
    const present = new Set(snapshot.items.map(r => r.id));
    for (const link of links()) {
      if (present.has(link.receipt_id)) continue;
      const row = ap.getApRow(link.row_id);
      if (link.attempted || row?.payments.length) {
        issues++;
        d.query('UPDATE _reimbursement_receipts SET error=? WHERE receipt_id=?').run('Settled receipt disappeared from source', link.receipt_id);
        continue;
      }
      d.transaction(() => {
        ap.deleteApRow(link.row_id);
        d.query('DELETE FROM _reimbursement_receipts WHERE receipt_id=?').run(link.receipt_id);
      })();
      if (row) deps.enqueue(row.filedDate.slice(0, 7));
    }
    meta('lastSuccess', new Date().toISOString());
    meta('error', issues ? `${issues} receipt(s) need review` : '');
    return { receipts: snapshot.items.length, issues };
  });
}

function config() {
  const url = process.env.REIMBURSEMENT_FEED_URL, token = process.env.REIMBURSEMENT_FEED_TOKEN, since = process.env.REIMBURSEMENT_SYNC_SINCE;
  if (!url || !token || !since) return null;
  if (!isoInstant(since)) throw new Error('Invalid REIMBURSEMENT_SYNC_SINCE');
  return { url: url.replace(/\/+$/, ''), token, since };
}
async function sourceFetch(path: string) {
  const c = config();
  if (!c) throw new Error('Receipt sync is disabled');
  return fetch(`${c.url}${path}`, { headers: { authorization: `Bearer ${c.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
}
export async function reimbursementPhoto(receiptId: string, index: string): Promise<Response> {
  const link = db().query('SELECT payload FROM _reimbursement_receipts WHERE receipt_id=?').get(receiptId) as { payload: string } | null;
  if (!link || !/^\d+$/.test(index) || Number(index) >= (JSON.parse(link.payload) as SourceReceipt).photoCount) return new Response(null, { status: 404 });
  const res = await sourceFetch(`/receipts/${encodeURIComponent(receiptId)}/photos/${index}`);
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !/^image\/(jpeg|png|webp)(;|$)/.test(type)) return new Response(null, { status: 502 });
  return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'private, max-age=300' } });
}
let started = false;
export function startReimbursementSync() {
  if (started || !config()) return;
  started = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const c = config()!;
      const res = await sourceFetch(`/receipts?since=${encodeURIComponent(c.since)}`);
      if (!res.ok) throw new Error(`Receipt feed HTTP ${res.status}`);
      await reconcileSnapshot(await res.json(), c.since);
    } catch (error) {
      console.error('[reimbursement-sync] snapshot failed', error instanceof Error ? error.message : error);
      try { meta('error', 'Receipt feed unavailable or reconciliation failed'); } catch { /* retry next tick */ }
    } finally { running = false; }
  };
  void tick();
  setInterval(() => void tick(), 30_000).unref();
}
