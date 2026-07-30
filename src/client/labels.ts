import type { CashBlockAmounts, DayProvenance } from "../shared/types.ts";

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
