// Server route tests. Establishes the pattern for this repo: point the DB
// at :memory:, force the dev auth bypass, then drive api.handle() directly
// — no real HTTP socket needed. Env vars must be set BEFORE importing the
// server module, since db.ts opens the database and runs migrate() at
// import time.

process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "development";
process.env.DEV_USER = "tester@thehfhotel.org";
process.env.MANAGER_EMAILS = "tester@thehfhotel.org";
process.env.PORT = "0"; // let the OS pick a free port — avoids clashing with `bun run dev`

import { beforeAll, describe, expect, test } from "bun:test";
import { REMARK_MAX_LEN, TENDERS } from "../shared/types.ts";
import type { Category, CategoryKey, Tender } from "../shared/types.ts";

const { api } = await import("./server.ts");

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
  test("seeds eleven income categories, including the split รายการอื่นๆ pair", () => {
    const income = categories.filter((c) => c.kind === "income");
    expect(income).toHaveLength(11);
    expect(income.find((c) => c.categoryKey === "other_cash")?.nameTh).toBe("รายการอื่นๆ เงินสด");
    expect(income.find((c) => c.categoryKey === "other_transfer")?.nameTh).toBe("รายการอื่นๆ โอน/เครดิต");
    expect(income.find((c) => c.categoryKey === "other_cash")?.isCash).toBe(true);
    expect(income.find((c) => c.categoryKey === "other_transfer")?.isCash).toBe(false);
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
      tenders: { deposit: 0, cash: 20_000, credit_kbank: 30_000, credit_icbc: 40_000, transfer_kbank: 50_000, transfer_icbc: 60_000, web: 70_000, other: 15_000 },
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

  test("verify is open to any signed-in user, not managers only", async () => {
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
