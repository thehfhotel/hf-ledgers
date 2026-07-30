// Parse a "สรุปยอด(รายวัน)" summary workbook into per-day category records.
//
// Layout facts (verified against the real files, not assumed):
// - Label lives in column C (index 2); amount in column G (index 6) — a
//   FIXED column, never "the last populated cell" (that silently reads
//   zeros or a stray remark string on this data).
// - The row grid is NOT fixed: 32 distinct label-block variants exist, and
//   the modal sheet has only eight rows with no water-bar rows at all. We
//   therefore key on normalized label text everywhere, never row position.
// - Below a `**หมายเหตุ` marker (column A) sits a second, cash-only block
//   using its own label set — see normalize.ts for why that table must stay
//   separate from the main category table.
// - "รายการ อื่นๆ" may be followed by up to four continuation rows with a
//   free-text description (column C or D) and its own amount in column G.
// - An unrecognized label's `section` matters, not just its position: a
//   main-block unknown label can be new income (the "7th layout variant" —
//   the sheet omits the "รายการ อื่นๆ" label entirely and writes the item
//   description directly in its place). A cash-block unknown label is always
//   a restatement of an amount already counted in the main block (the office
//   annotating "how much of the total was cash") — verified against real
//   sheets via the importer's grand-total-vs-printed-รวม reconciliation:
//   folding a cash-block label on top of its main-block counterpart
//   double-counts real money by exactly that amount, every time. See
//   scripts/import-xls/import.ts for the consumer of this distinction.

import * as XLSX from "xlsx";
import type {
  OtherIncomeItem,
  PropertyCode,
  SummaryCategoryKey,
  CashBlockKey,
  SummaryDayRecord,
  SummaryWorkbookResult,
  UnknownLabelEntry,
} from "./types.ts";
import { toSatang } from "./types.ts";
import { resolveSheetDate } from "./sheet-date.ts";
import { resolveCategoryLabel, resolveCashBlockLabel, stripWhitespace, inferIsCashFromFreeText } from "./normalize.ts";
import { decodeRange, cellAt, cellAddress, numberOrNull, textOrEmpty } from "./xlsx-cells.ts";

const LABEL_COL = 2; // C
const AMOUNT_COL = 6; // G
const OTHER_ITEM_TEXT_COL = 3; // D
const GRAND_TOTAL_LABEL_COL = 4; // E, e.g. "E12=รวม"
const NOTES_MARKER_COL = 0; // A — usually "**หมายเหตุ", but a real variant
// (verified: sheet "1-1-69" of the Ville summary workbook) writes it as bare
// "หมายเหตุ" with no leading asterisks. Match the core Thai word only.
const NOTES_MARKER_TEXT = "หมายเหตุ";
const GRAND_TOTAL_TEXT = "รวม";
const MAX_OTHER_INCOME_CONTINUATION_ROWS = 4;

/** Parse a single already-loaded worksheet. Exported separately from the
 *  workbook-level function so it can be unit tested without disk I/O. */
export function parseSummarySheet(sheetName: string, ws: XLSX.WorkSheet, property: PropertyCode): SummaryDayRecord {
  const dateResolution = resolveSheetDate({ sheetName, worksheet: ws, includeHeader: false });
  const range = decodeRange(ws);

  const categories: Partial<Record<SummaryCategoryKey, number>> = {};
  const cashBlock: Partial<Record<CashBlockKey, number>> = {};
  const otherIncomeItems: OtherIncomeItem[] = [];
  const unknownLabels: UnknownLabelEntry[] = [];
  let printedTotalSatang: number | null = null;
  let belowNotesMarker = false;

  for (let row = range.s.r; row <= range.e.r; row++) {
    const markerText = textOrEmpty(cellAt(ws, row, NOTES_MARKER_COL));
    if (markerText.includes(NOTES_MARKER_TEXT)) belowNotesMarker = true;

    const labelText = textOrEmpty(cellAt(ws, row, LABEL_COL));
    const grandTotalCandidateText = textOrEmpty(cellAt(ws, row, GRAND_TOTAL_LABEL_COL));
    const amountSatang = toSatang(numberOrNull(cellAt(ws, row, AMOUNT_COL)) ?? undefined);

    const isGrandTotalRow =
      stripWhitespace(grandTotalCandidateText) === GRAND_TOTAL_TEXT ||
      stripWhitespace(labelText) === GRAND_TOTAL_TEXT;
    if (isGrandTotalRow) {
      printedTotalSatang = amountSatang;
      continue;
    }

    if (!labelText) continue;

    if (belowNotesMarker) {
      const cashKey = resolveCashBlockLabel(labelText);
      if (cashKey) {
        cashBlock[cashKey] = amountSatang;
      } else if (amountSatang !== 0) {
        unknownLabels.push({ label: labelText, amountSatang, cellAddress: cellAddress(row, LABEL_COL), section: "cashBlock" });
      }
      continue;
    }

    const categoryKey = resolveCategoryLabel(labelText);
    if (!categoryKey) {
      if (amountSatang !== 0) {
        unknownLabels.push({ label: labelText, amountSatang, cellAddress: cellAddress(row, LABEL_COL), section: "main" });
      }
      continue;
    }

    categories[categoryKey] = amountSatang;
    if (categoryKey !== "otherItems") continue;

    // Itemized other-income: the label row itself may carry the first
    // description (column D), followed by up to four continuation rows.
    const sameRowText = textOrEmpty(cellAt(ws, row, OTHER_ITEM_TEXT_COL));
    if (sameRowText) {
      otherIncomeItems.push({
        text: sameRowText,
        amountSatang,
        isCash: inferIsCashFromFreeText(sameRowText),
        cellAddress: cellAddress(row, OTHER_ITEM_TEXT_COL),
      });
    }

    for (let offset = 1; offset <= MAX_OTHER_INCOME_CONTINUATION_ROWS; offset++) {
      const continuationRow = row + offset;
      if (continuationRow > range.e.r) break;
      const continuationLabelText = textOrEmpty(cellAt(ws, continuationRow, LABEL_COL));
      if (continuationLabelText && resolveCategoryLabel(continuationLabelText)) break; // next known label — stop

      const continuationDescText = textOrEmpty(cellAt(ws, continuationRow, OTHER_ITEM_TEXT_COL));
      const descriptionText = continuationDescText || (continuationLabelText && !resolveCategoryLabel(continuationLabelText) ? continuationLabelText : "");
      const continuationAmount = toSatang(numberOrNull(cellAt(ws, continuationRow, AMOUNT_COL)) ?? undefined);
      // A row with neither text nor a non-zero amount is a genuine blank
      // spacer — keep scanning within the offset budget. A row with a
      // non-zero amount but NO text (verified real case: sheet "31-8-2568"
      // row 8, a bare 2,280 THB with nothing in any column) is real money the
      // office's own printed total includes — it must never be dropped just
      // because it lacks a description; text stays "" (never invented).
      if (!descriptionText && continuationAmount === 0) continue;

      otherIncomeItems.push({
        text: descriptionText,
        amountSatang: continuationAmount,
        isCash: inferIsCashFromFreeText(descriptionText),
        cellAddress: cellAddress(continuationRow, continuationDescText ? OTHER_ITEM_TEXT_COL : LABEL_COL),
      });
    }
  }

  return {
    sheetName,
    property,
    dateResolution,
    categories,
    otherIncomeItems,
    cashBlock,
    printedTotalSatang,
    unknownLabels,
  };
}

export function parseSummaryWorkbook(filePath: string, property: PropertyCode): SummaryWorkbookResult {
  const workbook = XLSX.readFile(filePath, { cellNF: true, cellDates: false });
  const days: SummaryDayRecord[] = [];
  const dateFailures: SummaryWorkbookResult["dateFailures"] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const day = parseSummarySheet(sheetName, worksheet, property);
    days.push(day);
    if (day.dateResolution.unresolved) {
      dateFailures.push({ sheetName, dateResolution: day.dateResolution });
    }
  }

  return {
    filePath,
    property,
    sheetsParsed: workbook.SheetNames.length,
    days,
    dateFailures,
  };
}
