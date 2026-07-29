# Income Ledger API — contract of record

Locked interface. Every parallel work package (WP-A/B/C/D) builds against
this document instead of coordinating with each other. Changes to this file
are contract changes: they land in the serial Phase 2 integration step,
never hot-patched into a running fan-out.

Money = integer satang everywhere in this document (1 baht = 100 satang).
Business dates = Bangkok calendar strings `YYYY-MM-DD` (`todayBangkok()` in
`date.ts`). Audit timestamps (`createdAt`/`updatedAt`) are SQLite UTC
`datetime('now')` strings. UI language is Thai-only on every screen,
including admin — there is no `name_en` field anywhere in this contract.

## Data model (SQLite, `src/server/db.ts`, WAL + `PRAGMA foreign_keys = ON`)

- **`categories`** — `id` PK, `property` (`hf`|`hfville`), `kind`
  (`income`|`expense`), `name_th`, `sort`, `is_cash` (default 0),
  `archived_at` (nullable), `created_at`. Partial unique index on
  `(property, kind, name_th) WHERE archived_at IS NULL` — archived names are
  reusable. List index `(property, kind, sort)`. Category↔property/kind
  matching is server-enforced, not a DDL constraint.
- **`income_amounts`** — one cell per `(property, date, category_id)`:
  `amount_satang` (CHECK `>= 0`), `note` (nullable — carries รายการอื่นๆ's
  free-text), `updated_at`, `updated_by`. PK `(property, date, category_id)`.
  Saving `null`/`0` DELETEs the row (empty cells don't accumulate rows).
- **`expense_items`** — itemized: `id` PK, `property`, `date`,
  `category_id` FK, `note` (nullable), `amount_satang` (CHECK `> 0`),
  `created_at`, `created_by`, `updated_at`, `updated_by`.
- **`sheet_days`** — day remark + last-touched audit: `property`, `date`,
  `note` (nullable), `updated_at`, `updated_by`. PK `(property, date)`.
  Upserted on every mutation to that day (income cell, note, expense CRUD).
- **Seeding** — only when a property has zero categories (never re-fights
  admin edits). No hard delete ever; category rename = in-place relabel,
  meaning-change = archive + create new. Archived categories vanish from
  entry forms but still render on historical days that reference them.

Income seed (paper order; `*` = `is_cash`): มัดจำล่วงหน้า, ค่าห้องเงินสด*,
บัตรเครดิต/กสิกร, บัตรเครดิต ICBC, โอน/กสิกร, โอน ICBC, เว็ปไซด์,
รายการอื่นๆ*, บาร์น้ำ เงินสด*, บาร์น้ำ โอน/เครดิต.
Expense seed (all `is_cash = 1`, manager-editable): ซื้อของ/วัตถุดิบ,
ค่าแรงรายวัน, ค่าซ่อมแซม, ค่าสาธารณูปโภค, อื่นๆ.

## Auth (`src/server/auth.ts`)

`identify(req)` resolves the caller to `{ email, isManager } | null`:

- **development only** (`NODE_ENV === "development"`): `DEV_USER` env var
  bypass. Any other value of `NODE_ENV` ignores `DEV_USER` — fails closed.
- **else**: verify the `cf-access-jwt-assertion` header via the
  `verifyAccessJwt` pattern (RS256, JWKS cached 1h, checks `iss`/`aud`/
  `exp`/`nbf`) copied from `hf-mcp/src/auth.ts`. `isManager` = verified
  email is a member of `MANAGER_EMAILS` (comma-separated, lowercase).

Elysia wiring: a scoped `derive` resolves identity and 401s when absent;
`onBeforeHandle` on endpoints 3–5 (category admin) 403s non-managers.
Static assets and `GET /healthz` are unguarded — Cloudflare Access fronts
the whole host, so the app-side check is defense in depth for the API, not
the only gate.

## Error shape

Every non-2xx API response body is `{ "error": string }`.

| Status | Meaning |
|---|---|
| 400 | Malformed input (bad date/property, amount/note/name out of bounds) |
| 401 | No or invalid identity (see Auth above) |
| 403 | Valid identity, but not a manager, on a manager-only endpoint (3–5) |
| 404 | Property/category/expense not found, or references an unknown category |
| 409 | Duplicate active category name (`property` + `kind` + `nameTh`) |

`GET /healthz` lives OUTSIDE `/api`, requires no auth, and never touches the
DB (the deploy shim only allows 15 attempts × 2s).

## Bounds (validated server-side; constants in `src/shared/types.ts`)

- `amountSatang`: `0 ..= 99_999_999_999` (`AMOUNT_SATANG_MIN/MAX`)
- `note`: ≤ 200 chars (`NOTE_MAX_LEN`)
- `nameTh`: 1–80 chars (`NAME_TH_MIN_LEN`/`NAME_TH_MAX_LEN`)
- `property`: must be `"hf"` or `"hfville"` — 400 otherwise
- `date`: must match `YYYY-MM-DD` — 400 otherwise

## Endpoints (`/api`, Typebox; auth = any verified identity unless noted "mgr")

1. **`GET /api/me`** → `{ email, isManager }` (`Me`)

2. **`GET /api/:property/categories?includeArchived=1`** →
   `{ categories: Category[] }`, ordered by `(kind, sort)`. Omit the query
   param (or any value other than `1`) to get only active categories.

3. **`POST /api/:property/categories`** — mgr. Body
   `{ kind: CategoryKind, nameTh: string, isCash: boolean }` → 201
   `Category`. 409 if an active category with the same `(property, kind,
   nameTh)` exists.

4. **`PATCH /api/:property/categories/:id`** — mgr. Body: any subset of
   `{ nameTh?: string, isCash?: boolean, archived?: boolean }` → `Category`.
   `archived: true` sets `archived_at`; `archived: false` clears it (restore).
   404 if `:id` doesn't belong to `:property`.

5. **`POST /api/:property/categories/reorder`** — mgr. Body
   `{ kind: CategoryKind, orderedIds: number[] }` where `orderedIds` must be
   EXACTLY the active category ids of that `(property, kind)` (a permutation
   — no more, no fewer) → `{ categories: Category[] }`. 400 on mismatch.

6. **`GET /api/:property/days?month=YYYY-MM`** →
   `{ month: string, days: DaySummary[] }`. Only days with data, descending
   by date.

7. **`GET /api/:property/day/:date`** → `DaySheet`. `categories` = active
   categories of both kinds for the property, PLUS any archived category
   referenced by this day's `income`/`expenses` (flagged via its own
   `archivedAt`). `income` is keyed by `categoryId`. `totals` is always
   computed via `computeDayTotals()` from `src/shared/totals.ts` — the
   client imports the SAME function, never recomputes independently.

8. **`PUT /api/:property/day/:date/income/:categoryId`** — body
   `{ amountSatang: number | null, note?: string | null }`. `amountSatang`
   `null` or `0` DELETEs the cell (RDR empty-delete pattern). Upserts
   `sheet_days` audit. → `{ income: DaySheet["income"], totals: DayTotals }`.

9. **`PUT /api/:property/day/:date/note`** — body `{ note: string | null }`
   → `{ note: string | null }`. Upserts `sheet_days`.

10. **`POST /api/:property/day/:date/expenses`** — body
    `{ categoryId: number, amountSatang: number, note?: string | null }` →
    201 `ExpenseItem`. `amountSatang` must be `> 0` (unlike income cells,
    zero/empty expense lines simply aren't created).

11. **`PATCH /api/:property/expenses/:id`** — body: any subset of
    `{ categoryId?: number, amountSatang?: number, note?: string | null }` →
    `ExpenseItem`. 404 if `:id` doesn't belong to `:property`.

12. **`DELETE /api/:property/expenses/:id`** → 204 (or `{}` with 200 — pick
    one and keep `src/client/api.ts` consistent). 404 if `:id` doesn't
    belong to `:property`.

## Shared types (`src/shared/types.ts`, verbatim, READ-ONLY)

`Property`, `PROPERTIES`, `isProperty()`, `PROPERTY_LABELS` (full Thai/En
hotel names — `en` is contract metadata, never rendered), `CategoryKind`,
`Category`, `IncomeCell`, `ExpenseItem`, `DayTotals`, `DaySheet`,
`DaySummary`, `Me`, plus the bounds constants above. `money.ts`
(`formatSatang`, `parseAmountToSatang`), `totals.ts` (`computeDayTotals`),
`date.ts` (`todayBangkok`, `isoToThaiLong`, `isoToBuddhist`, month helpers).
