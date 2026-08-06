// Pure-layer tests for day-audit.ts (Wave 1, the office audit hub —
// docs/plan-audit-hub-slips.md): the STAY-MERGE reshaping of a day's PMS
// payments into ONE ROW PER SETTLEMENT. No network — `fetchDayAudit` is
// exercised only through its `_internal` test override (see
// server.test.ts's endpoint-level tests for that), never a real PMS
// connection.
//
// Real Thai ds_name labels throughout, same discipline pms-prefill.test.ts/
// deposit-register.test.ts enforce. The "R014843 shape" (a check-in's
// ค่าห้อง payment and its ตัดยอดมัดจำ line merging into ONE เช็คอิน row, never
// two) is this module's whole reason for existing — see the first describe
// block below.

import { describe, expect, test } from "bun:test";
import type { DepositLedgerEvent, RawDepositLedgerRow } from "./deposit-register.ts";
import {
  buildDayAuditRows,
  sortDayAuditRows,
  type DayAuditCheckinRow,
  type DayAuditDepositRow,
  type DayAuditRefundRow,
  type DayAuditRow,
} from "./day-audit.ts";

/** Minimal DayAuditDepositRow literal for `sortDayAuditRows`'s own direct
 * (non-`buildDayAuditRows`) tests — only `paidAtIso`/`auditKey` ever vary in
 * those tests, everything else is a fixed placeholder. */
function minimalDepositRow(auditKey: string, paidAtIso: string | null): DayAuditDepositRow {
  return {
    kind: "deposit",
    auditKey,
    rRef: "R000000",
    paidAtIso,
    guestName: null,
    payNo: auditKey,
    tender: "cash",
    amountSatang: 1000,
    checkinDateBangkok: null,
  };
}

/** Default row: a single-line ค่าห้อง (room charge) payment, cash tender,
 * everything else zeroed — same "everything else zeroed" default
 * philosophy deposit-register.test.ts's own `row()` fixture uses.
 * `ledger_free`/`ledger_note` are present (unlike deposit-register.ts's OWN
 * `RawDepositLedgerRow` fixture default, which never needs them read) only
 * because `RawDepositLedgerRow`'s TYPE requires them — day-audit.ts reuses
 * that exact shape so it can hand rows straight to `classifyDepositRow()`. */
function row(overrides: Partial<RawDepositLedgerRow>): RawDepositLedgerRow {
  return {
    ledger_legacy_id: 1,
    ledger_pay_no: "R2608-0001",
    ledger_cin_no: "CH26-005269",
    ledger_ds_name: "ค่าห้อง",
    ledger_pay_date: "2026-08-15T08:00:00.000Z", // Bangkok 15:00, same calendar day
    ledger_status: null,
    ledger_cash: "890.00",
    ledger_credit: "0",
    ledger_tran: "0",
    ledger_web: "0",
    ledger_amount: "890.00",
    ledger_free: "0",
    ledger_note: null,
    cust_title: null,
    cust_firstname: null,
    cust_lastname: null,
    cust_name2: null,
    ...overrides,
  };
}

/** A cross-history received event, as `fetchReceivedLookup` would classify
 * one via `classifyDepositRow` — the pure builder's `receivedByRRef` input
 * shape. */
function receivedEvent(overrides: Partial<DepositLedgerEvent>): DepositLedgerEvent {
  return {
    legacyId: 1,
    pmsRef: "R2607-0005",
    kind: "received",
    rNumber: "R090001",
    dateBangkok: "2026-07-01",
    amountSatang: 39_500,
    voided: false,
    tender: "cash",
    chRef: null,
    guestName: null,
    ...overrides,
  };
}

function checkinRows(result: ReturnType<typeof buildDayAuditRows>): DayAuditCheckinRow[] {
  return result.filter((r): r is DayAuditCheckinRow => r.kind === "checkin");
}
function depositRows(result: ReturnType<typeof buildDayAuditRows>): DayAuditDepositRow[] {
  return result.filter((r): r is DayAuditDepositRow => r.kind === "deposit");
}
function refundRows(result: ReturnType<typeof buildDayAuditRows>): DayAuditRefundRow[] {
  return result.filter((r): r is DayAuditRefundRow => r.kind === "refund");
}

describe("buildDayAuditRows: the stay merge (เช็คอิน rows)", () => {
  test("ค่าห้อง + ตัดยอดมัดจำ sharing a CH merge into ONE เช็คอิน row, never two (the R014843 shape)", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_legacy_id: 1,
        ledger_pay_no: "R2608-0010",
        ledger_cin_no: "CH26-005269",
        ledger_ds_name: "ค่าห้อง",
        ledger_cash: "500.00",
        ledger_amount: "500.00",
      }),
      row({
        ledger_legacy_id: 2,
        ledger_pay_no: "R2608-0011",
        ledger_cin_no: "CH26-005269",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014843",
        ledger_cash: "0",
        ledger_amount: "290.00",
        ledger_free: "290.00",
      }),
    ];

    const result = buildDayAuditRows(rows, new Map(), new Map());
    const checkins = checkinRows(result);
    expect(checkins.length).toBe(1); // never two rows for the same stay
    expect(checkins[0]!.chRef).toBe("CH26-005269");
    expect(checkins[0]!.auditKey).toBe("CH26-005269");
    expect([...checkins[0]!.receiptPayNos].sort()).toEqual(["R2608-0010", "R2608-0011"]);
    // Gross excludes the ตัดยอด line's own amount entirely (V1 — that money
    // lives in depositApplied, never gross, the same double-booking-bug fix
    // pms-prefill.ts's grossRoomSatang makes).
    expect(checkins[0]!.grossSatang).toBe(50_000);
    expect(checkins[0]!.depositApplied).not.toBeNull();
    expect(checkins[0]!.depositApplied!.amountSatang).toBe(29_000);
    expect(checkins[0]!.depositApplied!.rRef).toBe("R014843");
  });

  test("tender columns are read ONCE per payment group, summed across groups sharing a CH — never per line", () => {
    const rows: RawDepositLedgerRow[] = [
      // Payment group 1: two ค่าห้อง lines (a multi-room booking) — the
      // SAME replicated tender value on both lines must be read once, not
      // doubled (pms-prefill.ts's "57% inflation" money gotcha).
      row({
        ledger_legacy_id: 1,
        ledger_pay_no: "R2608-0030",
        ledger_cin_no: "CH26-100001",
        ledger_ds_name: "ค่าห้อง",
        ledger_cash: "1000.00",
        ledger_amount: "600.00",
      }),
      row({
        ledger_legacy_id: 2,
        ledger_pay_no: "R2608-0030",
        ledger_cin_no: "CH26-100001",
        ledger_ds_name: "ค่าห้อง",
        ledger_cash: "1000.00",
        ledger_amount: "400.00",
      }),
      // Payment group 2: a SEPARATE receipt, same CH — a ค่าปรับ (penalty)
      // charged on a different pay_no for the same stay.
      row({
        ledger_legacy_id: 3,
        ledger_pay_no: "R2608-0031",
        ledger_cin_no: "CH26-100001",
        ledger_ds_name: "ค่าปรับ",
        ledger_cash: "0",
        ledger_tran: "50.00",
        ledger_amount: "50.00",
      }),
    ];

    const result = buildDayAuditRows(rows, new Map(), new Map());
    const checkins = checkinRows(result);
    expect(checkins.length).toBe(1);
    const c = checkins[0]!;
    expect([...c.receiptPayNos].sort()).toEqual(["R2608-0030", "R2608-0031"]);
    expect(c.grossSatang).toBe(105_000); // 600+400 room + 50 penalty
    expect(c.composition.cashSatang).toBe(100_000); // group 1's cash read ONCE (1000.00), not doubled
    expect(c.composition.transferSatang).toBe(5_000); // group 2's transfer
    expect(c.composition.penaltySatang).toBe(5_000);
  });

  test("ยกเลิกห้อง forces a negative correction onto gross regardless of the raw stored sign", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2608-0040",
        ledger_cin_no: "CH26-200001",
        ledger_ds_name: "ค่าห้อง",
        ledger_cash: "1000.00",
        ledger_amount: "1000.00",
      }),
      row({
        ledger_pay_no: "R2608-0041",
        ledger_cin_no: "CH26-200001",
        ledger_ds_name: "ยกเลิกห้อง",
        ledger_cash: "0",
        ledger_amount: "300.00", // stored POSITIVE — must still reduce gross
      }),
    ];

    const result = buildDayAuditRows(rows, new Map(), new Map());
    const c = checkinRows(result)[0]!;
    expect(c.grossSatang).toBe(70_000); // 1000.00 - 300.00
  });

  test("an applied line whose R-ref label fails to parse leaves depositApplied null rather than guessing", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2608-0050",
        ledger_cin_no: "CH26-300001",
        ledger_ds_name: "ค่าห้อง",
        ledger_cash: "500.00",
        ledger_amount: "500.00",
      }),
      row({
        ledger_pay_no: "R2608-0051",
        ledger_cin_no: "CH26-300001",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:garbage",
        ledger_cash: "0",
        ledger_amount: "100.00",
        ledger_free: "100.00",
      }),
    ];

    const result = buildDayAuditRows(rows, new Map(), new Map());
    const c = checkinRows(result)[0]!;
    expect(c.depositApplied).toBeNull();
  });

  test("a check-in with no ตัดยอด line at all carries depositApplied: null", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_pay_no: "R2608-0055", ledger_cin_no: "CH26-350001", ledger_ds_name: "ค่าห้อง" }),
    ];
    const c = checkinRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(c.depositApplied).toBeNull();
  });
});

describe("buildDayAuditRows: depositApplied pairing across history + mismatch flag", () => {
  test("pairs with the R's received event across ALL history (not just today), mismatch true when applied != received (the R015834 shape)", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2608-0021",
        ledger_cin_no: "CH26-009999",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R090001",
        ledger_cash: "0",
        ledger_amount: "790.00",
        ledger_free: "790.00",
      }),
    ];
    const receivedByRRef = new Map([
      ["R090001", [receivedEvent({ pmsRef: "R2607-0005", dateBangkok: "2026-07-01", amountSatang: 39_500, tender: "cash" })]],
    ]);

    const c = checkinRows(buildDayAuditRows(rows, receivedByRRef, new Map()))[0]!;
    expect(c.depositApplied!.receivedPayNo).toBe("R2607-0005");
    expect(c.depositApplied!.receivedDateBangkok).toBe("2026-07-01");
    expect(c.depositApplied!.receivedTender).toBe("cash");
    expect(c.depositApplied!.receivedAmountSatang).toBe(39_500);
    expect(c.depositApplied!.amountSatang).toBe(79_000);
    expect(c.depositApplied!.mismatch).toBe(true);
  });

  test("no mismatch when applied equals the received total", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2608-0022",
        ledger_cin_no: "CH26-010000",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R090002",
        ledger_cash: "0",
        ledger_amount: "395.00",
        ledger_free: "395.00",
      }),
    ];
    const receivedByRRef = new Map([["R090002", [receivedEvent({ rNumber: "R090002", amountSatang: 39_500 })]]]);

    const c = checkinRows(buildDayAuditRows(rows, receivedByRRef, new Map()))[0]!;
    expect(c.depositApplied!.mismatch).toBe(false);
  });

  test("multiple active received events for the same R sum into receivedAmountSatang; the first (chronological) is canonical", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2608-0070",
        ledger_cin_no: "CH26-500001",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R888888",
        ledger_cash: "0",
        ledger_amount: "500.00",
        ledger_free: "500.00",
      }),
    ];
    const receivedByRRef = new Map([
      [
        "R888888",
        [
          receivedEvent({ rNumber: "R888888", pmsRef: "R2607-0010", dateBangkok: "2026-07-01", amountSatang: 20_000, tender: "cash" }),
          receivedEvent({ rNumber: "R888888", pmsRef: "R2607-0020", dateBangkok: "2026-07-05", amountSatang: 30_000, tender: "transfer" }),
        ],
      ],
    ]);

    const c = checkinRows(buildDayAuditRows(rows, receivedByRRef, new Map()))[0]!;
    expect(c.depositApplied!.receivedAmountSatang).toBe(50_000);
    expect(c.depositApplied!.receivedPayNo).toBe("R2607-0010"); // first entry — lookup query orders by pay_date
    expect(c.depositApplied!.mismatch).toBe(false); // 500.00 applied == 500.00 received total
  });

  test("orphan-applied (no received event anywhere for the R) still flags mismatch, receivedAmountSatang null", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2608-0060",
        ledger_cin_no: "CH26-400001",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R777777",
        ledger_cash: "0",
        ledger_amount: "200.00",
        ledger_free: "200.00",
      }),
    ];

    const c = checkinRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(c.depositApplied!.receivedAmountSatang).toBeNull();
    expect(c.depositApplied!.receivedPayNo).toBeNull();
    expect(c.depositApplied!.mismatch).toBe(true);
  });

  test("only ACTIVE received events count toward receivedAmountSatang — a voided one is excluded from the sum", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2608-0080",
        ledger_cin_no: "CH26-600001",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R999999",
        ledger_cash: "0",
        ledger_amount: "500.00",
        ledger_free: "500.00",
      }),
    ];
    const receivedByRRef = new Map([["R999999", [receivedEvent({ rNumber: "R999999", amountSatang: 50_000, voided: true })]]]);

    const c = checkinRows(buildDayAuditRows(rows, receivedByRRef, new Map()))[0]!;
    expect(c.depositApplied!.receivedAmountSatang).toBeNull();
    expect(c.depositApplied!.mismatch).toBe(true);
  });
});

describe("buildDayAuditRows: รับมัดจำ rows (จ่ายล่วงหน้า)", () => {
  test("one row per received deposit, keyed by its own pay_no", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2608-0100",
        ledger_cin_no: "R090005",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cash: "500.00",
        ledger_amount: "500.00",
      }),
    ];
    const d = depositRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(d.auditKey).toBe("R2608-0100");
    expect(d.rRef).toBe("R090005");
    expect(d.payNo).toBe("R2608-0100");
    expect(d.tender).toBe("cash");
    expect(d.amountSatang).toBe(50_000);
    expect(d.checkinDateBangkok).toBeNull(); // no lookup entry -> omitted, not guessed
  });

  test("carries the best-effort forward check-in date when the lookup has it", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_pay_no: "R2608-0101", ledger_cin_no: "R090006", ledger_ds_name: "จ่ายล่วงหน้า" }),
    ];
    const checkinDateByRRef = new Map([["R090006", "2026-09-01"]]);
    const d = depositRows(buildDayAuditRows(rows, new Map(), checkinDateByRRef))[0]!;
    expect(d.checkinDateBangkok).toBe("2026-09-01");
  });
});

describe("buildDayAuditRows: คืนเงิน rows", () => {
  test("คืนเงินจองห้อง becomes a negative refund row keyed by its own R", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2607-0480",
        ledger_cin_no: "R015834",
        ledger_ds_name: "คืนเงินจองห้อง",
        ledger_tran: "395.00",
        ledger_cash: "0",
        ledger_amount: "395.00",
      }),
    ];
    const r = refundRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(r.refundOf).toBe("deposit");
    expect(r.ref).toBe("R015834");
    expect(r.amountSatang).toBe(-39_500);
    expect(r.tender).toBe("transfer");
    expect(r.overRefundedWarning).toBe(false); // no received-lookup entry at all in this fixture
  });

  test("overRefundedWarning true when the paired R has a received event but every one is voided (the R015832 shape)", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2607-0480",
        ledger_cin_no: "R015832",
        ledger_ds_name: "คืนเงินจองห้อง",
        ledger_tran: "395.00",
        ledger_cash: "0",
        ledger_amount: "395.00",
      }),
    ];
    const receivedByRRef = new Map([["R015832", [receivedEvent({ rNumber: "R015832", voided: true })]]]);
    const r = refundRows(buildDayAuditRows(rows, receivedByRRef, new Map()))[0]!;
    expect(r.overRefundedWarning).toBe(true);
  });

  test("overRefundedWarning false when an ACTIVE received event exists for the R", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_pay_no: "R2607-0481", ledger_cin_no: "R015900", ledger_ds_name: "คืนเงินจองห้อง", ledger_cash: "395.00", ledger_amount: "395.00" }),
    ];
    const receivedByRRef = new Map([["R015900", [receivedEvent({ rNumber: "R015900", voided: false })]]]);
    const r = refundRows(buildDayAuditRows(rows, receivedByRRef, new Map()))[0]!;
    expect(r.overRefundedWarning).toBe(false);
  });

  test("คืนเงินส่วนเกิน becomes its own refund row, negative amount, keyed by the CH ref — never merged into the เช็คอิน row", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_pay_no: "R2608-0099",
        ledger_cin_no: "CH26-005269",
        ledger_ds_name: "คืนเงินส่วนเกิน",
        ledger_cash: "100.00",
        ledger_amount: "100.00",
      }),
    ];
    const result = buildDayAuditRows(rows, new Map(), new Map());
    expect(result.length).toBe(1);
    const r = refundRows(result)[0]!;
    expect(r.refundOf).toBe("excess");
    expect(r.ref).toBe("CH26-005269");
    expect(r.amountSatang).toBe(-10_000);
    expect(r.tender).toBe("cash");
    // Never folded into a เช็คอิน row's gross/composition — no checkin row
    // exists at all here since no ค่าห้อง/ยกเลิกห้อง/ค่าปรับ/ตัดยอด line was fed in.
    expect(checkinRows(result).length).toBe(0);
  });
});

describe("buildDayAuditRows: voided rows excluded entirely", () => {
  test("a voided ค่าห้อง line never produces any row", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_ds_name: "ค่าห้อง", ledger_status: "ยกเลิก", ledger_cin_no: "CH26-000001" }),
    ];
    expect(buildDayAuditRows(rows, new Map(), new Map())).toEqual([]);
  });

  test("a voided จ่ายล่วงหน้า line never produces a รับมัดจำ row", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_ds_name: "จ่ายล่วงหน้า", ledger_status: "ยกเลิก", ledger_cin_no: "R010001" }),
    ];
    expect(buildDayAuditRows(rows, new Map(), new Map())).toEqual([]);
  });

  test("a voided คืนเงินจองห้อง line never produces a คืนเงิน row", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_ds_name: "คืนเงินจองห้อง", ledger_status: "ยกเลิก", ledger_cin_no: "R010002" }),
    ];
    expect(buildDayAuditRows(rows, new Map(), new Map())).toEqual([]);
  });

  test("one voided line among several active ones is dropped, the rest still merge normally", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_pay_no: "R2608-0200", ledger_cin_no: "CH26-700001", ledger_ds_name: "ค่าห้อง", ledger_amount: "500.00", ledger_cash: "500.00" }),
      row({
        ledger_pay_no: "R2608-0201",
        ledger_cin_no: "CH26-700001",
        ledger_ds_name: "ค่าปรับ",
        ledger_status: "ยกเลิก",
        ledger_amount: "50.00",
        ledger_tran: "50.00",
      }),
    ];
    const c = checkinRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(c.grossSatang).toBe(50_000); // the voided ค่าปรับ line never contributes
    expect(c.receiptPayNos).toEqual(["R2608-0200"]);
  });
});

describe("buildDayAuditRows: row ordering (owner ask 2026-08-04 — date+time DESC, unified across kinds)", () => {
  test("rows of every kind interleave strictly newest-first by paidAtIso, not grouped by kind", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_pay_no: "R2608-0300", ledger_cin_no: "CH26-800001", ledger_ds_name: "ค่าห้อง", ledger_pay_date: "2026-08-15T06:00:00.000Z" }), // 13:00 BKK
      row({ ledger_pay_no: "R2608-0310", ledger_cin_no: "R020001", ledger_ds_name: "จ่ายล่วงหน้า", ledger_pay_date: "2026-08-15T07:00:00.000Z" }), // 14:00 BKK
      row({ ledger_pay_no: "R2608-0320", ledger_cin_no: "R020003", ledger_ds_name: "คืนเงินจองห้อง", ledger_pay_date: "2026-08-15T05:00:00.000Z" }), // 12:00 BKK
      row({ ledger_pay_no: "R2608-0301", ledger_cin_no: "CH26-800002", ledger_ds_name: "ค่าห้อง", ledger_pay_date: "2026-08-15T08:00:00.000Z" }), // 15:00 BKK — latest
    ];
    const result = buildDayAuditRows(rows, new Map(), new Map());
    // Newest (15:00 checkin) -> 14:00 deposit -> 13:00 checkin -> 12:00 refund.
    // Kinds interleave — this is the explicit intent, not incidental.
    expect(result.map((r) => r.auditKey)).toEqual(["CH26-800002", "R2608-0310", "CH26-800001", "R2608-0320"]);
    expect(result.map((r) => r.kind)).toEqual(["checkin", "deposit", "checkin", "refund"]);
    // Every consecutive pair is strictly non-increasing in paidAtIso.
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.paidAtIso! <= result[i - 1]!.paidAtIso!).toBe(true);
    }
  });

  test("a merged เช็คอิน row's paidAtIso is the LATEST non-voided line's pay_date in its group, never the earliest or the room-charge line specifically", () => {
    const rows: RawDepositLedgerRow[] = [
      // ค่าห้อง posted first...
      row({
        ledger_legacy_id: 1,
        ledger_pay_no: "R2608-0400",
        ledger_cin_no: "CH26-900001",
        ledger_ds_name: "ค่าห้อง",
        ledger_pay_date: "2026-08-15T02:00:00.000Z",
      }),
      // ...its ตัดยอด line lands LATER, on a different receipt, same CH.
      row({
        ledger_legacy_id: 2,
        ledger_pay_no: "R2608-0401",
        ledger_cin_no: "CH26-900001",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R090099",
        ledger_cash: "0",
        ledger_amount: "100.00",
        ledger_free: "100.00",
        ledger_pay_date: "2026-08-15T09:30:00.000Z", // the LATEST line — this wins
      }),
      // ...and a ค่าปรับ line lands in between.
      row({
        ledger_legacy_id: 3,
        ledger_pay_no: "R2608-0402",
        ledger_cin_no: "CH26-900001",
        ledger_ds_name: "ค่าปรับ",
        ledger_cash: "0",
        ledger_tran: "50.00",
        ledger_amount: "50.00",
        ledger_pay_date: "2026-08-15T05:00:00.000Z",
      }),
    ];
    const c = checkinRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(c.paidAtIso).toBe("2026-08-15T09:30:00.000Z"); // the ตัดยอด line — latest, not first, not the room charge
  });

  test("a row with no parseable pay_date (paidAtIso null) always sorts LAST, after every dated row", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_pay_no: "R2608-0500", ledger_cin_no: "R020010", ledger_ds_name: "จ่ายล่วงหน้า", ledger_pay_date: "not-a-real-date" }),
      row({ ledger_pay_no: "R2608-0501", ledger_cin_no: "R020011", ledger_ds_name: "จ่ายล่วงหน้า", ledger_pay_date: "2026-08-15T03:00:00.000Z" }),
    ];
    const result = buildDayAuditRows(rows, new Map(), new Map());
    expect(result.map((r) => r.auditKey)).toEqual(["R2608-0501", "R2608-0500"]);
    expect(result[0]!.paidAtIso).not.toBeNull();
    expect(result[1]!.paidAtIso).toBeNull();
  });

  test("equal (including equally-null) paidAtIso breaks the tie deterministically by auditKey DESC", () => {
    const rows: RawDepositLedgerRow[] = [
      row({ ledger_pay_no: "R2608-0600", ledger_cin_no: "R020020", ledger_ds_name: "จ่ายล่วงหน้า", ledger_pay_date: "2026-08-15T04:00:00.000Z" }),
      row({ ledger_pay_no: "R2608-0601", ledger_cin_no: "R020021", ledger_ds_name: "จ่ายล่วงหน้า", ledger_pay_date: "2026-08-15T04:00:00.000Z" }),
      row({ ledger_pay_no: "R2608-0602", ledger_cin_no: "R020022", ledger_ds_name: "จ่ายล่วงหน้า", ledger_pay_date: "not-a-real-date" }),
      row({ ledger_pay_no: "R2608-0603", ledger_cin_no: "R020023", ledger_ds_name: "จ่ายล่วงหน้า", ledger_pay_date: "not-a-real-date" }),
    ];
    const result = buildDayAuditRows(rows, new Map(), new Map());
    // Same-timestamp pair: higher auditKey (payNo, here) first.
    expect(result.slice(0, 2).map((r) => r.auditKey)).toEqual(["R2608-0601", "R2608-0600"]);
    // Both-null pair (still last overall): same DESC tiebreak among themselves.
    expect(result.slice(2, 4).map((r) => r.auditKey)).toEqual(["R2608-0603", "R2608-0602"]);

    // Re-running against a shuffled input yields the identical order —
    // proves the tiebreak is deterministic, not incidentally stable on
    // insertion order.
    const shuffled = [rows[3]!, rows[1]!, rows[2]!, rows[0]!];
    const result2 = buildDayAuditRows(shuffled, new Map(), new Map());
    expect(result2.map((r) => r.auditKey)).toEqual(result.map((r) => r.auditKey));
  });
});

describe("sortDayAuditRows (direct, no PMS shaping)", () => {
  test("sorts by paidAtIso DESC, independent of input order", () => {
    const rows: DayAuditRow[] = [
      minimalDepositRow("A", "2026-08-15T05:00:00.000Z"),
      minimalDepositRow("B", "2026-08-15T08:00:00.000Z"),
      minimalDepositRow("C", "2026-08-15T02:00:00.000Z"),
    ];
    expect(sortDayAuditRows(rows).map((r) => r.auditKey)).toEqual(["B", "A", "C"]);
  });

  test("never mutates its input array", () => {
    const rows: DayAuditRow[] = [minimalDepositRow("A", "2026-08-15T05:00:00.000Z"), minimalDepositRow("B", "2026-08-15T08:00:00.000Z")];
    const original = [...rows];
    sortDayAuditRows(rows);
    expect(rows).toEqual(original);
  });

  test("null paidAtIso rows always sort after every non-null row, regardless of how many", () => {
    const rows: DayAuditRow[] = [
      minimalDepositRow("Z-null-1", null),
      minimalDepositRow("A", "2026-08-15T05:00:00.000Z"),
      minimalDepositRow("Y-null-2", null),
    ];
    expect(sortDayAuditRows(rows).map((r) => r.auditKey)).toEqual(["A", "Z-null-1", "Y-null-2"]);
  });
});

// ── HF Ville parity (live 2026-08-06 survey) ───────────────────────────────
// RawDepositLedgerRow never carries ledger_ds_id or ledger_cust_no (both are
// either SQL-layer-only or resolved before the row reaches this module — see
// deposit-register.test.ts's own "HF Ville parity" header comment for the
// full reasoning), so what genuinely varies here is: which raw tender column
// normally carries the money (hfville: ledger_tran 64%, ledger_credit only
// 0.4%), which ht_customers column carries the surname + which sentinel means
// "no title" (hfville: cust_lastname direct + empty-string title), and which
// ds_name shapes are REALLY live on hfville vs merely possible (ค่าปรับ has
// ZERO live hf rows but 11 real, active hfville ones). CH-number format
// itself was NOT found to diverge by property in the survey (both properties
// share the "R{YYMM}-{NNNN}" pay_no / bare "R######" book_no dual shape,
// finding #15) — these fixtures reuse the same CH shape with distinct
// literals, not a claimed format difference.

/** HF Ville–shaped default row — same base as `row()`, redefaulted to
 * hfville's own real conventions (transfer-dominant tender, credit
 * near-absent; empty-string title sentinel; a real observed hfville
 * ledger_pay_no). See deposit-register.test.ts's own `hfvilleRow()` doc
 * comment for the shared rationale — this is that module's day-audit-side
 * twin. */
function hfvilleRow(overrides: Partial<RawDepositLedgerRow>): RawDepositLedgerRow {
  return row({
    ledger_pay_no: "R2510-0079",
    ledger_cin_no: "CH25-000100",
    ledger_cash: "0",
    ledger_tran: "890.00",
    ledger_amount: "890.00",
    cust_title: "",
    ...overrides,
  });
}

describe("HF Ville parity — stay merge and composition", () => {
  test("ค่าห้อง + ตัดยอดมัดจำ sharing a CH merge into one เช็คอิน row (hfville-shaped: transfer tender, direct-lastname guest)", () => {
    const rows: RawDepositLedgerRow[] = [
      hfvilleRow({
        ledger_legacy_id: 1,
        ledger_pay_no: "R2510-0079",
        ledger_cin_no: "CH25-000100",
        ledger_ds_name: "ค่าห้อง",
        cust_firstname: "สมศรี",
        cust_lastname: "แซ่ตั้ง",
      }),
      hfvilleRow({
        ledger_legacy_id: 2,
        ledger_pay_no: "R2510-0080",
        ledger_cin_no: "CH25-000100",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R001511",
        ledger_cash: "0",
        ledger_tran: "0",
        ledger_amount: "300.00",
        ledger_free: "300.00",
      }),
    ];
    const c = checkinRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(c.chRef).toBe("CH25-000100");
    expect(c.guestName).toBe("สมศรี แซ่ตั้ง"); // hfville's own name-field shape — surname in cust_lastname directly
    expect(c.grossSatang).toBe(89_000); // ค่าห้อง only, ตัดยอด excluded from gross (V1, same rule both properties)
    expect(c.composition.transferSatang).toBe(89_000); // hfville's dominant tender
    expect(c.composition.creditSatang).toBe(0);
    expect(c.depositApplied).not.toBeNull();
    expect(c.depositApplied!.amountSatang).toBe(30_000);
    expect(c.depositApplied!.rRef).toBe("R001511");
  });

  // hfville has REAL, active ค่าปรับ activity in the live survey (11 rows,
  // e.g. pay_no R2510-0079, ledger_tran 150.00) — hf has ZERO ค่าปรับ rows
  // in the entire live sample. This fixture is a REAL-shaped hfville row,
  // not a synthetic one.
  test("ค่าปรับ (penalty) on a separate hfville receipt folds into the same stay's gross/penaltySatang (real hfville shape, ledger_tran 150.00, pay_no R2510-0079)", () => {
    const rows: RawDepositLedgerRow[] = [
      hfvilleRow({ ledger_pay_no: "R2510-0200", ledger_cin_no: "CH25-000200", ledger_ds_name: "ค่าห้อง", ledger_tran: "1000.00", ledger_amount: "1000.00" }),
      hfvilleRow({ ledger_pay_no: "R2510-0079", ledger_cin_no: "CH25-000200", ledger_ds_name: "ค่าปรับ", ledger_cash: "0", ledger_tran: "150.00", ledger_amount: "150.00" }),
    ];
    const c = checkinRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(c.grossSatang).toBe(115_000); // 1000 room + 150 penalty
    expect(c.composition.penaltySatang).toBe(15_000);
  });

  test("depositApplied pairs with the R's received event across all history, hfville-shaped (mismatch true on the applied>received case)", () => {
    const rows: RawDepositLedgerRow[] = [
      hfvilleRow({
        ledger_pay_no: "R2510-0300",
        ledger_cin_no: "CH25-000300",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R001700",
        ledger_cash: "0",
        ledger_tran: "0",
        ledger_amount: "600.00",
        ledger_free: "600.00",
      }),
    ];
    const receivedByRRef = new Map([
      ["R001700", [receivedEvent({ rNumber: "R001700", pmsRef: "R2506-0050", dateBangkok: "2026-06-01", amountSatang: 30_000, tender: "transfer" })]],
    ]);
    const c = checkinRows(buildDayAuditRows(rows, receivedByRRef, new Map()))[0]!;
    expect(c.depositApplied!.receivedPayNo).toBe("R2506-0050");
    expect(c.depositApplied!.receivedTender).toBe("transfer");
    expect(c.depositApplied!.receivedAmountSatang).toBe(30_000);
    expect(c.depositApplied!.amountSatang).toBe(60_000);
    expect(c.depositApplied!.mismatch).toBe(true);
  });
});

describe("HF Ville parity — รับมัดจำ / คืนเงิน rows", () => {
  test("รับมัดจำ row: hfville-shaped, transfer tender, keyed by its own pay_no", () => {
    const rows: RawDepositLedgerRow[] = [
      hfvilleRow({ ledger_pay_no: "R2510-0400", ledger_cin_no: "R001800", ledger_ds_name: "จ่ายล่วงหน้า" }),
    ];
    const d = depositRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(d.auditKey).toBe("R2510-0400");
    expect(d.rRef).toBe("R001800");
    expect(d.tender).toBe("transfer");
    expect(d.amountSatang).toBe(89_000);
  });

  test("คืนเงินจองห้อง row: hfville-shaped, negative refund keyed by its own R, overRefundedWarning parity with hf's own logic", () => {
    const rows: RawDepositLedgerRow[] = [
      hfvilleRow({ ledger_pay_no: "R2510-0410", ledger_cin_no: "R001900", ledger_ds_name: "คืนเงินจองห้อง" }),
    ];
    const receivedByRRef = new Map([["R001900", [receivedEvent({ rNumber: "R001900", voided: true })]]]);
    const r = refundRows(buildDayAuditRows(rows, receivedByRRef, new Map()))[0]!;
    expect(r.ref).toBe("R001900");
    expect(r.amountSatang).toBe(-89_000);
    expect(r.tender).toBe("transfer");
    expect(r.overRefundedWarning).toBe(true); // every received event for this R is voided — the R015832 shape
  });
});

describe("HF Ville parity — ordering and the tender-replication trap", () => {
  test("newest-first ordering (owner ask 2026-08-04) holds for hfville-shaped rows too — no accidental hf-only assumption", () => {
    const rows: RawDepositLedgerRow[] = [
      hfvilleRow({ ledger_pay_no: "R2510-0500", ledger_cin_no: "CH25-000500", ledger_ds_name: "ค่าห้อง", ledger_pay_date: "2026-08-15T06:00:00.000Z" }), // 13:00 BKK
      hfvilleRow({ ledger_pay_no: "R2510-0510", ledger_cin_no: "R002000", ledger_ds_name: "จ่ายล่วงหน้า", ledger_pay_date: "2026-08-15T08:00:00.000Z" }), // 15:00 BKK — latest
      hfvilleRow({ ledger_pay_no: "R2510-0520", ledger_cin_no: "R002001", ledger_ds_name: "คืนเงินจองห้อง", ledger_pay_date: "2026-08-15T05:00:00.000Z" }), // 12:00 BKK
    ];
    const result = buildDayAuditRows(rows, new Map(), new Map());
    expect(result.map((r) => r.auditKey)).toEqual(["R2510-0510", "CH25-000500", "R2510-0520"]);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.paidAtIso! <= result[i - 1]!.paidAtIso!).toBe(true);
    }
  });

  // Finding: multi-line payment groups are NOT hf-exclusive — both
  // properties sit at ~86% single-line / ~14% multi-line at nearly
  // identical rates. A fixture giving hfville only single-line groups would
  // reproduce the exact "HF-shaped fixture" bug pattern one level down.
  test("tender-replication trap holds for hfville too: transfer read ONCE per payment group, never summed per line", () => {
    const rows: RawDepositLedgerRow[] = [
      hfvilleRow({ ledger_legacy_id: 1, ledger_pay_no: "R2510-0600", ledger_cin_no: "CH25-000600", ledger_ds_name: "ค่าห้อง", ledger_tran: "700.00", ledger_amount: "400.00" }),
      hfvilleRow({ ledger_legacy_id: 2, ledger_pay_no: "R2510-0600", ledger_cin_no: "CH25-000600", ledger_ds_name: "ค่าห้อง", ledger_tran: "700.00", ledger_amount: "300.00" }),
    ];
    const c = checkinRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(c.grossSatang).toBe(70_000); // 400 + 300, itemized
    expect(c.composition.transferSatang).toBe(70_000); // the SAME 700.00 read once, never doubled to 140_000
  });

  // SYNTHETIC (flagged per the brief's own fixture advice #5): the live
  // 2026-08-06 survey found ZERO multi-line deposit-lifecycle groups on
  // hfville (all 9 live examples are single-line) — hf DOES have a real
  // 5-line ตัดยอด group (pay_key R2203-0438) that replicates its tender
  // column identically across every line. This fixture mirrors that
  // REPLICATION shape on hfville data, on the reasonable assumption
  // iHOTEL's replication behaviour is code-driven, not property-driven — it
  // is NOT sampled from a real hfville row.
  test("SYNTHETIC: a multi-line hfville ตัดยอด group reads its replicated tender ONCE; the applied amount adopted is the FIRST line's ledger_free (day-audit.ts's own documented single-line-read rule)", () => {
    const rows: RawDepositLedgerRow[] = [1, 2, 3, 4, 5].map((n) =>
      hfvilleRow({
        ledger_legacy_id: n,
        ledger_pay_no: "R2510-0700",
        ledger_cin_no: "CH25-000700",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R002200",
        ledger_cash: "0",
        ledger_tran: "650.00", // replicated identically across all 5 lines
        ledger_free: n === 1 ? "650.00" : "0.00",
        ledger_amount: "130.00", // itemized per line (5 x 130 = 650)
      }),
    );
    const c = checkinRows(buildDayAuditRows(rows, new Map(), new Map()))[0]!;
    expect(c.composition.transferSatang).toBe(65_000); // read once from the first line, never re-summed to 325_000
    expect(c.depositApplied!.amountSatang).toBe(65_000);
    expect(c.depositApplied!.rRef).toBe("R002200");
  });
});
