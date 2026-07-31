import { forwardRef } from "react";
import type { DaySheet, Property } from "../../shared/types.ts";
import type { WeekDayIncome } from "./printWeekChart.ts";
import { DayTenderSummary, ReportFooter, ReportSheetTitle } from "./reportSheetBlocks.tsx";

// DaySheetPage's print/PDF target — the DAY SUMMARY half of the paper
// report (income, the cash-banking block, the day note) WITHOUT the
// per-booking grid (that's ReportSheet.tsx's "bookingsOnly" variant,
// BookingDayPage's print/PDF target instead).
//
// Deliberately a NARROW, single-column, portrait-shaped composition rather
// than ReportSheet's landscape sheet with its grid section stripped out:
// scaling a wide/short natural layout to fill a tall/narrow A4 portrait
// page would either leave most of the page blank or overflow one axis (see
// printGeometry.ts's computeFitScale — it fits BOTH axes, so a poor aspect
// match between content and page wastes exactly the space the owner wants
// used). A natural width close to A4 portrait's own printable width keeps
// the fit-to-page scale close to 1 in the common case.
//
// The income section here is reportSheetBlocks.tsx's DayTenderSummary — the
// ONE tender-grouped day-summary layout every export renders (owner
// decision, 2026-07-31: print, PDF, and ReportSheet.tsx's "full" variant/
// JPEG export all show the same groups-by-tender summary now, no expense
// section anywhere). This file stays the print/PDF-only wrapper: sheet
// width/padding, the inline title, and the footer around DayTenderSummary.
export const DAY_SUMMARY_SHEET_WIDTH = 720;
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
          className="flex flex-col gap-4 py-6"
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
