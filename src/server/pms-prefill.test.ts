// Pure-layer tests for pms-prefill.ts: day-window math and the
// row->candidate mapping (the money-gotcha dedup, deposit/refund routing,
// room/nights/guest-name assembly). No network — `fetchDayPayments` is
// exercised only through its `_internal` test override and its
// not-configured throw path, never a real PMS connection.
//
// No repo-wide "env before import" constraint applies here: unlike
// db.ts/server.ts, pms-prefill.ts reads process.env LAZILY at call time
// (see its top-of-file note), so pmsConfigured tests can set/unset env
// vars freely per-test. They still save + restore the original values in
// afterEach, since `bun test` runs every file in one process and a leaked
// override could affect a later file that imports server.ts.

import { afterEach, describe, expect, test } from "bun:test";
import {
  _internal,
  bangkokDayWindow,
  fetchDayPayments,
  mapLedgerRows,
  pmsConfigured,
  type PrefillCandidate,
  type RawLedgerRow,
} from "./pms-prefill.ts";

const ORIGINAL_HF = process.env.PMS_DB_URL_HF;
const ORIGINAL_HFVILLE = process.env.PMS_DB_URL_HFVILLE;

afterEach(() => {
  if (ORIGINAL_HF === undefined) delete process.env.PMS_DB_URL_HF;
  else process.env.PMS_DB_URL_HF = ORIGINAL_HF;
  if (ORIGINAL_HFVILLE === undefined) delete process.env.PMS_DB_URL_HFVILLE;
  else process.env.PMS_DB_URL_HFVILLE = ORIGINAL_HFVILLE;
  _internal.setFetchDayPaymentsForTests(null);
});

describe("pmsConfigured", () => {
  test("false for both properties when neither env var is set", () => {
    delete process.env.PMS_DB_URL_HF;
    delete process.env.PMS_DB_URL_HFVILLE;
    expect(pmsConfigured("hf")).toBe(false);
    expect(pmsConfigured("hfville")).toBe(false);
  });

  test("hf true only when PMS_DB_URL_HF is set", () => {
    process.env.PMS_DB_URL_HF = "postgres://example/hf";
    delete process.env.PMS_DB_URL_HFVILLE;
    expect(pmsConfigured("hf")).toBe(true);
    expect(pmsConfigured("hfville")).toBe(false);
  });

  test("hfville true only when PMS_DB_URL_HFVILLE is set", () => {
    delete process.env.PMS_DB_URL_HF;
    process.env.PMS_DB_URL_HFVILLE = "postgres://example/hfville";
    expect(pmsConfigured("hf")).toBe(false);
    expect(pmsConfigured("hfville")).toBe(true);
  });

  test("an empty string counts as unset", () => {
    process.env.PMS_DB_URL_HF = "";
    expect(pmsConfigured("hf")).toBe(false);
  });
});

describe("bangkokDayWindow", () => {
  test("normal day: window is exactly [T00:00+07:00, nextT00:00+07:00)", () => {
    const { fromIso, toIso } = bangkokDayWindow("2026-06-15");
    expect(fromIso).toBe("2026-06-14T17:00:00.000Z");
    expect(toIso).toBe("2026-06-15T17:00:00.000Z");
  });

  test("month rollover: Jan 31 -> Feb 1", () => {
    const { fromIso, toIso } = bangkokDayWindow("2026-01-31");
    expect(fromIso).toBe("2026-01-30T17:00:00.000Z");
    expect(toIso).toBe("2026-01-31T17:00:00.000Z"); // = 2026-02-01T00:00:00+07:00
  });

  test("year rollover: Dec 31 -> Jan 1 next year", () => {
    const { fromIso, toIso } = bangkokDayWindow("2026-12-31");
    expect(fromIso).toBe("2026-12-30T17:00:00.000Z");
    expect(toIso).toBe("2026-12-31T17:00:00.000Z"); // = 2027-01-01T00:00:00+07:00
  });

  test("window is always exactly 24 hours", () => {
    const { fromIso, toIso } = bangkokDayWindow("2026-03-01");
    expect(new Date(toIso).getTime() - new Date(fromIso).getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

/** Default line: a single-line room payment, everything else zeroed. */
function row(overrides: Partial<RawLedgerRow>): RawLedgerRow {
  return {
    ledger_legacy_id: 1,
    ledger_pay_no: "R2604-0250",
    ledger_cin_no: "CH26-005236",
    ledger_ds_label: "101",
    ledger_ds_name: "ค่าห้อง",
    ledger_ds_id: "P001",
    ledger_ds_num: "1",
    ledger_cash: "0",
    ledger_credit: "0",
    ledger_tran: "0",
    ledger_web: "0",
    ledger_amount: "1000.00",
    cust_firstname: "สมชาย",
    cust_lastname: "ใจดี",
    ...overrides,
  };
}

describe("mapLedgerRows", () => {
  test("empty input yields empty output", () => {
    expect(mapLedgerRows([])).toEqual([]);
  });

  test("single-line payment: room amount, cash tender, guest name, room/nights", () => {
    const [c] = mapLedgerRows([
      row({
        ledger_legacy_id: 1,
        ledger_pay_no: "R2604-0001",
        ledger_ds_label: "203",
        ledger_ds_num: "2",
        ledger_amount: "2500.00",
        ledger_cash: "2500.00",
      }),
    ]);
    expect(c).toMatchObject({
      pmsRef: "R2604-0001",
      bookingNo: "CH26-005236",
      guestName: "สมชาย ใจดี",
      roomNo: "203",
      roomCount: 1,
      nights: 2,
      grossRoomSatang: 250_000,
      grossOtherSatang: 0,
      cashSatang: 250_000,
      webSatang: 0,
      depositSatang: 0,
      unplacedCreditSatang: 0,
      unplacedTranSatang: 0,
      isDeposit: false,
      isRefund: false,
    });
  });

  test("multi-line payment: tenders taken ONCE, never summed across lines (the money gotcha)", () => {
    const lines: RawLedgerRow[] = [
      row({
        ledger_legacy_id: 10,
        ledger_pay_no: "R2604-0100",
        ledger_ds_id: "P001",
        ledger_ds_label: "301",
        ledger_ds_num: "3",
        ledger_amount: "3000.00",
        ledger_cash: "1000.00",
      }),
      row({
        ledger_legacy_id: 11,
        ledger_pay_no: "R2604-0100",
        ledger_ds_id: "P002",
        ledger_ds_name: "บาร์น้ำ",
        ledger_ds_label: "",
        ledger_amount: "150.00",
        ledger_cash: "1000.00", // replicated, must NOT be summed again
      }),
      row({
        ledger_legacy_id: 12,
        ledger_pay_no: "R2604-0100",
        ledger_ds_id: "P003",
        ledger_ds_name: "ค่าอาหาร",
        ledger_ds_label: "",
        ledger_amount: "200.00",
        ledger_cash: "1000.00", // replicated, must NOT be summed again
      }),
    ];
    const [c] = mapLedgerRows(lines);
    // Line amounts genuinely itemized -> summed raw.
    expect(c!.grossRoomSatang).toBe(300_000); // 3000.00
    expect(c!.grossOtherSatang).toBe(35_000); // 150.00 + 200.00
    // Tender taken once: 1000.00, NOT 3000.00 (which a naive sum-across-lines
    // bug would produce — the verified real-world 57% inflation case).
    expect(c!.cashSatang).toBe(100_000);
  });

  test("blank pay_no falls back to lid:<legacy id>", () => {
    const [c] = mapLedgerRows([row({ ledger_legacy_id: 555, ledger_pay_no: "" })]);
    expect(c!.pmsRef).toBe("lid:555");
  });

  test("whitespace-only pay_no also falls back to lid:", () => {
    const [c] = mapLedgerRows([row({ ledger_legacy_id: 556, ledger_pay_no: "   " })]);
    expect(c!.pmsRef).toBe("lid:556");
  });

  test("null pay_no also falls back to lid:", () => {
    const [c] = mapLedgerRows([row({ ledger_legacy_id: 557, ledger_pay_no: null })]);
    expect(c!.pmsRef).toBe("lid:557");
  });

  test("deposit payment routes credit+tran to depositSatang (มัดจำ is bank-agnostic)", () => {
    const [c] = mapLedgerRows([
      row({
        ledger_legacy_id: 20,
        ledger_pay_no: "R2604-0200",
        ledger_ds_name: "เงินจองห้อง",
        ledger_ds_label: null,
        ledger_amount: "1000.00",
        ledger_credit: "600.00",
        ledger_tran: "400.00",
      }),
    ]);
    expect(c!.isDeposit).toBe(true);
    expect(c!.depositSatang).toBe(100_000); // 600.00 + 400.00
    expect(c!.unplacedCreditSatang).toBe(0);
    expect(c!.unplacedTranSatang).toBe(0);
  });

  test("non-deposit payment leaves credit/tran unplaced (amount known, bank unknown)", () => {
    const [c] = mapLedgerRows([
      row({ ledger_legacy_id: 21, ledger_pay_no: "R2604-0201", ledger_credit: "700.00", ledger_tran: "300.00" }),
    ]);
    expect(c!.isDeposit).toBe(false);
    expect(c!.depositSatang).toBe(0);
    expect(c!.unplacedCreditSatang).toBe(70_000);
    expect(c!.unplacedTranSatang).toBe(30_000);
  });

  test("negative net tender total is flagged as a refund", () => {
    const [c] = mapLedgerRows([
      row({
        ledger_legacy_id: 30,
        ledger_pay_no: "R2604-0300",
        ledger_cash: "-500.00",
        ledger_amount: "-500.00",
      }),
    ]);
    expect(c!.cashSatang).toBe(-50_000);
    expect(c!.isRefund).toBe(true);
  });

  test("positive net tender total is NOT a refund", () => {
    const [c] = mapLedgerRows([row({ ledger_legacy_id: 31, ledger_pay_no: "R2604-0301", ledger_cash: "500.00" })]);
    expect(c!.isRefund).toBe(false);
  });

  test("refund detection nets cash+web+credit+tran together, not any one column alone", () => {
    // Cash alone is positive but credit swings the payment net-negative.
    const [c] = mapLedgerRows([
      row({
        ledger_legacy_id: 32,
        ledger_pay_no: "R2604-0302",
        ledger_cash: "100.00",
        ledger_credit: "-300.00",
      }),
    ]);
    expect(c!.isRefund).toBe(true);
  });

  test("a negative individual tender (cash) with a larger positive one (web) nets non-negative but is still flagged as isRefund", () => {
    // Regression: cash and web are two of the three columns
    // insertPmsBookingLines writes into CHECK(col >= 0) DB columns
    // (t_cash/t_web/t_deposit). If isRefund only looked at the net total,
    // this candidate (net = +200.00) would sail through as "not a refund"
    // and then crash the insert transaction on the t_cash CHECK constraint.
    const [c] = mapLedgerRows([
      row({
        ledger_legacy_id: 33,
        ledger_pay_no: "R2604-0303",
        ledger_cash: "-100.00",
        ledger_web: "300.00",
        ledger_amount: "300.00",
      }),
    ]);
    expect(c!.cashSatang).toBe(-10_000);
    expect(c!.webSatang).toBe(30_000);
    expect(c!.isRefund).toBe(true);
  });

  test("depositSatang itself going negative (credit+tran combine negative) while cash is positive enough to keep the net non-negative is still flagged as isRefund", () => {
    // Same shape as the cash/web case but through the deposit path:
    // isDeposit routes credit+tran into depositSatang, which is also
    // written to a CHECK(col >= 0) column (t_deposit). A large positive
    // cash line on the same payment can keep the NET non-negative even
    // while depositSatang itself is negative.
    const [c] = mapLedgerRows([
      row({
        ledger_legacy_id: 34,
        ledger_pay_no: "R2604-0304",
        ledger_ds_name: "เงินจองห้อง",
        ledger_cash: "1000.00",
        ledger_credit: "-80.00",
        ledger_tran: "-30.00",
        ledger_amount: "890.00",
      }),
    ]);
    expect(c!.cashSatang).toBe(100_000);
    expect(c!.depositSatang).toBe(-11_000); // -8000 (credit) + -3000 (tran) = -11000
    expect(c!.isRefund).toBe(true);
  });

  test("mixed P001/non-P001 lines: room and other amounts aggregate independently", () => {
    const lines: RawLedgerRow[] = [
      row({ ledger_legacy_id: 40, ledger_pay_no: "R2604-0400", ledger_ds_id: "P001", ledger_amount: "1200.00" }),
      row({
        ledger_legacy_id: 41,
        ledger_pay_no: "R2604-0400",
        ledger_ds_id: "P099",
        ledger_ds_name: "มินิบาร์",
        ledger_amount: "80.00",
      }),
      row({ ledger_legacy_id: 42, ledger_pay_no: "R2604-0400", ledger_ds_id: "P001", ledger_amount: "1200.00" }),
    ];
    const [c] = mapLedgerRows(lines);
    expect(c!.grossRoomSatang).toBe(240_000); // 1200 + 1200
    expect(c!.grossOtherSatang).toBe(8_000); // 80.00
  });

  describe("guest name assembly", () => {
    test("joins first + last, trimmed", () => {
      const [c] = mapLedgerRows([row({ cust_firstname: "  สมชาย ", cust_lastname: " ใจดี " })]);
      expect(c!.guestName).toBe("สมชาย ใจดี");
    });

    test("null when both names are blank", () => {
      const [c] = mapLedgerRows([row({ cust_firstname: null, cust_lastname: null })]);
      expect(c!.guestName).toBeNull();
    });

    test("uses whichever half is present when the other is missing", () => {
      const [c] = mapLedgerRows([row({ cust_firstname: "สมชาย", cust_lastname: null })]);
      expect(c!.guestName).toBe("สมชาย");
    });
  });

  test("roomCount counts distinct room labels across P001 lines (repeats not double-counted)", () => {
    const lines: RawLedgerRow[] = [
      row({
        ledger_legacy_id: 50,
        ledger_pay_no: "R2604-0500",
        ledger_ds_id: "P001",
        ledger_ds_label: "101",
        ledger_ds_num: "2",
      }),
      row({
        ledger_legacy_id: 51,
        ledger_pay_no: "R2604-0500",
        ledger_ds_id: "P001",
        ledger_ds_label: "102",
        ledger_ds_num: "2",
      }),
      row({
        ledger_legacy_id: 52,
        ledger_pay_no: "R2604-0500",
        ledger_ds_id: "P001",
        ledger_ds_label: "101", // repeat of the first room's label
        ledger_ds_num: "2",
      }),
    ];
    const [c] = mapLedgerRows(lines);
    expect(c!.roomCount).toBe(2);
    expect(c!.roomNo).toBe("101"); // first P001 line's label
    expect(c!.nights).toBe(2);
  });

  test("roomCount/roomNo/nights are null when the payment has no P001 line", () => {
    const [c] = mapLedgerRows([row({ ledger_ds_id: "P099", ledger_ds_label: "x", ledger_ds_num: "5" })]);
    expect(c!.roomCount).toBeNull();
    expect(c!.roomNo).toBeNull();
    expect(c!.nights).toBeNull();
  });

  test("comma-formatted amount strings ('1,234.50') parse to the correct satang", () => {
    const [c] = mapLedgerRows([row({ ledger_amount: "1,234.50" })]);
    expect(c!.grossRoomSatang).toBe(123_450);
  });

  test("null/empty amount cells are null-safe (treated as 0)", () => {
    const [nullCase] = mapLedgerRows([row({ ledger_amount: null })]);
    expect(nullCase!.grossRoomSatang).toBe(0);
    const [emptyCase] = mapLedgerRows([row({ ledger_amount: "" })]);
    expect(emptyCase!.grossRoomSatang).toBe(0);
  });

  test("output is sorted deterministically by payment key", () => {
    const keys = mapLedgerRows([
      row({ ledger_legacy_id: 2, ledger_pay_no: "R2604-0002" }),
      row({ ledger_legacy_id: 1, ledger_pay_no: "R2604-0001" }),
      row({ ledger_legacy_id: 3, ledger_pay_no: "" }),
    ]).map((c) => c.pmsRef);
    expect(keys).toEqual(["R2604-0001", "R2604-0002", "lid:3"]);
  });
});

describe("fetchDayPayments", () => {
  test("consults the _internal test override before anything else", async () => {
    delete process.env.PMS_DB_URL_HF; // deliberately NOT configured
    const fake: PrefillCandidate[] = [
      {
        pmsRef: "R2604-9999",
        bookingNo: null,
        guestName: null,
        roomNo: null,
        roomCount: null,
        nights: null,
        grossRoomSatang: 0,
        grossOtherSatang: 0,
        depositSatang: 0,
        cashSatang: 0,
        webSatang: 0,
        unplacedCreditSatang: 0,
        unplacedTranSatang: 0,
        isRefund: false,
        isDeposit: false,
      },
    ];
    _internal.setFetchDayPaymentsForTests(async () => fake);
    const result = await fetchDayPayments("hf", "2026-06-01");
    expect(result).toBe(fake);
  });

  test("throws plainly when the property is not configured and no override is set", async () => {
    delete process.env.PMS_DB_URL_HF;
    await expect(fetchDayPayments("hf", "2026-06-01")).rejects.toThrow();
  });
});
