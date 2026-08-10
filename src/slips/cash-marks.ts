// ยืนยันชำระเงินสด — reception's reversible "this was actually paid in CASH,
// no bank slip exists" resolution for a queue row that would otherwise sit
// in ส่งสลิป's pending queue forever (docs/plan-audit-hub-slips.md; added
// 2026-08-10). Append-only by construction (db.ts's `cash_mark_events`,
// same event-log philosophy as `supersede_events` — see storage.ts's own
// module doc comment): marking/unmarking INSERTs a new event, current state
// is always "what does the LATEST event (highest id) say", and every toggle
// survives forever as its own row.
//
// This module imports ONLY ./db.ts and shared types — no node:fs, no
// storage.ts, no image handling. storage.test.ts's own file-delete-primitive
// scan walks every src/slips source file, this one included, so it stays
// clean of that class of bug for free; there is nothing here to write a
// file for in the first place.
//
// Idempotence is STRICTER than supersede()/restore() in storage.ts: those
// two always write a fresh event even when the caller repeats an already-
// current action (a restored-then-resuperseded version needs each toggle to
// be its own timestamped/attributed row for the ประวัติ drawer). A cash
// mark has no such per-toggle history UI — the locked contract only needs
// "is it marked, since when, by whom" — so a redundant mark/unmark call
// intentionally inserts NOTHING and returns/no-ops on the EXISTING state.
// The mark->unmark->mark sequence still produces three real rows (proven in
// cash-marks.test.ts) — only a REPEATED call in the same direction collapses
// to a no-op.

import { db } from "./db.ts";
import type { Property } from "../shared/types.ts";

export interface CashMark {
  at: string;
  by: string;
}

interface CashMarkEventRow {
  action: "mark" | "unmark";
  by: string;
  at: string;
}

/** The single latest event (highest id) for one (property, audit_key), or
 * `null` when this settlement has never been touched. PRIVATE — every
 * exported function below goes through this, so "current state" has exactly
 * one derivation in the whole module. */
function latestEvent(property: Property, auditKey: string): CashMarkEventRow | null {
  return db
    .query<
      CashMarkEventRow,
      [string, string]
    >(`SELECT action, by, at FROM cash_mark_events WHERE property = ? AND audit_key = ? ORDER BY id DESC LIMIT 1`)
    .get(property, auditKey);
}

/**
 * Marks a settlement as paid in cash. Idempotent: if the LATEST event is
 * already `'mark'`, this inserts NOTHING and returns that existing event's
 * `at`/`by` unchanged (a second reception worker tapping the same button
 * twice must never overwrite the first worker's attribution). `auditDate` is
 * the audited day the mark was made FROM (mirrors `attach`'s own `date`
 * body field / `payment_audits.date` — informational provenance, never part
 * of the row's identity, which is `(property, audit_key)` alone via the
 * latest-event query above).
 */
export function markCash(property: Property, auditKey: string, auditDate: string, by: string): CashMark {
  const latest = latestEvent(property, auditKey);
  if (latest && latest.action === "mark") return { at: latest.at, by: latest.by }; // already marked — no-op, first mark stands

  db.prepare(`INSERT INTO cash_mark_events (property, audit_key, audit_date, action, by) VALUES (?, ?, ?, 'mark', ?)`).run(
    property,
    auditKey,
    auditDate,
    by,
  );
  const fresh = latestEvent(property, auditKey)!; // the row just inserted
  return { at: fresh.at, by: fresh.by };
}

/**
 * Un-marks a settlement — reverses `markCash`, putting it back into ส่งสลิป's
 * pending queue. Idempotent: if the settlement is already unmarked (latest
 * event is `'unmark'`, or it was never marked at all), this inserts NOTHING.
 * Same `auditDate` provenance role as `markCash`.
 */
export function unmarkCash(property: Property, auditKey: string, auditDate: string, by: string): void {
  const latest = latestEvent(property, auditKey);
  if (!latest || latest.action === "unmark") return; // already unmarked (or never marked) — no-op

  db.prepare(`INSERT INTO cash_mark_events (property, audit_key, audit_date, action, by) VALUES (?, ?, ?, 'unmark', ?)`).run(
    property,
    auditKey,
    auditDate,
    by,
  );
}

/**
 * Batch form of the current-state lookup — one query for every auditKey the
 * caller asks about, never N+1 (same discipline storage.ts's `summarize`/
 * `listCurrentBatch` document for their own batch functions). UNLIKE those
 * two, a requested key that has never been marked (or is currently
 * unmarked) is simply ABSENT from the returned map, never pre-seeded with a
 * zero-ish placeholder — the locked contract for this function is "absent
 * key = unmarked", so callers check `.get(key) ?? null` (queue.ts) or `??
 * null` on each field (internal.ts), never an existence check first for a
 * marked key.
 */
export function cashMarkStates(property: Property, keys: readonly string[]): Map<string, CashMark> {
  const out = new Map<string, CashMark>();
  if (keys.length === 0) return out;

  const placeholders = keys.map(() => "?").join(", ");
  const rows = db
    .query<
      { audit_key: string; action: "mark" | "unmark"; by: string; at: string },
      string[]
    >(`
      SELECT audit_key, action, by, at FROM (
        SELECT audit_key, action, by, at,
               ROW_NUMBER() OVER (PARTITION BY audit_key ORDER BY id DESC) AS rn
        FROM cash_mark_events
        WHERE property = ? AND audit_key IN (${placeholders})
      )
      WHERE rn = 1
    `)
    .all(property, ...keys);

  for (const row of rows) {
    if (row.action === "mark") out.set(row.audit_key, { at: row.at, by: row.by });
  }
  return out;
}
