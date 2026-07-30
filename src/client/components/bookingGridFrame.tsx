import { formatSatang } from "../../shared/money.ts";
import { TENDERS, type BookingTotals } from "../../shared/types.ts";

// The booking grid's FRAME: column widths, the three-row grouped header
// verbatim from the workbook, and the totals row.
//
// Shared by the editable entry grid (components/BookingGrid.tsx) and the
// printable day sheet (components/ReportSheet.tsx). The header wording is
// the office's strongest familiarity cue, so it exists exactly ONCE — two
// copies would drift the moment either screen is touched. Only the two
// things that legitimately differ between screen and paper are props: the
// delete column (`withActions`) and print density (`compact`).

/**
 * Widths of the 18 data columns in printed order — seq, bookingNo,
 * guestName, roomNo, roomCount, nights, grossRoom, grossOther, discount,
 * the eight TENDERS, remark. Sums to 1432px at scale 1.
 *
 * guestName and roomNo are deliberately generous. On the printed sheet those
 * cells wrap, so any width reads; on the entry grid they are inputs, which
 * CLIP instead — and a clipped guest name ("นายอดินันท์ ไวยวรร") or a
 * two-room list shown as "11011" defeats the whole point of a screen meant
 * to read like the workbook. Real values run long: company guests like
 * "บริษัท เอส แอนด์ ซันส์ เทรดดิ้ง จำกัด", and group-booking room lists up to
 * 125 chars. No width fits the worst case, so the entry cells also carry a
 * `title` for hover-to-read. Widths reclaimed from bookingNo (values are a
 * fixed 10-char "B2607-0447") and remark.
 */
export const BOOKING_GRID_DATA_WIDTHS: readonly number[] = [
  40, 80, 200, 84, 42, 42, 84, 78, 74, 84, 80, 76, 76, 76, 76, 76, 76, 104,
];

/** The row-edge delete column, present on the entry grid only. */
export const BOOKING_GRID_ACTION_WIDTH = 40;

export interface BookingGridFrameOptions {
  /** Include the row-edge delete column (entry grid) or not (printed sheet). */
  withActions?: boolean;
  /** Multiplier on every column width — the printed sheet shrinks the grid
   * to fit an A4-landscape content width. Widths are rounded per column, so
   * always take the table's own width from `bookingGridWidth()`. */
  scale?: number;
}

export function bookingGridWidths({ withActions = false, scale = 1 }: BookingGridFrameOptions = {}): number[] {
  const base = withActions
    ? [...BOOKING_GRID_DATA_WIDTHS, BOOKING_GRID_ACTION_WIDTH]
    : [...BOOKING_GRID_DATA_WIDTHS];
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

export function BookingGridColgroup({ withActions, scale }: BookingGridFrameOptions) {
  return (
    <colgroup>
      {bookingGridWidths({ withActions, scale }).map((width, index) => (
        <col key={index} style={{ width }} />
      ))}
    </colgroup>
  );
}

/** Three-row grouped header, wording verbatim from the workbook. Each row
 * spans the full 18 data columns (19 with the delete column). */
export function BookingGridHead({ withActions = false, compact = false, sticky = false }: BookingGridFrameProps) {
  const H = compact ? HEAD_COMPACT : HEAD_ROOMY;
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
        <th colSpan={8} className={H}>
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
        <th className={H}>มัดจำค่าห้อง</th>
        <th className={H}>เงินสด</th>
        <th colSpan={2} className={H}>
          บัตรเครดิต
        </th>
        <th colSpan={2} className={H}>
          เงินโอน
        </th>
        <th className={H}>แอพฯ</th>
        <th className={H}>อื่นๆ</th>
      </tr>
      <tr>
        <th className={H}>ค่าห้อง</th>
        <th className={H}>อื่นๆ</th>
        <th className={H}>โอน/เครดิต</th>
        <th className={H}>ค่าห้อง</th>
        <th className={H}>กสิกร</th>
        <th className={H}>ICBC</th>
        <th className={H}>กสิกร</th>
        <th className={H}>ICBC</th>
        <th className={H}>/เว็บไซด์</th>
        <th className={H}>สด/โอน/เครดิต</th>
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
 * here recomputes anything. */
export function BookingGridFoot({
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
        {TENDERS.map((tender) => (
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
