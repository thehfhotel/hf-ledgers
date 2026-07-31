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
  ExpenseItem,
  Me,
  OtherIncomeItem,
  Property,
} from "../shared/types.ts";

// Typed fetch wrappers for every endpoint in src/shared/api.md (the
// contract of record). One function per endpoint, in the same order as
// that document. Non-2xx responses throw with the server's `{error}`
// message when present.

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
    throw new Error(message);
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
// Moves ONLY this day's booking_lines + other_income_items to the other
// property (merging into any rows already there) — never the day-sheet
// income/expenses/note, and never the cash-block override. See
// BookingDayPage.tsx's confirm dialog for the exact scope told to the user.
export function moveBookingDay(
  property: Property,
  date: string,
  to: Property,
): Promise<{ movedBookingLines: number; movedOtherIncome: number }> {
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

// POST /api/:property/day/:date/pull-from-pms
// Inserts booking lines from the PMS payment ledger for that property+date —
// button-triggered only (BookingDayPage.tsx), never automatic. Insert-only
// and idempotent: a payment whose pms_ref already exists that day is
// skipped server-side, and an existing row is never updated. Refunds are
// filtered out server-side and counted in `skippedRefunds`, never inserted.
export function pullFromPms(
  property: Property,
  date: string,
): Promise<{ inserted: number; skipped: number; skippedRefunds: number; unplaced: PmsUnplacedTender[] }> {
  return request(`/${property}/day/${date}/pull-from-pms`, { method: "POST" });
}
