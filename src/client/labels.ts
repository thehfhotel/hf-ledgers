import type { CashAdjustmentAmounts, CashBlockAmounts, DayProvenance } from "../shared/types.ts";

// Thai display labels shared by more than one screen. Kept out of the pages
// so the day sheet and the history month list can never drift into two
// different words for the same DayProvenance value.

/** Full sentence form — the day sheet's provenance strip. */
export const PROVENANCE_LABELS_TH: Record<DayProvenance, string> = {
  app: "บันทึกในระบบนี้",
  transcribed: "คัดลอกจากเอกสารเดิม",
  reconstructed: "สร้างขึ้นใหม่จากข้อมูลเดิม (มีการปรับกระทบยอด)",
  summary_only: "มีเฉพาะข้อมูลสรุป (ยังไม่มีรายการจองรายตัว)",
};

/** Column form — the history table's ที่มา cell, with the full sentence
 * above carried as its title attribute. */
export const PROVENANCE_SHORT_TH: Record<DayProvenance, string> = {
  app: "บันทึกในระบบ",
  transcribed: "คัดลอกเอกสาร",
  reconstructed: "ปรับกระทบยอด",
  summary_only: "เฉพาะยอดสรุป",
};

/**
 * The paper's `**หมายเหตุ` cash-banking block, in its printed order and
 * wording — see src/shared/types.ts CashBlockAmounts. Shared by the booking
 * page (where a manager overrides the figures) and the printed day sheet
 * (where the override has to show up), so the two screens can never label
 * the same four lines differently.
 */
export const CASH_BLOCK_FIELDS: { key: keyof CashBlockAmounts; label: string }[] = [
  { key: "roomCashSatang", label: "รายได้โรงแรมเงินสด" },
  { key: "otherCashSatang", label: "รายการอื่นๆเงินสด" },
  { key: "barCashSatang", label: "บาร์น้ำเงินสด" },
  { key: "bankedSatang", label: "สรุปเงินสดฝากเข้าบัญชี" },
];

/**
 * The owner's deposit-machine reconciliation rows (docs/plan-unify-exports-
 * tender-split.md item 6, Wave C, 2026-07-31) — small change/coins that
 * can't always go into the deposit machine. Labels are VERBATIM from the
 * owner's request, with one correction: the owner typed the second row as
 * "เงินสดจากรอบก่อนที่เข้าตู้ไมไ่ด้" (a mis-ordered tone mark on ไม่ได้) — this
 * uses the correctly-spelled "ไม่ได้", same word as row 1. Shared by the day
 * page, the booking page's cash panel, and the printed **หมายเหตุ box, same
 * reasoning as CASH_BLOCK_FIELDS above: these two rows can never read
 * differently across screens. Order matches the sign each row carries in
 * `deriveCashBlock()` (bookings.ts): row 1 subtracts, row 2 adds.
 */
export const CASH_ADJUSTMENT_FIELDS: { key: keyof CashAdjustmentAmounts; label: string }[] = [
  { key: "heldBackSatang", label: "เงินสดยังไม่ฝาก (เข้าตู้ไม่ได้)" },
  { key: "broughtForwardSatang", label: "เงินสดจากรอบก่อนที่เข้าตู้ไม่ได้" },
];
