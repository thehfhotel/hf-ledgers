// Outbox-backed pusher to hf-analytics — mirrors the estate precedent
// (room-daily-reporter/src/server/push.ts): every day-mutating endpoint in
// server.ts enqueues the (property, date) it touched here, and a small
// interval worker drains the outbox oldest-first, POSTing each day's rollup
// to hf-analytics' locked ingest endpoint (POST /api/ingest/income-ledger,
// upsert on (property, date) — re-posting the same day is safe/idempotent).
// If hf-analytics is unreachable, rows stay queued and retry on the next
// tick.
//
// ENABLED = !!(ANALYTICS_URL && ANALYTICS_TOKEN): with either unset, the
// whole feature — enqueueing AND flushing — stays dormant, so every
// environment that hasn't wired analytics (dev, CI, a fresh deploy before
// secrets land) runs with a completely inert outbox table.
//
// Owns its own table (`_analytics_pending_pushes`), created here at import
// time — deliberately NOT in db.ts's migrate(), which is siblings'
// territory (see CLAUDE.md/this package's brief).

import {
  categoriesForDay,
  db,
  getDepositEventsForDay,
  getEffectiveIncomeForDay,
  getExpensesForDay,
  getOtherIncomeForDay,
  getSheetDay,
} from "./db.ts";
import { computeIncomeLedgerRollup } from "../shared/rollup.ts";
import type { Property } from "../shared/types.ts";

// Read LAZILY (call-time), never at module load: bun test runs every file
// in one process, so whichever test file imports server.ts first would
// otherwise freeze the enabled state for all later files - the discovery
// order differs between filesystems, which made CI fail while local passed.
const urlBase = (): string => (process.env.ANALYTICS_URL ?? "").replace(/\/+$/, "");
const token = (): string => process.env.ANALYTICS_TOKEN ?? "";
const enabled = (): boolean => !!(urlBase() && token());

db.exec(`
  CREATE TABLE IF NOT EXISTS _analytics_pending_pushes (
    property   TEXT NOT NULL,
    date       TEXT NOT NULL,
    queued_at  TEXT NOT NULL DEFAULT (datetime('now')),
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (property, date)
  );
`);

const enqueueStmt = db.prepare(
  `INSERT INTO _analytics_pending_pushes (property, date) VALUES (?, ?)
   ON CONFLICT (property, date) DO UPDATE SET queued_at = datetime('now')`,
);
const listPendingStmt = db.query<{ property: string; date: string }, []>(
  "SELECT property, date FROM _analytics_pending_pushes ORDER BY queued_at ASC LIMIT 50",
);
const deleteStmt = db.prepare("DELETE FROM _analytics_pending_pushes WHERE property = ? AND date = ?");
const markErrorStmt = db.prepare(
  "UPDATE _analytics_pending_pushes SET attempts = attempts + 1, last_error = ? WHERE property = ? AND date = ?",
);
// Same as markErrorStmt, but ALSO bumps queued_at — used only on a 4xx
// continue (see flush() below): without this, a permanently-failing day
// stays at the HEAD of listPendingStmt's `ORDER BY queued_at ASC LIMIT 50`
// window forever, so once 50 OTHER days queue up behind it, THEY silently
// stop being attempted at all (never re-added, just never selected). Only
// the 4xx path bumps — a 5xx/network failure breaks the batch immediately
// (see below), so there is nothing "behind" that row to unblock this tick.
const markErrorAndRequeueStmt = db.prepare(
  `UPDATE _analytics_pending_pushes SET attempts = attempts + 1, last_error = ?, queued_at = datetime('now')
   WHERE property = ? AND date = ?`,
);

/**
 * Enqueues (property, date) for push to hf-analytics. Call this from every
 * route in server.ts that changes a day's data (income cell, booking-line
 * CRUD, other-income CRUD, expense CRUD, day note, cash-block override,
 * verify, fill-from-bookings apply, month close/reopen — see server.ts call
 * sites). No-op when analytics push is disabled. Safe to call more than
 * once for the same day in quick succession: ON CONFLICT bumps queued_at
 * rather than creating a duplicate row, so repeat saves during the same
 * minute coalesce into one push.
 */
export function enqueueAnalyticsPush(property: Property, date: string): void {
  if (!enabled()) return;
  enqueueStmt.run(property, date);
}

/**
 * Assembles the exact payload for one (property, date) from the same
 * shapes server.ts's loadDayData() uses for the day-sheet API — the
 * EFFECTIVE income view (getEffectiveIncomeForDay(), so the two รายการอื่นๆ
 * cells are already resolved to their computed values whenever the day has
 * other-income items), never a re-derivation from booking lines. This
 * day's `deposit_events` (Wave C) feed the rollup's OUTSIDE-of-amounts
 * depositReceivedSatang/depositRefundedSatang pair — see rollup.ts.
 * `generatedAt` is stamped at push time here, not inside the pure
 * rollup.ts function.
 */
function buildPayload(property: Property, date: string) {
  const categories = categoriesForDay(property, date);
  const otherIncomeItems = getOtherIncomeForDay(property, date);
  const income = getEffectiveIncomeForDay(property, date, categories, otherIncomeItems);
  const expenses = getExpensesForDay(property, date);
  const deposits = getDepositEventsForDay(property, date);
  const sheetDay = getSheetDay(property, date);
  const verified = sheetDay?.verifiedAt != null;
  const provenance = sheetDay?.provenance ?? "app";

  const rollup = computeIncomeLedgerRollup(
    property,
    date,
    categories,
    income,
    expenses,
    verified,
    provenance,
    deposits,
  );
  return { ...rollup, generatedAt: new Date().toISOString() };
}

/** Thrown by `postOne` on a non-2xx HTTP response, carrying the response's
 * own status code so `flush()` can tell a permanent client-side rejection
 * (4xx — e.g. hf-analytics' footing-validation reject) apart from a
 * transient server-side/network failure (5xx, or `fetch` itself throwing,
 * which surfaces with `status: null`). */
class AnalyticsPushHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function postOne(property: Property, date: string): Promise<void> {
  const payload = buildPayload(property, date);
  const r = await fetch(`${urlBase()}/api/ingest/income-ledger`, {
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
    const pending = listPendingStmt.all();
    for (const row of pending) {
      try {
        await postOne(row.property as Property, row.date);
        deleteStmt.run(row.property, row.date);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 4xx is a PERMANENT rejection of this one day's payload (bad data,
        // e.g. a footing mismatch) — hf-analytics itself is fine, so
        // stopping the whole batch over it means every day queued behind
        // it (almost always fine) never gets pushed until this one is
        // somehow fixed. `continue` to the next row instead; this day
        // stays queued (never deleted) so a later fix still retries it —
        // see the C-tests note in the plan for the regression this covers.
        // ALSO bump queued_at here (markErrorAndRequeueStmt, not
        // markErrorStmt) so this day rotates to the BACK of
        // listPendingStmt's `ORDER BY queued_at ASC LIMIT 50` window —
        // otherwise it sits at the head forever and, once 50 healthy days
        // queue up behind it, those days silently fall outside the LIMIT
        // 50 window and are never attempted at all.
        // 5xx or a network failure (fetch itself throwing — no `status` at
        // all) means hf-analytics is likely unreachable/degraded: stop the
        // batch, no point hammering it further this tick. Next tick
        // retries, oldest first (queued_at order, not attempts), so a
        // persistently-failing day never itself blocks anything either —
        // this path does NOT bump queued_at (markErrorStmt), since nothing
        // behind it was even attempted this tick to unblock.
        if (err instanceof AnalyticsPushHttpError && err.status >= 400 && err.status < 500) {
          markErrorAndRequeueStmt.run(msg, row.property, row.date);
          continue;
        }
        markErrorStmt.run(msg, row.property, row.date);
        break;
      }
    }
  } finally {
    running = false;
  }
}

let bootTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

export function startAnalyticsPushWorker(): void {
  if (!enabled()) {
    console.log("[analytics-push] disabled (ANALYTICS_URL / ANALYTICS_TOKEN not set)");
    return;
  }
  console.log(`[analytics-push] enabled -> ${urlBase()}`);
  // First flush ~5s after boot so the server is fully up.
  bootTimer = setTimeout(flush, 5_000);
  intervalTimer = setInterval(flush, 30_000);
}

/**
 * Disarms the worker's timers. Tests that import server.ts (which arms the
 * worker at module load) MUST call this immediately after import, or a
 * flush firing mid-suite mutates the outbox under the assertions — exactly
 * the race that kept CI red on GH runners while passing on faster local
 * machines. Never called in production.
 */
export function stopAnalyticsPushWorker(): void {
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
  isPending(property: Property, date: string): boolean {
    const row = db
      .query<{ n: number }, [string, string]>(
        "SELECT 1 AS n FROM _analytics_pending_pushes WHERE property = ? AND date = ?",
      )
      .get(property, date);
    return row !== null;
  },
  /** Removes one (property, date) row, or empties the whole outbox when
   * called with no arguments — lets a test isolate "did THIS call enqueue"
   * from a prior call's leftover row on the same day. */
  clearPending(property?: Property, date?: string): void {
    if (property && date) {
      deleteStmt.run(property, date);
    } else {
      db.exec("DELETE FROM _analytics_pending_pushes");
    }
  },
};
