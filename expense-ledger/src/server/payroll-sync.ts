import { isValidIso, todayBangkok } from '@shared/date.ts';
import { lastDayOfMonth, type ApRow, type ApRowInput } from '../shared/apTypes.ts';
import type { ExpenseTransaction } from '../shared/types.ts';
import * as ap from './apStore.ts';
import { createApPaymentTransaction, findSourceApPayment, type CreateApPaymentTransactionInput } from './engine.ts';
import { enqueueAnalyticsPush } from './analytics-push.ts';
import { withApWriteLock } from './ap-write-lock.ts';

const ACTOR = 'payroll@system.thehfhotel.org';
const STATUSES = ['PENDING', 'APPROVED', 'SCHEDULED', 'PAID', 'REJECTED', 'FAILED'] as const;
/** Aggregate transfer batch only: no employee names, accounts or individual pay. */
export interface SourcePayrollRun {
  id: string;
  period: string;
  submittedAt: string;
  effectiveDate: string;
  amountSatang: number;
  employeeCount: number;
  status: typeof STATUSES[number];
  /** Actual Bangkok bank settlement date. Scheduling/uploading is not payment. */
  paidDate: string | null;
}
interface Snapshot { version: 1; complete: true; since: string; generatedAt: string; items: SourcePayrollRun[] }
interface Link { run_id: string; row_id: string; payload: string; attempted: number; error: string | null }
const isoInstant = (s: unknown): s is string => typeof s === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const bangkokDate = (s: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(s));

export function validatePayrollSnapshot(value: unknown, since: string): Snapshot {
  const snapshot = value as Snapshot;
  if (!isoInstant(since) || !snapshot || snapshot.version !== 1 || snapshot.complete !== true || snapshot.since !== since
    || !isoInstant(snapshot.generatedAt) || Date.parse(snapshot.generatedAt) > Date.now() + 60_000
    || !Array.isArray(snapshot.items) || snapshot.items.length > 5000) {
    throw new Error('Invalid complete payroll snapshot');
  }
  const ids = new Set<string>();
  for (const run of snapshot.items) {
    if (!run || typeof run.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(run.id) || ids.has(run.id)
      || typeof run.period !== 'string' || !/^\d{4}-\d{2}$/.test(run.period) || !isValidIso(`${run.period}-01`)
      || !isoInstant(run.submittedAt) || run.submittedAt < since || run.submittedAt > snapshot.generatedAt || !isValidIso(run.effectiveDate)
      || !Number.isSafeInteger(run.amountSatang) || run.amountSatang < 1 || run.amountSatang > 99_999_999_999
      || !Number.isSafeInteger(run.employeeCount) || run.employeeCount < 1 || run.employeeCount > 100_000
      || !STATUSES.includes(run.status)
      || (run.status === 'PAID' ? typeof run.paidDate !== 'string' || !isValidIso(run.paidDate)
        || run.paidDate > bangkokDate(snapshot.generatedAt) || run.paidDate > todayBangkok()
        || run.paidDate < bangkokDate(run.submittedAt) : run.paidDate !== null)) {
      throw new Error('Invalid payroll run in snapshot');
    }
    ids.add(run.id);
  }
  // Keep this operational store aggregate-only even if an upstream version
  // accidentally adds employee fields to the response.
  return { version: 1, complete: true, since: snapshot.since, generatedAt: snapshot.generatedAt,
    items: snapshot.items.map(run => ({ id: run.id, period: run.period, submittedAt: run.submittedAt,
      effectiveDate: run.effectiveDate, amountSatang: run.amountSatang, employeeCount: run.employeeCount,
      status: run.status, paidDate: run.paidDate })) };
}

/** A fixed, explicitly reviewed set of historical bank-verified batches.
 * Sorting and field normalization make harmless JSON key/order differences
 * equivalent while binding the approval to every financial/source field. */
export function validatePayrollBackfillManifest(value: unknown, since: string): SourcePayrollRun[] {
  if (!isoInstant(since)) throw new Error('Invalid payroll sync start');
  if (value === undefined) return [];
  const keys = ['id', 'period', 'submittedAt', 'effectiveDate', 'amountSatang', 'employeeCount', 'status', 'paidDate'];
  if (!Array.isArray(value) || value.length > 100 || value.some(run => !run || typeof run !== 'object'
    || Array.isArray(run) || Object.keys(run).length !== keys.length || Object.keys(run).some(key => !keys.includes(key)))) {
    throw new Error('Invalid payroll backfill manifest');
  }
  const retrievalSince = value.reduce((earliest, run) =>
    isoInstant(run.submittedAt) && run.submittedAt < earliest ? run.submittedAt : earliest, since);
  const items = validatePayrollSnapshot({ version: 1, complete: true, since: retrievalSince,
    generatedAt: new Date().toISOString(), items: value }, retrievalSince).items;
  if (items.some(run => run.status !== 'PAID' || run.submittedAt >= since)) {
    throw new Error('Payroll backfill requires approved historical paid batches');
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export function payrollRetrievalSince(since: string, manifest: readonly SourcePayrollRun[]): string {
  return manifest.reduce((earliest, run) => run.submittedAt < earliest ? run.submittedAt : earliest, since);
}

function db() {
  const d = ap.getApDbForPayroll();
  d.exec(`CREATE TABLE IF NOT EXISTS _payroll_runs (
    run_id TEXT PRIMARY KEY, row_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
    attempted INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE IF NOT EXISTS _payroll_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return d;
}
function meta(key: string, value: string) {
  db().query('INSERT INTO _payroll_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
function links(): Link[] { return db().query('SELECT * FROM _payroll_runs').all() as Link[]; }
export function isPayrollRow(id: string): boolean {
  return !!db().query('SELECT 1 FROM _payroll_runs WHERE row_id=?').get(id);
}
export function payrollExpenseView(row: ExpenseTransaction): ExpenseTransaction {
  const match = db().query(`SELECT r.row_id FROM _payroll_runs r JOIN ap_payment p ON p.row_id=r.row_id WHERE p.transaction_id=?`)
    .get(row.id) as { row_id: string } | null;
  return match ? { ...row, payrollRowId: match.row_id } : row;
}
export function payrollRowView(row: ApRow): ApRow {
  const link = db().query('SELECT * FROM _payroll_runs WHERE row_id=?').get(row.id) as Link | null;
  if (!link) return row;
  const run = JSON.parse(link.payload) as SourcePayrollRun;
  return { ...row, payroll: { runId: run.id, period: run.period, effectiveDate: run.effectiveDate,
    employeeCount: run.employeeCount, status: run.status, error: link.error !== null, paidDate: run.paidDate } };
}
export function payrollSyncStatus() {
  try {
    if (!config()) return { enabled: false };
  } catch {
    // A malformed optional secret disables payroll writes, not the AP page
    // or the other integrations. Never expose its JSON/parser error payload.
    return { enabled: true, lastSuccess: null, error: 'Payroll sync configuration is invalid' };
  }
  const values = Object.fromEntries((db().query('SELECT key,value FROM _payroll_meta').all() as { key: string; value: string }[])
    .map(r => [r.key, r.value]));
  const rows = links();
  return { enabled: true, since: values.since ?? null, lastSuccess: values.lastSuccess ?? null,
    error: values.error || null, runs: rows.length, issues: rows.filter(r => r.error).length,
    backfillRunCount: values.backfillManifest ? (JSON.parse(values.backfillManifest) as SourcePayrollRun[]).length : 0 };
}
export function payrollToAp(run: SourcePayrollRun): ApRowInput {
  const period = new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' })
    .format(new Date(`${run.period}-01T00:00:00.000Z`));
  return { creditor: 'เงินเดือนพนักงาน', item: `เงินเดือน ${period}`, amountSatang: run.amountSatang,
    vatSatang: null, whtSatang: null, discountSatang: 0, dueDate: run.effectiveDate,
    // วันที่ลงบิล = the LAST DAY of the batch's own period (ADR-0001): a July
    // batch is July ต้นทุน however late in August it was submitted, filed or
    // settled. Never effectiveDate/paidDate (payment dates) and never the
    // filing date.
    billDate: lastDayOfMonth(run.period),
    entity: 'รวมทุกโรงแรม', categoryCode: 'salary',
    note: `ยอดโอนสุทธิเงินเดือน ${period}\nพนักงาน ${run.employeeCount} คน\nรอบเงินเดือน ${run.id}` };
}

interface SyncDeps {
  post: (p: CreateApPaymentTransactionInput) => Promise<string>;
  find: (p: CreateApPaymentTransactionInput) => Promise<string | null>;
  enqueue: (month: string) => void;
}
const defaultDeps: SyncDeps = { post: createApPaymentTransaction, find: findSourceApPayment, enqueue: enqueueAnalyticsPush };

export async function reconcilePayrollSnapshot(value: unknown, since: string, deps: SyncDeps = defaultDeps,
  options: { backfillManifest?: unknown } = {}) {
  return withApWriteLock(async () => {
    // Perform every scope/approval check while holding the same lock as AP
    // writes. No pin, automatic row or historical payable changes unless the
    // complete source snapshot matches every approved historical batch.
    const manifest = validatePayrollBackfillManifest(options.backfillManifest, since);
    const snapshot = validatePayrollSnapshot(value, payrollRetrievalSince(since, manifest));
    const sourceById = new Map(snapshot.items.map(run => [run.id, run]));
    for (const approved of manifest) {
      const source = sourceById.get(approved.id);
      if (!source || JSON.stringify(source) !== JSON.stringify(approved)) {
        throw new Error('Approved payroll backfill batch is missing or changed');
      }
    }
    const approvedIds = new Set(manifest.map(run => run.id));
    const selected = snapshot.items.filter(run => run.submittedAt >= since || approvedIds.has(run.id));
    const d = db();
    const scope = d.query("SELECT value FROM _payroll_meta WHERE key='since'").get() as { value: string } | null;
    if (scope && scope.value !== since) throw new Error('Payroll sync start changed; explicit reconciliation required');
    const pinned = d.query("SELECT value FROM _payroll_meta WHERE key='backfillManifest'").get() as { value: string } | null;
    const canonicalManifest = JSON.stringify(manifest);
    if (pinned && pinned.value !== canonicalManifest) {
      throw new Error('Payroll backfill approval changed or removed; explicit reconciliation required');
    }
    d.transaction(() => {
      meta('since', since);
      if (!pinned && manifest.length) meta('backfillManifest', canonicalManifest);
    })();
    let issues = 0;
    for (const run of selected) {
      const rowId = `payroll-${run.id}`;
      try {
        const existing = d.query('SELECT * FROM _payroll_runs WHERE run_id=?').get(run.id) as Link | null;
        const before = ap.getApRow(rowId);
        if (existing && before && !existing.error && existing.payload === JSON.stringify(run)
          && (run.status !== 'PAID' || before.payments.length > 0)) continue;
        if (existing) {
          const old = JSON.parse(existing.payload) as SourcePayrollRun;
          if (old.submittedAt !== run.submittedAt) throw new Error('Payroll submission identity changed');
          // A bank post may have succeeded even when its response was lost.
          // Preserve the journal payload for exact recovery in either case.
          if ((existing.attempted || before?.payments.length)
            && (old.amountSatang !== run.amountSatang || old.paidDate !== run.paidDate
              || old.period !== run.period || old.effectiveDate !== run.effectiveDate
              || old.employeeCount !== run.employeeCount || run.status !== 'PAID')) {
            throw new Error('Payroll source changed after settlement began');
          }
        }
        // Only an explicit rejection can remove an unpaid payroll payable.
        // An absent or FAILED upload is ambiguous and must stay visible.
        if (run.status === 'REJECTED') {
          if (!existing) {
            if (before) throw new Error('Payroll row identity already exists');
            continue;
          }
          d.transaction(() => {
            ap.deleteApRow(rowId);
            d.query('DELETE FROM _payroll_runs WHERE run_id=?').run(run.id);
          })();
          if (before) deps.enqueue(before.billDate.slice(0, 7));
          continue;
        }
        const input = payrollToAp(run);
        d.transaction(() => {
          if (!existing) {
            if (before) throw new Error('Payroll row identity already exists');
            ap.createApRow(input, ACTOR, { id: rowId, filedDate: bangkokDate(run.submittedAt) });
            d.query('INSERT INTO _payroll_runs(run_id,row_id,payload) VALUES (?,?,?)').run(run.id, rowId, JSON.stringify(run));
          } else {
            if (!before) throw new Error('Linked payroll row is missing');
            if (!existing.attempted && !before.payments.length) ap.updateApRow(rowId, input);
            d.query('UPDATE _payroll_runs SET payload=?,error=NULL WHERE run_id=?').run(JSON.stringify(run), run.id);
          }
        })();
        const row = ap.getApRow(rowId)!;
        // A corrected period MOVES วันที่ลงบิล, so the batch leaves one งวด and
        // joins another. Restate BOTH months (as the PATCH route does):
        // pushing only the new one leaves the old งวด still holding a bill it
        // no longer has, and the payroll cost is counted twice.
        if (before && before.billDate !== row.billDate) deps.enqueue(before.billDate.slice(0, 7));
        deps.enqueue(row.billDate.slice(0, 7));
        if (run.status === 'FAILED') throw new Error('Payroll bank outcome needs review');
        if (run.status !== 'PAID' || row.payments.length) continue;
        const payment: CreateApPaymentTransactionInput = { apRowId: rowId, date: run.paidDate!,
          amountSatang: run.amountSatang, categoryCode: 'salary', paymentMethod: 'bank', email: ACTOR,
          comment: `${input.item} · ยอดโอนสุทธิ ${run.employeeCount} คน` };
        let transactionId = await deps.find(payment);
        if (!transactionId) {
          if (existing?.attempted) throw new Error('Payroll payment posting outcome unknown; review required before retry');
          // Durable intent BEFORE a network POST. Recover by exact engine tag;
          // never issue a second POST after a timeout or a process restart.
          d.query('UPDATE _payroll_runs SET attempted=1 WHERE run_id=?').run(run.id);
          transactionId = await deps.post(payment);
        }
        ap.addApPayment(rowId, { date: payment.date, amountSatang: payment.amountSatang, paymentMethod: 'bank',
          kind: 'full', installmentNumber: null, payerEmail: ACTOR, transactionId });
        deps.enqueue(row.billDate.slice(0, 7));
        deps.enqueue(payment.date.slice(0, 7));
      } catch (error) {
        issues++;
        const message = error instanceof Error ? error.message : 'Payroll sync failed';
        d.query('UPDATE _payroll_runs SET error=? WHERE run_id=?').run(message, run.id);
        console.error('[payroll-sync]', run.id, message);
      }
    }
    const present = new Set(selected.map(run => run.id));
    for (const link of links()) {
      if (present.has(link.run_id)) continue;
      issues++;
      d.query('UPDATE _payroll_runs SET error=? WHERE run_id=?').run('Payroll run disappeared from source; review required', link.run_id);
    }
    meta('lastSuccess', new Date().toISOString());
    meta('error', issues ? `${issues} payroll run(s) need review` : '');
    return { runs: selected.length, issues };
  });
}

function config() {
  const url = process.env.PAYROLL_FEED_URL, token = process.env.PAYROLL_FEED_TOKEN, since = process.env.PAYROLL_SYNC_SINCE;
  if (!url || !token || !since) return null;
  if (!isoInstant(since)) throw new Error('Invalid PAYROLL_SYNC_SINCE');
  let manifest: unknown;
  try { manifest = process.env.PAYROLL_BACKFILL_MANIFEST ? JSON.parse(process.env.PAYROLL_BACKFILL_MANIFEST) : undefined; }
  catch { throw new Error('Invalid PAYROLL_BACKFILL_MANIFEST'); }
  const backfillManifest = validatePayrollBackfillManifest(manifest, since);
  return { url: url.replace(/\/+$/, ''), token, since, backfillManifest,
    retrievalSince: payrollRetrievalSince(since, backfillManifest) };
}
let started = false;
export function startPayrollSync() {
  if (started) return;
  try {
    if (!config()) return;
  } catch {
    console.error('[payroll-sync] configuration invalid');
    try { meta('error', 'Payroll sync configuration is invalid'); } catch { /* keep the ledger available */ }
    return;
  }
  started = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const c = config()!;
      const response = await fetch(`${c.url}/payroll?since=${encodeURIComponent(c.retrievalSince)}`, {
        headers: { authorization: `Bearer ${c.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Payroll feed HTTP ${response.status}`);
      await reconcilePayrollSnapshot(await response.json(), c.since, defaultDeps, { backfillManifest: c.backfillManifest });
    } catch (error) {
      console.error('[payroll-sync] snapshot failed', error instanceof Error ? error.message : error);
      try { meta('error', 'Payroll feed unavailable or reconciliation failed'); } catch { /* retry next tick */ }
    } finally { running = false; }
  };
  void tick();
  setInterval(() => void tick(), 30_000).unref();
}
