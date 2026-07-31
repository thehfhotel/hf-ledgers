// Accrual cutover (Wave C, docs/adr/0001-accrual-recognition-for-deposits.md;
// plan section C7): the single commit-changed constant that decides, for a
// given (property, date), whether a มัดจำล่วงหน้า is booked under the OLD
// rule (a deposit IS income the day it is taken — src/shared/api.md's
// pre-2026-07-31 accounting block) or the NEW rule (a deposit is money
// received but not yet earned; the stay's full charge is recognised on the
// stay's day instead).
//
// OWNER-DECIDED: cutover = 2026-07-31 for BOTH properties ("reception
// changes the approach now — already changed the process"). Safe in
// practice: July carries zero deposit-category income cells (the only ones
// ever written are the 2025 Excel imports plus one 2026-05-08 outlier), so
// July's filed sheets are unaffected by the new rule; today's first real
// จ่ายล่วงหน้า entries land under the new model rather than as anomalies.
//
// This constant is NEVER read at runtime from an env var or a DB row — it
// is a plain source-level constant, changed by a commit like any other code
// change. A client/server split-brain on "is this an accrual day" is a
// money bug (one side books a deposit as income, the other doesn't), so the
// only safe way to keep both in lockstep is to ship them from the same
// source file, imported by both sides — never derive it from wall-clock
// time or any other value that could differ between processes.

import type { Property } from "./types.ts";
import { TENDERS } from "./types.ts";
import type { Tender } from "./types.ts";

/** Per-property cutover date (Bangkok calendar "YYYY-MM-DD", inclusive —
 * the cutover date itself is already an accrual day). Both properties share
 * the same date today, but the type stays per-property since the owner's
 * reasoning ("reception changes the approach") is an operational decision
 * that could legitimately diverge by property in the future. */
export const ACCRUAL_CUTOVER_DATE: Record<Property, string> = {
  hf: "2026-07-31",
  hfville: "2026-07-31",
};

/**
 * True when `date` (a Bangkok calendar "YYYY-MM-DD" string) is on or after
 * `property`'s accrual cutover — plain string comparison is safe and exact
 * for same-format ISO date strings, no Date parsing needed.
 *
 * Gates ONLY write boundaries (deposit CRUD write endpoints, importer
 * deposit-event emission) per the plan — read paths stay ungated because a
 * pre-cutover day can never hold a deposit_events row or a nonzero
 * t_deposit_applied cell in the first place (nothing ever writes one there).
 */
export function isAccrualDay(property: Property, date: string): boolean {
  return date >= ACCRUAL_CUTOVER_DATE[property];
}

/**
 * The 8 VISIBLE tender columns for a (property, date) — `deposit` and
 * `deposit_applied` share one printed slot (same position, same width, same
 * meaning-of-column-on-the-paper) and only one of the two is ever shown for
 * a given day: `deposit` pre-cutover (today's rule — a deposit IS income),
 * `deposit_applied` on/after cutover (the applied-at-the-stay tender under
 * accrual). Every OTHER tender (cash, credit_kbank, credit_icbc,
 * transfer_kbank, transfer_icbc, web, other) is always visible.
 *
 * `TENDERS` itself (shared/types.ts) stays the full 9-entry superset — the
 * one iterated for money math (computeBookingTotals, deriveIncomeFromBookings,
 * DB columns) where BOTH tenders must always be accounted for regardless of
 * which is "visible" on a given day's grid (a day can carry stray money in
 * the hidden slot — e.g. a legacy `deposit` value on a booking line dated
 * after cutover — and that money must never silently vanish from a sum).
 * This function is for RENDERING ONLY: which 8 columns the booking grid,
 * its printed frame, and the entry keyboard-nav order show for this date.
 */
export function visibleTendersForDate(property: Property, date: string): Tender[] {
  const hidden: Tender = isAccrualDay(property, date) ? "deposit" : "deposit_applied";
  return TENDERS.filter((tender) => tender !== hidden);
}
