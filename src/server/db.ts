import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PROPERTIES, TENDERS } from "../shared/types.ts";
import type {
  BookingLine,
  CashBlock,
  CashBlockAmounts,
  Category,
  CategoryKey,
  CategoryKind,
  DayProvenance,
  ExpenseItem,
  IncomeCell,
  OtherIncomeItem,
  Property,
  Tender,
} from "../shared/types.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/ledger.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/**
 * DDL + seed migration — see src/shared/api.md "Data model" for the locked
 * contract this mirrors exactly. Idempotent: safe to call on every boot.
 */
export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL CHECK (property IN ('hf', 'hfville')),
      kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
      name_th TEXT NOT NULL,
      sort INTEGER NOT NULL,
      is_cash INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Archived names are reusable: the unique constraint only applies to
    -- the active (non-archived) set.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_active_name
      ON categories (property, kind, name_th) WHERE archived_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_categories_list
      ON categories (property, kind, sort);

    CREATE TABLE IF NOT EXISTS income_amounts (
      property TEXT NOT NULL,
      date TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories (id),
      amount_satang INTEGER NOT NULL CHECK (amount_satang >= 0),
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL,
      PRIMARY KEY (property, date, category_id)
    );

    CREATE TABLE IF NOT EXISTS expense_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL,
      date TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories (id),
      note TEXT,
      amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_expense_items_day ON expense_items (property, date);

    CREATE TABLE IF NOT EXISTS sheet_days (
      property TEXT NOT NULL,
      date TEXT NOT NULL,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL,
      PRIMARY KEY (property, date)
    );

    -- One row per BookingLine (see src/shared/types.ts). Eight nullable
    -- tender columns (t_*) rather than the single-tender-enum shape a
    -- normal payment side-table would use — a booking can pay across
    -- several tenders, or none (coupon/comp), and both must round-trip
    -- losslessly through the plain Record<Tender, number> API shape (NULL
    -- reads back as 0 — see toBookingLine()).
    CREATE TABLE IF NOT EXISTS booking_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL CHECK (property IN ('hf', 'hfville')),
      date TEXT NOT NULL,
      seq INTEGER NOT NULL,
      booking_no TEXT,
      guest_name TEXT,
      room_no TEXT,
      room_count INTEGER,
      nights INTEGER,
      gross_room_satang INTEGER NOT NULL DEFAULT 0 CHECK (gross_room_satang >= 0),
      gross_other_satang INTEGER NOT NULL DEFAULT 0 CHECK (gross_other_satang >= 0),
      discount_satang INTEGER NOT NULL DEFAULT 0 CHECK (discount_satang >= 0),
      t_deposit INTEGER CHECK (t_deposit IS NULL OR t_deposit >= 0),
      t_cash INTEGER CHECK (t_cash IS NULL OR t_cash >= 0),
      t_credit_kbank INTEGER CHECK (t_credit_kbank IS NULL OR t_credit_kbank >= 0),
      t_credit_icbc INTEGER CHECK (t_credit_icbc IS NULL OR t_credit_icbc >= 0),
      t_transfer_kbank INTEGER CHECK (t_transfer_kbank IS NULL OR t_transfer_kbank >= 0),
      t_transfer_icbc INTEGER CHECK (t_transfer_icbc IS NULL OR t_transfer_icbc >= 0),
      t_web INTEGER CHECK (t_web IS NULL OR t_web >= 0),
      t_other INTEGER CHECK (t_other IS NULL OR t_other >= 0),
      remark TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'pms')),
      draft INTEGER NOT NULL DEFAULT 0,
      pms_ref TEXT,
      source_sheet TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_booking_lines_day ON booking_lines (property, date, seq);

    -- A PMS-fed row is unique per (property, date, pms_ref); manual/import
    -- rows never carry a pms_ref, so they are exempt from this index.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_lines_pms_ref
      ON booking_lines (property, date, pms_ref) WHERE pms_ref IS NOT NULL;

    -- Itemized non-booking revenue behind the two รายการอื่นๆ cells — shape
    -- mirrors expense_items. is_cash decides which of the two cells an item
    -- feeds (see deriveCashBlock() in src/shared/bookings.ts).
    CREATE TABLE IF NOT EXISTS other_income_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL CHECK (property IN ('hf', 'hfville')),
      date TEXT NOT NULL,
      description TEXT,
      amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
      is_cash INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_other_income_items_day ON other_income_items (property, date);

    -- Append-only audit trail for every income_amounts insert/update/delete
    -- (see saveIncomeCell()). Never updated or pruned.
    CREATE TABLE IF NOT EXISTS income_amount_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL,
      date TEXT NOT NULL,
      category_id INTEGER NOT NULL,
      old_satang INTEGER NOT NULL,
      new_satang INTEGER NOT NULL,
      source TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      by TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_income_amount_history_cell
      ON income_amount_history (property, date, category_id);

    -- Presence of a row = that (property, month) is closed. Blocks writes
    -- to income cells, booking lines, other-income items, and expenses for
    -- dates inside it (enforced in src/server/server.ts route handlers).
    CREATE TABLE IF NOT EXISTS closed_months (
      property TEXT NOT NULL CHECK (property IN ('hf', 'hfville')),
      month TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_by TEXT NOT NULL,
      PRIMARY KEY (property, month)
    );
  `);

  migrateCategoryKeyColumn();
  addColumnIfMissing("income_amounts", "source", "TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing("income_amounts", "manual", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("sheet_days", "cash_room_satang", "INTEGER");
  addColumnIfMissing("sheet_days", "cash_other_satang", "INTEGER");
  addColumnIfMissing("sheet_days", "cash_bar_satang", "INTEGER");
  addColumnIfMissing("sheet_days", "banked_cash_satang", "INTEGER");
  addColumnIfMissing("sheet_days", "provenance", "TEXT NOT NULL DEFAULT 'app'");
  addColumnIfMissing("sheet_days", "verified_at", "TEXT");
  addColumnIfMissing("sheet_days", "verified_by", "TEXT");

  for (const property of PROPERTIES) seedIfEmpty(property);
}

/**
 * Adds `column` to `table` via ALTER TABLE, but only when PRAGMA table_info
 * shows it genuinely absent — safe to call on every boot. `migrate()` used
 * to be a block of CREATE TABLE IF NOT EXISTS statements only; a throwing
 * ALTER here must never crash-loop the container, hence the guard.
 */
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function stripSpaces(s: string): string {
  return s.replace(/ /g, "");
}

// The paper and the original seed differ by a stray U+0020 in two labels
// (see src/shared/api.md "รายการอื่นๆ — RESOLVED"); matching on
// whitespace-stripped name_th absorbs that — same normalization the Excel
// importer uses.
const CATEGORY_KEY_BY_STRIPPED_NAME: Record<string, CategoryKey> = {
  [stripSpaces("มัดจำล่วงหน้า")]: "deposit",
  [stripSpaces("ค่าห้องเงินสด")]: "room_cash",
  [stripSpaces("บัตรเครดิต/กสิกร")]: "credit_kbank",
  [stripSpaces("บัตรเครดิต ICBC")]: "credit_icbc",
  [stripSpaces("โอน/กสิกร")]: "transfer_kbank",
  [stripSpaces("โอน ICBC")]: "transfer_icbc",
  [stripSpaces("เว็ปไซด์")]: "web",
  [stripSpaces("บาร์น้ำ เงินสด")]: "bar_cash",
  [stripSpaces("บาร์น้ำ โอน/เครดิต")]: "bar_transfer",
};

/**
 * One-time split of the seeded รายการอื่นๆ category into a cash half
 * (renamed in place, keeping its history) and a new transfer/credit half
 * inserted immediately after it — see src/shared/api.md "รายการอื่นๆ —
 * RESOLVED". Idempotent: matches only a still-unkeyed row by
 * whitespace-stripped name, so it is a no-op once applied (or on a fresh
 * DB seeded straight into the split shape).
 */
function splitOtherIncomeCategory(property: Property): void {
  const row = db
    .query<{ id: number; sort: number }, [string, string]>(
      `SELECT id, sort FROM categories
       WHERE property = ? AND kind = 'income' AND category_key IS NULL
         AND replace(name_th, ' ', '') = ?`,
    )
    .get(property, "รายการอื่นๆ");
  if (!row) return;

  db.prepare("UPDATE categories SET name_th = ?, is_cash = 1, category_key = 'other_cash' WHERE id = ?").run(
    "รายการอื่นๆ เงินสด",
    row.id,
  );

  // Make room at sort+1 for the new transfer/credit half, shifting
  // everything after it (บาร์น้ำ… and any manager-added categories) up by
  // one so the sequence stays dense and ordered.
  db.prepare("UPDATE categories SET sort = sort + 1 WHERE property = ? AND kind = 'income' AND sort > ?").run(
    property,
    row.sort,
  );

  db.prepare(
    `INSERT INTO categories (property, kind, name_th, sort, is_cash, category_key)
     VALUES (?, 'income', ?, ?, 0, 'other_transfer')`,
  ).run(property, "รายการอื่นๆ โอน/เครดิต", row.sort + 1);
}

/**
 * Backfills category_key for every still-unkeyed seeded income category.
 * Manager-created categories never match and are correctly left NULL.
 */
function backfillCategoryKeys(property: Property): void {
  const rows = db
    .query<{ id: number; name_th: string }, [string]>(
      "SELECT id, name_th FROM categories WHERE property = ? AND kind = 'income' AND category_key IS NULL",
    )
    .all(property);
  const update = db.prepare("UPDATE categories SET category_key = ? WHERE id = ?");
  for (const row of rows) {
    const key = CATEGORY_KEY_BY_STRIPPED_NAME[stripSpaces(row.name_th)];
    if (key) update.run(key, row.id);
  }
}

/** The split + backfill above must succeed or fail together — a crash
 * between them would otherwise leave a database with the rename applied
 * but no category_key, indistinguishable from "never migrated". */
function migrateCategoryKeyColumn(): void {
  addColumnIfMissing("categories", "category_key", "TEXT");
  const tx = db.transaction(() => {
    for (const property of PROPERTIES) {
      splitOtherIncomeCategory(property);
      backfillCategoryKeys(property);
    }
  });
  tx();
}

// Paper order; isCash flags per src/shared/api.md "Data model". รายการอื่นๆ
// is seeded pre-split into its cash/transfer pair (see "รายการอื่นๆ —
// RESOLVED") so a fresh database never needs the split migration to run.
const INCOME_SEED: ReadonlyArray<{ nameTh: string; isCash: boolean; categoryKey: CategoryKey }> = [
  { nameTh: "มัดจำล่วงหน้า", isCash: false, categoryKey: "deposit" },
  { nameTh: "ค่าห้องเงินสด", isCash: true, categoryKey: "room_cash" },
  { nameTh: "บัตรเครดิต/กสิกร", isCash: false, categoryKey: "credit_kbank" },
  { nameTh: "บัตรเครดิต ICBC", isCash: false, categoryKey: "credit_icbc" },
  { nameTh: "โอน/กสิกร", isCash: false, categoryKey: "transfer_kbank" },
  { nameTh: "โอน ICBC", isCash: false, categoryKey: "transfer_icbc" },
  { nameTh: "เว็ปไซด์", isCash: false, categoryKey: "web" },
  { nameTh: "รายการอื่นๆ เงินสด", isCash: true, categoryKey: "other_cash" },
  { nameTh: "รายการอื่นๆ โอน/เครดิต", isCash: false, categoryKey: "other_transfer" },
  { nameTh: "บาร์น้ำ เงินสด", isCash: true, categoryKey: "bar_cash" },
  { nameTh: "บาร์น้ำ โอน/เครดิต", isCash: false, categoryKey: "bar_transfer" },
];

// All is_cash = 1; manager-editable afterwards.
const EXPENSE_SEED: ReadonlyArray<{ nameTh: string; isCash: boolean }> = [
  { nameTh: "ซื้อของ/วัตถุดิบ", isCash: true },
  { nameTh: "ค่าแรงรายวัน", isCash: true },
  { nameTh: "ค่าซ่อมแซม", isCash: true },
  { nameTh: "ค่าสาธารณูปโภค", isCash: true },
  { nameTh: "อื่นๆ", isCash: true },
];

/** Seed only when this property has zero categories — never re-fights admin edits. */
function seedIfEmpty(property: Property): void {
  const row = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM categories WHERE property = ?")
    .get(property);
  if (row && row.n > 0) return;

  const insertIncome = db.prepare(
    "INSERT INTO categories (property, kind, name_th, sort, is_cash, category_key) VALUES (?, 'income', ?, ?, ?, ?)",
  );
  const insertExpense = db.prepare(
    "INSERT INTO categories (property, kind, name_th, sort, is_cash) VALUES (?, 'expense', ?, ?, ?)",
  );
  const tx = db.transaction(() => {
    INCOME_SEED.forEach((c, i) => insertIncome.run(property, c.nameTh, i, c.isCash ? 1 : 0, c.categoryKey));
    EXPENSE_SEED.forEach((c, i) => insertExpense.run(property, c.nameTh, i, c.isCash ? 1 : 0));
  });
  tx();
  console.log(`[db] seeded categories for property=${property}`);
}

migrate();

// ── categories ──────────────────────────────────────────────────────────

interface CategoryRow {
  id: number;
  property: string;
  kind: string;
  name_th: string;
  sort: number;
  is_cash: number;
  category_key: string | null;
  archived_at: string | null;
  created_at: string;
}

function toCategory(r: CategoryRow): Category {
  return {
    id: r.id,
    property: r.property as Property,
    kind: r.kind as CategoryKind,
    nameTh: r.name_th,
    sort: r.sort,
    isCash: r.is_cash === 1,
    categoryKey: r.category_key as CategoryKey | null,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
  };
}

export function listCategories(property: Property, includeArchived: boolean): Category[] {
  const sql = includeArchived
    ? "SELECT * FROM categories WHERE property = ? ORDER BY kind, sort"
    : "SELECT * FROM categories WHERE property = ? AND archived_at IS NULL ORDER BY kind, sort";
  return db.query<CategoryRow, [string]>(sql).all(property).map(toCategory);
}

export function getCategoryById(property: Property, id: number): Category | null {
  const row = db
    .query<CategoryRow, [number, string]>("SELECT * FROM categories WHERE id = ? AND property = ?")
    .get(id, property);
  return row ? toCategory(row) : null;
}

export function createCategory(
  property: Property,
  kind: CategoryKind,
  nameTh: string,
  isCash: boolean,
): Category {
  const row = db
    .query<{ n: number }, [string, string]>(
      "SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM categories WHERE property = ? AND kind = ?",
    )
    .get(property, kind);
  const nextSort = row ? row.n : 0;
  const info = db
    .prepare("INSERT INTO categories (property, kind, name_th, sort, is_cash) VALUES (?, ?, ?, ?, ?)")
    .run(property, kind, nameTh, nextSort, isCash ? 1 : 0);
  return getCategoryById(property, Number(info.lastInsertRowid))!;
}

export type UpdateCategoryPatch = { nameTh?: string; isCash?: boolean; archived?: boolean };

export function updateCategory(
  property: Property,
  id: number,
  patch: UpdateCategoryPatch,
): Category | null {
  const existing = getCategoryById(property, id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (patch.nameTh !== undefined) {
    sets.push("name_th = ?");
    params.push(patch.nameTh);
  }
  if (patch.isCash !== undefined) {
    sets.push("is_cash = ?");
    params.push(patch.isCash ? 1 : 0);
  }
  if (patch.archived !== undefined) {
    sets.push(patch.archived ? "archived_at = datetime('now')" : "archived_at = NULL");
  }
  if (sets.length === 0) return existing;

  db.prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ? AND property = ?`).run(
    ...params,
    id,
    property,
  );
  return getCategoryById(property, id);
}

/**
 * Sets sort = position in `orderedIds` for every id, but only if
 * `orderedIds` is exactly a permutation of the active ids of
 * (property, kind) — no more, no fewer. Returns null on any mismatch
 * (caller responds 400) or the reordered active categories of that kind.
 */
export function reorderCategories(
  property: Property,
  kind: CategoryKind,
  orderedIds: number[],
): Category[] | null {
  const activeRows = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM categories WHERE property = ? AND kind = ? AND archived_at IS NULL",
    )
    .all(property, kind);
  const activeIds = new Set(activeRows.map((r) => r.id));
  if (orderedIds.length !== activeIds.size) return null;

  const seen = new Set<number>();
  for (const id of orderedIds) {
    if (!activeIds.has(id) || seen.has(id)) return null;
    seen.add(id);
  }

  const update = db.prepare("UPDATE categories SET sort = ? WHERE id = ? AND property = ? AND kind = ?");
  const tx = db.transaction(() => {
    orderedIds.forEach((id, i) => update.run(i, id, property, kind));
  });
  tx();

  return listCategories(property, false).filter((c) => c.kind === kind);
}

/**
 * Active categories of both kinds for the property, PLUS any archived
 * category referenced by this day's income/expenses (still flagged via its
 * own archivedAt) — see src/shared/api.md endpoint 7.
 */
export function categoriesForDay(property: Property, date: string): Category[] {
  const active = listCategories(property, false);
  const activeIds = new Set(active.map((c) => c.id));

  const refRows = db
    .query<{ category_id: number }, [string, string, string, string]>(
      `SELECT category_id FROM income_amounts WHERE property = ? AND date = ?
       UNION
       SELECT category_id FROM expense_items WHERE property = ? AND date = ?`,
    )
    .all(property, date, property, date);

  const extra: Category[] = [];
  for (const r of refRows) {
    if (activeIds.has(r.category_id)) continue;
    const cat = getCategoryById(property, r.category_id);
    if (cat) extra.push(cat);
  }

  return [...active, ...extra];
}

// ── income_amounts ──────────────────────────────────────────────────────

interface IncomeRow {
  category_id: number;
  amount_satang: number;
  note: string | null;
  source: string;
  manual: number;
  updated_at: string;
  updated_by: string;
}

function toIncomeCell(r: IncomeRow): IncomeCell {
  return {
    categoryId: r.category_id,
    amountSatang: r.amount_satang,
    note: r.note,
    source: r.source as IncomeCell["source"],
    manual: r.manual === 1,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function getIncomeForDay(property: Property, date: string): Record<number, IncomeCell> {
  const rows = db
    .query<IncomeRow, [string, string]>(
      `SELECT category_id, amount_satang, note, source, manual, updated_at, updated_by
       FROM income_amounts WHERE property = ? AND date = ?`,
    )
    .all(property, date);
  const out: Record<number, IncomeCell> = {};
  for (const r of rows) out[r.category_id] = toIncomeCell(r);
  return out;
}

/**
 * The income view every read/write actually serves: identical to
 * getIncomeForDay() except the two รายการอื่นๆ cells (found by
 * categoryKey, never by nameTh) are replaced with a live sum of
 * other_income_items whenever the day has any — see src/shared/api.md
 * "รายการอื่นๆ — RESOLVED" point 3. With no items, the stored cells (if
 * any) pass through untouched and stay directly editable.
 */
export function getEffectiveIncomeForDay(
  property: Property,
  date: string,
  categories: Category[],
  otherIncomeItems: OtherIncomeItem[],
): Record<number, IncomeCell> {
  const income = getIncomeForDay(property, date);
  if (otherIncomeItems.length === 0) return income;

  const otherCashCategoryId = categories.find((c) => c.categoryKey === "other_cash")?.id;
  const otherTransferCategoryId = categories.find((c) => c.categoryKey === "other_transfer")?.id;
  if (otherCashCategoryId === undefined && otherTransferCategoryId === undefined) return income;

  const cashSatang = otherIncomeItems.filter((i) => i.isCash).reduce((sum, i) => sum + i.amountSatang, 0);
  const transferSatang = otherIncomeItems.filter((i) => !i.isCash).reduce((sum, i) => sum + i.amountSatang, 0);
  const latest = otherIncomeItems.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));

  const out: Record<number, IncomeCell> = { ...income };
  if (otherCashCategoryId !== undefined) {
    out[otherCashCategoryId] = computedOtherIncomeCell(otherCashCategoryId, cashSatang, latest);
  }
  if (otherTransferCategoryId !== undefined) {
    out[otherTransferCategoryId] = computedOtherIncomeCell(otherTransferCategoryId, transferSatang, latest);
  }
  return out;
}

function computedOtherIncomeCell(categoryId: number, amountSatang: number, latest: OtherIncomeItem): IncomeCell {
  return {
    categoryId,
    amountSatang,
    note: null,
    source: "manual",
    manual: false,
    updatedAt: latest.updatedAt,
    updatedBy: latest.updatedBy,
  };
}

/** True for the two รายการอื่นๆ categories once getEffectiveIncomeForDay
 * would compute them from items — direct PUT writes to these must be
 * rejected while true (see src/shared/api.md point 3). */
export function isComputedOtherIncomeCategory(category: Category, otherIncomeItemCount: number): boolean {
  return (
    otherIncomeItemCount > 0 && (category.categoryKey === "other_cash" || category.categoryKey === "other_transfer")
  );
}

/**
 * amountSatang null/0 DELETEs the cell (empty cells don't accumulate rows —
 * see src/shared/api.md endpoint 8). Does not touch sheet_days; callers
 * pair this with touchSheetDay(). Every mutation writes a row to
 * income_amount_history in the SAME transaction, recording the effective
 * old value (0 when no prior row existed).
 */
export function saveIncomeCell(
  property: Property,
  date: string,
  categoryId: number,
  amountSatang: number | null,
  note: string | null,
  updatedBy: string,
  source: IncomeCell["source"] = "manual",
  manual = true,
): void {
  const tx = db.transaction(() => {
    const before = db
      .query<{ amount_satang: number }, [string, string, number]>(
        "SELECT amount_satang FROM income_amounts WHERE property = ? AND date = ? AND category_id = ?",
      )
      .get(property, date, categoryId);
    const oldSatang = before?.amount_satang ?? 0;
    const newSatang = amountSatang === null ? 0 : amountSatang;

    if (amountSatang === null || amountSatang === 0) {
      db.prepare("DELETE FROM income_amounts WHERE property = ? AND date = ? AND category_id = ?").run(
        property,
        date,
        categoryId,
      );
    } else {
      db.prepare(
        `INSERT INTO income_amounts (property, date, category_id, amount_satang, note, source, manual, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
         ON CONFLICT (property, date, category_id) DO UPDATE SET
           amount_satang = excluded.amount_satang,
           note = excluded.note,
           source = excluded.source,
           manual = excluded.manual,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      ).run(property, date, categoryId, amountSatang, note, source, manual ? 1 : 0, updatedBy);
    }

    db.prepare(
      `INSERT INTO income_amount_history (property, date, category_id, old_satang, new_satang, source, by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(property, date, categoryId, oldSatang, newSatang, source, updatedBy);
  });
  tx();
}

// ── expense_items ───────────────────────────────────────────────────────

interface ExpenseRow {
  id: number;
  property: string;
  date: string;
  category_id: number;
  note: string | null;
  amount_satang: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

function toExpenseItem(r: ExpenseRow): ExpenseItem {
  return {
    id: r.id,
    property: r.property as Property,
    date: r.date,
    categoryId: r.category_id,
    note: r.note,
    amountSatang: r.amount_satang,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function getExpensesForDay(property: Property, date: string): ExpenseItem[] {
  return db
    .query<ExpenseRow, [string, string]>(
      "SELECT * FROM expense_items WHERE property = ? AND date = ? ORDER BY id ASC",
    )
    .all(property, date)
    .map(toExpenseItem);
}

export function getExpenseById(property: Property, id: number): ExpenseItem | null {
  const row = db
    .query<ExpenseRow, [number, string]>("SELECT * FROM expense_items WHERE id = ? AND property = ?")
    .get(id, property);
  return row ? toExpenseItem(row) : null;
}

export function createExpenseItem(
  property: Property,
  date: string,
  categoryId: number,
  amountSatang: number,
  note: string | null,
  by: string,
): ExpenseItem {
  const info = db
    .prepare(
      `INSERT INTO expense_items (property, date, category_id, note, amount_satang, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(property, date, categoryId, note, amountSatang, by, by);
  return getExpenseById(property, Number(info.lastInsertRowid))!;
}

export type UpdateExpensePatch = { categoryId?: number; amountSatang?: number; note?: string | null };

export function updateExpenseItem(
  property: Property,
  id: number,
  patch: UpdateExpensePatch,
  by: string,
): ExpenseItem | null {
  const existing = getExpenseById(property, id);
  if (!existing) return null;

  const sets: string[] = ["updated_at = datetime('now')", "updated_by = ?"];
  const params: Array<string | number | null> = [by];
  if (patch.categoryId !== undefined) {
    sets.push("category_id = ?");
    params.push(patch.categoryId);
  }
  if (patch.amountSatang !== undefined) {
    sets.push("amount_satang = ?");
    params.push(patch.amountSatang);
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    params.push(patch.note);
  }

  db.prepare(`UPDATE expense_items SET ${sets.join(", ")} WHERE id = ? AND property = ?`).run(
    ...params,
    id,
    property,
  );
  return getExpenseById(property, id);
}

export function deleteExpenseItem(property: Property, id: number): boolean {
  const info = db.prepare("DELETE FROM expense_items WHERE id = ? AND property = ?").run(id, property);
  return info.changes > 0;
}

// ── sheet_days ──────────────────────────────────────────────────────────

interface SheetDayRow {
  note: string | null;
  updated_at: string;
  updated_by: string;
  cash_room_satang: number | null;
  cash_other_satang: number | null;
  cash_bar_satang: number | null;
  banked_cash_satang: number | null;
  provenance: string;
  verified_at: string | null;
  verified_by: string | null;
}

export interface SheetDay {
  note: string | null;
  updatedAt: string;
  updatedBy: string;
  cashOverride: { roomCashSatang: number | null; otherCashSatang: number | null; barCashSatang: number | null; bankedSatang: number | null };
  provenance: DayProvenance;
  verifiedAt: string | null;
  verifiedBy: string | null;
}

function toSheetDay(row: SheetDayRow): SheetDay {
  return {
    note: row.note,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    cashOverride: {
      roomCashSatang: row.cash_room_satang,
      otherCashSatang: row.cash_other_satang,
      barCashSatang: row.cash_bar_satang,
      bankedSatang: row.banked_cash_satang,
    },
    provenance: row.provenance as DayProvenance,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
  };
}

export function getSheetDay(property: Property, date: string): SheetDay | null {
  const row = db
    .query<SheetDayRow, [string, string]>(
      `SELECT note, updated_at, updated_by, cash_room_satang, cash_other_satang, cash_bar_satang,
              banked_cash_satang, provenance, verified_at, verified_by
       FROM sheet_days WHERE property = ? AND date = ?`,
    )
    .get(property, date);
  return row ? toSheetDay(row) : null;
}

/**
 * Merges a day's stored cash-block override (any subset of the four
 * fields, nullable meaning "use derived") on top of the freshly computed
 * `derived` half — see PUT .../cash-block in src/shared/api.md. Returns
 * `entered: null` when no field is overridden, otherwise a fully-populated
 * CashBlockAmounts (overridden fields from the override row, the rest
 * falling back to derived) so callers can read it wholesale.
 */
export function mergeCashBlockOverride(
  derived: CashBlockAmounts,
  sheetDay: SheetDay | null,
): CashBlock {
  const override = sheetDay?.cashOverride;
  const hasOverride =
    !!override &&
    (override.roomCashSatang !== null ||
      override.otherCashSatang !== null ||
      override.barCashSatang !== null ||
      override.bankedSatang !== null);
  if (!hasOverride || !override) return { derived, entered: null };

  return {
    derived,
    entered: {
      roomCashSatang: override.roomCashSatang ?? derived.roomCashSatang,
      otherCashSatang: override.otherCashSatang ?? derived.otherCashSatang,
      barCashSatang: override.barCashSatang ?? derived.barCashSatang,
      bankedSatang: override.bankedSatang ?? derived.bankedSatang,
    },
  };
}

/**
 * Replaces the whole cash-block override in one shot: fields present in
 * `patch` become the stored override, fields absent fall back to derived
 * (stored as NULL) — see PUT .../cash-block. `patch: null` clears every
 * field. Upserts sheet_days so a day with no other activity yet can still
 * carry a manager's override.
 */
export function setCashBlockOverride(
  property: Property,
  date: string,
  patch: Partial<CashBlockAmounts> | null,
  by: string,
): void {
  const roomCashSatang = patch?.roomCashSatang ?? null;
  const otherCashSatang = patch?.otherCashSatang ?? null;
  const barCashSatang = patch?.barCashSatang ?? null;
  const bankedSatang = patch?.bankedSatang ?? null;

  db.prepare(
    `INSERT INTO sheet_days (property, date, note, updated_at, updated_by,
       cash_room_satang, cash_other_satang, cash_bar_satang, banked_cash_satang)
     VALUES (?, ?, NULL, datetime('now'), ?, ?, ?, ?, ?)
     ON CONFLICT (property, date) DO UPDATE SET
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by,
       cash_room_satang = excluded.cash_room_satang,
       cash_other_satang = excluded.cash_other_satang,
       cash_bar_satang = excluded.cash_bar_satang,
       banked_cash_satang = excluded.banked_cash_satang`,
  ).run(property, date, by, roomCashSatang, otherCashSatang, barCashSatang, bankedSatang);
}

/** Sets or clears a day's verification stamp. Any authenticated user may
 * call this (see PUT .../verify) — unlike month close, which is manager
 * only. */
export function setDayVerified(property: Property, date: string, verified: boolean, by: string): void {
  const verifiedAtExpr = verified ? "datetime('now')" : "NULL";
  db.prepare(
    `INSERT INTO sheet_days (property, date, note, updated_at, updated_by, verified_at, verified_by)
     VALUES (?, ?, NULL, datetime('now'), ?, ${verifiedAtExpr}, ?)
     ON CONFLICT (property, date) DO UPDATE SET
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by,
       verified_at = ${verifiedAtExpr},
       verified_by = excluded.verified_by`,
  ).run(property, date, by, verified ? by : null);
}

/** Bumps updated_at/updated_by without disturbing an existing note. */
export function touchSheetDay(property: Property, date: string, by: string): void {
  db.prepare(
    `INSERT INTO sheet_days (property, date, note, updated_at, updated_by)
     VALUES (?, ?, NULL, datetime('now'), ?)
     ON CONFLICT (property, date) DO UPDATE SET
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(property, date, by);
}

export function setSheetDayNote(property: Property, date: string, note: string | null, by: string): void {
  db.prepare(
    `INSERT INTO sheet_days (property, date, note, updated_at, updated_by)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT (property, date) DO UPDATE SET
       note = excluded.note,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(property, date, note, by);
}

/** Distinct dates in `month` (YYYY-MM) that have income, an expense, a
 * booking line, an itemized other-income entry, or an explicit day note —
 * descending. See src/shared/api.md endpoint 6. Every arm exists because a
 * day can be touched through that table ALONE: booking lines carry no
 * summary cells, and a day whose only money is an itemized other-income
 * entry (real case: hfville 2025-10-20, one 60-baht pool fee on a
 * reconstructed day) exists in no other table — omitting that arm rendered
 * it as a missing day in History while it held money. */
export function listDaysWithData(property: Property, month: string): string[] {
  const like = `${month}-%`;
  const rows = db
    .query<{ date: string }, [string, string, string, string, string, string, string, string, string, string]>(
      `SELECT date FROM income_amounts WHERE property = ? AND date LIKE ?
       UNION
       SELECT date FROM expense_items WHERE property = ? AND date LIKE ?
       UNION
       SELECT date FROM sheet_days WHERE property = ? AND date LIKE ? AND note IS NOT NULL
       UNION
       SELECT date FROM booking_lines WHERE property = ? AND date LIKE ?
       UNION
       SELECT date FROM other_income_items WHERE property = ? AND date LIKE ?
       ORDER BY date DESC`,
    )
    .all(property, like, property, like, property, like, property, like, property, like);
  return rows.map((r) => r.date);
}

// ── closed_months ───────────────────────────────────────────────────────

/** True when `date`'s calendar month is closed for `property` — blocks
 * writes to income cells, booking lines, other-income items, and expenses
 * (enforced by callers in src/server/server.ts). */
export function isMonthClosed(property: Property, date: string): boolean {
  return monthIsClosed(property, date.slice(0, 7));
}

export function monthIsClosed(property: Property, month: string): boolean {
  const row = db
    .query<{ n: number }, [string, string]>(
      "SELECT 1 AS n FROM closed_months WHERE property = ? AND month = ?",
    )
    .get(property, month);
  return row !== null;
}

export function setMonthClosed(property: Property, month: string, closed: boolean, by: string): void {
  if (closed) {
    db.prepare(
      `INSERT INTO closed_months (property, month, closed_at, closed_by)
       VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT (property, month) DO UPDATE SET
         closed_at = excluded.closed_at,
         closed_by = excluded.closed_by`,
    ).run(property, month, by);
  } else {
    db.prepare("DELETE FROM closed_months WHERE property = ? AND month = ?").run(property, month);
  }
}

// ── booking_lines ───────────────────────────────────────────────────────

const TENDER_COLUMN: Record<Tender, string> = {
  deposit: "t_deposit",
  cash: "t_cash",
  credit_kbank: "t_credit_kbank",
  credit_icbc: "t_credit_icbc",
  transfer_kbank: "t_transfer_kbank",
  transfer_icbc: "t_transfer_icbc",
  web: "t_web",
  other: "t_other",
};

function zeroTenders(): Record<Tender, number> {
  return Object.fromEntries(TENDERS.map((tender) => [tender, 0])) as Record<Tender, number>;
}

interface BookingLineRow {
  id: number;
  property: string;
  date: string;
  seq: number;
  booking_no: string | null;
  guest_name: string | null;
  room_no: string | null;
  room_count: number | null;
  nights: number | null;
  gross_room_satang: number;
  gross_other_satang: number;
  discount_satang: number;
  t_deposit: number | null;
  t_cash: number | null;
  t_credit_kbank: number | null;
  t_credit_icbc: number | null;
  t_transfer_kbank: number | null;
  t_transfer_icbc: number | null;
  t_web: number | null;
  t_other: number | null;
  remark: string | null;
  source: string;
  draft: number;
  pms_ref: string | null;
  source_sheet: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

function toBookingLine(r: BookingLineRow): BookingLine {
  return {
    id: r.id,
    property: r.property as Property,
    date: r.date,
    seq: r.seq,
    bookingNo: r.booking_no,
    guestName: r.guest_name,
    roomNo: r.room_no,
    roomCount: r.room_count,
    nights: r.nights,
    grossRoomSatang: r.gross_room_satang,
    grossOtherSatang: r.gross_other_satang,
    discountSatang: r.discount_satang,
    // NULL reads back as 0 — the DB columns are nullable (see migrate()),
    // but BookingLine.tenders is a lossless plain Record<Tender, number>
    // with no null/blank distinction, so every consumer of this shape
    // sees a concrete number for all eight columns.
    tenders: {
      deposit: r.t_deposit ?? 0,
      cash: r.t_cash ?? 0,
      credit_kbank: r.t_credit_kbank ?? 0,
      credit_icbc: r.t_credit_icbc ?? 0,
      transfer_kbank: r.t_transfer_kbank ?? 0,
      transfer_icbc: r.t_transfer_icbc ?? 0,
      web: r.t_web ?? 0,
      other: r.t_other ?? 0,
    },
    remark: r.remark,
    source: r.source as BookingLine["source"],
    draft: r.draft === 1,
    sourceSheet: r.source_sheet,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function getBookingLinesForDay(property: Property, date: string): BookingLine[] {
  return db
    .query<BookingLineRow, [string, string]>(
      "SELECT * FROM booking_lines WHERE property = ? AND date = ? ORDER BY seq ASC",
    )
    .all(property, date)
    .map(toBookingLine);
}

export function countBookingLinesForDay(property: Property, date: string): number {
  const row = db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM booking_lines WHERE property = ? AND date = ?",
    )
    .get(property, date);
  return row?.n ?? 0;
}

export function getBookingLineById(property: Property, id: number): BookingLine | null {
  const row = db
    .query<BookingLineRow, [number, string]>("SELECT * FROM booking_lines WHERE id = ? AND property = ?")
    .get(id, property);
  return row ? toBookingLine(row) : null;
}

/** The editable BookingLine fields — everything except id/property/date and
 * the audit quartet (see src/shared/api.md endpoints 14/15). */
export interface BookingLineInput {
  seq?: number;
  bookingNo?: string | null;
  guestName?: string | null;
  roomNo?: string | null;
  roomCount?: number | null;
  nights?: number | null;
  grossRoomSatang?: number;
  grossOtherSatang?: number;
  discountSatang?: number;
  tenders?: Record<Tender, number>;
  remark?: string | null;
  source?: BookingLine["source"];
  draft?: boolean;
  pmsRef?: string | null;
  sourceSheet?: string | null;
}

function nextBookingLineSeq(property: Property, date: string): number {
  const row = db
    .query<{ n: number }, [string, string]>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM booking_lines WHERE property = ? AND date = ?",
    )
    .get(property, date);
  return row?.n ?? 1;
}

export function createBookingLine(
  property: Property,
  date: string,
  input: BookingLineInput,
  by: string,
): BookingLine {
  const seq = input.seq ?? nextBookingLineSeq(property, date);
  const tenders = input.tenders ?? zeroTenders();

  const info = db
    .prepare(
      `INSERT INTO booking_lines (
         property, date, seq, booking_no, guest_name, room_no, room_count, nights,
         gross_room_satang, gross_other_satang, discount_satang,
         t_deposit, t_cash, t_credit_kbank, t_credit_icbc, t_transfer_kbank, t_transfer_icbc, t_web, t_other,
         remark, source, draft, pms_ref, source_sheet, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      property,
      date,
      seq,
      input.bookingNo ?? null,
      input.guestName ?? null,
      input.roomNo ?? null,
      input.roomCount ?? null,
      input.nights ?? null,
      input.grossRoomSatang ?? 0,
      input.grossOtherSatang ?? 0,
      input.discountSatang ?? 0,
      tenders.deposit,
      tenders.cash,
      tenders.credit_kbank,
      tenders.credit_icbc,
      tenders.transfer_kbank,
      tenders.transfer_icbc,
      tenders.web,
      tenders.other,
      input.remark ?? null,
      input.source ?? "manual",
      input.draft ? 1 : 0,
      input.pmsRef ?? null,
      input.sourceSheet ?? null,
      by,
      by,
    );
  return getBookingLineById(property, Number(info.lastInsertRowid))!;
}

export function updateBookingLine(
  property: Property,
  id: number,
  patch: BookingLineInput,
  by: string,
): BookingLine | null {
  const existing = getBookingLineById(property, id);
  if (!existing) return null;

  const sets: string[] = ["updated_at = datetime('now')", "updated_by = ?"];
  const params: Array<string | number | null> = [by];
  const set = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.seq !== undefined) set("seq", patch.seq);
  if (patch.bookingNo !== undefined) set("booking_no", patch.bookingNo);
  if (patch.guestName !== undefined) set("guest_name", patch.guestName);
  if (patch.roomNo !== undefined) set("room_no", patch.roomNo);
  if (patch.roomCount !== undefined) set("room_count", patch.roomCount);
  if (patch.nights !== undefined) set("nights", patch.nights);
  if (patch.grossRoomSatang !== undefined) set("gross_room_satang", patch.grossRoomSatang);
  if (patch.grossOtherSatang !== undefined) set("gross_other_satang", patch.grossOtherSatang);
  if (patch.discountSatang !== undefined) set("discount_satang", patch.discountSatang);
  if (patch.remark !== undefined) set("remark", patch.remark);
  if (patch.source !== undefined) set("source", patch.source);
  if (patch.draft !== undefined) set("draft", patch.draft ? 1 : 0);
  if (patch.pmsRef !== undefined) set("pms_ref", patch.pmsRef);
  if (patch.sourceSheet !== undefined) set("source_sheet", patch.sourceSheet);
  if (patch.tenders !== undefined) {
    for (const tender of TENDERS) set(TENDER_COLUMN[tender], patch.tenders[tender]);
  }

  db.prepare(`UPDATE booking_lines SET ${sets.join(", ")} WHERE id = ? AND property = ?`).run(
    ...params,
    id,
    property,
  );
  return getBookingLineById(property, id);
}

export function deleteBookingLine(property: Property, id: number): boolean {
  const info = db.prepare("DELETE FROM booking_lines WHERE id = ? AND property = ?").run(id, property);
  return info.changes > 0;
}

// ── other_income_items ──────────────────────────────────────────────────

interface OtherIncomeItemRow {
  id: number;
  property: string;
  date: string;
  description: string | null;
  amount_satang: number;
  is_cash: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

function toOtherIncomeItem(r: OtherIncomeItemRow): OtherIncomeItem {
  return {
    id: r.id,
    property: r.property as Property,
    date: r.date,
    description: r.description,
    amountSatang: r.amount_satang,
    isCash: r.is_cash === 1,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function getOtherIncomeForDay(property: Property, date: string): OtherIncomeItem[] {
  return db
    .query<OtherIncomeItemRow, [string, string]>(
      "SELECT * FROM other_income_items WHERE property = ? AND date = ? ORDER BY id ASC",
    )
    .all(property, date)
    .map(toOtherIncomeItem);
}

export function getOtherIncomeItemById(property: Property, id: number): OtherIncomeItem | null {
  const row = db
    .query<OtherIncomeItemRow, [number, string]>("SELECT * FROM other_income_items WHERE id = ? AND property = ?")
    .get(id, property);
  return row ? toOtherIncomeItem(row) : null;
}

export function createOtherIncomeItem(
  property: Property,
  date: string,
  description: string | null,
  amountSatang: number,
  isCash: boolean,
  by: string,
): OtherIncomeItem {
  const info = db
    .prepare(
      `INSERT INTO other_income_items (property, date, description, amount_satang, is_cash, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(property, date, description, amountSatang, isCash ? 1 : 0, by, by);
  return getOtherIncomeItemById(property, Number(info.lastInsertRowid))!;
}

export type UpdateOtherIncomeItemPatch = { description?: string | null; amountSatang?: number; isCash?: boolean };

export function updateOtherIncomeItem(
  property: Property,
  id: number,
  patch: UpdateOtherIncomeItemPatch,
  by: string,
): OtherIncomeItem | null {
  const existing = getOtherIncomeItemById(property, id);
  if (!existing) return null;

  const sets: string[] = ["updated_at = datetime('now')", "updated_by = ?"];
  const params: Array<string | number | null> = [by];
  if (patch.description !== undefined) {
    sets.push("description = ?");
    params.push(patch.description);
  }
  if (patch.amountSatang !== undefined) {
    sets.push("amount_satang = ?");
    params.push(patch.amountSatang);
  }
  if (patch.isCash !== undefined) {
    sets.push("is_cash = ?");
    params.push(patch.isCash ? 1 : 0);
  }

  db.prepare(`UPDATE other_income_items SET ${sets.join(", ")} WHERE id = ? AND property = ?`).run(
    ...params,
    id,
    property,
  );
  return getOtherIncomeItemById(property, id);
}

export function deleteOtherIncomeItem(property: Property, id: number): boolean {
  const info = db.prepare("DELETE FROM other_income_items WHERE id = ? AND property = ?").run(id, property);
  return info.changes > 0;
}
