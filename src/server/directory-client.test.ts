// Covers every degradation state resolveManagerEmails() must survive — a
// stubbed fetch stands in for the portal, per src/server/directory-client.ts:
//   1. fresh fetch (200, no prior cache)
//   2. cache hit within TTL (network never touched)
//   3. portal 503 with a warm cache (falls back to last-known-good)
//   4. portal 503 with an empty cache (fails closed)
//   5. client unconfigured (no URL/token) — same as a fetch failure
// PROTECTED_MANAGER must be present in every one of these.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureDirectoryCache, protectedManager, resolveManagerEmails } from "./directory-client.ts";

const PROTECTED = "owner@thehfhotel.org";

function okFetch(managers: string[], fetchedAt: string): typeof fetch {
  return (async () =>
    ({
      ok: true,
      json: async () => ({ managers, fetchedAt }),
    }) as unknown as Response) as unknown as typeof fetch;
}

function failedFetch(): typeof fetch {
  return (async () => ({ ok: false, json: async () => ({ error: "directory unavailable" }) }) as unknown as Response) as unknown as typeof fetch;
}

function unreachableFetch(): typeof fetch {
  return (async () => {
    throw new Error("fetch must not be called — a cache hit or an unconfigured client should short-circuit before this");
  }) as unknown as typeof fetch;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  ensureDirectoryCache(db);
  return db;
}

describe("resolveManagerEmails", () => {
  const saved = {
    url: process.env.PORTAL_DIRECTORY_URL,
    token: process.env.PORTAL_DIRECTORY_TOKEN,
    protectedManager: process.env.PROTECTED_MANAGER,
  };

  beforeEach(() => {
    process.env.PORTAL_DIRECTORY_URL = "https://example.invalid/portal-api/directory/managers";
    process.env.PORTAL_DIRECTORY_TOKEN = "test-token";
    process.env.PROTECTED_MANAGER = PROTECTED;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({
      PORTAL_DIRECTORY_URL: saved.url,
      PORTAL_DIRECTORY_TOKEN: saved.token,
      PROTECTED_MANAGER: saved.protectedManager,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("fresh fetch: 200 populates the set (lowercased) plus the protected manager", async () => {
    const db = freshDb();
    const t0 = Date.parse("2026-07-30T10:00:00Z");

    const managers = await resolveManagerEmails(db, {
      fetchImpl: okFetch(["a@thehfhotel.org", "B@thehfhotel.org"], "2026-07-30T09:59:00Z"),
      now: t0,
    });

    expect(managers.has("a@thehfhotel.org")).toBe(true);
    expect(managers.has("b@thehfhotel.org")).toBe(true);
    expect(managers.has(PROTECTED)).toBe(true);
  });

  test("cache hit within TTL never touches the network", async () => {
    const db = freshDb();
    const t0 = Date.parse("2026-07-30T10:00:00Z");

    await resolveManagerEmails(db, {
      fetchImpl: okFetch(["a@thehfhotel.org"], "2026-07-30T09:59:00Z"),
      now: t0,
    });

    const managers = await resolveManagerEmails(db, {
      fetchImpl: unreachableFetch(),
      now: t0 + 60_000, // 1 min later — well inside the 5 min TTL
    });

    expect(managers.has("a@thehfhotel.org")).toBe(true);
    expect(managers.has(PROTECTED)).toBe(true);
  });

  test("portal 503 with a warm cache falls back to last-known-good", async () => {
    const db = freshDb();
    const t0 = Date.parse("2026-07-30T10:00:00Z");

    await resolveManagerEmails(db, {
      fetchImpl: okFetch(["a@thehfhotel.org"], "2026-07-30T09:59:00Z"),
      now: t0,
    });

    // Past the TTL, so this attempts (and fails) a live fetch before falling back.
    const managers = await resolveManagerEmails(db, {
      fetchImpl: failedFetch(),
      now: t0 + 10 * 60_000,
    });

    expect(managers.has("a@thehfhotel.org")).toBe(true);
    expect(managers.has(PROTECTED)).toBe(true);
  });

  test("portal 503 with an empty cache fails closed to only the protected manager", async () => {
    const db = freshDb();

    const managers = await resolveManagerEmails(db, {
      fetchImpl: failedFetch(),
      now: Date.parse("2026-07-30T10:00:00Z"),
    });

    expect(managers.size).toBe(1);
    expect(managers.has(PROTECTED)).toBe(true);
  });

  test("unconfigured client (missing URL/token) behaves like a fetch failure and never calls fetch", async () => {
    delete process.env.PORTAL_DIRECTORY_URL;
    delete process.env.PORTAL_DIRECTORY_TOKEN;
    const db = freshDb();

    const managers = await resolveManagerEmails(db, { fetchImpl: unreachableFetch(), now: Date.now() });

    expect(managers.size).toBe(1);
    expect(managers.has(PROTECTED)).toBe(true);
  });

  test("protectedManager() lowercases the configured address and has a sane default", () => {
    process.env.PROTECTED_MANAGER = "Owner@ThehfHotel.org";
    expect(protectedManager()).toBe("owner@thehfhotel.org");

    delete process.env.PROTECTED_MANAGER;
    expect(protectedManager()).toBe("winut.hf@gmail.com");
  });
});
