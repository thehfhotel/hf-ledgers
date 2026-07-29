import { computeDayTotals } from "../shared/totals.ts";
import type { Category, DaySheet, ExpenseItem, IncomeCell } from "../shared/types.ts";

// Realistic demo DaySheet for WP-C's standalone report rendering
// (src/client/pages/ReportPage.tsx and components/ReportSheet.tsx can
// render this with no live server). Income figures are lifted from an
// actual paper sheet (สรุปยอดรายรับโรงแรม): ค่าห้องเงินสด 490.00,
// โอน/กสิกร 8,290.00, เว็ปไซด์ 2,983.80, บาร์น้ำ เงินสด 20.00 — these four
// sum to exactly the paper's printed total, 11,783.80 baht. `totals` is
// computed via the SAME computeDayTotals() the server uses, not hardcoded.

export const FIXTURE_DATE = "2026-07-28";
export const FIXTURE_UPDATED_BY = "reception@thehfhotel.org";

const incomeCategories: Category[] = [
  { id: 1, property: "hf", kind: "income", nameTh: "มัดจำล่วงหน้า", sort: 1, isCash: false, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 2, property: "hf", kind: "income", nameTh: "ค่าห้องเงินสด", sort: 2, isCash: true, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 3, property: "hf", kind: "income", nameTh: "บัตรเครดิต/กสิกร", sort: 3, isCash: false, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 4, property: "hf", kind: "income", nameTh: "บัตรเครดิต ICBC", sort: 4, isCash: false, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 5, property: "hf", kind: "income", nameTh: "โอน/กสิกร", sort: 5, isCash: false, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 6, property: "hf", kind: "income", nameTh: "โอน ICBC", sort: 6, isCash: false, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 7, property: "hf", kind: "income", nameTh: "เว็ปไซด์", sort: 7, isCash: false, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 8, property: "hf", kind: "income", nameTh: "รายการอื่นๆ", sort: 8, isCash: true, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 9, property: "hf", kind: "income", nameTh: "บาร์น้ำ เงินสด", sort: 9, isCash: true, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 10, property: "hf", kind: "income", nameTh: "บาร์น้ำ โอน/เครดิต", sort: 10, isCash: false, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
];

const expenseCategories: Category[] = [
  { id: 101, property: "hf", kind: "expense", nameTh: "ซื้อของ/วัตถุดิบ", sort: 1, isCash: true, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 102, property: "hf", kind: "expense", nameTh: "ค่าแรงรายวัน", sort: 2, isCash: true, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 103, property: "hf", kind: "expense", nameTh: "ค่าซ่อมแซม", sort: 3, isCash: true, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 104, property: "hf", kind: "expense", nameTh: "ค่าสาธารณูปโภค", sort: 4, isCash: true, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
  { id: 105, property: "hf", kind: "expense", nameTh: "อื่นๆ", sort: 5, isCash: true, archivedAt: null, createdAt: "2026-01-01 00:00:00" },
];

const categories: Category[] = [...incomeCategories, ...expenseCategories];

const updatedAt = "2026-07-28 15:40:00";

function cell(categoryId: number, amountSatang: number): IncomeCell {
  return { categoryId, amountSatang, note: null, updatedAt, updatedBy: FIXTURE_UPDATED_BY };
}

const income: Record<number, IncomeCell> = {
  2: cell(2, 49_000), // ค่าห้องเงินสด 490.00
  5: cell(5, 829_000), // โอน/กสิกร 8,290.00
  7: cell(7, 298_380), // เว็ปไซด์ 2,983.80
  9: cell(9, 2_000), // บาร์น้ำ เงินสด 20.00
};

const expenses: ExpenseItem[] = [
  {
    id: 1,
    property: "hf",
    date: FIXTURE_DATE,
    categoryId: 101,
    note: "น้ำยาทำความสะอาด",
    amountSatang: 12_000,
    createdAt: updatedAt,
    createdBy: FIXTURE_UPDATED_BY,
    updatedAt,
    updatedBy: FIXTURE_UPDATED_BY,
  },
  {
    id: 2,
    property: "hf",
    date: FIXTURE_DATE,
    categoryId: 102,
    note: "ค่าแรงช่างทำความสะอาดสระว่ายน้ำ",
    amountSatang: 15_000,
    createdAt: updatedAt,
    createdBy: FIXTURE_UPDATED_BY,
    updatedAt,
    updatedBy: FIXTURE_UPDATED_BY,
  },
  {
    id: 3,
    property: "hf",
    date: FIXTURE_DATE,
    categoryId: 105,
    note: "ค่าจัดส่งเอกสาร",
    amountSatang: 5_000,
    createdAt: updatedAt,
    createdBy: FIXTURE_UPDATED_BY,
    updatedAt,
    updatedBy: FIXTURE_UPDATED_BY,
  },
];

export const fixtureDaySheet: DaySheet = {
  categories,
  income,
  expenses,
  note: "ฝากเงินที่ธนาคารกสิกรไทย สาขาใกล้เคียง",
  totals: computeDayTotals(categories, income, expenses),
  updatedAt,
  updatedBy: FIXTURE_UPDATED_BY,
};
