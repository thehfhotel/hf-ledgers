// See storage.test.ts's own comment: env vars must be set BEFORE db.ts
// (imported transitively via queue.ts -> storage.ts) opens the database —
// a plain top-level `import` would be hoisted ahead of these assignments,
// so every module touching db.ts is loaded via a dynamic import below.
process.env.SLIPS_DB_PATH = ":memory:";
process.env.SLIPS_DATA_DIR = `/tmp/slips-queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
process.env.NODE_ENV = "development";
process.env.DEV_USER = "tester@thehfhotel.org";

import { afterEach, describe, expect, test } from "bun:test";
import type { DayAuditCheckinRow, DayAuditDepositRow, DayAuditRefundRow, DayAuditRow } from "../server/day-audit.ts";
import type { RawDepositLedgerRow } from "../server/deposit-register.ts";
import { PROPERTIES } from "../shared/types.ts";
const { _internal: dayAuditInternal, buildDayAuditRows } = await import("../server/day-audit.ts");
const { buildSlipQueue, needsSlipProof } = await import("./queue.ts");
const { createAttachment, supersede } = await import("./storage.ts");
const { markCash, unmarkCash } = await import("./cash-marks.ts");

function checkinRow(overrides: Partial<DayAuditCheckinRow> = {}): DayAuditCheckinRow {
  return {
    kind: "checkin",
    auditKey: "CH000001",
    chRef: "CH000001",
    paidAtIso: "2026-08-03T08:00:00.000Z",
    guestName: "สมชาย ใจดี",
    receiptPayNos: ["R2608-0001"],
    grossSatang: 100_000,
    composition: { cashSatang: 100_000, transferSatang: 0, creditSatang: 0, webSatang: 0, penaltySatang: 0 },
    depositApplied: null,
    ...overrides,
  };
}

function depositRow(overrides: Partial<DayAuditDepositRow> = {}): DayAuditDepositRow {
  return {
    kind: "deposit",
    auditKey: "R2608-0100",
    rRef: "R090001",
    paidAtIso: "2026-08-03T09:00:00.000Z",
    guestName: "สมหญิง มีทรัพย์",
    payNo: "R2608-0100",
    tender: "cash",
    amountSatang: 50_000,
    checkinDateBangkok: null,
    ...overrides,
  };
}

function refundRow(overrides: Partial<DayAuditRefundRow> = {}): DayAuditRefundRow {
  return {
    kind: "refund",
    auditKey: "R2607-0480",
    refundOf: "deposit",
    ref: "R015834",
    paidAtIso: "2026-08-03T10:00:00.000Z",
    guestName: null,
    payNo: "R2607-0480",
    tender: "transfer",
    amountSatang: -39_500,
    overRefundedWarning: false,
    ...overrides,
  };
}

describe("needsSlipProof", () => {
  test("checkin row: true iff composition.transferSatang is nonzero", () => {
    expect(needsSlipProof(checkinRow({ composition: { cashSatang: 0, transferSatang: 1000, creditSatang: 0, webSatang: 0, penaltySatang: 0 } }))).toBe(true);
    expect(needsSlipProof(checkinRow({ composition: { cashSatang: 1000, transferSatang: 0, creditSatang: 0, webSatang: 0, penaltySatang: 0 } }))).toBe(false);
  });
  test("deposit/refund rows: true iff tender is transfer", () => {
    expect(needsSlipProof(depositRow({ tender: "transfer" }))).toBe(true);
    expect(needsSlipProof(depositRow({ tender: "cash" }))).toBe(false);
    expect(needsSlipProof(depositRow({ tender: null }))).toBe(false);
    expect(needsSlipProof(refundRow({ tender: "transfer" }))).toBe(true);
    expect(needsSlipProof(refundRow({ tender: "credit" }))).toBe(false);
  });
});

describe("buildSlipQueue", () => {
  afterEach(() => {
    dayAuditInternal.setFetchDayAuditForTests(null);
  });

  test("cash-only rows never enter the queue", async () => {
    const rows: DayAuditRow[] = [checkinRow(), depositRow({ tender: "cash" })];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue).toEqual([]);
  });

  test("transfer-tendered rows enter the queue with a zero attachment state by default", async () => {
    const rows: DayAuditRow[] = [
      checkinRow({ auditKey: "CH000002", chRef: "CH000002", composition: { cashSatang: 0, transferSatang: 100_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 } }),
      refundRow({ auditKey: "R2607-0999", tender: "transfer" }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue.map((r) => r.auditKey).sort()).toEqual(["CH000002", "R2607-0999"]);
    for (const row of queue) {
      expect(row.attachment).toEqual({ count: 0, latestAt: null, latestVersion: null, superseded: 0 });
    }
  });

  test("queue rows carry the transfer amount separately from the settlement total", async () => {
    const rows: DayAuditRow[] = [
      checkinRow({
        auditKey: "CH000003",
        chRef: "CH000003",
        grossSatang: 150_000,
        composition: { cashSatang: 50_000, transferSatang: 100_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 },
      }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue[0]!.amountSatang).toBe(150_000);
    expect(queue[0]!.transferSatang).toBe(100_000);
  });

  test("reflects a real attachment's count/latestAt from storage", async () => {
    await createAttachment({
      property: "hf",
      auditKey: "CH000004",
      auditDate: "2026-08-03",
      by: "reception@thehfhotel.org",
      buffer: new Uint8Array([1, 2]),
      thumbBuffer: new Uint8Array([3]),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    const rows: DayAuditRow[] = [
      checkinRow({ auditKey: "CH000004", chRef: "CH000004", composition: { cashSatang: 0, transferSatang: 50_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 } }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue[0]!.attachment.count).toBe(1);
    expect(queue[0]!.attachment.latestAt).not.toBeNull();
  });

  test("currentAttachments carries one entry per CURRENT picture (the จัดการสลิป gallery's own thumbnail strip), matching attachment.count", async () => {
    const v1 = await createAttachment({
      property: "hf",
      auditKey: "CH000005",
      auditDate: "2026-08-03",
      by: "a@x.com",
      buffer: new Uint8Array([1]),
      thumbBuffer: new Uint8Array([2]),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    await createAttachment({
      property: "hf",
      auditKey: "CH000005",
      auditDate: "2026-08-03",
      by: "b@x.com",
      buffer: new Uint8Array([3]),
      thumbBuffer: new Uint8Array([4]),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    supersede("hf", "CH000005", v1.version, "m@x.com"); // v1 taken out — only v2 stays current

    const rows: DayAuditRow[] = [
      checkinRow({ auditKey: "CH000005", chRef: "CH000005", composition: { cashSatang: 0, transferSatang: 50_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 } }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue[0]!.currentAttachments.map((a) => a.version)).toEqual([2]);
    expect(queue[0]!.currentAttachments).toHaveLength(queue[0]!.attachment.count);
  });

  test("currentAttachments is [] for a pending (never-attached) row", async () => {
    const rows: DayAuditRow[] = [
      checkinRow({ auditKey: "CH000006", chRef: "CH000006", composition: { cashSatang: 0, transferSatang: 50_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 } }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue[0]!.currentAttachments).toEqual([]);
  });

  test("cashMark is null for a row that was never marked paid-in-cash", async () => {
    const rows: DayAuditRow[] = [
      checkinRow({ auditKey: "CH000007", chRef: "CH000007", composition: { cashSatang: 0, transferSatang: 50_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 } }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue[0]!.cashMark).toBeNull();
  });

  test("cashMark reflects a real mark event — ยืนยันชำระเงินสด surfaces on the queue row", async () => {
    markCash("hf", "CH000008", "2026-08-03", "reception@thehfhotel.org");
    const rows: DayAuditRow[] = [
      checkinRow({ auditKey: "CH000008", chRef: "CH000008", composition: { cashSatang: 0, transferSatang: 50_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 } }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue[0]!.cashMark).toEqual({ at: expect.any(String), by: "reception@thehfhotel.org" });
  });

  test("cashMark reverts to null once unmarked — the queue row is live, not a frozen snapshot", async () => {
    markCash("hf", "CH000009", "2026-08-03", "reception@thehfhotel.org");
    unmarkCash("hf", "CH000009", "2026-08-03", "manager@thehfhotel.org");
    const rows: DayAuditRow[] = [
      checkinRow({ auditKey: "CH000009", chRef: "CH000009", composition: { cashSatang: 0, transferSatang: 50_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 } }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue[0]!.cashMark).toBeNull();
  });

  test("a PMS query failure rejects — the route (not this function) turns that into a 502", async () => {
    dayAuditInternal.setFetchDayAuditForTests(async () => {
      throw new Error("connection refused");
    });
    await expect(buildSlipQueue("hf", "2026-08-03")).rejects.toThrow("connection refused");
  });

  test("preserves paidAtIso newest-first, matching buildDayAuditRows exactly — the two queue builders never disagree on order", async () => {
    // Three transfer-tendered รับมัดจำ receipts (all needsSlipProof: true),
    // fed in SCRAMBLED (non-chronological) raw order — buildDayAuditRows'
    // own sortDayAuditRows call is what puts them right, never anything in
    // this module.
    function rawRow(overrides: Partial<RawDepositLedgerRow>): RawDepositLedgerRow {
      return {
        ledger_legacy_id: 1,
        ledger_pay_no: "R2608-0900",
        ledger_cin_no: "R090100",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_pay_date: "2026-08-03T04:00:00.000Z",
        ledger_status: null,
        ledger_cash: "0",
        ledger_credit: "0",
        ledger_tran: "500.00",
        ledger_web: "0",
        ledger_amount: "500.00",
        ledger_free: "0",
        ledger_note: null,
        cust_title: null,
        cust_firstname: null,
        cust_lastname: null,
        cust_name2: null,
        ...overrides,
      };
    }
    const raw: RawDepositLedgerRow[] = [
      rawRow({ ledger_legacy_id: 1, ledger_pay_no: "R2608-0910", ledger_cin_no: "R090110", ledger_pay_date: "2026-08-03T02:00:00.000Z" }), // earliest
      rawRow({ ledger_legacy_id: 2, ledger_pay_no: "R2608-0911", ledger_cin_no: "R090111", ledger_pay_date: "2026-08-03T08:00:00.000Z" }), // latest
      rawRow({ ledger_legacy_id: 3, ledger_pay_no: "R2608-0912", ledger_cin_no: "R090112", ledger_pay_date: "2026-08-03T05:00:00.000Z" }), // middle
    ];

    const auditRows = buildDayAuditRows(raw, new Map(), new Map());
    const expectedOrder = auditRows.filter(needsSlipProof).map((r) => r.auditKey);
    expect(expectedOrder).toEqual(["R2608-0911", "R2608-0912", "R2608-0910"]); // newest-first, sanity check

    dayAuditInternal.setFetchDayAuditForTests(async () => auditRows);
    const queue = await buildSlipQueue("hf", "2026-08-03");
    expect(queue.map((r) => r.auditKey)).toEqual(expectedOrder);
    expect(queue.map((r) => r.paidAtIso)).toEqual(auditRows.filter(needsSlipProof).map((r) => r.paidAtIso));
  });

  // ── HF Ville parity (live 2026-08-06 survey) ─────────────────────────────
  // Every test above hardcodes "hf" — buildSlipQueue's own math
  // (needsSlipProof, refs, amount split) has no property branching, but
  // storage.ts's attachment lookups (summarize/listCurrentBatch) DO filter
  // by property in every query, and that plumbing had never been proven
  // against hfville at all. Table-driven across PROPERTIES below, plus a
  // dedicated cross-property isolation test — the storage-scoping analog of
  // the exact class of bug ("every fixture was HF-shaped, so a property-
  // specific path went untested") this task exists to close.

  test("cash-only rows never enter the queue — table-driven across hf and hfville", async () => {
    for (const property of PROPERTIES) {
      const rows: DayAuditRow[] = [
        checkinRow({ auditKey: `CASH-${property}`, chRef: `CASH-${property}` }),
        depositRow({ auditKey: `DEP-${property}`, tender: "cash" }),
      ];
      dayAuditInternal.setFetchDayAuditForTests(async () => rows);
      const queue = await buildSlipQueue(property, "2026-08-03");
      expect(queue).toEqual([]);
    }
  });

  test("transfer-tendered rows enter the queue on both properties — hfville's real tender profile (tran-dominant, credit near-absent) never blocks this", async () => {
    for (const property of PROPERTIES) {
      const rows: DayAuditRow[] = [
        checkinRow({
          auditKey: `TXN-${property}`,
          chRef: `TXN-${property}`,
          composition: { cashSatang: 0, transferSatang: 100_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 },
        }),
        refundRow({ auditKey: `REF-${property}`, tender: "transfer" }),
      ];
      dayAuditInternal.setFetchDayAuditForTests(async () => rows);
      const queue = await buildSlipQueue(property, "2026-08-03");
      expect(queue.map((r) => r.auditKey).sort()).toEqual([`REF-${property}`, `TXN-${property}`]);
    }
  });

  test("attachment state is scoped per property — an hfville attachment never leaks into hf's queue for the same auditKey, and vice versa", async () => {
    const sharedAuditKey = "CH_SHARED_001"; // deliberately the SAME auditKey on both properties' (independent) PMS
    await createAttachment({
      property: "hfville",
      auditKey: sharedAuditKey,
      auditDate: "2026-08-03",
      by: "hfville-reception@thehfhotel.org",
      buffer: new Uint8Array([9]),
      thumbBuffer: new Uint8Array([9]),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });

    const rows: DayAuditRow[] = [
      checkinRow({
        auditKey: sharedAuditKey,
        chRef: sharedAuditKey,
        composition: { cashSatang: 0, transferSatang: 50_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 },
      }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);

    const hfQueue = await buildSlipQueue("hf", "2026-08-03");
    expect(hfQueue[0]!.attachment.count).toBe(0); // hf's own attachment table has nothing at this key
    expect(hfQueue[0]!.currentAttachments).toEqual([]);

    const hfvilleQueue = await buildSlipQueue("hfville", "2026-08-03");
    expect(hfvilleQueue[0]!.attachment.count).toBe(1);
    expect(hfvilleQueue[0]!.currentAttachments).toHaveLength(1);
  });

  test("preserves paidAtIso newest-first on hfville-shaped raw rows too — buildSlipQueue and buildDayAuditRows never disagree on order regardless of property", async () => {
    function hfvilleRawRow(overrides: Partial<RawDepositLedgerRow>): RawDepositLedgerRow {
      return {
        ledger_legacy_id: 1,
        ledger_pay_no: "R2510-0900",
        ledger_cin_no: "R002900",
        ledger_ds_name: "จ่ายล่วงหน้า",
        ledger_pay_date: "2026-08-03T04:00:00.000Z",
        ledger_status: null,
        ledger_cash: "0",
        ledger_credit: "0",
        ledger_tran: "500.00", // hfville's dominant tender — never credit
        ledger_web: "0",
        ledger_amount: "500.00",
        ledger_free: "0",
        ledger_note: null,
        cust_title: "", // hfville's own "no title" sentinel
        cust_firstname: null,
        cust_lastname: null,
        cust_name2: null,
        ...overrides,
      };
    }
    const raw: RawDepositLedgerRow[] = [
      hfvilleRawRow({ ledger_legacy_id: 1, ledger_pay_no: "R2510-0910", ledger_cin_no: "R002910", ledger_pay_date: "2026-08-03T02:00:00.000Z" }), // earliest
      hfvilleRawRow({ ledger_legacy_id: 2, ledger_pay_no: "R2510-0911", ledger_cin_no: "R002911", ledger_pay_date: "2026-08-03T08:00:00.000Z" }), // latest
      hfvilleRawRow({ ledger_legacy_id: 3, ledger_pay_no: "R2510-0912", ledger_cin_no: "R002912", ledger_pay_date: "2026-08-03T05:00:00.000Z" }), // middle
    ];

    const auditRows = buildDayAuditRows(raw, new Map(), new Map());
    const expectedOrder = auditRows.filter(needsSlipProof).map((r) => r.auditKey);
    expect(expectedOrder).toEqual(["R2510-0911", "R2510-0912", "R2510-0910"]); // newest-first, sanity check

    dayAuditInternal.setFetchDayAuditForTests(async () => auditRows);
    const queue = await buildSlipQueue("hfville", "2026-08-03");
    expect(queue.map((r) => r.auditKey)).toEqual(expectedOrder);
    expect(queue.map((r) => r.paidAtIso)).toEqual(auditRows.filter(needsSlipProof).map((r) => r.paidAtIso));
  });
});
