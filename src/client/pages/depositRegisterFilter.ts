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

/**
 * Which of the two real buckets an EXCEPTION (mismatched/orphanApplied)
 * belongs to, per its own note's resolution state — owner ask (2026-08-01,
 * exceptions respect the focus filter once resolved). Unresolved
 * (`resolvedAt === null`) is "outstanding": a note saying "waiting on
 * reception" must keep shouting in the working view until someone
 * deliberately resolves it (the same `deposit_notes` "explained" convention
 * CONTEXT.md documents). Resolved (`resolvedAt` non-null) is "finished".
 * Deliberately a SEPARATE predicate from `depositFilterBucketForStatus` —
 * an exception's own resolution is a different axis from its thread's
 * received/applied/refunded status: the proven R015834 case is thread
 * `status: "applied"` (bucket "finished" by THAT rule) yet can still be an
 * unresolved exception that must show under "คงค้าง".
 */
export function depositExceptionBucketForResolved(resolvedAt: string | null): Exclude<DepositFilterBucket, "all"> {
  return resolvedAt === null ? "outstanding" : "finished";
}

/** Whether an exception row passes the given pill selection, per
 * `depositExceptionBucketForResolved` — the exceptions-section counterpart
 * of `matchesDepositFilter` (which is keyed off thread status instead). */
export function matchesDepositExceptionFilter(resolvedAt: string | null, filter: DepositFilterBucket): boolean {
  return filter === "all" || depositExceptionBucketForResolved(resolvedAt) === filter;
}

/**
 * Search row shape consumed by `matchesDepositSearch` — owner ask
 * (2026-08-01): "add search bar too. search for customer name, and ref like
 * R015811." `guestName`/`rNumber`/`appliedChRef` are common to every
 * thread-shaped row on the มัดจำ register (`DepositAgingRow`,
 * `DepositMismatchedException`, `DepositOrphanAppliedException`,
 * `DepositOverRefundedException` in client/api.ts all carry these three via
 * `DepositGuestNameField`/`DepositStatusFields`). `pmsRefs` is the odd one
 * out: NO row field carries more than one pmsRef — `receivedPmsRef` is only
 * that thread's FIRST non-voided received event's pay_no
 * (`receivedPmsRefFor`, server.ts), and `appliedChRef` is a CH/check-in ref,
 * not a pmsRef at all. So "every received/applied pmsRef (receipt numbers)"
 * is built by the caller (DepositRegisterPage.tsx) from the full
 * `register.events` feed, filtered to this thread's own non-voided
 * received/applied events' `pmsRef` (pay_no) values — a genuine split
 * receipt or a partial-then-fully-applied thread can have more than one. */
export interface DepositSearchRow {
  guestName: string | null;
  rNumber: string;
  pmsRefs: readonly string[];
  appliedChRef: string | null;
}

/**
 * Case-insensitive substring match for the มัดจำ register's search box.
 * Empty query (after trimming) always passes — "no search" means "show
 * everything", never "show nothing". Otherwise true when the (lowercased)
 * query is a substring of the row's guest name, R-number, any received/
 * applied pmsRef, or its applied CH ref. Pure — no React, no fetch — so it
 * unit-tests without a component harness (this repo has none), same
 * reasoning as `matchesDepositFilter` above. Composes with that pill filter
 * as a plain AND at the call site (DepositRegisterPage.tsx); this function
 * only ever answers the search half of that question.
 */
export function matchesDepositSearch(query: string, row: DepositSearchRow): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystacks: readonly (string | null)[] = [row.guestName, row.rNumber, row.appliedChRef, ...row.pmsRefs];
  return haystacks.some((h) => h !== null && h.toLowerCase().includes(q));
}
