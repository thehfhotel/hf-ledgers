// One-time (repeatable) backfill: enqueues every Bangkok calendar month the
// register holds a bill in — from the EARLIEST วันที่ลงบิล (never a
// hard-coded first month: after the 2026-09-19 recognition change a bill can
// be back-dated into a งวด older than the ledger's own go-live, and that
// month still has to be pushed) through the current month, into the
// hf-analytics outbox (src/server/analytics-push.ts), so data already
// filed/entered before analytics push existed gets pushed once. Idempotent
// / safe to re-run — enqueue upserts into the outbox (ON CONFLICT bumps
// queued_at) and the receiving hf-analytics endpoint upserts on (month), so
// re-pushing a month just overwrites it with the same numbers.
//
// Must be runnable inside the production container via `docker exec`, so
// this file imports ONLY from src/server/analytics-push.ts and
// @shared/date.ts (packages/shared) — never scripts/lib/, never `xlsx` or
// any other devDependency not installed in the production image.
//
// This script only ENQUEUES — it does not POST anything itself. The
// running server's own push worker (started by server.ts at boot) drains
// the outbox on its normal interval. That means this script needs no
// network env vars of its own; it only checks ANALYTICS_URL/ANALYTICS_TOKEN
// below so an operator gets a clear message instead of a silent no-op if
// the outbox itself is disabled.
//
// Usage (inside the production container):
//   docker exec expense-ledger bun scripts/analytics-backfill.ts

import { enqueueAnalyticsPush } from "../src/server/analytics-push.ts";
import { earliestBillMonth } from "../src/server/apStore.ts";
import { currentMonthBangkok, isValidMonth, shiftMonths } from "@shared/date.ts";

// The ledger's go-live backfill month (63 transactions, all entered on
// 2026-07-31 — see docs/overall-cost-sources.md). Used only as the FLOOR
// for an empty register (or one whose earliest bill is newer): the range
// below starts at the earliest วันที่ลงบิล whenever that is older.
const FIRST_MONTH = "2026-07";

/** Every "YYYY-MM" from `fromMonth` through `toMonth`, inclusive — plain
 * string comparison is safe here since both are always zero-padded
 * "YYYY-MM". Built with shiftMonths (@shared/date.ts) rather than
 * hand-rolled month arithmetic, matching this monorepo's "never reimplement
 * this arithmetic elsewhere" rule. */
function monthRange(fromMonth: string, toMonth: string): string[] {
  const months: string[] = [];
  let month = fromMonth;
  while (month <= toMonth) {
    months.push(month);
    month = shiftMonths(month, 1);
  }
  return months;
}

if (!process.env.ANALYTICS_URL || !process.env.ANALYTICS_TOKEN) {
  console.error(
    "[analytics-backfill] ANALYTICS_URL / ANALYTICS_TOKEN are not set in this process's env " +
      "-- enqueueAnalyticsPush() silently no-ops for every month when the outbox is disabled. " +
      "Run this inside the production container (docker exec expense-ledger ...), which " +
      "inherits the container's env, or export both vars first.",
  );
  process.exit(1);
}

// Opens the AP register (lazily, exactly like every other store call) to
// ask what the oldest งวด actually is — a bill back-dated into 2026-05 makes
// 2026-05 a month this backfill must enqueue.
const earliest = earliestBillMonth();
const fromMonth = earliest && earliest < FIRST_MONTH ? earliest : FIRST_MONTH;
const months = monthRange(fromMonth, currentMonthBangkok());
for (const month of months) {
  if (!isValidMonth(month)) throw new Error(`bad month computed: ${month}`);
  enqueueAnalyticsPush(month);
}

console.log(
  `[analytics-backfill] enqueued ${months.length} month(s) (${months[0]} .. ${months[months.length - 1] ?? months[0]}) ` +
    "-- the running server's push worker drains them on its normal interval.",
);
