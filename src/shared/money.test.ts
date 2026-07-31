import { describe, expect, test } from "bun:test";
import { formatSatang, parseAmountToSatang, shouldCommitAmount } from "./money.ts";

describe("formatSatang", () => {
  test("298380 -> 2,983.80", () => {
    expect(formatSatang(298_380)).toBe("2,983.80");
  });

  test("0 -> 0.00", () => {
    expect(formatSatang(0)).toBe("0.00");
  });
});

describe("parseAmountToSatang", () => {
  test("parses a thousands-separated amount", () => {
    expect(parseAmountToSatang("2,983.80")).toBe(298_380);
  });

  test("empty input is null", () => {
    expect(parseAmountToSatang("")).toBeNull();
  });

  test("a bare integer has no decimal places", () => {
    expect(parseAmountToSatang("20")).toBe(2_000);
  });
});

// shouldCommitAmount (Opus money-review P5, 2026-07-31): AmountInput's
// no-op check used to normalize a typed 0 to null unconditionally before
// comparing against the field's current value — correct for income cells/
// expense lines, where 0 IS empty, but wrong for zeroIsMeaningful fields
// (cash-block override/adjustment), where an explicit 0 is a real, distinct
// value from unset. The bug: typing "0.00" into an UNSET zeroIsMeaningful
// field compared equal to the unset baseline (both normalized to null) and
// never fired onCommit at all.
describe("shouldCommitAmount", () => {
  describe("zeroIsMeaningful = false (income cells, expense lines)", () => {
    test("typing 0 into an already-empty (null) field is a no-op", () => {
      expect(shouldCommitAmount(null, 0, false)).toBe(false);
    });

    test("clearing a previously-set field (parsed null) always fires", () => {
      expect(shouldCommitAmount(5_000, null, false)).toBe(true);
    });

    test("typing 0 into a previously-set field fires (the caller deletes the cell)", () => {
      expect(shouldCommitAmount(5_000, 0, false)).toBe(true);
    });

    test("re-typing the same amount is a no-op", () => {
      expect(shouldCommitAmount(5_000, 5_000, false)).toBe(false);
    });

    test("typing a new amount fires", () => {
      expect(shouldCommitAmount(5_000, 6_000, false)).toBe(true);
    });
  });

  describe("zeroIsMeaningful = true (cash-block override/adjustment fields)", () => {
    // THE PROVEN BUG, now fixed: this must be true, not false.
    test("typing explicit 0 into an UNSET (null) field fires onCommit(0)", () => {
      expect(shouldCommitAmount(null, 0, true)).toBe(true);
    });

    test("re-typing the same explicit 0 is a genuine no-op", () => {
      expect(shouldCommitAmount(0, 0, true)).toBe(false);
    });

    test("clearing an explicit-0 field back to blank (parsed null) fires", () => {
      expect(shouldCommitAmount(0, null, true)).toBe(true);
    });

    test("typing a new amount over an existing one fires", () => {
      expect(shouldCommitAmount(5_000, 6_000, true)).toBe(true);
    });

    test("re-typing the same amount is a no-op", () => {
      expect(shouldCommitAmount(5_000, 5_000, true)).toBe(false);
    });
  });
});
