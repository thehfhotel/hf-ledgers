// The append-only, versioned attachment storage engine (docs/plan-audit-
// hub-slips.md's binding "Storage rules", 2026-08-03):
//
// - No code path deletes or overwrites a picture file. A version's file
//   name embeds its version number AND a content hash, so it is only ever
//   written once (see buildAttachmentPaths). นำออก (per-picture remove, the
//   จัดการสลิป gallery's own × control) writes a supersede EVENT (db.ts's
//   `supersede_events`, an append-only event log — not a single flag)
//   instead of touching the file or the attachment row — see `supersede()`
//   below. กู้คืน (restore, from the ประวัติ drawer) writes a SEPARATE new
//   `restore` event — never mutates the supersede event it's undoing — see
//   `restore()`. A version's current-vs-superseded status is always "what
//   does the LATEST event say", so a version can be taken out and restored
//   any number of times and every toggle still survives forever as its own
//   row (db.ts's own module doc comment has the full reasoning).
// - Per-property layout: <root>/<property>/<yyyy-mm>/<auditKey>/, keyed by
//   the SETTLEMENT'S OWN audited day (not upload day) — `auditDate` is a
//   required input to `createAttachment`, not derived from `Date.now()`, so
//   a slip attached a day late still files under the stay's own month.
//
// This module never imports node:fs's unlink/rm family — only `Bun.write`
// (create) and `node:fs`'s `mkdirSync` (create) appear here. storage.test.ts
// asserts this by scanning the file's own `node:fs` import line.
//
// B2 (Opus security review, 2026-08-03, CONFIRMED EXPLOITABLE over HTTP):
// the raw auditKey used to flow DIRECTLY into the filesystem path
// (attachmentDir -> Bun.write) — a key like `..%2F..%2F..%2FHTTP_PWNED`
// wrote OUTSIDE picturesRoot(), and a crafted key made property "hf" write
// into hfville's own tree. PMS refs are never charset-validated at source
// (pms-prefill.ts's own note on this), so rejecting "/" etc. at the API
// boundary is NOT a safe fix on its own — a legitimate ref could contain
// one. The real fix: the raw key NEVER reaches a filesystem path again,
// full stop — `sanitizeAuditKeyForPath` below derives a safe, collision-
// proof directory component instead, and the raw key lives ONLY in the
// `audit_key` DB column (queried, never interpolated into a path).
// `assertContainedInPicturesRoot` is the second, independent layer: even
// if the sanitizer somehow had a bug, every write is verified to still
// land inside `picturesRoot()` before it happens.

import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { db } from "./db.ts";
import type { Property } from "../shared/types.ts";

export interface AttachmentRecord {
  property: Property;
  auditKey: string;
  version: number;
  auditDate: string;
  filePath: string;
  thumbPath: string;
  contentHash: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  engine: string;
  createdAt: string;
  createdBy: string;
  superseded: boolean;
  supersededAt: string | null;
  supersededBy: string | null;
}

export interface AttachmentSummary {
  /** Current (non-superseded) attachment count. */
  count: number;
  /** `createdAt` of the newest current attachment, `null` when `count` is 0. */
  latestAt: string | null;
  /** The highest CURRENT version number (ties broken by version, not
   * `createdAt` string comparison — same rule `latestCurrent` uses), `null`
   * when `count` is 0. Lets a caller build a thumbnail URL directly off this
   * summary without a second round-trip (e.g. the slips SPA's own queue
   * card) — additive, existing consumers (the ledger's internal status
   * endpoint) simply don't read it. */
  latestVersion: number | null;
  /** How many of this settlement's versions have been superseded — history
   * depth, not a warning signal on its own. */
  superseded: number;
}

/** 16 hex chars of a SHA-256 digest — a filename-uniqueness/cache-busting
 * component, never a security control (a version number already guarantees
 * a file is written at most once — see `createAttachment`). PURE. */
export function contentHashHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** The next version number for a settlement given every version it already
 * has — 1 for a brand-new settlement, otherwise one past the highest
 * existing version. Never reuses a number, even across supersedes (a
 * superseded version's file stays forever at its own path). PURE. */
export function nextVersion(existingVersions: readonly number[]): number {
  return existingVersions.length === 0 ? 1 : Math.max(...existingVersions) + 1;
}

/**
 * Turns a raw, UNTRUSTED auditKey into a filesystem-safe directory
 * component — NEVER the raw key itself (see this file's B2 module-doc
 * comment). Strips to a bounded allowlist (`[A-Za-z0-9._-]`, anything else
 * — `/`, null bytes, whatever — becomes `_`), THEN collapses every `..`
 * sequence too (a lone path segment with no `/` around it can't actually
 * traverse, since `.` is otherwise a harmless allowlisted character, but
 * this makes "the output never contains a traversal-shaped substring" a
 * simple, directly-checkable invariant rather than one that depends on
 * reasoning about how the segment gets joined elsewhere), and appends an
 * 8-hex-char hash of the FULL raw key, so two different raw keys that
 * happen to sanitize to the same allowlisted string can never collide onto
 * the same directory. The raw key itself is never reconstructable from this
 * output and is never needed to be — every lookup goes through SQLite by
 * `(property, audit_key)`, never by re-deriving a path from the key. PURE.
 */
export function sanitizeAuditKeyForPath(auditKey: string): string {
  const cleaned = auditKey
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.\./g, "_")
    .slice(0, 40);
  const hash = createHash("sha256").update(auditKey).digest("hex").slice(0, 8);
  return `${cleaned || "key"}-${hash}`;
}

/** `<property>/<yyyy-mm>/<sanitized auditKey>` — the settlement's own
 * directory, keyed by the AUDITED day's month (`auditDate`), not upload
 * time. `property` and `auditDate` are already safe by construction before
 * this is ever called (`isProperty()`/`isValidIso()` at the API boundary —
 * a fixed 2-value enum and a strict `YYYY-MM-DD` regex, respectively); only
 * `auditKey` ever needed sanitizing (see `sanitizeAuditKeyForPath`). PURE. */
export function attachmentDir(property: Property, auditDate: string, auditKey: string): string {
  const month = auditDate.slice(0, 7);
  return `${property}/${month}/${sanitizeAuditKeyForPath(auditKey)}`;
}

/**
 * Defense-in-depth backstop: asserts `candidatePath` resolves to somewhere
 * INSIDE `picturesRoot()` — should be unreachable given
 * `sanitizeAuditKeyForPath` above, but this is what actually stands between
 * a future bug (a new call site, a sanitizer edge case) and a real
 * filesystem escape, so it is checked immediately before every write.
 * Deliberately never includes the resolved path in its own thrown message
 * — this is an internal invariant, not something a client should ever see
 * any detail of (error-hygiene fix, same 2026-08-03 review).
 */
function assertContainedInPicturesRoot(candidatePath: string): void {
  const root = resolve(picturesRoot()) + sep;
  const resolved = resolve(candidatePath);
  if (!resolved.startsWith(root)) {
    throw new Error("path containment check failed");
  }
}

/** `v<N>-<hash>.<ext>` — the immutable original's file name. PURE. */
export function attachmentFileName(version: number, contentHash: string, ext: string): string {
  return `v${version}-${contentHash}.${ext}`;
}

/** `v<N>-<hash>.thumb.<ext>` — the cached derivative beside the original
 * (a derivative, never a mutation of the original). PURE. */
export function thumbFileName(version: number, contentHash: string, ext: string): string {
  return `v${version}-${contentHash}.thumb.${ext}`;
}

/** Read lazily (call-time), never captured at import time — same rule
 * pms-prefill.ts documents for its own env reads (bun test runs every file
 * in one process; capturing env at import time freezes whichever value was
 * set first). */
function picturesRoot(): string {
  return `${process.env.SLIPS_DATA_DIR ?? "./slips-data"}/pictures`;
}

interface AttachmentRow {
  property: string;
  audit_key: string;
  version: number;
  audit_date: string;
  file_path: string;
  thumb_path: string;
  content_hash: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  engine: string;
  created_at: string;
  created_by: string;
  superseded_at: string | null;
  superseded_by: string | null;
}

// LEFT JOINs the LATEST supersede_events row (highest `id`) for each
// (property, audit_key, version) — current vs. superseded is "what does
// that latest event say" (action = 'supersede' -> superseded, action =
// 'restore' or no event at all -> current), never a stored flag on
// `attachments` itself (which is never UPDATEd — see db.ts's module doc
// comment) and never just "does a row exist" (a restored-then-resuperseded
// version has MULTIPLE rows — see db.ts's own doc comment on why the old
// UNIQUE-per-version shape couldn't represent that). `superseded_at`/
// `superseded_by` come from that latest row ONLY when it's a 'supersede'
// action — a restore's own `at`/`by` never leaks into these columns (a
// restored version reads superseded_at/by NULL, exactly like a version
// that was never touched).
const ATTACHMENT_SELECT = `
  SELECT a.property, a.audit_key, a.version, a.audit_date, a.file_path, a.thumb_path,
         a.content_hash, a.bytes, a.width, a.height, a.format, a.engine,
         a.created_at, a.created_by,
         CASE WHEN s.action = 'supersede' THEN s.at ELSE NULL END AS superseded_at,
         CASE WHEN s.action = 'supersede' THEN s.by ELSE NULL END AS superseded_by
  FROM attachments a
  LEFT JOIN (
    SELECT property, audit_key, version, action, by, at
    FROM (
      SELECT property, audit_key, version, action, by, at,
             ROW_NUMBER() OVER (PARTITION BY property, audit_key, version ORDER BY id DESC) AS rn
      FROM supersede_events
    )
    WHERE rn = 1
  ) s ON s.property = a.property AND s.audit_key = a.audit_key AND s.version = a.version
`;

function toRecord(r: AttachmentRow): AttachmentRecord {
  return {
    property: r.property as Property,
    auditKey: r.audit_key,
    version: r.version,
    auditDate: r.audit_date,
    filePath: r.file_path,
    thumbPath: r.thumb_path,
    contentHash: r.content_hash,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    format: r.format,
    engine: r.engine,
    createdAt: r.created_at,
    createdBy: r.created_by,
    superseded: r.superseded_at !== null,
    supersededAt: r.superseded_at,
    supersededBy: r.superseded_by,
  };
}

export function getAttachment(property: Property, auditKey: string, version: number): AttachmentRecord | null {
  const row = db
    .query<AttachmentRow, [string, string, number]>(`${ATTACHMENT_SELECT} WHERE a.property = ? AND a.audit_key = ? AND a.version = ?`)
    .get(property, auditKey, version);
  return row ? toRecord(row) : null;
}

/** Full version history for a settlement, oldest first, superseded versions
 * included — "full version history stays viewable by the office" (the
 * plan's binding storage rule). */
export function listHistory(property: Property, auditKey: string): AttachmentRecord[] {
  return db
    .query<AttachmentRow, [string, string]>(`${ATTACHMENT_SELECT} WHERE a.property = ? AND a.audit_key = ? ORDER BY a.version ASC`)
    .all(property, auditKey)
    .map(toRecord);
}

/** The "current" (non-superseded) versions only — what the queue/day-audit
 * proof chip shows. */
export function listCurrent(property: Property, auditKey: string): AttachmentRecord[] {
  return listHistory(property, auditKey).filter((a) => !a.superseded);
}

/** Batch form of `listCurrent` — one query for every auditKey the caller
 * asks about, never N+1 (same discipline `summarize` below already
 * documents). Powers the จัดการสลิป gallery: each payment card needs the
 * FULL list of its current pictures (not just a count), to render one
 * thumbnail per picture. Every requested key is present in the returned
 * map (an empty array when the settlement has no current attachment), so a
 * caller never needs an existence check first. Oldest-first per key (same
 * order `listHistory` returns), mirroring `ATTACHMENT_SELECT`'s ordering. */
export function listCurrentBatch(property: Property, auditKeys: readonly string[]): Map<string, AttachmentRecord[]> {
  const out = new Map<string, AttachmentRecord[]>();
  for (const key of auditKeys) out.set(key, []);
  if (auditKeys.length === 0) return out;

  const placeholders = auditKeys.map(() => "?").join(", ");
  const rows = db
    .query<AttachmentRow, string[]>(`${ATTACHMENT_SELECT} WHERE a.property = ? AND a.audit_key IN (${placeholders}) ORDER BY a.version ASC`)
    .all(property, ...auditKeys)
    .map(toRecord);

  for (const row of rows) {
    if (row.superseded) continue;
    out.get(row.auditKey)?.push(row);
  }
  return out;
}

/** Batch summary for the internal status endpoint (server-to-server, the
 * ledger's day-audit enrichment) — one query for every auditKey the caller
 * asks about, never N+1. Every requested key is present in the returned map
 * (zero-valued when the settlement has no attachment at all), so a caller
 * never needs an existence check before reading. */
export function summarize(property: Property, auditKeys: readonly string[]): Map<string, AttachmentSummary> {
  const out = new Map<string, AttachmentSummary>();
  for (const key of auditKeys) out.set(key, { count: 0, latestAt: null, latestVersion: null, superseded: 0 });
  if (auditKeys.length === 0) return out;

  const placeholders = auditKeys.map(() => "?").join(", ");
  const rows = db
    .query<AttachmentRow, string[]>(`${ATTACHMENT_SELECT} WHERE a.property = ? AND a.audit_key IN (${placeholders})`)
    .all(property, ...auditKeys)
    .map(toRecord);

  for (const row of rows) {
    const summary = out.get(row.auditKey);
    if (!summary) continue; // defensive — every key was pre-seeded above
    if (row.superseded) {
      summary.superseded += 1;
    } else {
      summary.count += 1;
      if (summary.latestVersion === null || row.version > summary.latestVersion) {
        summary.latestVersion = row.version;
        summary.latestAt = row.createdAt;
      }
    }
  }
  return out;
}

/** The latest CURRENT (non-superseded) version, or `null` when the
 * settlement has none — used by the internal thumbnail endpoint. Ties
 * broken by the higher version number (never by `createdAt` string
 * comparison alone, which is only second-resolution). */
export function latestCurrent(property: Property, auditKey: string): AttachmentRecord | null {
  const current = listCurrent(property, auditKey);
  if (current.length === 0) return null;
  return current.reduce((a, b) => (b.version > a.version ? b : a));
}

export interface CreateAttachmentInput {
  property: Property;
  auditKey: string;
  /** The settlement's own audited day (YYYY-MM-DD) — determines the
   * month bucket, never the upload timestamp. */
  auditDate: string;
  by: string;
  buffer: Uint8Array;
  thumbBuffer: Uint8Array;
  width: number;
  height: number;
  format: string;
  engine: string;
}

/**
 * Writes a brand-new immutable version: computes the next version number
 * and content hash, writes both files (Bun.write creates any missing parent
 * directories itself — no separate mkdir step needed here), then INSERTs
 * the attachment row. The version number + content-hash file name means
 * this can never overwrite an existing file — `nextVersion` only issues a
 * version once, and a re-upload of byte-identical content still gets its
 * own fresh version number and its own file.
 */
export async function createAttachment(input: CreateAttachmentInput): Promise<AttachmentRecord> {
  const existingVersions = db
    .query<{ version: number }, [string, string]>("SELECT version FROM attachments WHERE property = ? AND audit_key = ?")
    .all(input.property, input.auditKey)
    .map((r) => r.version);
  const version = nextVersion(existingVersions);
  const contentHash = contentHashHex(input.buffer);
  const ext = input.format === "png" ? "png" : "jpg";
  const dir = attachmentDir(input.property, input.auditDate, input.auditKey);
  const filePath = `${picturesRoot()}/${dir}/${attachmentFileName(version, contentHash, ext)}`;
  const thumbPath = `${picturesRoot()}/${dir}/${thumbFileName(version, contentHash, ext)}`;

  // Defense-in-depth (B2): verified BEFORE either write, not after.
  assertContainedInPicturesRoot(filePath);
  assertContainedInPicturesRoot(thumbPath);

  await Bun.write(filePath, input.buffer);
  await Bun.write(thumbPath, input.thumbBuffer);

  db.prepare(
    `INSERT INTO attachments
       (property, audit_key, version, audit_date, file_path, thumb_path, content_hash, bytes, width, height, format, engine, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.property,
    input.auditKey,
    version,
    input.auditDate,
    filePath,
    thumbPath,
    contentHash,
    input.buffer.byteLength,
    input.width,
    input.height,
    input.format,
    input.engine,
    input.by,
  );

  return getAttachment(input.property, input.auditKey, version)!;
}

/**
 * นำออก (the จัดการสลิป gallery's per-picture ×; formerly เปลี่ยน/ลบ): writes a
 * `'supersede'` event for one version — never touches the file, never
 * touches the attachment row, never mutates a prior event. `null` when the
 * version doesn't exist at all (caller 404s). Re-superseding an
 * already-superseded version is a harmless, APPLICATION-level no-op (checked
 * here via `existing.superseded`, not a DB unique index — see db.ts's own
 * doc comment on why the event log dropped that index): the FIRST supersede
 * event stays the one that's "in effect" (same idempotence convention as
 * `payment_audits`'s un-tick in the ledger), and nothing new is written.
 */
export function supersede(property: Property, auditKey: string, version: number, by: string): AttachmentRecord | null {
  const existing = getAttachment(property, auditKey, version);
  if (!existing) return null;
  if (existing.superseded) return existing; // already superseded — no-op, first event stands
  db.prepare(`INSERT INTO supersede_events (property, audit_key, version, action, by) VALUES (?, ?, ?, 'supersede', ?)`).run(
    property,
    auditKey,
    version,
    by,
  );
  return getAttachment(property, auditKey, version);
}

/**
 * กู้คืน (the ประวัติ drawer's restore action): writes a `'restore'` event for
 * one version — the binding rule (owner-approved จัดการสลิป design) is that
 * this is a NEW append-only record, never a mutation of the supersede event
 * it's undoing. `null` when the version doesn't exist at all (caller 404s).
 * Restoring a version that's already current is a harmless no-op, same
 * idempotence shape as `supersede` above. Because this is a genuine new
 * event (not a row delete/flag flip), the version can be superseded again
 * later — that later `supersede` call sees `existing.superseded === false`
 * (the restore is now the latest event) and is free to write a fresh
 * `'supersede'` event of its own.
 */
export function restore(property: Property, auditKey: string, version: number, by: string): AttachmentRecord | null {
  const existing = getAttachment(property, auditKey, version);
  if (!existing) return null;
  if (!existing.superseded) return existing; // already current — no-op
  db.prepare(`INSERT INTO supersede_events (property, audit_key, version, action, by) VALUES (?, ?, ?, 'restore', ?)`).run(
    property,
    auditKey,
    version,
    by,
  );
  return getAttachment(property, auditKey, version);
}
