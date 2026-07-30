import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { parseReportSheet } from "./parse-report.ts";

const U = undefined;

/** Mirrors the real per-booking layout (verified against both the xls and
 *  xlsx files): a 3-row header band ending in the "ใบกับกับภาษี" anchor,
 *  then data rows, a totals row, then the sheet's own recap block. The
 *  header band here sits at rows 3-5 to prove the anchor is found by text,
 *  never a hardcoded row index. */
function buildSyntheticReportSheet(): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet([
    /* 0 */ ["รายงานรายรับของโรงแรม"],
    /* 1 */ [],
    /* 2 */ ["ประจำวันที่ 25 มีนาคม 2569"],
    /* 3 */ ["ลำดับ", "เลขที่", "ชื่อลูกค้า", "เลขที่", "จำนวน", U, "จำนวนเงิน", U, "ส่วนลด", "จำนวนเงินรับ"],
    /* 4 */ [U, U, U, U, "ห้อง", "คืน", "ก่อนหักส่วนลด", U, U, "มัดจำค่าห้อง", "เงินสด", "บัตรเครดิต"],
    /* 5 (anchor) */ ["ใบกับกับภาษี", U, U, "ห้อง", U, U, "ค่าห้อง", "อื่นๆ", U, "โอน/เครดิต", "ค่าห้อง", "กรสิกร", "ICBC", "กรสิกร", "ICBC", "/เว็บไซด์", "สด/โอน/เครดิต"],
    // Ordinary single-tender booking row.
    /* 6 */ [1, "B2603-0304", "น.ส.ธนัช แจ้งพูล", 416, 1, 1, 890, 0, 0, U, U, U, U, 890],
    // Multi-tender booking row: both deposit AND transfer-KBANK populated.
    /* 7 */ [2, "B2503-0003", "นางพรทิพย์ ศุภนภาโสตถิ์", 403, 1, 1, 890, 0, 0, 445, U, U, U, 445],
    // Zero-tender booking row (coupon/comp): discount absorbs the whole gross, no tender column populated.
    /* 8 */ [3, "B2603-0999", "บริษัท ทดสอบ จำกัด", 302, 1, 1, 500, 0, 500],
    // Guest-name overflow line: no seq, no financial data, just trailing company name text.
    /* 9 */ [U, U, "จำกัด (มหาชน)"],
    // A room with a fractional gross amount, to check satang rounding end to end.
    /* 10 */ [4, "B2603-0309", "Mr.Alexis Laignel", 414, 1, 1, 833.85, 0, 0, U, 833.85],
    // Blank pre-formatted row: seq present, nothing else.
    /* 11 */ [5],
    // Totals row: seq empty, room count/nights/gross all numeric.
    /* 12 */ [U, U, U, U, 4, 4, 3113.85, 0, 500, 445, 833.85, 0, 0, 445, 0, 890, 0],
    /* 13 */ [],
    // The sheet's own recap block, kept only for reconciliation.
    /* 14 */ [U, U, "สรุปยอดรายรับโรงแรม", U, U, "ส่วนลด", U, U, U, U, 500],
    /* 15 */ [244432, U, U, U, U, "มัดจำล่วงหน้า", U, U, U, U, 445],
    /* 16 */ [U, U, U, U, U, "ค่าห้องเงินสด", U, U, U, U, 0],
    /* 17 */ [U, U, U, U, U, U, U, "รวม", U, U, 3113.85],
  ]);
}

describe("parseReportSheet — header anchor and date", () => {
  const record = parseReportSheet("25-3-69", buildSyntheticReportSheet());

  test("finds the header band by the ใบกับกับภาษี anchor text, not a hardcoded row", () => {
    // If the anchor weren't found at all, no booking rows would ever parse.
    expect(record.bookingRows.length).toBeGreaterThan(0);
  });

  test("resolves the date from sheet name + header (majority of two)", () => {
    expect(record.dateResolution.date).toEqual({ year: 2026, month: 3, day: 25 });
  });
});

describe("parseReportSheet — row classification", () => {
  const record = parseReportSheet("25-3-69", buildSyntheticReportSheet());

  test("parses an ordinary single-tender row with all eight tender fields present", () => {
    const row = record.bookingRows.find((r) => r.bookingNo === "B2603-0304")!;
    expect(row.tenders).toEqual({
      depositSatang: 0,
      cashSatang: 0,
      creditKbankSatang: 0,
      creditIcbcSatang: 0,
      transferKbankSatang: 89000,
      transferIcbcSatang: 0,
      appWebsiteSatang: 0,
      otherSatang: 0,
    });
    expect(row.grossRoomSatang).toBe(89000);
  });

  test("a multi-tender row keeps both populated tender columns, never collapsing to one field", () => {
    const row = record.bookingRows.find((r) => r.bookingNo === "B2503-0003")!;
    expect(row.tenders.depositSatang).toBe(44500);
    expect(row.tenders.transferKbankSatang).toBe(44500);
    expect(row.tenders.cashSatang).toBe(0);
  });

  test("a zero-tender coupon/comp row round-trips losslessly via the discount field", () => {
    const row = record.bookingRows.find((r) => r.bookingNo === "B2603-0999")!;
    expect(row.discountSatang).toBe(50000);
    expect(Object.values(row.tenders).every((v) => v === 0)).toBe(true);
  });

  test("appends a guest-name overflow line to the previous booking row", () => {
    const row = record.bookingRows.find((r) => r.bookingNo === "B2603-0999")!;
    expect(row.guestName).toBe("บริษัท ทดสอบ จำกัด จำกัด (มหาชน)");
  });

  test("rounds a fractional gross amount to satang without floating drift", () => {
    const row = record.bookingRows.find((r) => r.bookingNo === "B2603-0309")!;
    expect(row.grossRoomSatang).toBe(83385);
    expect(row.tenders.cashSatang).toBe(83385);
  });

  test("skips a blank pre-formatted row (seq present, nothing else) without emitting a booking", () => {
    expect(record.bookingRows.some((r) => r.seq === 5)).toBe(false);
    expect(record.skippedBlankRowCount).toBe(1);
  });

  test("stops at the totals row and captures its aggregates separately", () => {
    expect(record.totalsRow).not.toBeNull();
    expect(record.totalsRow?.roomCount).toBe(4);
    expect(record.totalsRow?.grossRoomSatang).toBe(311385);
  });

  test("captures the sheet's own recap block for reconciliation, kept separate from booking rows", () => {
    expect(record.ownSummaryBlock.lines.length).toBeGreaterThan(0);
    expect(record.ownSummaryBlock.reconciliationTotalSatang).toBe(311385);
  });
});

describe("parseReportSheet — property classification", () => {
  test("classifies HF with confidence when room majority and bare title agree", () => {
    const record = parseReportSheet("25-3-69", buildSyntheticReportSheet());
    expect(record.property).toBe("hf");
    expect(record.quarantineReason).toBeNull();
  });

  test("quarantines the sheet when room majority and title disagree", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["รายงานรายรับของโรงแรม (Hf -Ville)"],
      [],
      ["ประจำวันที่ 1 มีนาคม 2568"],
      ["ลำดับ", "เลขที่", "ชื่อลูกค้า"],
      [],
      ["ใบกับกับภาษี"],
      [1, "B2503-0001", "น.ส.สุพัตรา พวงงาม", 416, 1, 1, 890, 0, 0, U, 890],
      [2, "B2503-0002", "นายทวีศักดิ์ สังข์ทอง", 404, 1, 1, 890, 0, 0, U, 890],
    ]);
    const record = parseReportSheet("1-3-68", ws);
    expect(record.property).toBeNull();
    expect(record.quarantineReason).toBe("room-title-mismatch");
  });

  test("confidently classifies from room majority alone when the title is missing", () => {
    // Real case: sheet "16-3-69" has no A1 title row at all, but its ten
    // booking rows are unambiguously Harbour Front.
    const ws = XLSX.utils.aoa_to_sheet([
      [],
      [],
      ["ประจำวันที่ 16 มีนาคม 2569"],
      ["ลำดับ", "เลขที่", "ชื่อลูกค้า"],
      [],
      ["ใบกับกับภาษี"],
      [1, "B2603-0001", "guest one", 507, 1, 1, 890, 0, 0, U, 890],
      [2, "B2603-0002", "guest two", 412, 1, 1, 890, 0, 0, U, 890],
    ]);
    const record = parseReportSheet("16-3-69", ws);
    expect(record.property).toBe("hf");
    expect(record.quarantineReason).toBeNull();
  });

  test("confidently classifies from a bare title alone when there is no usable room signal", () => {
    // Real case: sheets "21-06-69"/"22-06-69"/"27-06-69" record a single
    // informal cash note as a booking row with no room number at all.
    const ws = XLSX.utils.aoa_to_sheet([
      ["รายงานรายรับของโรงแรม"],
      [],
      ["ประจำวันที่ 21 มิถุนายน 2569"],
      ["ลำดับ", "เลขที่", "ชื่อลูกค้า"],
      [],
      ["ใบกับกับภาษี"],
      [U, U, "แม่อ้อยคียร์ 21/06/69", U, U, U, U, U, U, U, 500],
    ]);
    const record = parseReportSheet("21-06-69", ws);
    expect(record.property).toBe("hf");
    expect(record.quarantineReason).toBeNull();
  });
});

describe("parseReportSheet — totals-row detection edge cases", () => {
  test("does not mistake a minimal-data booking row for the totals row (real case: a monthly-rate 'รายเดือน' booking with a room and tender but no booking-no or guest name)", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["รายงานรายรับของโรงแรม"],
      [],
      ["ประจำวันที่ 20 กันยายน 2568"],
      ["ลำดับ", "เลขที่", "ชื่อลูกค้า"],
      [],
      ["ใบกับกับภาษี"],
      // A minimal booking: seq present, no booking-no, no guest, but a real
      // room number and a real tender amount (column Q = "other").
      [1, U, U, 203, 1, 1, 250, 0, 0, U, U, U, U, U, U, U, 250, "รายเดือน"],
      // The real totals row: no booking-no, no guest, AND no room either.
      [U, U, U, U, 1, 1, 250, 0, 0, U, U, U, U, U, U, U, 250],
    ]);
    const record = parseReportSheet("20-9-68", ws);
    expect(record.bookingRows).toHaveLength(1);
    expect(record.bookingRows[0]).toMatchObject({ roomRaw: "203", grossRoomSatang: 25000 });
    expect(record.totalsRow).not.toBeNull();
    expect(record.totalsRow?.grossRoomSatang).toBe(25000);
  });

  test("does not mistake the first booking row for the totals row on a sheet with no seq column at all", () => {
    // Real case: sheets "5-07-69" through "28-07-69" drop the seq column
    // entirely for every row, including real bookings.
    const ws = XLSX.utils.aoa_to_sheet([
      ["รายงานรายรับของโรงแรม"],
      [],
      ["ประจำวันที่ 5 กรกฎาคม 2569"],
      ["ลำดับ", "เลขที่", "ชื่อลูกค้า"],
      [],
      ["ใบกับกับภาษี"],
      [U, "B2607-0083", "guest one", 512, 1, 1, 750, 0, 0, U, U, U, U, 750],
      [U, "B2607-0084", "guest two", 510, 1, 1, 1490, 0, 0, U, U, U, U, 1490],
      // The real totals row: no booking-no, no guest, no room, none of them.
      [U, U, U, U, 2, 2, 2240, 0, 0, U, U, U, U, 2240],
    ]);
    const record = parseReportSheet("5-07-69", ws);
    expect(record.bookingRows).toHaveLength(2);
    expect(record.bookingRows.every((r) => r.missingSeqAnomaly)).toBe(true);
    expect(record.totalsRow).not.toBeNull();
    expect(record.totalsRow?.roomCount).toBe(2);
  });
});
