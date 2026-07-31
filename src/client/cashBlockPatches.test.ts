import { describe, expect, test } from "bun:test";
import { activeCashAdjustmentPatch, activeCashOverridePatch } from "./cashBlockPatches.ts";
import type { CashBlock, CashBlockAmounts } from "../shared/types.ts";

function derived(overrides: Partial<CashBlockAmounts> = {}): CashBlockAmounts {
  return {
    roomCashSatang: 49_000,
    otherCashSatang: 5_000,
    barCashSatang: 2_000,
    bankedSatang: 56_000,
    ...overrides,
  };
}

function block(overrides: Partial<CashBlock> = {}): CashBlock {
  return {
    derived: derived(),
    entered: null,
    heldBackSatang: null,
    broughtForwardSatang: null,
    depositCashInSatang: 0,
    depositCashOutSatang: 0,
    ...overrides,
  };
}

describe("activeCashOverridePatch", () => {
  test("no override recorded (entered null) -> empty patch", () => {
    expect(activeCashOverridePatch(block())).toEqual({});
  });

  // The core bug this function exists to fix: mergeCashBlockOverride()
  // fully populates `entered` with every field, including ones nobody
  // actually overrode (they fall back to derived at merge time). Only the
  // GENUINELY different field must survive into the patch.
  test("entered is a fully-merged document with only ONE field genuinely overridden -> patch carries only that field", () => {
    const cb = block({
      entered: { ...derived(), roomCashSatang: 60_000 }, // only roomCashSatang differs from derived
    });
    expect(activeCashOverridePatch(cb)).toEqual({ roomCashSatang: 60_000 });
  });

  test("two fields genuinely overridden -> patch carries exactly those two", () => {
    const cb = block({
      entered: { ...derived(), roomCashSatang: 60_000, bankedSatang: 999_999 },
    });
    expect(activeCashOverridePatch(cb)).toEqual({ roomCashSatang: 60_000, bankedSatang: 999_999 });
  });

  test("every field overridden -> patch carries the full document", () => {
    const cb = block({
      entered: { roomCashSatang: 1, otherCashSatang: 2, barCashSatang: 3, bankedSatang: 4 },
    });
    expect(activeCashOverridePatch(cb)).toEqual({
      roomCashSatang: 1,
      otherCashSatang: 2,
      barCashSatang: 3,
      bankedSatang: 4,
    });
  });

  test("an entered value that equals derived degrades to not-overridden (documented, intentional)", () => {
    // Same shape mergeCashBlockOverride() would never actually construct
    // (its hasOverride check requires a genuine DB override on at least
    // one field), but this proves the equality check itself, independent
    // of how `entered` came to look this way.
    const cb = block({ entered: derived() });
    expect(activeCashOverridePatch(cb)).toEqual({});
  });
});

describe("activeCashAdjustmentPatch", () => {
  test("neither recorded -> empty patch", () => {
    expect(activeCashAdjustmentPatch(block())).toEqual({});
  });

  test("only heldBackSatang recorded -> patch carries only that field", () => {
    const cb = block({ heldBackSatang: 12_000 });
    expect(activeCashAdjustmentPatch(cb)).toEqual({ heldBackSatang: 12_000 });
  });

  test("only broughtForwardSatang recorded -> patch carries only that field", () => {
    const cb = block({ broughtForwardSatang: 8_500 });
    expect(activeCashAdjustmentPatch(cb)).toEqual({ broughtForwardSatang: 8_500 });
  });

  test("both recorded -> patch carries both", () => {
    const cb = block({ heldBackSatang: 12_000, broughtForwardSatang: 8_500 });
    expect(activeCashAdjustmentPatch(cb)).toEqual({ heldBackSatang: 12_000, broughtForwardSatang: 8_500 });
  });

  test("an explicit 0 is a recorded value, not omitted like null", () => {
    const cb = block({ heldBackSatang: 0, broughtForwardSatang: 0 });
    expect(activeCashAdjustmentPatch(cb)).toEqual({ heldBackSatang: 0, broughtForwardSatang: 0 });
  });
});
