// Label normalization for the summary-sheet categories, plus best-effort
// cash/transfer inference from itemized other-income free text.
//
// IMPORTANT: normalize by stripping ALL whitespace before comparing. Two of
// the app's own category names differ from what's printed in the sheets by
// a single U+0020 (e.g. "บัตรเครดิต /กสิกร" vs "บัตรเครดิต/กสิกร"), and the
// cash-block label "บาร์น้ำเงินสด" collides character-for-character with the
// main-block label "บาร์น้ำ เงินสด" once whitespace is stripped — the two
// tables MUST stay section-scoped (above vs below "**หมายเหตุ"), never merged.

import type { CashBlockKey, SummaryCategoryKey } from "./types.ts";

export function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

const SUMMARY_CATEGORY_ALIASES: Record<SummaryCategoryKey, string[]> = {
  depositAdvance: ["มัดจำล่วงหน้า"],
  roomCash: ["ค่าห้องเงินสด"],
  creditKbank: ["บัตรเครดิต /กสิกร", "บัตรเครดิต KBANK"],
  creditIcbc: ["บัตรเครดิต ICBC"],
  transferKbank: ["โอน/กสิกร", "โอน KBANK"],
  transferIcbc: ["โอน ICBC"],
  website: ["เว็ปไซด์", "เว็บไซด์"],
  otherItems: ["รายการ อื่นๆ"],
  waterBarCash: ["บาร์น้ำ เงินสด"],
  waterBarTransferCredit: ["บาร์น้ำ โอน/เครดิต"],
};

const CASH_BLOCK_ALIASES: Record<CashBlockKey, string[]> = {
  hotelRevenueCash: ["รายได้โรงแรมเงินสด"],
  // "รายการอื่นๆ" (bare, no "เงินสด" suffix) is a real variant seen below the
  // notes marker (sheet "16-7-69" of the HF summary workbook) — it strips to
  // the same text as the main-block category label, but this table is
  // section-scoped so there is no collision.
  otherItemsCash: ["รายการอื่นๆเงินสด", "รายการอื่นๆ"],
  waterBarCashBlock: ["บาร์น้ำเงินสด"],
  bankedTotal: [
    "สรุป เงินสดน้ำฝากเข้าบัญชี",
    "สรุป เงินสดฝากเข้าบัญชี",
    "สรุป เงินสดนำฝากเข้าบัญชี",
  ],
};

function buildLookup<K extends string>(aliases: Record<K, string[]>): Map<string, K> {
  const lookup = new Map<string, K>();
  for (const key of Object.keys(aliases) as K[]) {
    for (const alias of aliases[key]) {
      lookup.set(stripWhitespace(alias), key);
    }
  }
  return lookup;
}

const CATEGORY_LOOKUP = buildLookup(SUMMARY_CATEGORY_ALIASES);
const CASH_BLOCK_LOOKUP = buildLookup(CASH_BLOCK_ALIASES);

/** Resolve a raw label from the main summary block (above `**หมายเหตุ`). */
export function resolveCategoryLabel(rawLabel: string): SummaryCategoryKey | null {
  return CATEGORY_LOOKUP.get(stripWhitespace(rawLabel)) ?? null;
}

/** Resolve a raw label from the cash-only block (below `**หมายเหตุ`). */
export function resolveCashBlockLabel(rawLabel: string): CashBlockKey | null {
  return CASH_BLOCK_LOOKUP.get(stripWhitespace(rawLabel)) ?? null;
}

/**
 * Best-effort tender inference from itemized other-income free text, e.g.
 * "R.116 ค่าปรับ(เงินสด)" (cash), "เบาะเสริมR.108 เงินโอน" (transfer),
 * "ค่าอาหารเช้า ห้อง 418 เงินสด" (cash). Returns undefined when the text
 * carries neither cash nor transfer/credit wording.
 */
export function inferIsCashFromFreeText(text: string): boolean | undefined {
  if (text.includes("เงินสด")) return true;
  if (text.includes("โอน") || text.includes("เครดิต")) return false;
  return undefined;
}
