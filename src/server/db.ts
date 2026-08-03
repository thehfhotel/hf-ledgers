import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PROPERTIES, TENDERS } from "../shared/types.ts";
import type {
  BookingLine,
  CashAdjustmentAmounts,
  CashBlock,
  CashBlockAmounts,
  Category,
  CategoryKey,
  CategoryKind,
  DayProvenance,
  DepositEvent,
  DepositEventKind,
  DepositNote,
  DepositTender,
  ExpenseItem,
  IncomeCell,
  OtherIncomeItem,
  PaymentAudit,
  Property,
  Tender,
} from "../shared/types.ts";
import type { DepositCandidate, PrefillCandidate } from "./pms-prefill.ts";

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
      t_deposit_applied INTEGER CHECK (t_deposit_applied IS NULL OR t_deposit_applied >= 0),
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

    -- Wave C (docs/adr/0001-accrual-recognition-for-deposits.md): one row
    -- per received-or-refunded มัดจำล่วงหน้า moment. Modelled on
    -- other_income_items (day-scoped, itemized), NOT a BookingLine flag —
    -- see shared/types.ts's DepositEvent doc comment for the failure-mode
    -- argument. amount_satang is always a >0 MAGNITUDE; kind carries the
    -- sign.
    CREATE TABLE IF NOT EXISTS deposit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL CHECK (property IN ('hf', 'hfville')),
      date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('received', 'refunded')),
      booking_no TEXT,
      guest_name TEXT,
      tender TEXT NOT NULL CHECK (tender IN ('cash', 'transfer', 'credit', 'web', 'other')),
      amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
      note TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'pms')),
      pms_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deposit_events_day ON deposit_events (property, date);

    -- One PMS payment can split tenders (see pms-prefill.ts), so the
    -- idempotence key for a PMS-sourced row is (property, date, pms_ref,
    -- tender), not (property, date, pms_ref) alone — mirrors
    -- idx_booking_lines_pms_ref's shape. Manual (hand-entered) rows never
    -- carry a pms_ref and are exempt.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_events_pms_ref
      ON deposit_events (property, date, pms_ref, tender) WHERE pms_ref IS NOT NULL;

    -- Wave D (the office deposit register — issue #5 / the R015834-style
    -- reconciliation requirement): ONE note thread per (property, R-number),
    -- never per exception kind — an R-number pairs with its deposit for
    -- life (docs/adr/0001: the booking is moved, never replaced), so a
    -- thread's whole history (aging today, mismatched next month) shares
    -- one conversation. "Explained" = resolved_at IS NOT NULL explicitly
    -- (mirrors sheet_days.verified_at's convention) — a note saying
    -- "waiting on reception" must keep shouting until someone deliberately
    -- marks it resolved.
    CREATE TABLE IF NOT EXISTS deposit_notes (
      property TEXT NOT NULL CHECK (property IN ('hf', 'hfville')),
      r_number TEXT NOT NULL,
      note TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL,
      PRIMARY KEY (property, r_number)
    );

    -- Wave 1 (docs/plan-audit-hub-slips.md, the office audit hub): one row
    -- per audited PAYMENT SETTLEMENT — audit_key is the CH (check-in) number
    -- for a เช็คอิน row (ค่าห้อง + its ตัดยอดมัดจำ merged), or the receipt's
    -- own pay_no for a รับมัดจำ/คืนเงิน row. Absence of a row = pending; there
    -- is no stored "false" (mirrors deposit_notes' resolved_at-presence
    -- convention). PK is (property, audit_key) ONLY — a settlement has
    -- exactly one audit_key for its whole life, so re-ticking (from any
    -- day's queue view) always targets the SAME row; the date column just
    -- records which audited day the tick was made from (see
    -- shared/types.ts's PaymentAudit doc comment). Un-ticking DELETEs the
    -- row outright (deletePaymentAudit) rather than storing a "false" or
    -- clearing timestamps in place — simpler than deposit_notes' resolved_at
    -- clear-in-place, and correct here because there is no note text to
    -- preserve across an un-tick.
    CREATE TABLE IF NOT EXISTS payment_audits (
      property TEXT NOT NULL CHECK (property IN ('hf', 'hfville')),
      audit_key TEXT NOT NULL,
      date TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      checked_by TEXT NOT NULL,
      PRIMARY KEY (property, audit_key)
    );

    -- The day-audit endpoint's own day-scoped listing (listPaymentAudits
    -- with a date) filters on this pair.
    CREATE INDEX IF NOT EXISTS idx_payment_audits_day ON payment_audits (property, date);
  `);

  migrateCategoryKeyColumn();
  addColumnIfMissing("income_amounts", "source", "TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing("income_amounts", "manual", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("sheet_days", "cash_room_satang", "INTEGER");
  addColumnIfMissing("sheet_days", "cash_other_satang", "INTEGER");
  addColumnIfMissing("sheet_days", "cash_bar_satang", "INTEGER");
  addColumnIfMissing("sheet_days", "banked_cash_satang", "INTEGER");
  // Deposit-machine reconciliation rows (docs/plan-unify-exports-tender-
  // split.md item 6, Wave C) — same nullable-column-on-sheet_days shape as
  // the four cash-override columns above, persisted/audited/merged the
  // same way (setCashBlockOverride/mergeCashBlockOverride), but with no
  // "derived" counterpart: see CashAdjustmentAmounts in shared/types.ts.
  addColumnIfMissing("sheet_days", "cash_held_back_satang", "INTEGER");
  addColumnIfMissing("sheet_days", "cash_brought_forward_satang", "INTEGER");
  addColumnIfMissing("sheet_days", "provenance", "TEXT NOT NULL DEFAULT 'app'");
  addColumnIfMissing("sheet_days", "verified_at", "TEXT");
  addColumnIfMissing("sheet_days", "verified_by", "TEXT");
  // Wave C (docs/adr/0001): the ninth tender, ตัดยอดมัดจำ — see
  // shared/types.ts's Tender doc comment. Already in the CREATE TABLE above
  // for a fresh DB; this covers an existing one.
  addColumnIfMissing("booking_lines", "t_deposit_applied", "INTEGER CHECK (t_deposit_applied IS NULL OR t_deposit_applied >= 0)");

  for (const property of PROPERTIES) seedIfEmpty(property);

  migrateTransferCreditSplit();
  migrateDepositAppliedCategory();
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

// ── โอน/เครดิต split (Wave B, docs/plan-unify-exports-tender-split.md item 2) ──
// The paper's three mixed-tender categories (มัดจำล่วงหน้า, รายการอื่นๆ
// โอน/เครดิต, บาร์น้ำ โอน/เครดิต) combined โอน+เครดิต in one input cell.
// `deposit`/`other_transfer`/`bar_transfer` KEEP their key strings — history
// stays under them untouched, no retro-split — but become โอน-only going
// forward, so their name_th gets โอน-only wording; a new เครดิต sibling
// category is seeded right after each. Additive, same shape as
// backfillCategoryKeys above: safe to run on every boot, and a no-op once
// applied (or on a fresh DB, whose INCOME_SEED is already pre-split).

interface TransferCreditSplit {
  transferKey: "deposit" | "other_transfer" | "bar_transfer";
  /** The pre-split seed default — renaming only fires when name_th still
   * equals this (whitespace-tolerant), so a manager's hand-set name is
   * never clobbered. */
  oldNameTh: string;
  newTransferNameTh: string;
  creditKey: "deposit_credit" | "other_credit" | "bar_credit";
  creditNameTh: string;
}

const TRANSFER_CREDIT_SPLITS: readonly TransferCreditSplit[] = [
  {
    transferKey: "deposit",
    oldNameTh: "มัดจำล่วงหน้า",
    newTransferNameTh: "มัดจำล่วงหน้า โอน",
    creditKey: "deposit_credit",
    creditNameTh: "มัดจำล่วงหน้า เครดิต",
  },
  {
    transferKey: "other_transfer",
    oldNameTh: "รายการอื่นๆ โอน/เครดิต",
    newTransferNameTh: "รายการอื่นๆ โอน",
    creditKey: "other_credit",
    creditNameTh: "รายการอื่นๆ เครดิต",
  },
  {
    transferKey: "bar_transfer",
    oldNameTh: "บาร์น้ำ โอน/เครดิต",
    newTransferNameTh: "บาร์น้ำ โอน",
    creditKey: "bar_credit",
    creditNameTh: "บาร์น้ำ เครดิต",
  },
];

/**
 * True when an ACTIVE (archived_at IS NULL) category already holds
 * `nameTh` for this (property, kind='income') — mirrors exactly the scope
 * of `idx_categories_active_name` (the partial unique index above), so this
 * returning false is the precise condition under which the corresponding
 * INSERT/UPDATE is guaranteed not to violate it. `excludeId` lets a rename
 * check ignore the row being renamed itself (renaming a row to the name it
 * already has, or would-be-has, is never a real collision).
 */
function activeNameCollision(property: Property, nameTh: string, excludeId?: number): boolean {
  const row = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM categories WHERE property = ? AND kind = 'income' AND archived_at IS NULL AND name_th = ?",
    )
    .get(property, nameTh);
  return row !== null && row.id !== excludeId;
}

/**
 * Per property: renames a still-default `transferKey` category to its
 * โอน-only wording, then seeds its เครดิต sibling immediately after it
 * (shifting every later sort by +1, same splice pattern
 * splitOtherIncomeCategory uses above). The sibling is seeded exactly once
 * — guarded by `category_key` already existing at all (active or
 * archived) for this property, never by name, so re-running this is a
 * no-op once applied. If `transferKey`'s category is missing entirely
 * (should not happen: the seed always creates it), the pair is skipped —
 * nothing to split against.
 *
 * Collision safety: `idx_categories_active_name` is a UNIQUE index on
 * (property, kind, name_th) for active rows. A manager can independently
 * create/rename an income category to any of our six target names before
 * this migration ever runs it — a rename or insert that collided with one
 * would throw inside `migrate()`, which runs at module top level (see the
 * bottom of this file): the process would die before `Bun.serve` ever
 * starts, and `restart:unless-stopped` would crash-loop the container
 * forever (empirically reproduced in review). Both the rename and the
 * insert below are therefore collision-checked first and SKIP (never
 * throw) when the target name is already active on a different row —
 * logged so the gap is visible, not silently swallowed.
 */
function splitTransferCreditCategory(property: Property, split: TransferCreditSplit): void {
  const row = db
    .query<{ id: number; sort: number; name_th: string }, [string, string]>(
      "SELECT id, sort, name_th FROM categories WHERE property = ? AND kind = 'income' AND category_key = ?",
    )
    .get(property, split.transferKey);
  if (!row) return;

  if (stripSpaces(row.name_th) === stripSpaces(split.oldNameTh)) {
    if (activeNameCollision(property, split.newTransferNameTh, row.id)) {
      console.log(
        `[db] migrateTransferCreditSplit: property=${property} key=${split.transferKey} — an active category is already named "${split.newTransferNameTh}"; skipped the rename, left "${row.name_th}" as-is.`,
      );
    } else {
      db.prepare("UPDATE categories SET name_th = ? WHERE id = ?").run(split.newTransferNameTh, row.id);
    }
  }

  const alreadySeeded = db
    .query<{ n: number }, [string, string]>("SELECT 1 AS n FROM categories WHERE property = ? AND category_key = ?")
    .get(property, split.creditKey);
  if (alreadySeeded) return;

  if (activeNameCollision(property, split.creditNameTh)) {
    console.log(
      `[db] migrateTransferCreditSplit: property=${property} key=${split.creditKey} — an active category is already named "${split.creditNameTh}"; skipped seeding the เครดิต sibling (will retry next boot).`,
    );
    return;
  }

  db.prepare("UPDATE categories SET sort = sort + 1 WHERE property = ? AND kind = 'income' AND sort > ?").run(
    property,
    row.sort,
  );
  db.prepare(
    `INSERT INTO categories (property, kind, name_th, sort, is_cash, category_key)
     VALUES (?, 'income', ?, ?, 0, ?)`,
  ).run(property, split.creditNameTh, row.sort + 1, split.creditKey);
}

/** Same succeed-or-fail-together reasoning as migrateCategoryKeyColumn: one
 * transaction per boot so a crash mid-way never leaves one property (or one
 * of the three pairs) split while another isn't. */
function migrateTransferCreditSplit(): void {
  const tx = db.transaction(() => {
    for (const property of PROPERTIES) {
      for (const split of TRANSFER_CREDIT_SPLITS) splitTransferCreditCategory(property, split);
    }
  });
  tx();
}

// ── deposit_applied category (Wave C, docs/adr/0001-accrual-recognition-
// for-deposits.md) ──────────────────────────────────────────────────────
// Seeded immediately after deposit_credit — same splice-and-shift pattern
// as splitTransferCreditCategory/splitOtherIncomeCategory above (never a
// plain append, which would put it at the END of the list rather than
// beside its accrual-era sibling `deposit`/`deposit_credit`). A fresh
// database's INCOME_SEED already carries it pre-inserted (see below), so
// this migration is a no-op there; it only does real work against a
// pre-Wave-C database.

const DEPOSIT_APPLIED_NAME_TH = "มัดจำล่วงหน้า (ตัดยอด)";

/**
 * Per property: inserts the `deposit_applied` category right after
 * `deposit_credit`'s current sort position, shifting everything after it up
 * by one (same splice as splitTransferCreditCategory). Guarded by
 * `category_key` already existing at all for this property (never by
 * name), so this is idempotent — a no-op once applied, or on a fresh DB
 * whose seed already includes it. Collision-safe like every other category
 * migration in this file: `idx_categories_active_name` is a UNIQUE index,
 * so a manager could independently have created/renamed a category to this
 * exact name before this migration ever runs — SKIP (never throw) rather
 * than crash `migrate()` at module top level and crash-loop the container.
 */
function migrateDepositAppliedCategoryForProperty(property: Property): void {
  const alreadySeeded = db
    .query<{ n: number }, [string, string]>(
      "SELECT 1 AS n FROM categories WHERE property = ? AND category_key = ?",
    )
    .get(property, "deposit_applied");
  if (alreadySeeded) return;

  const afterRow = db
    .query<{ sort: number }, [string, string]>(
      "SELECT sort FROM categories WHERE property = ? AND kind = 'income' AND category_key = ?",
    )
    .get(property, "deposit_credit");
  // deposit_credit missing entirely should not happen (the seed always
  // creates it, and it predates this migration) — skip cleanly rather than
  // guess a sort position if it somehow is.
  if (!afterRow) return;

  if (activeNameCollision(property, DEPOSIT_APPLIED_NAME_TH)) {
    console.log(
      `[db] migrateDepositAppliedCategory: property=${property} — an active category is already named "${DEPOSIT_APPLIED_NAME_TH}"; skipped seeding deposit_applied (will retry next boot).`,
    );
    return;
  }

  db.prepare("UPDATE categories SET sort = sort + 1 WHERE property = ? AND kind = 'income' AND sort > ?").run(
    property,
    afterRow.sort,
  );
  db.prepare(
    `INSERT INTO categories (property, kind, name_th, sort, is_cash, category_key)
     VALUES (?, 'income', ?, ?, 0, 'deposit_applied')`,
  ).run(property, DEPOSIT_APPLIED_NAME_TH, afterRow.sort + 1);
}

/** Same succeed-or-fail-together reasoning as the migrations above. */
function migrateDepositAppliedCategory(): void {
  const tx = db.transaction(() => {
    for (const property of PROPERTIES) migrateDepositAppliedCategoryForProperty(property);
  });
  tx();
}

// Paper order; isCash flags per src/shared/api.md "Data model". รายการอื่นๆ
// is seeded pre-split into its cash/transfer pair (see "รายการอื่นๆ —
// RESOLVED") so a fresh database never needs that split migration to run.
// มัดจำล่วงหน้า/รายการอื่นๆ โอน/บาร์น้ำ โอน are likewise seeded pre-split from
// their เครดิต sibling (see "โอน/เครดิต split" below, item 2 of
// docs/plan-unify-exports-tender-split.md) — a fresh database never needs
// TRANSFER_CREDIT_SPLITS to run either.
const INCOME_SEED: ReadonlyArray<{ nameTh: string; isCash: boolean; categoryKey: CategoryKey }> = [
  { nameTh: "มัดจำล่วงหน้า โอน", isCash: false, categoryKey: "deposit" },
  { nameTh: "มัดจำล่วงหน้า เครดิต", isCash: false, categoryKey: "deposit_credit" },
  // Wave C (docs/adr/0001): the accrual-era counterpart, seeded right after
  // its pre-cutover siblings — see migrateDepositAppliedCategoryForProperty
  // above for the existing-DB migration that inserts this in the same spot.
  { nameTh: DEPOSIT_APPLIED_NAME_TH, isCash: false, categoryKey: "deposit_applied" },
  { nameTh: "ค่าห้องเงินสด", isCash: true, categoryKey: "room_cash" },
  { nameTh: "บัตรเครดิต/กสิกร", isCash: false, categoryKey: "credit_kbank" },
  { nameTh: "บัตรเครดิต ICBC", isCash: false, categoryKey: "credit_icbc" },
  { nameTh: "โอน/กสิกร", isCash: false, categoryKey: "transfer_kbank" },
  { nameTh: "โอน ICBC", isCash: false, categoryKey: "transfer_icbc" },
  { nameTh: "เว็ปไซด์", isCash: false, categoryKey: "web" },
  { nameTh: "รายการอื่นๆ เงินสด", isCash: true, categoryKey: "other_cash" },
  { nameTh: "รายการอื่นๆ โอน", isCash: false, categoryKey: "other_transfer" },
  { nameTh: "รายการอื่นๆ เครดิต", isCash: false, categoryKey: "other_credit" },
  { nameTh: "บาร์น้ำ เงินสด", isCash: true, categoryKey: "bar_cash" },
  { nameTh: "บาร์น้ำ โอน", isCash: false, categoryKey: "bar_transfer" },
  { nameTh: "บาร์น้ำ เครดิต", isCash: false, categoryKey: "bar_credit" },
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
  cash_held_back_satang: number | null;
  cash_brought_forward_satang: number | null;
  provenance: string;
  verified_at: string | null;
  verified_by: string | null;
}

export interface SheetDay {
  note: string | null;
  updatedAt: string;
  updatedBy: string;
  cashOverride: {
    roomCashSatang: number | null;
    otherCashSatang: number | null;
    barCashSatang: number | null;
    bankedSatang: number | null;
    /** See CashAdjustmentAmounts (shared/types.ts) — no `derived`
     * counterpart of their own, unlike the four fields above. */
    heldBackSatang: number | null;
    broughtForwardSatang: number | null;
  };
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
      heldBackSatang: row.cash_held_back_satang,
      broughtForwardSatang: row.cash_brought_forward_satang,
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
              banked_cash_satang, cash_held_back_satang, cash_brought_forward_satang,
              provenance, verified_at, verified_by
       FROM sheet_days WHERE property = ? AND date = ?`,
    )
    .get(property, date);
  return row ? toSheetDay(row) : null;
}

/**
 * Merges a day's stored cash-block override (any subset of the four
 * `CashBlockAmounts` fields, nullable meaning "use derived") on top of the
 * freshly computed `derived` half — see PUT .../cash-block in
 * src/shared/api.md. Returns `entered: null` when no `CashBlockAmounts`
 * field is overridden, otherwise a fully-populated CashBlockAmounts
 * (overridden fields from the override row, the rest falling back to
 * derived) so callers can read it wholesale.
 *
 * `heldBackSatang`/`broughtForwardSatang` are copied straight through from
 * the stored override onto the returned CashBlock, independent of
 * `hasOverride` above — they have no `derived` fallback of their own (see
 * CashAdjustmentAmounts), so there is nothing to "merge": `null` genuinely
 * means not recorded. Callers must have already folded them into `derived`
 * (via deriveCashBlock's own heldBackSatang/broughtForwardSatang
 * parameters) before calling this — this function only surfaces them for
 * display/edit, it does not recompute bankedSatang from them.
 */
export function mergeCashBlockOverride(
  derived: CashBlockAmounts,
  sheetDay: SheetDay | null,
): Omit<CashBlock, "depositCashInSatang" | "depositCashOutSatang"> {
  const override = sheetDay?.cashOverride;
  const hasOverride =
    !!override &&
    (override.roomCashSatang !== null ||
      override.otherCashSatang !== null ||
      override.barCashSatang !== null ||
      override.bankedSatang !== null);
  const entered =
    !hasOverride || !override
      ? null
      : {
          roomCashSatang: override.roomCashSatang ?? derived.roomCashSatang,
          otherCashSatang: override.otherCashSatang ?? derived.otherCashSatang,
          barCashSatang: override.barCashSatang ?? derived.barCashSatang,
          bankedSatang: override.bankedSatang ?? derived.bankedSatang,
        };

  return {
    derived,
    entered,
    heldBackSatang: override?.heldBackSatang ?? null,
    broughtForwardSatang: override?.broughtForwardSatang ?? null,
  };
}

/**
 * Replaces the whole cash-block override in one shot: fields present in
 * `patch` become the stored override, fields absent fall back to derived —
 * or, for `heldBackSatang`/`broughtForwardSatang`, to "not recorded" —
 * (stored as NULL) — see PUT .../cash-block. `patch: null` clears every
 * field, both the four `CashBlockAmounts` overrides AND the two adjustment
 * fields (callers that mean to clear only one half must re-send the other
 * half's current values explicitly — see DaySheetPage.tsx/
 * BookingDayPage.tsx's clearCashOverride()/clearCashAdjustment()). Upserts
 * sheet_days so a day with no other activity yet can still carry a
 * manager's override.
 */
export function setCashBlockOverride(
  property: Property,
  date: string,
  patch: (Partial<CashBlockAmounts> & Partial<CashAdjustmentAmounts>) | null,
  by: string,
): void {
  const roomCashSatang = patch?.roomCashSatang ?? null;
  const otherCashSatang = patch?.otherCashSatang ?? null;
  const barCashSatang = patch?.barCashSatang ?? null;
  const bankedSatang = patch?.bankedSatang ?? null;
  const heldBackSatang = patch?.heldBackSatang ?? null;
  const broughtForwardSatang = patch?.broughtForwardSatang ?? null;

  db.prepare(
    `INSERT INTO sheet_days (property, date, note, updated_at, updated_by,
       cash_room_satang, cash_other_satang, cash_bar_satang, banked_cash_satang,
       cash_held_back_satang, cash_brought_forward_satang)
     VALUES (?, ?, NULL, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (property, date) DO UPDATE SET
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by,
       cash_room_satang = excluded.cash_room_satang,
       cash_other_satang = excluded.cash_other_satang,
       cash_bar_satang = excluded.cash_bar_satang,
       banked_cash_satang = excluded.banked_cash_satang,
       cash_held_back_satang = excluded.cash_held_back_satang,
       cash_brought_forward_satang = excluded.cash_brought_forward_satang`,
  ).run(
    property,
    date,
    by,
    roomCashSatang,
    otherCashSatang,
    barCashSatang,
    bankedSatang,
    heldBackSatang,
    broughtForwardSatang,
  );
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
  deposit_applied: "t_deposit_applied",
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
  t_deposit_applied: number | null;
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
      deposit_applied: r.t_deposit_applied ?? 0,
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
         t_deposit, t_deposit_applied, t_cash, t_credit_kbank, t_credit_icbc, t_transfer_kbank, t_transfer_icbc, t_web, t_other,
         remark, source, draft, pms_ref, source_sheet, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      tenders.deposit_applied,
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

/**
 * Inserts one `booking_lines` row per `PrefillCandidate` for `POST
 * .../pull-from-pms` (see src/server/pms-prefill.ts and src/shared/api.md).
 * ONE transaction. Per candidate: a row already on `(property, date,
 * pms_ref)` is skipped (counted, never updated — hand edits are sacred);
 * otherwise inserted via `createBookingLine()` with `source: 'pms'`,
 * `draft: false` (this is a confirmed received payment, not a draft
 * awaiting front-desk confirmation), `seq` allocated the same
 * `nextBookingLineSeq()` way every other insert path uses.
 *
 * Tenders — AUTO-PLACEMENT POLICY (grep "AUTO-PLACEMENT POLICY" if this
 * ever needs revisiting; evidence-based, set 2026-07-31, superseding the
 * older "never guess the acquiring bank, leave credit/transfer at 0"
 * rule for transfer specifically): `cash`/`web` always come straight from
 * the candidate, unchanged.
 *
 * - **`t_deposit` is NEVER written here any more** (Wave C,
 *   docs/adr/0001) — the pre-cutover `deposit` tender is retired at the
 *   importer's write boundary; every PMS-sourced booking line now writes
 *   `t_deposit_applied` from `candidate.appliedDepositSatang` instead (the
 *   accrual-era ตัดยอดมัดจำ tender, per V1's reading of `ledger_free` — see
 *   pms-prefill.ts). `appliedDepositBookingNos` (the R-numbers a ตัดยอด
 *   line's label carries) fold into `remark` so the office can trace which
 *   deposit(s) this line's applied amount came from, without clobbering an
 *   existing remark the candidate never supplies one alongside.
 * - `unplacedTranSatang` is written into `transfer_kbank` for BOTH
 *   properties. Across all 6,024 historical booking lines on hf AND
 *   hfville, `t_transfer_icbc` is 0 in every single row — every transfer
 *   this hotel group has ever recorded is โอน/กสิกร. This was previously
 *   left unwritten under the old "never guess the acquiring bank" rule;
 *   the evidence now empties that rule for transfers, and leaving it
 *   unwritten was a confirmed production money bug (12 of 17 PMS-inserted
 *   rows short by exactly their ledger_tran; 15,777 THB missing on hfville
 *   2026-07-24 and 2026-07-30 — docs/plan-unify-exports-tender-split.md
 *   item 4). If a real ICBC transfer ever shows up in the history (some
 *   row's `t_transfer_icbc` becomes nonzero), this policy needs revisiting
 *   — do not assume it still holds.
 * - `unplacedCreditSatang` is written into `credit_kbank` ONLY when
 *   `property === "hfville"` — hfville's entire credit-card history uses
 *   `credit_kbank` exclusively (single bank in practice there). `"hf"`
 *   genuinely uses both `credit_kbank` and `credit_icbc` historically, so
 *   which bank a "hf" credit-card payment landed on cannot be inferred
 *   from the PMS ledger; it stays unwritten (0) and is reported back to
 *   the caller (server.ts's `unplaced`) for hand-placement, same as
 *   before.
 *
 * Refund filtering happens in the caller (server.ts) before this is
 * invoked — every candidate reaching here is assumed insertable.
 */

/**
 * The tender placement for ONE `PrefillCandidate` — extracted (Wave D,
 * D5) from `insertPmsBookingLines`'s inline object so there is exactly ONE
 * place that decides where PMS money lands on the 9-tender record. Reused
 * by `insertPmsBookingLines` (new row), `diffCandidateAgainstBookingLine`
 * (re-pull comparison), and `applyPmsCandidateToBookingLine` (accepting a
 * re-pull diff) — all three must agree on this or a "changed" row and the
 * row a fresh pull would insert could silently diverge. See the
 * AUTO-PLACEMENT POLICY note above: `cash`/`web` always straight from the
 * candidate; `transfer_kbank` always carries `unplacedTranSatang`;
 * `credit_kbank` only on hfville; `deposit_applied` carries
 * `appliedDepositSatang` (Wave C) — this now explicitly includes that ninth
 * tender, unlike the pre-Wave-C `t_deposit` placement it replaced.
 */
export function candidateTenderPatch(property: Property, candidate: PrefillCandidate): Record<Tender, number> {
  return {
    ...zeroTenders(),
    deposit_applied: candidate.appliedDepositSatang,
    cash: candidate.cashSatang,
    web: candidate.webSatang,
    transfer_kbank: candidate.unplacedTranSatang,
    credit_kbank: property === "hfville" ? candidate.unplacedCreditSatang : 0,
  };
}

/** The tender columns `candidateTenderPatch` actually writes for a given
 * property — everything else (`deposit`, `credit_icbc`, `transfer_icbc`,
 * `other`) is hand-keyed and must never be touched by a re-pull merge (see
 * `applyPmsCandidateToBookingLine`). */
function pmsWrittenTenders(property: Property): Tender[] {
  return property === "hfville"
    ? ["cash", "web", "deposit_applied", "transfer_kbank", "credit_kbank"]
    : ["cash", "web", "deposit_applied", "transfer_kbank"];
}

/** One field where a fresh PMS candidate now disagrees with the CURRENTLY
 * STORED booking-line value (Wave D, D5's re-pull diff flow) — the diff is
 * against the current stored value, not the original import, so a
 * hand-edited row shows as "changed" too (flagged separately via
 * `handEdited` on the caller's `PmsBookingLineChange`, never suppressed —
 * "a human always decides" is the named tradeoff here). */
export interface BookingLineFieldDiff {
  field: string;
  before: string | number | null;
  after: string | number | null;
}

/**
 * Compares a fresh `PrefillCandidate` against an EXISTING `BookingLine`,
 * fields the PMS actually writes ONLY:
 * `bookingNo`/`guestName`/`roomNo`/`roomCount`/`nights`/`grossRoomSatang`/
 * `grossOtherSatang`, plus the tenders `candidateTenderPatch` places
 * (`cash`/`web`/`deposit_applied`/`transfer_kbank`, `credit_kbank` on
 * hfville only). Deliberately NEVER `remark` (hand-keyed context an office
 * worker may have added, not something the PMS reconciles), NEVER
 * `credit_icbc`/`transfer_icbc`/`other`/`deposit` (hand-keyed by design —
 * the PMS importer never writes these). PURE — no I/O, fixture-testable.
 */
export function diffCandidateAgainstBookingLine(
  property: Property,
  candidate: PrefillCandidate,
  existing: BookingLine,
): BookingLineFieldDiff[] {
  const diffs: BookingLineFieldDiff[] = [];
  const compare = (field: string, before: string | number | null, after: string | number | null) => {
    if (before !== after) diffs.push({ field, before, after });
  };

  compare("bookingNo", existing.bookingNo, candidate.bookingNo);
  compare("guestName", existing.guestName, candidate.guestName);
  compare("roomNo", existing.roomNo, candidate.roomNo);
  compare("roomCount", existing.roomCount, candidate.roomCount);
  compare("nights", existing.nights, candidate.nights);
  compare("grossRoomSatang", existing.grossRoomSatang, candidate.grossRoomSatang);
  compare("grossOtherSatang", existing.grossOtherSatang, candidate.grossOtherSatang);

  const patch = candidateTenderPatch(property, candidate);
  for (const tender of pmsWrittenTenders(property)) {
    compare(tender, existing.tenders[tender], patch[tender]);
  }

  return diffs;
}

/** One existing PMS-sourced row a fresh pull found differing from what is
 * currently stored (Wave D, D5, additive on `insertPmsBookingLines`'s
 * return — see `POST .../pull-from-pms`, src/shared/api.md). `handEdited =
 * updatedAt !== createdAt` — a row nobody has touched since the original
 * import has both timestamps identical. */
export interface PmsBookingLineChange {
  id: number;
  pmsRef: string;
  bookingNo: string | null;
  handEdited: boolean;
  fields: BookingLineFieldDiff[];
}

export function insertPmsBookingLines(
  property: Property,
  date: string,
  candidates: PrefillCandidate[],
  actor: string,
): { inserted: number; skipped: number; changed: PmsBookingLineChange[] } {
  let inserted = 0;
  let skipped = 0;
  const changed: PmsBookingLineChange[] = [];

  const tx = db.transaction(() => {
    for (const candidate of candidates) {
      const existingRow = db
        .query<BookingLineRow, [string, string, string]>(
          "SELECT * FROM booking_lines WHERE property = ? AND date = ? AND pms_ref = ?",
        )
        .get(property, date, candidate.pmsRef);
      if (existingRow) {
        skipped += 1;
        const existing = toBookingLine(existingRow);
        const fields = diffCandidateAgainstBookingLine(property, candidate, existing);
        if (fields.length > 0) {
          changed.push({
            id: existing.id,
            pmsRef: candidate.pmsRef,
            bookingNo: candidate.bookingNo,
            // KNOWN LIMITATION (review, deferred — fails safe): this reads
            // as "has ANY write ever touched this row since import", not
            // "was this row hand-edited by a human" — applyPmsCandidateToBookingLine
            // (the accept endpoint) calls updateBookingLine too, so accepting
            // a diff itself bumps updated_at, and every SUBSEQUENT pull's
            // `changed` detection then reports handEdited: true forever
            // after, even on a row nobody has ever hand-typed into. This
            // fails safe (worst case: an unnecessary "เคยแก้ไขด้วยมือ" chip on
            // a PMS-only row, never the reverse — a genuine hand edit is
            // never reported as false), so it ships as-is. Future fix: a
            // dedicated column (e.g. a `pms_baseline` snapshot, or a
            // separate `hand_edited_at` stamp set ONLY by the manual PATCH
            // path, never by applyPmsCandidateToBookingLine) would
            // distinguish "PMS touched this" from "a human touched this".
            handEdited: existing.updatedAt !== existing.createdAt,
            fields,
          });
        }
        continue;
      }

      const remark =
        candidate.appliedDepositBookingNos.length > 0
          ? `ตัดยอดมัดจำ: ${candidate.appliedDepositBookingNos.join(", ")}`
          : null;

      createBookingLine(
        property,
        date,
        {
          bookingNo: candidate.bookingNo,
          guestName: candidate.guestName,
          roomNo: candidate.roomNo,
          roomCount: candidate.roomCount,
          nights: candidate.nights,
          grossRoomSatang: candidate.grossRoomSatang,
          grossOtherSatang: candidate.grossOtherSatang,
          tenders: candidateTenderPatch(property, candidate),
          remark,
          source: "pms",
          draft: false,
          pmsRef: candidate.pmsRef,
        },
        actor,
      );
      inserted += 1;
    }
  });
  tx();

  return { inserted, skipped, changed };
}

/** Returns a PMS-sourced booking line's own `pms_ref` — deliberately NOT
 * exposed on the public `BookingLine` DTO (it's purely an idempotence/
 * lookup key, see `idx_booking_lines_pms_ref`), but `POST
 * .../bookings/:id/accept-pms-update` (Wave D, D5) needs it to re-locate
 * the row's still-live PMS candidate in a fresh `fetchDayPayments()` pull.
 * `null` for a manual/import row, or an id that doesn't exist for this
 * property. */
export function getBookingLinePmsRef(property: Property, id: number): string | null {
  const row = db
    .query<{ pms_ref: string | null }, [number, string]>(
      "SELECT pms_ref FROM booking_lines WHERE id = ? AND property = ?",
    )
    .get(id, property);
  return row?.pms_ref ?? null;
}

/**
 * Applies a freshly re-fetched `PrefillCandidate` onto an EXISTING
 * booking-line row (Wave D, D5's re-pull "accept" flow — `POST
 * .../bookings/:id/accept-pms-update`). Merges `candidateTenderPatch`'s
 * fields into the row's CURRENT tenders — never a wholesale tender
 * replacement — so hand-keyed `credit_icbc`/`transfer_icbc`/`other`/
 * `deposit` survive untouched exactly like `diffCandidateAgainstBookingLine`
 * never diffs them. Deliberately never touches `remark` either (same
 * "hand-keyed context" reasoning — not one of the PMS-written fields).
 * Reuses `updateBookingLine()` — the write path, audit stamping, and
 * `booking_lines` shape stay in exactly one place. `null` if `id` doesn't
 * belong to `property`.
 */
export function applyPmsCandidateToBookingLine(
  property: Property,
  id: number,
  candidate: PrefillCandidate,
  by: string,
): BookingLine | null {
  const existing = getBookingLineById(property, id);
  if (!existing) return null;

  const patch = candidateTenderPatch(property, candidate);
  const mergedTenders: Record<Tender, number> = { ...existing.tenders };
  for (const tender of pmsWrittenTenders(property)) mergedTenders[tender] = patch[tender];

  return updateBookingLine(
    property,
    id,
    {
      bookingNo: candidate.bookingNo,
      guestName: candidate.guestName,
      roomNo: candidate.roomNo,
      roomCount: candidate.roomCount,
      nights: candidate.nights,
      grossRoomSatang: candidate.grossRoomSatang,
      grossOtherSatang: candidate.grossOtherSatang,
      tenders: mergedTenders,
    },
    by,
  );
}

/**
 * Inserts one `deposit_events` row per `DepositCandidate` for `POST
 * .../pull-from-pms` (see src/server/pms-prefill.ts). ONE transaction,
 * insert-only and idempotent — mirrors `insertPmsBookingLines()` exactly,
 * except the dedup key is `(property, date, pms_ref, tender)` (one PMS
 * payment can split across tenders — see `idx_deposit_events_pms_ref`),
 * never updating a row that already exists (hand-entered notes on a
 * manually-created event, or a hand edit to an already-imported one, are
 * sacred just like booking-line hand edits are).
 */
export function insertPmsDepositEvents(
  property: Property,
  date: string,
  candidates: DepositCandidate[],
  actor: string,
): { inserted: number; skipped: number } {
  let inserted = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const candidate of candidates) {
      const existing = db
        .query<{ n: number }, [string, string, string, string]>(
          "SELECT 1 AS n FROM deposit_events WHERE property = ? AND date = ? AND pms_ref = ? AND tender = ?",
        )
        .get(property, date, candidate.pmsRef, candidate.tender);
      if (existing) {
        skipped += 1;
        continue;
      }

      createDepositEvent(
        property,
        date,
        {
          kind: candidate.kind,
          bookingNo: candidate.bookingNo,
          guestName: candidate.guestName,
          tender: candidate.tender,
          amountSatang: candidate.amountSatang,
          note: candidate.note,
          source: "pms",
          pmsRef: candidate.pmsRef,
        },
        actor,
      );
      inserted += 1;
    }
  });
  tx();

  return { inserted, skipped };
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

// ── deposit_events (Wave C, docs/adr/0001) ──────────────────────────────
// Hand-entry CRUD mirroring other_income_items above — same shape, same
// month-close/audit conventions applied by the CALLER (server.ts, per
// api.md's other-income endpoints), not enforced in this layer.

interface DepositEventRow {
  id: number;
  property: string;
  date: string;
  kind: string;
  booking_no: string | null;
  guest_name: string | null;
  tender: string;
  amount_satang: number;
  note: string | null;
  source: string;
  pms_ref: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

function toDepositEvent(r: DepositEventRow): DepositEvent {
  return {
    id: r.id,
    property: r.property as Property,
    date: r.date,
    kind: r.kind as DepositEventKind,
    bookingNo: r.booking_no,
    guestName: r.guest_name,
    tender: r.tender as DepositTender,
    amountSatang: r.amount_satang,
    note: r.note,
    source: r.source as DepositEvent["source"],
    pmsRef: r.pms_ref,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function getDepositEventsForDay(property: Property, date: string): DepositEvent[] {
  return db
    .query<DepositEventRow, [string, string]>(
      "SELECT * FROM deposit_events WHERE property = ? AND date = ? ORDER BY id ASC",
    )
    .all(property, date)
    .map(toDepositEvent);
}

export function getDepositEventById(property: Property, id: number): DepositEvent | null {
  const row = db
    .query<DepositEventRow, [number, string]>("SELECT * FROM deposit_events WHERE id = ? AND property = ?")
    .get(id, property);
  return row ? toDepositEvent(row) : null;
}

/** The editable DepositEvent fields — everything except id/property/date
 * and the audit quartet, per the shape of BookingLineInput/other-income
 * patch types elsewhere in this file. */
export interface DepositEventInput {
  kind?: DepositEventKind;
  bookingNo?: string | null;
  guestName?: string | null;
  tender?: DepositTender;
  amountSatang?: number;
  note?: string | null;
  source?: DepositEvent["source"];
  pmsRef?: string | null;
}

export function createDepositEvent(
  property: Property,
  date: string,
  input: DepositEventInput,
  by: string,
): DepositEvent {
  const info = db
    .prepare(
      `INSERT INTO deposit_events (
         property, date, kind, booking_no, guest_name, tender, amount_satang, note, source, pms_ref, created_by, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      property,
      date,
      input.kind ?? "received",
      input.bookingNo ?? null,
      input.guestName ?? null,
      input.tender ?? "cash",
      input.amountSatang ?? 0,
      input.note ?? null,
      input.source ?? "manual",
      input.pmsRef ?? null,
      by,
      by,
    );
  return getDepositEventById(property, Number(info.lastInsertRowid))!;
}

export function updateDepositEvent(
  property: Property,
  id: number,
  patch: DepositEventInput,
  by: string,
): DepositEvent | null {
  const existing = getDepositEventById(property, id);
  if (!existing) return null;

  const sets: string[] = ["updated_at = datetime('now')", "updated_by = ?"];
  const params: Array<string | number | null> = [by];
  const set = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.kind !== undefined) set("kind", patch.kind);
  if (patch.bookingNo !== undefined) set("booking_no", patch.bookingNo);
  if (patch.guestName !== undefined) set("guest_name", patch.guestName);
  if (patch.tender !== undefined) set("tender", patch.tender);
  if (patch.amountSatang !== undefined) set("amount_satang", patch.amountSatang);
  if (patch.note !== undefined) set("note", patch.note);
  if (patch.source !== undefined) set("source", patch.source);
  if (patch.pmsRef !== undefined) set("pms_ref", patch.pmsRef);

  db.prepare(`UPDATE deposit_events SET ${sets.join(", ")} WHERE id = ? AND property = ?`).run(
    ...params,
    id,
    property,
  );
  return getDepositEventById(property, id);
}

export function deleteDepositEvent(property: Property, id: number): boolean {
  const info = db.prepare("DELETE FROM deposit_events WHERE id = ? AND property = ?").run(id, property);
  return info.changes > 0;
}

// ── deposit_notes (Wave D, the office deposit register) ────────────────
// ONE note thread per (property, r_number) — see the `deposit_notes` DDL
// comment above and `DepositNote` (shared/types.ts) for the full
// reasoning. Deliberately NOT month-close gated at this layer (server.ts's
// route handlers never call closedMonthResponse for these) — a note is
// commentary against a PMS-sourced R-number, not a booking-day write, and
// an R-number's deposit can span months anyway.

interface DepositNoteRow {
  property: string;
  r_number: string;
  note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  updated_at: string;
  updated_by: string;
}

function toDepositNote(r: DepositNoteRow): DepositNote {
  return {
    property: r.property as Property,
    rNumber: r.r_number,
    note: r.note,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function getDepositNote(property: Property, rNumber: string): DepositNote | null {
  const row = db
    .query<DepositNoteRow, [string, string]>("SELECT * FROM deposit_notes WHERE property = ? AND r_number = ?")
    .get(property, rNumber);
  return row ? toDepositNote(row) : null;
}

/** Every note thread for a property — the register endpoint fetches this
 * ONCE per request and merges by `rNumber` onto the aging/exceptions rows,
 * rather than querying per-row. */
export function listDepositNotes(property: Property): DepositNote[] {
  return db
    .query<DepositNoteRow, [string]>("SELECT * FROM deposit_notes WHERE property = ?")
    .all(property)
    .map(toDepositNote);
}

/**
 * Upserts a note thread's text AND resolved state together (see `PUT
 * .../deposits/:rNumber/note`, src/shared/api.md) — mirrors
 * `setDayVerified()`'s resolved/verified-flag SQL shape exactly:
 * `resolved: true` stamps `resolved_at`/`resolved_by`; `resolved: false`
 * clears both back to NULL (never a stale timestamp from a PAST
 * resolution surviving a re-open).
 */
export function upsertDepositNote(
  property: Property,
  rNumber: string,
  note: string | null,
  resolved: boolean,
  by: string,
): DepositNote {
  const resolvedAtExpr = resolved ? "datetime('now')" : "NULL";
  db.prepare(
    `INSERT INTO deposit_notes (property, r_number, note, resolved_at, resolved_by, updated_at, updated_by)
     VALUES (?, ?, ?, ${resolvedAtExpr}, ?, datetime('now'), ?)
     ON CONFLICT (property, r_number) DO UPDATE SET
       note = excluded.note,
       resolved_at = ${resolvedAtExpr},
       resolved_by = excluded.resolved_by,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(property, rNumber, note, resolved ? by : null, by);
  return getDepositNote(property, rNumber)!;
}

export function deleteDepositNote(property: Property, rNumber: string): boolean {
  const info = db.prepare("DELETE FROM deposit_notes WHERE property = ? AND r_number = ?").run(property, rNumber);
  return info.changes > 0;
}

// ── payment_audits (Wave 1, the office audit hub — docs/plan-audit-hub-
// slips.md) ─────────────────────────────────────────────────────────────
// See the `payment_audits` DDL comment above and `PaymentAudit`
// (shared/types.ts) for the full reasoning: PK is (property, audit_key)
// only, absence = pending, un-tick DELETEs the row rather than storing a
// "false". Deliberately NOT month-close gated at this layer (server.ts's
// route handlers never call closedMonthResponse for these) — same
// "commentary, not a booking-day write" reasoning as deposit_notes.

interface PaymentAuditRow {
  property: string;
  audit_key: string;
  date: string;
  checked_at: string;
  checked_by: string;
}

function toPaymentAudit(r: PaymentAuditRow): PaymentAudit {
  return {
    property: r.property as Property,
    auditKey: r.audit_key,
    date: r.date,
    checkedAt: r.checked_at,
    checkedBy: r.checked_by,
  };
}

/** A single audit row by its key — module-internal (used by
 * `upsertPaymentAudit`'s own read-back and nowhere else); external callers
 * always go through `listPaymentAudits`, which covers both the day-scoped
 * and property-wide shapes below. */
function getPaymentAudit(property: Property, auditKey: string): PaymentAudit | null {
  const row = db
    .query<PaymentAuditRow, [string, string]>("SELECT * FROM payment_audits WHERE property = ? AND audit_key = ?")
    .get(property, auditKey);
  return row ? toPaymentAudit(row) : null;
}

/**
 * Every audit row for a property — scoped to one audited `date` when given
 * (the day-audit endpoint's own queue, matching the task's
 * `listPaymentAudits(property, date)` signature), or every row regardless of
 * date when `date` is omitted. The latter is what the day-audit endpoint
 * ALSO needs for a เช็คอิน row's `depositApplied.receivedChecked` — the
 * paired receipt's own audit status may have been ticked on a DIFFERENT day
 * than the one currently being audited (a มัดจำ received last month, applied
 * today), so that lookup can never be scoped to the CURRENT day's `date`
 * alone.
 */
export function listPaymentAudits(property: Property, date?: string): PaymentAudit[] {
  if (date !== undefined) {
    return db
      .query<PaymentAuditRow, [string, string]>("SELECT * FROM payment_audits WHERE property = ? AND date = ?")
      .all(property, date)
      .map(toPaymentAudit);
  }
  return db
    .query<PaymentAuditRow, [string]>("SELECT * FROM payment_audits WHERE property = ?")
    .all(property)
    .map(toPaymentAudit);
}

/**
 * Ticks (or re-ticks) a settlement as audited — `date` is the audited day
 * the tick was made from, not part of the row's identity (PK is
 * `(property, audit_key)` alone). Re-ticking the SAME audit_key (e.g. from a
 * different day's queue view, or simply pressed twice) overwrites `date`/
 * `checked_at`/`checked_by` with the latest tick — last write wins, same
 * convention `upsertDepositNote` uses for its own resolved-state overwrite.
 */
export function upsertPaymentAudit(property: Property, auditKey: string, date: string, by: string): PaymentAudit {
  db.prepare(
    `INSERT INTO payment_audits (property, audit_key, date, checked_at, checked_by)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT (property, audit_key) DO UPDATE SET
       date = excluded.date,
       checked_at = excluded.checked_at,
       checked_by = excluded.checked_by`,
  ).run(property, auditKey, date, by);
  return getPaymentAudit(property, auditKey)!;
}

/** Un-ticks a settlement — a plain DELETE (never a stored "false"), so
 * un-ticking something never audited at all is a harmless no-op (mirrors
 * `deleteDepositNote`'s own idempotent DELETE). */
export function deletePaymentAudit(property: Property, auditKey: string): boolean {
  const info = db.prepare("DELETE FROM payment_audits WHERE property = ? AND audit_key = ?").run(property, auditKey);
  return info.changes > 0;
}

// ── moving a day between properties ────────────────────────────────────

/**
 * Moves ONE day's `booking_lines`, `other_income_items`, AND
 * `deposit_events` (Wave C, Opus money-review F2, 2026-07-31 — a moved
 * day's deposit_events used to stay stranded on the origin property, so a
 * cash มัดจำล่วงหน้า kept reaching the WRONG side's ยอดฝากจริง forever) from
 * `from` to `to` — see src/shared/api.md `POST .../day/:date/move`.
 * Deliberately narrow scope beyond those three tables: `sheet_days` (income
 * cells, expenses, the day note, the cash-block override) is never touched
 * or re-keyed here — a merge of two single-valued cash-block overrides
 * would be meaningless, and the day sheet is a separate page's territory.
 * All three tables merge cleanly into whatever the destination day already
 * holds; this never refuses on a non-empty destination.
 *
 * `booking_lines.seq` is a dense per-(property,date) row order the printed
 * day sheet renders as the line number, but it is only a plain index, not
 * unique — merging two days' rows verbatim would produce duplicate seq
 * values and silently corrupt that numbering. So every moved row is
 * renumbered starting at the destination day's current `MAX(seq) + 1`,
 * walked in the moved rows' existing seq order (ties broken by `id`, their
 * insertion order) so their relative order survives the merge.
 * `other_income_items`/`deposit_events` carry no `seq` (or category) — both
 * merge with a plain re-key, no renumbering needed.
 *
 * Runs as a single transaction: if the destination day already holds a
 * booking line OR a deposit event sharing a `(property, date, pms_ref, ...)`
 * with a moved row (the partial unique indexes — nothing writes `pms_ref`
 * from the UI today, but a future importer might), the UPDATE throws, the
 * transaction rolls back, and NOTHING is moved — callers must not partially
 * apply this. `touchSheetDay()` bumps `updated_at`/`updated_by` on BOTH
 * property-days' `sheet_days` row (creating it if the day has no row yet)
 * so the move itself is visible in each day's own audit trail even though
 * its content is untouched.
 */
export function moveBookingDay(
  from: Property,
  to: Property,
  date: string,
  actor: string,
): { bookingLines: number; otherIncome: number; depositEvents: number } {
  const tx = db.transaction(() => {
    const destMax = db
      .query<{ n: number }, [string, string]>(
        "SELECT COALESCE(MAX(seq), 0) AS n FROM booking_lines WHERE property = ? AND date = ?",
      )
      .get(to, date);
    let nextSeq = (destMax?.n ?? 0) + 1;

    const movingLines = db
      .query<{ id: number }, [string, string]>(
        "SELECT id FROM booking_lines WHERE property = ? AND date = ? ORDER BY seq ASC, id ASC",
      )
      .all(from, date);

    const moveLine = db.prepare(
      `UPDATE booking_lines SET property = ?, seq = ?, updated_at = datetime('now'), updated_by = ?
       WHERE id = ?`,
    );
    for (const line of movingLines) {
      moveLine.run(to, nextSeq, actor, line.id);
      nextSeq += 1;
    }

    const otherIncomeInfo = db
      .prepare(
        `UPDATE other_income_items SET property = ?, updated_at = datetime('now'), updated_by = ?
         WHERE property = ? AND date = ?`,
      )
      .run(to, actor, from, date);

    const depositEventsInfo = db
      .prepare(
        `UPDATE deposit_events SET property = ?, updated_at = datetime('now'), updated_by = ?
         WHERE property = ? AND date = ?`,
      )
      .run(to, actor, from, date);

    touchSheetDay(from, date, actor);
    touchSheetDay(to, date, actor);

    return {
      bookingLines: movingLines.length,
      otherIncome: otherIncomeInfo.changes,
      depositEvents: depositEventsInfo.changes,
    };
  });
  return tx();
}
