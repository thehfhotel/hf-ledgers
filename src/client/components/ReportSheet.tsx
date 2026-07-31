import { forwardRef } from "react";
import { visibleTendersForDate } from "../../shared/accrual.ts";
import { computeBookingTotals, lineArithmeticMismatch } from "../../shared/bookings.ts";
import {
  type BookingLine,
  type DaySheet,
  type Property,
} from "../../shared/types.ts";
import {
  BookingGridColgroup,
  BookingGridFoot,
  BookingGridHead,
  bookingGridWidth,
  countText,
  moneyText,
} from "./bookingGridFrame.tsx";
import { DayTenderSummary, ReportFooter, ReportSheetTitle } from "./reportSheetBlocks.tsx";
import type { WeekDayIncome } from "./printWeekChart.ts";

// The printable day sheet — the filed paper (รายงานรายรับของโรงแรม) rather
// than a phone-sized summary card. Rendered VISIBLE (never offscreen — see
// exportJpeg.ts / ReportPage.tsx) and captured verbatim by html2canvas-pro,
// then shared to LINE as a JPEG. Also reused, in "bookingsOnly" mode, as
// BookingDayPage's print/PDF target for just the booking sheet (see
// usePrintExport.ts) — the day-SUMMARY half of the paper (no grid) is
// PrintableDaySummary.tsx instead, since a portrait A4 page needs a
// genuinely narrower composition, not this sheet's landscape shape shrunk
// down (see printGeometry.ts's "make use of the whole page" note).
//
// Layout, top to bottom, mirroring the workbook's own sheet:
//   1. title block  — report name, property, ประจำวันที่ <date in พ.ศ.>
//      (reportSheetBlocks.tsx's ReportSheetTitle)
//   2. the booking grid, READ-ONLY, using the SAME three-row grouped header
//      and totals row as the entry screen (components/bookingGridFrame.tsx —
//      one copy, so the two can never drift) — ALWAYS rendered, "full" and
//      "bookingsOnly" alike
//   3. the SAME tender-grouped day summary PrintableDaySummary.tsx's
//      print/PDF renders (reportSheetBlocks.tsx's DayTenderSummary — owner
//      decision, 2026-07-31: ONE layout for all three exports, no expense
//      section anywhere) — "full" variant only
//   4. footer: provenance, sign-off, last editor, export stamp
//      (reportSheetBlocks.tsx's ReportFooter) — "full" variant only
//
// Every figure on the sheet comes from the shared calculators
// (computeDayTotals via sheet.totals, computeBookingTotals, deriveCashBlock
// via sheet.cashBlock.derived) — nothing is recomputed locally.

/** Print density for the booking grid: the entry grid's own column widths,
 * shrunk to an A4-landscape content width (A4 landscape at 96dpi is ~1123px
 * of paper). */
const PRINT_SCALE = 0.83;
const PRINT_TABLE_WIDTH = bookingGridWidth({ withActions: false, scale: PRINT_SCALE });
const SHEET_PADDING = 22;

/** The sheet's true pixel width — derived from the grid it has to hold, so
 * the table edge and the sheet margin can never disagree. ~1180px. */
export const REPORT_SHEET_WIDTH = PRINT_TABLE_WIDTH + SHEET_PADDING * 2;

// Read-only grid cells. The frame closes the top and left edges (the cells
// carry bottom + right rules), same trick as the entry grid.
const PCELL = "border-b border-r border-line px-1 py-0.5 align-top text-[11px] leading-snug";
const PNUM = PCELL + " text-right tabular-nums whitespace-nowrap";

interface ReportSheetProps {
  property: Property;
  date: string;
  sheet: DaySheet;
  /** The day's booking rows, in seq order (drafts allowed — they are printed
   * as a footnote count, never as rows). */
  lines: BookingLine[];
  /** "full" (default): grid + the tender-grouped day summary + footer — the
   * paper form's exact shape, what ReportPage/exportJpeg use for the JPEG
   * share/download. "bookingsOnly": title + grid only, for BookingDayPage's
   * print/PDF of just the booking sheet. */
  variant?: "full" | "bookingsOnly";
  /** Marks the header "(ตัวอย่าง)" — see reportSheetBlocks.tsx's
   * ReportSheetTitle. */
  demo?: boolean;
  /** No longer changes anything: ReportSheetTitle has only the one-line form
   * now (owner decision, 2026-07-31 — see reportSheetBlocks.tsx), so every
   * ReportSheet rendering is inline regardless of this flag. Kept in the
   * prop type only because BookingDayPage.tsx's "bookingsOnly" print/PDF
   * call site still passes it explicitly. */
  inlineTitle?: boolean;
  /** The Monday-start calendar week containing `date`, zero-filled to
   * exactly 7 entries — threaded straight through to DayTenderSummary's
   * weekly chart (see DaySheetPage.tsx / printWeekChart.ts / ReportPage.tsx
   * for how it's fetched). Absent (undefined) while loading or after a
   * fetch failure — the chart section simply doesn't render. Unused by the
   * "bookingsOnly" variant, which never renders DayTenderSummary. */
  weekDays?: WeekDayIncome[];
}

export const ReportSheet = forwardRef<HTMLDivElement, ReportSheetProps>(function ReportSheet(
  { property, date, sheet, lines, variant = "full", demo = false, weekDays },
  ref,
) {
  const { provenance, verifiedAt, verifiedBy, updatedBy } = sheet;

  // Drafts are proposals, not income: computeBookingTotals() excludes them,
  // so the printed sheet excludes them too and footnotes the count instead.
  const printedLines = lines.filter((line) => !line.draft).slice().sort((a, b) => a.seq - b.seq);
  const draftCount = lines.length - printedLines.length;
  const bookingTotals = computeBookingTotals(lines);
  const anyMismatch = printedLines.some((line) => lineArithmeticMismatch(line));
  // Wave C (docs/adr/0001): the 8 tender columns actually visible for this
  // date — deposit pre-cutover, deposit_applied on/after (same printed
  // slot, see shared/accrual.ts).
  const visibleTenders = visibleTendersForDate(property, date);

  return (
    <div ref={ref} className="bg-white text-ink" style={{ width: REPORT_SHEET_WIDTH }}>
      <div className="h-1 bg-brand-800" />
      <div className="h-0.5 bg-gold-500" />

      <div className="py-6" style={{ paddingLeft: SHEET_PADDING, paddingRight: SHEET_PADDING }}>
        {/* 1. Title block — the way the workbook heads each sheet. */}
        <ReportSheetTitle property={property} date={date} demo={demo} />

        {/* 2. The booking grid, read-only, same frame as the entry screen. */}
        <section className="mb-5">
          <h2 className="mb-1 text-xs font-semibold text-ink-muted">รายการจอง</h2>
          <div className="border-t border-l border-line">
            <table
              className="border-separate border-spacing-0 bg-white"
              style={{ width: PRINT_TABLE_WIDTH, tableLayout: "fixed" }}
            >
              <BookingGridColgroup tenders={visibleTenders} scale={PRINT_SCALE} />
              <BookingGridHead tenders={visibleTenders} compact />
              <tbody>
                {printedLines.length === 0 && (
                  <tr>
                    <td colSpan={18} className={PCELL + " text-center text-ink-muted"}>
                      ไม่มีรายการจองในวันนี้
                    </td>
                  </tr>
                )}
                {printedLines.map((line) => (
                  <tr key={line.id}>
                    {/* Reconcile marker sits by the row number, same place
                        the entry grid puts it — never buried at the end of a
                        wrapped หมายเหตุ. */}
                    <td className={PCELL + " text-center tabular-nums"}>
                      {line.seq}
                      {lineArithmeticMismatch(line) && (
                        <span className="ml-0.5 align-super font-bold text-warn">*</span>
                      )}
                    </td>
                    <td className={PCELL + " break-words"}>{line.bookingNo ?? ""}</td>
                    <td className={PCELL + " break-words"}>{line.guestName ?? ""}</td>
                    <td className={PCELL + " break-words"}>{line.roomNo ?? ""}</td>
                    <td className={PNUM}>{countText(line.roomCount)}</td>
                    <td className={PNUM}>{countText(line.nights)}</td>
                    <td className={PNUM}>{moneyText(line.grossRoomSatang)}</td>
                    <td className={PNUM}>{moneyText(line.grossOtherSatang)}</td>
                    <td className={PNUM}>{moneyText(line.discountSatang)}</td>
                    {visibleTenders.map((tender) => (
                      <td key={tender} className={PNUM}>
                        {moneyText(line.tenders[tender])}
                      </td>
                    ))}
                    <td className={PCELL + " break-words"}>{line.remark ?? ""}</td>
                  </tr>
                ))}
              </tbody>
              <BookingGridFoot tenders={visibleTenders} totals={bookingTotals} compact />
            </table>
          </div>
          {(anyMismatch || draftCount > 0) && (
            <p className="mt-1 text-[11px] leading-snug text-ink-muted">
              {anyMismatch && "* ยอดรับไม่ตรงกับยอดห้อง+อื่นๆ-ส่วนลด (รายการจากช่องทางออนไลน์มักต่างกันได้)"}
              {anyMismatch && draftCount > 0 && " - "}
              {draftCount > 0 && `ไม่รวมรายการร่างจากระบบจอง ${draftCount} รายการ`}
            </p>
          )}
        </section>

        {/* 3. + 4. The tender-grouped day summary, and the provenance
            footer — the "full" paper form only; BookingDayPage's
            "bookingsOnly" print/PDF stops at the grid above. */}
        {variant === "full" && (
          <>
            {/* DayTenderSummary renders its own two-column grid (income
                data left, summary + charts right — owner decision,
                2026-07-31, see reportSheetBlocks.tsx's module comment).
                Stretches to this sheet's full content width (~1218px, grid-
                driven by the booking table above), wider than
                PrintableDaySummary's own landscape sheet — see the "stretch
                sensibly" note in DayTenderSummary's own comment. */}
            <DayTenderSummary property={property} date={date} sheet={sheet} weekDays={weekDays} />

            <ReportFooter provenance={provenance} verifiedAt={verifiedAt} verifiedBy={verifiedBy} updatedBy={updatedBy} />
          </>
        )}
      </div>
    </div>
  );
});
