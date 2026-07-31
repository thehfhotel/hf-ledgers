// Pure-layer tests for pms-prefill.ts: day-window math and the
// row->candidate mapping (the money-gotcha dedup, ds_name classification,
// deposit-lifecycle routing, sign anomaly, refund routing). No network —
// `fetchDayPayments` is exercised only through its `_internal` test
// override and its not-configured throw path, never a real PMS connection.
//
// Wave C rewrite (docs/adr/0001, plan section C0-C3): the real six-value
// ds_name vocabulary replaces the pre-Wave-C `DEPOSIT_MARKER` ("เงินจอง",
// which matched 0 of 5,714 real rows — the exact bug this rewrite fixes by
// construction). `row()`'s own override type below narrows `ledger_ds_name`
// to `LedgerDsName | \`${typeof DEPOSIT_APPLIED_PREFIX}${string}\`` —
// inventing a label is now a COMPILE ERROR, not a silently-wrong fixture.
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
  DEPOSIT_APPLIED_PREFIX,
  fetchDayPayments,
  LEDGER_DS_NAMES,
  mapLedgerRows,
  pmsConfigured,
  type LedgerDsName,
  type MapLedgerRowsResult,
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

/** The fixture vocabulary compiler enforcement (C-tests): `ledger_ds_name`
 * is typed to the real six labels plus the ตัดยอดล่วงหน้า prefix family —
 * assigning an invented label anywhere below is a TYPE ERROR, not a
 * silently-ignored fixture (the exact bug class the pre-Wave-C
 * `DEPOSIT_MARKER` was — it matched 0 of 5,714 real rows and nothing
 * caught it). */
type RowOverrides = Partial<Omit<RawLedgerRow, "ledger_ds_name">> & {
  ledger_ds_name?: LedgerDsName | `${typeof DEPOSIT_APPLIED_PREFIX}${string}` | null;
};

/** Default line: a single-line ค่าห้อง (room charge) payment, everything
 * else zeroed. */
function row(overrides: RowOverrides): RawLedgerRow {
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
    ledger_free: "0",
    ledger_status: null,
    ledger_note: null,
    cust_title: "",
    cust_firstname: "สมชาย",
    cust_lastname: "ใจดี",
    cust_name2: "",
    ...overrides,
  };
}

function map(rows: RawLedgerRow[]): MapLedgerRowsResult {
  return mapLedgerRows(rows);
}

describe("LEDGER_DS_NAMES", () => {
  test("is exactly the six real labels (never the invented pre-Wave-C marker)", () => {
    expect(LEDGER_DS_NAMES).toEqual(["ค่าห้อง", "จ่ายล่วงหน้า", "ยกเลิกห้อง", "คืนเงินส่วนเกิน", "คืนเงินจองห้อง", "ค่าปรับ"]);
  });
});

describe("mapLedgerRows: empty input", () => {
  test("yields empty everything", () => {
    expect(map([])).toEqual({ bookingCandidates: [], depositCandidates: [], anomalies: [] });
  });
});

describe("mapLedgerRows: each of the 7 recognized events", () => {
  test("ค่าห้อง -> booking candidate, grossRoomSatang, room/guest/nights", () => {
    const result = map([
      row({
        ledger_legacy_id: 1,
        ledger_pay_no: "R2604-0001",
        ledger_ds_label: "203",
        ledger_ds_num: "2",
        ledger_amount: "2500.00",
        ledger_cash: "2500.00",
      }),
    ]);
    expect(result.depositCandidates).toEqual([]);
    expect(result.anomalies).toEqual([]);
    expect(result.bookingCandidates).toHaveLength(1);
    expect(result.bookingCandidates[0]).toMatchObject({
      pmsRef: "R2604-0001",
      bookingNo: "CH26-005236",
      guestName: "สมชาย ใจดี",
      roomNo: "203",
      roomCount: 1,
      nights: 2,
      grossRoomSatang: 250_000,
      grossOtherSatang: 0,
      cashSatang: 250_000,
      appliedDepositSatang: 0,
      appliedDepositBookingNos: [],
      isRefund: false,
    });
  });

  test("จ่ายล่วงหน้า -> deposit candidate, kind received, bookingNo from ledger_cin_no", () => {
    const result = map([
      row({
        ledger_legacy_id: 2,
        ledger_pay_no: "R2604-0002",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cin_no: "R014843",
        ledger_ds_label: null,
        ledger_amount: "890.00",
        ledger_cash: "890.00",
      }),
    ]);
    expect(result.bookingCandidates).toEqual([]);
    expect(result.anomalies).toEqual([]);
    expect(result.depositCandidates).toEqual([
      {
        pmsRef: "R2604-0002",
        kind: "received",
        bookingNo: "R014843",
        guestName: "สมชาย ใจดี",
        tender: "cash",
        amountSatang: 89_000,
        note: null,
      },
    ]);
  });

  test("ตัดยอดล่วงหน้า -> booking candidate carries appliedDepositSatang from ledger_free + the R-number from its own label; ledger_amount excluded from gross", () => {
    const result = map([
      row({
        ledger_legacy_id: 3,
        ledger_pay_no: "R2604-0003",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014843",
        ledger_cin_no: "CH26-005269",
        ledger_ds_label: null,
        ledger_ds_id: "P001",
        ledger_amount: "890.00", // V1: equals the applied amount, NOT 0 — must never reach gross
        ledger_free: "890.00",
      }),
    ]);
    expect(result.depositCandidates).toEqual([]);
    expect(result.anomalies).toEqual([]);
    expect(result.bookingCandidates).toHaveLength(1);
    const c = result.bookingCandidates[0]!;
    expect(c.grossRoomSatang).toBe(0); // NEVER the 890 from ledger_amount
    expect(c.appliedDepositSatang).toBe(89_000);
    expect(c.appliedDepositBookingNos).toEqual(["R014843"]);
    expect(c.bookingNo).toBe("CH26-005269");
  });

  test("ยกเลิกห้อง -> grossRoomSatang reduced (sign anomaly, see dedicated describe below for both raw signs)", () => {
    const result = map([
      row({ ledger_legacy_id: 4, ledger_pay_no: "R2604-0004", ledger_ds_name: "ยกเลิกห้อง", ledger_amount: "500.00" }),
    ]);
    expect(result.bookingCandidates[0]!.grossRoomSatang).toBe(-50_000);
  });

  test("คืนเงินส่วนเกิน -> folds into grossOtherSatang like any other line; a same-line negative cash tender flags isRefund (report-not-insert, unchanged)", () => {
    const result = map([
      row({
        ledger_legacy_id: 5,
        ledger_pay_no: "R2604-0005",
        ledger_ds_name: "คืนเงินส่วนเกิน",
        ledger_amount: "-200.00",
        ledger_cash: "-200.00",
      }),
    ]);
    expect(result.bookingCandidates).toHaveLength(1);
    const c = result.bookingCandidates[0]!;
    expect(c.grossOtherSatang).toBe(-20_000);
    expect(c.isRefund).toBe(true);
  });

  test("คืนเงินจองห้อง -> deposit candidate, kind refunded, magnitude only (the same tender column the deposit used, per C0's Refund-column finding)", () => {
    const result = map([
      row({
        ledger_legacy_id: 6,
        ledger_pay_no: "R2604-0006",
        ledger_ds_name: "คืนเงินจองห้อง",
        ledger_cin_no: "R015834",
        ledger_ds_label: null,
        ledger_amount: "-395.00",
        ledger_tran: "-395.00",
        ledger_free: "0",
      }),
    ]);
    expect(result.bookingCandidates).toEqual([]);
    expect(result.anomalies).toEqual([]);
    expect(result.depositCandidates).toEqual([
      {
        pmsRef: "R2604-0006",
        kind: "refunded",
        bookingNo: "R015834",
        guestName: "สมชาย ใจดี",
        tender: "transfer",
        amountSatang: 39_500, // magnitude, never negative
        note: null,
      },
    ]);
  });

  test("ค่าปรับ -> folds into grossOtherSatang", () => {
    const result = map([
      row({ ledger_legacy_id: 7, ledger_pay_no: "R2604-0007", ledger_ds_name: "ค่าปรับ", ledger_amount: "150.00" }),
    ]);
    expect(result.bookingCandidates[0]!.grossOtherSatang).toBe(15_000);
  });
});

describe("SEV-016/ITM-007 regression: classification is by ds_name, never ds_id", () => {
  test("a ค่าห้อง line whose ds_id is NOT P001 still counts as room revenue", () => {
    const result = map([
      row({
        ledger_legacy_id: 10,
        ledger_pay_no: "R2604-0010",
        ledger_ds_name: "ค่าห้อง",
        ledger_ds_id: null, // the old ds_id-keyed importer would have missed this row entirely
        ledger_amount: "1000.00",
      }),
    ]);
    expect(result.bookingCandidates[0]!.grossRoomSatang).toBe(100_000);
  });

  test("a ตัดยอดล่วงหน้า line's ds_id being P001 (same as a room line) never lets its ledger_amount into gross", () => {
    const result = map([
      row({
        ledger_legacy_id: 11,
        ledger_pay_no: "R2604-0011",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014850",
        ledger_ds_id: "P001",
        ledger_amount: "500.00",
        ledger_free: "500.00",
      }),
    ]);
    expect(result.bookingCandidates[0]!.grossRoomSatang).toBe(0);
    expect(result.bookingCandidates[0]!.appliedDepositSatang).toBe(50_000);
  });
});

describe("sign anomaly (ยกเลิกห้อง): ค่าห้อง 2000 + ยกเลิกห้อง 500, both raw signs -> gross 1500", () => {
  test("raw ledger_amount +500 (the buggy stored sign) still SUBTRACTS", () => {
    const result = map([
      row({ ledger_legacy_id: 20, ledger_pay_no: "R2604-0020", ledger_ds_name: "ค่าห้อง", ledger_amount: "2000.00" }),
      row({ ledger_legacy_id: 21, ledger_pay_no: "R2604-0020", ledger_ds_name: "ยกเลิกห้อง", ledger_amount: "500.00" }),
    ]);
    expect(result.bookingCandidates).toHaveLength(1);
    expect(result.bookingCandidates[0]!.grossRoomSatang).toBe(150_000);
  });

  test("raw ledger_amount -500 also SUBTRACTS (never doubles up to -1000)", () => {
    const result = map([
      row({ ledger_legacy_id: 22, ledger_pay_no: "R2604-0021", ledger_ds_name: "ค่าห้อง", ledger_amount: "2000.00" }),
      row({ ledger_legacy_id: 23, ledger_pay_no: "R2604-0021", ledger_ds_name: "ยกเลิกห้อง", ledger_amount: "-500.00" }),
    ]);
    expect(result.bookingCandidates).toHaveLength(1);
    expect(result.bookingCandidates[0]!.grossRoomSatang).toBe(150_000);
  });
});

describe("applied-deposit group: ค่าห้อง 2000 + ตัดยอดล่วงหน้า (free 790) in ONE payment", () => {
  test("gross stays 2000, appliedDepositSatang is 790, NEVER 2790 (the live double-booking bug this rewrite fixes)", () => {
    const result = map([
      row({ ledger_legacy_id: 30, ledger_pay_no: "R2604-0030", ledger_ds_name: "ค่าห้อง", ledger_amount: "2000.00" }),
      row({
        ledger_legacy_id: 31,
        ledger_pay_no: "R2604-0030",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014843",
        ledger_amount: "790.00",
        ledger_free: "790.00",
      }),
    ]);
    expect(result.bookingCandidates).toHaveLength(1);
    const c = result.bookingCandidates[0]!;
    expect(c.grossRoomSatang).toBe(200_000);
    expect(c.appliedDepositSatang).toBe(79_000);
    expect(c.appliedDepositBookingNos).toEqual(["R014843"]);
  });
});

describe("free-without-applied anomaly", () => {
  test("a ยกเลิกห้อง line carrying a nonzero ledger_free, with no ตัดยอดล่วงหน้า line in the group, is flagged — never read into any figure", () => {
    const result = map([
      row({ ledger_legacy_id: 40, ledger_pay_no: "R2604-0040", ledger_ds_name: "ค่าห้อง", ledger_amount: "2000.00" }),
      row({
        ledger_legacy_id: 41,
        ledger_pay_no: "R2604-0040",
        ledger_ds_name: "ยกเลิกห้อง",
        ledger_amount: "100.00",
        ledger_free: "50.00", // unexplained — nothing in this group applies a deposit
      }),
    ]);
    expect(result.bookingCandidates).toHaveLength(1);
    expect(result.bookingCandidates[0]!.grossRoomSatang).toBe(200_000 - 10_000);
    expect(result.anomalies).toEqual([
      { pmsRef: "R2604-0040", reason: "free_without_applied", detail: "ยกเลิกห้อง (ledger_free 5000)" },
    ]);
  });

  test("ค่าห้อง's OWN nonzero ledger_free is a known discount/comp (V2) — never anomalous", () => {
    const result = map([
      row({
        ledger_legacy_id: 42,
        ledger_pay_no: "R2604-0041",
        ledger_ds_name: "ค่าห้อง",
        ledger_amount: "2000.00",
        ledger_free: "300.00", // a real discount/comp — must not trip the anomaly
      }),
    ]);
    expect(result.anomalies).toEqual([]);
    expect(result.bookingCandidates[0]!.grossRoomSatang).toBe(200_000);
  });

  test("no anomaly when a ตัดยอดล่วงหน้า line IS present, even alongside an unrelated free elsewhere", () => {
    const result = map([
      row({ ledger_legacy_id: 43, ledger_pay_no: "R2604-0042", ledger_ds_name: "ค่าห้อง", ledger_amount: "2000.00" }),
      row({
        ledger_legacy_id: 44,
        ledger_pay_no: "R2604-0042",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014900",
        ledger_amount: "500.00",
        ledger_free: "500.00",
      }),
    ]);
    expect(result.anomalies).toEqual([]);
  });
});

// F3 (Opus money-review, 2026-07-31): the OPPOSITE failure mode from V1's
// usual double-booking bug — an applied line whose ledger_free is 0 while
// its ledger_amount isn't used to book NOTHING at all, silently, with no
// anomaly to flag it. Money must never be invented from ledger_amount (V1/
// V2 rule that out), but the drop must be visible.
describe("applied_without_free anomaly (F3)", () => {
  test("ตัดยอดล่วงหน้า line with ledger_free 0 and nonzero ledger_amount books nothing, but IS flagged", () => {
    const result = map([
      row({
        ledger_legacy_id: 90,
        ledger_pay_no: "R2604-0090",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014843",
        ledger_amount: "890.00",
        ledger_free: "0",
      }),
    ]);
    expect(result.bookingCandidates).toHaveLength(1);
    const c = result.bookingCandidates[0]!;
    expect(c.grossRoomSatang).toBe(0); // never invented from ledger_amount
    expect(c.appliedDepositSatang).toBe(0);
    expect(result.anomalies).toEqual([
      { pmsRef: "R2604-0090", reason: "applied_without_free", detail: "ledger_amount 89000" },
    ]);
  });

  test("a normal applied line (both ledger_free and ledger_amount nonzero, equal per V1) never fires this anomaly", () => {
    const result = map([
      row({
        ledger_legacy_id: 91,
        ledger_pay_no: "R2604-0091",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014844",
        ledger_amount: "890.00",
        ledger_free: "890.00",
      }),
    ]);
    expect(result.anomalies).toEqual([]);
    expect(result.bookingCandidates[0]!.appliedDepositSatang).toBe(89_000);
  });
});

// F4 (Opus money-review, 2026-07-31): an unparseable R-number used to book
// the applied money silently with appliedDepositBookingNos: [] and no
// anomaly at all — contradicting this module's own "surfaced as a tripwire
// count, never dropped" design intent for a parse failure.
describe("unparseable_applied_booking_no anomaly (F4)", () => {
  test("a label whose suffix doesn't match R\\d{6} books the money but IS flagged, with an empty appliedDepositBookingNos", () => {
    const result = map([
      row({
        ledger_legacy_id: 92,
        ledger_pay_no: "R2604-0092",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:XYZ",
        ledger_amount: "890.00",
        ledger_free: "890.00",
      }),
    ]);
    expect(result.bookingCandidates).toHaveLength(1);
    const c = result.bookingCandidates[0]!;
    expect(c.appliedDepositSatang).toBe(89_000); // still booked — V1 is unconditional
    expect(c.appliedDepositBookingNos).toEqual([]);
    expect(result.anomalies).toEqual([
      {
        pmsRef: "R2604-0092",
        reason: "unparseable_applied_booking_no",
        detail: "ตัดยอดล่วงหน้า Booking No:XYZ (amount 89000)",
      },
    ]);
  });

  test("a well-formed R\\d{6} suffix parses cleanly and never fires this anomaly", () => {
    const result = map([
      row({
        ledger_legacy_id: 93,
        ledger_pay_no: "R2604-0093",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014843",
        ledger_amount: "890.00",
        ledger_free: "890.00",
      }),
    ]);
    expect(result.anomalies).toEqual([]);
    expect(result.bookingCandidates[0]!.appliedDepositBookingNos).toEqual(["R014843"]);
  });
});

// F5 (Opus money-review, 2026-07-31): buildDepositCandidates used to read
// tender columns per LINE, violating the module's own once-per-payment
// invariant (the same money-gotcha buildBookingCandidate's cash/web/
// credit/tran dedup already guards against) — a 2-line received group with
// a REPLICATED cash column emitted two candidates, masked only by the
// unique index silently dropping the "duplicate" (which would also drop a
// genuinely different second deposit sharing that tender).
describe("deposit tender dedup: read once per payment, never per line (F5)", () => {
  test("a 2-line จ่ายล่วงหน้า group with a replicated cash column yields exactly ONE candidate, not two", () => {
    const result = map([
      row({
        ledger_legacy_id: 94,
        ledger_pay_no: "R2604-0094",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cin_no: "R014843",
        ledger_ds_label: null,
        ledger_cash: "890.00",
      }),
      row({
        ledger_legacy_id: 95,
        ledger_pay_no: "R2604-0094",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cin_no: "R014843",
        ledger_ds_label: null,
        ledger_cash: "890.00", // replicated across lines — the money gotcha
      }),
    ]);
    expect(result.depositCandidates).toHaveLength(1);
    expect(result.depositCandidates[0]).toMatchObject({ tender: "cash", amountSatang: 89_000, kind: "received" });
  });

  test("still reads cash+tran split correctly from a genuinely single-line group (unaffected by the fix)", () => {
    const result = map([
      row({
        ledger_legacy_id: 96,
        ledger_pay_no: "R2604-0095",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cin_no: "R014999",
        ledger_ds_label: null,
        ledger_cash: "300.00",
        ledger_tran: "590.00",
      }),
    ]);
    expect(result.depositCandidates).toHaveLength(2);
  });
});

describe("voided rows: dropped in the PURE layer (defense in depth), NULL status active", () => {
  test("ledger_status = 'ยกเลิก' is dropped even without the SQL WHERE ever running", () => {
    const result = map([
      row({ ledger_legacy_id: 50, ledger_pay_no: "R2604-0050", ledger_status: "ยกเลิก", ledger_amount: "9999.00" }),
    ]);
    expect(result.bookingCandidates).toEqual([]);
    expect(result.depositCandidates).toEqual([]);
    expect(result.anomalies).toEqual([]);
  });

  test("ledger_status = NULL counts as active", () => {
    const result = map([
      row({ ledger_legacy_id: 51, ledger_pay_no: "R2604-0051", ledger_status: null, ledger_amount: "1000.00" }),
    ]);
    expect(result.bookingCandidates).toHaveLength(1);
  });

  test("a voided line is dropped even when it shares a payment key with an active line", () => {
    const result = map([
      row({ ledger_legacy_id: 52, ledger_pay_no: "R2604-0052", ledger_ds_name: "ค่าห้อง", ledger_amount: "1000.00" }),
      row({
        ledger_legacy_id: 53,
        ledger_pay_no: "R2604-0052",
        ledger_ds_name: "ค่าปรับ",
        ledger_status: "ยกเลิก",
        ledger_amount: "9999.00",
      }),
    ]);
    expect(result.bookingCandidates).toHaveLength(1);
    expect(result.bookingCandidates[0]!.grossRoomSatang).toBe(100_000);
    expect(result.bookingCandidates[0]!.grossOtherSatang).toBe(0);
  });
});

describe("received deposit split across cash + transfer -> two candidates", () => {
  test("one จ่ายล่วงหน้า line with both ledger_cash and ledger_tran nonzero yields two received DepositCandidates, same pmsRef", () => {
    const result = map([
      row({
        ledger_legacy_id: 60,
        ledger_pay_no: "R2604-0060",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cin_no: "R014999",
        ledger_ds_label: null,
        ledger_cash: "300.00",
        ledger_tran: "590.00",
      }),
    ]);
    expect(result.depositCandidates).toHaveLength(2);
    const cash = result.depositCandidates.find((d) => d.tender === "cash")!;
    const transfer = result.depositCandidates.find((d) => d.tender === "transfer")!;
    expect(cash).toMatchObject({ pmsRef: "R2604-0060", kind: "received", amountSatang: 30_000 });
    expect(transfer).toMatchObject({ pmsRef: "R2604-0060", kind: "received", amountSatang: 59_000 });
  });
});

describe("mixed R/CH scope in one payment group -> nothing + anomaly", () => {
  test("a group mixing จ่ายล่วงหน้า (deposit-scope) and ค่าห้อง (booking-scope) emits neither candidate type", () => {
    const result = map([
      row({ ledger_legacy_id: 70, ledger_pay_no: "R2604-0070", ledger_ds_name: "จ่ายล่วงหน้า", ledger_cash: "890.00" }),
      row({ ledger_legacy_id: 71, ledger_pay_no: "R2604-0070", ledger_ds_name: "ค่าห้อง", ledger_amount: "890.00" }),
    ]);
    expect(result.bookingCandidates).toEqual([]);
    expect(result.depositCandidates).toEqual([]);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]!.pmsRef).toBe("R2604-0070");
    expect(result.anomalies[0]!.reason).toBe("mixed_scope");
  });
});

describe("unknown ds_name -> anomaly, never money", () => {
  test("a ds_name matching none of the six labels nor the ตัดยอดล่วงหน้า prefix is flagged, no candidate emitted", () => {
    const rows: RawLedgerRow[] = [
      { ...row({ ledger_legacy_id: 80, ledger_pay_no: "R2604-0080", ledger_amount: "500.00" }), ledger_ds_name: "ค่าบริการพิเศษ" },
    ];
    const result = map(rows);
    expect(result.bookingCandidates).toEqual([]);
    expect(result.depositCandidates).toEqual([]);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]!.reason).toBe("unknown_ds_name");
    expect(result.anomalies[0]!.pmsRef).toBe("R2604-0080");
  });

  test("an unrecognized line alongside recognized ones still lets the recognized candidate through, plus its own anomaly", () => {
    const rows: RawLedgerRow[] = [
      row({ ledger_legacy_id: 81, ledger_pay_no: "R2604-0081", ledger_ds_name: "ค่าห้อง", ledger_amount: "1000.00" }),
      { ...row({ ledger_legacy_id: 82, ledger_pay_no: "R2604-0081", ledger_amount: "50.00" }), ledger_ds_name: "ค่าบริการพิเศษ" },
    ];
    const result = map(rows);
    expect(result.bookingCandidates).toHaveLength(1);
    expect(result.bookingCandidates[0]!.grossRoomSatang).toBe(100_000);
    expect(result.bookingCandidates[0]!.grossOtherSatang).toBe(0); // the unrecognized line's money never reaches gross
    expect(result.anomalies).toEqual([
      { pmsRef: "R2604-0081", reason: "unknown_ds_name", detail: "ค่าบริการพิเศษ (ds_id=P001, amount 5000)" },
    ]);
  });
});

describe("the money-gotcha dedup: tenders taken ONCE per booking candidate, never summed across lines", () => {
  test("multi-line ค่าห้อง payment: room+other amounts aggregate, cash tender read once", () => {
    const lines: RawLedgerRow[] = [
      row({
        ledger_legacy_id: 90,
        ledger_pay_no: "R2604-0100",
        ledger_ds_name: "ค่าห้อง",
        ledger_ds_label: "301",
        ledger_ds_num: "3",
        ledger_amount: "3000.00",
        ledger_cash: "1000.00",
      }),
      row({
        ledger_legacy_id: 91,
        ledger_pay_no: "R2604-0100",
        ledger_ds_name: "ค่าปรับ",
        ledger_ds_label: "",
        ledger_amount: "150.00",
        ledger_cash: "1000.00", // replicated, must NOT be summed again
      }),
      row({
        ledger_legacy_id: 92,
        ledger_pay_no: "R2604-0100",
        ledger_ds_name: "คืนเงินส่วนเกิน",
        ledger_ds_label: "",
        ledger_amount: "200.00",
        ledger_cash: "1000.00", // replicated, must NOT be summed again
      }),
    ];
    const result = map(lines);
    expect(result.bookingCandidates).toHaveLength(1);
    const c = result.bookingCandidates[0]!;
    expect(c.grossRoomSatang).toBe(300_000);
    expect(c.grossOtherSatang).toBe(35_000); // 150.00 + 200.00
    expect(c.cashSatang).toBe(100_000); // 1000.00, NOT 3000.00
  });

  test("blank pay_no falls back to lid:<legacy id>", () => {
    const result = map([row({ ledger_legacy_id: 555, ledger_pay_no: "" })]);
    expect(result.bookingCandidates[0]!.pmsRef).toBe("lid:555");
  });

  test("whitespace-only pay_no also falls back to lid:", () => {
    const result = map([row({ ledger_legacy_id: 556, ledger_pay_no: "   " })]);
    expect(result.bookingCandidates[0]!.pmsRef).toBe("lid:556");
  });

  test("null pay_no also falls back to lid:", () => {
    const result = map([row({ ledger_legacy_id: 557, ledger_pay_no: null })]);
    expect(result.bookingCandidates[0]!.pmsRef).toBe("lid:557");
  });
});

describe("refund detection on booking candidates (credit/transfer always unplaced now, no more isDeposit branch)", () => {
  test("non-deposit payment leaves credit/tran unplaced (amount known, bank unknown)", () => {
    const result = map([
      row({ ledger_legacy_id: 21, ledger_pay_no: "R2604-0201", ledger_credit: "700.00", ledger_tran: "300.00" }),
    ]);
    const c = result.bookingCandidates[0]!;
    expect(c.unplacedCreditSatang).toBe(70_000);
    expect(c.unplacedTranSatang).toBe(30_000);
    expect(c.isRefund).toBe(false);
  });

  test("negative net tender total is flagged as a refund", () => {
    const result = map([
      row({ ledger_legacy_id: 30, ledger_pay_no: "R2604-0300", ledger_cash: "-500.00", ledger_amount: "-500.00" }),
    ]);
    const c = result.bookingCandidates[0]!;
    expect(c.cashSatang).toBe(-50_000);
    expect(c.isRefund).toBe(true);
  });

  test("positive net tender total is NOT a refund", () => {
    const result = map([row({ ledger_legacy_id: 31, ledger_pay_no: "R2604-0301", ledger_cash: "500.00" })]);
    expect(result.bookingCandidates[0]!.isRefund).toBe(false);
  });

  test("refund detection nets cash+web+credit+tran together, not any one column alone", () => {
    const result = map([
      row({ ledger_legacy_id: 32, ledger_pay_no: "R2604-0302", ledger_cash: "100.00", ledger_credit: "-300.00" }),
    ]);
    expect(result.bookingCandidates[0]!.isRefund).toBe(true);
  });

  test("a negative individual tender (cash) with a larger positive one (web) nets non-negative but is still flagged as isRefund", () => {
    // Regression: cash and web are two of the columns insertPmsBookingLines
    // writes into CHECK(col >= 0) DB columns. If isRefund only looked at
    // the net total, this candidate (net = +200.00) would sail through as
    // "not a refund" and crash the insert transaction on the CHECK.
    const result = map([
      row({ ledger_legacy_id: 33, ledger_pay_no: "R2604-0303", ledger_cash: "-100.00", ledger_web: "300.00", ledger_amount: "300.00" }),
    ]);
    const c = result.bookingCandidates[0]!;
    expect(c.cashSatang).toBe(-10_000);
    expect(c.webSatang).toBe(30_000);
    expect(c.isRefund).toBe(true);
  });

  test("a negative unplacedTranSatang with a larger positive cash nets non-negative but is still flagged as isRefund", () => {
    const result = map([
      row({ ledger_legacy_id: 35, ledger_pay_no: "R2604-0305", ledger_cash: "2000.00", ledger_tran: "-500.00", ledger_amount: "1500.00" }),
    ]);
    const c = result.bookingCandidates[0]!;
    expect(c.cashSatang).toBe(200_000);
    expect(c.unplacedTranSatang).toBe(-50_000);
    expect(c.isRefund).toBe(true);
  });

  test("a negative unplacedCreditSatang with a larger positive cash nets non-negative but is still flagged as isRefund", () => {
    const result = map([
      row({ ledger_legacy_id: 36, ledger_pay_no: "R2604-0306", ledger_cash: "2000.00", ledger_credit: "-500.00", ledger_amount: "1500.00" }),
    ]);
    const c = result.bookingCandidates[0]!;
    expect(c.cashSatang).toBe(200_000);
    expect(c.unplacedCreditSatang).toBe(-50_000);
    expect(c.isRefund).toBe(true);
  });

  test("a คืนเงินจองห้อง refund is a magnitude on a DepositCandidate — never counted as a booking refund", () => {
    const result = map([
      row({
        ledger_legacy_id: 37,
        ledger_pay_no: "R2604-0307",
        ledger_ds_name: "คืนเงินจองห้อง",
        ledger_tran: "-395.00",
        ledger_amount: "-395.00",
      }),
    ]);
    expect(result.bookingCandidates).toEqual([]);
    expect(result.depositCandidates[0]!.amountSatang).toBe(39_500);
    expect(result.depositCandidates[0]!.kind).toBe("refunded");
  });
});

describe("guest name assembly", () => {
  test("joins first + last, trimmed", () => {
    const result = map([row({ cust_firstname: "  สมชาย ", cust_lastname: " ใจดี " })]);
    expect(result.bookingCandidates[0]!.guestName).toBe("สมชาย ใจดี");
  });

  test("null when both names are blank", () => {
    const result = map([row({ cust_firstname: null, cust_lastname: null })]);
    expect(result.bookingCandidates[0]!.guestName).toBeNull();
  });

  test("uses whichever half is present when the other is missing", () => {
    const result = map([row({ cust_firstname: "สมชาย", cust_lastname: null })]);
    expect(result.bookingCandidates[0]!.guestName).toBe("สมชาย");
  });

  test("prefix + first + last: prefix glued directly onto first (no space), one space before last", () => {
    const result = map([row({ cust_title: "นาย", cust_firstname: "สมชาย", cust_lastname: "ใจดี" })]);
    expect(result.bookingCandidates[0]!.guestName).toBe("นายสมชาย ใจดี");
  });

  test("cust_lastname blank falls back to cust_name2 (the real hotelnew/HF pattern)", () => {
    const result = map([row({ cust_title: "นาย", cust_firstname: "ธนัช", cust_lastname: "", cust_name2: "พลอาจ" })]);
    expect(result.bookingCandidates[0]!.guestName).toBe("นายธนัช พลอาจ");
  });

  test("cust_lastname wins over cust_name2 when both present (the real hotelville pattern)", () => {
    const result = map([
      row({ cust_title: "นาย", cust_firstname: "ชูเดช", cust_lastname: "แย้มสุคนธ์", cust_name2: "แย้มสุคนธ์" }),
    ]);
    expect(result.bookingCandidates[0]!.guestName).toBe("นายชูเดช แย้มสุคนธ์");
  });

  test("English title glues directly onto first name too", () => {
    const result = map([row({ cust_title: "Mr.", cust_firstname: "TAN YEOW CHONG", cust_lastname: null, cust_name2: null })]);
    expect(result.bookingCandidates[0]!.guestName).toBe("Mr.TAN YEOW CHONG");
  });

  test("prefix present but every name field blank -> prefix alone, not null", () => {
    const result = map([row({ cust_title: "นาย", cust_firstname: "", cust_lastname: null, cust_name2: null })]);
    expect(result.bookingCandidates[0]!.guestName).toBe("นาย");
  });
});

describe("roomCount/roomNo/nights derive from ค่าห้อง lines only", () => {
  test("roomCount counts distinct room labels across ค่าห้อง lines (repeats not double-counted)", () => {
    const lines: RawLedgerRow[] = [
      row({ ledger_legacy_id: 50, ledger_pay_no: "R2604-0500", ledger_ds_name: "ค่าห้อง", ledger_ds_label: "101", ledger_ds_num: "2" }),
      row({ ledger_legacy_id: 51, ledger_pay_no: "R2604-0500", ledger_ds_name: "ค่าห้อง", ledger_ds_label: "102", ledger_ds_num: "2" }),
      row({ ledger_legacy_id: 52, ledger_pay_no: "R2604-0500", ledger_ds_name: "ค่าห้อง", ledger_ds_label: "101", ledger_ds_num: "2" }),
    ];
    const c = map(lines).bookingCandidates[0]!;
    expect(c.roomCount).toBe(2);
    expect(c.roomNo).toBe("101");
    expect(c.nights).toBe(2);
  });

  test("roomCount/roomNo/nights are null when the payment has no ค่าห้อง line", () => {
    const c = map([row({ ledger_ds_name: "ค่าปรับ", ledger_ds_label: "x", ledger_ds_num: "5" })]).bookingCandidates[0]!;
    expect(c.roomCount).toBeNull();
    expect(c.roomNo).toBeNull();
    expect(c.nights).toBeNull();
  });
});

describe("amount parsing", () => {
  test("comma-formatted amount strings ('1,234.50') parse to the correct satang", () => {
    const c = map([row({ ledger_amount: "1,234.50" })]).bookingCandidates[0]!;
    expect(c.grossRoomSatang).toBe(123_450);
  });

  test("null/empty amount cells are null-safe (treated as 0)", () => {
    expect(map([row({ ledger_amount: null })]).bookingCandidates[0]!.grossRoomSatang).toBe(0);
    expect(map([row({ ledger_amount: "" })]).bookingCandidates[0]!.grossRoomSatang).toBe(0);
  });
});

describe("deterministic ordering", () => {
  test("booking candidates are sorted by payment key", () => {
    const keys = map([
      row({ ledger_legacy_id: 2, ledger_pay_no: "R2604-0002" }),
      row({ ledger_legacy_id: 1, ledger_pay_no: "R2604-0001" }),
      row({ ledger_legacy_id: 3, ledger_pay_no: "" }),
    ]).bookingCandidates.map((c) => c.pmsRef);
    expect(keys).toEqual(["R2604-0001", "R2604-0002", "lid:3"]);
  });

  test("deposit candidates are sorted by payment key too", () => {
    const keys = map([
      row({ ledger_legacy_id: 12, ledger_pay_no: "R2604-0012", ledger_ds_name: "จ่ายล่วงหน้า", ledger_cash: "100.00" }),
      row({ ledger_legacy_id: 11, ledger_pay_no: "R2604-0011", ledger_ds_name: "จ่ายล่วงหน้า", ledger_cash: "100.00" }),
    ]).depositCandidates.map((c) => c.pmsRef);
    expect(keys).toEqual(["R2604-0011", "R2604-0012"]);
  });
});

describe("fetchDayPayments", () => {
  test("consults the _internal test override before anything else", async () => {
    delete process.env.PMS_DB_URL_HF; // deliberately NOT configured
    const fake: MapLedgerRowsResult = { bookingCandidates: [], depositCandidates: [], anomalies: [] };
    _internal.setFetchDayPaymentsForTests(async () => fake);
    const result = await fetchDayPayments("hf", "2026-06-01");
    expect(result).toBe(fake);
  });

  test("throws plainly when the property is not configured and no override is set", async () => {
    delete process.env.PMS_DB_URL_HF;
    await expect(fetchDayPayments("hf", "2026-06-01")).rejects.toThrow();
  });
});
