import { Fragment } from "react";
import { isoToBuddhist, isoToThaiLong } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import {
  PROPERTY_LABELS,
  type DayProvenance,
  type DaySheet,
  type Property,
} from "../../shared/types.ts";
import { CASH_BLOCK_FIELDS, PROVENANCE_LABELS_TH } from "../labels.ts";
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

// Read-only report building blocks shared by the printable renderings of a
// day's data:
//   - ReportSheet.tsx (full paper form: booking grid + this) — JPEG export
//     (ReportPage.tsx) and BookingDayPage's "bookingsOnly" print/PDF.
//   - PrintableDaySummary.tsx (DaySheetPage's print/PDF — no booking grid).
// One copy of each block so every rendering that DOES use it can never
// drift into two different figures or wordings for the same day (see
// CLAUDE.md: never invent new wording for things that already have
// canonical strings).
//
// ONE LAYOUT FOR ALL THREE EXPORTS (owner decision, 2026-07-31): the day
// summary is DayTenderSummary below — groups income by tender (cash /
// transfer / card / web, see printDayIncomeGrouping.ts) instead of a flat
// per-category list, and carries no expense section at all (the expense
// section is gone everywhere, not just here). PrintableDaySummary.tsx
// renders it exactly as DaySheetPage's print/PDF always has; ReportSheet.tsx's
// "full" variant (ReportPage's JPEG export) now renders the SAME component
// after its booking grid, so print, PDF, and JPEG can never drift into three
// different layouts again. The old flat-list IncomeExpenseSummaryCard /
// CashSummaryCard pair that used to live here (with its own itemized
// รายจ่าย section) is retired; ReportSheet's "bookingsOnly" variant never
// rendered either card, so it is unaffected. ReportFooter, ReportSheetTitle,
// and the BOX/ROW_* primitives stay genuinely shared across every rendering.

export const BOX = "rounded-lg border border-line";
export const BOX_HEAD = "border-b border-line bg-tint px-3 py-1.5 text-xs font-semibold text-ink";
export const ROW_LABEL = "px-3 py-1 text-sm";
export const ROW_AMOUNT = "px-3 py-1 text-right text-sm tabular-nums whitespace-nowrap";

/** The หมายเหตุ (สรุปเงินสด) box only — the ONE box on the sheet meant to
 * visually jump out (it carries the bank-deposit figure the office actually
 * needs), never the ordinary section boxes above (สรุปยอดรายรับ, the weekly
 * chart, รายการอื่นๆ — those stay on BOX/BOX_HEAD's tint, unchanged). Per
 * design/HF-ONE.md (the estate-wide contract): `--hf-panel-tint` (this app's
 * `--color-tint`, what BOX_HEAD uses) is documented for "table headers,
 * wells" — a background for ORDINARY structure, not emphasis — while gold is
 * documented as "jewellery... one highlight per screen", exactly this box's
 * job. Using the panel-tint for both made every box read as equally (un)
 * emphasized: --color-tint (#f4f1ed) sits only ~11-18 RGB units off white
 * (contrast ratio ~1.06:1) and the box's own border (border-line, #e8e4df)
 * sits only ~12-14 units off ITS fill — a delta small enough to read fine in
 * a lossless on-screen screenshot (as reported) but that further compression
 * (a JPEG re-encode, print rasterisation, a phone screen) can wash out
 * entirely, which is exactly the "screenshot looks right, the real export
 * doesn't" gap that was reported. Gold-100/gold-300 keep the same warm,
 * on-brand neutral family (never grayscale) but widen both deltas
 * substantially (RGB delta to white ~9-52, fill-to-border delta ~15-76),
 * so the emphasis survives every capture path, not just a raw screenshot. */
const HIGHLIGHT_BOX = "rounded-lg border border-gold-300 bg-gold-100";
const HIGHLIGHT_BOX_HEAD = "border-b border-gold-300 bg-gold-100 px-3 py-1.5 text-xs font-semibold text-ink";

/** "29/7/2569 14:35" — Bangkok wall-clock, Buddhist Era, matching the
 * D/M/YYYY shape of shared date.ts's isoToBuddhist(). Kept local to the
 * report blocks (not shared date.ts): it stamps a moment in time, not a
 * stored business date. */
export function bangkokBuddhistStamp(when: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(when);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const buddhistYear = Number(get("year")) + 543;
  return `${get("day")}/${get("month")}/${buddhistYear} ${get("hour")}:${get("minute")}`;
}

/** Stored audit timestamps are UTC, either ISO or "YYYY-MM-DD HH:MM:SS". */
export function storedStamp(stored: string): string {
  const iso = stored.includes("T") ? stored : `${stored.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return stored;
  return bangkokBuddhistStamp(d);
}

// ── Title block ────────────────────────────────────────────────────────

/** PROPERTY_LABELS[property].th with a leading "โรงแรม " stripped, e.g.
 * "โรงแรม HF" -> "HF" ("HF วิลล์" has no such prefix and passes through
 * unchanged). Only used by the inline title below: it opens with
 * "รายงานรายรับของโรงแรม" itself, so printing the full label after it
 * would read "...ของโรงแรม โรงแรม HF". */
function shortPropertyLabel(property: Property): string {
  const th = PROPERTY_LABELS[property].th;
  const prefix = "โรงแรม ";
  return th.startsWith(prefix) ? th.slice(prefix.length) : th;
}

export interface ReportSheetTitleProps {
  property: Property;
  date: string;
  /** Marks the header "(ตัวอย่าง)", same wording as PropertyBadge's demo
   * flag — for a /demo print/PDF, so demo output is never mistaken for a
   * real property's report. */
  demo?: boolean;
}

/** ONE line ("รายงานรายรับของโรงแรม {short} ประจำวันที่ {date}") — the ONLY
 * title form every export renders (owner decision, 2026-07-31: ReportSheet's
 * "full" variant/JPEG export switched from the paper form's 3 stacked
 * centered lines to this, matching PrintableDaySummary.tsx's print/PDF and
 * ReportSheet's "bookingsOnly" print/PDF, both already inline). The stacked
 * 3-line form this replaced is retired — nothing renders it any more. */
export function ReportSheetTitle({ property, date, demo = false }: ReportSheetTitleProps) {
  const short = shortPropertyLabel(property);
  return (
    <header className="mb-4 text-center">
      <h1 className="text-lg font-bold text-brand-800">
        {`รายงานรายรับของโรงแรม ${short}${demo ? " (ตัวอย่าง)" : ""} ประจำวันที่ ${isoToThaiLong(date)}`}
      </h1>
    </header>
  );
}

// ── Tender-grouped day summary (สรุปยอดรายรับ + **หมายเหตุ + weekly chart +
//    รายการอื่นๆ) ─────────────────────────────────────────────────────────
//
// The ONE layout every export renders for a day's summary (see the module
// comment above): the owner found the flat 14-category list confusing on
// paper, so this groups the same income cells by HOW the money arrived
// (cash / transfer / card / web — see printDayIncomeGrouping.ts) and drops
// the itemized-expense section entirely. Only the wording/figures below
// that come from elsewhere (the bank line and any manager-overridden cash
// component line beneath it, the day note, the itemised รายการอื่นๆ list)
// are reused via CASH_BLOCK_FIELDS/BOX/ROW_* — never re-typed.

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

export interface DayTenderSummaryProps {
  /** The day this summary describes — drives the weekly chart's "printed
   * date" bar highlighting/override, not otherwise displayed here (the
   * title carries the date). */
  date: string;
  sheet: DaySheet;
  /** The Monday-start calendar week containing `date`, zero-filled to
   * exactly 7 entries (see DaySheetPage.tsx / printWeekChart.ts). Absent
   * (undefined) while loading or after a fetch failure — the chart section
   * simply doesn't render rather than breaking the rest of the summary. */
  weekDays?: WeekDayIncome[];
}

export function DayTenderSummary({ date, sheet, weekDays }: DayTenderSummaryProps) {
  const { totals, cashBlock, otherIncome, note } = sheet;
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
  // banked figure on the printed/exported sheet is the one the manager
  // actually recorded.
  const bankedDerived = cashBlock.derived.bankedSatang;
  const bankedEntered = cashBlock.entered?.bankedSatang;
  const bankedShown = bankedEntered ?? bankedDerived;
  const bankedOverridden = bankedEntered != null && bankedEntered !== bankedDerived;
  // Falls back to the field's own (never-changing) Thai wording rather
  // than a `.find(...)!` assertion — a future edit to CASH_BLOCK_FIELDS
  // that drops/renames the key must not crash the whole summary.
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

  // The chart bar for `date` always reflects the LIVE sheet totals, never
  // the possibly-stale value the caller's listDays() fetch captured at load
  // time (see printWeekChart.ts's overrideDayIncome) — editing income and
  // then printing/exporting must never show two different figures for the
  // same day on one page.
  const printedWeekDays = weekDays ? overrideDayIncome(weekDays, date, totals.incomeSatang) : undefined;

  return (
    <>
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
                visible, not silently swallowed. */}
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

      <div className={HIGHLIGHT_BOX}>
        <h2 className={HIGHLIGHT_BOX_HEAD}>**หมายเหตุ (สรุปเงินสด)</h2>
        <div className="px-3 py-2">
          {/* Manager cash overrides MUST show: when the till was counted
              short/over and a component (room/other/bar cash) was
              adjusted, that adjustment has to be visible, not just folded
              into the bank total below — same rule BookingDayPage's
              cash-block panel already enforces on screen. Silent in the
              common (no override) case. */}
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
          banking figure the office needs) and before รายการอื่นๆ, which
          stays the last section here (the footer is the caller's own,
          rendered after this component). Absent entirely when weekDays
          hasn't loaded yet or failed to load (DaySheetPage.tsx never
          throws on that failure). */}
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
    </>
  );
}

// ── Provenance / sign-off / who touched it last ──────────────────────────

export interface ReportFooterProps {
  provenance: DayProvenance;
  verifiedAt: string | null;
  verifiedBy: string | null;
  updatedBy: string;
}

export function ReportFooter({ provenance, verifiedAt, verifiedBy, updatedBy }: ReportFooterProps) {
  return (
    <footer className="mt-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line pt-2 text-[11px] text-ink-muted">
      <span>ที่มาของข้อมูล: {PROVENANCE_LABELS_TH[provenance]}</span>
      <span>
        {verifiedAt
          ? `ยืนยันแล้วโดย ${verifiedBy ?? "-"} เมื่อ ${storedStamp(verifiedAt)}`
          : "ยังไม่ยืนยันข้อมูล"}
      </span>
      <span>บันทึกล่าสุดโดย {updatedBy}</span>
      <span>ออกรายงาน {bangkokBuddhistStamp(new Date())}</span>
    </footer>
  );
}
