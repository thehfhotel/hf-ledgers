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
