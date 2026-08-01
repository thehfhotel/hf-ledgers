// Pure-layer tests for deposit-register.ts (Wave D, the office deposit
// register): classification of raw ht_payment_ledger rows, R-number
// threading, monthly reconciliation, and the two exception buckets. No
// network — `fetchDepositRegister` is exercised only through its
// `_internal` test override (see server.test.ts's endpoint-level tests for
// that), never a real PMS connection.
//
// Real Thai ds_name labels throughout (never an invented vocabulary — same
// discipline pms-prefill.test.ts enforces for the day-scoped importer).
// The proven live case (docs/adr/0001, plan Wave C's "C-risks"): booking
// R015834 received 395.00 (39_500 satang) and its application row moved
// 790.00 (79_000 satang) into ledger_free — this exact case must land in
// `mismatched` with `diffSatang: 39_500`.

import { describe, expect, test } from "bun:test";
import {
  DEPOSIT_R_NUMBER_RE,
  buildDepositExceptions,
  buildDepositRegisterData,
  buildDepositThreads,
  buildMonthlyReconciliation,
  classifyDepositRow,
  collectVoidedEvents,
  deriveDepositThreadStatus,
  type DepositLedgerEvent,
  type DepositThread,
  type RawDepositLedgerRow,
} from "./deposit-register.ts";

/** Default row: a single-line จ่ายล่วงหน้า (received) payment, cash tender,
 * everything else zeroed. */
function row(overrides: Partial<RawDepositLedgerRow>): RawDepositLedgerRow {
  return {
    ledger_legacy_id: 1,
    ledger_pay_no: "R2608-0001",
    ledger_cin_no: "R014843",
    ledger_ds_name: "จ่ายล่วงหน้า",
    ledger_pay_date: "2026-08-15T08:00:00.000Z", // Bangkok 15:00, same calendar day
    ledger_status: null,
    ledger_cash: "890.00",
    ledger_credit: "0",
    ledger_tran: "0",
    ledger_web: "0",
    ledger_amount: "890.00",
    ledger_free: "0",
    ledger_note: null,
    ...overrides,
  };
}

function event(overrides: Partial<DepositLedgerEvent>): DepositLedgerEvent {
  return {
    legacyId: 1,
    pmsRef: "R2608-0001",
    kind: "received",
    rNumber: "R014843",
    dateBangkok: "2026-08-15",
    amountSatang: 89_000,
    voided: false,
    tender: "cash",
    chRef: null,
    ...overrides,
  };
}

describe("DEPOSIT_R_NUMBER_RE", () => {
  test("matches the fixed R + 6 digits shape", () => {
    expect(DEPOSIT_R_NUMBER_RE.test("R014843")).toBe(true);
    expect(DEPOSIT_R_NUMBER_RE.test("R015834")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(DEPOSIT_R_NUMBER_RE.test("CH26-005269")).toBe(false);
    expect(DEPOSIT_R_NUMBER_RE.test("R14843")).toBe(false);
    expect(DEPOSIT_R_NUMBER_RE.test("r014843")).toBe(false);
    expect(DEPOSIT_R_NUMBER_RE.test("")).toBe(false);
  });
});

describe("classifyDepositRow", () => {
  test("จ่ายล่วงหน้า (received): R-number from ledger_cin_no, amount summed from tender columns", () => {
    const classified = classifyDepositRow(row({ ledger_cin_no: "R014843", ledger_cash: "890.00" }));
    expect(classified).not.toBeNull();
    expect(classified!.event).toEqual({
      legacyId: 1,
      pmsRef: "R2608-0001",
      kind: "received",
      rNumber: "R014843",
      dateBangkok: "2026-08-15",
      amountSatang: 89_000,
      voided: false,
      tender: "cash",
      chRef: null,
    });
    expect(classified!.unparsedAppliedBookingNo).toBe(false);
    expect(classified!.zeroTenderRow).toBe(false);
  });

  test("คืนเงินจองห้อง (refunded): amount is the abs of the summed tender columns (C0's negated-column finding)", () => {
    const classified = classifyDepositRow(
      row({
        ledger_ds_name: "คืนเงินจองห้อง",
        ledger_cin_no: "R014843",
        ledger_cash: "0",
        ledger_tran: "-395.00",
        ledger_amount: "-395.00",
        ledger_free: "0",
      }),
    );
    expect(classified!.event.kind).toBe("refunded");
    expect(classified!.event.amountSatang).toBe(39_500);
    expect(classified!.event.rNumber).toBe("R014843");
    expect(classified!.event.tender).toBe("transfer");
    expect(classified!.event.chRef).toBeNull();
    expect(classified!.zeroTenderRow).toBe(false);
  });

  test("tender is identified per the non-zero raw column: credit and web columns each resolve to their own DepositTender", () => {
    const viaCredit = classifyDepositRow(row({ ledger_cash: "0", ledger_credit: "500.00", ledger_amount: "500.00" }))!;
    expect(viaCredit.event.tender).toBe("credit");
    const viaWeb = classifyDepositRow(row({ ledger_cash: "0", ledger_web: "500.00", ledger_amount: "500.00" }))!;
    expect(viaWeb.event.tender).toBe("web");
  });

  // Review fix, tripwire gap (a): a received/refunded row whose tender
  // columns are ALL zero despite a nonzero ledger_amount — money exists on
  // the folio that this classifier isn't capturing into amountSatang.
  // ledger_amount is selected "for future tripwires" (DEPOSIT_LEDGER_QUERY's
  // doc comment) — this is that future.
  test("received row with all four tender columns zero but nonzero ledger_amount: amountSatang 0, flagged zeroTenderRow", () => {
    const classified = classifyDepositRow(
      row({
        ledger_cash: "0",
        ledger_credit: "0",
        ledger_tran: "0",
        ledger_web: "0",
        ledger_amount: "890.00",
      }),
    );
    expect(classified!.event.amountSatang).toBe(0);
    expect(classified!.zeroTenderRow).toBe(true);
    expect(classified!.event.tender).toBeNull();
  });

  test("received row with all tender columns AND ledger_amount zero: NOT flagged (genuinely a zero-money row)", () => {
    const classified = classifyDepositRow(
      row({ ledger_cash: "0", ledger_credit: "0", ledger_tran: "0", ledger_web: "0", ledger_amount: "0" }),
    );
    expect(classified!.event.amountSatang).toBe(0);
    expect(classified!.zeroTenderRow).toBe(false);
  });

  // Review fix, tripwire gap (b): a received/refunded row with a blank
  // ledger_cin_no — rNumber is null, but this is NOT the applied-only
  // unparsedAppliedBookingNo tripwire (a different, dedicated counter,
  // blankBookingNoRows, is derived by the caller directly from
  // event.kind/event.rNumber — see buildDepositRegisterData).
  test("received row with a blank ledger_cin_no: rNumber null, unparsedAppliedBookingNo stays false (that flag is applied-only)", () => {
    const classified = classifyDepositRow(row({ ledger_cin_no: "" }));
    expect(classified!.event.rNumber).toBeNull();
    expect(classified!.unparsedAppliedBookingNo).toBe(false);
  });

  test("ตัดยอดล่วงหน้า Booking No:R014843 (applied): amount from ledger_free, R-number from the label suffix", () => {
    const classified = classifyDepositRow(
      row({
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014843",
        ledger_cin_no: "CH26-005269", // CH-number here — must NOT be read as the R-number
        ledger_cash: "0",
        ledger_amount: "890.00", // must NOT be read — only ledger_free counts (V1)
        ledger_free: "890.00",
      }),
    );
    expect(classified!.event.kind).toBe("applied");
    expect(classified!.event.rNumber).toBe("R014843");
    expect(classified!.event.amountSatang).toBe(89_000);
    expect(classified!.unparsedAppliedBookingNo).toBe(false);
    // zeroTenderRow is scoped to received/refunded only — an applied row's
    // money lives in ledger_free, never the tender columns, so this is
    // always false there regardless of what the tender columns hold.
    expect(classified!.zeroTenderRow).toBe(false);
    // No bank tender moves on an applied line (it's an accounting offset);
    // its OWN ledger_cin_no (the CH-number) is carried as chRef — distinct
    // from, and never confused with, the R-number parsed from the label.
    expect(classified!.event.tender).toBeNull();
    expect(classified!.event.chRef).toBe("CH26-005269");
  });

  test("applied label with a trailing space (C0-observed) still parses", () => {
    const classified = classifyDepositRow(
      row({ ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R014843 ", ledger_free: "890.00" }),
    );
    expect(classified!.event.rNumber).toBe("R014843");
    expect(classified!.unparsedAppliedBookingNo).toBe(false);
  });

  test("applied label whose suffix doesn't match R\\d{6}: rNumber null, flagged as a tripwire, event still returned", () => {
    const classified = classifyDepositRow(
      row({ ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:ABC123", ledger_free: "500.00" }),
    );
    expect(classified!.event.kind).toBe("applied");
    expect(classified!.event.rNumber).toBeNull();
    expect(classified!.event.amountSatang).toBe(50_000);
    expect(classified!.unparsedAppliedBookingNo).toBe(true);
  });

  test("voided row (ledger_status = 'ยกเลิก'): tagged voided, still fully classified", () => {
    const classified = classifyDepositRow(row({ ledger_status: "ยกเลิก", ledger_cash: "500.00" }));
    expect(classified!.event.voided).toBe(true);
    expect(classified!.event.amountSatang).toBe(50_000);
  });

  test("a row matching none of the three known ds_names: null (defensive; SQL WHERE already restricts to these)", () => {
    expect(classifyDepositRow(row({ ledger_ds_name: "ค่าห้อง" }))).toBeNull();
  });

  test("ledger_pay_date normalizes to the Bangkok calendar date regardless of UTC vs Date instance", () => {
    const viaString = classifyDepositRow(row({ ledger_pay_date: "2026-08-15T20:00:00.000Z" }))!; // Bangkok: Aug 16, 03:00
    expect(viaString.event.dateBangkok).toBe("2026-08-16");
    const viaDate = classifyDepositRow(row({ ledger_pay_date: new Date("2026-08-15T08:00:00.000Z") }))!;
    expect(viaDate.event.dateBangkok).toBe("2026-08-15");
  });
});

describe("buildDepositThreads", () => {
  test("groups by R-number; sums exclude voided; outstanding = received - applied - refunded", () => {
    const events: DepositLedgerEvent[] = [
      event({ rNumber: "R014843", kind: "received", amountSatang: 89_000, dateBangkok: "2026-08-01" }),
      event({ rNumber: "R014843", kind: "applied", amountSatang: 89_000, dateBangkok: "2026-08-10" }),
      // Voided received event on the SAME R-number: present in `events`, excluded from every sum.
      event({ rNumber: "R014843", kind: "received", amountSatang: 10_000, dateBangkok: "2026-07-20", voided: true }),
    ];
    const threads = buildDepositThreads(events);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.rNumber).toBe("R014843");
    expect(thread.receivedSatang).toBe(89_000); // voided 10_000 excluded
    expect(thread.appliedSatang).toBe(89_000);
    expect(thread.refundedSatang).toBe(0);
    expect(thread.outstandingSatang).toBe(0);
    expect(thread.events).toHaveLength(3); // all three present for display
    // firstEventDate is the earliest ACTIVE event's date — the voided
    // 07-20 event (earlier than both active ones) must NOT anchor this.
    expect(thread.firstEventDate).toBe("2026-08-01");
    // Owner ask (2026-08-01): fully applied, nothing outstanding -> ตัดยอดแล้ว.
    expect(thread.status).toBe("applied");
  });

  test("the proven R015834 case: received 39_500, applied 79_000 -> outstanding is NEGATIVE (never appears in aging)", () => {
    const events: DepositLedgerEvent[] = [
      event({ rNumber: "R015834", kind: "received", amountSatang: 39_500 }),
      event({ rNumber: "R015834", kind: "applied", amountSatang: 79_000 }),
    ];
    const [thread] = buildDepositThreads(events);
    expect(thread!.receivedSatang).toBe(39_500);
    expect(thread!.appliedSatang).toBe(79_000);
    expect(thread!.outstandingSatang).toBe(-39_500);
    // Over-applied still reads as "applied" (ตัดยอดแล้ว) — the mismatch
    // itself is a SEPARATE, complementary signal via buildDepositExceptions.
    expect(thread!.status).toBe("applied");
  });

  test("events with rNumber null (unparseable applied label) are excluded from every thread", () => {
    const events: DepositLedgerEvent[] = [
      event({ rNumber: "R014843" }),
      event({ rNumber: null, kind: "applied", amountSatang: 5_000 }),
    ];
    const threads = buildDepositThreads(events);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.rNumber).toBe("R014843");
  });

  test("multiple R-numbers sort by rNumber", () => {
    const events: DepositLedgerEvent[] = [event({ rNumber: "R015834" }), event({ rNumber: "R014843" })];
    const threads = buildDepositThreads(events);
    expect(threads.map((t) => t.rNumber)).toEqual(["R014843", "R015834"]);
  });
});

// Owner ask (2026-08-01): the register must make a deposit's STATE
// unambiguous. These are the canonical Thai labels' derivation rules —
// see DepositThreadStatus's doc comment (shared/types.ts) for the full
// definitions.
describe("deriveDepositThreadStatus", () => {
  test("received only, nothing applied/refunded -> waitingCheckin (รอเช็คอิน)", () => {
    expect(
      deriveDepositThreadStatus({ receivedSatang: 89_000, appliedSatang: 0, refundedSatang: 0, outstandingSatang: 89_000 }),
    ).toBe("waitingCheckin");
  });

  test("still holding a balance but partially applied -> partial (บางส่วน)", () => {
    expect(
      deriveDepositThreadStatus({ receivedSatang: 100_000, appliedSatang: 40_000, refundedSatang: 0, outstandingSatang: 60_000 }),
    ).toBe("partial");
  });

  test("still holding a balance but partially refunded -> partial (บางส่วน)", () => {
    expect(
      deriveDepositThreadStatus({ receivedSatang: 100_000, appliedSatang: 0, refundedSatang: 40_000, outstandingSatang: 60_000 }),
    ).toBe("partial");
  });

  test("fully applied, outstanding zero -> applied (ตัดยอดแล้ว)", () => {
    expect(
      deriveDepositThreadStatus({ receivedSatang: 89_000, appliedSatang: 89_000, refundedSatang: 0, outstandingSatang: 0 }),
    ).toBe("applied");
  });

  test("over-applied (the R015834 mismatch shape), outstanding negative -> still applied (ตัดยอดแล้ว)", () => {
    expect(
      deriveDepositThreadStatus({ receivedSatang: 39_500, appliedSatang: 79_000, refundedSatang: 0, outstandingSatang: -39_500 }),
    ).toBe("applied");
  });

  test("orphanApplied shape (received 0, applied > 0) -> applied (ตัดยอดแล้ว)", () => {
    expect(
      deriveDepositThreadStatus({ receivedSatang: 0, appliedSatang: 50_000, refundedSatang: 0, outstandingSatang: -50_000 }),
    ).toBe("applied");
  });

  test("fully refunded, nothing applied -> refunded (คืนเงินแล้ว)", () => {
    expect(
      deriveDepositThreadStatus({ receivedSatang: 39_500, appliedSatang: 0, refundedSatang: 39_500, outstandingSatang: 0 }),
    ).toBe("refunded");
  });

  test("mixed applied + refunded close-out -> applied wins (a stay is the more informative outcome)", () => {
    expect(
      deriveDepositThreadStatus({ receivedSatang: 100_000, appliedSatang: 60_000, refundedSatang: 40_000, outstandingSatang: 0 }),
    ).toBe("applied");
  });
});

describe("buildMonthlyReconciliation", () => {
  test("first month opens at 0; every later opening = prior closing", () => {
    const events: DepositLedgerEvent[] = [
      event({ rNumber: "R014843", kind: "received", amountSatang: 100_000, dateBangkok: "2026-08-05" }),
      event({ rNumber: "R014843", kind: "applied", amountSatang: 60_000, dateBangkok: "2026-09-01" }),
      event({ rNumber: "R014843", kind: "refunded", amountSatang: 10_000, dateBangkok: "2026-09-10" }),
    ];
    const monthly = buildMonthlyReconciliation(events);
    expect(monthly).toEqual([
      { month: "2026-08", openingSatang: 0, receivedSatang: 100_000, appliedSatang: 0, refundedSatang: 0, closingSatang: 100_000 },
      { month: "2026-09", openingSatang: 100_000, receivedSatang: 0, appliedSatang: 60_000, refundedSatang: 10_000, closingSatang: 30_000 },
    ]);
  });

  test("returned chronological (ascending) — newest-first is the client's job", () => {
    const events: DepositLedgerEvent[] = [
      event({ dateBangkok: "2026-06-01", amountSatang: 1000 }),
      event({ dateBangkok: "2026-08-01", amountSatang: 2000 }),
      event({ dateBangkok: "2026-07-01", amountSatang: 3000 }),
    ];
    const months = buildMonthlyReconciliation(events).map((m) => m.month);
    expect(months).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  test("voided events excluded from every monthly sum but the month still exists if OTHER active events touch it", () => {
    const events: DepositLedgerEvent[] = [
      event({ dateBangkok: "2026-08-05", amountSatang: 50_000 }),
      event({ dateBangkok: "2026-08-05", amountSatang: 999_999, voided: true }),
    ];
    const monthly = buildMonthlyReconciliation(events);
    expect(monthly).toEqual([
      { month: "2026-08", openingSatang: 0, receivedSatang: 50_000, appliedSatang: 0, refundedSatang: 0, closingSatang: 50_000 },
    ]);
  });

  test("a month with ONLY voided events never appears at all", () => {
    const events: DepositLedgerEvent[] = [event({ dateBangkok: "2026-08-05", amountSatang: 50_000, voided: true })];
    expect(buildMonthlyReconciliation(events)).toEqual([]);
  });
});

describe("buildDepositExceptions", () => {
  test("the proven R015834 case lands in mismatched with diffSatang 39_500", () => {
    const threads: DepositThread[] = [
      {
        rNumber: "R015834",
        receivedSatang: 39_500,
        appliedSatang: 79_000,
        refundedSatang: 0,
        outstandingSatang: -39_500,
        firstEventDate: "2026-07-31",
        events: [],
        status: "applied",
      },
    ];
    const { mismatched, orphanApplied } = buildDepositExceptions(threads);
    expect(mismatched).toEqual([{ rNumber: "R015834", receivedSatang: 39_500, appliedSatang: 79_000, diffSatang: 39_500 }]);
    expect(orphanApplied).toEqual([]);
  });

  test("orphanApplied: applied > 0 with zero receipt", () => {
    const threads: DepositThread[] = [
      {
        rNumber: "R020000",
        receivedSatang: 0,
        appliedSatang: 50_000,
        refundedSatang: 0,
        outstandingSatang: -50_000,
        firstEventDate: null,
        events: [],
        status: "applied",
      },
    ];
    const { mismatched, orphanApplied } = buildDepositExceptions(threads);
    expect(mismatched).toEqual([]);
    expect(orphanApplied).toEqual([{ rNumber: "R020000", appliedSatang: 50_000 }]);
  });

  test("received-only (not yet applied) is neither exception", () => {
    const threads: DepositThread[] = [
      {
        rNumber: "R030000",
        receivedSatang: 89_000,
        appliedSatang: 0,
        refundedSatang: 0,
        outstandingSatang: 89_000,
        firstEventDate: "2026-08-01",
        events: [],
        status: "waitingCheckin",
      },
    ];
    const { mismatched, orphanApplied } = buildDepositExceptions(threads);
    expect(mismatched).toEqual([]);
    expect(orphanApplied).toEqual([]);
  });

  test("received === applied within tolerance is neither exception", () => {
    const threads: DepositThread[] = [
      {
        rNumber: "R040000",
        receivedSatang: 89_000,
        appliedSatang: 89_050, // 50 satang under RECONCILE_TOLERANCE_SATANG (100)
        refundedSatang: 0,
        outstandingSatang: -50,
        firstEventDate: "2026-08-01",
        events: [],
        status: "applied",
      },
    ];
    const { mismatched } = buildDepositExceptions(threads);
    expect(mismatched).toEqual([]);
  });
});

describe("collectVoidedEvents (review fix: walks events, not threads)", () => {
  test("flattens every voided event out of a plain event list, with rNumber attached", () => {
    const events: DepositLedgerEvent[] = [
      event({ rNumber: "R014843", kind: "received", amountSatang: 89_000, voided: false }),
      event({ rNumber: "R014843", kind: "received", amountSatang: 5_000, voided: true, dateBangkok: "2026-07-20" }),
    ];
    expect(collectVoidedEvents(events)).toEqual([
      { rNumber: "R014843", kind: "received", amountSatang: 5_000, dateBangkok: "2026-07-20" },
    ]);
  });

  test("no voided events anywhere: empty array", () => {
    expect(collectVoidedEvents([event({ voided: false })])).toEqual([]);
  });

  // The exact gap the review flagged: the old implementation walked
  // DepositThread[], so a voided event with rNumber: null (unparseable
  // applied label, or a blank ledger_cin_no) never appeared anywhere —
  // buildDepositThreads never groups a null-rNumber event into ANY thread,
  // so it was invisible to a threads-based walk. Walking events directly
  // fixes this: the footnote is complete regardless of whether an event
  // could be threaded.
  test("a voided event with rNumber: null (never threaded) still appears — the footnote must be complete", () => {
    const events: DepositLedgerEvent[] = [
      event({ rNumber: null, kind: "applied", amountSatang: 12_000, voided: true, dateBangkok: "2026-06-01" }),
      event({ rNumber: "R014843", voided: false }),
    ];
    expect(collectVoidedEvents(events)).toEqual([
      { rNumber: null, kind: "applied", amountSatang: 12_000, dateBangkok: "2026-06-01" },
    ]);
  });
});

describe("buildDepositRegisterData (row-level, end to end)", () => {
  test("the R015834 case built straight from raw rows: threads, monthly, and unparsedAppliedRows all agree", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_legacy_id: 1,
        ledger_pay_no: "R2607-9001",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cin_no: "R015834",
        ledger_pay_date: "2026-07-25T08:00:00.000Z",
        ledger_cash: "395.00",
        ledger_amount: "395.00",
      }),
      row({
        ledger_legacy_id: 2,
        ledger_pay_no: "R2608-9002",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R015834",
        ledger_cin_no: "CH26-009000",
        ledger_pay_date: "2026-08-01T08:00:00.000Z",
        ledger_cash: "0",
        ledger_amount: "790.00",
        ledger_free: "790.00",
      }),
      // An unparseable applied row elsewhere — must be counted as a
      // tripwire, never dropped, never crash the pipeline.
      row({
        ledger_legacy_id: 3,
        ledger_pay_no: "R2608-9003",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:BADREF",
        ledger_cin_no: "CH26-009999",
        ledger_pay_date: "2026-08-02T08:00:00.000Z",
        ledger_free: "1000.00",
      }),
    ];

    const data = buildDepositRegisterData(rows);
    expect(data.unparsedAppliedRows).toBe(1);
    // None of the three new tripwire gaps apply to this fixture — every row
    // has real tender money, a real R-number (or is applied), and a
    // parseable date.
    expect(data.zeroTenderRows).toBe(0);
    expect(data.blankBookingNoRows).toBe(0);
    expect(data.undatedRows).toBe(0);
    expect(data.voided).toEqual([]);

    const thread = data.threads.find((t) => t.rNumber === "R015834")!;
    expect(thread.receivedSatang).toBe(39_500);
    expect(thread.appliedSatang).toBe(79_000);
    expect(thread.outstandingSatang).toBe(-39_500);

    expect(data.monthly).toEqual([
      { month: "2026-07", openingSatang: 0, receivedSatang: 39_500, appliedSatang: 0, refundedSatang: 0, closingSatang: 39_500 },
      { month: "2026-08", openingSatang: 39_500, receivedSatang: 0, appliedSatang: 79_000 + 100_000, refundedSatang: 0, closingSatang: 39_500 - 79_000 - 100_000 },
    ]);
  });

  // Owner ask (2026-08-01, register mapability): `events` is the full flat
  // classified list, exposed without recomputation — the received event
  // carries its tender (`cash`, the one non-zero raw column) and `chRef:
  // null` (its cin_no is already `rNumber`); the applied event carries
  // `tender: null` (no bank movement) and `chRef` from its OWN
  // `ledger_cin_no` (the CH/check-in number, distinct from the R-number
  // parsed out of its ds_name label).
  test("events: the full flat list, including tender for received and CH ref for applied", () => {
    const rows: RawDepositLedgerRow[] = [
      row({
        ledger_legacy_id: 1,
        ledger_pay_no: "R2607-9001",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cin_no: "R015834",
        ledger_pay_date: "2026-07-25T08:00:00.000Z",
        ledger_cash: "395.00",
        ledger_amount: "395.00",
      }),
      row({
        ledger_legacy_id: 2,
        ledger_pay_no: "R2608-9002",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:R015834",
        ledger_cin_no: "CH26-009000",
        ledger_pay_date: "2026-08-01T08:00:00.000Z",
        ledger_cash: "0",
        ledger_amount: "790.00",
        ledger_free: "790.00",
      }),
    ];
    const data = buildDepositRegisterData(rows);
    expect(data.events).toEqual([
      {
        legacyId: 1,
        pmsRef: "R2607-9001",
        kind: "received",
        rNumber: "R015834",
        dateBangkok: "2026-07-25",
        amountSatang: 39_500,
        voided: false,
        tender: "cash",
        chRef: null,
      },
      {
        legacyId: 2,
        pmsRef: "R2608-9002",
        kind: "applied",
        rNumber: "R015834",
        dateBangkok: "2026-08-01",
        amountSatang: 79_000,
        voided: false,
        tender: null,
        chRef: "CH26-009000",
      },
    ]);
  });

  // Review fix: three synthetic rows, one per tripwire gap, none of which
  // may silently vanish. Also confirms `voided` is now computed INSIDE
  // buildDepositRegisterData (walking events, not threads) rather than
  // requiring the caller to re-derive it.
  test("the three tripwire counters (review fix): zeroTenderRows, blankBookingNoRows, undatedRows", () => {
    const rows: RawDepositLedgerRow[] = [
      // (a) all four tender columns zero, but ledger_amount is real money.
      row({
        ledger_legacy_id: 10,
        ledger_pay_no: "R2609-1010",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cin_no: "R050001",
        ledger_cash: "0",
        ledger_credit: "0",
        ledger_tran: "0",
        ledger_web: "0",
        ledger_amount: "500.00",
      }),
      // (b) a received row with a blank ledger_cin_no.
      row({
        ledger_legacy_id: 11,
        ledger_pay_no: "R2609-1011",
        ledger_ds_name: "คืนเงินจองห้อง",
        ledger_cin_no: "",
        ledger_tran: "-200.00",
        ledger_amount: "-200.00",
        ledger_cash: "0",
      }),
      // (c) an unparseable payment date.
      row({
        ledger_legacy_id: 12,
        ledger_pay_no: "R2609-1012",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_cin_no: "R050002",
        ledger_pay_date: "not-a-date",
        ledger_cash: "300.00",
        ledger_amount: "300.00",
      }),
      // A voided row with an unparseable applied label, to prove `voided`
      // (computed inside buildDepositRegisterData) includes it even though
      // it can never join a thread.
      row({
        ledger_legacy_id: 13,
        ledger_pay_no: "R2609-1013",
        ledger_ds_name: "ตัดยอดล่วงหน้า Booking No:BADREF2",
        ledger_cin_no: "CH26-999999",
        ledger_status: "ยกเลิก",
        ledger_free: "700.00",
        ledger_cash: "0",
        ledger_amount: "0",
      }),
    ];

    const data = buildDepositRegisterData(rows);
    expect(data.zeroTenderRows).toBe(1);
    expect(data.blankBookingNoRows).toBe(1);
    expect(data.undatedRows).toBe(1);
    // R050001 (zero-tender) has a valid date but its amountSatang is 0
    // (that IS the tripwire — its real 500.00 never reached amountSatang),
    // and R050002's real 300.00 (undated) is EXCLUDED from monthly
    // entirely — so the received total across every month is 0 despite two
    // rows carrying real money on the raw ledger.
    expect(data.monthly.reduce((sum, m) => sum + m.receivedSatang, 0)).toBe(0);
    expect(data.monthly.reduce((sum, m) => sum + m.refundedSatang, 0)).toBe(20_000); // the blank-cin_no refund still counts
    // The blank-cin_no row's thread never exists (nothing to group it by).
    expect(data.threads.find((t) => t.receivedSatang === 0 && t.refundedSatang === 20_000)).toBeUndefined();
    // The voided applied row (unparseable label) still shows up in `voided`.
    expect(data.voided).toEqual(
      expect.arrayContaining([{ rNumber: null, kind: "applied", amountSatang: 70_000, dateBangkok: expect.any(String) }]),
    );
    // Owner ask (2026-08-01): that same voided applied row is ALSO present
    // in the flat `events` list, tagged `voided: true` (never dropped) and
    // carrying its own CH ref (row 13's ledger_cin_no).
    expect(data.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          legacyId: 13,
          kind: "applied",
          rNumber: null,
          voided: true,
          amountSatang: 70_000,
          tender: null,
          chRef: "CH26-999999",
        }),
      ]),
    );
  });

  test("empty input yields empty everything", () => {
    expect(buildDepositRegisterData([])).toEqual({
      threads: [],
      monthly: [],
      unparsedAppliedRows: 0,
      zeroTenderRows: 0,
      blankBookingNoRows: 0,
      undatedRows: 0,
      voided: [],
      events: [],
    });
  });
});
