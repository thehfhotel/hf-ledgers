import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/ledger.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/**
 * DDL + seed migration. Empty in the Phase 0 scaffold — WP-A (owns
 * src/server/** only) fills in the full schema per the locked contract in
 * src/shared/api.md: `categories`, `income_amounts`, `expense_items`,
 * `sheet_days`, plus the per-property seed (income paper order, expense
 * starters) run only when that property currently has zero categories.
 */
export function migrate(): void {
  // WP-A: CREATE TABLE IF NOT EXISTS ... (see src/shared/api.md "Data model").
}

migrate();
