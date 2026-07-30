import { describe, expect, test } from "bun:test";
import { toSatang } from "./types.ts";

describe("toSatang", () => {
  test("rounds a clean baht amount to satang", () => {
    expect(toSatang(99)).toBe(9900);
    expect(toSatang(23.48)).toBe(2348);
  });

  test("rounds per-cell, never summing floating baht first — real cached total 22066.739999999998", () => {
    expect(toSatang(22066.739999999998)).toBe(2206674);
  });

  test("treats null and undefined as zero", () => {
    expect(toSatang(null)).toBe(0);
    expect(toSatang(undefined)).toBe(0);
  });

  test("treats zero as zero", () => {
    expect(toSatang(0)).toBe(0);
  });

  test("handles negative amounts (e.g. adjustments)", () => {
    expect(toSatang(-50.5)).toBe(-5050);
  });
});
