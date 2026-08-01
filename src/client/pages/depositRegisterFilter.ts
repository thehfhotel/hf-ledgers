// Pure filter logic for the มัดจำ register's ทั้งหมด/คงค้าง/เสร็จสิ้น pill
// (owner ask, 2026-08-01: "create a pill to select finished and outstanding
// so office can focus only on the outstanding"). Kept separate from
// DepositRegisterPage.tsx so the status -> bucket mapping is unit-testable
// without a component harness (this repo has none).

import type { DepositThreadStatus } from "../../shared/types.ts";

/** The pill's three options. `"all"` is a passthrough (never narrows);
 * `"outstanding"`/`"finished"` are the two real buckets a `DepositThreadStatus`
 * is sorted into (see `DEPOSIT_FILTER_BUCKET_BY_STATUS` below). */
export type DepositFilterBucket = "all" | "outstanding" | "finished";

/** Which of the two real buckets a `DepositThreadStatus` belongs to —
 * รอเช็คอิน/บางส่วน (still holding a balance) are "outstanding", ตัดยอดแล้ว/
 * คืนเงินแล้ว (closed out, however they closed) are "finished". Typed as a
 * `Record<DepositThreadStatus, ...>` (not a partial map / switch with a
 * default) so that if `DepositThreadStatus` ever grows a fifth member,
 * this object literal fails to compile until that member is explicitly
 * placed into a bucket — the exhaustiveness the owner asked for. */
export const DEPOSIT_FILTER_BUCKET_BY_STATUS: Record<DepositThreadStatus, Exclude<DepositFilterBucket, "all">> = {
  waitingCheckin: "outstanding",
  partial: "outstanding",
  applied: "finished",
  refunded: "finished",
};

/** The bucket a thread's status falls into, per `DEPOSIT_FILTER_BUCKET_BY_STATUS`. */
export function depositFilterBucketForStatus(status: DepositThreadStatus): Exclude<DepositFilterBucket, "all"> {
  return DEPOSIT_FILTER_BUCKET_BY_STATUS[status];
}

/** Whether a thread's status passes the given pill selection — `"all"`
 * always passes; otherwise the thread's own bucket must match. */
export function matchesDepositFilter(status: DepositThreadStatus, filter: DepositFilterBucket): boolean {
  return filter === "all" || depositFilterBucketForStatus(status) === filter;
}
