// One-time (repeatable) backfill: enqueues every historical day into the
// hf-analytics outbox (src/server/analytics-push.ts) so the rows already in
// the database get pushed once. Idempotent / safe to re-run — enqueue
// upserts into the outbox (ON CONFLICT bumps queued_at) and the receiving
// hf-analytics endpoint upserts on (property, date), so re-pushing a day
// just overwrites it with the same numbers.
//
// Must be runnable inside the production container via `docker exec`, so
// this file imports ONLY from src/server/db.ts, src/server/analytics-push.ts
// and src/shared/types.ts — never anything under scripts/import-xls/, and
// never the `xlsx` devDependency (not installed in the production image).
//
// This script only ENQUEUES — it does not POST anything itself. The
// running server's own push worker (started by server.ts at boot) drains
// the outbox on its normal interval. That means this script needs no
// network env vars of its own; it only needs DB_PATH to already point at
// the same database the server uses (true by default inside the
// container), and it still checks ANALYTICS_URL/ANALYTICS_TOKEN below so an
// operator gets a clear message instead of a silent no-op if the outbox
// itself is disabled.
//
// IMPORTANT for the Excel-importer runbook: scripts/import-xls/import.ts
// writes by copy-and-swap OUTSIDE the running app process (it replaces the
// SQLite file wholesale), so a future import run bypasses this outbox
// entirely and never enqueues anything on its own — re-run THIS script
// after every import so the imported/changed days get pushed.
//
// Usage (inside the production container):
//   docker exec income-ledger bun scripts/analytics-backfill.ts

import { db } from "../src/server/db.ts";
import { enqueueAnalyticsPush } from "../src/server/analytics-push.ts";
import { PROPERTIES } from "../src/shared/types.ts";
import type { Property } from "../src/shared/types.ts";

/**
 * Every distinct date with any data for `property`, across all four sources
 * that can make a day "exist" — the same union db.ts's listDaysWithData()
 * uses per calendar month, but unbounded here since a one-time backfill
 * must sweep the entire history in one pass rather than one month at a
 * time.
 */
function listAllDatesWithData(property: Property): string[] {
  const rows = db
    .query<{ date: string }, [string, string, string, string]>(
      `SELECT date FROM income_amounts WHERE property = ?
       UNION
       SELECT date FROM expense_items WHERE property = ?
       UNION
       SELECT date FROM sheet_days WHERE property = ? AND note IS NOT NULL
       UNION
       SELECT date FROM booking_lines WHERE property = ?
       ORDER BY date ASC`,
    )
    .all(property, property, property, property);
  return rows.map((r) => r.date);
}

if (!process.env.ANALYTICS_URL || !process.env.ANALYTICS_TOKEN) {
  console.error(
    "[analytics-backfill] ANALYTICS_URL / ANALYTICS_TOKEN are not set in this process's env " +
      "-- enqueueAnalyticsPush() silently no-ops for every day when the outbox is disabled. " +
      "Run this inside the production container (docker exec income-ledger ...), which " +
      "inherits the container's env, or export both vars first.",
  );
  process.exit(1);
}

let total = 0;
for (const property of PROPERTIES) {
  const dates = listAllDatesWithData(property);
  console.log(`[analytics-backfill] property=${property}: ${dates.length} day(s) to enqueue`);
  for (const date of dates) {
    enqueueAnalyticsPush(property, date);
    total++;
  }
}

console.log(
  `[analytics-backfill] enqueued ${total} day(s) total -- the running server's push worker drains them on its normal interval.`,
);
