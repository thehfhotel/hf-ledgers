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
  /** รอแนบสลิป tab — no slip attached AND not marked เงินสด yet. */
  pending: SlipQueueRow[];
  /** จัดการสลิป tab — at least one CURRENT (non-superseded) attachment, OR
   * marked เงินสด (paid in cash, no slip will ever exist). A cash-marked
   * row lands here even with zero attachments; unmarking (`cashMark` back
   * to `null`) is the only way out, same as attaching a slip is for a
   * never-marked row. */
  attached: SlipQueueRow[];
}

/**
 * Splits an already-filtered (date + search) row list into the two tabs —
 * a row is "settled" (จัดการสลิป) once it has a slip (`attachment.count >
 * 0`) OR is cash-marked (`cashMark !== null`); otherwise it's still
 * รอแนบสลิป. The two conditions are independent and either alone is enough
 * — a cash mark never waits on attachment state and vice versa (a slip can
 * still surface later on a cash-marked row; App.tsx's "+ เพิ่มรูป" tile stays
 * available for exactly that). Uses a single pass (never two separate
 * `.filter()` calls over the same array) and PRESERVES each row's relative
 * order within its bucket — `rows` arrives newest-`paidAtIso`-first from
 * the server (`sortDayAuditRows`, `src/server/day-audit.ts`), and this
 * partition must never disturb that: reception's date+time-descending sort
 * has to hold inside BOTH tabs, not just the old single list. PURE.
 */
export function partitionSlipQueue(rows: readonly SlipQueueRow[]): SlipQueuePartition {
  const pending: SlipQueueRow[] = [];
  const attached: SlipQueueRow[] = [];
  for (const row of rows) {
    if (row.attachment.count === 0 && row.cashMark === null) pending.push(row);
    else attached.push(row);
  }
  return { pending, attached };
}
