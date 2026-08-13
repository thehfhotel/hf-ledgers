import { formatSatang } from "@shared/money.ts";
import { TENDERS, type BookingTotals, type Tender } from "../../shared/types.ts";

// The booking grid's FRAME: column widths, the three-row grouped header
// verbatim from the workbook, and the totals row.
//
// Shared by the editable entry grid (components/BookingGrid.tsx) and the
// printable day sheet (components/ReportSheet.tsx). The header wording is
// the office's strongest familiarity cue, so it exists exactly ONCE — two
// copies would drift the moment either screen is touched. Only the two
// things that legitimately differ between screen and paper are props: the
// delete column (`withActions`) and print density (`compact`).
//
// Wave C (docs/adr/0001, shared/accrual.ts): the grid shows exactly 8 money
// columns, but WHICH 8 now varies by date — `deposit` pre-cutover,
// `deposit_applied` on/after (same printed slot, see
// `visibleTendersForDate()`). Every function here that renders actual
// columns (BookingGridColgroup/Head/Foot) takes the caller's
// `visibleTendersForDate()` result as its `tenders` prop instead of
// assuming the module-level `TENDERS` constant (which is the full 9-entry
// superset, for money math, not display).

/**
 * Widths of the fixed (non-tender) data columns in printed order — seq,
 * bookingNo, guestName, roomNo, roomCount, nights, grossRoom, grossOther,
 * discount. The 8 tender columns and the remark column are appended by
 * `bookingGridWidths()` below, keyed by whichever `tenders` the caller is
 * actually rendering.
 *
 * guestName and roomNo are deliberately generous. On the printed sheet those
 * cells wrap, so any width reads; on the entry grid they are inputs, which
 * CLIP instead — and a clipped guest name ("นายอดินันท์ ไวยวรร") or a
 * two-room list shown as "11011" defeats the whole point of a screen meant
 * to read like the workbook. Real values run long: company guests like
 * "บริษัท เอส แอนด์ ซันส์ เทรดดิ้ง จำกัด", and group-booking room lists up to
 * 125 chars. No width fits the worst case, so the entry cells also carry a
 * `title` for hover-to-read. bookingNo is sized for its actual fixed-width
 * PMS format ("CH26-001712", 11 chars) — a prior width here assumed a
 * shorter 10-char legacy format ("B2607-0447") and clipped the real one.
 */
const FIXED_COLUMN_WIDTHS_BEFORE_TENDERS: readonly number[] = [40, 100, 200, 84, 42, 42, 84, 78, 74];

/** Per-tender column width. `deposit`/`deposit_applied` share the identical
 * width (84px) — they share one printed slot (see accrual.ts), so the
 * grid's total width is invariant to which of the two a given date shows. */
const TENDER_COLUMN_WIDTH_PX: Record<Tender, number> = {
  deposit: 84,
  deposit_applied: 84,
  cash: 80,
  credit_kbank: 76,
  credit_icbc: 76,
  transfer_kbank: 76,
  transfer_icbc: 76,
  web: 76,
  other: 76,
};

const REMARK_COLUMN_WIDTH_PX = 104;

/** The row-edge delete column, present on the entry grid only. */
export const BOOKING_GRID_ACTION_WIDTH = 40;

/** The canonical 8-of-9 tender list used ONLY as `bookingGridWidths()`'s
 * default when a caller omits `tenders` — safe because `deposit`/
 * `deposit_applied` share an identical column width (see
 * `TENDER_COLUMN_WIDTH_PX` above), so the grid's TOTAL width never actually
 * depends on which of the two is included. This lets module-level sizing
 * constants that have no date to compute from (ReportSheet.tsx's
 * `PRINT_TABLE_WIDTH`/`REPORT_SHEET_WIDTH`, exported for ReportPage.tsx's
 * preview-scale math) stay computed once at import time. Anything that
 * renders ACTUAL columns (`BookingGridColgroup`/`BookingGridHead`/
 * `BookingGridFoot`) must always pass the real `visibleTendersForDate()`
 * result instead — never rely on this default for rendering, only for a
 * pure total-width number. */
const WIDTH_CALC_TENDERS: readonly Tender[] = TENDERS.filter((tender) => tender !== "deposit_applied");

export interface BookingGridFrameOptions {
  /** The 8 tender columns actually visible for the date being rendered —
   * see shared/accrual.ts's `visibleTendersForDate()`. Optional ONLY for
   * `bookingGridWidths()`/`bookingGridWidth()`'s pure-total-width use
   * (defaults to `WIDTH_CALC_TENDERS`, see its doc comment); every
   * column-RENDERING caller (`BookingGridColgroup`/`BookingGridHead`/
   * `BookingGridFoot`) must pass it explicitly. */
  tenders?: readonly Tender[];
  /** Include the row-edge delete column (entry grid) or not (printed sheet). */
  withActions?: boolean;
  /** Multiplier on every column width — the printed sheet shrinks the grid
   * to fit an A4-landscape content width. Widths are rounded per column, so
   * always take the table's own width from `bookingGridWidth()`. */
  scale?: number;
}

export function bookingGridWidths({
  tenders = WIDTH_CALC_TENDERS,
  withActions = false,
  scale = 1,
}: BookingGridFrameOptions = {}): number[] {
  const base = [
    ...FIXED_COLUMN_WIDTHS_BEFORE_TENDERS,
    ...tenders.map((tender) => TENDER_COLUMN_WIDTH_PX[tender]),
    REMARK_COLUMN_WIDTH_PX,
    ...(withActions ? [BOOKING_GRID_ACTION_WIDTH] : []),
  ];
  return base.map((width) => Math.round(width * scale));
}

/** Total table width for a given frame — the sum of the ROUNDED column
 * widths, so cell rules and the table edge can never disagree by a pixel. */
export function bookingGridWidth(options: BookingGridFrameOptions = {}): number {
  return bookingGridWidths(options).reduce((sum, width) => sum + width, 0);
}

// border-separate (not collapse) on purpose: collapsed borders are dropped
// on sticky thead/tfoot cells in Chrome, so the grid rules live on the cells
// themselves (bottom + right) and the frame around the grid closes the top
// and left edges.
const HEAD = "border-b border-r border-line bg-tint text-center font-semibold text-ink-muted";
const HEAD_ROOMY = HEAD + " px-1.5 py-1 text-xs";
const HEAD_COMPACT = HEAD + " px-1 py-0.5 text-[10px] leading-tight";

const FOOT = "border-b border-r border-t-2 border-line border-t-gold-500 bg-tint tabular-nums";
const FOOT_ROOMY = FOOT + " px-1.5 py-1";
const FOOT_COMPACT = FOOT + " px-1 py-0.5 text-[11px] leading-tight";

export interface BookingGridFrameProps extends BookingGridFrameOptions {
  /** Print density: smaller type and tighter padding for the paper sheet. */
  compact?: boolean;
  /** Pin the band while the rows scroll (entry grid only). */
  sticky?: boolean;
}

export function BookingGridColgroup({ tenders, withActions, scale }: BookingGridFrameOptions) {
  return (
    <colgroup>
      {bookingGridWidths({ tenders, withActions, scale }).map((width, index) => (
        <col key={index} style={{ width }} />
      ))}
    </colgroup>
  );
}

/**
 * Each tender column's header label split across the group row (row 2) and
 * the leaf row (row 3) — e.g. `cash` prints "เงินสด" over "ค่าห้อง",
 * combining to "เงินสดค่าห้อง" (`TENDER_LABELS_TH.cash`). `deposit_applied`
 * ("ตัดยอดมัดจำ", Wave C) has no natural two-word split, so its row-3 half
 * is simply empty — the column's single group-row label already carries
 * the whole meaning.
 */
const TENDER_HEADER_SPLIT: Record<Tender, [row2: string, row3: string]> = {
  deposit: ["มัดจำค่าห้อง", "โอน/เครดิต"],
  deposit_applied: ["ตัดยอดมัดจำ", ""],
  cash: ["เงินสด", "ค่าห้อง"],
  credit_kbank: ["บัตรเครดิต", "กสิกร"],
  credit_icbc: ["บัตรเครดิต", "ICBC"],
  transfer_kbank: ["เงินโอน", "กสิกร"],
  transfer_icbc: ["เงินโอน", "ICBC"],
  web: ["แอพฯ", "/เว็บไซด์"],
  other: ["อื่นๆ", "สด/โอน/เครดิต"],
};

/** Groups consecutive tenders sharing the same row-2 header label into one
 * colSpan cell — in the canonical order this merges credit_kbank+
 * credit_icbc under "บัตรเครดิต" and transfer_kbank+transfer_icbc under
 * "เงินโอน" (exactly the workbook's original hardcoded shape); every other
 * tender, including whichever of deposit/deposit_applied is visible, gets
 * its own colSpan=1 cell. Purely positional (adjacency in `tenders`), so
 * this still works correctly for whatever 8-of-9 subset a given date shows. */
function groupTenderHeaderRow2(tenders: readonly Tender[]): Array<{ label: string; colSpan: number }> {
  const groups: Array<{ label: string; colSpan: number }> = [];
  for (const tender of tenders) {
    const [row2Label] = TENDER_HEADER_SPLIT[tender];
    const last = groups[groups.length - 1];
    if (last && last.label === row2Label) last.colSpan += 1;
    else groups.push({ label: row2Label, colSpan: 1 });
  }
  return groups;
}

/** Three-row grouped header, wording verbatim from the workbook (except the
 * deposit slot's label, which is date-driven — see `TENDER_HEADER_SPLIT`).
 * Each row spans the full 18 data columns (19 with the delete column). */
export function BookingGridHead({
  tenders = WIDTH_CALC_TENDERS,
  withActions = false,
  compact = false,
  sticky = false,
}: BookingGridFrameProps) {
  const H = compact ? HEAD_COMPACT : HEAD_ROOMY;
  const row2Groups = groupTenderHeaderRow2(tenders);
  return (
    <thead className={sticky ? "sticky top-0 z-10" : undefined}>
      <tr>
        <th rowSpan={3} className={H}>
          ลำดับ
        </th>
        <th className={H}>เลขที่</th>
        <th rowSpan={3} className={H}>
          ชื่อลูกค้า
        </th>
        <th className={H}>เลขที่</th>
        <th colSpan={2} className={H}>
          จำนวน
        </th>
        <th colSpan={2} className={H}>
          จำนวนเงิน
        </th>
        <th rowSpan={3} className={H}>
          ส่วนลด
        </th>
        <th colSpan={tenders.length} className={H}>
          จำนวนเงินรับ
        </th>
        <th rowSpan={3} className={H}>
          หมายเหตุ
        </th>
        {withActions && (
          <th rowSpan={3} className={H}>
            <span className="sr-only">ลบแถว</span>
          </th>
        )}
      </tr>
      <tr>
        <th rowSpan={2} className={H}>
          ใบกำกับภาษี
        </th>
        <th rowSpan={2} className={H}>
          ห้อง
        </th>
        <th rowSpan={2} className={H}>
          ห้อง
        </th>
        <th rowSpan={2} className={H}>
          คืน
        </th>
        <th colSpan={2} className={H}>
          ก่อนหักส่วนลด
        </th>
        {row2Groups.map((group, i) => (
          <th key={i} colSpan={group.colSpan} className={H}>
            {group.label}
          </th>
        ))}
      </tr>
      <tr>
        <th className={H}>ค่าห้อง</th>
        <th className={H}>อื่นๆ</th>
        {tenders.map((tender) => (
          <th key={tender} className={H}>
            {TENDER_HEADER_SPLIT[tender][1]}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/** Amounts and counts render BLANK when zero or empty, same as the paper —
 * a column of "0.00" is noise the office never wrote down. */
export function moneyText(satang: number | null | undefined): string {
  return satang != null && satang !== 0 ? formatSatang(satang) : "";
}

export function countText(count: number | null | undefined): string {
  return count != null && count !== 0 ? String(count) : "";
}

/** The totals row. Every figure comes from computeBookingTotals() — nothing
 * here recomputes anything. `totals.byTender` always carries all 9 tenders
 * (see BookingTotals/computeBookingTotals) — this indexes into it with
 * whichever 8 `tenders` the caller is displaying for this date, so a
 * hidden column's total (if any — see BookingGrid.tsx's warning chip) is
 * simply not shown here, never lost from `totals` itself. */
export function BookingGridFoot({
  tenders = WIDTH_CALC_TENDERS,
  totals,
  withActions = false,
  compact = false,
  sticky = false,
}: BookingGridFrameProps & { totals: BookingTotals }) {
  const F = compact ? FOOT_COMPACT : FOOT_ROOMY;
  const labelSize = compact ? " text-[10px]" : " text-xs";
  return (
    <tfoot className={sticky ? "sticky bottom-0 z-10" : undefined}>
      <tr className="font-semibold">
        <td colSpan={4} className={F + labelSize + " font-normal text-ink-muted"}>
          รวม {totals.lineCount} รายการ
        </td>
        <td className={F + " text-right"}>{countText(totals.roomCount)}</td>
        <td className={F + " text-right"}>{countText(totals.nights)}</td>
        <td className={F + " text-right"}>{moneyText(totals.grossRoomSatang)}</td>
        <td className={F + " text-right"}>{moneyText(totals.grossOtherSatang)}</td>
        <td className={F + " text-right"}>{moneyText(totals.discountSatang)}</td>
        {tenders.map((tender) => (
          <td key={tender} className={F + " text-right"}>
            {moneyText(totals.byTender[tender])}
          </td>
        ))}
        <td colSpan={withActions ? 2 : 1} className={F + " text-right"}>
          <span className={"font-normal text-ink-muted" + labelSize}>ยอดรับรวม </span>
          <span className="font-bold text-brand-500">{formatSatang(totals.receivedSatang)}</span>
        </td>
      </tr>
    </tfoot>
  );
}
