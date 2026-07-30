// Parse a "รายงานรายรับโรงแรม(รายวัน)" per-booking workbook into per-day
// booking rows, keeping the sheet's own bottom summary block only for
// reconciliation (it disagrees with the rows above it on ~35% of sheets —
// the office hand-adjusts it — so it is never the source of truth here).
//
// Layout facts (verified against the real files, not assumed):
// - Locate the header band by finding the cell containing "ใบกับกับภาษี";
//   data starts on the row after. Never key on "ลำดับ" (deleted from column
//   A on ~42% of sheets) and never hardcode a row index (xls puts the band
//   at different rows than xlsx).
// - Columns (0-indexed): c0 seq, c1 booking/tax-invoice no, c2 guest name,
//   c3 room no, c4 room count, c5 nights, c6 gross room, c7 gross other,
//   c8 discount, c9 deposit, c10 cash, c11 credit KBANK, c12 credit ICBC,
//   c13 transfer KBANK, c14 transfer ICBC, c15 app/website, c16 other,
//   c17 remark.
// - Stop at the totals row (c0 empty while c4/c5/c6 are numeric) and at the
//   sheet's own recap block, found via "สรุปยอดรายรับ" in column C.
// - A row with a seq number but no guest and no non-zero gross/discount/
//   tender is a blank pre-formatted row — skip it (an explicit "0" does not
//   count as carrying financial data). A row with no seq AND no guest AND
//   no financial data is a stray artifact — skip it but keep it visible for
//   diagnostics. A row with no seq but real guest text and no financial
//   data is a guest-name overflow line — append it to the previous booking.
//   The same overflow pattern applies to a giant multi-room booking whose
//   room list wraps onto following rows (verified real case: one booking
//   spanning 16 rooms across 4 lines of concatenated room numbers) and to a
//   remark that wraps onto a following row — both append to the previous
//   booking rather than being lost as unclassified noise.
// - 216 of 4,720 rows populate two or three tender columns and 392 populate
//   none (coupon/comp, with the amount in c8 discount) — every row carries
//   all eight tender amounts, never a single collapsed tender field.

import * as XLSX from "xlsx";
import type {
  BookingRow,
  BookingTenders,
  OwnSummaryBlock,
  OwnSummaryLine,
  ReportSheetRecord,
  ReportTotalsRow,
  ReportWorkbookResult,
} from "./types.ts";
import { toSatang } from "./types.ts";
import { resolveSheetDate } from "./sheet-date.ts";
import { classifyRoomCell, classifySheetProperty } from "./classify.ts";
import { stripWhitespace } from "./normalize.ts";
import {
  decodeRange,
  cellAt,
  isPresent,
  isNumericCell,
  hasNonZeroValue,
  numberOrNull,
  textOrEmpty,
  textOrNull,
} from "./xlsx-cells.ts";

const SEQ = 0;
const BOOKING_NO = 1;
const GUEST = 2;
const ROOM = 3;
const ROOM_COUNT = 4;
const NIGHTS = 5;
const GROSS_ROOM = 6;
const GROSS_OTHER = 7;
const DISCOUNT = 8;
const DEPOSIT = 9;
const CASH = 10;
const CREDIT_KBANK = 11;
const CREDIT_ICBC = 12;
const TRANSFER_KBANK = 13;
const TRANSFER_ICBC = 14;
const APP_WEBSITE = 15;
const OTHER = 16;
const REMARK = 17;
const LAST_DATA_COL = REMARK;

const TENDER_COLS = [DEPOSIT, CASH, CREDIT_KBANK, CREDIT_ICBC, TRANSFER_KBANK, TRANSFER_ICBC, APP_WEBSITE, OTHER];

const HEADER_ANCHOR_TEXT = "ใบกับกับภาษี";
const OWN_SUMMARY_MARKER_COL = 2; // C
const OWN_SUMMARY_MARKER_TEXT = "สรุปยอดรายรับ";
const OWN_SUMMARY_LABEL_COL_START = 3; // D
const OWN_SUMMARY_LABEL_COL_END = 9; // J
const OWN_SUMMARY_AMOUNT_COL_START = 3; // D — excludes column C, home of the stray BE date cell
const OWN_SUMMARY_AMOUNT_COL_END = 14; // O
const GRAND_TOTAL_TEXT = "รวม";

function findHeaderAnchorRow(ws: XLSX.WorkSheet): number | null {
  const range = decodeRange(ws);
  for (let row = range.s.r; row <= range.e.r; row++) {
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = cellAt(ws, row, col);
      if (cell != null && typeof cell.v === "string" && cell.v.trim() === HEADER_ANCHOR_TEXT) {
        return row;
      }
    }
  }
  return null;
}

function findOwnSummaryMarkerRow(ws: XLSX.WorkSheet, fromRow: number): number | null {
  const range = decodeRange(ws);
  for (let row = fromRow; row <= range.e.r; row++) {
    const cell = cellAt(ws, row, OWN_SUMMARY_MARKER_COL);
    if (cell != null && typeof cell.v === "string" && cell.v.includes(OWN_SUMMARY_MARKER_TEXT)) {
      return row;
    }
  }
  return null;
}

function buildTenders(ws: XLSX.WorkSheet, row: number): BookingTenders {
  return {
    depositSatang: toSatang(numberOrNull(cellAt(ws, row, DEPOSIT)) ?? undefined),
    cashSatang: toSatang(numberOrNull(cellAt(ws, row, CASH)) ?? undefined),
    creditKbankSatang: toSatang(numberOrNull(cellAt(ws, row, CREDIT_KBANK)) ?? undefined),
    creditIcbcSatang: toSatang(numberOrNull(cellAt(ws, row, CREDIT_ICBC)) ?? undefined),
    transferKbankSatang: toSatang(numberOrNull(cellAt(ws, row, TRANSFER_KBANK)) ?? undefined),
    transferIcbcSatang: toSatang(numberOrNull(cellAt(ws, row, TRANSFER_ICBC)) ?? undefined),
    appWebsiteSatang: toSatang(numberOrNull(cellAt(ws, row, APP_WEBSITE)) ?? undefined),
    otherSatang: toSatang(numberOrNull(cellAt(ws, row, OTHER)) ?? undefined),
  };
}

function buildBookingRow(ws: XLSX.WorkSheet, row: number, seqPresent: boolean): BookingRow {
  const roomRaw = textOrEmpty(cellAt(ws, row, ROOM));
  const roomClassification = classifyRoomCell(roomRaw);
  return {
    rowIndex: row,
    seq: seqPresent ? numberOrNull(cellAt(ws, row, SEQ)) : null,
    bookingNo: textOrNull(cellAt(ws, row, BOOKING_NO)),
    guestName: textOrEmpty(cellAt(ws, row, GUEST)),
    roomRaw,
    roomTokens: roomClassification.tokens,
    property: roomClassification.agreedProperty,
    roomCount: numberOrNull(cellAt(ws, row, ROOM_COUNT)),
    nights: numberOrNull(cellAt(ws, row, NIGHTS)),
    grossRoomSatang: toSatang(numberOrNull(cellAt(ws, row, GROSS_ROOM)) ?? undefined),
    grossOtherSatang: toSatang(numberOrNull(cellAt(ws, row, GROSS_OTHER)) ?? undefined),
    discountSatang: toSatang(numberOrNull(cellAt(ws, row, DISCOUNT)) ?? undefined),
    tenders: buildTenders(ws, row),
    remark: textOrNull(cellAt(ws, row, REMARK)),
    missingSeqAnomaly: !seqPresent,
  };
}

function dumpRowForDiagnostics(ws: XLSX.WorkSheet, row: number): string {
  const parts: string[] = [];
  for (let col = 0; col <= LAST_DATA_COL; col++) {
    const cell = cellAt(ws, row, col);
    if (isPresent(cell)) parts.push(`${XLSX.utils.encode_col(col)}=${JSON.stringify(cell!.v)}`);
  }
  return parts.join(" | ");
}

interface RowScanResult {
  bookingRows: BookingRow[];
  totalsRow: ReportTotalsRow | null;
  totalsRowIndex: number | null;
  skippedBlankRowCount: number;
  unclassifiedRows: Array<{ rowIndex: number; raw: string }>;
}

function scanBookingRows(ws: XLSX.WorkSheet, dataStartRow: number): RowScanResult {
  const range = decodeRange(ws);
  const bookingRows: BookingRow[] = [];
  const unclassifiedRows: Array<{ rowIndex: number; raw: string }> = [];
  let totalsRow: ReportTotalsRow | null = null;
  let totalsRowIndex: number | null = null;
  let skippedBlankRowCount = 0;
  let lastBookingRow: BookingRow | null = null;

  for (let row = dataStartRow; row <= range.e.r; row++) {
    const guestColumnText = textOrEmpty(cellAt(ws, row, GUEST));
    if (guestColumnText.includes(OWN_SUMMARY_MARKER_TEXT)) {
      // Defensive stop: the sheet's own recap block shares column C (GUEST)
      // with the marker text. A missing/malformed totals row (verified real
      // case: room-count/nights on the totals row stored as TEXT, not
      // numbers) would otherwise let this loop walk straight into the recap
      // block and misparse its label/amount cells as a fabricated booking.
      break;
    }

    const seqPresent = isPresent(cellAt(ws, row, SEQ));
    const hasBookingNo = isPresent(cellAt(ws, row, BOOKING_NO));
    const guestText = guestColumnText;
    const hasGuestText = guestText !== "";
    const hasRoomText = textOrEmpty(cellAt(ws, row, ROOM)) !== "";
    const roomCountCell = cellAt(ws, row, ROOM_COUNT);
    const nightsCell = cellAt(ws, row, NIGHTS);
    const grossRoomCell = cellAt(ws, row, GROSS_ROOM);
    const grossOtherCell = cellAt(ws, row, GROSS_OTHER);
    const discountCell = cellAt(ws, row, DISCOUNT);

    // The totals row is identified by the ABSENCE of booking number, guest
    // name, AND room number — never by the absence of a seq number alone.
    // Verified real cases pulling in different directions:
    //  - A whole batch of recent sheets (5-07-69 .. 28-07-69) drop the seq
    //    column entirely for every row, including real bookings, so
    //    "!seqPresent" alone fired on the very first booking row and
    //    fabricated a bogus totals row from it.
    //  - Some minimal-data bookings (verified: a "รายเดือน"/monthly-rate
    //    row with a real room number and tender but no booking number or
    //    guest name) still have a seq AND a room — so "no booking-no/guest"
    //    alone is not enough either. The real totals row's room cell is
    //    always blank (or a lone placeholder space); a genuine booking row
    //    always carries a room number. Requiring all three absent is what
    //    correctly separates the totals row from every booking-row variant
    //    seen in the real data.
    const isTotalsRowShape =
      !hasBookingNo &&
      !hasGuestText &&
      !hasRoomText &&
      isNumericCell(roomCountCell) &&
      isNumericCell(nightsCell) &&
      isNumericCell(grossRoomCell);
    if (isTotalsRowShape) {
      totalsRow = {
        roomCount: numberOrNull(roomCountCell),
        nights: numberOrNull(nightsCell),
        grossRoomSatang: toSatang(numberOrNull(grossRoomCell) ?? undefined),
        grossOtherSatang: toSatang(numberOrNull(grossOtherCell) ?? undefined),
        discountSatang: toSatang(numberOrNull(discountCell) ?? undefined),
        tenders: buildTenders(ws, row),
      };
      totalsRowIndex = row;
      break;
    }

    // An explicit "0" does not count as carrying financial data — only a
    // real non-zero amount does. This matters for real pre-formatted rows
    // that write 0 into gross-other/discount with nothing else on the row.
    const hasGrossOrTenderData =
      hasNonZeroValue(grossRoomCell) ||
      hasNonZeroValue(grossOtherCell) ||
      hasNonZeroValue(discountCell) ||
      TENDER_COLS.some((col) => hasNonZeroValue(cellAt(ws, row, col)));

    if (seqPresent) {
      // A real seq number is the strongest signal of a distinct booking-table
      // row. Build it even when the guest-name cell is blank/whitespace-only
      // (verified real case: a genuine booking with room + gross + tender
      // data but an empty guest field) — never lose real financial data to
      // an over-eager "no guest, so unclassified" rule.
      if (hasGuestText || hasGrossOrTenderData) {
        const bookingRow = buildBookingRow(ws, row, seqPresent);
        bookingRows.push(bookingRow);
        lastBookingRow = bookingRow;
      } else {
        skippedBlankRowCount++;
      }
      continue;
    }

    if (hasGuestText && hasGrossOrTenderData) {
      // No seq, but real financial data — an anomaly, not silently folded
      // into the previous row. Still recorded as its own booking row.
      const bookingRow = buildBookingRow(ws, row, seqPresent);
      bookingRows.push(bookingRow);
      lastBookingRow = bookingRow;
      continue;
    }

    if (hasGuestText && lastBookingRow) {
      // Guest-name overflow line (long company names wrap onto the next row).
      lastBookingRow.guestName = `${lastBookingRow.guestName} ${guestText}`.trim();
      continue;
    }

    if (!hasGrossOrTenderData && lastBookingRow) {
      const roomContinuationText = textOrEmpty(cellAt(ws, row, ROOM));
      if (roomContinuationText) {
        // Room-list overflow: a giant multi-room booking's room numbers
        // wrap onto a following row (verified real case: one booking
        // spanning 16 rooms across 4 lines of concatenated room numbers).
        lastBookingRow.roomRaw = `${lastBookingRow.roomRaw},${roomContinuationText}`;
        const reclassified = classifyRoomCell(lastBookingRow.roomRaw);
        lastBookingRow.roomTokens = reclassified.tokens;
        lastBookingRow.property = reclassified.agreedProperty;
        continue;
      }

      const remarkContinuationText = textOrEmpty(cellAt(ws, row, REMARK));
      if (remarkContinuationText) {
        // Remark overflow: a long note wraps onto a following row.
        lastBookingRow.remark = lastBookingRow.remark
          ? `${lastBookingRow.remark} ${remarkContinuationText}`
          : remarkContinuationText;
        continue;
      }
    }

    // No guest name, and either no seq + no data (stray artifact row) or the
    // rare anomaly of seq + data but no guest — never silently drop either.
    unclassifiedRows.push({ rowIndex: row, raw: dumpRowForDiagnostics(ws, row) });
  }

  return { bookingRows, totalsRow, totalsRowIndex, skippedBlankRowCount, unclassifiedRows };
}

function parseOwnSummaryBlock(ws: XLSX.WorkSheet, searchFromRow: number): OwnSummaryBlock {
  const range = decodeRange(ws);
  const markerRow = findOwnSummaryMarkerRow(ws, searchFromRow);
  const lines: OwnSummaryLine[] = [];
  let reconciliationTotalSatang: number | null = null;
  if (markerRow === null) return { lines, reconciliationTotalSatang };

  for (let row = markerRow; row <= range.e.r; row++) {
    const labelParts: string[] = [];
    for (let col = OWN_SUMMARY_LABEL_COL_START; col <= OWN_SUMMARY_LABEL_COL_END; col++) {
      const text = textOrEmpty(cellAt(ws, row, col));
      if (text) labelParts.push(text);
    }
    const label = labelParts.join(" ").trim();
    if (!label) continue;

    let amount: number | null = null;
    for (let col = OWN_SUMMARY_AMOUNT_COL_END; col >= OWN_SUMMARY_AMOUNT_COL_START; col--) {
      const value = numberOrNull(cellAt(ws, row, col));
      if (value !== null) {
        amount = value;
        break;
      }
    }
    const amountSatang = amount === null ? null : toSatang(amount);

    if (stripWhitespace(label) === GRAND_TOTAL_TEXT) {
      reconciliationTotalSatang = amountSatang;
      break;
    }

    lines.push({ label, amountSatang, rowIndex: row });
  }

  return { lines, reconciliationTotalSatang };
}

/** Parse a single already-loaded worksheet. Exported separately from the
 *  workbook-level function so it can be unit tested without disk I/O. */
export function parseReportSheet(sheetName: string, ws: XLSX.WorkSheet): ReportSheetRecord {
  const dateResolution = resolveSheetDate({ sheetName, worksheet: ws, includeHeader: true });
  const anchorRow = findHeaderAnchorRow(ws);

  if (anchorRow === null) {
    return {
      sheetName,
      dateResolution,
      property: null,
      quarantineReason: "no-signal",
      quarantineDetail: `header anchor "${HEADER_ANCHOR_TEXT}" not found`,
      bookingRows: [],
      totalsRow: null,
      ownSummaryBlock: { lines: [], reconciliationTotalSatang: null },
      skippedBlankRowCount: 0,
      unclassifiedRows: [],
    };
  }

  const scan = scanBookingRows(ws, anchorRow + 1);
  const searchFromRow = scan.totalsRowIndex !== null ? scan.totalsRowIndex + 1 : anchorRow + 1;
  const ownSummaryBlock = parseOwnSummaryBlock(ws, searchFromRow);

  const a1Text = textOrEmpty(cellAt(ws, 0, 0));
  const roomRawValues = scan.bookingRows.map((row) => row.roomRaw);
  const classification = classifySheetProperty(a1Text, roomRawValues);

  return {
    sheetName,
    dateResolution,
    property: classification.property,
    quarantineReason: classification.quarantineReason,
    quarantineDetail: classification.quarantineReason ? classification.detail : null,
    bookingRows: scan.bookingRows,
    totalsRow: scan.totalsRow,
    ownSummaryBlock,
    skippedBlankRowCount: scan.skippedBlankRowCount,
    unclassifiedRows: scan.unclassifiedRows,
  };
}

export function parseReportWorkbook(filePath: string): ReportWorkbookResult {
  const workbook = XLSX.readFile(filePath, { cellNF: true, cellDates: false });
  const days: ReportSheetRecord[] = [];
  const dateFailures: ReportWorkbookResult["dateFailures"] = [];
  const quarantinedSheets: ReportWorkbookResult["quarantinedSheets"] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const record = parseReportSheet(sheetName, worksheet);
    days.push(record);
    if (record.dateResolution.unresolved) {
      dateFailures.push({ sheetName, dateResolution: record.dateResolution });
    }
    if (record.quarantineReason) {
      quarantinedSheets.push({
        sheetName,
        reason: record.quarantineReason,
        detail: record.quarantineDetail ?? "",
      });
    }
  }

  return {
    filePath,
    sheetsParsed: workbook.SheetNames.length,
    days,
    dateFailures,
    quarantinedSheets,
  };
}
