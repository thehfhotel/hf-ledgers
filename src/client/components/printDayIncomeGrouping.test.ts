import { describe, expect, test } from "bun:test";
import { computeDayTotals } from "../../shared/totals.ts";
import type { Category, ExpenseItem, IncomeCell } from "../../shared/types.ts";
import {
  GRAND_TOTAL_LABEL_TH,
  groupDayIncomeForPrint,
  UNCLASSIFIED_GROUP_LABEL_TH,
  UNCLASSIFIED_TOTAL_LABEL_TH,
  type DayIncomeSheet,
} from "./printDayIncomeGrouping.ts";

const STAMP = "2026-07-28 15:40:00";
const BY = "tester@thehfhotel.org";

function makeCategory(overrides: Partial<Category> & Pick<Category, "id" | "nameTh">): Category {
  return {
    property: "hf",
    kind: "income",
    sort: overrides.id,
    isCash: false,
    categoryKey: null,
    archivedAt: null,
    createdAt: STAMP,
    ...overrides,
  };
}

function makeCell(categoryId: number, amountSatang: number, overrides: Partial<IncomeCell> = {}): IncomeCell {
  return {
    categoryId,
    amountSatang,
    note: null,
    source: "manual",
    manual: true,
    updatedAt: STAMP,
    updatedBy: BY,
    ...overrides,
  };
}

// The eleven standard categories, seeded verbatim from server/db.ts's
// INCOME_SEED (nameTh + categoryKey), each with a distinctive amount so a
// mis-grouped cell is easy to spot in a failing assertion.
const STANDARD_CATEGORIES: Category[] = [
  makeCategory({ id: 1, nameTh: "มัดจำล่วงหน้า", categoryKey: "deposit" }),
  makeCategory({ id: 2, nameTh: "ค่าห้องเงินสด", categoryKey: "room_cash", isCash: true }),
  makeCategory({ id: 3, nameTh: "บัตรเครดิต/กสิกร", categoryKey: "credit_kbank" }),
  makeCategory({ id: 4, nameTh: "บัตรเครดิต ICBC", categoryKey: "credit_icbc" }),
  makeCategory({ id: 5, nameTh: "โอน/กสิกร", categoryKey: "transfer_kbank" }),
  makeCategory({ id: 6, nameTh: "โอน ICBC", categoryKey: "transfer_icbc" }),
  makeCategory({ id: 7, nameTh: "เว็ปไซด์", categoryKey: "web" }),
  makeCategory({ id: 8, nameTh: "รายการอื่นๆ เงินสด", categoryKey: "other_cash", isCash: true }),
  makeCategory({ id: 9, nameTh: "รายการอื่นๆ โอน/เครดิต", categoryKey: "other_transfer" }),
  makeCategory({ id: 10, nameTh: "บาร์น้ำ เงินสด", categoryKey: "bar_cash", isCash: true }),
  makeCategory({ id: 11, nameTh: "บาร์น้ำ โอน/เครดิต", categoryKey: "bar_transfer" }),
];

const STANDARD_INCOME: Record<number, IncomeCell> = {
  1: makeCell(1, 5_000), // deposit
  2: makeCell(2, 49_000), // room_cash
  3: makeCell(3, 30_000), // credit_kbank
  4: makeCell(4, 20_000), // credit_icbc
  5: makeCell(5, 829_000), // transfer_kbank
  6: makeCell(6, 6_000), // transfer_icbc
  7: makeCell(7, 298_380), // web
  8: makeCell(8, 15_000), // other_cash
  9: makeCell(9, 7_000), // other_transfer
  10: makeCell(10, 2_000), // bar_cash
  11: makeCell(11, 3_000), // bar_transfer
};

describe("groupDayIncomeForPrint", () => {
  test("groups every standard category into its tender group, in the specified order", () => {
    const sheet: DayIncomeSheet = { categories: STANDARD_CATEGORIES, income: STANDARD_INCOME };
    const grouped = groupDayIncomeForPrint(sheet);

    expect(grouped.groups.map((g) => g.id)).toEqual(["cash", "transfer", "card", "web"]);
    expect(grouped.groups.map((g) => g.label)).toEqual(["เงินสด", "เงินโอน", "บัตรเครดิต", "เว็บไซต์ / OTA"]);

    const cash = grouped.groups[0]!;
    expect(cash.lines.map((l) => l.categoryKey)).toEqual(["room_cash", "other_cash", "bar_cash"]);
    expect(cash.lines.map((l) => l.label)).toEqual(["ค่าห้องเงินสด", "รายการอื่นๆ เงินสด", "บาร์น้ำ เงินสด"]);
    expect(cash.lines.map((l) => l.amountSatang)).toEqual([49_000, 15_000, 2_000]);
    expect(cash.totalSatang).toBe(49_000 + 15_000 + 2_000);
    expect(cash.totalLabel).toBe("รวมเงินสด");

    const transfer = grouped.groups[1]!;
    expect(transfer.lines.map((l) => l.categoryKey)).toEqual([
      "transfer_kbank",
      "transfer_icbc",
      "deposit",
      "other_transfer",
      "bar_transfer",
    ]);
    expect(transfer.lines.map((l) => l.amountSatang)).toEqual([829_000, 6_000, 5_000, 7_000, 3_000]);
    expect(transfer.totalSatang).toBe(829_000 + 6_000 + 5_000 + 7_000 + 3_000);
    expect(transfer.totalLabel).toBe("รวมเงินโอน");

    const card = grouped.groups[2]!;
    expect(card.lines.map((l) => l.categoryKey)).toEqual(["credit_kbank", "credit_icbc"]);
    expect(card.lines.map((l) => l.amountSatang)).toEqual([30_000, 20_000]);
    expect(card.totalSatang).toBe(50_000);
    expect(card.totalLabel).toBe("รวมบัตรเครดิต");

    const web = grouped.groups[3]!;
    expect(web.lines.map((l) => l.categoryKey)).toEqual(["web"]);
    expect(web.lines.map((l) => l.amountSatang)).toEqual([298_380]);
    expect(web.totalSatang).toBe(298_380);
    expect(web.totalLabel).toBe("รวมเว็บไซต์");

    expect(grouped.unclassified).toEqual([]);
    expect(grouped.grandTotalSatang).toBe(
      cash.totalSatang + transfer.totalSatang + card.totalSatang + web.totalSatang,
    );
  });

  test("a standard sub-line with no cell at all renders amountSatang null (print shows '-'), never dropped", () => {
    const categories = STANDARD_CATEGORIES;
    const income: Record<number, IncomeCell> = { 2: makeCell(2, 49_000) }; // only room_cash has data
    const grouped = groupDayIncomeForPrint({ categories, income });

    const cash = grouped.groups[0]!;
    expect(cash.lines.find((l) => l.categoryKey === "room_cash")?.amountSatang).toBe(49_000);
    expect(cash.lines.find((l) => l.categoryKey === "other_cash")?.amountSatang).toBeNull();
    expect(cash.lines.find((l) => l.categoryKey === "bar_cash")?.amountSatang).toBeNull();
    // Still present with its live/fallback label even at zero data.
    expect(cash.lines.find((l) => l.categoryKey === "other_cash")?.label).toBe("รายการอื่นๆ เงินสด");
  });

  test("falls back to the seed label when a property has no category at all for a standard key", () => {
    // Deliberately omit the web category entirely.
    const categories = STANDARD_CATEGORIES.filter((c) => c.categoryKey !== "web");
    const grouped = groupDayIncomeForPrint({ categories, income: {} });
    const web = grouped.groups[3]!.lines[0]!;
    expect(web.categoryKey).toBe("web");
    expect(web.label).toBe("เว็ปไซด์"); // fallback, not a live category
    expect(web.amountSatang).toBeNull();
    expect(web.archived).toBe(false);
  });

  test("a manager-created null-categoryKey category with money lands in the unclassified group, outside every tender total", () => {
    const categories: Category[] = [
      ...STANDARD_CATEGORIES,
      makeCategory({ id: 20, nameTh: "ค่าปรับยกเลิกห้อง", categoryKey: null, sort: 20 }),
      // A second manager category with NO cell — must not appear at all.
      makeCategory({ id: 21, nameTh: "ค่าคอมมิชชั่นพิเศษ", categoryKey: null, sort: 21 }),
    ];
    const income: Record<number, IncomeCell> = { ...STANDARD_INCOME, 20: makeCell(20, 12_345) };
    const grouped = groupDayIncomeForPrint({ categories, income });

    expect(grouped.unclassified).toEqual([
      { categoryId: 20, label: "ค่าปรับยกเลิกห้อง", amountSatang: 12_345, archived: false },
    ]);
    expect(grouped.unclassifiedTotalSatang).toBe(12_345);

    // Not counted in any of the four tender totals.
    for (const group of grouped.groups) {
      expect(group.lines.every((l) => l.categoryKey !== undefined)).toBe(true);
    }
    const tenderTotalSum = grouped.groups.reduce((sum, g) => sum + g.totalSatang, 0);
    const standardCellSum = Object.values(STANDARD_INCOME).reduce((sum, c) => sum + c.amountSatang, 0);
    expect(tenderTotalSum).toBe(standardCellSum);

    // But it IS in the grand total.
    expect(grouped.grandTotalSatang).toBe(standardCellSum + 12_345);
  });

  test("an archived null-key category referenced by this day's data still renders, marked archived", () => {
    const categories: Category[] = [
      ...STANDARD_CATEGORIES,
      makeCategory({ id: 30, nameTh: "โปรโมชั่นเก่า", categoryKey: null, sort: 30, archivedAt: "2026-06-01 00:00:00" }),
    ];
    const income: Record<number, IncomeCell> = { ...STANDARD_INCOME, 30: makeCell(30, 4_000) };
    const grouped = groupDayIncomeForPrint({ categories, income });

    expect(grouped.unclassified).toEqual([
      { categoryId: 30, label: "โปรโมชั่นเก่า", amountSatang: 4_000, archived: true },
    ]);
  });

  test("an archived STANDARD-key category referenced by this day's data still renders in its tender group, marked archived", () => {
    // Model the (server-guarded-against-in-practice, but defended here
    // anyway) case of a keyed category the day's data references but that
    // has since been archived, with no active category holding the key.
    const categories = STANDARD_CATEGORIES.map((c) =>
      c.categoryKey === "bar_cash" ? { ...c, archivedAt: "2026-06-01 00:00:00" } : c,
    );
    const grouped = groupDayIncomeForPrint({ categories, income: STANDARD_INCOME });

    const barCashLine = grouped.groups[0]!.lines.find((l) => l.categoryKey === "bar_cash")!;
    expect(barCashLine.amountSatang).toBe(2_000);
    expect(barCashLine.archived).toBe(true);
    expect(barCashLine.label).toBe("บาร์น้ำ เงินสด");
  });

  test("invariant: sum of every group total + unclassified total equals the day's รวมรายรับ (totals.incomeSatang)", () => {
    const categories: Category[] = [
      ...STANDARD_CATEGORIES,
      makeCategory({ id: 20, nameTh: "ค่าปรับยกเลิกห้อง", categoryKey: null, sort: 20 }),
      makeCategory({ id: 30, nameTh: "โปรโมชั่นเก่า", categoryKey: null, sort: 30, archivedAt: "2026-06-01 00:00:00" }),
    ];
    const income: Record<number, IncomeCell> = {
      ...STANDARD_INCOME,
      20: makeCell(20, 12_345),
      30: makeCell(30, 4_000),
    };
    const expenses: ExpenseItem[] = [];
    const totals = computeDayTotals(categories, income, expenses);

    const grouped = groupDayIncomeForPrint({ categories, income });

    expect(grouped.grandTotalSatang).toBe(totals.incomeSatang);
  });

  test("exported labels match the required Thai wording", () => {
    expect(GRAND_TOTAL_LABEL_TH).toBe("รวมรายรับทั้งวัน");
    expect(UNCLASSIFIED_GROUP_LABEL_TH).toBe("อื่นๆ (ไม่ระบุประเภท)");
    expect(UNCLASSIFIED_TOTAL_LABEL_TH).toBe("รวมอื่นๆ (ไม่ระบุประเภท)");
  });
});
