import { describe, expect, test } from "bun:test";
import { ACCRUAL_CUTOVER_DATE, isAccrualDay, visibleTendersForDate } from "./accrual.ts";
import { TENDERS } from "./types.ts";

describe("ACCRUAL_CUTOVER_DATE", () => {
  test("both properties share the same owner-decided cutover date", () => {
    expect(ACCRUAL_CUTOVER_DATE.hf).toBe("2026-07-31");
    expect(ACCRUAL_CUTOVER_DATE.hfville).toBe("2026-07-31");
  });
});

describe("isAccrualDay", () => {
  test("the day before cutover is pre-cutover", () => {
    expect(isAccrualDay("hf", "2026-07-30")).toBe(false);
    expect(isAccrualDay("hfville", "2026-07-30")).toBe(false);
  });

  test("the cutover date itself IS already an accrual day (inclusive)", () => {
    expect(isAccrualDay("hf", "2026-07-31")).toBe(true);
    expect(isAccrualDay("hfville", "2026-07-31")).toBe(true);
  });

  test("any date after cutover is an accrual day", () => {
    expect(isAccrualDay("hf", "2026-08-01")).toBe(true);
    expect(isAccrualDay("hf", "2027-01-01")).toBe(true);
  });

  test("far in the past is never an accrual day", () => {
    expect(isAccrualDay("hf", "2020-01-01")).toBe(false);
  });
});

describe("visibleTendersForDate", () => {
  test("pre-cutover: 8 tenders, deposit visible, deposit_applied hidden", () => {
    const visible = visibleTendersForDate("hf", "2026-07-30");
    expect(visible).toHaveLength(8);
    expect(visible).toContain("deposit");
    expect(visible).not.toContain("deposit_applied");
  });

  test("on/after cutover: 8 tenders, deposit_applied visible, deposit hidden", () => {
    const visible = visibleTendersForDate("hf", "2026-07-31");
    expect(visible).toHaveLength(8);
    expect(visible).toContain("deposit_applied");
    expect(visible).not.toContain("deposit");
  });

  test("every OTHER tender is always visible regardless of cutover", () => {
    const always = TENDERS.filter((t) => t !== "deposit" && t !== "deposit_applied");
    const pre = visibleTendersForDate("hf", "2026-01-01");
    const post = visibleTendersForDate("hf", "2027-01-01");
    for (const tender of always) {
      expect(pre).toContain(tender);
      expect(post).toContain(tender);
    }
  });

  test("preserves TENDERS' own relative order (the deposit slot's position never moves)", () => {
    const pre = visibleTendersForDate("hf", "2026-01-01");
    const post = visibleTendersForDate("hf", "2027-01-01");
    // Same length, and swapping just "deposit" for "deposit_applied" (or
    // vice versa) at the same index reproduces the other list exactly.
    expect(pre.map((t): (typeof post)[number] => (t === "deposit" ? "deposit_applied" : t))).toEqual(post);
  });

  test("hf and hfville agree, since they share the same cutover date today", () => {
    expect(visibleTendersForDate("hf", "2026-07-30")).toEqual(visibleTendersForDate("hfville", "2026-07-30"));
    expect(visibleTendersForDate("hf", "2026-08-01")).toEqual(visibleTendersForDate("hfville", "2026-08-01"));
  });
});
