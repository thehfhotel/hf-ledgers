import { describe, expect, test } from "bun:test";
import {
  computeBookingTotals,
  deriveCashBlock,
  deriveIncomeFromBookings,
  lineArithmeticMismatch,
  RECONCILE_TOLERANCE_SATANG,
} from "./bookings.ts";
import { TENDERS } from "./types.ts";
import type { BookingLine, Category, IncomeCell, OtherIncomeItem, Tender } from "./types.ts";

function zeroTenders(): Record<Tender, number> {
  return Object.fromEntries(TENDERS.map((tender) => [tender, 0])) as Record<Tender, number>;
}

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
