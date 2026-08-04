// Pure view-shaping for the จัดการสลิป gallery — extracted out of App.tsx so
// the count-vs-version / badge-visibility rules (owner-reported bug #1,
// "จัดการสลิป — Manage Slips" design) are unit-testable without a DOM, same
// reasoning partition.ts already documents for its own extraction.

import type { SlipQueueRow } from "./api.ts";

/**
 * Whether the gallery's small count badge should render at all. Owner rule:
 * hidden at `count === 1` ("the picture speaks for itself" — a lone
 * thumbnail needs no redundant "1" next to it), shown from 2 up. `count`
 * here is ALWAYS `attachment.count` — the number of CURRENT (non-
 * superseded) pictures — never `attachment.latestVersion` (owner-reported
 * bug: a settlement with exactly one current picture that has been
 * เปลี่ยน'd/re-attached several times carries a HIGH version number but
 * still only ONE current picture, and must never show a badge at all).
 * This is the SAME `count` field the office's compact audit thumbnail
 * (src/client/pages/DayAuditQueue.tsx's `proofCount`) reads — the two
 * surfaces differ only in their threshold (`> 1` there vs. `>= 2` here,
 * which is the same threshold spelled differently), never in which field
 * they read. PURE.
 */
export function shouldShowCountBadge(count: number): boolean {
  return count >= 2;
}

/**
 * ประวัติ (N รายการ) — the HISTORY count shown on each จัดการสลิป card,
 * DELIBERATELY DIFFERENT from the badge's current-picture count above: N is
 * every picture this settlement has EVER had (current + superseded), so a
 * settlement with 1 current picture that replaced 2 taken-out ones reads
 * "ประวัติ (3 รายการ)" right next to a badge-less single thumbnail — the
 * button is the one place total history depth is surfaced, the badge is the
 * one place current-only count is. Both numbers come off the SAME
 * `AttachmentSummary` (no extra fetch): `count` (current) + `superseded`
 * (taken-out) = every version ever attached, exactly what `listHistory`
 * would return the length of. PURE.
 */
export function historyCount(attachment: Pick<SlipQueueRow["attachment"], "count" | "superseded">): number {
  return attachment.count + attachment.superseded;
}
