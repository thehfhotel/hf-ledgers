import { CASH_BLOCK_FIELDS } from "./labels.ts";
import type { CashAdjustmentAmounts, CashBlock, CashBlockAmounts } from "../shared/types.ts";

// Shared PUT .../cash-block body builders — the ONE copy DaySheetPage.tsx
// and BookingDayPage.tsx both import (Opus money-review, 2026-07-31,
// docs/plan-unify-exports-tender-split.md item 6 follow-up: two
// byte-identical copies of this logic had already drifted apart once).
//
// THE BUG THIS FIXES: `mergeCashBlockOverride()` (db.ts) returns a FULLY
// POPULATED `CashBlockAmounts` for `cashBlock.entered` the moment ANY ONE
// of the four fields is overridden — every field NOT actually overridden
// falls back to `derived` AT MERGE TIME, so e.g. `entered.bankedSatang`
// reads as a concrete number even when nobody ever overrode bankedSatang
// itself. Naively re-sending `...cashBlock.entered` in a later PUT (the
// pattern every commit handler used before this fix) therefore stores that
// PRE-adjustment `derived.bankedSatang` SNAPSHOT as a REAL, permanent
// override — which then wins over every future recomputation, including a
// heldBack/broughtForward adjustment recorded afterward. Proven broken
// sequences: override room cash then record held-back 30 -> bank line
// unchanged; record held-back, override bar, correct held-back -> stale;
// clear the adjustment after an override -> the deduction stays baked in
// with its explanatory row gone.
//
// `activeCashOverridePatch()` recovers only the fields that are GENUINELY
// different from derived, so re-sending it never re-pins an untouched
// field's current derived snapshot as a permanent override. An override
// that happens to equal derived degrading back to "not overridden" is
// fine — the ปรับจาก hint already treats an entered value equal to derived
// as unremarkable, so this can never visibly regress anything.

const CASH_BLOCK_KEYS = CASH_BLOCK_FIELDS.map((field) => field.key);

/** The subset of `cashBlock.entered` that is genuinely overridden — i.e.
 * differs from `cashBlock.derived` for that field — safe to re-send
 * verbatim in a PUT .../cash-block body without pinning an untouched
 * field's current derived snapshot as a permanent override. */
export function activeCashOverridePatch(cashBlock: CashBlock): Partial<CashBlockAmounts> {
  if (!cashBlock.entered) return {};
  const out: Partial<CashBlockAmounts> = {};
  for (const key of CASH_BLOCK_KEYS) {
    if (cashBlock.entered[key] !== cashBlock.derived[key]) out[key] = cashBlock.entered[key];
  }
  return out;
}

/** The currently-recorded heldBackSatang/broughtForwardSatang adjustment,
 * ready to re-send in a PUT .../cash-block body alongside a change to the
 * other half (the override above, or the other adjustment field) — `null`
 * (not recorded) fields are omitted entirely, never sent as an explicit 0
 * a caller never typed. */
export function activeCashAdjustmentPatch(cashBlock: CashBlock): Partial<CashAdjustmentAmounts> {
  return {
    ...(cashBlock.heldBackSatang != null ? { heldBackSatang: cashBlock.heldBackSatang } : {}),
    ...(cashBlock.broughtForwardSatang != null ? { broughtForwardSatang: cashBlock.broughtForwardSatang } : {}),
  };
}
