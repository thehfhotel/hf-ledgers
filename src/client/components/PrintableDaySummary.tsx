import { forwardRef, Fragment } from "react";
import { isoToBuddhist } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import type { DaySheet, Property } from "../../shared/types.ts";
import { CASH_BLOCK_FIELDS } from "../labels.ts";
import {
  GRAND_TOTAL_LABEL_TH,
  groupDayIncomeForPrint,
  UNCLASSIFIED_GROUP_LABEL_TH,
  UNCLASSIFIED_TOTAL_LABEL_TH,
} from "./printDayIncomeGrouping.ts";
import {
  isFutureDay,
  overrideDayIncome,
  scaleWeekBars,
  WEEKDAY_LABELS_TH,
  type WeekDayIncome,
} from "./printWeekChart.ts";
import { BOX, BOX_HEAD, ReportFooter, ReportSheetTitle, ROW_AMOUNT, ROW_LABEL } from "./reportSheetBlocks.tsx";

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
// The income section here is DELIBERATELY its own rendering rather than
// reportSheetBlocks.tsx's IncomeExpenseSummaryCard/CashSummaryCard (used
// unchanged by ReportSheet.tsx's JPEG export and the bookingsOnly print):
// the owner found the flat 11-category list confusing on paper, so THIS
// print groups the same cells by HOW the money arrived (cash / transfer /
// card / web — see printDayIncomeGrouping.ts) and drops the expense
// deduction lines entirely. Only the screen's identical wording/figures for
// what DOES stay (the bank line and any manager-overridden cash-component
// line beneath it, the day note, the itemised รายการอื่นๆ list, the footer)
// are reused, via the shared BOX/ROW_* primitives and CASH_BLOCK_FIELDS —
// never re-typed.
export const DAY_SUMMARY_SHEET_WIDTH = 720;
const SHEET_PADDING = 20;
/** Sub-line indent under a bold group heading — inline style (not a
 * Tailwind pl-* utility) so it reliably wins over ROW_LABEL's own px-3,
 * regardless of Tailwind's generated rule order. */
const SUB_LINE_INDENT_PX = 26;

const WEEK_CHART_TITLE_TH = "รายรับรายวัน สัปดาห์นี้ (จ–อา)";
/** Fixed natural height of the chart's bar-plotting row (excludes the box
 * header) regardless of the week's data — the printed sheet's natural
 * height must stay predictable so printGeometry.ts's fit-to-page scale
 * (computeFitScale, see usePrintExport.ts) keeps fitting a full day's sheet
 * on one A4 page the same way it always has. Comfortably inside the
 * ~120-150px budget once the box header is added on top. */
const WEEK_CHART_PLOT_HEIGHT_PX = 130;
/** Tallest bar's own height within the plot row — the rest of
 * WEEK_CHART_PLOT_HEIGHT_PX is the amount label above it and the two label
 * rows (weekday, day-of-month) below. */
const WEEK_CHART_BAR_MAX_PX = 64;

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
    const { totals, cashBlock, otherIncome, provenance, verifiedAt, verifiedBy, note, updatedBy } = sheet;
    const grouped = groupDayIncomeForPrint(sheet);
    // A REAL cross-check, not a re-derivation the print trusts blindly: the
    // grouping's own independently-summed grandTotalSatang against the
    // server-computed totals.incomeSatang. They can only disagree if a
    // future CategoryKey slips the grouping's exhaustiveness check somehow,
    // or a category carries a stale/duplicate key — either way this must
    // stay visible, never silently swallowed (see the ตรวจสอบ line below).
    const incomeMismatch = grouped.grandTotalSatang !== totals.incomeSatang;

    // Entered (manager-overridden) figure wins over derived, same reading
    // the booking page and the screen's cash-banking block use, so the
    // banked figure on the printed sheet is the one the manager actually
    // recorded.
    const bankedDerived = cashBlock.derived.bankedSatang;
    const bankedEntered = cashBlock.entered?.bankedSatang;
    const bankedShown = bankedEntered ?? bankedDerived;
    const bankedOverridden = bankedEntered != null && bankedEntered !== bankedDerived;
    // Falls back to the field's own (never-changing) Thai wording rather
    // than a `.find(...)!` assertion — a future edit to CASH_BLOCK_FIELDS
    // that drops/renames the key must not crash the whole print.
    const bankLabel = CASH_BLOCK_FIELDS.find((field) => field.key === "bankedSatang")?.label ?? "สรุปเงินสดฝากเข้าบัญชี";

    // The three cash COMPONENTS (room/other/bar cash) are redundant with
    // the เงินสด group's sub-lines above in the common case, so they print
    // ONLY when a manager overrode at least one of them (a till counted
    // short/over) — the same visibility BookingDayPage's cash-block panel
    // gives that override on screen. entered is narrowed to non-null once
    // for both the filter and the map below (TS keeps a `const`'s narrowing
    // across the closures here), so nothing needs a `!` assertion.
    const enteredCash = cashBlock.entered;
    const overriddenCashComponents = enteredCash
      ? CASH_BLOCK_FIELDS.filter(
          (field) => field.key !== "bankedSatang" && enteredCash[field.key] !== cashBlock.derived[field.key],
        ).map((field) => ({
          key: field.key,
          label: field.label,
          entered: enteredCash[field.key],
          derived: cashBlock.derived[field.key],
        }))
      : [];

    // The printed date's chart bar always reflects the LIVE sheet totals,
    // never the possibly-stale value DaySheetPage's listDays() fetch
    // captured at load time (see printWeekChart.ts's overrideDayIncome) —
    // editing income and then printing must never show two different
    // figures for the same day on one page.
    const printedWeekDays = weekDays ? overrideDayIncome(weekDays, date, totals.incomeSatang) : undefined;

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

          <div className={BOX}>
            <h2 className={BOX_HEAD}>สรุปยอดรายรับโรงแรม (แยกตามวิธีรับเงิน)</h2>
            <table className="w-full border-separate border-spacing-0">
              <tbody>
                {grouped.groups.map((group) => (
                  <Fragment key={group.id}>
                    <tr>
                      <td colSpan={2} className={ROW_LABEL + " pt-2 pb-0.5 font-bold text-ink"}>
                        {group.label}
                      </td>
                    </tr>
                    {group.lines.map((line) => (
                      <tr key={line.categoryKey} className="align-baseline">
                        <td className={ROW_LABEL + " border-b border-line"} style={{ paddingLeft: SUB_LINE_INDENT_PX }}>
                          {line.label}
                          {line.archived && <span className="ml-1 text-xs text-ink-muted">(เลิกใช้)</span>}
                        </td>
                        <td className={ROW_AMOUNT + " border-b border-line"}>
                          {line.amountSatang != null ? formatSatang(line.amountSatang) : "-"}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}

                {/* Manager-created income categories with no CategoryKey —
                    never dropped, but honestly excluded from every tender
                    total below since the paper never recorded how they
                    arrived. */}
                {grouped.unclassified.length > 0 && (
                  <Fragment>
                    <tr>
                      <td colSpan={2} className={ROW_LABEL + " pt-2 pb-0.5 font-bold text-ink"}>
                        {UNCLASSIFIED_GROUP_LABEL_TH}
                      </td>
                    </tr>
                    {grouped.unclassified.map((line) => (
                      <tr key={line.categoryId} className="align-baseline">
                        <td className={ROW_LABEL + " border-b border-line"} style={{ paddingLeft: SUB_LINE_INDENT_PX }}>
                          {line.label}
                          {line.archived && <span className="ml-1 text-xs text-ink-muted">(เลิกใช้)</span>}
                        </td>
                        <td className={ROW_AMOUNT + " border-b border-line"}>{formatSatang(line.amountSatang)}</td>
                      </tr>
                    ))}
                  </Fragment>
                )}

                {/* Totals — visually distinct (shaded + bold) from the
                    sub-lines above, so a shorter total row can never be
                    mistaken for one more category. The four group subtotals
                    plus (when non-empty) the unclassified subtotal are the
                    ONLY shaded rows, and always sum to the bold grand total
                    below. */}
                {grouped.groups.map((group) => (
                  <tr key={`${group.id}-total`} className="bg-tint">
                    <td className={ROW_LABEL + " border-t border-line font-semibold"}>
                      {group.totalLabel}
                      {group.id === "transfer" && "*"}
                    </td>
                    <td className={ROW_AMOUNT + " border-t border-line font-semibold"}>
                      {formatSatang(group.totalSatang)}
                    </td>
                  </tr>
                ))}
                {grouped.unclassified.length > 0 && (
                  <tr className="bg-tint">
                    <td className={ROW_LABEL + " border-t border-line font-semibold"}>{UNCLASSIFIED_TOTAL_LABEL_TH}</td>
                    <td className={ROW_AMOUNT + " border-t border-line font-semibold"}>
                      {formatSatang(grouped.unclassifiedTotalSatang)}
                    </td>
                  </tr>
                )}

                <tr>
                  <td className={ROW_LABEL + " border-t-2 border-line-strong pt-1.5 text-base font-bold text-brand-500"}>
                    {GRAND_TOTAL_LABEL_TH}
                  </td>
                  <td
                    className={
                      ROW_AMOUNT + " border-t-2 border-line-strong pt-1.5 text-base font-bold text-brand-500"
                    }
                  >
                    {formatSatang(totals.incomeSatang)}
                  </td>
                </tr>
                {/* Real-time cross-check, never suppressed: if the tender
                    grouping's own independently-summed total ever disagrees
                    with the server-computed รวมรายรับทั้งวัน, that has to be
                    visible on the printed sheet, not silently swallowed. */}
                {incomeMismatch && (
                  <tr>
                    <td colSpan={2} className={ROW_LABEL + " pt-1 pb-1 text-xs font-semibold text-bad"}>
                      ตรวจสอบ: ผลรวมตามวิธีรับเงินไม่ตรงกับรวมรายรับ (ต่าง{" "}
                      {formatSatang(Math.abs(totals.incomeSatang - grouped.grandTotalSatang))})
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="px-3 pt-1 pb-2 text-[11px] leading-snug text-ink-muted">
              * รายการ โอน/เครดิต ที่แยกประเภทไม่ได้ นับรวมในเงินโอน
            </p>
          </div>

          <div className={BOX + " bg-tint"}>
            <h2 className={BOX_HEAD}>**หมายเหตุ (สรุปเงินสด)</h2>
            <div className="px-3 py-2">
              {/* Manager cash overrides MUST print: when the till was
                  counted short/over and a component (room/other/bar cash)
                  was adjusted, that adjustment has to be visible, not just
                  folded into the bank total below — same rule
                  BookingDayPage's cash-block panel already enforces on
                  screen. Silent in the common (no override) case. */}
              {overriddenCashComponents.length > 0 && (
                <div className="mb-1.5 flex flex-col gap-0.5 border-b border-line pb-1.5">
                  {overriddenCashComponents.map((row) => (
                    <div key={row.key} className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-ink">
                        {row.label}
                        <span className="ml-1.5 text-xs font-normal text-ink-muted">
                          (ปรับจาก {formatSatang(row.derived)})
                        </span>
                      </span>
                      <span className="text-sm tabular-nums whitespace-nowrap text-ink">
                        {formatSatang(row.entered)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-bold text-brand-500">
                  {bankLabel} (ยอดฝากจริง)
                  {bankedOverridden && (
                    <span className="ml-1.5 text-xs font-normal text-ink-muted">
                      (ปรับจาก {formatSatang(bankedDerived)})
                    </span>
                  )}
                </span>
                <span className="text-base font-bold tabular-nums whitespace-nowrap text-brand-500">
                  {formatSatang(bankedShown)}
                </span>
              </div>
              {note && (
                <p className="mt-2 border-t border-line pt-1.5 text-xs leading-snug text-ink">
                  <span className="font-semibold">หมายเหตุประจำวัน: </span>
                  {note}
                </p>
              )}
            </div>
          </div>

          {/* Weekly income bar chart — decorative trend context, deliberately
              placed after the cash/**หมายเหตุ box (which carries the actual
              banking figure the office needs) and before รายการอื่นๆ/the
              footer, which stay the sheet's closing sections. Absent
              entirely when weekDays hasn't loaded yet or failed to load
              (DaySheetPage.tsx never throws on that failure). */}
          {printedWeekDays && printedWeekDays.length === 7 && (
            <div className={BOX}>
              <h2 className={BOX_HEAD}>
                {WEEK_CHART_TITLE_TH}{" "}
                <span className="font-normal text-ink-muted">
                  ({isoToBuddhist(printedWeekDays[0]!.date)}–{isoToBuddhist(printedWeekDays[6]!.date)})
                </span>
              </h2>
              <div
                className="flex items-end justify-between gap-1.5 px-3 pt-3 pb-2"
                style={{ height: WEEK_CHART_PLOT_HEIGHT_PX }}
              >
                {printedWeekDays.every((d) => d.incomeSatang === 0) ? (
                  <div className="flex w-full items-center justify-center text-sm text-ink-muted">-</div>
                ) : (
                  scaleWeekBars(printedWeekDays, WEEK_CHART_BAR_MAX_PX).map((bar, i) => {
                    const isPrintedDate = bar.date === date;
                    // Days AFTER the printed date haven't happened yet —
                    // muted, barless, and blank rather than reading as zero
                    // income (so a Monday printout doesn't look like a week
                    // of six empty days). Past/today zero days keep the
                    // normal (unmuted) zero-bar look.
                    const isFuture = isFutureDay(bar.date, date);
                    const dayOfMonth = Number(bar.date.slice(8, 10));
                    const mutedStyle = { color: "#999" };
                    return (
                      <div key={bar.date} className="flex flex-1 flex-col items-center gap-1">
                        <span className="text-[10px] tabular-nums whitespace-nowrap text-ink-muted">
                          {!isFuture && bar.incomeSatang > 0 ? formatSatang(bar.incomeSatang) : ""}
                        </span>
                        <div
                          className="w-full max-w-[24px]"
                          style={{
                            height: !isFuture && bar.incomeSatang > 0 ? Math.max(bar.heightPx, 2) : 0,
                            backgroundColor: isFuture ? "transparent" : isPrintedDate ? "#000" : "#666",
                          }}
                        />
                        <span
                          className={
                            "text-[10px] " +
                            (isPrintedDate ? "font-bold text-ink" : isFuture ? "" : "font-medium text-ink-muted")
                          }
                          style={isFuture ? mutedStyle : undefined}
                        >
                          {WEEKDAY_LABELS_TH[i]}
                        </span>
                        <span
                          className={
                            "text-[10px] tabular-nums " +
                            (isPrintedDate ? "font-bold text-ink" : isFuture ? "" : "text-ink-muted")
                          }
                          style={isFuture ? mutedStyle : undefined}
                        >
                          {dayOfMonth}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {otherIncome.length > 0 && (
            <div className={BOX}>
              <h2 className={BOX_HEAD}>รายการอื่นๆ</h2>
              <table className="w-full border-separate border-spacing-0">
                <tbody>
                  {otherIncome.map((item) => (
                    <tr key={item.id} className="align-baseline">
                      <td className={ROW_LABEL + " border-b border-line"}>{item.description ?? "-"}</td>
                      <td className="border-b border-line px-2 py-1 text-xs text-ink-muted whitespace-nowrap">
                        {item.isCash ? "เงินสด" : "โอน/เครดิต"}
                      </td>
                      <td className={ROW_AMOUNT + " border-b border-line"}>{formatSatang(item.amountSatang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ReportFooter provenance={provenance} verifiedAt={verifiedAt} verifiedBy={verifiedBy} updatedBy={updatedBy} />
        </div>
      </div>
    );
  },
);
