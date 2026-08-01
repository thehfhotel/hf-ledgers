import type {
  BookingLine,
  BookingTotals,
  CashAdjustmentAmounts,
  CashBlock,
  CashBlockAmounts,
  Category,
  CategoryKey,
  CategoryKind,
  DaySheet,
  DaySummary,
  DepositEvent,
  DepositEventKind,
  DepositNote,
  DepositTender,
  DepositThreadStatus,
  ExpenseItem,
  Me,
  OtherIncomeItem,
  Property,
} from "../shared/types.ts";

// Typed fetch wrappers for every endpoint in src/shared/api.md (the
// contract of record). One function per endpoint, in the same order as
// that document. Non-2xx responses throw with the server's `{error}`
// message when present.

/** Thrown by `request()` on any non-2xx response — carries the HTTP
 * `status` alongside the message so a caller that genuinely needs to
 * distinguish e.g. 503 ("not configured") from any other failure can (the
 * deposit register page's "PMS not connected" empty state is the first
 * caller that needs this — every earlier page only ever showed the message
 * text). Still an `Error` subclass, so every existing
 * `err instanceof Error ? err.message : ...` call site is unaffected. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* body wasn't JSON — keep the statusText fallback */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// 1. GET /api/me
export function getMe(): Promise<Me> {
  return request<Me>("/me");
}

// 2. GET /api/:property/categories
export function listCategories(
  property: Property,
  includeArchived = false,
): Promise<{ categories: Category[] }> {
  const qs = includeArchived ? "?includeArchived=1" : "";
  return request(`/${property}/categories${qs}`);
}

// 3. POST /api/:property/categories
export function createCategory(
  property: Property,
  body: { kind: CategoryKind; nameTh: string; isCash: boolean },
): Promise<Category> {
  return request(`/${property}/categories`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// 4. PATCH /api/:property/categories/:id
export function updateCategory(
  property: Property,
  id: number,
  body: Partial<{ nameTh: string; isCash: boolean; archived: boolean }>,
): Promise<Category> {
  return request(`/${property}/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// 5. POST /api/:property/categories/reorder
export function reorderCategories(
  property: Property,
  kind: CategoryKind,
  orderedIds: number[],
): Promise<{ categories: Category[] }> {
  return request(`/${property}/categories/reorder`, {
    method: "POST",
    body: JSON.stringify({ kind, orderedIds }),
  });
}

// 6. GET /api/:property/days?month=YYYY-MM
export function listDays(property: Property, month: string): Promise<{ month: string; days: DaySummary[] }> {
  return request(`/${property}/days?month=${encodeURIComponent(month)}`);
}

// 7. GET /api/:property/day/:date
export function getDay(property: Property, date: string): Promise<DaySheet> {
  return request(`/${property}/day/${date}`);
}

// 8. PUT /api/:property/day/:date/income/:categoryId
// P3 (Opus money-review, 2026-07-31): response also carries the freshly
// recomputed cashBlock (see api.md) — callers must merge it so the
// day-page bank line never goes stale after an income-cell edit.
export function putIncomeCell(
  property: Property,
  date: string,
  categoryId: number,
  body: { amountSatang: number | null; note?: string | null },
): Promise<{ income: DaySheet["income"]; totals: DaySheet["totals"]; cashBlock: DaySheet["cashBlock"] }> {
  return request(`/${property}/day/${date}/income/${categoryId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// 9. PUT /api/:property/day/:date/note
export function putDayNote(
  property: Property,
  date: string,
  note: string | null,
): Promise<{ note: string | null }> {
  return request(`/${property}/day/${date}/note`, {
    method: "PUT",
    body: JSON.stringify({ note }),
  });
}

// 10. POST /api/:property/day/:date/expenses
export function createExpense(
  property: Property,
  date: string,
  body: { categoryId: number; amountSatang: number; note?: string | null },
): Promise<ExpenseItem> {
  return request(`/${property}/day/${date}/expenses`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// 11. PATCH /api/:property/expenses/:id
export function updateExpense(
  property: Property,
  id: number,
  body: Partial<{ categoryId: number; amountSatang: number; note: string | null }>,
): Promise<ExpenseItem> {
  return request(`/${property}/expenses/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// 12. DELETE /api/:property/expenses/:id
export function deleteExpense(property: Property, id: number): Promise<void> {
  return request(`/${property}/expenses/${id}`, { method: "DELETE" });
}

// ── Wave 2 (Planned endpoints, src/shared/api.md §"Planned endpoints") ────

/** The editable subset of BookingLine — everything except id/property/date
 * and the audit quartet, per api.md endpoint 14. `seq` is optional: the
 * server assigns `max(seq) + 1` for the day when the body omits it. */
export type BookingLineInput = Partial<
  Omit<BookingLine, "id" | "property" | "date" | "createdAt" | "createdBy" | "updatedAt" | "updatedBy">
>;

// 13. GET /api/:property/day/:date/bookings
// `pmsPull` is additive (src/server/pms-prefill.ts's pmsConfigured for this
// property) — the client's capability flag for the ดึงข้อมูล button.
export function listBookingLines(
  property: Property,
  date: string,
): Promise<{ lines: BookingLine[]; totals: BookingTotals; pmsPull: boolean }> {
  return request(`/${property}/day/${date}/bookings`);
}

// 14. POST /api/:property/day/:date/bookings
export function createBookingLine(property: Property, date: string, body: BookingLineInput): Promise<BookingLine> {
  return request(`/${property}/day/${date}/bookings`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// 15. PATCH /api/:property/bookings/:id
export function updateBookingLine(property: Property, id: number, body: BookingLineInput): Promise<BookingLine> {
  return request(`/${property}/bookings/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// 16. DELETE /api/:property/bookings/:id
export function deleteBookingLine(property: Property, id: number): Promise<void> {
  return request(`/${property}/bookings/${id}`, { method: "DELETE" });
}

// 17. POST /api/:property/day/:date/other-income
export function createOtherIncomeItem(
  property: Property,
  date: string,
  body: { description: string | null; amountSatang: number; isCash: boolean },
): Promise<OtherIncomeItem> {
  return request(`/${property}/day/${date}/other-income`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// 18. PATCH /api/:property/other-income/:id
export function updateOtherIncomeItem(
  property: Property,
  id: number,
  body: Partial<{ description: string | null; amountSatang: number; isCash: boolean }>,
): Promise<OtherIncomeItem> {
  return request(`/${property}/other-income/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// 19. DELETE /api/:property/other-income/:id
export function deleteOtherIncomeItem(property: Property, id: number): Promise<void> {
  return request(`/${property}/other-income/${id}`, { method: "DELETE" });
}

export interface FillFromBookingsDiffRow {
  categoryKey: CategoryKey;
  categoryId: number | null;
  beforeSatang: number;
  afterSatang: number;
  skippedManual: boolean;
}

// 20. POST /api/:property/day/:date/fill-from-bookings
// `apply` picks the `?apply=true` query-flag form the contract offered as
// one of two equivalent shapes — kept consistent here as the only caller.
export function fillFromBookings(
  property: Property,
  date: string,
  apply: boolean,
): Promise<{ diff: FillFromBookingsDiffRow[] }> {
  const qs = apply ? "?apply=true" : "";
  return request(`/${property}/day/${date}/fill-from-bookings${qs}`, { method: "POST" });
}

// 21. PUT /api/:property/day/:date/cash-block
// body may also carry heldBackSatang/broughtForwardSatang (the deposit-
// machine reconciliation rows, docs/plan-unify-exports-tender-split.md
// item 6 — see CashAdjustmentAmounts) — same absolute-replace body as the
// four CashBlockAmounts fields.
export function putCashBlock(
  property: Property,
  date: string,
  body: (Partial<CashBlockAmounts> & Partial<CashAdjustmentAmounts>) | null,
): Promise<CashBlock> {
  return request(`/${property}/day/${date}/cash-block`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// 22. PUT /api/:property/day/:date/verify
// Any verified identity, NOT manager-only (api.md endpoint 22): front desk
// signs off its own day.
export function putVerify(
  property: Property,
  date: string,
  verified: boolean,
): Promise<{ verifiedAt: string | null; verifiedBy: string | null }> {
  return request(`/${property}/day/${date}/verify`, {
    method: "PUT",
    body: JSON.stringify({ verified }),
  });
}

// 23. GET /api/:property/months/:month/close
export function getMonthClose(property: Property, month: string): Promise<{ month: string; closed: boolean }> {
  return request(`/${property}/months/${month}/close`);
}

// 24. PUT /api/:property/months/:month/close
export function putMonthClose(
  property: Property,
  month: string,
  closed: boolean,
): Promise<{ month: string; closed: boolean }> {
  return request(`/${property}/months/${month}/close`, {
    method: "PUT",
    body: JSON.stringify({ closed }),
  });
}

// 25. POST /api/:property/day/:date/move
// Moves ONLY this day's booking_lines + other_income_items + deposit_events
// (Wave C, Opus money-review F2, 2026-07-31) to the other property (merging
// into any rows already there) — never the day-sheet income/expenses/note,
// and never the cash-block override. See BookingDayPage.tsx's confirm
// dialog for the exact scope told to the user.
export function moveBookingDay(
  property: Property,
  date: string,
  to: Property,
): Promise<{ movedBookingLines: number; movedOtherIncome: number; movedDepositEvents: number }> {
  return request(`/${property}/day/${date}/move`, {
    method: "POST",
    body: JSON.stringify({ to }),
  });
}

/** One payment the pull could not fully place — the amount is known but the
 * PMS records no acquiring bank, so credit/transfer land here instead of a
 * bank-specific tender column. `bookingNo` falls back to `pmsRef` when the
 * folio/booking id is unknown (see BookingDayPage.tsx's result alert). */
export interface PmsUnplacedTender {
  pmsRef: string;
  bookingNo: string | null;
  creditSatang: number;
  tranSatang: number;
}

/** One payment whose credit/transfer amount the server auto-placed on a
 * bank column itself (see db.ts's insertPmsBookingLines AUTO-PLACEMENT
 * POLICY) — a verification note, since it's still an inference, just an
 * evidence-backed one. */
export interface PmsAutoPlacedTender {
  pmsRef: string;
  bookingNo: string | null;
  transferSatang: number;
  creditSatang: number;
}

/** One flagged-but-unbooked oddity from a pull (Wave C, docs/adr/0001) —
 * mirrors src/server/pms-prefill.ts's `PrefillAnomaly` (never money;
 * reported back so a human can look). */
export interface PmsAnomaly {
  pmsRef: string;
  reason: "mixed_scope" | "unknown_ds_name" | "free_without_applied" | "pre_cutover_deposit";
  detail: string;
}

/** One field where a fresh PMS re-pull now disagrees with what is
 * currently stored on an existing booking line (Wave D, D5) — mirrors
 * db.ts's `BookingLineFieldDiff`. `before`/`after` are whatever that
 * field's own type is (string, number, or null) — rendered generically as
 * text by `PmsPullResultDialog`. */
export interface PmsBookingLineFieldDiff {
  field: string;
  before: string | number | null;
  after: string | number | null;
}

/** One existing PMS-sourced booking line a fresh pull found differing from
 * what is currently stored (Wave D, D5) — mirrors db.ts's
 * `PmsBookingLineChange`. `handEdited` drives the "เคยแก้ไขด้วยมือ" chip in
 * `PmsPullResultDialog`. */
export interface PmsBookingLineChange {
  id: number;
  pmsRef: string;
  bookingNo: string | null;
  handEdited: boolean;
  fields: PmsBookingLineFieldDiff[];
}

// POST /api/:property/day/:date/pull-from-pms
// Inserts booking lines AND deposit events from the PMS payment ledger for
// that property+date (Wave C, docs/adr/0001) — button-triggered only
// (BookingDayPage.tsx), never automatic. Insert-only and idempotent: a
// payment whose pms_ref already exists that day is skipped server-side, and
// an existing row is never updated. Refunds are filtered out server-side
// and counted in `skippedRefunds`, never inserted. `changed` (Wave D, D5,
// additive) lists existing rows the fresh pull found differing from what's
// currently stored — surfaced by `PmsPullResultDialog` for a per-row accept.
export function pullFromPms(
  property: Property,
  date: string,
): Promise<{
  inserted: number;
  skipped: number;
  skippedRefunds: number;
  unplaced: PmsUnplacedTender[];
  autoPlaced: PmsAutoPlacedTender[];
  depositsInserted: number;
  depositsSkipped: number;
  anomalies: PmsAnomaly[];
  changed: PmsBookingLineChange[];
}> {
  return request(`/${property}/day/${date}/pull-from-pms`, { method: "POST" });
}

// POST /api/:property/bookings/:id/accept-pms-update (Wave D, D5) — no
// body. Re-fetches the day fresh and re-applies the fields the PMS writes
// onto the EXISTING row (merged into its current tenders — hand-keyed
// credit_icbc/transfer_icbc/other survive). 404 non-pms row, 409 closed
// month, 409 if the candidate has vanished or become a refund.
export function acceptPmsUpdate(property: Property, id: number): Promise<BookingLine> {
  return request(`/${property}/bookings/${id}/accept-pms-update`, { method: "POST" });
}

// ── Wave C: deposit_events hand-entry CRUD (docs/adr/0001) ────────────────

/** The editable DepositEvent fields — everything except id/property/date
 * and the audit quartet, per the server's DepositEventInput shape. */
export type DepositEventInput = Partial<{
  kind: DepositEventKind;
  bookingNo: string | null;
  guestName: string | null;
  tender: DepositTender;
  amountSatang: number;
  note: string | null;
}>;

// 27. POST /api/:property/day/:date/deposits
export function createDepositEvent(
  property: Property,
  date: string,
  body: { kind: DepositEventKind; bookingNo: string | null; guestName: string | null; tender: DepositTender; amountSatang: number; note: string | null },
): Promise<DepositEvent> {
  return request(`/${property}/day/${date}/deposits`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// 28. PATCH /api/:property/deposits/:id
export function updateDepositEvent(property: Property, id: number, body: DepositEventInput): Promise<DepositEvent> {
  return request(`/${property}/deposits/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// 29. DELETE /api/:property/deposits/:id
export function deleteDepositEvent(property: Property, id: number): Promise<void> {
  return request(`/${property}/deposits/${id}`, { method: "DELETE" });
}

// ── Wave D: the office deposit register (issue #5) ────────────────────────
// A SEPARATE, direct-to-PMS code path (src/server/deposit-register.ts) —
// full deposit-lifecycle history, independent of Wave C's importer/cutover.

/** Note fields merged onto every aging/exception row — `null` note/
 * resolvedAt/resolvedBy when no `DepositNote` thread exists yet for that
 * R-number. */
interface DepositNoteFields {
  note: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface DepositMonthlyReconciliation {
  /** Bangkok "YYYY-MM". Returned CHRONOLOGICAL (ascending) — reversing for
   * "newest first" display (สรุปรายเดือน) is this page's own job. */
  month: string;
  openingSatang: number;
  receivedSatang: number;
  appliedSatang: number;
  refundedSatang: number;
  closingSatang: number;
}

/** Owner ask (2026-08-01, explicit deposit state): every thread-shaped row
 * carries its `DepositThreadStatus` (shared/types.ts — รอเช็คอิน/ตัดยอดแล้ว/
 * คืนเงินแล้ว/บางส่วน) plus, when it has one, its latest applied event's CH
 * ref + date ("where it went") — `null`/`null` for a thread with no applied
 * event at all. */
type DepositStatusFields = {
  status: DepositThreadStatus;
  appliedChRef: string | null;
  appliedDateBangkok: string | null;
};

export type DepositAgingRow = DepositNoteFields &
  DepositStatusFields & {
    rNumber: string;
    receivedSatang: number;
    appliedSatang: number;
    refundedSatang: number;
    outstandingSatang: number;
    firstEventDate: string | null;
    /** Owner ask (2026-08-01, register mapability): the pay_no of this
     * thread's own received event (voided excluded), `null` when none —
     * lets the office find the actual PMS receipt behind an R-number. */
    receivedPmsRef: string | null;
  };

export type DepositMismatchedException = DepositNoteFields &
  DepositStatusFields & {
    rNumber: string;
    receivedSatang: number;
    appliedSatang: number;
    diffSatang: number;
    receivedPmsRef: string | null;
  };

export type DepositOrphanAppliedException = DepositNoteFields &
  DepositStatusFields & {
    rNumber: string;
    appliedSatang: number;
    receivedPmsRef: string | null;
  };

/** One classified deposit-lifecycle event, mirrors
 * `src/server/deposit-register.ts`'s `DepositLedgerEvent` (trimmed to the
 * wire fields — `legacyId` stays server-internal). `tender` is `null` for
 * `kind: "applied"` (an accounting offset via `ledger_free`, no bank
 * movement) and for a received/refunded row whose four tender columns are
 * genuinely all zero. `chRef` (the CH/check-in number) is populated for
 * `kind: "applied"` events only — received/refunded events already carry
 * their R-number as `rNumber`, so it is never duplicated there. */
export interface DepositRegisterEvent {
  dateBangkok: string | null;
  kind: "received" | "applied" | "refunded";
  rNumber: string | null;
  pmsRef: string;
  tender: DepositTender | null;
  amountSatang: number;
  voided: boolean;
  chRef: string | null;
}

/** `rNumber` is nullable (review fix): a voided row can itself carry an
 * unparseable/blank R-number, which never joins any aging/exceptions row —
 * the footnote must still be able to show it. */
export interface DepositVoidedEvent {
  rNumber: string | null;
  kind: "received" | "applied" | "refunded";
  amountSatang: number;
  dateBangkok: string | null;
}

export interface DepositRegisterResponse {
  property: Property;
  generatedAt: string;
  monthly: DepositMonthlyReconciliation[];
  aging: DepositAgingRow[];
  exceptions: {
    mismatched: DepositMismatchedException[];
    orphanApplied: DepositOrphanAppliedException[];
  };
  unparsedAppliedRows: number;
  /** Review fix: three more tripwire counters, none of which invent or drop
   * money. `zeroTenderRows` — a received/refunded row whose tender columns
   * summed to zero despite a nonzero ledger_amount. `blankBookingNoRows` —
   * a received/refunded row with no R-number at all (never joins a thread).
   * `undatedRows` — a row whose payment date failed to parse (dropped from
   * `monthly`, still counted in its thread). See deposit-register.ts's
   * `DepositRegisterData` doc comment for the full reasoning. */
  zeroTenderRows: number;
  blankBookingNoRows: number;
  undatedRows: number;
  voided: DepositVoidedEvent[];
  /** Owner ask (2026-08-01, register mapability): the full classified event
   * list, every kind INCLUDING voided ones, in chronological order — the
   * สรุปรายเดือน page filters this by `dateBangkok`'s `"YYYY-MM"` prefix to
   * show a month's events on expand. Additive. */
  events: DepositRegisterEvent[];
}

// 30. GET /api/:property/deposits/register — 503 when this property's PMS
// env URL is unset (see `ApiError`, `err.status === 503`, for the page's
// "PMS not connected" empty state), 502 on a live query failure.
export function getDepositRegister(property: Property): Promise<DepositRegisterResponse> {
  return request(`/${property}/deposits/register`);
}

// 31. PUT /api/:property/deposits/:rNumber/note — NOT month-close gated
// (commentary rule). `:rNumber` must match iHOTEL's fixed `R\d{6}` shape.
export function putDepositNote(
  property: Property,
  rNumber: string,
  body: { note: string | null; resolved: boolean },
): Promise<DepositNote> {
  return request(`/${property}/deposits/${encodeURIComponent(rNumber)}/note`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// 32. DELETE /api/:property/deposits/:rNumber/note
export function deleteDepositNote(property: Property, rNumber: string): Promise<void> {
  return request(`/${property}/deposits/${encodeURIComponent(rNumber)}/note`, { method: "DELETE" });
}
