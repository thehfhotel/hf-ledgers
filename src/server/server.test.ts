// Server route tests. Establishes the pattern for this repo: point the DB
// at :memory:, force the dev auth bypass, then drive api.handle() directly
// — no real HTTP socket needed. Env vars must be set BEFORE importing the
// server module, since db.ts opens the database and runs migrate() at
// import time.

process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "development";
process.env.DEV_USER = "tester@thehfhotel.org";
process.env.PORT = "0"; // let the OS pick a free port — avoids clashing with `bun run dev`

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { activeCashAdjustmentPatch, activeCashOverridePatch } from "../client/cashBlockPatches.ts";
import { DEPOSIT_NOTE_MAX_LEN, REMARK_MAX_LEN, TENDERS } from "../shared/types.ts";
import type { CashBlock, Category, CategoryKey, Property, Tender } from "../shared/types.ts";
import type { DepositCandidate, PrefillAnomaly, PrefillCandidate } from "./pms-prefill.ts";
import type { DepositLedgerEvent, DepositRegisterData, DepositThread, MonthlyDepositReconciliation } from "./deposit-register.ts";

const { api } = await import("./server.ts");
// server.ts already imported pms-prefill.ts above, so this re-import just
// reads the cached module — same _internal pattern as analytics-push.test.ts.
const { _internal: pmsPrefillInternal } = await import("./pms-prefill.ts");
// Same pattern again for deposit-register.ts (Wave D) — server.ts already
// imported it above, so this just reads the cached module.
const { _internal: depositRegisterInternal } = await import("./deposit-register.ts");

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

let categories: Category[];
let categoryIdByKey: Map<CategoryKey, number>;

function categoryId(key: CategoryKey): number {
  const id = categoryIdByKey.get(key);
  if (id === undefined) throw new Error(`no seeded category for key ${key}`);
  return id;
}

beforeAll(async () => {
  const res = await call<{ categories: Category[] }>("GET", `/${PROPERTY}/categories`);
  categories = res.body.categories;
  categoryIdByKey = new Map(
    categories.filter((c): c is Category & { categoryKey: CategoryKey } => c.categoryKey !== null).map((c) => [c.categoryKey, c.id]),
  );
});

describe("category seed and category_key", () => {
  test("seeds fifteen income categories, including the split รายการอื่นๆ, โอน/เครดิต pairs, and the Wave C deposit_applied category", () => {
    const income = categories.filter((c) => c.kind === "income");
    expect(income).toHaveLength(15);
    expect(income.find((c) => c.categoryKey === "other_cash")?.nameTh).toBe("รายการอื่นๆ เงินสด");
    expect(income.find((c) => c.categoryKey === "other_transfer")?.nameTh).toBe("รายการอื่นๆ โอน");
    expect(income.find((c) => c.categoryKey === "other_cash")?.isCash).toBe(true);
    expect(income.find((c) => c.categoryKey === "other_transfer")?.isCash).toBe(false);
  });

  // Wave C (docs/adr/0001): the accrual-era category, seeded right after
  // deposit_credit.
  test("seeds deposit_applied ('มัดจำล่วงหน้า (ตัดยอด)') immediately after deposit_credit", () => {
    const income = categories.filter((c) => c.kind === "income");
    expect(income.find((c) => c.categoryKey === "deposit_applied")?.nameTh).toBe("มัดจำล่วงหน้า (ตัดยอด)");
    expect(income.find((c) => c.categoryKey === "deposit_applied")?.isCash).toBe(false);
    const indexOf = (key: string) => income.findIndex((c) => c.categoryKey === key);
    expect(indexOf("deposit_applied")).toBe(indexOf("deposit_credit") + 1);
  });

  // Wave B (docs/plan-unify-exports-tender-split.md item 2): the three
  // formerly-mixed โอน/เครดิต categories, split at entry time.
  test("seeds the three เครดิต siblings with โอน-only wording on their existing partner", () => {
    const income = categories.filter((c) => c.kind === "income");
    expect(income.find((c) => c.categoryKey === "deposit")?.nameTh).toBe("มัดจำล่วงหน้า โอน");
    expect(income.find((c) => c.categoryKey === "deposit_credit")?.nameTh).toBe("มัดจำล่วงหน้า เครดิต");
    expect(income.find((c) => c.categoryKey === "bar_transfer")?.nameTh).toBe("บาร์น้ำ โอน");
    expect(income.find((c) => c.categoryKey === "bar_credit")?.nameTh).toBe("บาร์น้ำ เครดิต");
    expect(income.find((c) => c.categoryKey === "other_credit")?.nameTh).toBe("รายการอื่นๆ เครดิต");
    for (const key of ["deposit_credit", "other_credit", "bar_credit"] as const) {
      expect(income.find((c) => c.categoryKey === key)?.isCash).toBe(false);
    }
  });

  test("refuses to archive a category with a non-null category_key", async () => {
    const res = await call("PATCH", `/${PROPERTY}/categories/${categoryId("room_cash")}`, { archived: true });
    expect(res.status).toBe(400);
  });

  test("allows archiving a manager-created (unkeyed) category", async () => {
    const created = await call<Category>("POST", `/${PROPERTY}/categories`, {
      kind: "expense",
      nameTh: "ทดสอบหมวดหมู่ชั่วคราว",
      isCash: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.categoryKey).toBeNull();

    const archived = await call<Category>("PATCH", `/${PROPERTY}/categories/${created.body.id}`, {
      archived: true,
    });
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).not.toBeNull();
  });
});

describe("booking-line CRUD", () => {
  const DATE = "2026-02-01";

  test("creates a multi-tender line, auto-assigning seq", async () => {
    const created = await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
      guestName: "สมชาย ใจดี",
      roomNo: "101",
      roomCount: 1,
      nights: 2,
      grossRoomSatang: 200_000,
      tenders: { ...zeroTenders(), cash: 120_000, transfer_kbank: 80_000 },
    });
    expect(created.status).toBe(201);
    const body = created.body as { seq: number; tenders: Record<Tender, number> };
    expect(body.seq).toBe(1);
    expect(body.tenders.cash).toBe(120_000);
    expect(body.tenders.transfer_kbank).toBe(80_000);
    expect(body.tenders.web).toBe(0);
  });

  test("creates a zero-tender coupon/comp line, auto-incrementing seq", async () => {
    const created = await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
      guestName: "คูปองห้องพัก",
      tenders: zeroTenders(),
    });
    expect(created.status).toBe(201);
    const body = created.body as { seq: number; tenders: Record<Tender, number> };
    expect(body.seq).toBe(2);
    expect(TENDERS.every((t) => body.tenders[t] === 0)).toBe(true);
  });

  test("GET bookings lists both lines ordered by seq with correct totals", async () => {
    const res = await call<{ lines: Array<{ id: number; seq: number }>; totals: { lineCount: number; receivedSatang: number } }>(
      "GET",
      `/${PROPERTY}/day/${DATE}/bookings`,
    );
    expect(res.status).toBe(200);
    expect(res.body.lines.map((l) => l.seq)).toEqual([1, 2]);
    expect(res.body.totals.lineCount).toBe(2);
    expect(res.body.totals.receivedSatang).toBe(200_000);
  });

  test("PATCH updates a line's tenders, round-tripping the full record", async () => {
    const list = await call<{ lines: Array<{ id: number; seq: number }> }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    const firstLineId = list.body.lines.find((l) => l.seq === 1)!.id;

    const patched = await call("PATCH", `/${PROPERTY}/bookings/${firstLineId}`, {
      tenders: { ...zeroTenders(), credit_icbc: 200_000 },
    });
    expect(patched.status).toBe(200);
    const body = patched.body as { tenders: Record<Tender, number> };
    expect(body.tenders.credit_icbc).toBe(200_000);
    expect(body.tenders.cash).toBe(0);
    expect(body.tenders.transfer_kbank).toBe(0);
  });

  test("DELETE removes a line", async () => {
    const list = await call<{ lines: Array<{ id: number; seq: number }> }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    const secondLineId = list.body.lines.find((l) => l.seq === 2)!.id;

    const deleted = await call("DELETE", `/${PROPERTY}/bookings/${secondLineId}`);
    expect(deleted.status).toBe(204);

    const after = await call<{ lines: unknown[] }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    expect(after.body.lines).toHaveLength(1);
  });

  test("remark is bounded by REMARK_MAX_LEN, the one constant both sides read", async () => {
    const atBound = await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
      guestName: "ทดสอบหมายเหตุยาว",
      remark: "ก".repeat(REMARK_MAX_LEN),
      tenders: zeroTenders(),
    });
    expect(atBound.status).toBe(201);
    expect((atBound.body as { remark: string }).remark).toHaveLength(REMARK_MAX_LEN);

    const overBound = await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
      guestName: "ทดสอบหมายเหตุยาวเกิน",
      remark: "ก".repeat(REMARK_MAX_LEN + 1),
      tenders: zeroTenders(),
    });
    expect(overBound.status).toBe(400);
    expect((overBound.body as { error: string }).error).toBe("invalid remark");

    const created = (atBound.body as { id: number }).id;
    const patchedOver = await call("PATCH", `/${PROPERTY}/bookings/${created}`, {
      remark: "ก".repeat(REMARK_MAX_LEN + 1),
    });
    expect(patchedOver.status).toBe(400);

    await call("DELETE", `/${PROPERTY}/bookings/${created}`);
  });

  test("a day touched only by a booking line still appears in GET /days", async () => {
    const res = await call<{ days: Array<{ date: string }> }>("GET", `/${PROPERTY}/days?month=2026-02`);
    expect(res.body.days.some((d) => d.date === DATE)).toBe(true);
  });
});

describe("other-income items and the two อื่นๆ cells", () => {
  const DATE = "2026-02-05";

  test("with no items, the other_cash cell is directly editable", async () => {
    const put = await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("other_cash")}`, {
      amountSatang: 5_000,
      note: null,
    });
    expect(put.status).toBe(200);
  });

  test("adding an item makes both อื่นๆ cells computed and read-only", async () => {
    const created = await call("POST", `/${PROPERTY}/day/${DATE}/other-income`, {
      description: "ค่าอาหารเช้า",
      amountSatang: 3_000,
      isCash: true,
    });
    expect(created.status).toBe(201);

    const day = await call<{ income: Record<number, { amountSatang: number }> }>("GET", `/${PROPERTY}/day/${DATE}`);
    // The direct edit above (5,000) is superseded by the computed sum (3,000).
    expect(day.body.income[categoryId("other_cash")]?.amountSatang).toBe(3_000);
    expect(day.body.income[categoryId("other_transfer")]?.amountSatang).toBe(0);

    const blockedPut = await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("other_cash")}`, {
      amountSatang: 9_999,
      note: null,
    });
    expect(blockedPut.status).toBe(400);
  });

  test("a second, transfer item updates the other_transfer cell independently", async () => {
    await call("POST", `/${PROPERTY}/day/${DATE}/other-income`, {
      description: "ค่าจอดรถ",
      amountSatang: 1_500,
      isCash: false,
    });

    const day = await call<{ income: Record<number, { amountSatang: number }>; otherIncome: unknown[] }>(
      "GET",
      `/${PROPERTY}/day/${DATE}`,
    );
    expect(day.body.income[categoryId("other_cash")]?.amountSatang).toBe(3_000);
    expect(day.body.income[categoryId("other_transfer")]?.amountSatang).toBe(1_500);
    expect(day.body.otherIncome).toHaveLength(2);
  });

  test("deleting every item releases the cells back to direct editing", async () => {
    const items = await call<{ otherIncome: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}`);
    for (const item of (await call<{ otherIncome: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}`)).body
      .otherIncome) {
      await call("DELETE", `/${PROPERTY}/other-income/${item.id}`);
    }
    void items;

    const put = await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("other_cash")}`, {
      amountSatang: 2_222,
      note: null,
    });
    expect(put.status).toBe(200);
  });
});

describe("fill-from-bookings", () => {
  const DATE = "2026-02-10";

  test("preview diffs the seven tender-derived categories, excluding tender 'other'", async () => {
    await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
      guestName: "ผู้เข้าพักทดสอบ",
      grossRoomSatang: 700_000,
      tenders: {
        deposit: 10_000,
        deposit_applied: 0,
        cash: 20_000,
        credit_kbank: 30_000,
        credit_icbc: 40_000,
        transfer_kbank: 50_000,
        transfer_icbc: 60_000,
        web: 70_000,
        other: 15_000,
      },
    });

    const preview = await call<{
      diff: Array<{ categoryKey: CategoryKey; categoryId: number | null; beforeSatang: number; afterSatang: number; skippedManual: boolean }>;
    }>("POST", `/${PROPERTY}/day/${DATE}/fill-from-bookings`);
    expect(preview.status).toBe(200);
    expect(preview.body.diff).toHaveLength(7);
    expect(preview.body.diff.some((d) => (d.categoryKey as string) === "other")).toBe(false);
    const depositLine = preview.body.diff.find((d) => d.categoryKey === "deposit")!;
    expect(depositLine.beforeSatang).toBe(0);
    expect(depositLine.afterSatang).toBe(10_000);
    expect(depositLine.skippedManual).toBe(false);

    // Preview must not have written anything.
    const day = await call<{ income: Record<number, unknown> }>("GET", `/${PROPERTY}/day/${DATE}`);
    expect(day.body.income[categoryId("deposit")]).toBeUndefined();
  });

  test("apply writes ordinary audited cells but skips a manually-edited category", async () => {
    // Mark credit_kbank as a manual human entry before applying.
    await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("credit_kbank")}`, {
      amountSatang: 999_999,
      note: null,
    });

    const applied = await call<{
      diff: Array<{ categoryKey: CategoryKey; categoryId: number | null; beforeSatang: number; afterSatang: number; skippedManual: boolean }>;
    }>("POST", `/${PROPERTY}/day/${DATE}/fill-from-bookings?apply=true`);
    expect(applied.status).toBe(200);

    const creditKbank = applied.body.diff.find((d) => d.categoryKey === "credit_kbank")!;
    expect(creditKbank.skippedManual).toBe(true);
    expect(creditKbank.afterSatang).toBe(999_999); // untouched

    const day = await call<{ income: Record<number, { amountSatang: number; source: string; manual: boolean }> }>(
      "GET",
      `/${PROPERTY}/day/${DATE}`,
    );
    expect(day.body.income[categoryId("deposit")].amountSatang).toBe(10_000);
    expect(day.body.income[categoryId("deposit")].source).toBe("booking");
    expect(day.body.income[categoryId("deposit")].manual).toBe(false);
    expect(day.body.income[categoryId("credit_kbank")].amountSatang).toBe(999_999);
    expect(day.body.income[categoryId("credit_kbank")].manual).toBe(true);
  });

  test("a later fill never deletes a cell it has no positive evidence for", async () => {
    // Remove the booking line's deposit tender entirely by re-fetching and
    // patching it to zero, then re-run fill-from-bookings: deposit's
    // derived total is now 0, so it must be absent from the diff, and the
    // previously-applied deposit cell (10,000) must survive untouched.
    const list = await call<{ lines: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    const lineId = list.body.lines[0]!.id;
    await call("PATCH", `/${PROPERTY}/bookings/${lineId}`, {
      tenders: {
        deposit: 0,
        deposit_applied: 0,
        cash: 20_000,
        credit_kbank: 30_000,
        credit_icbc: 40_000,
        transfer_kbank: 50_000,
        transfer_icbc: 60_000,
        web: 70_000,
        other: 15_000,
      },
    });

    const applied = await call<{ diff: Array<{ categoryKey: CategoryKey }> }>(
      "POST",
      `/${PROPERTY}/day/${DATE}/fill-from-bookings?apply=true`,
    );
    expect(applied.body.diff.some((d) => d.categoryKey === "deposit")).toBe(false);

    const day = await call<{ income: Record<number, { amountSatang: number }> }>("GET", `/${PROPERTY}/day/${DATE}`);
    expect(day.body.income[categoryId("deposit")].amountSatang).toBe(10_000);
  });
});

describe("month close", () => {
  const MONTH = "2026-03";
  const DATE = "2026-03-15";

  test("GET reports a fresh month as open", async () => {
    const res = await call<{ month: string; closed: boolean }>("GET", `/${PROPERTY}/months/${MONTH}/close`);
    expect(res.body.closed).toBe(false);
  });

  test("closing the month blocks income, expense, booking-line, and other-income writes with 409", async () => {
    const closed = await call<{ closed: boolean }>("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });
    expect(closed.status).toBe(200);
    expect(closed.body.closed).toBe(true);

    const income = await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("room_cash")}`, {
      amountSatang: 1_000,
      note: null,
    });
    expect(income.status).toBe(409);

    const expense = await call("POST", `/${PROPERTY}/day/${DATE}/expenses`, {
      categoryId: categories.find((c) => c.kind === "expense")!.id,
      amountSatang: 1_000,
    });
    expect(expense.status).toBe(409);

    const booking = await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, { tenders: zeroTenders() });
    expect(booking.status).toBe(409);

    const otherIncome = await call("POST", `/${PROPERTY}/day/${DATE}/other-income`, {
      description: null,
      amountSatang: 500,
      isCash: true,
    });
    expect(otherIncome.status).toBe(409);

    // A closed month is frozen outright, sign-off included: you cannot flip
    // the verified state of data nobody is allowed to change.
    const verify = await call("PUT", `/${PROPERTY}/day/${DATE}/verify`, { verified: true });
    expect(verify.status).toBe(409);
  });

  test("verify is open to any signed-in user (no roles in this app)", async () => {
    const reopened = await call<{ closed: boolean }>("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: false });
    expect(reopened.body.closed).toBe(false);

    const verified = await call<{ verifiedBy: string | null }>("PUT", `/${PROPERTY}/day/${DATE}/verify`, {
      verified: true,
    });
    expect(verified.status).toBe(200);
    expect(verified.body.verifiedBy).not.toBeNull();

    const cleared = await call<{ verifiedAt: string | null }>("PUT", `/${PROPERTY}/day/${DATE}/verify`, {
      verified: false,
    });
    expect(cleared.body.verifiedAt).toBeNull();

    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });
  });

  test("the day note stays writable on a closed month (api.md: endpoint 9 is not gated)", async () => {
    const closed = await call<{ closed: boolean }>("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });
    expect(closed.body.closed).toBe(true);

    // A note is commentary, and after a close it is exactly the thing still
    // worth recording — see src/shared/api.md, Wave 2 endpoints preamble.
    const note = await call<{ note: string | null }>("PUT", `/${PROPERTY}/day/${DATE}/note`, {
      note: "ปิดเดือนแล้ว บันทึกเพิ่มภายหลัง",
    });
    expect(note.status).toBe(200);
    expect(note.body.note).toBe("ปิดเดือนแล้ว บันทึกเพิ่มภายหลัง");

    const day = await call<{ note: string | null; monthClosed: boolean }>("GET", `/${PROPERTY}/day/${DATE}`);
    expect(day.body.monthClosed).toBe(true);
    expect(day.body.note).toBe("ปิดเดือนแล้ว บันทึกเพิ่มภายหลัง");

    const cleared = await call<{ note: string | null }>("PUT", `/${PROPERTY}/day/${DATE}/note`, { note: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.note).toBeNull();
  });

  test("reopening the month allows writes again", async () => {
    const reopened = await call<{ closed: boolean }>("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: false });
    expect(reopened.body.closed).toBe(false);

    const income = await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("room_cash")}`, {
      amountSatang: 1_000,
      note: null,
    });
    expect(income.status).toBe(200);
  });
});

describe("day sheet amendments", () => {
  const DATE = "2026-04-01";

  test("a brand-new day carries sane defaults for every new DaySheet field", async () => {
    const res = await call<{
      bookingLineCount: number;
      otherIncome: unknown[];
      cashBlock: { derived: unknown; entered: unknown };
      provenance: string;
      verifiedAt: string | null;
      verifiedBy: string | null;
      monthClosed: boolean;
    }>("GET", `/${PROPERTY}/day/${DATE}`);
    expect(res.body.bookingLineCount).toBe(0);
    expect(res.body.otherIncome).toEqual([]);
    expect(res.body.cashBlock.entered).toBeNull();
    expect(res.body.provenance).toBe("app");
    expect(res.body.verifiedAt).toBeNull();
    expect(res.body.monthClosed).toBe(false);
  });

  test("verify sets and clears verifiedAt/verifiedBy, reflected in both GET day and GET days", async () => {
    // Give the day some data first so it participates in listDaysWithData —
    // verify alone (no income/expense/booking line/note) would otherwise
    // never surface it in the month list.
    await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("bar_cash")}`, {
      amountSatang: 1_000,
      note: null,
    });

    const verified = await call<{ verifiedAt: string | null; verifiedBy: string | null }>(
      "PUT",
      `/${PROPERTY}/day/${DATE}/verify`,
      { verified: true },
    );
    expect(verified.body.verifiedAt).not.toBeNull();
    expect(verified.body.verifiedBy).toBe("tester@thehfhotel.org");

    const day = await call<{ verifiedAt: string | null }>("GET", `/${PROPERTY}/day/${DATE}`);
    expect(day.body.verifiedAt).not.toBeNull();

    const days = await call<{ days: Array<{ date: string; verified: boolean; provenance: string }> }>(
      "GET",
      `/${PROPERTY}/days?month=2026-04`,
    );
    const summary = days.body.days.find((d) => d.date === DATE)!;
    expect(summary.verified).toBe(true);
    expect(summary.provenance).toBe("app");

    const unverified = await call<{ verifiedAt: string | null }>("PUT", `/${PROPERTY}/day/${DATE}/verify`, {
      verified: false,
    });
    expect(unverified.body.verifiedAt).toBeNull();
  });

  test("cash-block override merges per-field on top of derived, and clears with null", async () => {
    const overridden = await call<{ derived: { bankedSatang: number }; entered: { bankedSatang: number } | null }>(
      "PUT",
      `/${PROPERTY}/day/${DATE}/cash-block`,
      { bankedSatang: 123_456 },
    );
    expect(overridden.status).toBe(200);
    expect(overridden.body.entered?.bankedSatang).toBe(123_456);

    const cleared = await call<{ entered: unknown }>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, null);
    expect(cleared.body.entered).toBeNull();
  });
});

// Deposit-machine reconciliation rows (docs/plan-unify-exports-tender-
// split.md item 6, Wave C, owner request 2026-07-31): small change/coins
// that couldn't go into the deposit machine. Own DATE, isolated from "day
// sheet amendments" above, so month-close toggling here can't interact with
// that describe's own tests.
describe("cash-block deposit-machine adjustment (heldBackSatang/broughtForwardSatang)", () => {
  const DATE = "2026-04-10";

  test("round trip: persists, folds into derived.bankedSatang, and survives a GET", async () => {
    await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("room_cash")}`, {
      amountSatang: 50_000,
      note: null,
    });

    const put = await call<{
      derived: { bankedSatang: number };
      entered: unknown;
      heldBackSatang: number | null;
      broughtForwardSatang: number | null;
    }>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { heldBackSatang: 12_000, broughtForwardSatang: 8_500 });
    expect(put.status).toBe(200);
    expect(put.body.heldBackSatang).toBe(12_000);
    expect(put.body.broughtForwardSatang).toBe(8_500);
    expect(put.body.derived.bankedSatang).toBe(50_000 - 12_000 + 8_500);
    // Neither field is a CashBlockAmounts field, so recording only these two
    // never creates a phantom till-count override.
    expect(put.body.entered).toBeNull();

    const day = await call<{
      cashBlock: {
        derived: { bankedSatang: number };
        heldBackSatang: number | null;
        broughtForwardSatang: number | null;
      };
    }>("GET", `/${PROPERTY}/day/${DATE}`);
    expect(day.body.cashBlock.heldBackSatang).toBe(12_000);
    expect(day.body.cashBlock.broughtForwardSatang).toBe(8_500);
    expect(day.body.cashBlock.derived.bankedSatang).toBe(50_000 - 12_000 + 8_500);
  });

  test("explicit 0 is stored and distinct from null (unset) — omitting a field resets it to null", async () => {
    const zeroed = await call<{ heldBackSatang: number | null; broughtForwardSatang: number | null }>(
      "PUT",
      `/${PROPERTY}/day/${DATE}/cash-block`,
      { heldBackSatang: 0, broughtForwardSatang: 8_500 },
    );
    expect(zeroed.body.heldBackSatang).toBe(0);
    expect(zeroed.body.broughtForwardSatang).toBe(8_500);

    // Absolute replace, same rule as the four CashBlockAmounts fields:
    // heldBackSatang is absent from this body, so it resets to null.
    const clearedOne = await call<{ heldBackSatang: number | null; broughtForwardSatang: number | null }>(
      "PUT",
      `/${PROPERTY}/day/${DATE}/cash-block`,
      { broughtForwardSatang: 8_500 },
    );
    expect(clearedOne.body.heldBackSatang).toBeNull();
    expect(clearedOne.body.broughtForwardSatang).toBe(8_500);
  });

  test("an explicit bankedSatang override still wins over the adjusted derived figure", async () => {
    const res = await call<{
      derived: { bankedSatang: number };
      entered: { bankedSatang: number } | null;
    }>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, {
      heldBackSatang: 12_000,
      broughtForwardSatang: 0,
      bankedSatang: 999_999,
    });
    // derived still reflects the adjustment against the 50,000 room-cash
    // income cell set by the first test in this describe...
    expect(res.body.derived.bankedSatang).toBe(50_000 - 12_000 + 0);
    // ...but entered.bankedSatang (the pre-existing override mechanism) is
    // what every consumer actually reads (mergeCashBlockOverride in db.ts).
    expect(res.body.entered?.bankedSatang).toBe(999_999);
  });

  test("negative amounts are rejected with 400 — the sign lives in the formula, never in the stored value", async () => {
    const heldBack = await call("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { heldBackSatang: -100 });
    expect(heldBack.status).toBe(400);

    const broughtForward = await call("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { broughtForwardSatang: -1 });
    expect(broughtForward.status).toBe(400);
  });

  test("NOT gated by month close — same rule as the existing cash-block override (api.md endpoint 21)", async () => {
    const MONTH = "2026-04";
    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });

    const res = await call<{ heldBackSatang: number | null }>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, {
      heldBackSatang: 5_000,
    });
    expect(res.status).toBe(200);
    expect(res.body.heldBackSatang).toBe(5_000);

    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: false });
  });

  test("clearing the adjustment alone does not disturb an active CashBlockAmounts override, and vice versa", async () => {
    // Establish an override on one of the four fields alongside an
    // adjustment in the same PUT (both fresh — this test's own baseline).
    await call("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { roomCashSatang: 77_000, heldBackSatang: 3_000 });

    // Re-sending the override field alone (mirrors clearCashAdjustment() in
    // DaySheetPage.tsx/BookingDayPage.tsx — never a bare `null` body for
    // this, or the override would be wiped too) clears ONLY the adjustment.
    const clearedAdjustment = await call<{
      entered: { roomCashSatang: number } | null;
      heldBackSatang: number | null;
      broughtForwardSatang: number | null;
    }>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { roomCashSatang: 77_000 });
    expect(clearedAdjustment.body.entered?.roomCashSatang).toBe(77_000);
    expect(clearedAdjustment.body.heldBackSatang).toBeNull();
    expect(clearedAdjustment.body.broughtForwardSatang).toBeNull();

    // Re-establish the adjustment, then re-send it alone (mirrors
    // clearCashOverride()'s adjustment-preserving branch) to clear ONLY the
    // override.
    await call("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { roomCashSatang: 77_000, heldBackSatang: 3_000 });
    const clearedOverride = await call<{
      entered: unknown;
      heldBackSatang: number | null;
    }>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { heldBackSatang: 3_000 });
    expect(clearedOverride.body.entered).toBeNull();
    expect(clearedOverride.body.heldBackSatang).toBe(3_000);
  });
});

// P0 (Opus money-review, 2026-07-31): mergeCashBlockOverride() fully
// populates `entered` (every field, including bankedSatang) the moment ANY
// ONE of the four CashBlockAmounts fields is overridden — untouched fields
// fall back to `derived` AT MERGE TIME. Blindly re-sending that merged
// document in a later PUT (what every commit handler did before the fix)
// stores the PRE-adjustment `bankedSatang` snapshot as a real, permanent
// override, which then wins forever over any later recomputation. These
// tests build each PUT body through the ACTUAL production helpers
// (src/client/cashBlockPatches.ts) — the same functions DaySheetPage.tsx
// and BookingDayPage.tsx import — starting from the FULL merged `entered`
// document the previous response actually returned, never a hand-picked
// "obviously correct" body. This is "what the client actually sends," proven
// end to end through the real API.
describe("client-simulated commit sequences (Opus money-review P0, 2026-07-31)", () => {
  function bankedShown(cb: Pick<CashBlock, "derived" | "entered">): number {
    return cb.entered?.bankedSatang ?? cb.derived.bankedSatang;
  }

  test("edit-after-override: override a component, record/correct held-back, override another component — the bank line always moves by the LIVE adjustment, never a stale snapshot", async () => {
    const DATE = "2026-04-11";
    await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("room_cash")}`, {
      amountSatang: 50_000,
      note: null,
    });

    // Step 1: override roomCashSatang (till-count correction, no
    // adjustment recorded yet).
    const step1 = await call<CashBlock>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { roomCashSatang: 60_000 });
    expect(step1.status).toBe(200);
    const bankedBeforeAdjustment = bankedShown(step1.body);
    expect(bankedBeforeAdjustment).toBe(50_000); // bankedSatang was never itself overridden

    // Step 2: record heldBackSatang = 30.00 baht. The client builds this
    // PUT body from step1's FULL merged `entered` document (roomCashSatang
    // overridden; otherCashSatang/barCashSatang/bankedSatang all present
    // too, each having fallen back to derived) — proving the filtering
    // actually strips the untouched fields rather than re-pinning them.
    const step2Body = {
      ...activeCashOverridePatch(step1.body),
      ...activeCashAdjustmentPatch(step1.body),
      heldBackSatang: 3_000,
    };
    expect(step2Body).toEqual({ roomCashSatang: 60_000, heldBackSatang: 3_000 });
    const step2 = await call<CashBlock>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, step2Body);
    // THE PROVEN BUG: pre-fix, this stayed at bankedBeforeAdjustment
    // (unchanged) because the stale merged bankedSatang had been pinned as
    // a permanent override.
    expect(bankedShown(step2.body)).toBe(bankedBeforeAdjustment - 3_000);

    // Step 3: override barCashSatang too (a second till-count correction,
    // interleaved with the adjustment already in place).
    await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("bar_cash")}`, {
      amountSatang: 2_000,
      note: null,
    });
    const step3Body = {
      ...activeCashOverridePatch(step2.body),
      ...activeCashAdjustmentPatch(step2.body),
      barCashSatang: 5_000,
    };
    expect(step3Body).toEqual({ roomCashSatang: 60_000, heldBackSatang: 3_000, barCashSatang: 5_000 });
    const step3 = await call<CashBlock>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, step3Body);
    expect(bankedShown(step3.body)).toBe(50_000 + 2_000 - 3_000); // room + bar cash - held-back

    // Step 4: correct the held-back figure from 30.00 to 40.00 baht — THE
    // PROVEN BUG: pre-fix this went stale (still reflecting the OLD 30.00
    // deduction) because re-sending the merged document each time kept
    // re-pinning whatever bankedSatang snapshot existed at commit time.
    const step4Body = {
      ...activeCashOverridePatch(step3.body),
      ...activeCashAdjustmentPatch(step3.body),
      heldBackSatang: 4_000,
    };
    expect(step4Body).toEqual({ roomCashSatang: 60_000, barCashSatang: 5_000, heldBackSatang: 4_000 });
    const step4 = await call<CashBlock>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, step4Body);
    expect(bankedShown(step4.body)).toBe(50_000 + 2_000 - 4_000); // NOT stale at the old 30.00 deduction
  });

  test("clear-after-override: clearing the adjustment removes both its deduction AND its explanatory row, leaving the override untouched", async () => {
    const DATE = "2026-04-12";
    await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("room_cash")}`, {
      amountSatang: 40_000,
      note: null,
    });

    // Override roomCashSatang, then record a held-back adjustment on top.
    const overridden = await call<CashBlock>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, {
      roomCashSatang: 45_000,
    });
    const withAdjustment = await call<CashBlock>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, {
      ...activeCashOverridePatch(overridden.body),
      heldBackSatang: 5_000,
    });
    expect(bankedShown(withAdjustment.body)).toBe(40_000 - 5_000);

    // clearCashAdjustment()'s exact body: the currently-active override
    // patch, with the adjustment fields omitted entirely (never re-sent,
    // not even as an explicit 0) — never a blind `entered` spread.
    const clearBody = activeCashOverridePatch(withAdjustment.body);
    expect(clearBody).toEqual({ roomCashSatang: 45_000 });
    const cleared = await call<CashBlock>("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, clearBody);

    // THE PROVEN BUG: pre-fix, the -5,000 deduction stayed baked into
    // bankedSatang (a pinned stale snapshot) even after heldBackSatang
    // itself went back to null — a deduction with no row left to explain
    // it. Fixed: the bank line returns to its pre-adjustment figure...
    expect(cleared.body.heldBackSatang).toBeNull();
    expect(cleared.body.broughtForwardSatang).toBeNull();
    expect(bankedShown(cleared.body)).toBe(40_000);
    // ...while the unrelated till-count override survives untouched.
    expect(cleared.body.entered?.roomCashSatang).toBe(45_000);
  });
});

// P3 (Opus money-review, 2026-07-31): PUT income/:categoryId now also
// returns the freshly recomputed cashBlock — without it, the day page's
// "ยอดฝากจริง" bold line (and the print portal's export of it) went stale
// after every income edit until the next full day reload.
describe("PUT income cell response includes the recomputed cashBlock (Opus money-review P3, 2026-07-31)", () => {
  const DATE = "2026-04-13";

  test("cashBlock in the PUT income response reflects the just-written cash income immediately, without a follow-up GET", async () => {
    const first = await call<{ cashBlock: { derived: { bankedSatang: number } } }>(
      "PUT",
      `/${PROPERTY}/day/${DATE}/income/${categoryId("room_cash")}`,
      { amountSatang: 30_000, note: null },
    );
    expect(first.status).toBe(200);
    expect(first.body.cashBlock.derived.bankedSatang).toBe(30_000);

    const second = await call<{ cashBlock: { derived: { bankedSatang: number } } }>(
      "PUT",
      `/${PROPERTY}/day/${DATE}/income/${categoryId("bar_cash")}`,
      { amountSatang: 5_000, note: null },
    );
    expect(second.body.cashBlock.derived.bankedSatang).toBe(35_000);
  });

  test("an active heldBack/broughtForward adjustment still applies to the cashBlock returned by a PUT income response", async () => {
    await call("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { heldBackSatang: 10_000 });
    const res = await call<{
      cashBlock: { derived: { bankedSatang: number }; heldBackSatang: number | null };
    }>("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("room_cash")}`, { amountSatang: 50_000, note: null });
    expect(res.body.cashBlock.heldBackSatang).toBe(10_000);
    // 50,000 room (just written) + 5,000 bar (from the previous test) -
    // 10,000 held back.
    expect(res.body.cashBlock.derived.bankedSatang).toBe(50_000 + 5_000 - 10_000);
  });
});

describe("a day whose only money is itemized other-income", () => {
  // Real production case: hfville 2025-10-20 held one 60-baht pool fee and
  // nothing else, and was invisible to GET /days (and to the analytics
  // backfill, same UNION) until the other_income_items arm was added.
  const DATE = "2026-04-05";

  test("surfaces in GET /days", async () => {
    const created = await call("POST", `/${PROPERTY}/day/${DATE}/other-income`, {
      description: "ค่าเล่นสระน้ำ เด็ก",
      amountSatang: 6_000,
      isCash: true,
    });
    expect(created.status).toBe(201);

    const days = await call<{ days: Array<{ date: string }> }>("GET", `/${PROPERTY}/days?month=2026-04`);
    expect(days.status).toBe(200);
    expect(days.body.days.some((d) => d.date === DATE)).toBe(true);

    const id = (created.body as { id: number }).id;
    await call("DELETE", `/${PROPERTY}/other-income/${id}`);
  });
});

describe("move a booking day to the other property", () => {
  const OTHER: Property = "hfville";

  describe("clean move: rows land on the destination, source day left empty", () => {
    const DATE = "2026-05-01";

    test("moves booking lines (renumbered seq 1..n) and other-income items", async () => {
      await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
        guestName: "ผู้เข้าพัก A",
        tenders: zeroTenders(),
      });
      await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
        guestName: "ผู้เข้าพัก B",
        tenders: zeroTenders(),
      });
      await call("POST", `/${PROPERTY}/day/${DATE}/other-income`, {
        description: "ค่าจอดรถ",
        amountSatang: 2_000,
        isCash: true,
      });

      const moved = await call<{ movedBookingLines: number; movedOtherIncome: number }>(
        "POST",
        `/${PROPERTY}/day/${DATE}/move`,
        { to: OTHER },
      );
      expect(moved.status).toBe(200);
      expect(moved.body.movedBookingLines).toBe(2);
      expect(moved.body.movedOtherIncome).toBe(1);

      const sourceBookings = await call<{ lines: unknown[] }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
      expect(sourceBookings.body.lines).toHaveLength(0);

      const destBookings = await call<{ lines: Array<{ seq: number; guestName: string | null }> }>(
        "GET",
        `/${OTHER}/day/${DATE}/bookings`,
      );
      expect(destBookings.body.lines.map((l) => l.seq)).toEqual([1, 2]);
      expect(destBookings.body.lines.map((l) => l.guestName)).toEqual(["ผู้เข้าพัก A", "ผู้เข้าพัก B"]);

      const destDay = await call<{ otherIncome: Array<{ description: string | null; amountSatang: number }> }>(
        "GET",
        `/${OTHER}/day/${DATE}`,
      );
      expect(destDay.body.otherIncome).toHaveLength(1);
      expect(destDay.body.otherIncome[0]?.amountSatang).toBe(2_000);
    });

    // F2 (Opus money-review, 2026-07-31): moveBookingDay used to strand
    // deposit_events on the origin property — a moved day's cash มัดจำล่วงหน้า
    // kept reaching the WRONG side's ยอดฝากจริง forever. Needs a post-cutover
    // date, since deposit_events writes are gated by isAccrualDay.
    test("F2 regression: also moves this day's deposit_events, so the destination's cash block picks up the deposit cash", async () => {
      const DEPOSIT_DATE = "2026-08-23"; // on/after the 2026-07-31 cutover
      await call("POST", `/${PROPERTY}/day/${DEPOSIT_DATE}/deposits`, {
        kind: "received",
        bookingNo: "R020010",
        guestName: "ทดสอบ ย้ายมัดจำ",
        tender: "cash",
        amountSatang: 89_000,
        note: null,
      });

      const moved = await call<{ movedBookingLines: number; movedOtherIncome: number; movedDepositEvents: number }>(
        "POST",
        `/${PROPERTY}/day/${DEPOSIT_DATE}/move`,
        { to: OTHER },
      );
      expect(moved.status).toBe(200);
      expect(moved.body.movedDepositEvents).toBe(1);

      const sourceDay = await call<{ deposits: unknown[]; cashBlock: { depositCashInSatang: number } }>(
        "GET",
        `/${PROPERTY}/day/${DEPOSIT_DATE}`,
      );
      expect(sourceDay.body.deposits).toEqual([]);
      expect(sourceDay.body.cashBlock.depositCashInSatang).toBe(0);

      const destDay = await call<{
        deposits: Array<{ bookingNo: string | null; amountSatang: number }>;
        cashBlock: { depositCashInSatang: number };
      }>("GET", `/${OTHER}/day/${DEPOSIT_DATE}`);
      expect(destDay.body.deposits).toHaveLength(1);
      expect(destDay.body.deposits[0]).toMatchObject({ bookingNo: "R020010", amountSatang: 89_000 });
      expect(destDay.body.cashBlock.depositCashInSatang).toBe(89_000);
    });
  });

  describe("merge into a non-empty destination", () => {
    const DATE = "2026-05-02";

    test("moved rows renumber contiguously after the destination's existing max seq, order preserved", async () => {
      await call("POST", `/${OTHER}/day/${DATE}/bookings`, { guestName: "ปลายทาง 1", tenders: zeroTenders() });
      await call("POST", `/${OTHER}/day/${DATE}/bookings`, { guestName: "ปลายทาง 2", tenders: zeroTenders() });

      await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, { guestName: "ต้นทาง 1", tenders: zeroTenders() });
      await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, { guestName: "ต้นทาง 2", tenders: zeroTenders() });
      await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, { guestName: "ต้นทาง 3", tenders: zeroTenders() });

      const moved = await call<{ movedBookingLines: number }>("POST", `/${PROPERTY}/day/${DATE}/move`, {
        to: OTHER,
      });
      expect(moved.status).toBe(200);
      expect(moved.body.movedBookingLines).toBe(3);

      const dest = await call<{ lines: Array<{ seq: number; guestName: string | null }> }>(
        "GET",
        `/${OTHER}/day/${DATE}/bookings`,
      );
      const seqs = dest.body.lines.map((l) => l.seq);
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(seqs).size).toBe(seqs.length); // no duplicates

      expect(dest.body.lines.map((l) => l.guestName)).toEqual([
        "ปลายทาง 1",
        "ปลายทาง 2",
        "ต้นทาง 1",
        "ต้นทาง 2",
        "ต้นทาง 3",
      ]);

      const source = await call<{ lines: unknown[] }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
      expect(source.body.lines).toHaveLength(0);
    });
  });

  describe("validation", () => {
    const DATE = "2026-05-04";

    test("400 when to equals the source property", async () => {
      const res = await call("POST", `/${PROPERTY}/day/${DATE}/move`, { to: PROPERTY });
      expect(res.status).toBe(400);
    });

    test("400 when to is an unknown property", async () => {
      const res = await call("POST", `/${PROPERTY}/day/${DATE}/move`, { to: "not-a-property" });
      expect(res.status).toBe(400);
    });

    test("400 when to is absent", async () => {
      const res = await call("POST", `/${PROPERTY}/day/${DATE}/move`, {});
      expect(res.status).toBe(400);
    });
  });

  describe("month-close guards", () => {
    test("409 when the SOURCE month is closed", async () => {
      const MONTH = "2026-06";
      const DATE = "2026-06-10";
      await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });

      const res = await call("POST", `/${PROPERTY}/day/${DATE}/move`, { to: OTHER });
      expect(res.status).toBe(409);

      await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: false });
    });

    test("409 when the DESTINATION month is closed", async () => {
      const MONTH = "2026-07";
      const DATE = "2026-07-10";
      await call("PUT", `/${OTHER}/months/${MONTH}/close`, { closed: true });

      const res = await call("POST", `/${PROPERTY}/day/${DATE}/move`, { to: OTHER });
      expect(res.status).toBe(409);

      await call("PUT", `/${OTHER}/months/${MONTH}/close`, { closed: false });
    });
  });

  describe("the day sheet itself is out of scope", () => {
    const DATE = "2026-05-10";

    test("income cells and the cash-block override on BOTH sides survive a move unchanged", async () => {
      await call("PUT", `/${PROPERTY}/day/${DATE}/income/${categoryId("room_cash")}`, {
        amountSatang: 12_300,
        note: null,
      });
      await call("PUT", `/${PROPERTY}/day/${DATE}/cash-block`, { bankedSatang: 45_600 });
      await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
        guestName: "ผู้เข้าพักย้าย",
        tenders: zeroTenders(),
      });

      const beforeDest = await call<{ income: Record<number, unknown>; cashBlock: { entered: unknown } }>(
        "GET",
        `/${OTHER}/day/${DATE}`,
      );

      const moved = await call("POST", `/${PROPERTY}/day/${DATE}/move`, { to: OTHER });
      expect(moved.status).toBe(200);

      const afterSource = await call<{
        income: Record<number, { amountSatang: number }>;
        cashBlock: { entered: { bankedSatang: number } | null };
      }>("GET", `/${PROPERTY}/day/${DATE}`);
      expect(afterSource.body.income[categoryId("room_cash")]?.amountSatang).toBe(12_300);
      expect(afterSource.body.cashBlock.entered?.bankedSatang).toBe(45_600);

      const afterDest = await call<{ income: Record<number, unknown>; cashBlock: { entered: unknown } }>(
        "GET",
        `/${OTHER}/day/${DATE}`,
      );
      expect(afterDest.body.income).toEqual(beforeDest.body.income);
      expect(afterDest.body.cashBlock.entered).toEqual(beforeDest.body.cashBlock.entered);

      // The booking line itself did move — proves the move actually ran.
      const sourceBookings = await call<{ lines: unknown[] }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
      expect(sourceBookings.body.lines).toHaveLength(0);
    });
  });
});

describe("PMS prefill: POST /:property/day/:date/pull-from-pms", () => {
  // "hf" is PROPERTY's env URL per the locked env-var mapping
  // (PMS_DB_URL_HF / PMS_DB_URL_HFVILLE) — see pms-prefill.ts / api.md.
  // All dates in this describe block are on/after both properties' accrual
  // cutover (2026-07-31, shared/accrual.ts) unless a test says otherwise —
  // see the dedicated "pre-cutover" describe block below for that gate.
  function pmsCandidate(overrides: Partial<PrefillCandidate> = {}): PrefillCandidate {
    return {
      pmsRef: "R2608-0000",
      bookingNo: "CH26-000000",
      guestName: "ทดสอบ พีเอ็มเอส",
      roomNo: "101",
      roomCount: 1,
      nights: 1,
      grossRoomSatang: 100_000,
      grossOtherSatang: 0,
      cashSatang: 0,
      webSatang: 0,
      unplacedCreditSatang: 0,
      unplacedTranSatang: 0,
      appliedDepositSatang: 0,
      appliedDepositBookingNos: [],
      isRefund: false,
      ...overrides,
    };
  }

  function depositCandidate(overrides: Partial<DepositCandidate> = {}): DepositCandidate {
    return {
      pmsRef: "R2608-9000",
      kind: "received",
      bookingNo: "R014000",
      guestName: "ทดสอบ มัดจำ",
      tender: "cash",
      amountSatang: 50_000,
      note: null,
      ...overrides,
    };
  }

  /** Wraps booking/deposit candidate arrays into the fetchDayPayments
   * MapLedgerRowsResult shape the test override now returns. */
  function pmsResult(
    bookingCandidates: PrefillCandidate[] = [],
    depositCandidates: DepositCandidate[] = [],
    anomalies: PrefillAnomaly[] = [],
  ) {
    return { bookingCandidates, depositCandidates, anomalies };
  }

  // Every test starts from env unset; tests that need it configured set it
  // themselves. Restoring to unset (rather than to whatever it was before
  // the file ran, which is always undefined in this suite) keeps the 328
  // pre-existing tests, which never touch this env var, unaffected either way.
  afterEach(() => {
    pmsPrefillInternal.setFetchDayPaymentsForTests(null);
    delete process.env.PMS_DB_URL_HF;
    delete process.env.PMS_DB_URL_HFVILLE;
  });

  test("503 when the property's PMS env URL is unset", async () => {
    delete process.env.PMS_DB_URL_HF;
    const res = await call("POST", `/${PROPERTY}/day/2026-08-01/pull-from-pms`);
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe("pms prefill not configured");
  });

  test("inserts two candidates: visible via GET bookings with correct seq continuation, tenders mapped, transfer_kbank auto-placed (hf credit stays unplaced)", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-08-02";

    await call("POST", `/${PROPERTY}/day/${DATE}/bookings`, { guestName: "จองด้วยมือก่อน", tenders: zeroTenders() });

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      pmsResult([
        pmsCandidate({
          pmsRef: "R2608-0101",
          bookingNo: "CH26-000101",
          roomNo: "101",
          cashSatang: 100_000,
          appliedDepositSatang: 20_000,
          appliedDepositBookingNos: ["R014843"],
          unplacedTranSatang: 30_000,
          unplacedCreditSatang: 12_000,
        }),
        pmsCandidate({ pmsRef: "R2608-0102", bookingNo: "CH26-000102", roomNo: "102", webSatang: 75_000 }),
      ]),
    );

    const pulled = await call<{
      inserted: number;
      skipped: number;
      skippedRefunds: number;
      unplaced: Array<{ pmsRef: string; bookingNo: string | null; creditSatang: number; tranSatang: number }>;
      autoPlaced: Array<{ pmsRef: string; bookingNo: string | null; transferSatang: number; creditSatang: number }>;
      depositsInserted: number;
      depositsSkipped: number;
      anomalies: unknown[];
    }>("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    expect(pulled.status).toBe(200);
    expect(pulled.body.inserted).toBe(2);
    expect(pulled.body.skipped).toBe(0);
    expect(pulled.body.skippedRefunds).toBe(0);
    expect(pulled.body.depositsInserted).toBe(0);
    expect(pulled.body.depositsSkipped).toBe(0);
    expect(pulled.body.anomalies).toEqual([]);
    // hf: credit cannot be inferred (two banks in use there) — stays unplaced.
    expect(pulled.body.unplaced).toEqual([
      { pmsRef: "R2608-0101", bookingNo: "CH26-000101", creditSatang: 12_000, tranSatang: 0 },
    ]);
    // transfer is auto-placed for every property — reported for verification.
    expect(pulled.body.autoPlaced).toEqual([
      { pmsRef: "R2608-0101", bookingNo: "CH26-000101", transferSatang: 30_000, creditSatang: 0 },
    ]);

    const bookings = await call<{
      lines: Array<{
        seq: number;
        bookingNo: string | null;
        source: string;
        draft: boolean;
        remark: string | null;
        tenders: Record<Tender, number>;
      }>;
    }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    expect(bookings.body.lines.map((l) => l.seq)).toEqual([1, 2, 3]);

    const first = bookings.body.lines.find((l) => l.bookingNo === "CH26-000101")!;
    expect(first.source).toBe("pms");
    expect(first.draft).toBe(false);
    expect(first.tenders.cash).toBe(100_000);
    // Wave C: t_deposit is NEVER written by the importer any more — the
    // applied amount lands in the ninth tender instead.
    expect(first.tenders.deposit).toBe(0);
    expect(first.tenders.deposit_applied).toBe(20_000);
    expect(first.remark).toBe("ตัดยอดมัดจำ: R014843");
    // transfer_kbank now carries the auto-placed amount (the fixed money bug).
    expect(first.tenders.transfer_kbank).toBe(30_000);
    // credit stays unwritten on "hf" — two credit banks in use, cannot be inferred.
    expect(first.tenders.credit_kbank).toBe(0);
    expect(first.tenders.credit_icbc).toBe(0);
    expect(first.tenders.transfer_icbc).toBe(0);
    expect(first.tenders.other).toBe(0);

    const second = bookings.body.lines.find((l) => l.bookingNo === "CH26-000102")!;
    expect(second.tenders.web).toBe(75_000);
    expect(second.tenders.credit_kbank).toBe(0);
    expect(second.tenders.transfer_kbank).toBe(0);
  });

  test("credit_kbank is auto-placed for hfville (single credit bank in that property's history) — nothing left unplaced", async () => {
    process.env.PMS_DB_URL_HFVILLE = "postgresql://readonly@fake-pms-test/hfville";
    const HFVILLE = "hfville";
    const DATE = "2026-08-02";

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      pmsResult([
        pmsCandidate({
          pmsRef: "R2608-0501",
          bookingNo: "CH26-000501",
          cashSatang: 10_000,
          unplacedCreditSatang: 18_000,
          unplacedTranSatang: 5_000,
        }),
      ]),
    );

    const pulled = await call<{
      inserted: number;
      unplaced: unknown[];
      autoPlaced: Array<{ pmsRef: string; bookingNo: string | null; transferSatang: number; creditSatang: number }>;
    }>("POST", `/${HFVILLE}/day/${DATE}/pull-from-pms`);
    expect(pulled.body.inserted).toBe(1);
    expect(pulled.body.unplaced).toEqual([]);
    expect(pulled.body.autoPlaced).toEqual([
      { pmsRef: "R2608-0501", bookingNo: "CH26-000501", transferSatang: 5_000, creditSatang: 18_000 },
    ]);

    const bookings = await call<{ lines: Array<{ bookingNo: string | null; tenders: Record<Tender, number> }> }>(
      "GET",
      `/${HFVILLE}/day/${DATE}/bookings`,
    );
    const line = bookings.body.lines.find((l) => l.bookingNo === "CH26-000501")!;
    expect(line.tenders.credit_kbank).toBe(18_000);
    expect(line.tenders.transfer_kbank).toBe(5_000);
    expect(line.tenders.credit_icbc).toBe(0);
    expect(line.tenders.transfer_icbc).toBe(0);
  });

  test("hf credit stays unplaced and unwritten: two credit banks genuinely in use on that property, PMS records neither", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-08-08";

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      pmsResult([
        pmsCandidate({ pmsRef: "R2608-0601", bookingNo: "CH26-000601", cashSatang: 20_000, unplacedCreditSatang: 9_000 }),
      ]),
    );

    const pulled = await call<{
      unplaced: Array<{ pmsRef: string; bookingNo: string | null; creditSatang: number; tranSatang: number }>;
      autoPlaced: unknown[];
    }>("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    expect(pulled.body.unplaced).toEqual([
      { pmsRef: "R2608-0601", bookingNo: "CH26-000601", creditSatang: 9_000, tranSatang: 0 },
    ]);
    // Nothing was auto-placed for this candidate — no transfer, and hf credit isn't auto-placed.
    expect(pulled.body.autoPlaced).toEqual([]);

    const bookings = await call<{ lines: Array<{ bookingNo: string | null; tenders: Record<Tender, number> }> }>(
      "GET",
      `/${PROPERTY}/day/${DATE}/bookings`,
    );
    const line = bookings.body.lines.find((l) => l.bookingNo === "CH26-000601")!;
    expect(line.tenders.credit_kbank).toBe(0);
  });

  // Regression for the confirmed production money bug (2026-07-31): a real
  // ประภัสสร-shaped hfville payment — ค่าห้อง 2,500, เงินสด 1,250, เงินโอน
  // 1,250 — was previously inserted with only t_cash populated, silently
  // dropping the 1,250 THB transfer (docs/plan-unify-exports-tender-split.md
  // item 4). transfer_kbank must now carry it on every property.
  test("regression: ประภัสสร-shaped candidate (cash 1,250 + transfer 1,250, gross 2,500) inserts with both t_cash and transfer_kbank populated", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-08-09";

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      pmsResult([
        pmsCandidate({
          pmsRef: "R2607-0701",
          bookingNo: "CH26-000701",
          grossRoomSatang: 250_000,
          grossOtherSatang: 0,
          cashSatang: 125_000,
          unplacedTranSatang: 125_000,
        }),
      ]),
    );

    const pulled = await call<{ inserted: number }>("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    expect(pulled.body.inserted).toBe(1);

    const bookings = await call<{ lines: Array<{ bookingNo: string | null; tenders: Record<Tender, number> }> }>(
      "GET",
      `/${PROPERTY}/day/${DATE}/bookings`,
    );
    const line = bookings.body.lines.find((l) => l.bookingNo === "CH26-000701")!;
    expect(line.tenders.cash).toBe(125_000);
    expect(line.tenders.transfer_kbank).toBe(125_000);
  });

  test("pressing pull-from-pms twice is idempotent: the second press skips every candidate, no duplicate rows", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-08-03";

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      pmsResult([
        pmsCandidate({ pmsRef: "R2608-0201", bookingNo: "CH26-000201", cashSatang: 50_000 }),
        pmsCandidate({ pmsRef: "R2608-0202", bookingNo: "CH26-000202", webSatang: 25_000 }),
      ]),
    );

    const first = await call<{ inserted: number; skipped: number }>(
      "POST",
      `/${PROPERTY}/day/${DATE}/pull-from-pms`,
    );
    expect(first.body.inserted).toBe(2);
    expect(first.body.skipped).toBe(0);

    const second = await call<{ inserted: number; skipped: number }>(
      "POST",
      `/${PROPERTY}/day/${DATE}/pull-from-pms`,
    );
    expect(second.body.inserted).toBe(0);
    expect(second.body.skipped).toBe(2);

    const bookings = await call<{ lines: unknown[] }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    expect(bookings.body.lines).toHaveLength(2);
  });

  test("a refund candidate is skipped and counted, never inserted", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-08-04";

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      pmsResult([
        pmsCandidate({ pmsRef: "R2608-0301", bookingNo: "CH26-000301", cashSatang: 40_000 }),
        pmsCandidate({ pmsRef: "R2608-0302", bookingNo: "CH26-000302", cashSatang: -10_000, isRefund: true }),
      ]),
    );

    const pulled = await call<{ inserted: number; skipped: number; skippedRefunds: number }>(
      "POST",
      `/${PROPERTY}/day/${DATE}/pull-from-pms`,
    );
    expect(pulled.body.inserted).toBe(1);
    expect(pulled.body.skipped).toBe(0);
    expect(pulled.body.skippedRefunds).toBe(1);

    const bookings = await call<{ lines: Array<{ bookingNo: string | null }> }>(
      "GET",
      `/${PROPERTY}/day/${DATE}/bookings`,
    );
    expect(bookings.body.lines).toHaveLength(1);
    expect(bookings.body.lines[0]?.bookingNo).toBe("CH26-000301");
  });

  test("unplaced now lists only genuinely-unplaced hf credit; transfer is auto-placed and reported via autoPlaced instead", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-08-05";

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      pmsResult([
        pmsCandidate({
          pmsRef: "R2608-0401",
          bookingNo: "CH26-000401",
          cashSatang: 10_000,
          unplacedCreditSatang: 15_000,
        }),
        pmsCandidate({
          pmsRef: "R2608-0402",
          bookingNo: "CH26-000402",
          webSatang: 5_000,
          unplacedTranSatang: 8_000,
        }),
        pmsCandidate({ pmsRef: "R2608-0403", bookingNo: "CH26-000403", cashSatang: 1_000 }), // fully placed
      ]),
    );

    const pulled = await call<{
      unplaced: Array<{ pmsRef: string; bookingNo: string | null; creditSatang: number; tranSatang: number }>;
      autoPlaced: Array<{ pmsRef: string; bookingNo: string | null; transferSatang: number; creditSatang: number }>;
    }>("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    // Only the hf credit amount remains genuinely unplaced.
    expect(pulled.body.unplaced).toEqual([
      { pmsRef: "R2608-0401", bookingNo: "CH26-000401", creditSatang: 15_000, tranSatang: 0 },
    ]);
    // The transfer amount was auto-placed into transfer_kbank instead.
    expect(pulled.body.autoPlaced).toEqual([
      { pmsRef: "R2608-0402", bookingNo: "CH26-000402", transferSatang: 8_000, creditSatang: 0 },
    ]);
  });

  test("409 when the month is closed", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const MONTH = "2026-09";
    const DATE = "2026-09-15";
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => pmsResult([pmsCandidate({ pmsRef: "R2609-0001" })]));

    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });
    const res = await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    expect(res.status).toBe(409);
    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: false });

    const bookings = await call<{ lines: unknown[] }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    expect(bookings.body.lines).toHaveLength(0);
  });

  test("502 when the PMS fetch throws, and nothing is inserted", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-08-06";
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => {
      throw new Error("connection refused");
    });

    const res = await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toBe("connection refused");

    const bookings = await call<{ lines: unknown[] }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    expect(bookings.body.lines).toHaveLength(0);
  });

  test("GET bookings exposes pmsPull as this property's capability flag", async () => {
    const DATE = "2026-08-07";
    delete process.env.PMS_DB_URL_HF;
    const unconfigured = await call<{ pmsPull: boolean }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    expect(unconfigured.body.pmsPull).toBe(false);

    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const configured = await call<{ pmsPull: boolean }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    expect(configured.body.pmsPull).toBe(true);
  });

  // ── Wave D, D5: re-pull change detection (the office deposit register's
  // sibling fix, issue #5) — a re-pull of an ALREADY-imported day must
  // still skip the existing row (hand edits are sacred — insert-only NEVER
  // changes), but now ALSO reports a `changed` diff when the fresh PMS
  // candidate disagrees with what is currently stored, so the office can
  // see it and decide (see `PmsPullResultDialog.tsx` on the client, and the
  // accept-pms-update tests below for the "apply the diff" half).
  describe("re-pull change detection (Wave D, D5)", () => {
    test("an unchanged existing row: skipped, changed is empty, the stored row is untouched", async () => {
      process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
      const DATE = "2026-09-20";
      pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
        pmsResult([pmsCandidate({ pmsRef: "R2609-9001", bookingNo: "CH26-900001", cashSatang: 100_000 })]),
      );
      await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);

      const second = await call<{ inserted: number; skipped: number; changed: unknown[] }>(
        "POST",
        `/${PROPERTY}/day/${DATE}/pull-from-pms`,
      );
      expect(second.body.inserted).toBe(0);
      expect(second.body.skipped).toBe(1);
      expect(second.body.changed).toEqual([]);
    });

    test("a fresh candidate differing on gross room + tenders: reported in `changed`, never written — the stored row is provably untouched", async () => {
      process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
      const DATE = "2026-09-21";
      pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
        pmsResult([
          pmsCandidate({ pmsRef: "R2609-9002", bookingNo: "CH26-900002", grossRoomSatang: 100_000, cashSatang: 100_000 }),
        ]),
      );
      await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
      const before = await call<{ lines: Array<{ id: number; grossRoomSatang: number; tenders: Record<Tender, number>; updatedAt: string } > }>(
        "GET",
        `/${PROPERTY}/day/${DATE}/bookings`,
      );
      const storedId = before.body.lines[0]!.id;

      // The PMS now says 1,200 (was 1,000) — reception amended the folio.
      pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
        pmsResult([
          pmsCandidate({ pmsRef: "R2609-9002", bookingNo: "CH26-900002", grossRoomSatang: 120_000, cashSatang: 120_000 }),
        ]),
      );
      const pulled = await call<{
        inserted: number;
        skipped: number;
        changed: Array<{ id: number; pmsRef: string; bookingNo: string | null; handEdited: boolean; fields: Array<{ field: string; before: unknown; after: unknown }> }>;
      }>("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);

      expect(pulled.body.inserted).toBe(0);
      expect(pulled.body.skipped).toBe(1);
      expect(pulled.body.changed).toHaveLength(1);
      const change = pulled.body.changed[0]!;
      expect(change.id).toBe(storedId);
      expect(change.pmsRef).toBe("R2609-9002");
      expect(change.handEdited).toBe(false);
      expect(change.fields).toEqual(
        expect.arrayContaining([
          { field: "grossRoomSatang", before: 100_000, after: 120_000 },
          { field: "cash", before: 100_000, after: 120_000 },
        ]),
      );

      // The stored row is PROVABLY untouched — insert-only never writes on skip.
      const after = await call<{ lines: Array<{ id: number; grossRoomSatang: number; updatedAt: string }> }>(
        "GET",
        `/${PROPERTY}/day/${DATE}/bookings`,
      );
      expect(after.body.lines[0]!.grossRoomSatang).toBe(100_000);
      expect(after.body.lines[0]!.updatedAt).toBe(before.body.lines[0]!.updatedAt);
    });

    test("handEdited is true once a hand edit bumped updatedAt past createdAt", async () => {
      process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
      const DATE = "2026-09-22";
      pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
        pmsResult([pmsCandidate({ pmsRef: "R2609-9003", bookingNo: "CH26-900003", cashSatang: 50_000 })]),
      );
      await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
      const before = await call<{ lines: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
      const id = before.body.lines[0]!.id;

      // `handEdited` compares SQLite `datetime('now')` strings, which are
      // only SECOND-resolution — without a real gap here, a fast test run
      // could insert-then-patch inside the same wall-clock second and
      // updatedAt would equal createdAt even though a hand edit happened.
      await Bun.sleep(1100);

      // A hand edit — the office corrected the guest name.
      await call("PATCH", `/${PROPERTY}/bookings/${id}`, { guestName: "แก้ไขด้วยมือ" });

      pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
        pmsResult([pmsCandidate({ pmsRef: "R2609-9003", bookingNo: "CH26-900003", cashSatang: 55_000 })]),
      );
      const pulled = await call<{ changed: Array<{ handEdited: boolean }> }>(
        "POST",
        `/${PROPERTY}/day/${DATE}/pull-from-pms`,
      );
      expect(pulled.body.changed).toHaveLength(1);
      expect(pulled.body.changed[0]!.handEdited).toBe(true);
    });
  });

  // ── Wave C: deposit events ride along the same pull ────────────────────
  describe("deposit events (Wave C, docs/adr/0001)", () => {
    test("inserts received + refunded deposit candidates as deposit_events, idempotently", async () => {
      process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
      const DATE = "2026-08-10";

      pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
        pmsResult(
          [],
          [
            depositCandidate({ pmsRef: "R2608-9001", kind: "received", bookingNo: "R014001", tender: "cash", amountSatang: 89_000 }),
            depositCandidate({ pmsRef: "R2608-9002", kind: "refunded", bookingNo: "R014002", tender: "transfer", amountSatang: 39_500 }),
          ],
        ),
      );

      const first = await call<{ depositsInserted: number; depositsSkipped: number; anomalies: unknown[] }>(
        "POST",
        `/${PROPERTY}/day/${DATE}/pull-from-pms`,
      );
      expect(first.body.depositsInserted).toBe(2);
      expect(first.body.depositsSkipped).toBe(0);
      expect(first.body.anomalies).toEqual([]);

      const day = await call<{ deposits: Array<{ kind: string; bookingNo: string | null; amountSatang: number }> }>(
        "GET",
        `/${PROPERTY}/day/${DATE}`,
      );
      expect(day.body.deposits).toHaveLength(2);
      expect(day.body.deposits.find((d) => d.bookingNo === "R014001")).toMatchObject({ kind: "received", amountSatang: 89_000 });
      expect(day.body.deposits.find((d) => d.bookingNo === "R014002")).toMatchObject({ kind: "refunded", amountSatang: 39_500 });

      const second = await call<{ depositsInserted: number; depositsSkipped: number }>(
        "POST",
        `/${PROPERTY}/day/${DATE}/pull-from-pms`,
      );
      expect(second.body.depositsInserted).toBe(0);
      expect(second.body.depositsSkipped).toBe(2);
    });

    test("anomalies from the importer pass straight through, additive to depositsInserted/Skipped", async () => {
      process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
      const DATE = "2026-08-11";

      pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
        pmsResult([], [], [{ pmsRef: "R2608-9100", reason: "mixed_scope", detail: "จ่ายล่วงหน้า, ค่าห้อง" }]),
      );

      const pulled = await call<{ anomalies: Array<{ pmsRef: string; reason: string; detail: string }> }>(
        "POST",
        `/${PROPERTY}/day/${DATE}/pull-from-pms`,
      );
      expect(pulled.body.anomalies).toEqual([{ pmsRef: "R2608-9100", reason: "mixed_scope", detail: "จ่ายล่วงหน้า, ค่าห้อง" }]);
    });

    // C7: the importer refuses to write a deposit_events row for a
    // pre-cutover date — the money is reported as an anomaly instead of
    // silently dropped OR silently written against a rule that isn't live
    // yet for that date.
    test("a deposit candidate on a PRE-cutover date becomes a pre_cutover_deposit anomaly, never inserted", async () => {
      process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
      const DATE = "2026-07-15"; // before the 2026-07-31 cutover

      pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
        pmsResult(
          [],
          [depositCandidate({ pmsRef: "R2607-9001", kind: "received", tender: "cash", amountSatang: 50_000 })],
        ),
      );

      const pulled = await call<{
        depositsInserted: number;
        depositsSkipped: number;
        anomalies: Array<{ pmsRef: string; reason: string }>;
      }>("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
      expect(pulled.body.depositsInserted).toBe(0);
      expect(pulled.body.depositsSkipped).toBe(0);
      expect(pulled.body.anomalies).toHaveLength(1);
      expect(pulled.body.anomalies[0]).toMatchObject({ pmsRef: "R2607-9001", reason: "pre_cutover_deposit" });

      const day = await call<{ deposits: unknown[] }>("GET", `/${PROPERTY}/day/${DATE}`);
      expect(day.body.deposits).toEqual([]);
    });

    // F1 (Opus money-review, 2026-07-31): a ตัดยอดล่วงหน้า BOOKING candidate
    // (not a deposit-event candidate) found on a pre-cutover date used to
    // write its appliedDepositSatang into t_deposit_applied anyway — the
    // route computed `accrual` and gated the deposit-EVENT branch, but
    // called insertPmsBookingLines (with the applied amount still intact)
    // BEFORE that gate ever ran. Proven live: a pre-cutover pull wrote
    // tenders.deposit_applied even though depositsInserted stayed 0 (since
    // that money was already booked as income under the OLD pre-cutover
    // rule — writing t_deposit_applied too would double-count it).
    test("F1 regression: a pre-cutover pull strips appliedDepositSatang from the booking candidate before insert, and flags it as an anomaly", async () => {
      process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
      const DATE = "2026-07-20"; // before the 2026-07-31 cutover

      pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
        pmsResult([
          pmsCandidate({
            pmsRef: "R2607-8001",
            bookingNo: "CH26-008001",
            grossRoomSatang: 0,
            cashSatang: 0,
            appliedDepositSatang: 89_000,
            appliedDepositBookingNos: ["R014843"],
          }),
        ]),
      );

      const pulled = await call<{
        inserted: number;
        anomalies: Array<{ pmsRef: string; reason: string; detail: string }>;
      }>("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
      expect(pulled.body.inserted).toBe(1); // the candidate itself still inserts
      expect(pulled.body.anomalies).toHaveLength(1);
      expect(pulled.body.anomalies[0]).toMatchObject({ pmsRef: "R2607-8001", reason: "pre_cutover_deposit" });
      expect(pulled.body.anomalies[0]!.detail).toContain("89000");

      const bookings = await call<{ lines: Array<{ bookingNo: string | null; remark: string | null; tenders: Record<Tender, number> }> }>(
        "GET",
        `/${PROPERTY}/day/${DATE}/bookings`,
      );
      const line = bookings.body.lines.find((l) => l.bookingNo === "CH26-008001")!;
      // The applied tender is ZERO — never written on a pre-cutover date —
      // and the R-number never lands in remark either, since nothing was
      // actually applied.
      expect(line.tenders.deposit_applied).toBe(0);
      expect(line.remark).toBeNull();
    });
  });
});

describe("Wave C: deposit_events hand-entry CRUD (docs/adr/0001)", () => {
  const DATE = "2026-08-20"; // on/after the 2026-07-31 accrual cutover
  const PRE_CUTOVER_DATE = "2026-07-01";

  test("POST creates a deposit event, touches sheet_days, and is visible via GET day", async () => {
    const created = await call<{ id: number; kind: string; amountSatang: number }>(
      "POST",
      `/${PROPERTY}/day/${DATE}/deposits`,
      { kind: "received", bookingNo: "R020001", guestName: "ทดสอบ มัดจำ", tender: "cash", amountSatang: 89_000, note: null },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: "received", amountSatang: 89_000 });

    const day = await call<{ deposits: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}`);
    expect(day.body.deposits.some((d) => d.id === created.body.id)).toBe(true);
  });

  test("400 on an invalid kind/tender/amount", async () => {
    const badKind = await call("POST", `/${PROPERTY}/day/${DATE}/deposits`, {
      kind: "bogus",
      bookingNo: null,
      guestName: null,
      tender: "cash",
      amountSatang: 1_000,
      note: null,
    });
    expect(badKind.status).toBe(400);

    const badTender = await call("POST", `/${PROPERTY}/day/${DATE}/deposits`, {
      kind: "received",
      bookingNo: null,
      guestName: null,
      tender: "bogus",
      amountSatang: 1_000,
      note: null,
    });
    expect(badTender.status).toBe(400);

    const badAmount = await call("POST", `/${PROPERTY}/day/${DATE}/deposits`, {
      kind: "received",
      bookingNo: null,
      guestName: null,
      tender: "cash",
      amountSatang: 0,
      note: null,
    });
    expect(badAmount.status).toBe(400);
  });

  test("400 pre-cutover: refuses to create a deposit event before the accrual cutover", async () => {
    const res = await call("POST", `/${PROPERTY}/day/${PRE_CUTOVER_DATE}/deposits`, {
      kind: "received",
      bookingNo: null,
      guestName: null,
      tender: "cash",
      amountSatang: 1_000,
      note: null,
    });
    expect(res.status).toBe(400);
  });

  test("409 when the month is closed", async () => {
    const MONTH = "2026-10";
    const CLOSED_DATE = "2026-10-05";
    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });
    const res = await call("POST", `/${PROPERTY}/day/${CLOSED_DATE}/deposits`, {
      kind: "received",
      bookingNo: null,
      guestName: null,
      tender: "cash",
      amountSatang: 1_000,
      note: null,
    });
    expect(res.status).toBe(409);
    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: false });
  });

  test("PATCH updates a field, 404 for an unknown id", async () => {
    const created = await call<{ id: number }>("POST", `/${PROPERTY}/day/${DATE}/deposits`, {
      kind: "received",
      bookingNo: "R020002",
      guestName: null,
      tender: "cash",
      amountSatang: 50_000,
      note: null,
    });
    const patched = await call<{ amountSatang: number }>("PATCH", `/${PROPERTY}/deposits/${created.body.id}`, {
      amountSatang: 60_000,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.amountSatang).toBe(60_000);

    const missing = await call("PATCH", `/${PROPERTY}/deposits/999999`, { amountSatang: 1_000 });
    expect(missing.status).toBe(404);
  });

  test("DELETE removes the event, 404 for an unknown id", async () => {
    const created = await call<{ id: number }>("POST", `/${PROPERTY}/day/${DATE}/deposits`, {
      kind: "received",
      bookingNo: "R020003",
      guestName: null,
      tender: "cash",
      amountSatang: 10_000,
      note: null,
    });
    const deleted = await call("DELETE", `/${PROPERTY}/deposits/${created.body.id}`);
    expect(deleted.status).toBe(204);

    const missing = await call("DELETE", `/${PROPERTY}/deposits/999999`);
    expect(missing.status).toBe(404);
  });

  test("a received cash deposit reaches the cash block's depositCashInSatang and folds into bankedSatang", async () => {
    const CASH_DATE = "2026-08-21";
    await call("POST", `/${PROPERTY}/day/${CASH_DATE}/deposits`, {
      kind: "received",
      bookingNo: "R020004",
      guestName: null,
      tender: "cash",
      amountSatang: 89_000,
      note: null,
    });
    const day = await call<{ cashBlock: { derived: { bankedSatang: number }; depositCashInSatang: number; depositCashOutSatang: number } }>(
      "GET",
      `/${PROPERTY}/day/${CASH_DATE}`,
    );
    expect(day.body.cashBlock.depositCashInSatang).toBe(89_000);
    expect(day.body.cashBlock.depositCashOutSatang).toBe(0);
    expect(day.body.cashBlock.derived.bankedSatang).toBe(89_000);
  });

  test("a non-cash (transfer) received deposit never touches the cash block", async () => {
    const NONCASH_DATE = "2026-08-22";
    await call("POST", `/${PROPERTY}/day/${NONCASH_DATE}/deposits`, {
      kind: "received",
      bookingNo: "R020005",
      guestName: null,
      tender: "transfer",
      amountSatang: 89_000,
      note: null,
    });
    const day = await call<{ cashBlock: { derived: { bankedSatang: number }; depositCashInSatang: number } }>(
      "GET",
      `/${PROPERTY}/day/${NONCASH_DATE}`,
    );
    expect(day.body.cashBlock.depositCashInSatang).toBe(0);
    expect(day.body.cashBlock.derived.bankedSatang).toBe(0);
  });
});

describe("Wave D, D5: accept-pms-update (POST /:property/bookings/:id/accept-pms-update)", () => {
  function acceptCandidate(overrides: Partial<PrefillCandidate> = {}): PrefillCandidate {
    return {
      pmsRef: "R2610-0001",
      bookingNo: "CH26-950001",
      guestName: "ทดสอบ ยอมรับ",
      roomNo: "301",
      roomCount: 1,
      nights: 1,
      grossRoomSatang: 100_000,
      grossOtherSatang: 0,
      cashSatang: 100_000,
      webSatang: 0,
      unplacedCreditSatang: 0,
      unplacedTranSatang: 0,
      appliedDepositSatang: 0,
      appliedDepositBookingNos: [],
      isRefund: false,
      ...overrides,
    };
  }

  function acceptResult(bookingCandidates: PrefillCandidate[]) {
    return { bookingCandidates, depositCandidates: [] as DepositCandidate[], anomalies: [] as PrefillAnomaly[] };
  }

  afterEach(() => {
    pmsPrefillInternal.setFetchDayPaymentsForTests(null);
    delete process.env.PMS_DB_URL_HF;
    delete process.env.PMS_DB_URL_HFVILLE;
  });

  test("happy path: applies the fresh candidate's PMS-written fields onto the existing row, merging into current tenders — hand-keyed fields survive", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-09-25";
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1001", bookingNo: "CH26-951001" })]),
    );
    await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    const inserted = await call<{ lines: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    const id = inserted.body.lines[0]!.id;

    // Hand-keyed fields the PMS importer never writes — must survive the accept.
    await call("PATCH", `/${PROPERTY}/bookings/${id}`, {
      remark: "บันทึกเพิ่มเติมด้วยมือ",
      tenders: { ...zeroTenders(), cash: 100_000, credit_icbc: 5_000 },
    });

    // The PMS now says 1,200 (was 1,000) — reception amended the folio.
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1001", bookingNo: "CH26-951001", grossRoomSatang: 120_000, cashSatang: 120_000 })]),
    );

    const accepted = await call<{
      id: number;
      grossRoomSatang: number;
      remark: string | null;
      tenders: Record<Tender, number>;
    }>("POST", `/${PROPERTY}/bookings/${id}/accept-pms-update`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.grossRoomSatang).toBe(120_000);
    expect(accepted.body.tenders.cash).toBe(120_000);
    // Never touched — not a PMS-written field.
    expect(accepted.body.tenders.credit_icbc).toBe(5_000);
    expect(accepted.body.remark).toBe("บันทึกเพิ่มเติมด้วยมือ");
  });

  test("idempotent: calling accept again with the same fresh candidate still succeeds and yields the same result", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-09-26";
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1002", bookingNo: "CH26-951002" })]),
    );
    await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    const inserted = await call<{ lines: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    const id = inserted.body.lines[0]!.id;

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1002", bookingNo: "CH26-951002", grossRoomSatang: 150_000, cashSatang: 150_000 })]),
    );

    const first = await call<{ grossRoomSatang: number }>("POST", `/${PROPERTY}/bookings/${id}/accept-pms-update`);
    expect(first.status).toBe(200);
    expect(first.body.grossRoomSatang).toBe(150_000);

    const second = await call<{ grossRoomSatang: number }>("POST", `/${PROPERTY}/bookings/${id}/accept-pms-update`);
    expect(second.status).toBe(200);
    expect(second.body.grossRoomSatang).toBe(150_000);
  });

  test("404: a manually-created (non-pms) booking line", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-09-27";
    const created = await call<{ id: number }>("POST", `/${PROPERTY}/day/${DATE}/bookings`, {
      guestName: "จองด้วยมือ",
      tenders: zeroTenders(),
    });
    const res = await call("POST", `/${PROPERTY}/bookings/${created.body.id}/accept-pms-update`);
    expect(res.status).toBe(404);
  });

  test("404: an unknown booking line id", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const res = await call("POST", `/${PROPERTY}/bookings/999999/accept-pms-update`);
    expect(res.status).toBe(404);
  });

  test("503 when the property's PMS env URL is unset", async () => {
    delete process.env.PMS_DB_URL_HF;
    const res = await call("POST", `/${PROPERTY}/bookings/1/accept-pms-update`);
    expect(res.status).toBe(503);
  });

  test("409 closed month, then succeeds after reopening", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const MONTH = "2026-09";
    const DATE = "2026-09-28";
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1003", bookingNo: "CH26-951003" })]),
    );
    await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    const inserted = await call<{ lines: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    const id = inserted.body.lines[0]!.id;

    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1003", bookingNo: "CH26-951003", grossRoomSatang: 200_000, cashSatang: 200_000 })]),
    );
    const blocked = await call("POST", `/${PROPERTY}/bookings/${id}/accept-pms-update`);
    expect(blocked.status).toBe(409);

    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: false });
    const succeeded = await call<{ grossRoomSatang: number }>("POST", `/${PROPERTY}/bookings/${id}/accept-pms-update`);
    expect(succeeded.status).toBe(200);
    expect(succeeded.body.grossRoomSatang).toBe(200_000);
  });

  test("409: the candidate has vanished from the ledger entirely", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-09-29";
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1004", bookingNo: "CH26-951004" })]),
    );
    await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    const inserted = await call<{ lines: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    const id = inserted.body.lines[0]!.id;

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => acceptResult([])); // gone
    const res = await call("POST", `/${PROPERTY}/bookings/${id}/accept-pms-update`);
    expect(res.status).toBe(409);
  });

  test("409: the candidate became a refund", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const DATE = "2026-09-30";
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1005", bookingNo: "CH26-951005" })]),
    );
    await call("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    const inserted = await call<{ lines: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    const id = inserted.body.lines[0]!.id;

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1005", bookingNo: "CH26-951005", isRefund: true, cashSatang: -50_000 })]),
    );
    const res = await call("POST", `/${PROPERTY}/bookings/${id}/accept-pms-update`);
    expect(res.status).toBe(409);
  });

  // F1 mirror (Opus money-review pattern, endpoint 26): a pre-cutover row
  // must never have an applied-deposit amount (re-)written, even if the PMS
  // now shows one on that same folio — it was already booked as income
  // under the OLD rule (docs/adr/0001), so writing it again would double it.
  test("pre-cutover date: never applies a newly-appeared appliedDepositSatang onto the row", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const PRE_CUTOVER_DATE = "2026-07-15";
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([acceptCandidate({ pmsRef: "R2610-1006", bookingNo: "CH26-951006", appliedDepositSatang: 0 })]),
    );
    await call("POST", `/${PROPERTY}/day/${PRE_CUTOVER_DATE}/pull-from-pms`);
    const inserted = await call<{ lines: Array<{ id: number }> }>("GET", `/${PROPERTY}/day/${PRE_CUTOVER_DATE}/bookings`);
    const id = inserted.body.lines[0]!.id;

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () =>
      acceptResult([
        acceptCandidate({
          pmsRef: "R2610-1006",
          bookingNo: "CH26-951006",
          appliedDepositSatang: 20_000,
          appliedDepositBookingNos: ["R099999"],
        }),
      ]),
    );
    const accepted = await call<{ tenders: Record<Tender, number> }>(
      "POST",
      `/${PROPERTY}/bookings/${id}/accept-pms-update`,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.tenders.deposit_applied).toBe(0);
  });
});

describe("Wave D: the office deposit register (GET /:property/deposits/register)", () => {
  function thread(overrides: Partial<DepositThread> = {}): DepositThread {
    return {
      rNumber: "R014843",
      receivedSatang: 89_000,
      appliedSatang: 0,
      refundedSatang: 0,
      outstandingSatang: 89_000,
      firstEventDate: "2026-08-01",
      events: [],
      status: "waitingCheckin",
      ...overrides,
    };
  }

  afterEach(() => {
    depositRegisterInternal.setFetchDepositRegisterForTests(null);
    delete process.env.PMS_DB_URL_HF;
    delete process.env.PMS_DB_URL_HFVILLE;
  });

  test("503 when the property's PMS env URL is unset", async () => {
    delete process.env.PMS_DB_URL_HF;
    const res = await call("GET", `/${PROPERTY}/deposits/register`);
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe("pms prefill not configured");
  });

  test("502 when the PMS query fails", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    depositRegisterInternal.setFetchDepositRegisterForTests(async () => {
      throw new Error("connection refused");
    });
    const res = await call("GET", `/${PROPERTY}/deposits/register`);
    expect(res.status).toBe(502);
  });

  test("200: aging is outstanding>0 oldest-first, exceptions carry diffSatang/orphan amounts, unparsedAppliedRows + monthly pass through", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const monthly: MonthlyDepositReconciliation[] = [
      { month: "2026-07", openingSatang: 0, receivedSatang: 100_000, appliedSatang: 0, refundedSatang: 0, closingSatang: 100_000 },
    ];
    const register: DepositRegisterData = {
      threads: [
        thread({ rNumber: "R090001", firstEventDate: "2026-08-05", outstandingSatang: 50_000 }),
        thread({ rNumber: "R090002", firstEventDate: "2026-07-01", outstandingSatang: 20_000 }),
        // R015834: the proven mismatch case — outstanding goes negative, never aging.
        thread({
          rNumber: "R015834",
          receivedSatang: 39_500,
          appliedSatang: 79_000,
          outstandingSatang: -39_500,
          firstEventDate: "2026-07-31",
          status: "applied",
        }),
        thread({
          rNumber: "R090003",
          receivedSatang: 0,
          appliedSatang: 30_000,
          outstandingSatang: -30_000,
          firstEventDate: null,
          status: "applied",
        }),
      ],
      monthly,
      unparsedAppliedRows: 2,
      // Review fix: three more tripwire counters, distinct values so the
      // test can prove each one passes through independently (not just
      // "some number").
      zeroTenderRows: 3,
      blankBookingNoRows: 1,
      undatedRows: 4,
      voided: [{ rNumber: null, kind: "applied" as const, amountSatang: 70_000, dateBangkok: "2026-06-01" }],
      events: [],
    };
    depositRegisterInternal.setFetchDepositRegisterForTests(async () => register);

    const res = await call<{
      property: string;
      generatedAt: string;
      monthly: unknown[];
      aging: Array<{ rNumber: string; status: string; receivedPmsRef: string | null }>;
      exceptions: {
        mismatched: Array<{
          rNumber: string;
          receivedSatang: number;
          appliedSatang: number;
          diffSatang: number;
          note: string | null;
          resolvedAt: string | null;
          resolvedBy: string | null;
          status: string;
          receivedPmsRef: string | null;
          appliedChRef: string | null;
          appliedDateBangkok: string | null;
        }>;
        orphanApplied: Array<{
          rNumber: string;
          appliedSatang: number;
          note: string | null;
          resolvedAt: string | null;
          resolvedBy: string | null;
          status: string;
          receivedPmsRef: string | null;
          appliedChRef: string | null;
          appliedDateBangkok: string | null;
        }>;
      };
      unparsedAppliedRows: number;
      zeroTenderRows: number;
      blankBookingNoRows: number;
      undatedRows: number;
      voided: Array<{ rNumber: string | null; kind: string; amountSatang: number; dateBangkok: string | null }>;
      events: unknown[];
    }>("GET", `/${PROPERTY}/deposits/register`);

    expect(res.status).toBe(200);
    expect(res.body.property).toBe(PROPERTY);
    expect(typeof res.body.generatedAt).toBe("string");
    expect(res.body.monthly).toEqual(monthly);
    expect(res.body.aging.map((r) => r.rNumber)).toEqual(["R090002", "R090001"]); // oldest first
    // Owner ask (2026-08-01): both aging threads are receipts sitting
    // untouched (no applied/refunded activity in this fixture) -> รอเช็คอิน.
    expect(res.body.aging.every((r) => r.status === "waitingCheckin")).toBe(true);
    expect(res.body.exceptions.mismatched).toEqual([
      {
        rNumber: "R015834",
        receivedSatang: 39_500,
        appliedSatang: 79_000,
        diffSatang: 39_500,
        note: null,
        resolvedAt: null,
        resolvedBy: null,
        status: "applied",
        receivedPmsRef: null,
        appliedChRef: null,
        appliedDateBangkok: null,
      },
    ]);
    expect(res.body.exceptions.orphanApplied).toEqual([
      {
        rNumber: "R090003",
        appliedSatang: 30_000,
        note: null,
        resolvedAt: null,
        resolvedBy: null,
        status: "applied",
        receivedPmsRef: null,
        appliedChRef: null,
        appliedDateBangkok: null,
      },
    ]);
    expect(res.body.unparsedAppliedRows).toBe(2);
    // Review fix: each tripwire counter passes through independently.
    expect(res.body.zeroTenderRows).toBe(3);
    expect(res.body.blankBookingNoRows).toBe(1);
    expect(res.body.undatedRows).toBe(4);
    expect(res.body.voided).toEqual([{ rNumber: null, kind: "applied", amountSatang: 70_000, dateBangkok: "2026-06-01" }]);
    // Additive: the flat events feed is always present (empty here since
    // the fixture's threads carry no events).
    expect(res.body.events).toEqual([]);
  });

  test("notes merge onto both aging rows and exception rows sharing the same rNumber", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    depositRegisterInternal.setFetchDepositRegisterForTests(async () => ({
      threads: [
        thread({ rNumber: "R090010", firstEventDate: "2026-08-01", outstandingSatang: 10_000 }),
        thread({
          rNumber: "R090011",
          receivedSatang: 39_500,
          appliedSatang: 79_000,
          outstandingSatang: -39_500,
          firstEventDate: "2026-07-31",
        }),
      ],
      monthly: [],
      unparsedAppliedRows: 0,
      zeroTenderRows: 0,
      blankBookingNoRows: 0,
      undatedRows: 0,
      voided: [],
      events: [],
    }));

    await call("PUT", `/${PROPERTY}/deposits/R090010/note`, { note: "รอตรวจสอบ", resolved: false });
    await call("PUT", `/${PROPERTY}/deposits/R090011/note`, { note: "ให้เหตุผลจากรีเซปชั่น", resolved: true });

    const res = await call<{
      aging: Array<{ rNumber: string; note: string | null; resolvedAt: string | null }>;
      exceptions: { mismatched: Array<{ rNumber: string; note: string | null; resolvedAt: string | null }> };
    }>("GET", `/${PROPERTY}/deposits/register`);

    const agingRow = res.body.aging.find((r) => r.rNumber === "R090010")!;
    expect(agingRow.note).toBe("รอตรวจสอบ");
    expect(agingRow.resolvedAt).toBeNull();

    const mismatchedRow = res.body.exceptions.mismatched.find((r) => r.rNumber === "R090011")!;
    expect(mismatchedRow.note).toBe("ให้เหตุผลจากรีเซปชั่น");
    expect(mismatchedRow.resolvedAt).not.toBeNull();
  });

  // Owner ask (2026-08-01, register mapability + explicit deposit state):
  // the top-level `events` field carries the register's full flat event
  // list (additive), and `receivedPmsRef`/`status`/`appliedChRef`/
  // `appliedDateBangkok` are correctly resolved from a thread's OWN
  // `events` — a partially-applied thread (still in `aging`, since
  // outstanding > 0) that HAS an applied event lets both the "where it
  // received from" and "where it's partly gone to" mappings be asserted
  // in the same row.
  test("events passes through; receivedPmsRef/status/appliedChRef/appliedDateBangkok resolve from the thread's own events", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";

    const receivedEvent: DepositLedgerEvent = {
      legacyId: 1,
      pmsRef: "R2608-0001",
      kind: "received",
      rNumber: "R090020",
      dateBangkok: "2026-08-01",
      amountSatang: 50_000,
      voided: false,
      tender: "cash",
      chRef: null,
    };
    const appliedEvent: DepositLedgerEvent = {
      legacyId: 2,
      pmsRef: "R2608-0002",
      kind: "applied",
      rNumber: "R090020",
      dateBangkok: "2026-08-10",
      amountSatang: 20_000,
      voided: false,
      tender: null,
      chRef: "CH26-005269",
    };
    const flatEvents = [receivedEvent, appliedEvent];

    const register: DepositRegisterData = {
      threads: [
        thread({
          rNumber: "R090020",
          receivedSatang: 50_000,
          appliedSatang: 20_000,
          outstandingSatang: 30_000,
          firstEventDate: "2026-08-01",
          status: "partial",
          events: flatEvents,
        }),
      ],
      monthly: [],
      unparsedAppliedRows: 0,
      zeroTenderRows: 0,
      blankBookingNoRows: 0,
      undatedRows: 0,
      voided: [],
      events: flatEvents,
    };
    depositRegisterInternal.setFetchDepositRegisterForTests(async () => register);

    const res = await call<{
      aging: Array<{
        rNumber: string;
        status: string;
        receivedPmsRef: string | null;
        appliedChRef: string | null;
        appliedDateBangkok: string | null;
      }>;
      events: Array<{
        dateBangkok: string | null;
        kind: string;
        rNumber: string | null;
        pmsRef: string;
        tender: string | null;
        amountSatang: number;
        voided: boolean;
        chRef: string | null;
      }>;
    }>("GET", `/${PROPERTY}/deposits/register`);

    expect(res.status).toBe(200);
    const agingRow = res.body.aging.find((r) => r.rNumber === "R090020")!;
    expect(agingRow.status).toBe("partial");
    expect(agingRow.receivedPmsRef).toBe("R2608-0001");
    expect(agingRow.appliedChRef).toBe("CH26-005269");
    expect(agingRow.appliedDateBangkok).toBe("2026-08-10");

    expect(res.body.events).toEqual([
      {
        dateBangkok: "2026-08-01",
        kind: "received",
        rNumber: "R090020",
        pmsRef: "R2608-0001",
        tender: "cash",
        amountSatang: 50_000,
        voided: false,
        chRef: null,
      },
      {
        dateBangkok: "2026-08-10",
        kind: "applied",
        rNumber: "R090020",
        pmsRef: "R2608-0002",
        tender: null,
        amountSatang: 20_000,
        voided: false,
        chRef: "CH26-005269",
      },
    ]);
  });
});

describe("Wave D, D3: deposit notes CRUD (PUT/DELETE /:property/deposits/:rNumber/note)", () => {
  test("PUT creates a note thread; round-trips note + resolved state", async () => {
    const created = await call<{
      property: string;
      rNumber: string;
      note: string | null;
      resolvedAt: string | null;
      resolvedBy: string | null;
    }>("PUT", `/${PROPERTY}/deposits/R070001/note`, { note: "รอเอกสารจากรีเซปชั่น", resolved: false });
    expect(created.status).toBe(200);
    expect(created.body.rNumber).toBe("R070001");
    expect(created.body.note).toBe("รอเอกสารจากรีเซปชั่น");
    expect(created.body.resolvedAt).toBeNull();
    expect(created.body.resolvedBy).toBeNull();
  });

  test("resolved: true stamps resolvedAt/resolvedBy; resolved: false clears both", async () => {
    const resolved = await call<{ resolvedAt: string | null; resolvedBy: string | null }>(
      "PUT",
      `/${PROPERTY}/deposits/R070002/note`,
      { note: "ตรวจสอบแล้ว", resolved: true },
    );
    expect(resolved.body.resolvedAt).not.toBeNull();
    expect(resolved.body.resolvedBy).toBe("tester@thehfhotel.org");

    const reopened = await call<{ resolvedAt: string | null; resolvedBy: string | null }>(
      "PUT",
      `/${PROPERTY}/deposits/R070002/note`,
      { note: "ตรวจสอบแล้ว", resolved: false },
    );
    expect(reopened.body.resolvedAt).toBeNull();
    expect(reopened.body.resolvedBy).toBeNull();
  });

  test("400 on an invalid rNumber shape", async () => {
    const res = await call("PUT", `/${PROPERTY}/deposits/not-an-r-number/note`, { note: "x", resolved: false });
    expect(res.status).toBe(400);
  });

  test("400 on a note exceeding DEPOSIT_NOTE_MAX_LEN", async () => {
    const res = await call("PUT", `/${PROPERTY}/deposits/R070003/note`, {
      note: "x".repeat(DEPOSIT_NOTE_MAX_LEN + 1),
      resolved: false,
    });
    expect(res.status).toBe(400);
  });

  test("DELETE removes the note; deleting a non-existent note is still 204 (idempotent)", async () => {
    await call("PUT", `/${PROPERTY}/deposits/R070004/note`, { note: "ลบทิ้ง", resolved: false });
    const deleted = await call("DELETE", `/${PROPERTY}/deposits/R070004/note`);
    expect(deleted.status).toBe(204);

    const deletedAgain = await call("DELETE", `/${PROPERTY}/deposits/R070004/note`);
    expect(deletedAgain.status).toBe(204);
  });

  test("400 on an invalid rNumber shape for DELETE too", async () => {
    const res = await call("DELETE", `/${PROPERTY}/deposits/not-an-r-number/note`);
    expect(res.status).toBe(400);
  });

  // deposit_notes carries no `date` at all (keyed by property + R-number
  // only), so month-close structurally cannot apply — this is a regression
  // guard against ever wiring a closedMonthResponse-style gate onto these
  // endpoints (the plan's explicit "commentary rule": a note is NOT gated,
  // same as the day note/endpoint 9 and the cash-block adjustment/endpoint 21).
  test("succeeds even while some month is closed — NOT month-close gated (commentary rule)", async () => {
    const MONTH = "2026-11";
    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: true });

    const put = await call("PUT", `/${PROPERTY}/deposits/R070005/note`, { note: "บันทึกได้แม้ปิดบัญชี", resolved: false });
    expect(put.status).toBe(200);

    const del = await call("DELETE", `/${PROPERTY}/deposits/R070005/note`);
    expect(del.status).toBe(204);

    await call("PUT", `/${PROPERTY}/months/${MONTH}/close`, { closed: false });
  });
});
