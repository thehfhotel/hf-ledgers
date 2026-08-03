// ส่งสลิป's OWN SQLite database — completely separate from the income
// ledger's (src/server/db.ts). This process never imports that file, and
// that file never imports this one: two databases, two containers, two
// volumes (docs/plan-audit-hub-slips.md Wave 2 — "separate process/origin
// is non-negotiable (security)").
//
// Append-only by construction: an `attachments` row is INSERTed exactly
// once and never UPDATEd or DELETEd (the picture file it names is likewise
// immutable — see storage.ts). "Superseding" a version INSERTs a
// `supersede_events` row instead of mutating the attachment row itself —
// current-vs-history is a LEFT JOIN, never an UPDATE. No function anywhere
// under src/slips/ ever imports a file-delete or row-delete primitive —
// storage.test.ts asserts this by scanning every file's own `node:fs`
// import line for a banned name, so this comment is free to name those
// functions in prose without tripping that check.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ENV read at call time inside slipsDataDir()/callers, matching the rest of
// this codebase's "never capture env at import time" rule (pms-prefill.ts's
// module comment) — except the DB path itself, which (like src/server/db.ts)
// necessarily IS read once at import time to open the database. Tests set
// SLIPS_DB_PATH before importing this module (same pattern server.test.ts
// already established for DB_PATH).
const DB_PATH = process.env.SLIPS_DB_PATH ?? `${process.env.SLIPS_DATA_DIR ?? "./slips-data"}/slips.db`;

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/** Idempotent DDL — safe to call on every boot, mirrors src/server/db.ts's
 * migrate(). */
export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL CHECK (property IN ('hf', 'hfville')),
      audit_key TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      audit_date TEXT NOT NULL,
      file_path TEXT NOT NULL,
      thumb_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      format TEXT NOT NULL,
      engine TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL,
      UNIQUE (property, audit_key, version)
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_key ON attachments (property, audit_key);

    -- Append-only: every row here is an INSERT, never an UPDATE/DELETE. A
    -- row present means the named (property, audit_key, version) is
    -- superseded; "current" = every attachment row with NO matching row
    -- here (storage.ts's LEFT JOIN). Superseding a version with no fresh
    -- attach following it is how "ลบ" (remove) is expressed — there is no
    -- file-delete code path anywhere in this app.
    CREATE TABLE IF NOT EXISTS supersede_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL,
      audit_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      by TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (property, audit_key, version)
    );
  `);
}

migrate();
