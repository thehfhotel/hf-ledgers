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
`category_key` (see `CategoryKey` below): มัดจำล่วงหน้า โอน (`deposit`),
มัดจำล่วงหน้า เครดิต (`deposit_credit`), มัดจำล่วงหน้า (ตัดยอด) (`deposit_applied`
— Wave C, docs/adr/0001, seeded right after `deposit_credit`), ค่าห้องเงินสด*
(`room_cash`), บัตรเครดิต/กสิกร (`credit_kbank`), บัตรเครดิต ICBC
(`credit_icbc`), โอน/กสิกร (`transfer_kbank`), โอน ICBC (`transfer_icbc`),
เว็ปไซด์ (`web`), รายการอื่นๆ* (see note below), บาร์น้ำ เงินสด* (`bar_cash`),
บาร์น้ำ โอน (`bar_transfer`), บาร์น้ำ เครดิต (`bar_credit`) — fifteen
categories total. Expense seed (all `is_cash = 1`, manager-editable):
ซื้อของ/วัตถุดิบ, ค่าแรงรายวัน, ค่าซ่อมแซม, ค่าสาธารณูปโภค, อื่นๆ.

> **Accounting rule — TWO ERAS, split at each property's accrual cutover
> (`shared/accrual.ts`'s `ACCRUAL_CUTOVER_DATE`, `2026-07-31` for both `hf`
> and `hfville` today).** Historical days are NOT restated — a query
> spanning the cutover legitimately sees a discontinuity in what `รวม`
> means. See `docs/adr/0001-accrual-recognition-for-deposits.md` for the
> full reasoning and lifecycle.
>
> **Pre-cutover (kept verbatim, 2026-07-30 text) — an advance deposit IS
> income on the day it is taken.** `มัดจำล่วงหน้า` (`deposit`) counts toward
> the day's `รวม` like any other tender, because the deposit is 50% of the
> booking's payment, collected to create the booking — not a liability held
> on someone else's behalf. A handful of source sheets excluded it from
> their printed total (e.g. HF 2026-05-08, printed 53,586.40 vs 54,976.40
> with the 1,190 deposit); those sheets are the exception and the app is
> deliberately not bug-compatible with them. Cash refunded to a guest is NOT
> netted off income: the income cell stays gross and the refund shows up in
> the cash block, so `รวม` and the banked figure legitimately differ by the
> refund. Record the refund as a cash expense if it should reduce the day's
> net.
>
> **On/after cutover (Wave C) — a มัดจำล่วงหน้า is money received but NOT YET
> EARNED; the stay's full charge is recognised when the stay happens.**
> `รวมรายรับทั้งวัน` stops meaning "money received today" and means "revenue
> earned today" instead — it no longer reconciles with the bank by
> construction (that is the ADR's stated, accepted consequence). The two
> accrual moments: **received** (`deposit_events`, `kind: "received"` —
> money in, NOT รายรับ) and **applied** (the ninth `Tender`,
> `deposit_applied` — "ตัดยอดมัดจำ" — IS รายรับ, no money moves). A cash
> deposit received still reaches ยอดฝากจริง (`CashBlock.depositCashInSatang`)
> while staying entirely out of every income cell; a cash refund of a cash
> deposit reduces it back (`depositCashOutSatang`); transfer/credit/web/
> other deposit tenders never touch the cash figure either way. The retired
> pre-cutover `deposit`/`deposit_credit` categories keep their key/meaning
> (history is not restated) but render read-only and only-when-nonzero at
> the UI layer once a day is on/after cutover.

> **รายการอื่นๆ — RESOLVED, build to this.** The paper's single อื่นๆ column
> mixes cash and transfer/credit, so one cash-flagged category cannot express
> it (measured: bank-deposit figure wrong on 75 days, 68,528 THB). Three
> pieces, in one shape:
>
> 1. The seed **splits into two categories** — `รายการอื่นๆ เงินสด`
>    (`other_cash`, `is_cash = 1`) and `รายการอื่นๆ โอน/เครดิต`
>    (`other_transfer`, `is_cash = 0`, later renamed `รายการอื่นๆ โอน` — see
>    "โอน/เครดิต split" below). Their sum is the paper's one อื่นๆ
>    line; `other_cash` alone is the paper's `รายการอื่นๆเงินสด` note line.
> 2. **`other_income_items` is the itemized detail behind them** — this
>    revenue is non-booking (breakfast, late checkout, parking, fines), runs
>    2-4 entries a day with free text, and has no booking row to derive from.
>    Each item's `isCash` decides which of the two cells it feeds — there is
>    no itemized โอน/เครดิต distinction, so a non-cash item's amount always
>    computes into `other_transfer` (โอน) even when the actual receipt was a
>    credit card; `other_credit` is a separate, always-directly-editable
>    category for hand-keying credit-card receipts that are NOT itemized
>    here (the day sheet warns against double-entry — see below).
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

> **โอน/เครดิต split (Wave B, 2026-07-31, see
> docs/plan-unify-exports-tender-split.md item 2) — build to this.** The
> paper's three mixed-tender categories (มัดจำล่วงหน้า, รายการอื่นๆ
> โอน/เครดิต, บาร์น้ำ โอน/เครดิต) combined โอน+เครดิต in one input cell.
> `deposit`/`other_transfer`/`bar_transfer` **keep their key strings**
> (history stays under them untouched — no retro-split, mixed-tender data
> already on the books is exactly what the print's mixed-tender footnote
> covers) but their `name_th` becomes โอน-only wording going forward; three
> new sibling keys — `deposit_credit`, `other_credit`, `bar_credit` — carry
> เครดิต money instead, seeded immediately after their โอน partner. An
> additive, idempotent boot migration (`migrateTransferCreditSplit()` in
> `db.ts`, same shape as the `category_key` backfill below): renames the
> still-default transfer category and seeds its เครดิต sibling, but SKIPS
> (never throws) either step when the target `name_th` is already held by a
> different active category — `idx_categories_active_name` is a UNIQUE
> index, and a manager-created category can independently collide with one
> of the six target names; a throwing migration would crash the boot
> (`migrate()` runs at module top level, before `Bun.serve`) and
> crash-loop the container under `restart:unless-stopped`. A skip is logged
> (`console.log`, `[db] migrateTransferCreditSplit: ...`) and retried on
> every subsequent boot until the conflicting name is resolved. `deposit`'s
> booking-derived amount (`fill-from-bookings`, endpoint 20) still writes
> the WHOLE merged `t_deposit` tender into `deposit` — the `Tender` union
> itself is unchanged by this split — so the UI carries an explicit warning
> against also hand-keying the credit portion into `deposit_credit`.

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
  A fresh database's seed now inserts all fifteen income categories
  pre-split (see "โอน/เครดิต split" above for the three added 2026-07-31,
  and the Wave C section below for `deposit_applied`), with their keys,
  directly — every split/insert migration is a no-op on a fresh DB. Never
  match category identity by `name_th` — managers can rename categories,
  `category_key` cannot change out from under a rename.
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
- **Deposit-machine reconciliation rows** (docs/plan-unify-exports-tender-
  split.md item 6, Wave C, owner request 2026-07-31) — small change/coins
  that can't always go into the deposit machine, so ยอดฝากจริง legitimately
  differs from the day's raw cash total. Two more nullable columns on
  **`sheet_days`**, same shape/persistence/audit as the cash-block override
  above: `cash_held_back_satang` (today's cash held back — the owner's row
  1, "เงินสดยังไม่ฝาก (เข้าตู้ไม่ได้)") and `cash_brought_forward_satang` (a
  prior round's held-back cash deposited today — row 2, "เงินสดจากรอบก่อนที่
  เข้าตู้ไม่ได้"). `null` = not recorded; an explicit `0` is meaningful and
  distinct from `null` (never collapsed). They fold into `bankedSatang`
  INSIDE `deriveCashBlock()`: `bankedSatang = roomCash + otherCash + barCash
  - heldBackSatang + broughtForwardSatang` — subtract row 1, add row 2. An
  explicit `entered.bankedSatang` override (above) still wins over this
  computed figure, unchanged. Unlike the four `CashBlockAmounts` fields,
  these two have **no `derived` counterpart** (there is nothing in the
  day's income/expense data to derive them from — always a direct manual
  entry), so on the wire they live directly on `CashBlock` as
  `heldBackSatang`/`broughtForwardSatang: number | null` rather than inside
  `derived`/`entered` (see `CashAdjustmentAmounts`, Shared types below).
  `PUT .../cash-block`'s body accepts them as two more optional `number`
  fields, same absolute-replace rule as the four above (present -> stored,
  absent -> reset to `null`; a `null` body clears all six). **Not gated by
  month close**, same reasoning as the cash-block override itself: a
  reconciliation is exactly the thing still worth recording after a close.
  Bounds: `AMOUNT_SATANG_MIN/MAX`, same as every other satang field — the
  sign lives in the formula above, never in the stored value (both are
  always non-negative).
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

## Auth (`packages/shared/src/access.ts`)

`identify(req)` resolves the caller to `{ email } | null` (`Identity`):

- **development only** (`NODE_ENV === "development"`): `DEV_USER` env var
  bypass. Any other value of `NODE_ENV` ignores `DEV_USER` — fails closed.
- **else**: verify the `cf-access-jwt-assertion` header via the
  `verifyAccessJwt` pattern (RS256, JWKS cached 1h, checks `iss`/`aud`/
  `exp`/`nbf`) copied from `hf-mcp/src/auth.ts`.

**There are no roles in this app.** Cloudflare Access alone decides who may
reach `income.thehfhotel.org` — `identify()` only resolves WHO the caller is,
never WHAT they may do. The resolved email is recorded as
`created_by`/`updated_by`/`verified_by`/`closed_by` provenance on every
write; it never gates access to an endpoint. Every endpoint below is open to
any verified identity, including the office-1 and reception kiosk logins.

Elysia wiring: a scoped `derive` resolves identity and a top-level
`onBeforeHandle` 401s when it is absent. Static assets and `GET /healthz`
are unguarded.

This app-side check is NOT merely defense in depth, and an earlier version of
this paragraph saying so was wrong. Cloudflare Access fronts the public
hostname, but `docker-compose.yml` binds this container on `0.0.0.0:4040`
(and the slips container on `0.0.0.0:4060`), so any device already on the LAN
reaches the process directly without passing through Cloudflare — and on that
path `verifyAccessJwt` is the only gate there is. That is why an unset
`ACCESS_AUD` fails CLOSED rather than skipping the audience check; see
`packages/shared/src/access.ts`'s file header and its test suite.

## Error shape

Every non-2xx API response body is `{ "error": string }`.

| Status | Meaning |
|---|---|
| 400 | Malformed input (bad date/property, amount/note/name out of bounds) |
| 401 | No or invalid identity (see Auth above) |
| 404 | Property/category/expense not found, or references an unknown category |
| 409 | Duplicate active category name (`property` + `kind` + `nameTh`), or the target month is closed |

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
- `roomNo`: ≤ 200 chars (`ROOM_NO_MAX_LEN`) — group bookings carry long room
  lists; the imported 38-room HF booking on 2025-10-10 is 125 chars. The
  client slices to this bound on commit and the server validates against it,
  so lowering it silently destroys data on blur.
- `roomCount`, `nights`: `0 ..= 999` (`COUNT_MAX`)
- `remark` (BookingLine): ≤ 200 chars (`REMARK_MAX_LEN`) — settled at 200 to
  match `NOTE_MAX_LEN` and the note convention. The bound was previously
  unstated here, and the client allowed 500 while the server validated 200,
  so a long remark 400'd on blur and the row's edit was lost. Both sides read
  `REMARK_MAX_LEN`; neither re-declares the number locally.
- `description` (OtherIncomeItem): ≤ 200 chars (`DESCRIPTION_MAX_LEN`)

Wave D addition:

- `note` (`DepositNote`): ≤ 1000 chars (`DEPOSIT_NOTE_MAX_LEN`) — deliberately
  more generous than `NOTE_MAX_LEN`: this is the office's only durable record
  of *why* a deposit exception exists (e.g. the R015834-style 395->790 gap),
  so it needs room for a real explanation.

Wave 1 addition:

- `auditKey` (`payment_audits`): reuses `BOOKING_NO_MAX_LEN` (≤ 40 chars) —
  an audit key is always either a CH number or a receipt pay_no, both that
  same shape/length already bounded elsewhere in this contract; no new
  constant was introduced for it.

## Endpoints (`/api`, Typebox; auth = any verified identity — no roles)

1. **`GET /api/me`** → `{ email }` (`Me`)

2. **`GET /api/:property/categories?includeArchived=1`** →
   `{ categories: Category[] }`, ordered by `(kind, sort)`. Omit the query
   param (or any value other than `1`) to get only active categories.

3. **`POST /api/:property/categories`** — Body
   `{ kind: CategoryKind, nameTh: string, isCash: boolean }` → 201
   `Category`. 409 if an active category with the same `(property, kind,
   nameTh)` exists.

4. **`PATCH /api/:property/categories/:id`** — Body: any subset of
   `{ nameTh?: string, isCash?: boolean, archived?: boolean }` → `Category`.
   `archived: true` sets `archived_at`; `archived: false` clears it (restore).
   404 if `:id` doesn't belong to `:property`. **400 on `archived: true` for a
   category whose `categoryKey` is non-null** (`cannot archive a category with
   a category_key`) — a keyed category is what `fill-from-bookings` and the two
   รายการอื่นๆ cells derive into, so archiving it would silently strip that
   derivation from every future day. Renaming and `isCash` stay allowed. The
   admin UI therefore does not offer archive on keyed rows at all (it used to,
   and surfaced this English server message to a Thai-only screen).

5. **`POST /api/:property/categories/reorder`** — Body
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
   `sheet_days` audit. → `{ income: DaySheet["income"], totals: DayTotals,
   cashBlock: CashBlock }`. **`cashBlock` is additive** (Opus money-review
   P3, 2026-07-31): room/bar cash and the two computed รายการอื่นๆ cells
   all feed `deriveCashBlock()`, so without returning it here the client's
   cash-banking panel (and its print/PDF export) would read a stale
   `cashBlock` after every income edit until the next full `GET day`.
   Built the same way GET day (7) builds it — the stored heldBack/
   broughtForward adjustment and any `CashBlockAmounts` override already
   folded in.

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

  **Superseded in part by the deposit-machine reconciliation rows** (item 6
  above, Wave C, Opus money-review 2026-07-31): `DaySheetPage.tsx`'s panel
  header still lists the per-category cash rows (summing to
  `cashIncomeSatang`, but no longer printed as an aggregate line of its
  own), and its bold "(ยอดฝากจริง)" line is now `cashBlock.entered?.
  bankedSatang ?? cashBlock.derived.bankedSatang` — **not**
  `cashIncomeSatang` — since `bankedSatang` is the only figure that
  reflects a till-count override or a heldBack/broughtForward adjustment.
  The deduction line beneath it still reads `cashExpenseSatang` verbatim
  (unaffected by either), but the net line below THAT is now computed
  client-side as `bankedShown - cashExpenseSatang`, not the server's
  `cashToDepositSatang` — the latter is gross-cash-derived and would
  silently stop agreeing with the panel's own bold line once an override
  or adjustment exists. `cashToDepositSatang` itself is unchanged
  server-side (still `cashIncomeSatang - cashExpenseSatang`) and remains
  the correct figure for any consumer that genuinely wants the un-adjusted
  net — e.g. `GET .../days`'s `DaySummary.cashToDepositSatang`, which this
  change does not touch.

## Wave 2 endpoints (built in `src/server/server.ts`)

Implemented against the plan below. Same conventions as above: any verified
identity — no roles; every non-2xx body is `{ "error": string }`.
Endpoints 8, 10-12, 14-19, 22 and 25 additionally 409
(`{ error: "month is closed" }`) when the target date's month is closed
(`closed_months`) — endpoint 25 checks it for BOTH the source and
destination property. Verify (22) is gated because a closed month is frozen
outright, sign-off included — you cannot flip the sign-off state of data
nobody is allowed to change. Endpoint 9 (day note) and 21 (cash-block)
are deliberately NOT gated: a note is commentary, and the cash-block
override is a correction to a derived control figure, which is exactly the
thing still worth recording after a close.

13. **`GET /api/:property/day/:date/bookings`** →
    `{ lines: BookingLine[], totals: BookingTotals }`. `lines` ordered by
    `seq` ascending. `totals` is always `computeBookingTotals(lines)`
    (`src/shared/bookings.ts`) — the client imports the SAME function,
    never recomputes independently. **Wave 3 addition:** the response also
    carries `pmsPull: boolean` — `pmsConfigured(property)`
    (`src/server/pms-prefill.ts`), true iff this property's PMS env URL is
    set. This is the client's capability flag for the ดึงข้อมูล button
    (endpoint 26) — everything else about this endpoint is unchanged.

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

21. **`PUT /api/:property/day/:date/cash-block`** — body: any subset
    of `CashBlockAmounts` **plus** `CashAdjustmentAmounts`'s
    `heldBackSatang`/`broughtForwardSatang` (the deposit-machine
    reconciliation rows, item 6 above), or `null` to clear all six fields
    entirely (omitted/cleared fields fall back to `derived` for the four
    `CashBlockAmounts` fields, or to "not recorded" — `null` — for the two
    adjustment fields) → `CashBlock`. NOT gated by month close (see item 6
    above).

22. **`PUT /api/:property/day/:date/verify`** — front desk signs off its own
    day, which is the whole point of the phase-2 "staff verify instead of
    type" workflow. 409s on a closed month. body `{ verified: boolean }` →
    `{ verifiedAt: string | null, verifiedBy: string | null }`.
    `verified: false` clears both back to `null`.

23. **`GET /api/:property/months/:month/close`** →
    `{ month: string, closed: boolean }`.

24. **`PUT /api/:property/months/:month/close`** — body
    `{ closed: boolean }` → `{ month: string, closed: boolean }`.
    `DaySheet.monthClosed` is a hint for the client to disable editing —
    it is NOT itself a server-side write lock on endpoints 8-21; if a write
    lock is added, document the enforcement here.

25. **`POST /api/:property/day/:date/move`** — moves ONLY this day's
    `booking_lines`, `other_income_items`, AND `deposit_events` (Wave C,
    Opus money-review F2, 2026-07-31 — a moved day's deposit events used to
    strand on the origin property, so a cash มัดจำล่วงหน้า kept reaching the
    WRONG side's ยอดฝากจริง forever) from `:property` to another property.
    Body `{ to: Property }` → 200
    `{ movedBookingLines: number, movedOtherIncome: number, movedDepositEvents: number }`.
    400 (`{ error: "invalid to" }`) if `to` is missing/not `"hf"`/`"hfville"`,
    or equals `:property`. 409 (`{ error: "month is closed" }`) if `:date`'s
    month is closed on EITHER `:property` or `to` — checked for both sides
    before anything is written.

    **Scope, deliberately narrow beyond those three tables:** the day sheet
    itself — `sheet_days` (income cells, expenses, the day note) — is NOT
    moved; that is a different page's data and stays on its original
    property/date. Neither is the cash-block override: it is a
    single-valued correction of a derived figure, and merging two overrides
    is meaningless, so the client must say so rather than attempt it (both
    properties keep their own `entered`/`derived` cash block, untouched).
    `touchSheetDay()` still bumps `updated_at`/`updated_by` on BOTH
    property-days' `sheet_days` row (creating one if the day had none) from
    the caller's identity, so the move itself is visible in each day's own
    audit trail even though its content is untouched.

    **Merge, never refuse:** if the destination day already holds rows,
    the moved rows merge into them. `booking_lines.seq` is a dense
    per-(property,date) row order the printed day sheet renders as the row
    number, but it is only a plain index, not unique — so merging verbatim
    would produce duplicate `seq` values and silently corrupt that
    numbering. The server renumbers every moved booking line starting at
    the destination day's current `MAX(seq) + 1`, walked in the moved
    rows' existing `seq` order (ties broken by `id`) so their relative
    order survives the merge. `other_income_items`/`deposit_events` carry
    no `seq` (or category), so both merge with a plain re-key, no
    renumbering.

    Runs as a single transaction (`moveBookingDay()` in `db.ts`): if the
    destination day already has a booking line OR a deposit event sharing a
    `(property, date, pms_ref, ...)` with a moved row (the partial unique
    indexes — nothing writes `pms_ref` from the UI today, but a future
    importer might), the whole move rolls back and responds 500 rather
    than partially applying or crashing.

    No permission check — this app has no roles (see Auth above); any
    signed-in identity may move a day. Enqueues the analytics outbox for
    BOTH `(property, date)` and `(to, date)` — one call changes two
    property-days' rollups.

    Client wrapper (`src/client/api.ts`):
    `moveBookingDay(property: Property, date: string, to: Property):
    Promise<{ movedBookingLines: number; movedOtherIncome: number; movedDepositEvents: number }>`.

## Wave 3: PMS prefill (`src/server/pms-prefill.ts`, `docs/pms-prefill-plan.md`)

26. **`POST /api/:property/day/:date/pull-from-pms`** — no body. Inserts
    booking lines AND deposit events (Wave C, docs/adr/0001) from the PMS
    payment ledger (`ht_payment_ledger`) for `:property`'s day `:date`,
    button-triggered only (never automatic — no fetch on load, no
    polling). → 200
    `{ inserted: number, skipped: number, skippedRefunds: number,
    unplaced: Array<{ pmsRef: string, bookingNo: string | null,
    creditSatang: number, tranSatang: number }>,
    autoPlaced: Array<{ pmsRef: string, bookingNo: string | null,
    transferSatang: number, creditSatang: number }>,
    depositsInserted: number, depositsSkipped: number,
    anomalies: Array<{ pmsRef: string, reason: "mixed_scope" |
    "unknown_ds_name" | "free_without_applied" | "pre_cutover_deposit",
    detail: string }> }`.
    `depositsInserted`/`depositsSkipped`/`anomalies` are additive (Wave C,
    2026-07-31): `depositsInserted`/`depositsSkipped` mirror
    `inserted`/`skipped` but for `deposit_events` rows
    (`insertPmsDepositEvents()`, db.ts) — same idempotence key shape, just
    `(property, date, pms_ref, tender)` instead of `(property, date,
    pms_ref)` (one PMS payment can split tenders). `anomalies` is never
    money — every entry is a `pms-prefill.ts` classification oddity (mixed
    R/CH scope in one payment, an unrecognized `ds_name`, a
    ยกเลิกห้อง/คืนเงินส่วนเกิน/ค่าปรับ line's unexplained `ledger_free`, or a
    received/refunded deposit found on a date before this property's
    accrual cutover — `pre_cutover_deposit`, reported rather than dropped,
    never written as a `deposit_events` row on a day that can't
    legitimately hold one) reported for a human to look at, never silently
    folded into any total. `autoPlaced` is additive (added 2026-07-31) — existing consumers reading
    only `inserted`/`skipped`/`skippedRefunds`/`unplaced` are unaffected.

    **Dark by default.** 503 (`{ error: "pms prefill not configured" }`)
    when this property's PMS env URL (`PMS_DB_URL_HF` / `PMS_DB_URL_HFVILLE`
    — one per property, independently dark/live) is unset — the button
    itself is hidden client-side via the `pmsPull` capability flag on
    endpoint 13, this is the server-side enforcement of the same gate.

    **Insert-only and idempotent — the core guarantee.** A payment whose
    `pms_ref` (the PMS's own receipt/payment number, or `lid:<legacy id>`
    when blank) already exists on that `(property, date)` is skipped, never
    updated: hand edits on an existing row are sacred. Pressing the button
    twice is harmless (second press: `inserted: 0`, everything in
    `skipped`); a payment taken after the last press appears as a new row
    on the next press. Rows are keyed per PMS **payment**, not per folio, so
    a late second payment on the same booking arrives as a new row rather
    than requiring an update to an already-inserted one.

    **The tender-dedup rule.** iHOTEL replicates the whole tender split
    (cash/credit/transfer/web/free) onto every LINE of a multi-line
    receipt — summing raw rows would multiply the money (a verified
    real-world case differed by 57%). `pms-prefill.ts` deduplicates to one
    tender value per payment before this endpoint ever sees a candidate;
    `ledger_amount` (genuinely itemized per line) is summed raw into
    `grossRoomSatang`/`grossOtherSatang`. This endpoint trusts that
    dedup — it never re-sums tenders itself.

    **Auto-placement policy (evidence-based, set 2026-07-31 —
    `insertPmsBookingLines()` in `db.ts`, grep "AUTO-PLACEMENT POLICY").**
    `cash → t_cash`, `web → t_web`, `deposit → t_deposit` always map
    directly. Credit and transfer used to be left entirely at 0 under a
    "never guess the acquiring bank" rule — leaving them unwritten turned
    out to be a confirmed production money bug (12 of 17 PMS-inserted rows
    silently short by exactly their transfer amount; see
    `docs/plan-unify-exports-tender-split.md` item 4). The rule is now
    evidence-gated per tender:
    - **Transfer → `t_transfer_kbank`, on BOTH properties.** Across all
      6,024 historical booking lines on hf and hfville, `t_transfer_icbc`
      is 0 in every row — every transfer this hotel group has ever
      recorded is โอน/กสิกร. If a real ICBC transfer ever appears in the
      history, this policy needs revisiting.
    - **Credit → `t_credit_kbank`, ONLY on `hfville`.** hfville's
      credit-card history uses `credit_kbank` exclusively (one bank in
      practice). `hf` genuinely uses both `credit_kbank` and
      `credit_icbc`, so which bank an `hf` credit-card payment landed on
      cannot be inferred from the PMS ledger — it stays unwritten (0)
      there, same as the old rule.
    Amounts the server placed on a bank column are reported back in
    `autoPlaced` (one entry per inserted-or-skipped non-refund candidate
    with a nonzero placed transfer/hfville-credit amount) — a
    verification note for the operator, since it's still an inference,
    just an evidence-backed one now. Amounts that remain genuinely
    unresolvable (hf credit only, going forward) are reported in
    `unplaced`, same "type it in by hand" contract as before. `discountSatang`
    is never filled either — **correction (Wave C, C0 gate V2): a discount/
    comp column DOES exist in the PMS ledger (`ledger_free` — see below);
    this importer still never reads it into `discountSatang`.** `ledger_free`
    is read for exactly one purpose (the ตัดยอดล่วงหน้า line's applied-deposit
    amount, keyed by `ds_name`, never by "free != 0" — see the Wave C
    section below); on every OTHER line, including a ค่าห้อง line's own
    genuine discount/comp use of the same column, it is deliberately left
    unread. `discountSatang` stays `0` from the importer, editable by hand
    as always.

    **Refunds are reported, never inserted.** A candidate whose net tender
    total is negative (`isRefund: true`) is filtered out before insertion
    and counted in `skippedRefunds` — it never becomes a booking-line row,
    positive or negative.

    **Calendar-day window, not a cashier round.** The pulled window is
    `:date`'s Bangkok calendar day (`bangkokDayWindow()` in
    `pms-prefill.ts`) — a payment recorded just after local midnight lands
    on the next day's sheet, not the round it was taken in. See
    `docs/pms-prefill-plan.md` "Day boundary" for the rationale and the
    known v2 escape hatch if this ever bites in practice.

    **Failure is plain and inserts nothing.** A PMS query failure (network,
    auth, bad SQL) is caught and returned as 502 `{ error: string }` before
    any row is written — never a partial insert. 409
    (`{ error: "month is closed" }`) applies exactly like every other
    write path (`closedMonthResponse`). Enqueues the analytics outbox for
    `(property, date)` only when `inserted > 0`.

    Client wrapper (`src/client/api.ts`):
    `pullFromPms(property: Property, date: string):
    Promise<{ inserted: number; skipped: number; skippedRefunds: number;
    unplaced: PmsUnplacedTender[]; autoPlaced: PmsAutoPlacedTender[];
    depositsInserted: number; depositsSkipped: number; anomalies:
    PmsAnomaly[] }>` — fully typed at the source (Wave C, 2026-07-31;
    `PmsAutoPlacedTender` was added the same wave, closing the earlier gap
    where `BookingDayPage.tsx` had to widen the result with a local cast).

## Wave C: deposit_events (`src/server/db.ts`, `docs/adr/0001-accrual-recognition-for-deposits.md`)

27. **`POST /api/:property/day/:date/deposits`** — hand-entry create for a
    received/refunded มัดจำล่วงหน้า moment. Body
    `{ kind: "received" | "refunded", bookingNo: string | null, guestName:
    string | null, tender: "cash" | "transfer" | "credit" | "web" | "other",
    amountSatang: number, note: string | null }` → 201 `DepositEvent`.
    `amountSatang` must be `> 0` (a magnitude — `kind` carries the sign,
    same convention as `deposit_events.amount_satang`). Mirrors the
    other-income CRUD shape (endpoint 17): `closedMonthResponse` (409 on a
    closed month), `touchSheetDay` + `enqueueAnalyticsPush` on write.
    **400 (`{ error: "pre-cutover date: deposits are not tracked before the
    accrual cutover" }`) when `:date` is before `:property`'s accrual
    cutover** (`isAccrualDay()`, shared/accrual.ts) — a pre-cutover day can
    never legitimately hold one under the new model.

28. **`PATCH /api/:property/deposits/:id`** — body: any subset of the
    fields above → `DepositEvent`. 404 if `:id` doesn't belong to
    `:property`. Same closed-month/pre-cutover gates as create, evaluated
    against the EXISTING event's own `date` (not gated by whether the patch
    itself touches money — patching `note` alone on a pre-cutover row would
    404 differently, but a pre-cutover row cannot exist in the first place
    outside a data anomaly, so this is a defensive backstop, not a live
    path).

29. **`DELETE /api/:property/deposits/:id`** → 204. Same gates as update.

`GET /api/:property/day/:date` (endpoint 7) gains `deposits: DepositEvent[]`
— this day's rows, additive alongside every other `DaySheet` field.
`CashBlock` gains always-derived `depositCashInSatang`/`depositCashOutSatang`
(never stored, never part of the `CashBlockAmounts` override pair — see
`depositCashTotals()`/`deriveCashBlock()` in `shared/bookings.ts`).

**Data model.** New table `deposit_events`: `id` PK, `property`, `date`,
`kind` (`received`|`refunded`), `booking_no` (nullable — the R-number for a
PMS-sourced row), `guest_name` (nullable), `tender`
(`cash`|`transfer`|`credit`|`web`|`other` — bank-agnostic on purpose, unlike
the booking-grid `Tender` columns), `amount_satang` (CHECK `> 0`, a
magnitude), `note` (nullable), `source` (`manual`|`pms`), `pms_ref`
(nullable), audit quartet. Unique `(property, date, pms_ref, tender) WHERE
pms_ref IS NOT NULL` — one PMS payment can split across tenders. New column
`booking_lines.t_deposit_applied` (nullable, `CHECK >= 0`, same shape as
every other tender column) — the ninth `Tender`'s DB column. New income
category `deposit_applied` (nameTh "มัดจำล่วงหน้า (ตัดยอด)", `is_cash =
0`), seeded immediately after `deposit_credit`; an additive boot migration
(`migrateDepositAppliedCategoryForProperty()`, db.ts, same
splice-and-shift/collision-skip-and-log shape as `migrateTransferCreditSplit`)
inserts it for a pre-Wave-C database. Fifteen income categories total on a
fresh DB going forward.

**Importer** (`src/server/pms-prefill.ts`, rewritten this wave — see
`docs/adr/0001` and the plan's C0/C3 sections for the full classification
table): classifies PMS ledger lines by `ds_name` text (never `ds_id`,
log-only now) against six exact labels (`ค่าห้อง`, `จ่ายล่วงหน้า`,
`ยกเลิกห้อง`, `คืนเงินส่วนเกิน`, `คืนเงินจองห้อง`, `ค่าปรับ`) plus the
ตัดยอดล่วงหน้า prefix family (`"ตัดยอดล่วงหน้า Booking No:" + R-number`). A
payment group is R-scoped (จ่ายล่วงหน้า/คืนเงินจองห้อง → `DepositCandidate`s,
one per non-zero raw tender column) or CH-scoped (everything else,
including ตัดยอดล่วงหน้า → `PrefillCandidate` — the applied amount comes
from that line's `ledger_free`, per V1, and that SAME line's
`ledger_amount` is excluded from gross even though its `ds_id` is typically
`P001` — the live double-booking bug this rewrite fixes). A group mixing
both scopes emits nothing plus a `mixed_scope` anomaly (a pure safety net —
zero live instances per the C0 gate). `PrefillCandidate` no longer carries
`isDeposit`/`depositSatang` (retired with the pre-cutover `deposit` tender
at the write boundary — `insertPmsBookingLines` no longer writes
`t_deposit` at all); it gains `appliedDepositSatang` and
`appliedDepositBookingNos` (the R-number(s) an applied line's label
carries, folded into the inserted row's `remark`).

## Wave D: the office deposit register + re-pull corrections (issue #5)

Two independent features sharing one wave: a read-mostly office reconciliation
view over the PMS's full deposit-lifecycle history (`src/server/deposit-register.ts`,
a SEPARATE direct-to-PMS code path — does NOT depend on Wave C's importer or
the accrual cutover), and a re-pull "diff and accept" flow so an already-
imported booking line can be reconciled against the PMS without silently
auto-overwriting a hand edit. **Numbering note:** the plan's draft numbered
the register endpoint 27 — by the time this wave was built, 27/28/29 were
already the shipped Wave C deposit_events hand-entry CRUD above, so the new
endpoints below continue sequentially from 30.

30. **`GET /api/:property/deposits/register`** → `{ property: Property,
    generatedAt: string, monthly: MonthlyDepositReconciliation[], aging:
    DepositAgingRow[], finished: DepositAgingRow[], exceptions: { mismatched:
    MismatchedDepositException[], orphanApplied:
    OrphanAppliedDepositException[], overRefunded:
    OverRefundedDepositException[] }, unparsedAppliedRows: number,
    zeroTenderRows: number, blankBookingNoRows: number, undatedRows: number,
    voided: VoidedDepositEventSummary[], events: DepositRegisterEvent[] }`.
    Same dark-by-default gate as endpoint 26:
    **503** (`{ error: "pms prefill not configured" }`) when this
    property's PMS env URL is unset, **502** on a live query failure,
    nothing returned on either. Queries the property's FULL
    `ht_payment_ledger` history (no date window, unlike every day-scoped
    endpoint above) for exactly the three deposit-lifecycle `ds_name`s —
    `จ่ายล่วงหน้า` (received, exact), the `ตัดยอดล่วงหน้า Booking No:` prefix
    family (applied), `คืนเงินจองห้อง` (refunded, exact) — voided rows
    (`ledger_status = 'ยกเลิก'`) are RETURNED, tagged, never filtered out of
    the query.

    - `monthly` is the opening/received/applied/refunded/closing
      reconciliation, ONE ROW PER Bangkok month that has at least one active
      (non-voided) event — **returned CHRONOLOGICAL (ascending)**, and the
      client's สรุปรายเดือน table (`DepositRegisterPage.tsx`) renders it in
      this SAME ascending (oldest-first) order (owner ask, 2026-08-01, live
      มัดจำ register fix round — was reversed client-side to newest-first).
      The first month
      with any activity opens at `0` (OWNER-DECIDED, plan D-open-items:
      pre-feature มัดจำ history is out of scope, hfville's first deposit-
      lifecycle month is 2026-03, hf's is 2026-04); every later month's
      opening is exactly the prior month's closing.
    - `aging` is every R-number thread with `outstandingSatang > 0`
      (received - applied - refunded, voided excluded from all three),
      **sorted oldest-first by its earliest active event's date** — the
      R015834-style case (applied > received) makes `outstandingSatang`
      NEGATIVE, so it never appears here; it appears in `exceptions.mismatched`
      instead.
    - **`finished` (owner ask, 2026-08-01, unified มัดจำ table) — additive,
      SAME row shape as `aging`.** Every R-number thread whose `status` is
      `"applied"` or `"refunded"` (the `depositFilterBucketForStatus`
      "finished" bucket, `src/client/pages/depositRegisterFilter.ts`) —
      i.e. every closed-out thread, uncapped. **Sorted newest-closed-first**
      by `closedDateBangkok` (see below; a thread with no computable closing
      date sorts last). Replaces the client's old ตัดยอดแล้วล่าสุด section,
      which was built client-side from `events` filtered to
      `kind === "applied" && !voided` and capped at the 20 most recent —
      that capped, event-level (not thread-level) list is retired; the
      client's register page now renders `aging` and `finished` through ONE
      unified thread table, switching which array(s) feed it via the
      ทั้งหมด/คงค้าง/เสร็จสิ้น pill.
    - **`closedDateBangkok: string | null` (owner ask, 2026-08-01, unified
      มัดจำ table) — additive, on EVERY `aging`/`finished` row.** The latest
      non-voided `applied` OR `refunded` event's date for that thread —
      broader than `appliedDateBangkok` below (which is `null` for a thread
      closed purely by a refund, since it has no applied event at all).
      Always `null` on an `aging` row (outstanding by definition, never
      closed); on a `finished` row, `null` only in the defensive case where
      its closing event's own date failed to parse. The client uses this to
      compute the unified table's "ค้างมา (วัน)" column for a finished row —
      `firstEventDate` -> `closedDateBangkok` (days the deposit sat before
      being resolved) — instead of the outstanding bucket's own
      `firstEventDate` -> today.
    - `exceptions.mismatched`: threads where `receivedSatang > 0 &&
      appliedSatang > 0 && |appliedSatang - receivedSatang| >
      RECONCILE_TOLERANCE_SATANG` (`shared/bookings.ts`, 100 satang / 1 THB —
      the same tolerance the booking-vs-summary variance strip uses), with
      `diffSatang = appliedSatang - receivedSatang` (signed, never abs'd —
      the R015834 case: received 39_500, applied 79_000 -> `diffSatang:
      39_500`).
    - `exceptions.orphanApplied`: threads where `appliedSatang > 0 &&
      receivedSatang === 0` — money applied against an R-number with no
      recorded receipt at all.
    - **`exceptions.overRefunded` (owner fix round, 2026-08-01, live
      มัดจำ register, real data — the R015832 case) — additive, a THIRD
      exception bucket.** Threads where `refundedSatang - receivedSatang >
      RECONCILE_TOLERANCE_SATANG` — the register paid back more than it
      actively holds a receipt for. The proven live case, R015832: the
      received row was VOIDED (`ledger_status = 'ยกเลิก'`, correctly excluded
      from sums — `receivedSatang` lands at exactly `0`) while its
      คืนเงินจองห้อง refund row (`R2607-0480`) stayed ACTIVE and correctly
      subtracted 39_500 satang (395.00) — one cancellation reversing the
      money TWICE, closing the month 395.00 low with no signal anywhere
      until this fix. `diffSatang = receivedSatang - refundedSatang` —
      ALWAYS negative by construction (the excess refunded, never abs'd —
      same signed-field convention as `mismatched.diffSatang`, R015832 ->
      `diffSatang: -39_500`). Checked INDEPENDENTLY of the
      `mismatched`/`orphanApplied` branching (never an `else` off that
      chain) — a thread can appear in `overRefunded` AND `mismatched` at
      once (a small early over-refund plus a later, separately-mismatched
      application is a real, if rare, shape). `refundedSatang > receivedSatang`
      forces `outstandingSatang = receivedSatang - appliedSatang -
      refundedSatang` NEGATIVE regardless of `appliedSatang` (subtracting a
      further `appliedSatang >= 0` only makes it more negative) — so an
      `overRefunded` thread can never appear in `aging` either (confirmed:
      `aging`'s own `outstandingSatang > 0` filter already excludes it, no
      change needed there). This row shape carries the SAME enrichment as
      `mismatched`/`orphanApplied` below (`receivedPmsRef`/`status`/
      `guestName`/`appliedChRef`/`appliedDateBangkok`/note fields) **PLUS**
      `receivedTenders` (see that field's own doc further down) — unlike the
      other two exception kinds, this bucket's whole point is "what (if
      anything) was actually, actively received", so showing it here is in
      scope where it wasn't for `mismatched`/`orphanApplied`.
    - `unparsedAppliedRows` is a tripwire count: an applied
      (`ตัดยอดล่วงหน้า Booking No:…`) row whose R-number suffix doesn't match
      `R\d{6}` is still classified and counted toward `monthly`, just
      excluded from every thread (nothing to group it by) — never dropped
      silently.
    - **Three more tripwire counters (review fix), none of which ever
      invent or drop money — each just names a way a row can otherwise
      leave with zero signal:**
      - `zeroTenderRows`: a received/refunded row whose four tender columns
        (`ledger_cash`/`ledger_credit`/`ledger_tran`/`ledger_web`) summed to
        ZERO despite a nonzero `ledger_amount` — `amountSatang` ends up `0`,
        so the row's money is otherwise invisible everywhere downstream.
        `ledger_amount` is selected "for completeness/future tripwires" —
        this is that future.
      - `blankBookingNoRows`: a received/refunded row with a blank
        `ledger_cin_no` — `rNumber: null`, so the event can never join a
        thread (no aging row, no exception, no note ever sees it), even
        though it still fully participates in `monthly`. Distinct from
        `unparsedAppliedRows`, which is applied-row-only.
      - `undatedRows`: an event whose `ledger_pay_date` failed to parse —
        dropped from `monthly` (which needs a month to bucket by) while
        still fully counted in whichever thread it belongs to.
    - `voided` flattens every voided event straight out of the classified
      event list (computed inside `buildDepositRegisterData`, review fix —
      it used to walk `threads`, which silently dropped a voided event
      whose R-number was unparseable/blank, since such an event never joins
      any thread at all) — the register page's collapsed "ไม่รวมในยอดข้างต้น"
      footnote, independent of which threads happen to also be outstanding
      or exceptional. `VoidedDepositEventSummary.rNumber` is nullable for
      exactly that reason.
    - Every `aging`/`finished`/`exceptions.mismatched`/
      `exceptions.orphanApplied`/`exceptions.overRefunded` row additionally
      carries `note: string | null`, `resolvedAt: string | null`,
      `resolvedBy: string | null` — merged from `deposit_notes` by
      R-number, `null`/`null`/`null` when no note thread exists yet. A
      thread can appear in `aging` AND `exceptions` at once (still
      outstanding, but also mismatched) — the same note applies to both;
      `finished` and `aging` are mutually exclusive (a thread's `status`
      puts it in exactly one bucket), but a `finished` thread can likewise
      also be an `exceptions.mismatched`/`exceptions.overRefunded` row
      simultaneously (an `overRefunded` thread's `status` is almost always
      `"refunded"`, `finished`-bucketed, per `deriveDepositThreadStatus` —
      see `OverRefundedDepositException`'s own doc comment,
      `src/server/deposit-register.ts`).
    - **`events` (owner ask, 2026-08-01, register mapability) — additive.**
      The FULL classified event list, every kind INCLUDING voided ones,
      exposed straight off `DepositRegisterData.events` (no
      recomputation) in chronological order (same order the underlying
      query returns rows in). One entry per classified ledger row:
      `{ dateBangkok: string | null, kind: "received" | "applied" |
      "refunded", rNumber: string | null, pmsRef: string, tender:
      DepositTender | null, amountSatang: number, voided: boolean, chRef:
      string | null }`. `pmsRef` is the payment key
      (`COALESCE(NULLIF(ledger_pay_no,''), 'lid:'||ledger_legacy_id)`) —
      the office's own receipt/payment number. `tender` is which of the
      four raw tender columns (cash/credit/transfer/web) carried the
      money for a received/refunded event (the first non-zero one,
      C0-verified single-line-group assumption) — `null` for `kind:
      "applied"` (an accounting offset via `ledger_free`, no bank
      movement) and `null` when a received/refunded row's tender columns
      are genuinely all zero (the `zeroTenderRow` tripwire case). `chRef`
      is the CH (check-in) number, populated for `kind: "applied"` events
      ONLY — that ds_name's OWN `ledger_cin_no` holds the CH-number on
      that scope of line (never the R-number, which is parsed from the
      label suffix instead); `null` for received/refunded events (their
      `ledger_cin_no` is already `rNumber`, never duplicated here) and for
      an applied row whose `ledger_cin_no` is itself blank. Also carries
      `guestName: string | null` (owner ask, 2026-08-01, guest name — see
      below). The client (`DepositRegisterPage.tsx`) filters this by
      `dateBangkok`'s `"YYYY-MM"` prefix to drive สรุปรายเดือน's expandable
      per-month event list. (It no longer filters this by
      `kind === "applied" && !voided` for a ตัดยอดแล้วล่าสุด section — that
      client-side derivation was retired 2026-08-01 in favor of the
      `finished` field above.)
    - **`receivedPmsRef`, `status`, `appliedChRef`, `appliedDateBangkok`
      (owner ask, 2026-08-01) — additive fields on EVERY
      `aging`/`finished`/`exceptions.mismatched`/`exceptions.orphanApplied`/
      `exceptions.overRefunded` row.**
      `receivedPmsRef: string | null` is that thread's own received
      event's `pmsRef` (voided excluded), `null` when none — lets the
      office find the paper receipt behind an R-number without opening
      the PMS (`orphanApplied` rows are always `null` here by
      definition — no received event exists). `status:
      DepositThreadStatus` (`"waitingCheckin" | "applied" | "refunded" |
      "partial"`, shared/types.ts — see `DEPOSIT_THREAD_STATUS_LABELS_TH`
      for the canonical รอเช็คอิน/ตัดยอดแล้ว/คืนเงินแล้ว/บางส่วน labels) is
      derived PURELY from that thread's own received/applied/refunded/
      outstanding figures via `deriveDepositThreadStatus()`
      (`src/server/deposit-register.ts`) — never stored, always
      recomputed. `appliedChRef`/`appliedDateBangkok: string | null` are
      the CH ref + date of that thread's LATEST non-voided applied event
      (`null`/`null` when it has none) — "where it went" for a
      `"applied"`/`"partial"` status, so a used deposit is traceable
      without opening the PMS. Note that a thread whose status is
      `"applied"` (fully absorbed, `outstandingSatang <= 0`) or
      `"refunded"` never appears in `aging` at all (that list filters
      `outstandingSatang > 0`) — it appears in `finished` instead (or
      `events`, for a month's expandable row on สรุปรายเดือน).
    - **`guestName: string | null` (owner ask, 2026-08-01, deposit register
      guest name) — additive, on EVERY `aging`/`finished`/
      `exceptions.mismatched`/`exceptions.orphanApplied`/
      `exceptions.overRefunded` row AND on every `events` entry.**
      `DEPOSIT_LEDGER_QUERY` gained the same `ht_customers` LEFT JOIN
      `pms-prefill.ts`'s `LEDGER_QUERY` already used (copied verbatim —
      the C-prefix join condition verified live 2026-07-30), selecting
      only `cust_title`/`cust_firstname`/`cust_lastname`/`cust_name2` (the
      four columns the `ledger_ro` role is granted on `ht_customers`).
      Assembled by the SAME `buildGuestName()` pms-prefill.ts uses
      (exported, reused — never a second copy): title glued onto the
      first name with no space, then the last name (preferring
      `cust_lastname`, falling back to `cust_name2` when blank) — see
      `buildGuestName`'s own doc comment for the full per-property data
      shape this rule is based on. On `events`, `guestName` is that EVENT's
      own join result. On `aging`/`exceptions.*` rows, `guestName` is the
      THREAD's guest: the received event's guest wins; if it has none
      (e.g. the orphanApplied shape, no received event at all), falls back
      to any other event's guest in the thread (`deriveThreadGuestName()`,
      `src/server/deposit-register.ts`) — deliberately NOT voided-aware
      (guest identity is a property of the person, not of whether that
      particular payment line was later cancelled, unlike the money sums).
      `null` whenever no event in scope has an `ht_customers` match.
    - **`receivedTenders: { tender: DepositTender; amountSatang: number }[]`
      (owner ask, 2026-08-01, มัดจำ register tender visibility) — additive,
      on EVERY `aging`/`finished` row (NOT on `exceptions.mismatched`/
      `exceptions.orphanApplied` — out of scope for THAT ask). Owner fix
      round, 2026-08-01, the R015832 case: ALSO on `exceptions.overRefunded`
      rows — that bucket's whole point is "what was actually, actively
      received", so the tender breakdown is directly relevant there in a way
      it wasn't for the other two exception kinds (usually empty in
      practice: the R015832 shape's triggering condition is exactly a
      receipt that's been voided, leaving no active received event to
      derive a tender from).** That thread's non-voided `kind: "received"`
      events, grouped by `tender` and summed
      (`deriveReceivedTenders()`/`DepositThread.receivedTenders`,
      `src/server/deposit-register.ts`) — usually one entry; a genuine split
      receipt (two received events on the same R-number using different
      tenders, e.g. part cash part transfer) produces two, each with its own
      summed `amountSatang`. An event whose own `tender` is `null` (the
      `zeroTenderRow` case: all four raw tender columns zero) contributes
      nothing. Empty array (never `null`) when the thread has no such event
      at all (e.g. every `orphanApplied`-shaped thread, which by definition
      has no received event). Order is first-seen, not alphabetical.
      `applied`/`refunded` events are never read here — RECEIVED tender
      only; a refund's own tender is already visible via the `events` feed's
      สรุปรายเดือน month-expansion rows, out of scope for this thread-level
      field.

31. **`PUT /api/:property/deposits/:rNumber/note`** — body `{ note: string |
    null, resolved: boolean }` → `DepositNote`. `:rNumber` must match
    `/^R\d{6}$/` (400 otherwise, `{ error: "invalid rNumber" }`) — iHOTEL's
    fixed shape, read straight off this same page's rows. `resolved: true`
    stamps `resolvedAt`/`resolvedBy` (the caller's identity); `resolved:
    false` clears both back to `null` — mirrors `PUT .../day/:date/verify`'s
    resolved/unresolve toggle exactly. **NOT month-close gated** (commentary
    rule, same as the day note/endpoint 9 and the cash-block adjustment/
    endpoint 21) — a note against an R-number is not a booking-day write,
    and `deposit_notes` carries no `date` at all (keyed by `property` +
    `r_number` only), so month-close cannot structurally apply. ONE note
    thread per `(property, rNumber)` — an R-number pairs with its deposit
    for life (docs/adr/0001: the booking is moved, never replaced), so this
    is never per-exception-kind.

    Elysia routing note: the path parameter is internally named `:id`, not
    `:rNumber` — the underlying router (memoirist) rejects two different
    parameter NAMES at the same tree position, and endpoints 28/29 already
    registered `:id` there for `deposit_events`. The URL text itself is
    unaffected; this is purely an internal capture-group label.

32. **`DELETE /api/:property/deposits/:rNumber/note`** → 204, always
    (deleting a note thread that doesn't exist is a harmless no-op, not a
    404 — unlike every other `DELETE` in this contract, there is no
    "the resource must have existed" invariant worth enforcing here). Same
    `rNumber` validation and month-close exemption as `PUT` above.

33. **`POST /api/:property/bookings/:id/accept-pms-update`** — no body →
    the updated `BookingLine`. The "accept" half of the re-pull diff flow
    (below): re-fetches the day FRESH via `fetchDayPayments()` (never trusts
    a client-cached diff — the client only ever saw a snapshot from the last
    `pull-from-pms` response), then applies the fields the PMS writes onto
    the row's CURRENT tenders via `applyPmsCandidateToBookingLine()` (merge,
    not replace — hand-keyed `credit_icbc`/`transfer_icbc`/`other`/`deposit`
    and `remark` survive untouched). Gates, in order: **503** when this
    property's PMS env URL is unset; **404** (`{ error: "booking line not
    found" }`) if `:id` doesn't exist, doesn't belong to `:property`, or
    isn't `source: "pms"`; **409** (`{ error: "month is closed" }`) if the
    row's date's month is closed (reopen via endpoint 24 first); **502** on
    a live PMS query failure; **409** (`{ error: "pms candidate no longer
    available (vanished or became a refund)" }`) if the fresh fetch no
    longer contains this `pms_ref` at all, or it now nets negative
    (`isRefund`). Same pre-cutover applied-deposit guard as endpoint 26
    (F1): on a pre-cutover date, `appliedDepositSatang` is forced to `0`
    before applying, even if the PMS now shows one on that folio — it was
    already booked as income under the OLD rule. **Idempotent**: calling
    this again once nothing differs re-applies the same values and still
    succeeds (200) — it does not special-case "no diff" into a no-op response,
    it simply converges to the same stored state either way.

**Amendment to endpoint 26** (`POST .../pull-from-pms`) — response gains
`changed: PmsBookingLineChange[]` (additive, like `autoPlaced`): every
EXISTING row (already counted in `skipped`, never touched) that a fresh pull
found differing from what is currently stored. Insert-only behavior is
unchanged — `changed` is purely a report. `PmsBookingLineChange = { id:
number, pmsRef: string, bookingNo: string | null, handEdited: boolean,
fields: BookingLineFieldDiff[] }`; `handEdited = updatedAt !== createdAt` (a
row nobody has touched since the original import has both timestamps
identical); `BookingLineFieldDiff = { field: string, before: string | number
| null, after: string | number | null }`. The diff is against the CURRENT
stored value, not the original import — a hand-edited row shows as "changed"
too (flagged via `handEdited`, never suppressed: "a human always decides").
Compares ONLY the fields the PMS importer actually writes:
`bookingNo`/`guestName`/`roomNo`/`roomCount`/`nights`/`grossRoomSatang`/
`grossOtherSatang`, plus the tenders `cash`/`web`/`deposit_applied`/
`transfer_kbank` (and `credit_kbank` on hfville only) — NEVER `remark`
(hand-keyed context) or `credit_icbc`/`transfer_icbc`/`other`/`deposit`
(hand-keyed by design, the importer never writes these).

**Data model.** New table `deposit_notes`: `property`, `r_number`, `note`
(nullable), `resolved_at` (nullable), `resolved_by` (nullable), `updated_at`,
`updated_by`. PK `(property, r_number)`. "Explained" = `resolved_at IS NOT
NULL` explicitly (mirrors `sheet_days.verified_at`'s convention) — a note
saying "waiting on reception" must keep shouting until someone deliberately
marks it resolved. db.ts fns: `getDepositNote`, `listDepositNotes`,
`upsertDepositNote`, `deleteDepositNote`.

**Register query** (`src/server/deposit-register.ts`, mirrors
`pms-prefill.ts`'s shape exactly — pure mapping fns + a thin network shim +
an `_internal` test override; shares `pms-prefill.ts`'s per-property
Postgres client cache via the exported `getPmsClient()` rather than opening
a second connection pool): `DEPOSIT_LEDGER_QUERY` selects
`ledger_legacy_id`/`ledger_pay_no`/`ledger_cin_no`/`ledger_ds_name`/
`ledger_pay_date`/`ledger_status`/all four tender columns/`ledger_amount`/
`ledger_free`/`ledger_note`, filtered to the three deposit-lifecycle
`ds_name`s, full history, no date window. `classifyDepositRow()` — received/
refunded: R-number from `ledger_cin_no` (trimmed, unvalidated — mirrors
`pms-prefill.ts`'s own reading of the same column), amount = abs of the
summed tender columns (a refund's tender is stored negative in the SAME
column the deposit used, C0's "refund column" finding), plus a `zeroTenderRow`
flag (review fix) when those four columns sum to zero despite a nonzero
`ledger_amount`; applied: amount from `ledger_free` (V1), R-number parsed
from the ds_name's own system-templated suffix via the SAME
`parseAppliedBookingNo()` `pms-prefill.ts` exports, `null` + a tripwire flag
when unparseable (`zeroTenderRow` is always `false` on this branch — that
tripwire is received/refunded-only). `buildDepositThreads()` groups by
R-number; `buildMonthlyReconciliation()` builds the opening/closing table;
`buildDepositExceptions()` derives `mismatched`/`orphanApplied`/`overRefunded`
(owner fix round, 2026-08-01, the R015832 case — see endpoint 30's own
`exceptions.overRefunded` doc above) from threads;
`collectVoidedEvents()` (review fix: takes the flat `DepositLedgerEvent[]`
list, NOT `DepositThread[]` — the threads-based version silently dropped a
voided event whose R-number was unparseable/blank, since such an event never
joins any thread) flattens the voided footnote data;
`buildDepositRegisterData()` (the row-level entry point) computes
`zeroTenderRows`/`blankBookingNoRows`/`undatedRows`/`voided` alongside
`threads`/`monthly`/`unparsedAppliedRows` so the endpoint never has to
re-derive any of them; it now also returns `events` (additive, 2026-08-01) —
the exact flat `DepositLedgerEvent[]` list `threads`/`monthly`/`voided` were
all already built from, exposed without recomputation so the endpoint can
surface a flat, chronological feed. `DepositLedgerEvent` itself gained two
fields the same wave: `tender: DepositTender | null` (via `dominantTender()`
— the first non-zero of cash/credit/transfer/web on a received/refunded row,
`null` for `applied` and for a genuinely all-zero row) and `chRef: string |
null` (an applied row's OWN `ledger_cin_no`, trimmed — the CH-number, `null`
for received/refunded since their `ledger_cin_no` is already `rNumber`).

**Explicit deposit state** (owner ask, 2026-08-01 — `src/server/deposit-
register.ts` + `src/shared/types.ts`): `DepositThread` gained a `status:
DepositThreadStatus` field, computed inside `buildDepositThreads()` for
every thread via `deriveDepositThreadStatus()` (PURE — no I/O, takes just
the four received/applied/refunded/outstanding numbers `DepositThread`
already carries). `DepositThreadStatus` (shared/types.ts) is `"waitingCheckin"
| "applied" | "refunded" | "partial"`, labeled via
`DEPOSIT_THREAD_STATUS_LABELS_TH` (รอเช็คอิน/ตัดยอดแล้ว/คืนเงินแล้ว/บางส่วน — the
ONLY vocabulary the register UI may use for a thread's state; see
CONTEXT.md's มัดจำล่วงหน้า entry for the full definitions and the terms to
avoid). Priority order: `outstandingSatang > 0` with nothing yet applied/
refunded → `waitingCheckin`; `outstandingSatang > 0` with some already moved
→ `partial`; `outstandingSatang <= 0` (covers both the ordinary fully-applied
case and the R015834-style over-applied mismatch — complementary to, never
exclusive with, `buildDepositExceptions`) with `refundedSatang > 0` and
nothing applied → `refunded`; `outstandingSatang <= 0` with `appliedSatang >
0` → `applied` (covers the orphan-applied exception and a mixed applied+
refund close-out too — a stay is the more informative "where it went" of the
two). The route (`server.ts`) attaches `status` to every `aging`/
`exceptions.mismatched`/`exceptions.orphanApplied`/`exceptions.overRefunded`
row from its thread, plus `appliedChRef`/`appliedDateBangkok` via a small
`appliedMappingFor()` helper (the thread's own events, latest non-voided
`applied` one, dateBangkok descending) — see endpoint 30's own field-by-field
description above. An `overRefunded` thread's `status` is almost always
`"refunded"` (no application involved by construction) — `outstandingSatang
<= 0` is guaranteed whenever `refundedSatang > receivedSatang`, so it always
lands in the `refunded`/`applied` branches above, never `waitingCheckin`/
`partial`.

**Re-pull diff flow** (`src/server/db.ts`): `candidateTenderPatch(property,
candidate)` — the ONE place that decides where PMS money lands on the
9-tender record, extracted out of `insertPmsBookingLines` so
`diffCandidateAgainstBookingLine()` and `applyPmsCandidateToBookingLine()`
can never drift from what a fresh insert would write.
`diffCandidateAgainstBookingLine(property, candidate, existing)` — pure,
returns `BookingLineFieldDiff[]` over exactly the PMS-written fields (see the
endpoint-26 amendment above). `insertPmsBookingLines()`'s return gains
`changed: PmsBookingLineChange[]` (additive). `getBookingLinePmsRef(property,
id)` — the ONLY way to read a row's `pms_ref` server-side; deliberately never
added to the public `BookingLine` DTO (it's purely an idempotence/lookup
key). `applyPmsCandidateToBookingLine(property, id, candidate, by)` — merges
`candidateTenderPatch`'s fields into the row's CURRENT tenders (never a
wholesale replace) and reuses `updateBookingLine()`.

## Wave 1: the office audit hub (`src/server/day-audit.ts`, `docs/plan-audit-hub-slips.md`)

A day-scoped, STAY-MERGED reshaping of ALL of a day's PMS payments (not just
deposits — the audit hub's whole scope, per the plan) into ONE ROW PER
SETTLEMENT, plus its own tiny audit trail (`payment_audits`) independent of
`sheet_days.verified_at`/month-close. A SEPARATE code path from both Wave C's
importer and Wave D's register — `day-audit.ts` reuses `getPmsClient()`/
`pmsConfigured()`/`bangkokDayWindow()`/`parseLedgerSatang()`/
`buildGuestName()`/`LEDGER_DS_NAMES`/`DEPOSIT_APPLIED_PREFIX`/
`parseAppliedBookingNo()` (pms-prefill.ts) and `classifyDepositRow()`/
`RawDepositLedgerRow` (deposit-register.ts) directly, so all three modules
can never disagree on what a จ่ายล่วงหน้า/ตัดยอดล่วงหน้า/คืนเงินจองห้อง row
means.

34. **`GET /api/:property/audit/day/:date`** → `{ rows: DayAuditRow[],
    checkedCount: number, totalCount: number, pullStatus: boolean }`. Same
    dark-by-default gate as endpoints 26/30: **503**
    (`{ error: "pms prefill not configured" }`) when this property's PMS env
    URL is unset, **502** on a live query failure, **400** on an invalid
    `date`. `rows` is sorted **PENDING FIRST** (`checked: false` before
    `checked: true`; `Array#sort`'s stability preserves each bucket's
    underlying order as a secondary key), and **within each bucket, date+time
    DESCENDING** — newest `paidAtIso` first (`sortDayAuditRows`,
    `src/server/day-audit.ts`, owner ask 2026-08-04: "payment rows must sort
    by DATE AND TIME, DESCENDING — in BOTH ตรวจรายวัน and ส่งสลิป", which share
    this same row-building module). A row with `paidAtIso: null` always sorts
    LAST; equal (including equally-null) timestamps break the tie
    deterministically on `auditKey` DESC. **Rows of different `kind`s
    interleave chronologically — this is deliberate, not a bug**: nothing
    downstream may assume rows are grouped by kind. `pullStatus` is whether
    this `(property, date)` already has at least one `source: "pms"` booking
    line (the client's ดึงข้อมูล chip) — reuses `getBookingLinesForDay()`,
    never a second query.

    **`DayAuditRow`** is a discriminated union on `kind`, every variant
    carrying `auditKey: string` (the settlement's identity — see
    `payment_audits` below), `paidAtIso: string | null` (the sort key above —
    full-precision ISO-8601 instant, `null` only on a `ledger_pay_date` parse
    failure, never expected in practice) plus the merged audit-state quartet
    `checked: boolean`, `checkedAt: string | null`, `checkedBy: string |
    null`, and the Wave-2 slip-inbox pair `proofCount: number`,
    `proofsPending: boolean`, merged onto every row by THIS route from
    ส่งสลิป's own internal status endpoint (`fetchSlipProofStatus`,
    `src/server/server.ts` — bearer-token server-to-server, fail-silent: an
    unreachable/unconfigured slip service just means `proofCount` stays `0`
    for that request, never a 502 for the whole route). `proofCount` is the
    settlement's current attachment count; `proofsPending` is
    `needsSlipProof(row) && proofCount === 0`, computed unconditionally from
    the row itself — a row that never needed a slip (cash tender only)
    always reads `proofCount: 0, proofsPending: false`.

    The SAME round trip (2026-08-10, `docs/plan-audit-hub-slips.md`'s
    reception paid-in-cash reversal — see "Wave 2: ยืนยันชำระเงินสด" below)
    also merges `cashMarkedAt: string | null`, `cashMarkedBy: string | null`
    onto every row — `null`/`null` together for a row that never needed a
    slip, was never asked about (the slip service is dark/unreachable), or
    simply was never cash-marked; both populated together once reception
    marks it. Deliberately does NOT change `proofsPending`: a cash-marked
    settlement with no attachment still reads `proofsPending: true`
    underneath its own `cashMarkedAt` — the client swaps the red รอสลิป chip
    for a calm เงินสด one using `cashMarkedAt` alone, nothing downstream that
    keys off `proofsPending` needs to change.

    - **`kind: "checkin"`** (`DayAuditCheckinRow`) — ONE row per STAY, keyed
      by the CH (check-in) number (`auditKey === chRef`). A check-in's
      `ค่าห้อง` payment(s) and its (at most one) `ตัดยอดมัดจำ` line merge into
      this ONE row regardless of whether they share a receipt (pay_no) or
      not — never two rows for the same stay. `paidAtIso` for a merged row is
      the **LATEST** contributing line's own `ledger_pay_date` (across every
      ค่าห้อง/ยกเลิกห้อง/ค่าปรับ/ตัดยอด line feeding this CH, regardless of
      which receipt it's on) — never the earliest, never specifically the
      room-charge line: the settlement's COMPLETION moment is what the
      office scans the queue by. `receiptPayNos: string[]`
      lists every distinct receipt contributing a line; `grossSatang` sums
      `ค่าห้อง` + `ยกเลิกห้อง` (forced negative, same sign-anomaly fix
      pms-prefill.ts's `buildBookingCandidate` makes) + `ค่าปรับ` — NEVER the
      ตัดยอด line's own amount (V1: that money lives in `depositApplied`,
      not gross) and NEVER a `คืนเงินส่วนเกิน` line (its own `kind: "refund"`
      row instead, see below). `composition: { cashSatang, transferSatang,
      creditSatang, webSatang, penaltySatang }` — the first four are TENDER
      totals (how the folio was paid, read ONCE per payment group and
      summed across however many receipts share this check-in — the same
      tender-replication money gotcha pms-prefill.ts's module comment
      documents); `penaltySatang` is a REVENUE-line breakdown instead (how
      much of `grossSatang` came from a `ค่าปรับ` line), an orthogonal axis,
      not a fifth tender. `depositApplied` (`null` when this stay carries no
      ตัดยอด line, or its line's own R-ref label failed to parse — the
      register's `unparsedAppliedRows` tripwire already covers that
      globally, this hub just omits the chip): `{ amountSatang, rRef,
      receivedDateBangkok, receivedPayNo, receivedTender, receivedAmountSatang,
      mismatch, receivedChecked }` — paired with the R's own RECEIVED event
      across its WHOLE history (never just this day, via a second, narrow,
      no-date-window query), summing every ACTIVE received event for that R
      into `receivedAmountSatang` (`null` when none exist at all — the
      orphan-applied shape) and taking the chronologically-first as
      canonical for `receivedPayNo`/`receivedTender`/`receivedDateBangkok`.
      `mismatch = |amountSatang - (receivedAmountSatang ?? 0)| >
      RECONCILE_TOLERANCE_SATANG` — the row-level red-chip flag (the
      register's own exception list already covers this globally; this is
      the same signal surfaced per-row for the work queue). `receivedChecked`
      (additive, merged by the route, NOT by `day-audit.ts` — see below) is
      the PAIRED RECEIPT's own audit state, distinct from this row's own
      `checked`.
    - **`kind: "deposit"`** (`DayAuditDepositRow`) — one รับมัดจำ row per
      จ่ายล่วงหน้า receipt received THIS day, keyed by its own pay_no
      (`auditKey === payNo`, since a received deposit has no CH yet).
      `checkinDateBangkok: string | null` is a best-effort forward reference
      via `ht_bookings` — **UNVERIFIED**: this build shipped with no live PMS
      connection to run the `SET ROLE ledger_ro` probe the plan calls for,
      so `ht_bookings.book_no` being the SAME R-number iHOTEL writes onto
      `ledger_cin_no`, and `ledger_ro` even holding a grant on
      `ht_bookings.book_no`/`book_checkin` at all, are both ASSUMPTIONS. The
      lookup is wrapped in try/catch specifically so a wrong column name or
      a missing grant degrades to `null` on every row (a normal value, never
      an error) rather than 502ing the endpoint — **this must be verified
      against live evergreen data (or simply observed in production logs)
      before it is trusted to ever return anything.**
    - **`kind: "refund"`** (`DayAuditRefundRow`) — one คืนเงิน row (negative
      `amountSatang`) per `คืนเงินจองห้อง` (`refundOf: "deposit"`, `ref` = the
      R-number, keyed by its own pay_no) or `คืนเงินส่วนเกิน` (`refundOf:
      "excess"`, `ref` = the CH number when known else its own pay_no) line
      — kept as ONE row kind with a discriminant since both render
      identically and only the ref's meaning differs. `คืนเงินส่วนเกิน` is its
      OWN row here, unlike pms-prefill.ts, which folds it into the same
      booking candidate as the room charge — this hub wants every
      settlement independently auditable. `overRefundedWarning` (the
      R015832-shape signal, `refundOf: "deposit"` only) is `true` when the
      refund's own R has AT LEAST ONE received event anywhere in its history
      but NONE are active (every one voided) — a CHEAP per-row proxy for the
      register's own `overRefunded` bucket, not a re-run of its full
      thread-level `refundedSatang > receivedSatang` computation.

    Voided rows never produce ANY row here at all (re-asserted in the pure
    `buildDayAuditRows()`, fixture-provable without a database, same
    defense-in-depth pattern as `mapLedgerRows`/`classifyDepositRow`) — this
    is a work queue, not the reconciliation; the register's own voided
    footnote already covers completeness.

    `checked`/`checkedAt`/`checkedBy` are merged onto every row by THIS
    route (never by `day-audit.ts`, which has zero knowledge of
    `payment_audits` — mirrors deposit-register.ts's strict separation from
    `deposit_notes`) from a day-scoped `listPaymentAudits(property, date)`
    lookup keyed by `auditKey`. A เช็คอิน row's `depositApplied.receivedChecked`
    is merged from a SEPARATE, property-WIDE `listPaymentAudits(property)`
    lookup (no date filter) keyed by `receivedPayNo` instead — the paired
    receipt may have been ticked from a completely different day's queue
    view than the one currently being audited.

35. **`POST /api/:property/audit/:auditKey/check`** — body `{ date: string
    }` → `PaymentAudit` (`{ property, auditKey, date, checkedAt, checkedBy
    }`). Ticks (or re-ticks) a settlement as audited; `checkedBy` is the
    caller's identity, `checkedAt` the server timestamp. `date` is the
    audited day the tick was made FROM — it is **NOT** part of the
    settlement's identity (the table's PK is `(property, auditKey)` alone),
    so re-ticking the SAME `auditKey` from a different day's queue view
    still targets the same row, overwriting `date`/`checkedAt`/`checkedBy`
    (last write wins, same convention `upsertDepositNote` uses). `auditKey`
    is bound-checked against `BOOKING_NO_MAX_LEN` (an audit key is always
    either a CH number or a receipt pay_no, both that same shape/length).
    **NOT month-close gated** — audit is commentary-like (the SAME reasoning
    as `deposit_notes`/the day note/endpoint 9/the cash-block adjustment/
    endpoint 21): a tick is evidence someone LOOKED at a settlement, not a
    booking-day write, and it must remain possible even after the month
    closes (an auditor working through a backlog should never be blocked by
    month-close).

36. **`DELETE /api/:property/audit/:auditKey/check`** → 204, always
    (un-ticking a settlement never ticked at all is a harmless no-op, same
    "not worth a 404" reasoning as `DELETE .../deposits/:rNumber/note`).
    Same `auditKey` bound and month-close exemption as `POST` above.

**Data model.** New table `payment_audits`: `property`, `audit_key TEXT NOT
NULL`, `date TEXT NOT NULL` (the audited day the tick was made from — NOT
part of the row's identity), `checked_at`, `checked_by`. PK
`(property, audit_key)` — absence of a row = pending; there is no stored
"false". Un-ticking DELETEs the row outright (never a stale timestamp
surviving a re-open, unlike `deposit_notes`' resolved-state clear-in-place —
there is no note TEXT to preserve across an un-tick here). db.ts fns:
`listPaymentAudits(property, date?)` (day-scoped when `date` is given,
property-wide otherwise — the route uses BOTH shapes, see endpoint 34's own
doc above), `upsertPaymentAudit`, `deletePaymentAudit`.

**`day-audit.ts` internals.** `DAY_AUDIT_LEDGER_QUERY` — day-scoped (via
`bangkokDayWindow()`), restricted to the seven recognized `ds_name` shapes
(`LEDGER_DS_NAMES`'s six exact labels, string-built into the WHERE clause
rather than a bound array parameter — these are fixed compile-time Thai
strings, never user input, same reasoning `DEPOSIT_LEDGER_QUERY`'s own
inlined-literal WHERE uses — plus the `ตัดยอดล่วงหน้า Booking No:` prefix
family), voided rows excluded at the SQL level (unlike
`DEPOSIT_LEDGER_QUERY`'s full-history query, which returns them tagged for
the register's own greyed display — this hub never shows a voided line at
all). `buildDayAuditRows(rows, receivedByRRef, checkinDateByRRef)` — PURE,
the stay-merge itself: groups `ค่าห้อง`/`ยกเลิกห้อง`/`ค่าปรับ`/`ตัดยอด` lines
by payment key first (tender columns read ONCE per group, but each line's own
`ledger_pay_date` is folded into a running `maxPaidAtIso` EVERY line, not just
the first — see `paidAtIso`'s doc above), then re-groups those payment-group
aggregates by `ledger_cin_no` to build the merged เช็คอิน rows (taking the
LATEST `maxPaidAtIso` across every aggregate sharing that CH) — this second
re-grouping is the whole point: a room charge and its deposit application
sharing a CH but NOT a payment key still land in ONE row. Returns
`sortDayAuditRows(...)` of the three row-kind arrays (exported, PURE — see
endpoint 34's own ordering doc above; also reused as-is by
`src/slips/queue.ts`'s `buildSlipQueue`, which merely filters this
already-ordered array and therefore never disagrees with the ledger's own
queue on order). `fetchReceivedLookup()` — the cross-history pairing query
(`ledger_ds_name = 'จ่ายล่วงหน้า'` only, `ledger_cin_no IN (...)` the exact
R-refs this day's rows need, no date window, voided rows NOT filtered —
`overRefundedWarning` needs to see them), reuses `classifyDepositRow()` on
every row. `fetchCheckinDateLookup()` — the best-effort `ht_bookings` join,
see endpoint 34's own `checkinDateBangkok` doc above for why it is
UNVERIFIED and wrapped in try/catch. Both cross-history lookups build their
`IN (...)` clause via a small `sqlStringList()` escaper (SQL single-quote
doubling) rather than a bound array parameter — chosen because this module
has no live PMS connection available to verify Bun.SQL's array-binding
behavior against.

## Wave 2: ยืนยันชำระเงินสด — cash-mark reversal (`src/slips/`, `docs/plan-audit-hub-slips.md`, added 2026-08-10)

ส่งสลิป (`slips.thehfhotel.org`, `src/slips/`) is reception's own slip inbox
— a SEPARATE process/origin from this ledger (Wave 2's binding "separate
process/origin is non-negotiable" rule), sharing only pure/side-effect-free
code (`day-audit.ts`'s stay-merge, `pms-prefill.ts`'s config check). Its
browser-facing routes live under `/slips-api/*` (Cloudflare Access +
`identify()` — this SERVICE's own audience, not this ledger's `/api/*`
identity — 401 without a verified one, no extra role beyond that); its
server-to-server routes live under `/slips-internal/*` (bearer-token
`SLIPS_INGRESS_TOKEN`, fails closed when unset, NEVER behind Cloudflare
Access — a private Docker-network hop between the two containers). This
section documents ONLY the reversible cash-mark added 2026-08-10; the rest
of ส่งสลิป's surface (`attach`/`supersede`/`restore`/`history`/`picture`/
`day`) predates this section and is not repeated here.

**Why:** some queued settlements were actually settled in CASH — no bank
slip will ever exist for them — so without a resolution they sit in
ส่งสลิป's pending queue forever. Reception marks such a row "paid in cash",
reversibly, with a full audit trail; the office's ตรวจสอบ hub sees the same
state via the existing internal status endpoint (endpoint 34 above).

- **`POST /slips-api/:property/cash-mark/:auditKey`** — body `{ date:
  string }` → 200 `{ auditKey: string, cashMark: { at: string, by: string }
  }`. Auth: `/slips-api/*`'s standard identity gate. Validation mirrors the
  existing `attach` route exactly: 400 `{ error: "invalid property" }` for
  an unrecognized property, 400 `{ error: "invalid auditKey" }` when
  `auditKey` exceeds `BOOKING_NO_MAX_LEN`, 400 `{ error: "invalid date" }`
  when `date` fails `isValidIso`. `date` is the audited day the mark was
  made FROM — informational provenance only (same role as `attach`'s own
  `date` body field / `payment_audits.date` above), never part of the
  mark's identity, which is `(property, auditKey)` alone. **Idempotent**:
  marking an already-marked settlement inserts no new event and returns the
  ORIGINAL mark's `at`/`by` unchanged — a second tap, or a second reception
  worker, can never steal the first mark's attribution.

- **`POST /slips-api/:property/cash-unmark/:auditKey`** — body `{ date:
  string }` → 200 `{ auditKey: string, cashMark: null }`. Same auth/
  validation as `cash-mark` above. Reverses a mark, putting the settlement
  back into the pending queue. **Idempotent**: un-marking an already-
  unmarked (or never-marked) settlement is a harmless no-op — always 200,
  never a 404 (same "not worth a 404" convention as `DELETE
  .../audit/:auditKey/check`, endpoint 36 above).

**`SlipQueueRow.cashMark`** (`src/slips/queue.ts`, part of `GET
/slips-api/:property/day/:date`'s `{ rows: SlipQueueRow[] }`) gains:
`cashMark: { at: string, by: string } | null` — non-null once reception has
marked the settlement, `null` when never marked or currently un-marked.
Batched via `cash-marks.ts`'s `cashMarkStates()` (one query for the whole
day, never N+1), the same discipline `attachment`/`currentAttachments`
already follow via `storage.ts`. A marked row is **not** filtered out of
`rows` by this endpoint — the pending/resolved split is a client-side
concern, kept separate the same way the attachment fields already are.

**`StatusResponseEntry`** (`src/slips/internal.ts`, the per-key value shape
of `GET /slips-internal/:property/status?keys=...`, bearer-token gated) gains:
`cashMarkedAt: string | null`, `cashMarkedBy: string | null` — both `null`
together when unmarked (including for a key with no cash-mark history at
all), both populated together when marked; there is no state where only one
of the pair carries a value. Every requested key is present with these two
fields, same "every requested key present" guarantee `count`/`latestAt`/
`latestVersion`/`superseded` already carry — the ledger's own
`fetchSlipProofStatus` (`src/server/server.ts`, see endpoint 34 above) never
needs an existence check before reading them.

**Data model.** New table `cash_mark_events` (`src/slips/db.ts`) — append-
only EVENT LOG, same philosophy as `supersede_events`: `id` PK, `property`
(`hf`|`hfville`), `audit_key`, `audit_date`, `action` (`'mark'|'unmark'`),
`by`, `at` (default `datetime('now')`); index on `(property, audit_key)`.
No UNIQUE constraint — the same key accumulates many events over its life.
Current state = the LATEST event (highest `id`) for a `(property,
audit_key)`: `'mark'` → marked, `'unmark'` or no rows at all → unmarked;
never a row is UPDATEd or DELETEd. `src/slips/cash-marks.ts` fns:
`markCash(property, auditKey, auditDate, by): CashMark` (`{ at, by }`,
idempotent as documented above), `unmarkCash(property, auditKey, auditDate,
by): void` (idempotent), `cashMarkStates(property, keys): Map<string,
CashMark>` — batch; a key **absent from the returned map** means unmarked
(deliberately UNLIKE `storage.ts`'s `summarize`/`listCurrentBatch`, which
pre-seed every requested key with a zero-valued placeholder instead — this
function's own locked contract is "absent = unmarked", and both call sites
above resolve that absence to `null` themselves).

## Shared types (`src/shared/types.ts`, verbatim, READ-ONLY)

`Property`, `PROPERTIES`, `isProperty()`, `PROPERTY_LABELS` (full Thai/En
hotel names — `en` is contract metadata, never rendered), `CategoryKind`,
`Tender` (NINE values as of Wave C — the eight paper columns plus
`deposit_applied`, which shares the `deposit` slot on the printed grid, see
`visibleTendersForDate()` below), `TENDERS` (paper column order — iterate
this, never `Object.keys()`, on a `Record<Tender, ...>`), `TENDER_LABELS_TH`,
`CategoryKey` (fifteen values as of Wave C, adding `deposit_applied` — stable
category identity, independent of `nameTh` — managers can rename
categories), `TENDER_TO_CATEGORY_KEY` (the eight tenders that derive a
category cell; `"other"` is deliberately absent — it becomes an itemized
`OtherIncomeItem` instead), `Category` (now with `categoryKey`),
`IncomeCell` (now with `source`/`manual`), `ExpenseItem`, `BookingLine`,
`OtherIncomeItem`, `CashBlockAmounts`, `CashAdjustmentAmounts`, `CashBlock`
(now with `depositCashInSatang`/`depositCashOutSatang`, Wave C),
`DepositEvent`, `DepositEventKind`, `DepositTender`, `DEPOSIT_TENDERS`,
`DEPOSIT_TENDER_LABELS_TH` (Wave C), `DepositNote` and `DEPOSIT_NOTE_MAX_LEN`
(Wave D — the office deposit register's note-thread contract),
`DepositThreadStatus` and `DEPOSIT_THREAD_STATUS_LABELS_TH` (2026-08-01 —
the register's explicit-state chip vocabulary, see the Register query
section above), `PaymentAudit` (Wave 1 — the audit hub's `payment_audits`
contract, see that section above), `DayProvenance`,
`DayTotals`, `BookingTotals`, `DaySheet`
(see Wave 2 field additions above, plus `deposits: DepositEvent[]` Wave C),
`DaySummary` (now with
`verified`/`provenance`), `Me`, plus the bounds constants above.

`accrual.ts` (Wave C): `ACCRUAL_CUTOVER_DATE` (per-property, commit-changed,
never runtime), `isAccrualDay()`, `visibleTendersForDate()` (the 8 tender
columns to render for a date — `deposit` pre-cutover, `deposit_applied`
on/after, same printed slot).

`money.ts` (`formatSatang`, `parseAmountToSatang`, `shouldCommitAmount`), `totals.ts`
(`computeDayTotals`), `bookings.ts` (`computeBookingTotals`,
`deriveIncomeFromBookings`, `deriveCashBlock` (now takes a `depositEvents`
param, defaulted `[]`), `depositCashTotals` (Wave C), `lineArithmeticMismatch`,
`RECONCILE_TOLERANCE_SATANG` — Wave D's `mismatched` exception threshold
reuses this SAME constant, never a second tolerance value) — same philosophy
as `totals.ts`: the server computes with these and the client imports the
SAME functions, so UI and API can never disagree. `rollup.ts`'s
`computeIncomeLedgerRollup` gains a `depositEvents` param and the payload
gains optional `depositReceivedSatang`/`depositRefundedSatang` (OUTSIDE
`amounts` — see the hf-analytics section below). `date.ts` (`todayBangkok`,
`isoToThaiLong`, `isoToBuddhist`, month helpers, plus Wave D's `daysBetween()`
for the aging list's "days outstanding" column).

## hf-analytics ingest (Wave C addition)

The `POST /api/ingest/income-ledger` payload (`IncomeLedgerRollup`,
`shared/rollup.ts`) gains two OPTIONAL top-level fields, OUTSIDE `amounts`:
`depositReceivedSatang`/`depositRefundedSatang` — this day's total
มัดจำล่วงหน้า received/refunded across every `DepositTender` (not cash-only).
Omitted (never an explicit 0) when the respective total is zero, same
omit-zero convention as `amounts`. Applied deposits ride INSIDE `amounts` as
the ordinary key `deposit_applied` and foot normally — never weaken the
footing rule by excluding a key instead of using this separate pair for the
received/refunded case, which is money-in-not-income / money-out-not-expense
under accrual and would silently overstate revenue if folded into `amounts`.
