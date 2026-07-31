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
import { REMARK_MAX_LEN, TENDERS } from "../shared/types.ts";
import type { Category, CategoryKey, Property, Tender } from "../shared/types.ts";
import type { PrefillCandidate } from "./pms-prefill.ts";

const { api } = await import("./server.ts");
// server.ts already imported pms-prefill.ts above, so this re-import just
// reads the cached module — same _internal pattern as analytics-push.test.ts.
const { _internal: pmsPrefillInternal } = await import("./pms-prefill.ts");

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
  test("seeds fourteen income categories, including the split รายการอื่นๆ and โอน/เครดิต pairs", () => {
    const income = categories.filter((c) => c.kind === "income");
    expect(income).toHaveLength(14);
    expect(income.find((c) => c.categoryKey === "other_cash")?.nameTh).toBe("รายการอื่นๆ เงินสด");
    expect(income.find((c) => c.categoryKey === "other_transfer")?.nameTh).toBe("รายการอื่นๆ โอน");
    expect(income.find((c) => c.categoryKey === "other_cash")?.isCash).toBe(true);
    expect(income.find((c) => c.categoryKey === "other_transfer")?.isCash).toBe(false);
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
      depositSatang: 0,
      cashSatang: 0,
      webSatang: 0,
      unplacedCreditSatang: 0,
      unplacedTranSatang: 0,
      isRefund: false,
      isDeposit: false,
      ...overrides,
    };
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

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => [
      pmsCandidate({
        pmsRef: "R2608-0101",
        bookingNo: "CH26-000101",
        roomNo: "101",
        cashSatang: 100_000,
        depositSatang: 20_000,
        unplacedTranSatang: 30_000,
        unplacedCreditSatang: 12_000,
      }),
      pmsCandidate({ pmsRef: "R2608-0102", bookingNo: "CH26-000102", roomNo: "102", webSatang: 75_000 }),
    ]);

    const pulled = await call<{
      inserted: number;
      skipped: number;
      skippedRefunds: number;
      unplaced: Array<{ pmsRef: string; bookingNo: string | null; creditSatang: number; tranSatang: number }>;
      autoPlaced: Array<{ pmsRef: string; bookingNo: string | null; transferSatang: number; creditSatang: number }>;
    }>("POST", `/${PROPERTY}/day/${DATE}/pull-from-pms`);
    expect(pulled.status).toBe(200);
    expect(pulled.body.inserted).toBe(2);
    expect(pulled.body.skipped).toBe(0);
    expect(pulled.body.skippedRefunds).toBe(0);
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
        tenders: Record<Tender, number>;
      }>;
    }>("GET", `/${PROPERTY}/day/${DATE}/bookings`);
    expect(bookings.body.lines.map((l) => l.seq)).toEqual([1, 2, 3]);

    const first = bookings.body.lines.find((l) => l.bookingNo === "CH26-000101")!;
    expect(first.source).toBe("pms");
    expect(first.draft).toBe(false);
    expect(first.tenders.cash).toBe(100_000);
    expect(first.tenders.deposit).toBe(20_000);
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

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => [
      pmsCandidate({
        pmsRef: "R2608-0501",
        bookingNo: "CH26-000501",
        cashSatang: 10_000,
        unplacedCreditSatang: 18_000,
        unplacedTranSatang: 5_000,
      }),
    ]);

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

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => [
      pmsCandidate({ pmsRef: "R2608-0601", bookingNo: "CH26-000601", cashSatang: 20_000, unplacedCreditSatang: 9_000 }),
    ]);

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

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => [
      pmsCandidate({
        pmsRef: "R2607-0701",
        bookingNo: "CH26-000701",
        grossRoomSatang: 250_000,
        grossOtherSatang: 0,
        cashSatang: 125_000,
        unplacedTranSatang: 125_000,
      }),
    ]);

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

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => [
      pmsCandidate({ pmsRef: "R2608-0201", bookingNo: "CH26-000201", cashSatang: 50_000 }),
      pmsCandidate({ pmsRef: "R2608-0202", bookingNo: "CH26-000202", webSatang: 25_000 }),
    ]);

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

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => [
      pmsCandidate({ pmsRef: "R2608-0301", bookingNo: "CH26-000301", cashSatang: 40_000 }),
      pmsCandidate({ pmsRef: "R2608-0302", bookingNo: "CH26-000302", cashSatang: -10_000, isRefund: true }),
    ]);

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

    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => [
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
    ]);

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
    pmsPrefillInternal.setFetchDayPaymentsForTests(async () => [pmsCandidate({ pmsRef: "R2609-0001" })]);

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
});
