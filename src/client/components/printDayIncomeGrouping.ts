import type { Category, CategoryKey, DaySheet, IncomeCell } from "../../shared/types.ts";

// Pure grouping logic for the DAY-SUMMARY PRINT ONLY (PrintableDaySummary.tsx
// / .print-stage). The owner finds the flat 11-category list confusing on
// paper — this regroups the same cells by HOW the money arrived (cash /
// transfer / card / web), which the screen and the JPEG export do NOT do
// (they keep the flat list) — see PrintableDaySummary.tsx and
// reportSheetBlocks.tsx's IncomeExpenseSummaryCard for those unchanged
// renderings.
//
// Grouping is keyed on `categoryKey`, NEVER `nameTh` — managers can rename
// categories freely (see src/shared/types.ts Category doc comment), so any
// logic that means "the cash room-income category" has to key off the
// stable identity, same rule bookings.ts/rollup.ts/DaySheetPage.tsx follow.

export type PrintIncomeGroupId = "cash" | "transfer" | "card" | "web";

export interface PrintIncomeSubLine {
  categoryKey: CategoryKey;
  /** The category's live nameTh when a category with this key exists on
   * the sheet (active or archived); the seed fallback label otherwise. */
  label: string;
  /** null = no IncomeCell at all for this key (render "-", same as the
   * flat print's `cell ? formatSatang(...) : "-"` rule) — 0 or more is a
   * real cell (possibly a manually-entered zero). Summed across every
   * category sharing this key so a data anomaly (two categories same key)
   * can never silently drop money. */
  amountSatang: number | null;
  /** True when the (only, or representative) category carrying this key
   * is archived — the day sheet ships it because it's referenced by this
   * day's data (same contract IncomeExpenseSummaryCard's flat list uses). */
  archived: boolean;
}

export interface PrintIncomeGroup {
  id: PrintIncomeGroupId;
  /** Group heading, e.g. "เงินสด". */
  label: string;
  /** Group subtotal row's label, e.g. "รวมเงินสด". */
  totalLabel: string;
  lines: PrintIncomeSubLine[];
  totalSatang: number;
}

/** A manager-created income category (`categoryKey: null`) that holds
 * money on this day — printed in a trailing group, counted in the day's
 * grand total, but deliberately in none of the four tender totals: the
 * paper never told us how it arrived, so we do not invent a split. */
export interface PrintIncomeUnclassifiedLine {
  categoryId: number;
  label: string;
  amountSatang: number;
  archived: boolean;
}

export interface GroupedDayIncomeForPrint {
  /** Fixed order: cash, transfer, card, web (the task's group 1-4 order). */
  groups: PrintIncomeGroup[];
  /** Only categories that actually hold a cell — never a full listing of
   * every manager-created category, most of which carry nothing. */
  unclassified: PrintIncomeUnclassifiedLine[];
  unclassifiedTotalSatang: number;
  /** Independently summed from `groups` + `unclassified` (never copied
   * from `sheet.totals.incomeSatang`) so the grand total is a REAL
   * cross-check: the unit tests assert this equals `totals.incomeSatang`,
   * proving the grouping is lossless — every income cell lands in exactly
   * one place. The component still displays the server-computed
   * `totals.incomeSatang` for "รวมรายรับทั้งวัน" itself (this repo's rule:
   * totals are always server-computed, the client never prints its own
   * recomputation as the authoritative figure) — and visibly cross-checks
   * the two, see PrintableDaySummary.tsx's ตรวจสอบ line.
   */
  grandTotalSatang: number;
}

/**
 * Every standard CategoryKey mapped to its tender group, `satisfies`-checked
 * against `Record<CategoryKey, PrintIncomeGroupId>`: a CategoryKey added to
 * shared/types.ts without a matching entry here fails `bun run typecheck`
 * instead of silently vanishing from every printed total — the bug class
 * this replaces, where a key present in the contract but forgotten in a
 * hand-built per-group array printed as "-" forever, its money invisible on
 * paper. Object key order is spec-guaranteed insertion order for these
 * non-numeric string keys, and IS the printed sub-line order within each
 * group (see keysForGroup) — this one object is both the grouping table and
 * the layout order, so there is nothing else to keep in sync.
 */
const KEY_TO_GROUP = {
  room_cash: "cash",
  other_cash: "cash",
  bar_cash: "cash",
  // The two bank-named transfer columns first, then the three MIXED
  // โอน/เครดิต categories the paper never split by tender (see the task's
  // instruction not to invent one) — PrintableDaySummary.tsx marks the
  // group total with an asterisk + footnote so that honesty stays visible.
  transfer_kbank: "transfer",
  transfer_icbc: "transfer",
  deposit: "transfer",
  other_transfer: "transfer",
  bar_transfer: "transfer",
  credit_kbank: "card",
  credit_icbc: "card",
  web: "web",
} satisfies Record<CategoryKey, PrintIncomeGroupId>;

/** Fallback Thai label per key, verbatim from the seed list in server/db.ts
 * — used only when the property has no category carrying that key at all,
 * so a standard line stays visible even with nothing to show (matching how
 * the flat print lists every category today). */
const FALLBACK_LABEL_TH: Record<CategoryKey, string> = {
  deposit: "มัดจำล่วงหน้า",
  room_cash: "ค่าห้องเงินสด",
  credit_kbank: "บัตรเครดิต/กสิกร",
  credit_icbc: "บัตรเครดิต ICBC",
  transfer_kbank: "โอน/กสิกร",
  transfer_icbc: "โอน ICBC",
  web: "เว็ปไซด์",
  other_cash: "รายการอื่นๆ เงินสด",
  other_transfer: "รายการอื่นๆ โอน/เครดิต",
  bar_cash: "บาร์น้ำ เงินสด",
  bar_transfer: "บาร์น้ำ โอน/เครดิต",
};

const GROUP_LABELS: Record<PrintIncomeGroupId, { label: string; totalLabel: string }> = {
  cash: { label: "เงินสด", totalLabel: "รวมเงินสด" },
  transfer: { label: "เงินโอน", totalLabel: "รวมเงินโอน" },
  card: { label: "บัตรเครดิต", totalLabel: "รวมบัตรเครดิต" },
  web: { label: "เว็บไซต์ / OTA", totalLabel: "รวมเว็บไซต์" },
};

/** Fixed print order: cash, transfer, card, web (the task's group 1-4 order). */
const GROUP_ORDER: PrintIncomeGroupId[] = ["cash", "transfer", "card", "web"];

/** Every CategoryKey assigned to `groupId`, in KEY_TO_GROUP's own (fixed,
 * spec-guaranteed) insertion order — the printed sub-line order. */
function keysForGroup(groupId: PrintIncomeGroupId): CategoryKey[] {
  return (Object.keys(KEY_TO_GROUP) as CategoryKey[]).filter((key) => KEY_TO_GROUP[key] === groupId);
}

export const UNCLASSIFIED_GROUP_LABEL_TH = "อื่นๆ (ไม่ระบุประเภท)";
export const UNCLASSIFIED_TOTAL_LABEL_TH = "รวมอื่นๆ (ไม่ระบุประเภท)";
export const GRAND_TOTAL_LABEL_TH = "รวมรายรับทั้งวัน";

/** The subset of DaySheet this pure function actually reads — lets tests
 * build a minimal fixture instead of a full DaySheet. A real DaySheet
 * satisfies this structurally, so `groupDayIncomeForPrint(sheet)` at the
 * call site needs no adapting. */
export type DayIncomeSheet = Pick<DaySheet, "categories" | "income">;

function buildSubLine(
  categoryKey: CategoryKey,
  incomeCategories: Category[],
  income: Record<number, IncomeCell>,
): PrintIncomeSubLine {
  const matches = incomeCategories.filter((c) => c.categoryKey === categoryKey);
  // Prefer an active category for the printed label; fall back to an
  // archived one referenced by this day's data (the DaySheet contract:
  // "categories" ships any archived category the day's cells reference).
  const representative = matches.find((c) => c.archivedAt === null) ?? matches[0];

  let amountSatang: number | null = null;
  for (const category of matches) {
    const cell = income[category.id];
    if (cell) amountSatang = (amountSatang ?? 0) + cell.amountSatang;
  }

  return {
    categoryKey,
    label: representative ? representative.nameTh : FALLBACK_LABEL_TH[categoryKey],
    amountSatang,
    archived: representative ? representative.archivedAt !== null : false,
  };
}

/**
 * Groups a day's income cells by tender (cash / transfer / card / web) for
 * the print-only layout — see the module comment above. Never touches
 * `sheet.expenses` or the cash-banking block; those stay PrintableDaySummary
 * / reportSheetBlocks territory.
 */
export function groupDayIncomeForPrint(sheet: DayIncomeSheet): GroupedDayIncomeForPrint {
  const incomeCategories = sheet.categories.filter((c) => c.kind === "income");

  const groups: PrintIncomeGroup[] = GROUP_ORDER.map((id) => {
    const lines = keysForGroup(id).map((key) => buildSubLine(key, incomeCategories, sheet.income));
    const totalSatang = lines.reduce((sum, line) => sum + (line.amountSatang ?? 0), 0);
    return { id, ...GROUP_LABELS[id], lines, totalSatang };
  });

  const unclassified: PrintIncomeUnclassifiedLine[] = incomeCategories
    .filter((c) => c.categoryKey === null && sheet.income[c.id] != null)
    .slice()
    .sort((a, b) => a.sort - b.sort)
    .map((c) => ({
      categoryId: c.id,
      label: c.nameTh,
      amountSatang: sheet.income[c.id]!.amountSatang,
      archived: c.archivedAt !== null,
    }));
  const unclassifiedTotalSatang = unclassified.reduce((sum, line) => sum + line.amountSatang, 0);

  const grandTotalSatang = groups.reduce((sum, g) => sum + g.totalSatang, 0) + unclassifiedTotalSatang;

  return { groups, unclassified, unclassifiedTotalSatang, grandTotalSatang };
}
