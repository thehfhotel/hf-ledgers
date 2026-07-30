import { forwardRef } from "react";
import type { DaySheet, Property } from "../../shared/types.ts";
import { CashSummaryCard, IncomeExpenseSummaryCard, ReportFooter, ReportSheetTitle } from "./reportSheetBlocks.tsx";

// DaySheetPage's print/PDF target — the DAY SUMMARY half of the paper
// report (income by category, expenses, the cash-banking block, the day
// note) WITHOUT the per-booking grid (that's ReportSheet.tsx's
// "bookingsOnly" variant, BookingDayPage's print/PDF target instead).
//
// Deliberately a NARROW, single-column, portrait-shaped composition rather
// than ReportSheet's landscape sheet with its grid section stripped out:
// scaling a wide/short natural layout to fill a tall/narrow A4 portrait
// page would either leave most of the page blank or overflow one axis (see
// printGeometry.ts's computeFitScale — it fits BOTH axes, so a poor aspect
// match between content and page wastes exactly the space the owner wants
// used). A natural width close to A4 portrait's own printable width keeps
// the fit-to-page scale close to 1 in the common case.
export const DAY_SUMMARY_SHEET_WIDTH = 720;
const SHEET_PADDING = 20;

interface PrintableDaySummaryProps {
  property: Property;
  date: string;
  sheet: DaySheet;
  /** Marks the header "(ตัวอย่าง)" — see reportSheetBlocks.tsx's
   * ReportSheetTitle. DaySheetPage has no live /demo route today, but the
   * prop is threaded through for the same reason ReportSheet's is. */
  demo?: boolean;
}

export const PrintableDaySummary = forwardRef<HTMLDivElement, PrintableDaySummaryProps>(
  function PrintableDaySummary({ property, date, sheet, demo = false }, ref) {
    const { categories, income, expenses, totals, otherIncome, cashBlock, provenance, verifiedAt, verifiedBy, note, updatedBy } =
      sheet;

    return (
      <div ref={ref} className="bg-white text-ink" style={{ width: DAY_SUMMARY_SHEET_WIDTH }}>
        <div className="h-1 bg-brand-800" />
        <div className="h-0.5 bg-gold-500" />

        <div
          className="flex flex-col gap-4 py-6"
          style={{ paddingLeft: SHEET_PADDING, paddingRight: SHEET_PADDING }}
        >
          {/* Always the one-line print form — this component is print-only
              (never the JPEG export), see reportSheetBlocks.tsx's
              ReportSheetTitle. */}
          <ReportSheetTitle property={property} date={date} demo={demo} inline />
          <IncomeExpenseSummaryCard categories={categories} income={income} expenses={expenses} totals={totals} />
          <CashSummaryCard cashBlock={cashBlock} totals={totals} note={note} otherIncome={otherIncome} />
          <ReportFooter provenance={provenance} verifiedAt={verifiedAt} verifiedBy={verifiedBy} updatedBy={updatedBy} />
        </div>
      </div>
    );
  },
);
