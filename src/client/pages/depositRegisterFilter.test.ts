import { describe, expect, test } from "bun:test";
import type { DepositThreadStatus } from "../../shared/types.ts";
import {
  DEPOSIT_FILTER_BUCKET_BY_STATUS,
  depositExceptionBucketForResolved,
  depositFilterBucketForStatus,
  matchesDepositExceptionFilter,
  matchesDepositFilter,
} from "./depositRegisterFilter.ts";

const ALL_STATUSES: DepositThreadStatus[] = ["waitingCheckin", "partial", "applied", "refunded"];

describe("DEPOSIT_FILTER_BUCKET_BY_STATUS / depositFilterBucketForStatus", () => {
  test("waitingCheckin and partial are outstanding (still holding a balance)", () => {
    expect(depositFilterBucketForStatus("waitingCheckin")).toBe("outstanding");
    expect(depositFilterBucketForStatus("partial")).toBe("outstanding");
  });

  test("applied and refunded are finished (closed out, however they closed)", () => {
    expect(depositFilterBucketForStatus("applied")).toBe("finished");
    expect(depositFilterBucketForStatus("refunded")).toBe("finished");
  });

  test("every DepositThreadStatus maps to exactly one of the two real buckets", () => {
    for (const status of ALL_STATUSES) {
      expect(["outstanding", "finished"]).toContain(DEPOSIT_FILTER_BUCKET_BY_STATUS[status]);
    }
  });
});

describe("matchesDepositFilter", () => {
  test('"all" passes every status, including the ตัดยอดแล้ว mismatch shape (R015834)', () => {
    for (const status of ALL_STATUSES) {
      expect(matchesDepositFilter(status, "all")).toBe(true);
    }
  });

  test('"outstanding" passes only waitingCheckin/partial', () => {
    expect(matchesDepositFilter("waitingCheckin", "outstanding")).toBe(true);
    expect(matchesDepositFilter("partial", "outstanding")).toBe(true);
    expect(matchesDepositFilter("applied", "outstanding")).toBe(false);
    expect(matchesDepositFilter("refunded", "outstanding")).toBe(false);
  });

  test('"finished" passes only applied/refunded', () => {
    expect(matchesDepositFilter("applied", "finished")).toBe(true);
    expect(matchesDepositFilter("refunded", "finished")).toBe(true);
    expect(matchesDepositFilter("waitingCheckin", "finished")).toBe(false);
    expect(matchesDepositFilter("partial", "finished")).toBe(false);
  });

  // The proven R015834 case (docs/adr/0001): received 395.00, applied
  // 790.00 -> status "applied" (over-applied still reads as ตัดยอดแล้ว) yet
  // the row is ALSO a mismatched exception. The exceptions section IS now
  // pill-filtered (owner ask, 2026-08-01, exceptions respect the focus
  // filter once resolved) — but via its OWN resolved-based predicate
  // (`matchesDepositExceptionFilter` below), never via this thread-status
  // one. This test only proves the STATUS predicate's own behavior: an
  // "applied" thread does not pass "outstanding", regardless of whether it
  // happens to also be an (unresolved) exception elsewhere in the UI.
  test("an applied (over-applied/mismatched-shape) thread does not pass the outstanding filter", () => {
    expect(matchesDepositFilter("applied", "outstanding")).toBe(false);
  });
});

// Owner ask (2026-08-01, exceptions respect the focus filter once
// resolved): a SEPARATE predicate from the one above — an exception's own
// bucket is keyed off its note's resolution (`resolvedAt`), not the
// thread's `DepositThreadStatus`.
describe("depositExceptionBucketForResolved / matchesDepositExceptionFilter", () => {
  test("unresolved (resolvedAt null) is outstanding — keeps shouting until dismissed", () => {
    expect(depositExceptionBucketForResolved(null)).toBe("outstanding");
  });

  test("resolved (resolvedAt non-null, SQLite datetime('now') text) is finished", () => {
    expect(depositExceptionBucketForResolved("2026-08-01 10:23:45")).toBe("finished");
  });

  test('"all" passes both resolved and unresolved', () => {
    expect(matchesDepositExceptionFilter(null, "all")).toBe(true);
    expect(matchesDepositExceptionFilter("2026-08-01 10:23:45", "all")).toBe(true);
  });

  test('"outstanding" passes only unresolved', () => {
    expect(matchesDepositExceptionFilter(null, "outstanding")).toBe(true);
    expect(matchesDepositExceptionFilter("2026-08-01 10:23:45", "outstanding")).toBe(false);
  });

  test('"finished" passes only resolved', () => {
    expect(matchesDepositExceptionFilter("2026-08-01 10:23:45", "finished")).toBe(true);
    expect(matchesDepositExceptionFilter(null, "finished")).toBe(false);
  });

  // The R015834 mirror of matchesDepositFilter's own test above: a thread
  // whose STATUS bucket is "finished" (applied/refunded) can still carry an
  // UNRESOLVED exception, which must independently pass "outstanding" via
  // this predicate — the two bucket rules never have to agree.
  test("an unresolved exception passes outstanding even when its thread's own status bucket is finished", () => {
    expect(depositFilterBucketForStatus("applied")).toBe("finished"); // the thread's own bucket
    expect(matchesDepositExceptionFilter(null, "outstanding")).toBe(true); // the exception's own bucket, independently
  });
});
