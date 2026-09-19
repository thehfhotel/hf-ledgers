// Outbox-backed pusher to hf-analytics — mirrors the income ledger's
// src/server/analytics-push.ts (hf-ledgers root) exactly where it fits:
// every mutating route in server.ts enqueues the MONTH it touched here, and
// a small interval worker drains the outbox oldest-first, POSTing each
// month's rollup to hf-analytics' locked ingest endpoint
// (POST /api/ingest/expense-ledger, upsert on (month) — re-posting the same
// month is safe/idempotent, replacing every line of that month). If
// hf-analytics is unreachable, months stay queued and retry on the next
// tick.
//
// ENABLED = !!(ANALYTICS_URL && ANALYTICS_TOKEN): with either unset, the
// whole feature — enqueueing AND flushing — stays dormant, so every
// environment that hasn't wired analytics (dev, CI, a fresh deploy before
// secrets land) runs with a completely inert outbox table.
//
// IMPORTING THIS FILE HAS NO SIDE EFFECTS: no DB open, no enqueue, no timer.
// server.ts calls the exported startAnalyticsPush() explicitly, from its
// boot path AFTER the listener is up, never at module load — see
// startAnalyticsPush()'s own doc comment. `GET /healthz` and the rest of
// server boot (everything before the listener comes up) never touch this
// file's DB handle either way.
//
// STORAGE: this app has exactly ONE documented database-of-its-own — the AP
// register's bun:sqlite store (src/server/apStore.ts, `AP_DB_PATH`) — see
// CLAUDE.md's "AP register storage exception". This module's outbox table
// (`_analytics_pending_pushes`) lives in that SAME sqlite file (via
// apStore.ts's `getApDbForAnalytics()`), not a new database, per that
// exception's amendment. Unlike apStore.ts's own tables, this table is
// created here at first actual use (the first enqueue or flush — including
// startAnalyticsPush()'s own boot-month enqueue), deliberately NOT inside
// apStore.ts's own DDL — this is a sibling concern (operational outbox
// state, not AP register data), matching the income ledger's
// analytics-push.ts owning its own table rather than folding it into
// db.ts's migrate(). Because enqueueAnalyticsPush() is called from EVERY
// mutating route (not just /api/ap/*) as well as from startAnalyticsPush(),
// the AP register's sqlite file is lazily opened on the first such call
// once analytics push is enabled — never merely by importing this module,
// and never when analytics push is disabled.

import { getApDbForAnalytics, listApRows } from "./apStore.ts";
import { getMonthExpenseTransactionsWithApManaged } from "./engine.ts";
import { payrollRowView } from "./payroll-sync.ts";
import { reimbursementRowView } from "./reimbursement-sync.ts";
import { computeExpenseLedgerRollup, type ExpenseLedgerRollup } from "../shared/rollup.ts";
import { currentMonthBangkok, shiftMonths } from "@shared/date.ts";

// Read LAZILY (call-time), never at module load — see the income ledger's
// analytics-push.ts for why: bun test runs every file in one process, so
// whichever test file imports server.ts first would otherwise freeze the
// enabled state for all later files.
const urlBase = (): string => (process.env.ANALYTICS_URL ?? "").replace(/\/+$/, "");
const token = (): string => process.env.ANALYTICS_TOKEN ?? "";
const enabled = (): boolean => !!(urlBase() && token());

/** Returns the AP register's lazily-opened sqlite handle, having ensured
 * this module's own outbox table exists on it. Safe to call every time
 * (CREATE TABLE IF NOT EXISTS is cheap) rather than caching an
 * "initialized" flag, so this file needs no module-load-time DDL of its
 * own — see the file header. */
function outboxDb() {
  const db = getApDbForAnalytics();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _analytics_pending_pushes (
      month      TEXT PRIMARY KEY,
      queued_at  TEXT NOT NULL DEFAULT (datetime('now')),
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
  return db;
}

/**
 * Enqueues `month` (Bangkok calendar "YYYY-MM") for push to hf-analytics.
 * Call this from every route in server.ts that changes a transaction's or
 * an AP row's data — see server.ts call sites. No-op when analytics push
 * is disabled. Safe to call more than once for the same month in quick
 * succession: ON CONFLICT bumps queued_at rather than creating a duplicate
 * row, so repeat saves during the same minute coalesce into one push.
 */
export function enqueueAnalyticsPush(month: string): void {
  if (!enabled()) return;
  outboxDb()
    .query(
      `INSERT INTO _analytics_pending_pushes (month) VALUES (?)
       ON CONFLICT (month) DO UPDATE SET queued_at = datetime('now')`,
    )
    .run(month);
}

/**
 * Assembles the exact payload for one month: this month's expense
 * transactions plus which of them are AP-managed
 * (getMonthExpenseTransactionsWithApManaged — ONE extra engine call for the
 * whole month, not one per transaction), and every AP register row
 * (computeExpenseLedgerRollup itself scopes the AP rows to this month by
 * their วันที่ลงบิล / `bill_date` — see src/shared/rollup.ts's file header
 * for why it isn't pre-filtered here). `generatedAt` is stamped at push time here, not
 * inside the pure rollup.ts function.
 *
 * `.map(reimbursementRowView).map(payrollRowView)` decorates each row with
 * its `.payroll`/`.reimbursement` marker (same two calls, same order, as
 * server.ts's GET /api/ap/rows route) — computeExpenseLedgerRollup's
 * `filedBySource` bucket (src/shared/rollup.ts's apRowSource()) needs that
 * presence to tell a payroll/reimbursement-synced row apart from a manual
 * one; `listApRows` alone never sets either field.
 */
async function buildPayload(month: string): Promise<ExpenseLedgerRollup> {
  const { transactions, apManagedIds } = await getMonthExpenseTransactionsWithApManaged(month);
  const apRows = listApRows({ mode: "all" }).map(reimbursementRowView).map(payrollRowView);
  return computeExpenseLedgerRollup(month, transactions, apManagedIds, apRows, new Date().toISOString());
}

/** Thrown by `postOne` on a non-2xx HTTP response, carrying the response's
 * own status code so `flush()` can tell a permanent client-side rejection
 * (4xx — e.g. hf-analytics' footing-validation reject, SourcePayloadError)
 * apart from a transient server-side/network failure (5xx, or `fetch`
 * itself throwing, which surfaces with `status: null`). */
class AnalyticsPushHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function postOne(month: string): Promise<void> {
  const payload = await buildPayload(month);
  const r = await fetch(`${urlBase()}/api/ingest/expense-ledger`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token()}`,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    throw new AnalyticsPushHttpError(`${r.status} ${await r.text().catch(() => "")}`, r.status);
  }
}

let running = false;
async function flush(): Promise<void> {
  if (!enabled() || running) return;
  running = true;
  try {
    const pending = outboxDb()
      .query<{ month: string }, []>("SELECT month FROM _analytics_pending_pushes ORDER BY queued_at ASC LIMIT 50")
      .all();
    for (const row of pending) {
      try {
        await postOne(row.month);
        outboxDb().query("DELETE FROM _analytics_pending_pushes WHERE month = ?").run(row.month);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 4xx is a PERMANENT rejection of this one month's payload (bad
        // data — a footing mismatch, hf-analytics' SourcePayloadError) —
        // hf-analytics itself is fine, and re-sending the exact same bytes
        // will never succeed on its own (see hf-data/CLAUDE.md's ingest
        // rule: "a schema-valid but permanently un-ingestable payload must
        // throw SourcePayloadError so sender-side outboxes discard it
        // instead of head-of-line-blocking forever"). DROP it — delete the
        // row and log — rather than requeue: a stuck bad month would
        // otherwise sit at the head of `ORDER BY queued_at ASC LIMIT 50`
        // forever, and every healthy month queued behind it would never be
        // attempted once 50 piled up. The next real mutation to that
        // month's data (or a manual analytics-backfill.ts run) re-enqueues
        // it from scratch. `continue` to the next row — a bad month is not
        // evidence hf-analytics itself is unhealthy.
        //
        // 5xx or a network failure (fetch itself throwing — no `status` at
        // all) means hf-analytics is likely unreachable/degraded: KEEP the
        // row queued and stop the batch — no point hammering it further
        // this tick. Next tick retries, oldest first (queued_at order), so
        // a persistently-failing month never itself blocks anything else
        // either.
        if (err instanceof AnalyticsPushHttpError && err.status >= 400 && err.status < 500) {
          console.error(`[analytics-push] dropping month ${row.month} after a permanent (4xx) rejection: ${msg}`);
          outboxDb().query("DELETE FROM _analytics_pending_pushes WHERE month = ?").run(row.month);
          continue;
        }
        outboxDb()
          .query("UPDATE _analytics_pending_pushes SET attempts = attempts + 1, last_error = ? WHERE month = ?")
          .run(msg, row.month);
        break;
      }
    }
  } finally {
    running = false;
  }
}

let bootTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Explicit start, called by server.ts from its boot path AFTER the listener
 * is up — NEVER at module import. Importing this file (or server.ts) must
 * have zero side effects: no DB open, no enqueue, no timer — see the file
 * header and expense-ledger/CLAUDE.md's "AP register storage exception".
 *
 * A no-op when analytics push is disabled (dormant means dormant — this
 * returns before touching the outbox DB at all, so a plain `enabled()`
 * check is the only thing that runs when ANALYTICS_URL / ANALYTICS_TOKEN
 * are unset). When enabled, enqueues the current month and the two before
 * it (so a redeploy, or a period with analytics newly enabled, always
 * re-syncs recent data even when no mutation happens to touch it in the
 * meantime) and starts the flush interval. Tests call this explicitly
 * after setting up their own env / AP_DB_PATH.
 */
export function startAnalyticsPush(): void {
  if (!enabled()) {
    console.log("[analytics-push] disabled (ANALYTICS_URL / ANALYTICS_TOKEN not set)");
    return;
  }
  console.log(`[analytics-push] enabled -> ${urlBase()}`);
  enqueueAnalyticsPush(currentMonthBangkok());
  enqueueAnalyticsPush(shiftMonths(currentMonthBangkok(), -1));
  enqueueAnalyticsPush(shiftMonths(currentMonthBangkok(), -2));
  // First flush ~5s after boot so the server is fully up.
  bootTimer = setTimeout(flush, 5_000);
  intervalTimer = setInterval(flush, 30_000);
}

/**
 * Disarms the worker's timers. Tests that call startAnalyticsPush() MUST
 * call this immediately after, or a flush firing mid-suite mutates the
 * outbox under the assertions — exactly the race the income ledger's
 * analytics-push.ts documents. Never called in production.
 */
export function stopAnalyticsPush(): void {
  if (bootTimer !== null) clearTimeout(bootTimer);
  if (intervalTimer !== null) clearInterval(intervalTimer);
  bootTimer = null;
  intervalTimer = null;
}

// Test-only handles.
export const _internal = {
  flush,
  postOne,
  buildPayload,
  isPending(month: string): boolean {
    const row = outboxDb()
      .query<{ n: number }, [string]>("SELECT 1 AS n FROM _analytics_pending_pushes WHERE month = ?")
      .get(month);
    return row !== null;
  },
  /** Removes one month's row, or empties the whole outbox when called with
   * no argument — lets a test isolate "did THIS call enqueue" from a prior
   * call's leftover row for the same month. */
  clearPending(month?: string): void {
    if (month) {
      outboxDb().query("DELETE FROM _analytics_pending_pushes WHERE month = ?").run(month);
    } else {
      outboxDb().exec("DELETE FROM _analytics_pending_pushes");
    }
  },
};
