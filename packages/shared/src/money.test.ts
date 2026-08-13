// The UNION of both ledgers' money suites, not a pick between them: neither
// was a superset of the other, and each half is load-bearing for a fix that
// already shipped.
//
// From expense-ledger — the parseAmountToSatang rejection cases. That file
// didn't exist before the M2 fix (ApRowDrawer.tsx's VAT/WHT/discount fields
// used to treat an unparseable amount as a silent 0 rather than a validation
// error); these tests lock the CONTRACT that fix depends on: parse must keep
// returning null, never a coerced number, for anything that isn't a valid
// non-negative amount, so a client-side `?? 0` fallback can never again hide
// a clerk's typo. Its five cases ("abc", "12.345", "-5", "12.", "1e5") cover
// income-ledger's thinner three.
//
// From income-ledger — the whole shouldCommitAmount describe (Opus
// money-review P5, 2026-07-31). AmountInput's no-op check used to normalize
// a typed 0 to null unconditionally before comparing against the field's
// current value — correct for income cells and expense lines, where 0 IS
// empty, but wrong for zeroIsMeaningful fields (cash-block override/
// adjustment), where an explicit 0 is a real, distinct value from unset. The
// bug: typing "0.00" into an UNSET zeroIsMeaningful field compared equal to
// the unset baseline (both normalized to null) and never fired onCommit at
// all.

import { describe, expect, test } from "bun:test";
import { formatSatang, parseAmountToSatang, shouldCommitAmount } from "./money.ts";

describe("parseAmountToSatang", () => {
  test("parses a plain integer baht amount", () => {
    expect(parseAmountToSatang("20")).toBe(2_000);
  });

  test("parses a decimal amount with two places", () => {
    expect(parseAmountToSatang("2,983.80")).toBe(298_380);
  });

  test("trims surrounding whitespace", () => {
    expect(parseAmountToSatang(" 490.5 ")).toBe(49_050);
  });

  test("empty input is null", () => {
    expect(parseAmountToSatang("")).toBeNull();
    expect(parseAmountToSatang("   ")).toBeNull();
  });

  // M2 fix's exact regression case: none of these unparseable strings may
  // ever silently coerce to a number — the AP row drawer relies on this null
  // to show a validation error instead of quietly zeroing out a real VAT/
  // WHT/discount figure.
  test("garbage text is null, not a coerced number", () => {
    expect(parseAmountToSatang("abc")).toBeNull();
    expect(parseAmountToSatang("12.345")).toBeNull(); // more than 2 decimal places
    expect(parseAmountToSatang("-5")).toBeNull(); // negative
    expect(parseAmountToSatang("12.")).toBeNull();
    expect(parseAmountToSatang("1e5")).toBeNull();
  });
});

describe("formatSatang", () => {
  test("formats satang as a 2-decimal baht string with thousands separators", () => {
    expect(formatSatang(298_380)).toBe("2,983.80");
  });

  test("formats zero", () => {
    expect(formatSatang(0)).toBe("0.00");
  });
});

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
