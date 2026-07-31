import type { Category, CategoryKey, DaySheet, IncomeCell } from "../../shared/types.ts";

// Pure grouping logic feeding reportSheetBlocks.tsx's DayTenderSummary — the
// owner found the flat 15-category list confusing on paper, so this
// regroups the same cells by HOW the money arrived (cash / transfer / card /
// web, plus the optional Wave C deposit_applied group). As of the
// "ONE LAYOUT FOR ALL THREE EXPORTS" rework (owner decision, 2026-07-31, see
// reportSheetBlocks.tsx's own module comment), print, PDF, AND the JPEG
// export (ReportPage.tsx via ReportSheet.tsx's "full" variant) all render
// DayTenderSummary and therefore this same grouping — only the LIVE SCREEN
// (DaySheetPage.tsx's own รายรับ panel, plain JSX, no shared component)
// keeps the flat per-category list this module was built to replace on
// paper. The old flat-list print components this superseded
// (IncomeExpenseSummaryCard/CashSummaryCard) are retired and no longer
// exist — see reportSheetBlocks.tsx's module comment for that history.
//
// Grouping is keyed on `categoryKey`, NEVER `nameTh` — managers can rename
// categories freely (see src/shared/types.ts Category doc comment), so any
// logic that means "the cash room-income category" has to key off the
// stable identity, same rule bookings.ts/rollup.ts/DaySheetPage.tsx follow.

// `"deposit_applied"` (Wave C, docs/adr/0001) is a FIFTH group, printed only
// when it holds money — see GROUP_ORDER/groupDayIncomeForPrint's filter
// below and reportSheetBlocks.tsx's DayTenderSummary, which renders it as
// an ordinary group in the left column plus a subtotal in the totals box.
// Deliberately not folded into "card"/"transfer"/whichever bank actually
// settled it: the ตัดยอดมัดจำ tender needs its own visible line so revenue
// recognised via a deposit (no money moved) reads distinctly from revenue
// that arrived by an ordinary tender today.
export type PrintIncomeGroupId = "cash" | "transfer" | "card" | "web" | "deposit_applied";

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
  /** Fixed order: cash, transfer, card, web, then deposit_applied (Wave C)
   * when it holds money — the OPTIONAL fifth group is simply absent from
   * this array on a day that applied no deposit. */
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
  // The two bank-named transfer columns first, then the three
  // historically-MIXED โอน/เครดิต categories the paper never split by
  // tender for data already on the books (see the task's instruction not
  // to invent one) — reportSheetBlocks.tsx's DayTenderSummary marks the
  // group total with an asterisk + footnote so that honesty stays visible.
  // Going forward (2026-07-31) these three are โอน-only at entry; their
  // split-off เครดิต siblings (deposit_credit/other_credit/bar_credit,
  // below) carry new money into the card group instead.
  transfer_kbank: "transfer",
  transfer_icbc: "transfer",
  deposit: "transfer",
  other_transfer: "transfer",
  bar_transfer: "transfer",
  credit_kbank: "card",
  credit_icbc: "card",
  deposit_credit: "card",
  other_credit: "card",
  bar_credit: "card",
  web: "web",
  // Wave C (docs/adr/0001): its own group, printed only when non-empty —
  // see GROUP_ORDER/groupDayIncomeForPrint's filter below.
  deposit_applied: "deposit_applied",
} satisfies Record<CategoryKey, PrintIncomeGroupId>;

/** Fallback Thai label per key, verbatim from the seed list in server/db.ts
 * — used only when the property has no category carrying that key at all,
 * so a standard line stays visible even with nothing to show (matching how
 * the flat print lists every category today). */
const FALLBACK_LABEL_TH: Record<CategoryKey, string> = {
  deposit: "มัดจำล่วงหน้า โอน",
  deposit_credit: "มัดจำล่วงหน้า เครดิต",
  deposit_applied: "มัดจำล่วงหน้า (ตัดยอด)",
  room_cash: "ค่าห้องเงินสด",
  credit_kbank: "บัตรเครดิต/กสิกร",
  credit_icbc: "บัตรเครดิต ICBC",
  transfer_kbank: "โอน/กสิกร",
  transfer_icbc: "โอน ICBC",
  web: "เว็ปไซด์",
  other_cash: "รายการอื่นๆ เงินสด",
  other_transfer: "รายการอื่นๆ โอน",
  other_credit: "รายการอื่นๆ เครดิต",
  bar_cash: "บาร์น้ำ เงินสด",
  bar_transfer: "บาร์น้ำ โอน",
  bar_credit: "บาร์น้ำ เครดิต",
};

const GROUP_LABELS: Record<PrintIncomeGroupId, { label: string; totalLabel: string }> = {
  cash: { label: "เงินสด", totalLabel: "รวมเงินสด" },
  transfer: { label: "เงินโอน", totalLabel: "รวมเงินโอน" },
  card: { label: "บัตรเครดิต", totalLabel: "รวมบัตรเครดิต" },
  web: { label: "เว็บไซต์ / OTA", totalLabel: "รวมเว็บไซต์" },
  deposit_applied: { label: "มัดจำที่ตัดยอด", totalLabel: "รวมมัดจำที่ตัดยอด" },
};

/** Fixed print order: cash, transfer, card, web, deposit_applied (the
 * task's group 1-4 order, plus the Wave C fifth group appended last). */
const GROUP_ORDER: PrintIncomeGroupId[] = ["cash", "transfer", "card", "web", "deposit_applied"];

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
  }).filter((group) => group.id !== "deposit_applied" || group.totalSatang > 0);
  // ^ Wave C: the deposit_applied group is OPTIONAL — printed only on a day
  // that actually applied a deposit, so a no-deposit day's printed sheet
  // stays byte-identical to before this group existed (rather than an
  // always-visible "0.00" row nobody asked for).

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
