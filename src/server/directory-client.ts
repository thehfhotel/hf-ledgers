// Manager directory client — replaces the old MANAGER_EMAILS hand-copy with
// live tier membership read from the HF Portal (the "HF Managers" Access
// tier lives there; see hf-erp-portal's infra/cloudflare/hostnames.json).
//
// Interface (locked):
//   GET <PORTAL_DIRECTORY_URL>
//   Authorization: Bearer <PORTAL_DIRECTORY_TOKEN>
//   200 -> { managers: string[], fetchedAt: "<ISO 8601>" }
//   401 -> { error: "unauthorized" }
//   503 -> { error: "directory unavailable" }   the portal's own Cloudflare
//                                                read failed — deliberate,
//                                                never a stale 200.
//
// Staleness is entirely this module's problem, not the portal's:
//   - Last-known-good is persisted in SQLite (`manager_directory_cache`,
//     one row), NEVER only in process memory — a container restart during a
//     portal outage must not lose it (that's exactly when it's needed most:
//     a deploy restarts the container).
//   - A TTL (~5 min) skips re-fetching when the cache is fresh.
//   - Any fetch failure (network error, non-200, or the client
//     unconfigured) falls back to the persisted cache indefinitely, logging
//     its age. Only a cache that has NEVER been written (a cold start with
//     the portal down) fails closed to an empty set.
//   - PROTECTED_MANAGER is unconditionally folded into every returned set —
//     the break-glass path back in, mirroring hf-erp-portal's
//     src/server/access.ts. It is added here, once, so every degradation
//     state is covered by the same guarantee.

import type { Database } from "bun:sqlite";

const TTL_MS = 5 * 60 * 1000;

// Owner account that must never lose category-admin access — a portal
// outage plus a container restart (deploy) must not lock every manager out.
// Env-overridable per the task, but defaults to the address already used
// this way elsewhere in the estate (hf-erp-portal's access.ts).
export const protectedManager = (): string => (process.env.PROTECTED_MANAGER || "winut.hf@gmail.com").toLowerCase();

interface DirectoryResponse {
  managers: string[];
  fetchedAt: string;
}

interface CacheRow {
  managers_json: string;
  fetched_at: string;
  cached_at: string;
}

/**
 * Creates the manager-directory cache table if missing. Idempotent, safe to
 * call on every boot — called from auth.ts's own module init, NOT from
 * db.ts's migrate() (a sibling package also needs a new table this wave and
 * neither may touch that shared file).
 */
export function ensureDirectoryCache(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manager_directory_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      managers_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      cached_at TEXT NOT NULL
    );
  `);
}

function readCache(db: Database): { managers: string[]; fetchedAt: string; cachedAtMs: number } | null {
  const row = db
    .query<CacheRow, []>("SELECT managers_json, fetched_at, cached_at FROM manager_directory_cache WHERE id = 1")
    .get();
  if (!row) return null;
  const cachedAtMs = Date.parse(row.cached_at);
  return {
    managers: JSON.parse(row.managers_json) as string[],
    fetchedAt: row.fetched_at,
    cachedAtMs: Number.isNaN(cachedAtMs) ? 0 : cachedAtMs,
  };
}

function writeCache(db: Database, managers: string[], fetchedAt: string, cachedAtIso: string): void {
  db.prepare(
    `INSERT INTO manager_directory_cache (id, managers_json, fetched_at, cached_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       managers_json = excluded.managers_json,
       fetched_at = excluded.fetched_at,
       cached_at = excluded.cached_at`,
  ).run(JSON.stringify(managers), fetchedAt, cachedAtIso);
}

/**
 * Calls the portal directory endpoint. Returns null on ANY failure —
 * unconfigured client, network error, non-200 (401/503/etc), or a malformed
 * body — so the caller has one branch ("no fresh data") rather than needing
 * to special-case each failure mode.
 */
async function fetchDirectory(fetchImpl: typeof fetch): Promise<DirectoryResponse | null> {
  const url = process.env.PORTAL_DIRECTORY_URL || "";
  const token = process.env.PORTAL_DIRECTORY_TOKEN || "";
  if (!url || !token) return null;

  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<DirectoryResponse>;
    if (!Array.isArray(body.managers) || typeof body.fetchedAt !== "string") return null;
    return { managers: body.managers, fetchedAt: body.fetchedAt };
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  /** Injection seam for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injection seam for tests — defaults to Date.now(). */
  now?: number;
}

/**
 * Resolves the current effective manager email set (lowercased), degrading
 * through: TTL-fresh cache hit -> live fetch -> stale-cache fallback ->
 * fail-closed empty set. PROTECTED_MANAGER is always included, in every
 * branch, so a manager admin never gets fully locked out of this app.
 */
export async function resolveManagerEmails(db: Database, options: ResolveOptions = {}): Promise<Set<string>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  const protectedEmail = protectedManager();

  const cached = readCache(db);
  if (cached && now - cached.cachedAtMs < TTL_MS) {
    return withProtected(cached.managers, protectedEmail);
  }

  const fresh = await fetchDirectory(fetchImpl);
  if (fresh) {
    writeCache(db, fresh.managers, fresh.fetchedAt, new Date(now).toISOString());
    return withProtected(fresh.managers, protectedEmail);
  }

  if (cached) {
    const ageMs = now - cached.cachedAtMs;
    console.error(
      `[directory] portal fetch failed; serving cached manager list (age ${Math.round(ageMs / 1000)}s, fetched ${cached.fetchedAt})`,
    );
    return withProtected(cached.managers, protectedEmail);
  }

  console.error("[directory] portal fetch failed and no cache has ever been written; failing closed");
  return withProtected([], protectedEmail);
}

function withProtected(managers: string[], protectedEmail: string): Set<string> {
  const set = new Set(managers.map((m) => m.toLowerCase()));
  set.add(protectedEmail);
  return set;
}
