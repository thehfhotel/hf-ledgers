// Pure view-shaping for the ส่งสลิป SPA (owner feedback, 2026-08-04: "after
// attaching a slip, the row leaves the รอแนบสลิป list and reception thinks
// it vanished" — the fix restructures the single scrolling list into TABS,
// รอแนบสลิป / จัดการสลิป, so a settlement moving from one to the other is an
// explicit navigation, never a silent disappearance). Extracted out of
// App.tsx so the partition/search logic is unit-testable without a DOM.

import type { SlipQueueRow } from "./api.ts";

/** True iff `row` matches a free-text `query` against guest name or any ref
 * — case-insensitive, blank query matches everything. PURE. */
export function matchesSearch(row: SlipQueueRow, query: string): boolean {
  if (query.trim() === "") return true;
  const needle = query.trim().toLowerCase();
  if (row.guestName?.toLowerCase().includes(needle)) return true;
  return row.refs.some((r) => r.toLowerCase().includes(needle));
}

export interface SlipQueuePartition {
  /** รอแนบสลิป tab — no slip attached at all yet. */
  pending: SlipQueueRow[];
  /** จัดการสลิป tab — at least one CURRENT (non-superseded) attachment. */
  attached: SlipQueueRow[];
}

/**
 * Splits an already-filtered (date + search) row list into the two tabs —
 * `attachment.count === 0` (nothing attached yet) vs `> 0` (at least one
 * current version). Uses a single pass (never two separate `.filter()`
 * calls over the same array) and PRESERVES each row's relative order within
 * its bucket — `rows` arrives newest-`paidAtIso`-first from the server
 * (`sortDayAuditRows`, `src/server/day-audit.ts`), and this partition must
 * never disturb that: reception's date+time-descending sort has to hold
 * inside BOTH tabs, not just the old single list. PURE.
 */
export function partitionSlipQueue(rows: readonly SlipQueueRow[]): SlipQueuePartition {
  const pending: SlipQueueRow[] = [];
  const attached: SlipQueueRow[] = [];
  for (const row of rows) {
    if (row.attachment.count === 0) pending.push(row);
    else attached.push(row);
  }
  return { pending, attached };
}
