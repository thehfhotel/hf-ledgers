import { describe, expect, test } from "bun:test";
import type { DepositThreadStatus } from "../../shared/types.ts";
import {
  DEPOSIT_FILTER_BUCKET_BY_STATUS,
  depositFilterBucketForStatus,
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
  // the row is ALSO a mismatched exception. The exception section is never
  // pill-filtered (see DepositRegisterPage.tsx's ข้อยกเว้น section comment)
  // — this test only proves the FILTER PREDICATE's own behavior: an
  // "applied" thread does not pass "outstanding", regardless of whether it
  // happens to also be an exception elsewhere in the UI.
  test("an applied (over-applied/mismatched-shape) thread does not pass the outstanding filter", () => {
    expect(matchesDepositFilter("applied", "outstanding")).toBe(false);
  });
});
