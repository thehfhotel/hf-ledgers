import type {
  Category,
  CategoryKind,
  DaySheet,
  DaySummary,
  ExpenseItem,
  Me,
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

// 3. POST /api/:property/categories (mgr)
export function createCategory(
  property: Property,
  body: { kind: CategoryKind; nameTh: string; isCash: boolean },
): Promise<Category> {
  return request(`/${property}/categories`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// 4. PATCH /api/:property/categories/:id (mgr)
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

// 5. POST /api/:property/categories/reorder (mgr)
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
export function putIncomeCell(
  property: Property,
  date: string,
  categoryId: number,
  body: { amountSatang: number | null; note?: string | null },
): Promise<{ income: DaySheet["income"]; totals: DaySheet["totals"] }> {
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
