import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { parseSummarySheet } from "./parse-summary.ts";

const U = undefined;

/** Mirrors the real layout of hfSummary sheet "16-4-68" (itemized other
 *  income via column D) plus a cash-block section and one unknown label,
 *  to exercise the full label-driven pipeline end to end. */
function buildSyntheticSummarySheet(): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet([
    /* 0 */ ["สรุปยอดรายรับโรงแรม", U, "มัดจำล่วงหน้า", U, U, U, 0],
    /* 1 */ [244090, U, "ค่าห้องเงินสด", U, U, U, 4160],
    /* 2 */ [U, U, "บัตรเครดิต /กสิกร", U, U, U, 790],
    /* 3 */ [U, U, "บัตรเครดิต ICBC", U, U, U, 0],
    /* 4 */ [U, U, "โอน/กสิกร", U, U, U, 5151],
    /* 5 */ [U, U, "โอน ICBC", U, U, U, 0],
    /* 6 */ [U, U, "เว็ปไซด์", "Agoda", U, U, 890.53],
    /* 7 */ [U, U, "รายการ อื่นๆ", "รับรองแขก", U, U, 2580],
    /* 8 */ [U, U, U, "ค่าปรับแก้วลูกค้า", U, U, 50],
    /* 9 */ [U, U, "บาร์น้ำ เงินสด", U, U, U, 120],
    /* 10 */ [U, U, "บาร์น้ำ โอน/เครดิต", U, U, U, 0],
    /* 11 */ [U, U, U, U, "รวม", U, 13641.53],
    /* 12 */ [],
    /* 13 */ ["**หมายเหตุ", U, "รายได้โรงแรมเงินสด", U, U, U, 4160],
    /* 14 */ [U, U, "รายการอื่นๆเงินสด", U, U, U, 0],
    /* 15 */ [U, U, "บาร์น้ำเงินสด", U, U, U, 120],
    /* 16 */ [U, U, "สรุป เงินสดน้ำฝากเข้าบัญชี", U, U, U, 4280],
    /* 17 */ [U, U, "ยอดพิศดารแปลกใหม่", U, U, U, 999],
  ]);
}

describe("parseSummarySheet", () => {
  const ws = buildSyntheticSummarySheet();
  const record = parseSummarySheet("16-4-68", ws, "hf");

  test("resolves the date from the sheet name + BE date cell", () => {
    expect(record.dateResolution.date).toEqual({ year: 2025, month: 4, day: 16 });
    expect(record.dateResolution.unresolved).toBe(false);
  });

  test("reads every main-block category at its fixed column, not the last populated cell", () => {
    expect(record.categories.depositAdvance).toBe(0);
    expect(record.categories.roomCash).toBe(416000);
    expect(record.categories.creditKbank).toBe(79000);
    expect(record.categories.creditIcbc).toBe(0);
    expect(record.categories.transferKbank).toBe(515100);
    expect(record.categories.transferIcbc).toBe(0);
    expect(record.categories.website).toBe(89053);
    expect(record.categories.otherItems).toBe(258000);
    expect(record.categories.waterBarCash).toBe(12000);
    expect(record.categories.waterBarTransferCredit).toBe(0);
  });

  test("captures the printed grand total from the 'รวม' row", () => {
    expect(record.printedTotalSatang).toBe(1364153);
  });

  test("itemizes the other-income continuation rows, keeping verbatim text and inferring tender", () => {
    expect(record.otherIncomeItems).toHaveLength(2);
    expect(record.otherIncomeItems[0]).toMatchObject({
      text: "รับรองแขก",
      amountSatang: 258000,
    });
    expect(record.otherIncomeItems[1]).toMatchObject({
      text: "ค่าปรับแก้วลูกค้า",
      amountSatang: 5000,
    });
  });

  test("parses the cash block below the **หมายเหตุ marker", () => {
    expect(record.cashBlock.hotelRevenueCash).toBe(416000);
    expect(record.cashBlock.otherItemsCash).toBe(0);
    expect(record.cashBlock.waterBarCashBlock).toBe(12000);
    expect(record.cashBlock.bankedTotal).toBe(428000);
  });

  test("the cash-block water-bar line never leaks into the main-block category", () => {
    // "บาร์น้ำเงินสด" (cash block) and "บาร์น้ำ เงินสด" (main block) strip to
    // the same text — they must resolve through separate, section-scoped tables.
    expect(record.categories.waterBarCash).toBe(12000); // from row 9, main block
    expect(record.cashBlock.waterBarCashBlock).toBe(12000); // from row 15, cash block
  });

  test("reports an unrecognized label with a non-zero amount, never silently drops it", () => {
    expect(record.unknownLabels).toHaveLength(1);
    expect(record.unknownLabels[0]).toMatchObject({ label: "ยอดพิศดารแปลกใหม่", amountSatang: 99900 });
  });

  test("tags a below-marker unknown label as section 'cashBlock', not 'main'", () => {
    // Row 17 sits below the **หมายเหตุ marker (row 13) — see
    // types.ts UnknownLabelEntry.section: a cashBlock label is always a
    // restatement of money already counted above, never new income.
    expect(record.unknownLabels[0]!.section).toBe("cashBlock");
  });
});

describe("parseSummarySheet — unknown-label section tagging", () => {
  test("an unrecognized label ABOVE the notes marker is tagged section 'main'", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["สรุปยอดรายรับโรงแรม", U, "มัดจำล่วงหน้า", U, U, U, 0],
      [244075, U, "ค่าห้องเงินสด", U, U, U, 850],
      [U, U, "รายการอื่นๆ ค่าคีย์การ์ดหาย(เงินสด)R.413", U, U, U, 100],
      [U, U, "บาร์น้ำ เงินสด", U, U, U, 100],
      [U, U, U, U, "รวม", U, 1050],
      [],
      ["**หมายเหตุ", U, "รายได้โรงแรมเงินสด", U, U, U, 850],
      [U, U, "รายการอื่นๆ ค่าคีย์การ์ดหาย(เงินสด)R.413", U, U, U, 100],
      [U, U, "บาร์น้ำเงินสด", U, U, U, 100],
      [U, U, "สรุปเงินสดฝากเข้าบัญชี", U, U, U, 950],
    ]);
    const record = parseSummarySheet("5-7-69", ws, "hf");

    // The real-world pattern this mirrors (verified sheet "5-7-69" of the HF
    // summary workbook): the SAME text/amount appears once above the marker
    // (a real, uncaptured item — the "7th layout variant") and once below it
    // (a cash-portion annotation of that same item) — they must be
    // distinguishable by section, not merely deduplicated by text, since two
    // genuinely different items could coincidentally share text or amount.
    expect(record.unknownLabels).toHaveLength(2);
    const mainLabel = record.unknownLabels.find((u) => u.section === "main");
    const cashBlockLabel = record.unknownLabels.find((u) => u.section === "cashBlock");
    expect(mainLabel).toMatchObject({ label: "รายการอื่นๆ ค่าคีย์การ์ดหาย(เงินสด)R.413", amountSatang: 10000 });
    expect(cashBlockLabel).toMatchObject({ label: "รายการอื่นๆ ค่าคีย์การ์ดหาย(เงินสด)R.413", amountSatang: 10000 });
  });
});

describe("parseSummarySheet — no itemization", () => {
  test("a lump-sum 'รายการ อื่นๆ' with no D text yields a category total but zero itemized entries", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["สรุปยอดรายรับโรงแรม", U, "มัดจำล่วงหน้า", U, U, U, 1000],
      [244075, U, "ค่าห้องเงินสด", U, U, U, 4853],
      [U, U, "รายการ อื่นๆ", U, U, U, 1290],
      [U, U, "บาร์น้ำ เงินสด", U, U, U, 330],
    ]);
    const record = parseSummarySheet("1", ws, "hf");
    expect(record.categories.otherItems).toBe(129000);
    expect(record.otherIncomeItems).toHaveLength(0);
  });
});

describe("parseSummarySheet — continuation row with an amount but no text", () => {
  test("a non-zero continuation row with no text anywhere is kept, not dropped as a blank spacer", () => {
    // Mirrors the real layout of HF summary sheet "31-8-2568": row 7 is a
    // normal itemized entry, row 8 carries only an amount (2,280) with
    // nothing in any column, row 9 is a genuinely blank spacer (amount 0),
    // then the next recognized category starts.
    const ws = XLSX.utils.aoa_to_sheet([
      ["สรุปยอดรายรับโรงแรม", U, "มัดจำล่วงหน้า", U, U, U, 0],
      [244227, U, "ค่าห้องเงินสด", U, U, U, 1890.75],
      [U, U, "รายการ อื่นๆ", "ค่าซื้ออาหารเช้าเพิ่ม(โอนเงิน)", U, U, 200],
      [U, U, U, U, U, U, 2280],
      [U, U, U, U, U, U, 0],
      [U, U, "บาร์น้ำ เงินสด", U, U, U, 0],
      [U, U, U, U, "รวม", U, 17595.6],
    ]);
    const record = parseSummarySheet("31-8-2568", ws, "hf");

    expect(record.otherIncomeItems).toHaveLength(2);
    expect(record.otherIncomeItems[0]).toMatchObject({ text: "ค่าซื้ออาหารเช้าเพิ่ม(โอนเงิน)", amountSatang: 20000 });
    expect(record.otherIncomeItems[1]).toMatchObject({ text: "", amountSatang: 228000 });

    // The genuinely blank spacer row (amount 0, no text) never becomes an
    // item, and the scan still finds the next recognized category correctly.
    expect(record.categories.waterBarCash).toBe(0);
  });
});
