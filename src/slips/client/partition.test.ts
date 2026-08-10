import { describe, expect, test } from "bun:test";
import type { SlipQueueRow } from "./api.ts";
import { matchesSearch, partitionSlipQueue } from "./partition.ts";

function row(overrides: Partial<SlipQueueRow> = {}): SlipQueueRow {
  return {
    auditKey: "CH000001",
    kind: "checkin",
    paidAtIso: "2026-08-03T08:00:00.000Z",
    guestName: "สมชาย ใจดี",
    refs: ["CH000001", "R2608-0001"],
    amountSatang: 100_000,
    transferSatang: 100_000,
    attachment: { count: 0, latestAt: null, latestVersion: null, superseded: 0 },
    currentAttachments: [],
    cashMark: null,
    ...overrides,
  };
}

describe("matchesSearch", () => {
  test("blank query matches everything", () => {
    expect(matchesSearch(row(), "")).toBe(true);
    expect(matchesSearch(row(), "   ")).toBe(true);
  });

  test("matches guestName case-insensitively", () => {
    expect(matchesSearch(row({ guestName: "Somchai Jaidee" }), "somchai")).toBe(true);
    expect(matchesSearch(row({ guestName: "Somchai Jaidee" }), "SOMCHAI")).toBe(true);
    expect(matchesSearch(row({ guestName: "Somchai Jaidee" }), "nobody")).toBe(false);
  });

  test("matches any ref, not just the first", () => {
    expect(matchesSearch(row({ refs: ["CH26-005269", "R2608-0010"] }), "R2608-0010")).toBe(true);
  });

  test("a null guestName never throws — just falls through to refs", () => {
    expect(matchesSearch(row({ guestName: null, refs: ["R090001"] }), "R090001")).toBe(true);
    expect(matchesSearch(row({ guestName: null, refs: ["R090001"] }), "nomatch")).toBe(false);
  });
});

describe("partitionSlipQueue", () => {
  test("splits by attachment.count: 0 -> pending, >0 -> attached", () => {
    const rows = [
      row({ auditKey: "A", attachment: { count: 0, latestAt: null, latestVersion: null, superseded: 0 } }),
      row({ auditKey: "B", attachment: { count: 1, latestAt: "2026-08-03T09:00:00.000Z", latestVersion: 1, superseded: 0 } }),
      row({ auditKey: "C", attachment: { count: 0, latestAt: null, latestVersion: null, superseded: 0 } }),
    ];
    const { pending, attached } = partitionSlipQueue(rows);
    expect(pending.map((r) => r.auditKey)).toEqual(["A", "C"]);
    expect(attached.map((r) => r.auditKey)).toEqual(["B"]);
  });

  test("preserves the input's relative (newest-first) order within each bucket", () => {
    // Rows arrive newest-paidAtIso-first from the server — the partition
    // must never re-sort or reverse either bucket.
    const rows = [
      row({ auditKey: "NEWEST", paidAtIso: "2026-08-03T10:00:00.000Z", attachment: { count: 1, latestAt: null, latestVersion: 1, superseded: 0 } }),
      row({ auditKey: "MID-PENDING", paidAtIso: "2026-08-03T09:00:00.000Z" }),
      row({ auditKey: "OLDEST", paidAtIso: "2026-08-03T08:00:00.000Z", attachment: { count: 2, latestAt: null, latestVersion: 2, superseded: 0 } }),
      row({ auditKey: "OLDEST-PENDING", paidAtIso: "2026-08-03T07:00:00.000Z" }),
    ];
    const { pending, attached } = partitionSlipQueue(rows);
    expect(pending.map((r) => r.auditKey)).toEqual(["MID-PENDING", "OLDEST-PENDING"]);
    expect(attached.map((r) => r.auditKey)).toEqual(["NEWEST", "OLDEST"]);
  });

  test("an empty list partitions into two empty lists", () => {
    expect(partitionSlipQueue([])).toEqual({ pending: [], attached: [] });
  });

  test("a cash-marked row with zero attachments lands in attached (จัดการสลิป), not pending", () => {
    const rows = [row({ auditKey: "CASH", cashMark: { at: "2026-08-10 10:00:00", by: "reception@thehfhotel.org" } })];
    const { pending, attached } = partitionSlipQueue(rows);
    expect(pending).toEqual([]);
    expect(attached.map((r) => r.auditKey)).toEqual(["CASH"]);
  });

  test("unmarking (cashMark back to null) returns the row to pending", () => {
    const rows = [row({ auditKey: "UNMARKED", cashMark: null })];
    const { pending, attached } = partitionSlipQueue(rows);
    expect(pending.map((r) => r.auditKey)).toEqual(["UNMARKED"]);
    expect(attached).toEqual([]);
  });

  test("a row with BOTH an attachment and a cash mark stays attached (either condition alone is enough)", () => {
    const rows = [
      row({
        auditKey: "BOTH",
        attachment: { count: 1, latestAt: "2026-08-03T09:00:00.000Z", latestVersion: 1, superseded: 0 },
        cashMark: { at: "2026-08-10 10:00:00", by: "reception@thehfhotel.org" },
      }),
    ];
    const { pending, attached } = partitionSlipQueue(rows);
    expect(pending).toEqual([]);
    expect(attached.map((r) => r.auditKey)).toEqual(["BOTH"]);
  });
});
