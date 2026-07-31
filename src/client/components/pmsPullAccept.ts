// Pure(ish) control-flow logic extracted out of PmsPullResultDialog.tsx
// (review fix 1 + 2) so it is directly unit-testable without a component-
// rendering harness — this repo has none (see shared/money.ts's
// shouldCommitAmount for the precedent: the exact same reasoning).

import type { PmsBookingLineChange } from "../api.ts";

/**
 * Defensive normalization for the dialog's initial `changed` state (review
 * fix 1) — `result.changed` is additive server-side (Wave D, D5), so a
 * stale cached response (or a future contract change) could omit it;
 * without this, `.length`/`.map` on `undefined` would throw with no
 * ErrorBoundary anywhere in this app to catch it, white-screening the
 * booking-entry page.
 */
export function normalizeChangedRows(changed: PmsBookingLineChange[] | undefined): PmsBookingLineChange[] {
  return changed ?? [];
}

export type AcceptOutcome =
  | { kind: "accept-failed"; message: string }
  | { kind: "accepted-and-refreshed" }
  | { kind: "accepted-but-refresh-failed" };

/**
 * The per-row accept flow's control logic (review fix 2), two ordered
 * steps:
 *
 * 1. `acceptCall()` — the server-side accept (`POST .../accept-pms-update`).
 *    If this throws, the row is untouched server-side, so it must stay
 *    visible with its own retryable error (`"accept-failed"`) — `refetch`
 *    is never called in this branch.
 * 2. `refetch()` — the post-accept resync (`refetchLinesAndSheet` on
 *    BookingDayPage.tsx). Only reached once the accept has ALREADY
 *    succeeded server-side. If THIS throws, the row must NOT be silently
 *    removed from view: removing it before the refetch resolves would
 *    strand a refetch failure with nowhere to render (the row it would have
 *    attached its error to is already gone) while the screen's booking data
 *    stays stale. `"accepted-but-refresh-failed"` tells the caller to keep
 *    the row visible and show a DIALOG-level banner instead of a per-row
 *    error, since the accept itself did succeed.
 */
export async function runAcceptFlow(
  acceptCall: () => Promise<unknown>,
  refetch: () => Promise<void>,
): Promise<AcceptOutcome> {
  try {
    await acceptCall();
  } catch (err) {
    return { kind: "accept-failed", message: err instanceof Error ? err.message : "ยอมรับการเปลี่ยนแปลงไม่สำเร็จ" };
  }
  try {
    await refetch();
    return { kind: "accepted-and-refreshed" };
  } catch {
    return { kind: "accepted-but-refresh-failed" };
  }
}
