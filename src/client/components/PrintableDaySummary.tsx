import { forwardRef } from "react";
import type { DaySheet, Property } from "../../shared/types.ts";
import type { WeekDayIncome } from "./printWeekChart.ts";
import { DayTenderSummary, ReportFooter, ReportSheetTitle } from "./reportSheetBlocks.tsx";

// DaySheetPage's print/PDF target — the DAY SUMMARY half of the paper
// report (income, the cash-banking block, the day note) WITHOUT the
// per-booking grid (that's ReportSheet.tsx's "bookingsOnly" variant,
// BookingDayPage's print/PDF target instead).
//
// LANDSCAPE, two-column composition (owner decision, 2026-07-31, superseding
// the single-column portrait shape this sheet used before): a single
// stacked column is HEIGHT-bound — the portrait sheet's natural size (720 x
// ~1450px) needed a ~0.72 fit-to-page scale, ~8.7pt body text, to stay on
// one A4 page. reportSheetBlocks.tsx's DayTenderSummary now renders its own
// two-column grid internally (income data left, summary + charts right —
// see its module comment), which roughly halves the stacked height for the
// same content; pairing that with a landscape page (width-generous instead
// of height-bound, same orientation ReportSheet.tsx/BookingDayPage's
// bookingsOnly print already uses — see usePrintExport.ts's `orientation`)
// is what actually buys back the fit scale, not a wider single column
// (printGeometry.ts's computeFitScale fits BOTH axes; a wide/short natural
// layout on a tall/narrow page wastes the opposite axis instead). This
// file stays the print/PDF-only wrapper: sheet width/padding, the inline
// title, and the footer sit around DayTenderSummary's two-column region,
// each spanning the full sheet width above/below it.
//
// DAY_SUMMARY_SHEET_WIDTH is sized so DayTenderSummary's two internal
// columns land in its own ~480-540px target range (gap-6 = 24px gap, minus
// SHEET_PADDING on each side: (1040 - 40 - 24) / 2 = 488px) while landing
// just under the landscape A4 printable width at 10mm margins (~1047px, see
// printGeometry.ts's a4PrintableAreaPx). Row/section padding inside
// DayTenderSummary/ReportFooter (reportSheetBlocks.tsx) and this file's own
// wrapper padding were ALSO tightened (owner decision, 2026-07-31, same
// change) — pure whitespace, no label/figure/conditional touched — so a
// realistic full day's natural height clears the printable HEIGHT (~718px)
// too, without needing the fit-to-page scale to shrink below 1 at all (see
// usePrintExport.ts's computeFitScale: scale can land >=1, using the page
// fully rather than shrinking to it). This matters beyond just legibility:
// Chromium's print/print-to-PDF pagination fragments a page based on an
// element's PRE-transform (natural) box height, not its post-transform
// visual size — an element whose NATURAL height exceeds the printable area
// silently spills onto a second page even though the applied CSS transform
// visually shrinks it to fit (confirmed against this app's pre-existing
// single-column portrait layout too, via a real print-dialog capture — see
// the two-column rework's verification notes). Keeping natural height
// under the printable height sidesteps that entirely, rather than merely
// buying a better-looking (but still occasionally 2-page) scale number.
//
// The income section here is reportSheetBlocks.tsx's DayTenderSummary — the
// ONE tender-grouped day-summary layout every export renders (owner
// decision, 2026-07-31: print, PDF, and ReportSheet.tsx's "full" variant/
// JPEG export all show the same groups-by-tender summary now, no expense
// section anywhere). This file stays the print/PDF-only wrapper: sheet
// width/padding, the inline title, and the footer around DayTenderSummary.
export const DAY_SUMMARY_SHEET_WIDTH = 1040;
const SHEET_PADDING = 20;

interface PrintableDaySummaryProps {
  property: Property;
  date: string;
  sheet: DaySheet;
  /** The Monday-start calendar week containing `date`, zero-filled to
   * exactly 7 entries (see DaySheetPage.tsx / printWeekChart.ts). Absent
   * (undefined) while loading or after a fetch failure — the chart section
   * simply doesn't render rather than breaking the rest of the print. */
  weekDays?: WeekDayIncome[];
  /** Marks the header "(ตัวอย่าง)" — see reportSheetBlocks.tsx's
   * ReportSheetTitle. DaySheetPage has no live /demo route today, but the
   * prop is threaded through for the same reason ReportSheet's is. */
  demo?: boolean;
}

export const PrintableDaySummary = forwardRef<HTMLDivElement, PrintableDaySummaryProps>(
  function PrintableDaySummary({ property, date, sheet, weekDays, demo = false }, ref) {
    const { provenance, verifiedAt, verifiedBy, updatedBy } = sheet;

    return (
      <div ref={ref} className="bg-white text-ink" style={{ width: DAY_SUMMARY_SHEET_WIDTH }}>
        <div className="h-1 bg-brand-800" />
        <div className="h-0.5 bg-gold-500" />

        <div
          className="flex flex-col gap-2 py-3"
          style={{ paddingLeft: SHEET_PADDING, paddingRight: SHEET_PADDING }}
        >
          {/* ReportSheetTitle now has only the one-line form — see
              reportSheetBlocks.tsx's 2026-07-31 owner-decision comment. */}
          <ReportSheetTitle property={property} date={date} demo={demo} />

          <DayTenderSummary date={date} sheet={sheet} weekDays={weekDays} />

          <ReportFooter provenance={provenance} verifiedAt={verifiedAt} verifiedBy={verifiedBy} updatedBy={updatedBy} />
        </div>
      </div>
    );
  },
);
