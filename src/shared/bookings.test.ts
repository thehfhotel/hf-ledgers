import { describe, expect, test } from "bun:test";
import {
  computeBookingTotals,
  depositCashTotals,
  deriveCashBlock,
  deriveIncomeFromBookings,
  lineArithmeticMismatch,
  RECONCILE_TOLERANCE_SATANG,
} from "./bookings.ts";
import { TENDERS } from "./types.ts";
import type { BookingLine, Category, DepositEvent, IncomeCell, OtherIncomeItem, Property, Tender } from "./types.ts";

function zeroTenders(): Record<Tender, number> {
  return Object.fromEntries(TENDERS.map((tender) => [tender, 0])) as Record<Tender, number>;
}

// `property` defaults to "hf" so every pre-existing call site is unaffected
// — the hfville-parity describe blocks below are the only callers that ever
// pass it explicitly.
function makeLine(overrides: Partial<BookingLine> = {}): BookingLine {
  return {
    id: 1,
    property: "hf",
    date: "2026-07-29",
    seq: 1,
    bookingNo: "B-1001",
    guestName: "สมชาย ใจดี",
    roomNo: "101",
    roomCount: 1,
    nights: 1,
    grossRoomSatang: 100_000,
    grossOtherSatang: 0,
    discountSatang: 0,
    tenders: zeroTenders(),
    remark: null,
    source: "manual",
    draft: false,
    sourceSheet: null,
    createdAt: "2026-07-29 00:00:00",
    createdBy: "tester@thehfhotel.org",
    updatedAt: "2026-07-29 00:00:00",
    updatedBy: "tester@thehfhotel.org",
    ...overrides,
  };
}

describe("computeBookingTotals", () => {
  test("sums each tender column independently across lines", () => {
    const lineA = makeLine({
      id: 1,
      grossRoomSatang: 100_000,
      tenders: { ...zeroTenders(), cash: 60_000, transfer_kbank: 40_000 },
    });
    const lineB = makeLine({
      id: 2,
      grossRoomSatang: 50_000,
      tenders: { ...zeroTenders(), web: 50_000 },
    });

    const totals = computeBookingTotals([lineA, lineB]);

    expect(totals.byTender.cash).toBe(60_000);
    expect(totals.byTender.transfer_kbank).toBe(40_000);
    expect(totals.byTender.web).toBe(50_000);
    expect(totals.byTender.deposit).toBe(0);
    expect(totals.receivedSatang).toBe(150_000);
    expect(totals.lineCount).toBe(2);
  });

  test("excludes draft lines from every figure", () => {
    const confirmedLine = makeLine({
      id: 1,
      grossRoomSatang: 100_000,
      tenders: { ...zeroTenders(), cash: 100_000 },
    });
    const draftLine = makeLine({
      id: 2,
      draft: true,
      source: "pms",
      grossRoomSatang: 999_000,
      tenders: { ...zeroTenders(), cash: 999_000 },
    });

    const totals = computeBookingTotals([confirmedLine, draftLine]);

    expect(totals.lineCount).toBe(1);
    expect(totals.grossRoomSatang).toBe(100_000);
    expect(totals.byTender.cash).toBe(100_000);
  });

  test("a booking split across multiple tenders contributes to each", () => {
    const line = makeLine({
      grossRoomSatang: 300_000,
      tenders: { ...zeroTenders(), deposit: 100_000, cash: 100_000, credit_kbank: 100_000 },
    });

    const totals = computeBookingTotals([line]);

    expect(totals.byTender.deposit).toBe(100_000);
    expect(totals.byTender.cash).toBe(100_000);
    expect(totals.byTender.credit_kbank).toBe(100_000);
    expect(totals.receivedSatang).toBe(300_000);
  });

  test("a coupon/comp row with zero tenders contributes zero received but still counts as a line", () => {
    const line = makeLine({ grossRoomSatang: 0, grossOtherSatang: 0, discountSatang: 0, tenders: zeroTenders() });

    const totals = computeBookingTotals([line]);

    expect(totals.receivedSatang).toBe(0);
    expect(totals.lineCount).toBe(1);
  });
});

describe("deriveIncomeFromBookings", () => {
  test("maps each of the seven derivable tenders to its CategoryKey", () => {
    const line = makeLine({
      tenders: {
        ...zeroTenders(),
        deposit: 10_000,
        cash: 20_000,
        credit_kbank: 30_000,
        credit_icbc: 40_000,
        transfer_kbank: 50_000,
        transfer_icbc: 60_000,
        web: 70_000,
      },
    });

    const derived = deriveIncomeFromBookings([line]);

    expect(derived.deposit).toBe(10_000);
    expect(derived.room_cash).toBe(20_000);
    expect(derived.credit_kbank).toBe(30_000);
    expect(derived.credit_icbc).toBe(40_000);
    expect(derived.transfer_kbank).toBe(50_000);
    expect(derived.transfer_icbc).toBe(60_000);
    expect(derived.web).toBe(70_000);
  });

  test("tender other is never included, even when present on a line", () => {
    const line = makeLine({ tenders: { ...zeroTenders(), other: 15_000 } });

    const derived = deriveIncomeFromBookings([line]);

    expect(Object.keys(derived)).toHaveLength(0);
  });

  test("excludes draft lines", () => {
    const draftLine = makeLine({ draft: true, source: "pms", tenders: { ...zeroTenders(), cash: 20_000 } });

    const derived = deriveIncomeFromBookings([draftLine]);

    expect(derived.room_cash).toBeUndefined();
  });

  // Wave C (docs/adr/0001): deposit_applied ("ตัดยอดมัดจำ") derives into its
  // own same-named CategoryKey exactly like every other tender — no special
  // casing needed since the function loops TENDERS generically.
  test("deposit_applied maps to its own CategoryKey", () => {
    const line = makeLine({ tenders: { ...zeroTenders(), deposit_applied: 79_000 } });

    const derived = deriveIncomeFromBookings([line]);

    expect(derived.deposit_applied).toBe(79_000);
  });
});

describe("deriveCashBlock", () => {
  const categories: Category[] = [
    {
      id: 1,
      property: "hf",
      kind: "income",
      nameTh: "ค่าห้องเงินสด",
      sort: 1,
      isCash: true,
      categoryKey: "room_cash",
      archivedAt: null,
      createdAt: "2026-01-01 00:00:00",
    },
    {
      id: 2,
      property: "hf",
      kind: "income",
      nameTh: "บาร์น้ำ เงินสด",
      sort: 2,
      isCash: true,
      categoryKey: "bar_cash",
      archivedAt: null,
      createdAt: "2026-01-01 00:00:00",
    },
    {
      id: 3,
      property: "hf",
      kind: "income",
      nameTh: "โอน/กสิกร",
      sort: 3,
      isCash: false,
      categoryKey: "transfer_kbank",
      archivedAt: null,
      createdAt: "2026-01-01 00:00:00",
    },
    {
      id: 4,
      property: "hf",
      kind: "income",
      nameTh: "รายการอื่นๆ เงินสด",
      sort: 4,
      isCash: true,
      categoryKey: "other_cash",
      archivedAt: null,
      createdAt: "2026-01-01 00:00:00",
    },
    // A manager-created custom cash category — categoryKey null, isCash
    // true, e.g. a "กองทุนเล็ก" cash box the seed never produces today, but
    // the generalization to category.isCash must still fold it into the
    // otherCash bucket (see deriveCashBlock's docblock).
    {
      id: 5,
      property: "hf",
      kind: "income",
      nameTh: "กองทุนสำรอง (เงินสด)",
      sort: 5,
      isCash: true,
      categoryKey: null,
      archivedAt: null,
      createdAt: "2026-01-01 00:00:00",
    },
  ];

  function incomeCell(categoryId: number, amountSatang: number): IncomeCell {
    return {
      categoryId,
      amountSatang,
      note: null,
      source: "manual",
      manual: true,
      updatedAt: "2026-07-29 10:00:00",
      updatedBy: "tester@thehfhotel.org",
    };
  }

  function otherIncomeItem(amountSatang: number, isCash: boolean): OtherIncomeItem {
    return {
      id: 1,
      property: "hf",
      date: "2026-07-29",
      description: "รายการทดสอบ",
      amountSatang,
      isCash,
      createdAt: "2026-07-29 08:00:00",
      createdBy: "tester@thehfhotel.org",
      updatedAt: "2026-07-29 08:00:00",
      updatedBy: "tester@thehfhotel.org",
    };
  }

  test("sums room cash, bar cash, and cash-only other-income into a banked total", () => {
    const income: Record<number, IncomeCell> = {
      1: incomeCell(1, 49_000), // room cash
      2: incomeCell(2, 2_000), // bar cash
      3: incomeCell(3, 829_000), // non-cash category — must not count
    };
    const otherIncomeItems: OtherIncomeItem[] = [
      otherIncomeItem(5_000, true), // cash — counts
      otherIncomeItem(3_000, false), // transfer/credit — must not count
    ];

    const block = deriveCashBlock(categories, income, otherIncomeItems);

    expect(block.roomCashSatang).toBe(49_000);
    expect(block.barCashSatang).toBe(2_000);
    expect(block.otherCashSatang).toBe(5_000);
    expect(block.bankedSatang).toBe(56_000);
  });

  test("an empty day derives an all-zero block", () => {
    const block = deriveCashBlock(categories, {}, []);

    expect(block).toEqual({
      roomCashSatang: 0,
      otherCashSatang: 0,
      barCashSatang: 0,
      bankedSatang: 0,
    });
  });

  // Wave B (issue #2): the other-cash term falls back to the day's typed
  // other_cash cell when there are zero itemized other-income rows —
  // mirroring getEffectiveIncomeForDay's items-else-cell rule (db.ts)
  // exactly, including what counts as "has items" (otherIncomeItems.length,
  // regardless of any item's own isCash). Zero live instances in
  // production (86% of days carry an explicit banked override, immune by
  // construction) — this closes a latent, UI-reachable trap only.
  describe("other_cash fallback (Wave B)", () => {
    test("typed-cell-only day (no itemized rows): the cell value reaches otherCash and bankedSatang", () => {
      const income: Record<number, IncomeCell> = {
        1: incomeCell(1, 49_000), // room cash
        2: incomeCell(2, 2_000), // bar cash
        4: incomeCell(4, 7_500), // typed รายการอื่นๆ เงินสด cell, no items backing it
      };

      const block = deriveCashBlock(categories, income, []);

      expect(block.otherCashSatang).toBe(7_500);
      expect(block.bankedSatang).toBe(49_000 + 2_000 + 7_500);
    });

    test("itemized day: identical to today — items win, the cell is ignored entirely", () => {
      const income: Record<number, IncomeCell> = {
        1: incomeCell(1, 49_000),
        2: incomeCell(2, 2_000),
        // A stale/wrong cell value that must NOT leak into otherCashSatang
        // once itemized rows exist for the day.
        4: incomeCell(4, 999_000),
      };
      const otherIncomeItems: OtherIncomeItem[] = [
        otherIncomeItem(5_000, true), // cash — counts
        otherIncomeItem(3_000, false), // transfer/credit — must not count
      ];

      const block = deriveCashBlock(categories, income, otherIncomeItems);

      expect(block.otherCashSatang).toBe(5_000);
      expect(block.bankedSatang).toBe(49_000 + 2_000 + 5_000);
    });

    test("a day with only non-cash itemized rows still counts as 'has items' — the cell is ignored, not just the isCash filter", () => {
      const income: Record<number, IncomeCell> = {
        4: incomeCell(4, 12_000), // must be ignored: items exist, even though none are cash
      };
      const otherIncomeItems: OtherIncomeItem[] = [otherIncomeItem(3_000, false)];

      const block = deriveCashBlock(categories, income, otherIncomeItems);

      expect(block.otherCashSatang).toBe(0);
    });
  });

  // Wave B (issue #2): room/bar/other selection generalises from three
  // hardcoded categoryKey checks to category.isCash — room_cash and
  // bar_cash keep their own buckets, every OTHER isCash category (the
  // seeded other_cash key, or a custom manager-created one with
  // categoryKey null) sums into otherCash.
  describe("custom isCash category generalisation (Wave B)", () => {
    test("a custom isCash category (categoryKey null) with a typed cell counts into otherCash", () => {
      const income: Record<number, IncomeCell> = {
        1: incomeCell(1, 49_000),
        5: incomeCell(5, 1_000), // custom cash category, no otherIncomeItems at all
      };

      const block = deriveCashBlock(categories, income, []);

      expect(block.otherCashSatang).toBe(1_000);
      expect(block.bankedSatang).toBe(49_000 + 1_000);
    });

    test("a custom isCash category's cell adds ALONGSIDE itemized other-income, independent of the items-else-cell rule (that rule is other_cash-specific)", () => {
      const income: Record<number, IncomeCell> = {
        5: incomeCell(5, 1_000), // custom cash category
      };
      const otherIncomeItems: OtherIncomeItem[] = [otherIncomeItem(5_000, true)];

      const block = deriveCashBlock(categories, income, otherIncomeItems);

      expect(block.otherCashSatang).toBe(1_000 + 5_000);
    });
  });

  // Deposit-machine reconciliation rows (docs/plan-unify-exports-tender-
  // split.md item 6, Wave C): bankedSatang = roomCash + otherCash + barCash
  // - heldBackSatang + broughtForwardSatang. Every combination below reuses
  // the SAME 56,000 satang cash total from the first test above
  // (49,000 room + 2,000 bar + 5,000 other-cash) so only the adjustment's
  // own effect varies.
  describe("heldBackSatang/broughtForwardSatang adjustment", () => {
    const income: Record<number, IncomeCell> = {
      1: incomeCell(1, 49_000), // room cash
      2: incomeCell(2, 2_000), // bar cash
    };
    const otherIncomeItems: OtherIncomeItem[] = [otherIncomeItem(5_000, true)];
    const CASH_TOTAL_SATANG = 56_000;

    test("neither set (default): bankedSatang is unaffected, same as no adjustment ever existed", () => {
      const block = deriveCashBlock(categories, income, otherIncomeItems);
      expect(block.bankedSatang).toBe(CASH_TOTAL_SATANG);
    });

    test("heldBackSatang only: subtracted from the cash total", () => {
      const block = deriveCashBlock(categories, income, otherIncomeItems, 12_000, null);
      expect(block.bankedSatang).toBe(CASH_TOTAL_SATANG - 12_000);
      // The three components themselves are untouched by the adjustment —
      // only the final bankedSatang figure moves.
      expect(block.roomCashSatang).toBe(49_000);
      expect(block.otherCashSatang).toBe(5_000);
      expect(block.barCashSatang).toBe(2_000);
    });

    test("broughtForwardSatang only: added to the cash total", () => {
      const block = deriveCashBlock(categories, income, otherIncomeItems, null, 8_500);
      expect(block.bankedSatang).toBe(CASH_TOTAL_SATANG + 8_500);
    });

    test("both set: subtracts row 1 and adds row 2 in the same formula", () => {
      const block = deriveCashBlock(categories, income, otherIncomeItems, 12_000, 8_500);
      expect(block.bankedSatang).toBe(CASH_TOTAL_SATANG - 12_000 + 8_500);
    });

    test("explicit 0 for both behaves arithmetically identically to null (unset) for both", () => {
      const withNulls = deriveCashBlock(categories, income, otherIncomeItems, null, null);
      const withZeros = deriveCashBlock(categories, income, otherIncomeItems, 0, 0);
      expect(withZeros.bankedSatang).toBe(withNulls.bankedSatang);
      expect(withZeros.bankedSatang).toBe(CASH_TOTAL_SATANG);
    });

    test("a held-back amount larger than the cash total is allowed to go negative — the formula never clamps", () => {
      const block = deriveCashBlock(categories, income, otherIncomeItems, CASH_TOTAL_SATANG + 1_000, null);
      expect(block.bankedSatang).toBe(-1_000);
    });

    // Wave B regression: the fallback/generalisation changes above must not
    // disturb how heldBack/broughtForward fold into bankedSatang — same
    // formula, now fed by a cash total that includes a typed-cell-only
    // other_cash fallback instead of an itemized sum.
    test("interplay is unchanged when the cash total comes from the other_cash fallback rather than items", () => {
      const fallbackIncome: Record<number, IncomeCell> = {
        1: incomeCell(1, 49_000), // room cash
        2: incomeCell(2, 2_000), // bar cash
        4: incomeCell(4, 5_000), // other_cash cell, no itemized rows — the Wave B fallback
      };
      const block = deriveCashBlock(categories, fallbackIncome, [], 12_000, 8_500);
      expect(block.otherCashSatang).toBe(5_000);
      expect(block.bankedSatang).toBe(CASH_TOTAL_SATANG - 12_000 + 8_500);
    });
  });

  // Wave C (docs/adr/0001): a cash มัดจำล่วงหน้า received/refunded today
  // folds into bankedSatang (it moved the till) while staying entirely out
  // of every income cell above (never รายรับ under accrual) — transfer/
  // credit/web/other deposit tenders never touch it either way.
  describe("depositEvents folding (Wave C)", () => {
    function depositEvent(overrides: Partial<DepositEvent> = {}): DepositEvent {
      return {
        id: 1,
        property: "hf",
        date: "2026-08-01",
        kind: "received",
        bookingNo: "R014843",
        guestName: "ทดสอบ มัดจำ",
        tender: "cash",
        amountSatang: 89_000,
        note: null,
        source: "manual",
        pmsRef: null,
        createdAt: "2026-08-01 10:00:00",
        createdBy: "tester@thehfhotel.org",
        updatedAt: "2026-08-01 10:00:00",
        updatedBy: "tester@thehfhotel.org",
        ...overrides,
      };
    }

    test("default call sites (no depositEvents passed) are unaffected", () => {
      const block = deriveCashBlock(categories, {}, []);
      expect(block.bankedSatang).toBe(0);
    });

    test("a received cash deposit ADDS to bankedSatang, with no income-cell effect", () => {
      const block = deriveCashBlock(categories, {}, [], null, null, [depositEvent({ amountSatang: 89_000 })]);
      expect(block.bankedSatang).toBe(89_000);
      expect(block.roomCashSatang).toBe(0);
      expect(block.otherCashSatang).toBe(0);
      expect(block.barCashSatang).toBe(0);
    });

    test("a refunded cash deposit SUBTRACTS from bankedSatang", () => {
      const block = deriveCashBlock(categories, {}, [], null, null, [
        depositEvent({ kind: "refunded", amountSatang: 30_000 }),
      ]);
      expect(block.bankedSatang).toBe(-30_000);
    });

    test("received + refunded cash deposits net together", () => {
      const block = deriveCashBlock(categories, {}, [], null, null, [
        depositEvent({ id: 1, kind: "received", amountSatang: 89_000 }),
        depositEvent({ id: 2, kind: "refunded", amountSatang: 30_000 }),
      ]);
      expect(block.bankedSatang).toBe(89_000 - 30_000);
    });

    test("non-cash deposit tenders (transfer/credit/web/other) never touch bankedSatang", () => {
      const block = deriveCashBlock(categories, {}, [], null, null, [
        depositEvent({ id: 1, tender: "transfer", amountSatang: 50_000 }),
        depositEvent({ id: 2, tender: "credit", amountSatang: 60_000 }),
        depositEvent({ id: 3, tender: "web", amountSatang: 70_000 }),
        depositEvent({ id: 4, tender: "other", amountSatang: 80_000 }),
      ]);
      expect(block.bankedSatang).toBe(0);
    });

    test("combines with room/other/bar cash AND the heldBack/broughtForward adjustment in the same formula", () => {
      const income: Record<number, IncomeCell> = {
        1: incomeCell(1, 49_000), // room cash
        2: incomeCell(2, 2_000), // bar cash
      };
      const block = deriveCashBlock(categories, income, [], 12_000, 8_500, [depositEvent({ amountSatang: 89_000 })]);
      expect(block.bankedSatang).toBe(49_000 + 2_000 + 89_000 - 12_000 + 8_500);
    });
  });
});

describe("depositCashTotals", () => {
  function depositEvent(overrides: Partial<DepositEvent> = {}): DepositEvent {
    return {
      id: 1,
      property: "hf",
      date: "2026-08-01",
      kind: "received",
      bookingNo: null,
      guestName: null,
      tender: "cash",
      amountSatang: 1_000,
      note: null,
      source: "manual",
      pmsRef: null,
      createdAt: "2026-08-01 10:00:00",
      createdBy: "tester@thehfhotel.org",
      updatedAt: "2026-08-01 10:00:00",
      updatedBy: "tester@thehfhotel.org",
      ...overrides,
    };
  }

  test("empty list -> both zero", () => {
    expect(depositCashTotals([])).toEqual({ depositCashInSatang: 0, depositCashOutSatang: 0 });
  });

  test("sums cash received into depositCashInSatang, cash refunded into depositCashOutSatang", () => {
    const totals = depositCashTotals([
      depositEvent({ id: 1, kind: "received", amountSatang: 89_000 }),
      depositEvent({ id: 2, kind: "received", amountSatang: 10_000 }),
      depositEvent({ id: 3, kind: "refunded", amountSatang: 30_000 }),
    ]);
    expect(totals).toEqual({ depositCashInSatang: 99_000, depositCashOutSatang: 30_000 });
  });

  test("non-cash tenders are excluded entirely, regardless of kind", () => {
    const totals = depositCashTotals([
      depositEvent({ id: 1, tender: "transfer", kind: "received", amountSatang: 50_000 }),
      depositEvent({ id: 2, tender: "credit", kind: "refunded", amountSatang: 20_000 }),
    ]);
    expect(totals).toEqual({ depositCashInSatang: 0, depositCashOutSatang: 0 });
  });
});

describe("lineArithmeticMismatch", () => {
  function lineReceiving(satang: number): BookingLine {
    return makeLine({
      grossRoomSatang: 100_000,
      grossOtherSatang: 0,
      discountSatang: 0,
      tenders: { ...zeroTenders(), cash: satang },
    });
  }

  test("a 99 satang discrepancy is within tolerance", () => {
    expect(lineArithmeticMismatch(lineReceiving(100_000 + 99))).toBe(false);
  });

  test("a 101 satang discrepancy exceeds tolerance", () => {
    expect(lineArithmeticMismatch(lineReceiving(100_000 + 101))).toBe(true);
  });

  test("exactly at the tolerance boundary is not a mismatch", () => {
    expect(lineArithmeticMismatch(lineReceiving(100_000 + RECONCILE_TOLERANCE_SATANG))).toBe(false);
  });

  test("an exactly-reconciling line is never a mismatch", () => {
    expect(lineArithmeticMismatch(lineReceiving(100_000))).toBe(false);
  });
});

// hfville parity. None of the functions in bookings.ts branch on `property`
// at all — it rides along on BookingLine/Category/OtherIncomeItem/
// DepositEvent purely as a passthrough field the arithmetic never inspects
// (property-specific ROUTING, e.g. which bank column a PMS credit payment
// lands in, lives one layer up in db.ts's candidateTenderPatch — out of
// scope for this file). These tests exist anyway for the same reason
// rollup.test.ts's hfville describe block does: an HF-shaped fixture suite
// is exactly the failure mode that let a real customer-join bug ship
// unnoticed elsewhere in this app, so every pure function that touches
// property-tagged data gets its own hfville-shaped run, table-driven where
// the assertion is identical, dedicated where the fixture shape itself is
// property-specific (hfville's real book_no format, its credit_kbank-heavy
// tender profile per db.ts's AUTO-PLACEMENT POLICY).
describe("hfville parity (property is a pure passthrough — no arithmetic branches on it)", () => {
  const HFVILLE: Property = "hfville";

  // Table-driven core: the SAME tender shape produces IDENTICAL totals for
  // both properties.
  for (const property of ["hf", "hfville"] as const) {
    test(`property=${property}: computeBookingTotals sums tenders and excludes drafts identically`, () => {
      const confirmed = makeLine({
        id: 1,
        property,
        bookingNo: property === "hfville" ? "R001511" : "B-1001", // hfville-real bare book_no shape
        grossRoomSatang: 100_000,
        tenders: { ...zeroTenders(), cash: 60_000, transfer_kbank: 40_000 },
      });
      const draft = makeLine({
        id: 2,
        property,
        draft: true,
        source: "pms",
        grossRoomSatang: 999_000,
        tenders: { ...zeroTenders(), cash: 999_000 },
      });

      const totals = computeBookingTotals([confirmed, draft]);
      expect(totals.lineCount).toBe(1);
      expect(totals.byTender.cash).toBe(60_000);
      expect(totals.byTender.transfer_kbank).toBe(40_000);
      expect(totals.receivedSatang).toBe(100_000);
    });

    test(`property=${property}: deriveIncomeFromBookings maps tenders to CategoryKeys identically`, () => {
      const line = makeLine({
        property,
        tenders: { ...zeroTenders(), deposit_applied: 79_000, cash: 20_000, credit_kbank: 18_000 },
      });
      const derived = deriveIncomeFromBookings([line]);
      expect(derived.deposit_applied).toBe(79_000);
      expect(derived.room_cash).toBe(20_000);
      expect(derived.credit_kbank).toBe(18_000);
    });
  }

  // hfville-specific tender shape: per db.ts's AUTO-PLACEMENT POLICY,
  // hfville routes PMS credit-card money into credit_kbank (single bank in
  // its history) — unlike hf, which leaves credit unplaced (two banks, can't
  // infer). computeBookingTotals/deriveIncomeFromBookings must not care
  // either way — this is a fixture-realism check, not a new code path.
  test("an hfville line with credit_kbank populated (its realistic auto-placed tender) totals and derives correctly", () => {
    const line = makeLine({
      property: HFVILLE,
      bookingNo: "R001453",
      grossRoomSatang: 300_000,
      tenders: { ...zeroTenders(), cash: 10_000, credit_kbank: 18_000, transfer_kbank: 5_000 },
    });
    const totals = computeBookingTotals([line]);
    expect(totals.receivedSatang).toBe(33_000);
    expect(totals.byTender.credit_kbank).toBe(18_000);
    // hfville's live tender profile barely ever populates credit_icbc/
    // transfer_icbc (see the DB survey) — a realistic hfville fixture line
    // leaves them at 0, and the derivation must still surface 0, not omit
    // the keys or crash on an unset column.
    expect(totals.byTender.credit_icbc).toBe(0);
    expect(totals.byTender.transfer_icbc).toBe(0);

    const derived = deriveIncomeFromBookings([line]);
    expect(derived.credit_kbank).toBe(18_000);
    expect(derived.credit_icbc).toBeUndefined();
  });

  describe("deriveCashBlock / depositCashTotals — hfville categories", () => {
    // Mirrors the hf `categories` fixture above exactly, keyed to
    // property: "hfville" — the seed produces the identical categoryKey/
    // isCash shape on both properties (see db.test.ts's migration
    // coverage), so this fixture is not a divergence, just the hfville side
    // of the same shape.
    const hfvilleCategories: Category[] = [
      {
        id: 101,
        property: HFVILLE,
        kind: "income",
        nameTh: "ค่าห้องเงินสด",
        sort: 1,
        isCash: true,
        categoryKey: "room_cash",
        archivedAt: null,
        createdAt: "2026-01-01 00:00:00",
      },
      {
        id: 102,
        property: HFVILLE,
        kind: "income",
        nameTh: "บาร์น้ำ เงินสด",
        sort: 2,
        isCash: true,
        categoryKey: "bar_cash",
        archivedAt: null,
        createdAt: "2026-01-01 00:00:00",
      },
      {
        id: 103,
        property: HFVILLE,
        kind: "income",
        nameTh: "รายการอื่นๆ เงินสด",
        sort: 4,
        isCash: true,
        categoryKey: "other_cash",
        archivedAt: null,
        createdAt: "2026-01-01 00:00:00",
      },
    ];

    function hfvilleIncomeCell(categoryId: number, amountSatang: number): IncomeCell {
      return {
        categoryId,
        amountSatang,
        note: null,
        source: "manual",
        manual: true,
        updatedAt: "2026-07-29 10:00:00",
        updatedBy: "tester@thehfhotel.org",
      };
    }

    function hfvilleOtherIncomeItem(amountSatang: number, isCash: boolean): OtherIncomeItem {
      return {
        id: 1,
        property: HFVILLE,
        date: "2026-07-29",
        description: "รายการทดสอบ hfville",
        amountSatang,
        isCash,
        createdAt: "2026-07-29 08:00:00",
        createdBy: "tester@thehfhotel.org",
        updatedAt: "2026-07-29 08:00:00",
        updatedBy: "tester@thehfhotel.org",
      };
    }

    test("sums room cash, bar cash, and cash-only other-income into a banked total, same formula as hf", () => {
      const income: Record<number, IncomeCell> = {
        101: hfvilleIncomeCell(101, 49_000),
        102: hfvilleIncomeCell(102, 2_000),
      };
      const otherIncomeItems: OtherIncomeItem[] = [
        hfvilleOtherIncomeItem(5_000, true),
        hfvilleOtherIncomeItem(3_000, false),
      ];

      const block = deriveCashBlock(hfvilleCategories, income, otherIncomeItems);
      expect(block.roomCashSatang).toBe(49_000);
      expect(block.barCashSatang).toBe(2_000);
      expect(block.otherCashSatang).toBe(5_000);
      expect(block.bankedSatang).toBe(56_000);
    });

    test("an empty day derives an all-zero block for hfville too", () => {
      const block = deriveCashBlock(hfvilleCategories, {}, []);
      expect(block).toEqual({ roomCashSatang: 0, otherCashSatang: 0, barCashSatang: 0, bankedSatang: 0 });
    });

    function hfvilleDepositEvent(overrides: Partial<DepositEvent> = {}): DepositEvent {
      return {
        id: 1,
        property: HFVILLE,
        date: "2026-08-01",
        kind: "received",
        bookingNo: "R001511", // real hfville book_no shape (bare R+6-digit)
        guestName: "ทดสอบ มัดจำ hfville",
        tender: "cash",
        amountSatang: 89_000,
        note: null,
        source: "manual",
        pmsRef: null,
        createdAt: "2026-08-01 10:00:00",
        createdBy: "tester@thehfhotel.org",
        updatedAt: "2026-08-01 10:00:00",
        updatedBy: "tester@thehfhotel.org",
        ...overrides,
      };
    }

    // Wave C (docs/adr/0001): the deposit cash-terms fold-in must apply to
    // hfville identically to hf, even though the live survey shows
    // hfville's own deposit-lifecycle rows are far rarer (9 groups total vs
    // hf's 669) and, as of the survey, none observed multi-line there — see
    // the module-level FIXTURE ADVICE this suite was built against. Rarity
    // of live data is not a reason to under-test the rule itself.
    test("a received cash deposit ADDS to bankedSatang for hfville, with no income-cell effect", () => {
      const block = deriveCashBlock(hfvilleCategories, {}, [], null, null, [hfvilleDepositEvent({ amountSatang: 89_000 })]);
      expect(block.bankedSatang).toBe(89_000);
      expect(block.roomCashSatang).toBe(0);
    });

    test("a refunded cash deposit SUBTRACTS from bankedSatang for hfville", () => {
      const block = deriveCashBlock(hfvilleCategories, {}, [], null, null, [
        hfvilleDepositEvent({ kind: "refunded", amountSatang: 30_000 }),
      ]);
      expect(block.bankedSatang).toBe(-30_000);
    });

    test("non-cash deposit tenders never touch bankedSatang for hfville", () => {
      const block = deriveCashBlock(hfvilleCategories, {}, [], null, null, [
        hfvilleDepositEvent({ id: 1, tender: "transfer", amountSatang: 50_000 }),
        hfvilleDepositEvent({ id: 2, tender: "credit", amountSatang: 60_000 }),
      ]);
      expect(block.bankedSatang).toBe(0);
    });

    test("heldBackSatang/broughtForwardSatang fold into bankedSatang for hfville, same formula as hf", () => {
      const income: Record<number, IncomeCell> = { 101: hfvilleIncomeCell(101, 49_000), 102: hfvilleIncomeCell(102, 2_000) };
      const block = deriveCashBlock(hfvilleCategories, income, [], 12_000, 8_500, [hfvilleDepositEvent({ amountSatang: 89_000 })]);
      expect(block.bankedSatang).toBe(49_000 + 2_000 + 89_000 - 12_000 + 8_500);
    });

    test("depositCashTotals sums hfville cash events independent of the category/income machinery above", () => {
      const totals = depositCashTotals([
        hfvilleDepositEvent({ id: 1, kind: "received", amountSatang: 89_000 }),
        hfvilleDepositEvent({ id: 2, kind: "received", amountSatang: 10_000 }),
        hfvilleDepositEvent({ id: 3, kind: "refunded", amountSatang: 30_000 }),
        hfvilleDepositEvent({ id: 4, tender: "transfer", kind: "received", amountSatang: 999_000 }), // excluded: non-cash
      ]);
      expect(totals).toEqual({ depositCashInSatang: 99_000, depositCashOutSatang: 30_000 });
    });
  });

  test("lineArithmeticMismatch tolerance is identical for hfville", () => {
    const line = makeLine({
      property: HFVILLE,
      bookingNo: "R001453",
      grossRoomSatang: 100_000,
      grossOtherSatang: 0,
      discountSatang: 0,
      tenders: { ...zeroTenders(), cash: 100_000 + RECONCILE_TOLERANCE_SATANG + 1 },
    });
    expect(lineArithmeticMismatch(line)).toBe(true);
  });
});
