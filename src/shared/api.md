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

Income seed (paper order; `*` = `is_cash`), now also carrying its stable
`category_key` (see `CategoryKey` below): มัดจำล่วงหน้า (`deposit`),
ค่าห้องเงินสด* (`room_cash`), บัตรเครดิต/กสิกร (`credit_kbank`), บัตรเครดิต
ICBC (`credit_icbc`), โอน/กสิกร (`transfer_kbank`), โอน ICBC
(`transfer_icbc`), เว็ปไซด์ (`web`), รายการอื่นๆ* (see note below),
บาร์น้ำ เงินสด* (`bar_cash`), บาร์น้ำ โอน/เครดิต (`bar_transfer`).
Expense seed (all `is_cash = 1`, manager-editable): ซื้อของ/วัตถุดิบ,
ค่าแรงรายวัน, ค่าซ่อมแซม, ค่าสาธารณูปโภค, อื่นๆ.

> **รายการอื่นๆ — RESOLVED, build to this.** The paper's single อื่นๆ column
> mixes cash and transfer/credit, so one cash-flagged category cannot express
> it (measured: bank-deposit figure wrong on 75 days, 68,528 THB). Three
> pieces, in one shape:
>
> 1. The seed **splits into two categories** — `รายการอื่นๆ เงินสด`
>    (`other_cash`, `is_cash = 1`) and `รายการอื่นๆ โอน/เครดิต`
>    (`other_transfer`, `is_cash = 0`). Their sum is the paper's one อื่นๆ
>    line; `other_cash` alone is the paper's `รายการอื่นๆเงินสด` note line.
> 2. **`other_income_items` is the itemized detail behind them** — this
>    revenue is non-booking (breakfast, late checkout, parking, fines), runs
>    2-4 entries a day with free text, and has no booking row to derive from.
>    Each item's `isCash` decides which of the two cells it feeds.
> 3. **When a day has at least one item, the two cells are computed from the
>    items and are read-only.** With no items, both cells are directly
>    editable — that is how summary-only historical days import.
>
> This standing computation is deliberately unlike the booking-to-summary
> fill, which is an explicit button: there, two independent sources disagree
> on a third of days and the office's typed figure must win. Here there is
> one source, entered by one person on one screen, so a live sum surprises
> nobody. Prod currently holds zero income rows, so the split is a seed
> change with no data migration.

### Data model additions (Wave 2 — AS BUILT in `src/server/db.ts`)

`migrate()` no longer just runs a block of `CREATE TABLE IF NOT EXISTS`
statements — it now also runs guarded `ALTER TABLE` migrations via a
`addColumnIfMissing(table, column, ddl)` helper (checks `PRAGMA
table_info` first) so a throwing DDL statement can never crash-loop the
container. Every migration below is idempotent; verified by replaying it
against a copy of the production schema (30 seeded categories, zero data
rows) twice in a row.

- **`categories.category_key`** — nullable TEXT mirroring `CategoryKey`.
  Seeded rows get their key; manager-created categories get `NULL`.
  Backfilled by matching **whitespace-stripped** `name_th`
  (`replace(name_th, ' ', '')` in SQL, `.replace(/ /g, "")` in JS for the
  comparison value) — the paper and the original seed differ by a stray
  U+0020 in two labels. The one-time รายการอื่นๆ split (rename in place to
  `รายการอื่นๆ เงินสด` + insert `รายการอื่นๆ โอน/เครดิต` immediately after,
  shifting every later category's `sort` by +1) runs as part of this same
  migration, wrapped in one `db.transaction()` together with the backfill.
  A fresh database's seed now inserts all eleven income categories
  pre-split, with their keys, directly — the split migration is a no-op on
  a fresh DB. Never match category identity by `name_th` — managers can
  rename categories, `category_key` cannot change out from under a rename.
- **`income_amounts.source`** (TEXT, default `manual`) and
  **`income_amounts.manual`** (INTEGER boolean, default 1) — mirror
  `IncomeCell.source`/`.manual`. Every `income_amounts` insert/update/delete
  now also writes a row to the new append-only **`income_amount_history`**
  table (`property, date, category_id, old_satang, new_satang, source, at,
  by`) in the SAME transaction (`saveIncomeCell()`), satisfying the
  "history is a prerequisite for any automated write path" requirement.
  `POST .../fill-from-bookings?apply=true` skips any cell with `manual =
  1` and never invokes the delete branch (it only ever writes categories
  with a positive derived amount — see endpoint 20 below).
- **`booking_lines`** — new table, one row per `BookingLine`.
  **Diverges from the guidance above: the eight tender columns
  (`t_deposit` … `t_other`) are nullable**, not `default 0, never
  nullable`. `NULL` reads back as `0` (`toBookingLine()` in `db.ts`), so
  the API shape stays the lossless plain `Record<Tender, number>` from
  `types.ts` regardless — nullability is purely a DB-layer affordance for
  a future importer that may need to distinguish "blank on the paper" from
  "explicitly zero" (this wave's own write paths never leave a tender
  column NULL). Index `(property, date, seq)`; partial unique index on
  `(property, date, pms_ref) WHERE pms_ref IS NOT NULL`.
- **`other_income_items`** — new table, structurally close to
  `expense_items` (itemized, `amount_satang CHECK > 0`) but for
  `OtherIncomeItem` (`description` instead of a category+note pair,
  `is_cash` carried per-row instead of relying on a category flag).
- **Cash-block override — diverges from the guidance above.** Rather than
  a separate `cash_block_overrides` table, the four `CashBlockAmounts`
  fields (`cash_room_satang`, `cash_other_satang`, `cash_bar_satang`,
  `banked_cash_satang`) are nullable columns directly on **`sheet_days`**,
  each independently nullable (`null` = "use the derived value for this
  field"). `PUT .../cash-block` is an absolute replace, not a merge: every
  field present in the body becomes the stored override for that field;
  every field NOT present is reset to `NULL` (falls back to derived);
  `null` body clears all four. `CashBlock.entered` is still typed as
  `CashBlockAmounts | null` (never a partial) — the server pre-merges
  stored overrides on top of `derived` per field
  (`mergeCashBlockOverride()` in `db.ts`) before responding, so `entered`
  is `null` only when NOTHING is overridden, and otherwise a
  fully-populated, ready-to-display object. The `derived` half is never
  stored — always recomputed via `deriveCashBlock()`
  (`src/shared/bookings.ts`).
- **`sheet_days`** also gains nullable `verified_at`/`verified_by` (written
  by `PUT .../verify`) and `provenance` (TEXT, `NOT NULL DEFAULT 'app'` —
  every day this wave's write paths create is `"app"`; the Excel importer
  is expected to set `transcribed`/`reconstructed`/`summary_only`
  explicitly when it creates a row). A new **`closed_months`** table
  (renamed from the guidance's `month_closes`), PK `(property, month)`,
  row presence = closed; written by `PUT .../months/:month/close`.

**The two รายการอื่นๆ cells (endpoint 7/8), as built:** `IncomeCell` has no
field to signal "server-computed, read-only" — `source`/`manual` don't fit
(a computed cell is neither a human `manual` edit nor a `booking` fill).
Rather than stretch those fields, the server exposes `DaySheet.otherIncome`
(already in the contract) and the client is expected to derive
"read-only" for the `other_cash`/`other_transfer` categoryIds from
`otherIncome.length > 0` — the server enforces the same rule
independently: `GET day`/`GET days`/`PUT income` all read through
`getEffectiveIncomeForDay()`, which overrides those two cells with a live
`other_income_items` sum whenever the day has any item (regardless of
its own `isCash`), and `PUT .../income/:categoryId` 400s a direct write to
either of those two categoryIds while items exist.

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

Wave 2 additions:

- `bookingNo`: ≤ 40 chars (`BOOKING_NO_MAX_LEN`)
- `guestName`: ≤ 120 chars (`GUEST_NAME_MAX_LEN`)
- `roomNo`: ≤ 40 chars (`ROOM_NO_MAX_LEN`)
- `roomCount`, `nights`: `0 ..= 999` (`COUNT_MAX`)
- `description` (OtherIncomeItem): ≤ 200 chars (`DESCRIPTION_MAX_LEN`)

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

### Amendments to existing endpoints (Wave 2)

- **Endpoint 2** (`GET .../categories`) — each `Category` now also carries
  `categoryKey: CategoryKey | null` (see Shared types below).
- **Endpoint 6** (`GET .../days`) — each `DaySummary` gains `verified:
  boolean` and `provenance: DayProvenance`.
- **Endpoint 7** (`GET .../day/:date`) — `DaySheet` gains
  `bookingLineCount: number`, `otherIncome: OtherIncomeItem[]`,
  `cashBlock: CashBlock`, `provenance: DayProvenance`,
  `verifiedAt: string | null`, `verifiedBy: string | null`,
  `monthClosed: boolean`.
- **`listDaysWithData`** (`src/server/db.ts`) must gain a `booking_lines`
  arm (`SELECT DISTINCT date FROM booking_lines WHERE property = ? AND date
  LIKE ?`) alongside its existing `income_amounts` / `expense_items` /
  `sheet_days` arms. Its `sheet_days` arm requires `note IS NOT NULL`, so a
  day touched only via booking lines (no summary income/expense/note)
  would otherwise never surface in `GET .../days` — i.e. never appear in
  History.
- **Report labeling** (`src/client/components/ReportSheet.tsx`,
  `src/client/pages/DaySheetPage.tsx`) — the report currently prints
  `cashToDepositSatang` (gross cash income MINUS cash expenses) under the
  paper's own label `สรุปเงินสดฝากเข้าบัญชี`, but the paper's line of that
  name is the GROSS figure. Measured against the office's own books this
  overstates the banked amount on 75 days by 68,528 THB in total. The Wave 2
  UI must show three distinct, separately labeled lines: gross cash income
  (`cashIncomeSatang` — the paper's line), the deduction
  (`cashExpenseSatang`), and the net (`cashToDepositSatang`). Do not collapse
  them back into one number under one label. No new field is needed:
  `cashIncomeSatang` already is the gross figure.

## Wave 2 endpoints (built in `src/server/server.ts`)

Implemented against the plan below. Same conventions as above: any verified
identity unless noted "mgr"; every non-2xx body is `{ "error": string }`.
Endpoints 8, 10-12, 14-19 and 22 additionally 409
(`{ error: "month is closed" }`) when the target date's month is closed
(`closed_months`). Verify (22) is gated because a closed month is frozen
outright, sign-off included — you cannot flip the sign-off state of data
nobody is allowed to change. Endpoint 9 (day note) and 21 (cash-block)
are deliberately NOT gated: a note is commentary, and the cash-block
override is a manager correction to a derived control figure, which is
exactly the thing still worth recording after a close.

13. **`GET /api/:property/day/:date/bookings`** →
    `{ lines: BookingLine[], totals: BookingTotals }`. `lines` ordered by
    `seq` ascending. `totals` is always `computeBookingTotals(lines)`
    (`src/shared/bookings.ts`) — the client imports the SAME function,
    never recomputes independently.

14. **`POST /api/:property/day/:date/bookings`** — body: the editable
    `BookingLine` fields (everything except `id`/`property`/`date`/audit
    quartet; server assigns `seq` as `max(seq) + 1` for that day unless the
    body supplies one) → 201 `BookingLine`. 400 on an out-of-bounds
    `bookingNo` (`BOOKING_NO_MAX_LEN`), `guestName` (`GUEST_NAME_MAX_LEN`),
    `roomNo` (`ROOM_NO_MAX_LEN`), `roomCount`/`nights` (`COUNT_MAX`), or a
    negative amount.

15. **`PATCH /api/:property/bookings/:id`** — body: any subset of the
    editable `BookingLine` fields (never `id`/`property`/`date`) →
    `BookingLine`. 404 if `:id` doesn't belong to `:property`.

16. **`DELETE /api/:property/bookings/:id`** → 204. 404 if `:id` doesn't
    belong to `:property`.

17. **`POST /api/:property/day/:date/other-income`** — body
    `{ description: string | null, amountSatang: number, isCash: boolean }`
    → 201 `OtherIncomeItem`. `amountSatang` must be `> 0` (matches the
    `expense_items` convention — zero/empty lines simply aren't created).
    400 if `description` exceeds `DESCRIPTION_MAX_LEN`.

18. **`PATCH /api/:property/other-income/:id`** — body: any subset of
    `{ description?: string | null, amountSatang?: number, isCash?: boolean }`
    → `OtherIncomeItem`. 404 if `:id` doesn't belong to `:property`.

19. **`DELETE /api/:property/other-income/:id`** → 204. 404 if `:id`
    doesn't belong to `:property`.

20. **`POST /api/:property/day/:date/fill-from-bookings`** — computes
    `deriveIncomeFromBookings()` (`src/shared/bookings.ts`) over the day's
    booking lines (non-draft filtering happens inside that function) and
    diffs it against the day's current `IncomeCell`s, per `CategoryKey`.
    **Resolved: the apply signal is the query param `?apply=true`** (not a
    body flag) — consistent with endpoint 2's existing
    `?includeArchived=1`; `src/client/api.ts` must pass it the same way.
    A `CategoryKey` with no positive derived amount for the day (no
    booking line contributed to that tender, or there are no booking lines
    at all) is **omitted from `diff` entirely** — this is what "never
    deletes a cell it has no positive evidence for" means concretely: no
    diff line, nothing written, existing cell (if any) untouched. Without
    `?apply=true` it is preview-only →
    `{ diff: Array<{ categoryKey: CategoryKey, categoryId: number | null,
    beforeSatang: number, afterSatang: number, skippedManual: boolean }> }`.
    `categoryId` is `null` if the property has no active category seeded
    with that key yet (nothing is written for that line even with
    `?apply=true`). With `?apply=true`, it additionally writes each
    non-`manual` cell as an ordinary audited `IncomeCell`
    (`source: "booking"`, `manual: false`) — skipped when the value is
    unchanged, to keep `income_amount_history` free of no-op rows — and
    returns the same diff shape reflecting what
    was actually written — any cell flagged `manual: true` is left
    untouched (`skippedManual: true`) in both the preview and the apply.

21. **`PUT /api/:property/day/:date/cash-block`** — mgr. body: any subset
    of `CashBlockAmounts`, or `null` to clear the override entirely
    (omitted/cleared fields fall back to `derived` for that field) →
    `CashBlock`.

22. **`PUT /api/:property/day/:date/verify`** — any verified identity, NOT
    mgr-only: front desk signs off its own day, which is the whole point of
    the phase-2 "staff verify instead of type" workflow. 409s on a closed
    month. body `{ verified: boolean }` →
    `{ verifiedAt: string | null, verifiedBy: string | null }`.
    `verified: false` clears both back to `null`.

23. **`GET /api/:property/months/:month/close`** →
    `{ month: string, closed: boolean }`.

24. **`PUT /api/:property/months/:month/close`** — mgr. body
    `{ closed: boolean }` → `{ month: string, closed: boolean }`.
    `DaySheet.monthClosed` is a hint for the client to disable editing —
    it is NOT itself a server-side write lock on endpoints 8-21; if a write
    lock is added, document the enforcement here.

## Shared types (`src/shared/types.ts`, verbatim, READ-ONLY)

`Property`, `PROPERTIES`, `isProperty()`, `PROPERTY_LABELS` (full Thai/En
hotel names — `en` is contract metadata, never rendered), `CategoryKind`,
`Tender`, `TENDERS` (paper column order — iterate this, never
`Object.keys()`, on a `Record<Tender, ...>`), `TENDER_LABELS_TH`,
`CategoryKey` (stable category identity, independent of `nameTh` — managers
can rename categories), `TENDER_TO_CATEGORY_KEY` (the seven tenders that
derive a category cell; `"other"` is deliberately absent — it becomes an
itemized `OtherIncomeItem` instead), `Category` (now with `categoryKey`),
`IncomeCell` (now with `source`/`manual`), `ExpenseItem`, `BookingLine`,
`OtherIncomeItem`, `CashBlockAmounts`, `CashBlock`, `DayProvenance`,
`DayTotals`, `BookingTotals`, `DaySheet`
(see Wave 2 field additions above), `DaySummary` (now with
`verified`/`provenance`), `Me`, plus the bounds constants above.

`money.ts` (`formatSatang`, `parseAmountToSatang`), `totals.ts`
(`computeDayTotals`), `bookings.ts` (`computeBookingTotals`,
`deriveIncomeFromBookings`, `deriveCashBlock`, `lineArithmeticMismatch`,
`RECONCILE_TOLERANCE_SATANG`) — same philosophy as `totals.ts`: the server
computes with these and the client imports the SAME functions, so UI and
API can never disagree. `date.ts` (`todayBangkok`, `isoToThaiLong`,
`isoToBuddhist`, month helpers).
