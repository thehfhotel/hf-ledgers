// Asserts that every day-mutating endpoint in server.ts enqueues its
// (property, date) into the hf-analytics outbox (analytics-push.ts). Kept
// as its own file rather than folded into server.test.ts: that file is
// shared, actively-evolving ground another work package owns this wave, and
// this suite's setup (enabling the outbox via ANALYTICS_URL/ANALYTICS_TOKEN)
// is a self-contained concern.
//
// Same import-order rule as server.test.ts: env vars must be set BEFORE
// importing server.ts, since db.ts opens the database and runs migrate()
// at import time. The values mirror server.test.ts's own dev-auth-bypass
// setup so this file behaves identically whether bun runs it in the same
// process as server.test.ts or standalone.

process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "development";
process.env.DEV_USER = "tester@thehfhotel.org";
process.env.PORT = "0";
// Enables the outbox (see analytics-push.ts's ENABLED gate) so enqueue
// actually writes to the outbox table. The URL is deliberately unreachable
// (port 1) — this suite asserts enqueue only, never a live flush. The
// worker's timers are disarmed right after import (see below); before that
// disarm existed, the 5s boot flush fired mid-suite on slow CI runners and
// mutated the outbox under the assertions.
process.env.ANALYTICS_URL = "http://127.0.0.1:1";
process.env.ANALYTICS_TOKEN = "test-analytics-token";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { TENDERS } from "../shared/types.ts";
import type { Category, CategoryKey, Tender } from "../shared/types.ts";

const { api } = await import("./server.ts");
const { _internal, enqueueAnalyticsPush, stopAnalyticsPushWorker } = await import("./analytics-push.ts");
// db.ts is already loaded (server.ts imports it) — this dynamic import just
// reads the cached module, same _internal pattern as everything else here.
// Must stay dynamic, never a static top-of-file import: a static import is
// hoisted before this file's own `process.env.DB_PATH = ":memory:"` line,
// which would run db.ts's module-level migrate() against the wrong path.
const { db } = await import("./db.ts");
// server.ts armed the worker at import (ENABLED is true here). Disarm it
// NOW: on slow runners the 5s boot flush fires mid-suite and mutates the
// outbox under these assertions — the exact race that kept CI red while
// passing locally. This suite asserts enqueue only, never a live flush.
stopAnalyticsPushWorker();

const BASE = "http://localhost";

interface Call<T> {
  status: number;
  body: T;
}

async function call<T>(method: string, path: string, requestBody?: unknown): Promise<Call<T>> {
  const res = await api.handle(
    new Request(`${BASE}/api${path}`, {
      method,
      headers: requestBody !== undefined ? { "content-type": "application/json" } : undefined,
      body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
    }),
  );
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, body };
}

function zeroTenders(): Record<Tender, number> {
  return Object.fromEntries(TENDERS.map((tender) => [tender, 0])) as Record<Tender, number>;
}

const PROPERTY = "hf";

let categoryIdByKey: Map<CategoryKey, number>;
let expenseCategoryId: number;

function categoryId(key: CategoryKey): number {
  const id = categoryIdByKey.get(key);
  if (id === undefined) throw new Error(`no seeded category for key ${key}`);
  return id;
}

beforeAll(async () => {
  const res = await call<{ categories: Category[] }>("GET", `/${PROPERTY}/categories`);
  categoryIdByKey = new Map(
    res.body.categories
      .filter((c): c is Category & { categoryKey: CategoryKey } => c.categoryKey !== null)
      .map((c) => [c.categoryKey, c.id]),
  );
  expenseCategoryId = res.body.categories.find((c) => c.kind === "expense")!.id;
});

describe("analytics outbox: every day-mutating endpoint enqueues its (property, date)", () => {
  test("PUT income cell", async () => {
    const DATE = "2026-06-01";
    _internal.clearPending(PROPERTY, DATE);
    const res = await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("room_cash")}`, {
      amountSatang: 1_000,
      note: null,
    });
    expect(res.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);
  });

  test("PUT day note", async () => {
    const DATE = "2026-06-02";
    _internal.clearPending(PROPERTY, DATE);
    const res = await call("PUT", `/${PROPERTY}/day/${DATE}/note`, { note: "หมายเหตุทดสอบ" });
    expect(res.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);
  });

  test("POST/PATCH/DELETE expenses each enqueue independently", async () => {
    const DATE = "2026-06-03";
    _internal.clearPending(PROPERTY, DATE);
    const created = await call<{ id: number }>("POST", `/${PROPERTY}/day/${DATE}/expenses`, {
      categoryId: expenseCategoryId,
      amountSatang: 500,
    });
    expect(created.status).toBe(201);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);

    _internal.clearPending(PROPERTY, DATE);
    const patched = await call("PATCH", `/${PROPERTY}/expenses/${created.body.id}`, { amountSatang: 600 });
    expect(patched.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);

    _internal.clearPending(PROPERTY, DATE);
    const deleted = await call("DELETE", `/${PROPERTY}/expenses/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);
  });

  test("POST/PATCH/DELETE booking lines each enqueue independently", async () => {
    const DATE = "2026-06-04";
    _internal.clearPending(PROPERTY, DATE);
    const created = await call<{ id: number }>("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
      guestName: "ทดสอบ",
      tenders: zeroTenders(),
    });
    expect(created.status).toBe(201);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);

    _internal.clearPending(PROPERTY, DATE);
    const patched = await call("PATCH", `/${PROPERTY}/bookings/${created.body.id}`, {
      tenders: { ...zeroTenders(), cash: 1_000 },
    });
    expect(patched.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);

    _internal.clearPending(PROPERTY, DATE);
    const deleted = await call("DELETE", `/${PROPERTY}/bookings/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);
  });

  test("POST/PATCH/DELETE other-income items each enqueue independently", async () => {
    const DATE = "2026-06-05";
    _internal.clearPending(PROPERTY, DATE);
    const created = await call<{ id: number }>("POST", `/${PROPERTY}/day/${DATE}/other-income`, {
      description: "ค่าอาหารเช้า",
      amountSatang: 300,
      isCash: true,
    });
    expect(created.status).toBe(201);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);

    _internal.clearPending(PROPERTY, DATE);
    const patched = await call("PATCH", `/${PROPERTY}/other-income/${created.body.id}`, { amountSatang: 400 });
    expect(patched.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);

    _internal.clearPending(PROPERTY, DATE);
    const deleted = await call("DELETE", `/${PROPERTY}/other-income/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);
  });

  test("fill-from-bookings: preview does NOT enqueue, apply=true does", async () => {
    const DATE = "2026-06-06";
    _internal.clearPending(PROPERTY, DATE);
    await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
      guestName: "ทดสอบ",
      tenders: { ...zeroTenders(), cash: 500 },
    });
    _internal.clearPending(PROPERTY, DATE); // the booking-line create above already enqueued; isolate the fill call

    const preview = await call("POST", `/${PROPERTY}/day/${DATE}/fill-from-bookings`);
    expect(preview.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(false);

    const applied = await call("POST", `/${PROPERTY}/day/${DATE}/fill-from-bookings?apply=true`);
    expect(applied.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);
  });

  test("PUT cash-block override", async () => {
    const DATE = "2026-06-07";
    _internal.clearPending(PROPERTY, DATE);
    const res = await call("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { bankedSatang: 1_000 });
    expect(res.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);
  });

  test("PUT verify", async () => {
    const DATE = "2026-06-08";
    _internal.clearPending(PROPERTY, DATE);
    const res = await call("PUT", `/${PROPERTY}/day/${DATE}/verify`, { verified: true });
    expect(res.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);
  });

  test("month close and reopen re-enqueue every day with data in that month", async () => {
    const MONTH = "2026-06";
    const DATE = "2026-06-20";
    await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("bar_cash")}`, {
      amountSatang: 100,
      note: null,
    });
    _internal.clearPending(PROPERTY, DATE);

    const closed = await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });
    expect(closed.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);

    _internal.clearPending(PROPERTY, DATE);
    const reopened = await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: false });
    expect(reopened.status).toBe(200);
    expect(_internal.isPending(PROPERTY, DATE)).toBe(true);
  });
});

// Wave C fix: the pre-Wave-C flush() broke the WHOLE batch on the first
// error, regardless of cause — a single permanently-un-ingestable day (a
// footing mismatch hf-analytics 4xx-rejects) sat at the head of the queue
// forever and head-of-line-blocked every healthy day queued behind it. The
// fix distinguishes a permanent 4xx (continue past it — the day stays
// queued for a human to fix, but the rest of the batch still gets pushed)
// from a 5xx/network failure (break — hf-analytics itself is likely
// down/degraded, no point hammering it further this tick).
describe("flush(): continue on 4xx, break on 5xx/network", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Forces a specific `queued_at` on an outbox row so the batch's
   * processing order is deterministic in this test — `enqueueAnalyticsPush`
   * uses `datetime('now')` (second resolution), so two enqueues in the same
   * test could otherwise tie and leave `listPendingStmt`'s ORDER BY
   * unspecified between them. */
  function forceQueuedAt(date: string, queuedAt: string): void {
    db.prepare("UPDATE _analytics_pending_pushes SET queued_at = ? WHERE property = ? AND date = ?").run(
      queuedAt,
      PROPERTY,
      date,
    );
  }

  /** Mocks fetch to return `statusByDate[date]` (or 200 if absent) for a
   * POST whose body's `date` field matches — mirrors real payload shape
   * (buildPayload always includes `date`). */
  function mockFetchByDate(statusByDate: Record<string, number>): void {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { date?: string };
      const status = (body.date && statusByDate[body.date]) || 200;
      return new Response(JSON.stringify({ ok: status < 300 }), { status });
    }) as typeof fetch;
  }

  test("a 4xx on the first-queued day does not block a healthy day queued behind it", async () => {
    const DATE_A = "2026-06-25";
    const DATE_B = "2026-06-26";
    _internal.clearPending(PROPERTY, DATE_A);
    _internal.clearPending(PROPERTY, DATE_B);
    enqueueAnalyticsPush(PROPERTY, DATE_A);
    enqueueAnalyticsPush(PROPERTY, DATE_B);
    forceQueuedAt(DATE_A, "2020-01-01 00:00:00");
    forceQueuedAt(DATE_B, "2020-01-01 00:00:01");

    mockFetchByDate({ [DATE_A]: 400 });
    await _internal.flush();

    // The 4xx day stays queued (never silently discarded — a human can fix
    // the underlying data and it retries later), but processing CONTINUED
    // past it: the healthy day behind it was pushed and removed.
    expect(_internal.isPending(PROPERTY, DATE_A)).toBe(true);
    expect(_internal.isPending(PROPERTY, DATE_B)).toBe(false);
  });

  // Opus money-review (2026-07-31): a 4xx-continue must ALSO bump
  // queued_at, or the failing day sits at the HEAD of listPendingStmt's
  // `ORDER BY queued_at ASC LIMIT 50` window forever — once 50 healthy days
  // queue up behind it, they'd silently fall outside the LIMIT 50 window
  // and never be attempted at all.
  test("a 4xx continue bumps queued_at, rotating the day to the BACK of the queue", async () => {
    const DATE_A = "2026-06-23";
    _internal.clearPending(PROPERTY, DATE_A);
    enqueueAnalyticsPush(PROPERTY, DATE_A);
    forceQueuedAt(DATE_A, "2020-01-01 00:00:00");

    mockFetchByDate({ [DATE_A]: 400 });
    await _internal.flush();

    const row = db
      .query<{ queued_at: string }, [string, string]>(
        "SELECT queued_at FROM _analytics_pending_pushes WHERE property = ? AND date = ?",
      )
      .get(PROPERTY, DATE_A);
    expect(row).not.toBeNull();
    expect(row!.queued_at).not.toBe("2020-01-01 00:00:00"); // bumped to datetime('now')
  });

  test("a 5xx on the first-queued day BREAKS the batch — a healthy day behind it is left untouched this tick", async () => {
    const DATE_A = "2026-06-27";
    const DATE_B = "2026-06-28";
    _internal.clearPending(PROPERTY, DATE_A);
    _internal.clearPending(PROPERTY, DATE_B);
    enqueueAnalyticsPush(PROPERTY, DATE_A);
    enqueueAnalyticsPush(PROPERTY, DATE_B);
    forceQueuedAt(DATE_A, "2020-01-01 00:00:00");
    forceQueuedAt(DATE_B, "2020-01-01 00:00:01");

    mockFetchByDate({ [DATE_A]: 503 });
    await _internal.flush();

    expect(_internal.isPending(PROPERTY, DATE_A)).toBe(true);
    expect(_internal.isPending(PROPERTY, DATE_B)).toBe(true); // never attempted this tick
  });

  test("a network failure (fetch itself throws) also BREAKS the batch, same as a 5xx", async () => {
    const DATE_A = "2026-06-29";
    const DATE_B = "2026-06-30";
    _internal.clearPending(PROPERTY, DATE_A);
    _internal.clearPending(PROPERTY, DATE_B);
    enqueueAnalyticsPush(PROPERTY, DATE_A);
    enqueueAnalyticsPush(PROPERTY, DATE_B);
    forceQueuedAt(DATE_A, "2020-01-01 00:00:00");
    forceQueuedAt(DATE_B, "2020-01-01 00:00:01");

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await _internal.flush();

    expect(_internal.isPending(PROPERTY, DATE_A)).toBe(true);
    expect(_internal.isPending(PROPERTY, DATE_B)).toBe(true);
  });

  test("a 4xx is the ONLY day queued — flush still completes cleanly (never throws)", async () => {
    const DATE_A = "2026-06-24";
    _internal.clearPending(PROPERTY, DATE_A);
    enqueueAnalyticsPush(PROPERTY, DATE_A);

    mockFetchByDate({ [DATE_A]: 422 });
    await _internal.flush();

    expect(_internal.isPending(PROPERTY, DATE_A)).toBe(true);
  });
});
