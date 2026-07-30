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

import { beforeAll, describe, expect, test } from "bun:test";
import { TENDERS } from "../shared/types.ts";
import type { Category, CategoryKey, Tender } from "../shared/types.ts";

const { api } = await import("./server.ts");
const { _internal, stopAnalyticsPushWorker } = await import("./analytics-push.ts");
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
