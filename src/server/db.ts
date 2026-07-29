import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PROPERTIES } from "../shared/types.ts";
import type { Category, CategoryKind, ExpenseItem, IncomeCell, Property } from "../shared/types.ts";

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
  `);

  for (const property of PROPERTIES) seedIfEmpty(property);
}

// Paper order; isCash flags per src/shared/api.md "Data model".
const INCOME_SEED: ReadonlyArray<{ nameTh: string; isCash: boolean }> = [
  { nameTh: "มัดจำล่วงหน้า", isCash: false },
  { nameTh: "ค่าห้องเงินสด", isCash: true },
  { nameTh: "บัตรเครดิต/กสิกร", isCash: false },
  { nameTh: "บัตรเครดิต ICBC", isCash: false },
  { nameTh: "โอน/กสิกร", isCash: false },
  { nameTh: "โอน ICBC", isCash: false },
  { nameTh: "เว็ปไซด์", isCash: false },
  { nameTh: "รายการอื่นๆ", isCash: true },
  { nameTh: "บาร์น้ำ เงินสด", isCash: true },
  { nameTh: "บาร์น้ำ โอน/เครดิต", isCash: false },
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

  const insert = db.prepare(
    "INSERT INTO categories (property, kind, name_th, sort, is_cash) VALUES (?, ?, ?, ?, ?)",
  );
  const tx = db.transaction(() => {
    INCOME_SEED.forEach((c, i) => insert.run(property, "income", c.nameTh, i, c.isCash ? 1 : 0));
    EXPENSE_SEED.forEach((c, i) => insert.run(property, "expense", c.nameTh, i, c.isCash ? 1 : 0));
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
  updated_at: string;
  updated_by: string;
}

export function getIncomeForDay(property: Property, date: string): Record<number, IncomeCell> {
  const rows = db
    .query<IncomeRow, [string, string]>(
      "SELECT category_id, amount_satang, note, updated_at, updated_by FROM income_amounts WHERE property = ? AND date = ?",
    )
    .all(property, date);
  const out: Record<number, IncomeCell> = {};
  for (const r of rows) {
    out[r.category_id] = {
      categoryId: r.category_id,
      amountSatang: r.amount_satang,
      note: r.note,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    };
  }
  return out;
}

/**
 * amountSatang null/0 DELETEs the cell (empty cells don't accumulate rows —
 * see src/shared/api.md endpoint 8). Does not touch sheet_days; callers
 * pair this with touchSheetDay().
 */
export function saveIncomeCell(
  property: Property,
  date: string,
  categoryId: number,
  amountSatang: number | null,
  note: string | null,
  updatedBy: string,
): void {
  if (amountSatang === null || amountSatang === 0) {
    db.prepare("DELETE FROM income_amounts WHERE property = ? AND date = ? AND category_id = ?").run(
      property,
      date,
      categoryId,
    );
    return;
  }

  db.prepare(
    `INSERT INTO income_amounts (property, date, category_id, amount_satang, note, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT (property, date, category_id) DO UPDATE SET
       amount_satang = excluded.amount_satang,
       note = excluded.note,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(property, date, categoryId, amountSatang, note, updatedBy);
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
}

export function getSheetDay(
  property: Property,
  date: string,
): { note: string | null; updatedAt: string; updatedBy: string } | null {
  const row = db
    .query<SheetDayRow, [string, string]>(
      "SELECT note, updated_at, updated_by FROM sheet_days WHERE property = ? AND date = ?",
    )
    .get(property, date);
  if (!row) return null;
  return { note: row.note, updatedAt: row.updated_at, updatedBy: row.updated_by };
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

/** Distinct dates in `month` (YYYY-MM) that have income, an expense, or an
 * explicit day note — descending. See src/shared/api.md endpoint 6. */
export function listDaysWithData(property: Property, month: string): string[] {
  const like = `${month}-%`;
  const rows = db
    .query<{ date: string }, [string, string, string, string, string, string]>(
      `SELECT date FROM income_amounts WHERE property = ? AND date LIKE ?
       UNION
       SELECT date FROM expense_items WHERE property = ? AND date LIKE ?
       UNION
       SELECT date FROM sheet_days WHERE property = ? AND date LIKE ? AND note IS NOT NULL
       ORDER BY date DESC`,
    )
    .all(property, like, property, like, property, like);
  return rows.map((r) => r.date);
}
