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
const { _internal: dayAuditInternal } = await import("../server/day-audit.ts");
const { buildSlipQueue, needsSlipProof } = await import("./queue.ts");
const { createAttachment } = await import("./storage.ts");

function checkinRow(overrides: Partial<DayAuditCheckinRow> = {}): DayAuditCheckinRow {
  return {
    kind: "checkin",
    auditKey: "CH000001",
    chRef: "CH000001",
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

  test("a PMS query failure rejects — the route (not this function) turns that into a 502", async () => {
    dayAuditInternal.setFetchDayAuditForTests(async () => {
      throw new Error("connection refused");
    });
    await expect(buildSlipQueue("hf", "2026-08-03")).rejects.toThrow("connection refused");
  });
});
