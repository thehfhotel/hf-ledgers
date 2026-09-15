// Asserts (1) every mutating route in server.ts enqueues the month it
// touched into the hf-analytics outbox (analytics-push.ts), (2) boot itself
// enqueues the current month and the two before it, and (3) flush()'s
// error handling: a 4xx DROPS the month (permanent rejection — see
// analytics-push.ts's flush() comment and hf-data/CLAUDE.md's ingest rule),
// while a 5xx or a network failure KEEPS it queued and stops the batch.
//
// Same import-order rule as server.test.ts / the income ledger's
// analytics-push.test.ts: env vars (including AP_DB_PATH, so the module-
// level boot enqueue below lands in this test's own tmp file rather than
// the real default path) must be set BEFORE importing server.ts, since
// apStore.ts's db is lazily opened the first time anything (including the
// boot enqueue) touches it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "analytics-push-test-"));
process.env.AP_DB_PATH = join(tmpDir, "ap.db");
process.env.NODE_ENV = "development";
process.env.DEV_USER = "tester@thehfhotel.org";
process.env.PORT = "0";
process.env.ENGINE_API_TOKEN = "test-token";
// Enables the outbox (see analytics-push.ts's ENABLED gate). The URL is
// deliberately unreachable in general — individual tests below install
// their own global.fetch mock covering both the engine surface and this
// URL, so nothing here ever makes a real network call.
process.env.ANALYTICS_URL = "http://127.0.0.1:1";
process.env.ANALYTICS_TOKEN = "test-analytics-token";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { currentMonthBangkok, shiftMonths, todayBangkok } from "@shared/date.ts";
import { deriveDateFromEngineTime, type EngineTransactionPayload } from "./transactionBuilder.ts";

const { fetchHandler } = await import("./server.ts");
const { _internal, stopAnalyticsPushWorker } = await import("./analytics-push.ts");
const apStore = await import("./apStore.ts");
const { _internal: engineInternal } = await import("./engine.ts");

// server.ts armed the worker AND enqueued the boot months at import (both
// env vars are set above). Capture that boot state for the dedicated test
// below, then disarm the worker's timers immediately — on a slow runner the
// 5s boot flush would otherwise fire mid-suite and mutate the outbox under
// later assertions (the exact race the income ledger's own
// analytics-push.test.ts documents).
const bootPendingMonths = {
  current: _internal.isPending(currentMonthBangkok()),
  minus1: _internal.isPending(shiftMonths(currentMonthBangkok(), -1)),
  minus2: _internal.isPending(shiftMonths(currentMonthBangkok(), -2)),
};
stopAnalyticsPushWorker();

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("boot enqueues the current month and the two before it", () => {
  test("all three are pending immediately after import", () => {
    expect(bootPendingMonths.current).toBe(true);
    expect(bootPendingMonths.minus1).toBe(true);
    expect(bootPendingMonths.minus2).toBe(true);
  });
});

// ── Shared engine mock ──────────────────────────────────────────────────
// A minimal in-memory ezBookkeeping stand-in: enough category/account
// surface for "other" and "commission-booking" (the only two codes these
// tests post under), plus a real transaction store so
// getMonthExpenseTransactionsWithApManaged's by_month listing and
// isApManagedTransaction's tag lookups both see what was actually created —
// exactly like a real engine would.

const CATEGORIES_RESPONSE = {
  success: true,
  result: {
    "2": [
      { id: "500", name: "ค่าใช้จ่ายอื่นๆ", subCategories: [{ id: "501", name: "ค่าใช้จ่ายอื่นๆ" }] },
      { id: "510", name: "ค่าคอมมิชชั่น BOOKING", subCategories: [{ id: "511", name: "ค่าคอมมิชชั่น BOOKING" }] },
    ],
  },
};

const ACCOUNTS_RESPONSE = {
  success: true,
  result: [
    { id: "1", name: "เงินสด", category: 1 },
    { id: "2", name: "ธนาคาร", category: 2 },
  ],
};

interface StoredTx extends EngineTransactionPayload {
  id: string;
}

let transactions: Map<string, StoredTx>;
let nextTxId: number;
let tags: Map<string, string>;
let nextTagId: number;
/** month ("YYYY-MM") -> HTTP status for that month's analytics POST, or
 * "throw" to simulate a network failure. Absent = 200 (success). */
let analyticsResponseFor: Record<string, number | "throw">;

function resetEngineState(): void {
  transactions = new Map();
  nextTxId = 1000;
  tags = new Map();
  nextTagId = 1;
  analyticsResponseFor = {};
}

const originalFetch = global.fetch;

global.fetch = (async (url: string | URL, init?: RequestInit) => {
  const href = String(url);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

  if (href.includes("/api/ingest/expense-ledger")) {
    const control = body?.month ? analyticsResponseFor[body.month as string] : undefined;
    if (control === "throw") throw new TypeError("fetch failed");
    const status = typeof control === "number" ? control : 200;
    return new Response(JSON.stringify({ ok: status < 300 }), { status });
  }
  if (href.includes("/transaction/categories/list.json")) {
    return new Response(JSON.stringify(CATEGORIES_RESPONSE));
  }
  if (href.includes("/accounts/list.json")) {
    return new Response(JSON.stringify(ACCOUNTS_RESPONSE));
  }
  if (href.includes("/transaction/tags/list.json")) {
    return new Response(
      JSON.stringify({ success: true, result: Array.from(tags, ([name, id]) => ({ id, name })) }),
    );
  }
  if (href.includes("/transaction/tags/add.json")) {
    const id = String(nextTagId++);
    tags.set(body.name, id);
    return new Response(JSON.stringify({ success: true, result: { id, name: body.name } }));
  }
  if (href.includes("/transactions/add.json")) {
    const id = String(nextTxId++);
    transactions.set(id, { ...(body as EngineTransactionPayload), id });
    return new Response(JSON.stringify({ success: true, result: { id } }));
  }
  if (href.includes("/transactions/modify.json")) {
    const id = String(body.id);
    if (!transactions.has(id)) return new Response(JSON.stringify({ success: false, errorMessage: "not found" }));
    transactions.set(id, { ...(body as EngineTransactionPayload), id });
    return new Response(JSON.stringify({ success: true }));
  }
  if (href.includes("/transactions/delete.json")) {
    const existed = transactions.delete(String(body.id));
    return new Response(JSON.stringify({ success: existed, errorMessage: existed ? undefined : "not found" }));
  }
  if (href.includes("/transactions/get.json")) {
    const id = new URL(href).searchParams.get("id")!;
    const tx = transactions.get(id);
    if (!tx) return new Response(JSON.stringify({ success: false, errorMessage: "not found" }));
    return new Response(JSON.stringify({ success: true, result: tx }));
  }
  if (href.includes("/transactions/list/by_month.json")) {
    const params = new URL(href).searchParams;
    const wantMonth = `${params.get("year")}-${String(params.get("month")).padStart(2, "0")}`;
    const items = Array.from(transactions.values()).filter(
      (t) => deriveDateFromEngineTime(t.time).slice(0, 7) === wantMonth,
    );
    return new Response(JSON.stringify({ success: true, result: { items, totalCount: items.length } }));
  }
  throw new Error(`unexpected fetch call in analytics-push.test.ts: ${href}`);
}) as typeof fetch;

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  resetEngineState();
  engineInternal.resetCaches();
  _internal.clearPending();
});

function devRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

describe("analytics outbox: mutating routes enqueue their month", () => {
  test("POST /expenses enqueues the current month", async () => {
    const res = await fetchHandler(
      devRequest("/api/expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: todayBangkok(),
          amountSatang: 1_000,
          categoryCode: "other",
          paymentMethod: "cash",
          comment: "ทดสอบ",
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(_internal.isPending(currentMonthBangkok())).toBe(true);
  });

  test("PATCH then DELETE /expenses/:id each enqueue independently", async () => {
    const created = await fetchHandler(
      devRequest("/api/expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: todayBangkok(),
          amountSatang: 1_000,
          categoryCode: "other",
          paymentMethod: "cash",
          comment: "ทดสอบ",
        }),
      }),
    );
    const { id } = (await created.json()) as { id: string };

    _internal.clearPending();
    const patched = await fetchHandler(
      devRequest(`/api/expenses/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: todayBangkok(),
          amountSatang: 2_000,
          categoryCode: "other",
          paymentMethod: "cash",
          comment: "ทดสอบแก้ไข",
        }),
      }),
    );
    expect(patched.status).toBe(200);
    expect(_internal.isPending(currentMonthBangkok())).toBe(true);

    _internal.clearPending();
    const deleted = await fetchHandler(devRequest(`/api/expenses/${id}`, { method: "DELETE" }));
    expect(deleted.status).toBe(204);
    expect(_internal.isPending(currentMonthBangkok())).toBe(true);
  });

  test("POST /ap/rows enqueues the current (filed) month", async () => {
    const res = await fetchHandler(
      devRequest("/api/ap/rows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creditor: "Booking.com",
          item: "ค่าคอมมิชชั่น",
          amountSatang: 10_000,
          vatSatang: null,
          whtSatang: null,
          discountSatang: 0,
          dueDate: null,
          entity: "HF",
          categoryCode: "commission-booking",
          note: "",
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(_internal.isPending(currentMonthBangkok())).toBe(true);
  });

  test("POST /ap/rows/:id/payments enqueues the row's filed month", async () => {
    const rowId = apStore.createApRow(
      {
        creditor: "Booking.com",
        item: "ค่าคอมมิชชั่น",
        amountSatang: 10_000,
        vatSatang: null,
        whtSatang: null,
        discountSatang: 0,
        dueDate: null,
        entity: "HF",
        categoryCode: "commission-booking",
        note: "",
      } as never,
      "tester@thehfhotel.org",
    );
    _internal.clearPending();

    const res = await fetchHandler(
      devRequest(`/api/ap/rows/${rowId}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: todayBangkok(), amountSatang: 4_000, paymentMethod: "cash" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(_internal.isPending(currentMonthBangkok())).toBe(true);
  });
});

describe("flush(): 4xx drops the month, 5xx/network keeps it and stops the batch", () => {
  /** Forces a specific queued_at so the batch's processing order is
   * deterministic — enqueueAnalyticsPush uses datetime('now') (second
   * resolution), so two enqueues in the same test could otherwise tie. */
  function forceQueuedAt(month: string, queuedAt: string): void {
    apStore._getDbForTests().prepare("UPDATE _analytics_pending_pushes SET queued_at = ? WHERE month = ?").run(queuedAt, month);
  }

  test("a 4xx on the first-queued month drops it and CONTINUES to the next", async () => {
    const monthA = "2020-01";
    const monthB = "2020-02";
    _internal.clearPending();
    const { enqueueAnalyticsPush } = await import("./analytics-push.ts");
    enqueueAnalyticsPush(monthA);
    enqueueAnalyticsPush(monthB);
    forceQueuedAt(monthA, "2020-01-01 00:00:00");
    forceQueuedAt(monthB, "2020-01-01 00:00:01");
    analyticsResponseFor[monthA] = 400;

    await _internal.flush();

    // Dropped, not merely left queued — a permanent 4xx is discarded.
    expect(_internal.isPending(monthA)).toBe(false);
    // Processing continued past it: monthB was attempted and (200) removed.
    expect(_internal.isPending(monthB)).toBe(false);
  });

  test("a 5xx on the first-queued month KEEPS it queued and BREAKS the batch", async () => {
    const monthA = "2020-03";
    const monthB = "2020-04";
    _internal.clearPending();
    const { enqueueAnalyticsPush } = await import("./analytics-push.ts");
    enqueueAnalyticsPush(monthA);
    enqueueAnalyticsPush(monthB);
    forceQueuedAt(monthA, "2020-01-01 00:00:00");
    forceQueuedAt(monthB, "2020-01-01 00:00:01");
    analyticsResponseFor[monthA] = 503;

    await _internal.flush();

    expect(_internal.isPending(monthA)).toBe(true); // kept, not dropped
    expect(_internal.isPending(monthB)).toBe(true); // never attempted this tick
  });

  test("a network failure (fetch throws) also keeps and breaks, same as a 5xx", async () => {
    const monthA = "2020-05";
    const monthB = "2020-06";
    _internal.clearPending();
    const { enqueueAnalyticsPush } = await import("./analytics-push.ts");
    enqueueAnalyticsPush(monthA);
    enqueueAnalyticsPush(monthB);
    forceQueuedAt(monthA, "2020-01-01 00:00:00");
    forceQueuedAt(monthB, "2020-01-01 00:00:01");
    analyticsResponseFor[monthA] = "throw";

    await _internal.flush();

    expect(_internal.isPending(monthA)).toBe(true);
    expect(_internal.isPending(monthB)).toBe(true);
  });

  test("a 4xx as the ONLY queued month completes cleanly (flush never throws)", async () => {
    const monthA = "2020-07";
    _internal.clearPending();
    const { enqueueAnalyticsPush } = await import("./analytics-push.ts");
    enqueueAnalyticsPush(monthA);
    analyticsResponseFor[monthA] = 422;

    await _internal.flush();

    expect(_internal.isPending(monthA)).toBe(false);
  });
});
