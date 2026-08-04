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

    -- Append-only EVENT LOG: every take-out ("action = 'supersede'", เปลี่ยน/
    -- ลบ/นำออก) or restore ("action = 'restore'", กู้คืน) is its OWN INSERTed
    -- row, never an UPDATE to a prior one — restore's own binding rule is
    -- "writes a new record un-superseding, never mutating history"
    -- (docs/plan-audit-hub-slips.md's storage rules extend to this: a
    -- version can be taken out, restored, and taken out again, and every
    -- one of those toggles must survive as its own permanent row). Current
    -- vs. history is therefore no longer "does a matching row exist" — it's
    -- "what is the LATEST event (highest id) for this (property, audit_key,
    -- version)": no rows or a latest action='restore' means current, a
    -- latest action='supersede' means superseded (storage.ts's
    -- ATTACHMENT_SELECT computes this with a window function). No UNIQUE
    -- index on (property, audit_key, version) here —
    -- that constraint belonged to the pre-restore, at-most-one-supersede-
    -- ever shape; see migrateSupersedeEventsToActionLog for the one-time,
    -- data-preserving rebuild of a database still carrying that old shape.
    CREATE TABLE IF NOT EXISTS supersede_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL,
      audit_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      action TEXT NOT NULL DEFAULT 'supersede' CHECK (action IN ('supersede', 'restore')),
      by TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_supersede_events_version ON supersede_events (property, audit_key, version);
  `);

  migrateSupersedeEventsToActionLog();
}

/**
 * One-time, idempotent rebuild of a database whose `supersede_events` table
 * still has the OLD shape (no `action` column — the pre-restore design that
 * recorded at most one row ever per (property, audit_key, version), via a
 * UNIQUE index). Detected by `PRAGMA table_info` rather than a version
 * counter, matching this codebase's existing `addColumnIfMissing`-style
 * convention (src/server/db.ts). A brand-new database never reaches the
 * rebuild branch — `migrate()`'s own `CREATE TABLE IF NOT EXISTS` above
 * already creates the new (action-column, no-UNIQUE) shape directly, so
 * `columns.some(action column present)` is already true.
 *
 * The rebuild itself (rename -> recreate -> copy -> drop) is a schema
 * change, NOT a data deletion: every existing supersede_events row survives,
 * translated 1:1 into an `action: 'supersede'` event (exactly what it always
 * meant under the old shape — the old table only ever recorded take-outs).
 */
function migrateSupersedeEventsToActionLog(): void {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(supersede_events)`).all();
  if (columns.some((c) => c.name === "action")) return; // fresh DB, or already migrated

  db.exec(`
    ALTER TABLE supersede_events RENAME TO supersede_events_pre_restore;
    CREATE TABLE supersede_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property TEXT NOT NULL,
      audit_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      action TEXT NOT NULL DEFAULT 'supersede' CHECK (action IN ('supersede', 'restore')),
      by TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO supersede_events (property, audit_key, version, action, by, at)
      SELECT property, audit_key, version, 'supersede', by, at FROM supersede_events_pre_restore;
    DROP TABLE supersede_events_pre_restore;
    CREATE INDEX IF NOT EXISTS idx_supersede_events_version ON supersede_events (property, audit_key, version);
  `);
}

migrate();
