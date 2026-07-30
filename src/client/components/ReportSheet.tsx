import { forwardRef } from "react";
import { computeBookingTotals, lineArithmeticMismatch } from "../../shared/bookings.ts";
import { isoToThaiLong } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import {
  PROPERTY_LABELS,
  TENDERS,
  type BookingLine,
  type Category,
  type DaySheet,
  type Property,
} from "../../shared/types.ts";
import { CASH_BLOCK_FIELDS, PROVENANCE_LABELS_TH } from "../labels.ts";
import {
  BookingGridColgroup,
  BookingGridFoot,
  BookingGridHead,
  bookingGridWidth,
  countText,
  moneyText,
} from "./bookingGridFrame.tsx";

// The printable day sheet — the filed paper (รายงานรายรับของโรงแรม) rather
// than a phone-sized summary card. Rendered VISIBLE (never offscreen — see
// exportJpeg.ts / ReportPage.tsx) and captured verbatim by html2canvas-pro,
// then shared to LINE as a JPEG.
//
// Layout, top to bottom, mirroring the workbook's own sheet:
//   1. title block  — report name, property, ประจำวันที่ <date in พ.ศ.>
//   2. the booking grid, READ-ONLY, using the SAME three-row grouped header
//      and totals row as the entry screen (components/bookingGridFrame.tsx —
//      one copy, so the two can never drift)
//   3. side by side: สรุปยอดรายรับโรงแรม (+ รายจ่าย) | **หมายเหตุ cash
//      banking block (+ the itemised รายการอื่นๆ entries, when there are any)
//   4. footer: provenance, sign-off, last editor, export stamp
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

interface ReportSheetProps {
  property: Property;
  date: string;
  sheet: DaySheet;
  /** The day's booking rows, in seq order (drafts allowed — they are printed
   * as a footnote count, never as rows). */
  lines: BookingLine[];
}

function activeSorted(categories: Category[], kind: Category["kind"]): Category[] {
  return categories
    .filter((c) => c.kind === kind && c.archivedAt === null)
    .slice()
    .sort((a, b) => a.sort - b.sort);
}

function categoryName(categories: Category[], categoryId: number): string {
  return categories.find((c) => c.id === categoryId)?.nameTh ?? "-";
}

/** "29/7/2569 14:35" — Bangkok wall-clock, Buddhist Era, matching the
 * D/M/YYYY shape of shared date.ts's isoToBuddhist(). Kept local to the
 * report sheet: it stamps a moment in time, not a stored business date, so
 * it doesn't belong in the shared date helpers. */
function bangkokBuddhistStamp(when: Date): string {
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
function storedStamp(stored: string): string {
  const iso = stored.includes("T") ? stored : `${stored.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return stored;
  return bangkokBuddhistStamp(d);
}

// ── Small print primitives ───────────────────────────────────────────────
// Same table idiom as the rest of the app (tint header band, border-line
// rules, ink-muted 12px headers) at print density.

const BOX = "rounded-lg border border-line";
const BOX_HEAD = "border-b border-line bg-tint px-3 py-1.5 text-xs font-semibold text-ink";
const ROW_LABEL = "px-3 py-1 text-sm";
const ROW_AMOUNT = "px-3 py-1 text-right text-sm tabular-nums whitespace-nowrap";

// Read-only grid cells. The frame closes the top and left edges (the cells
// carry bottom + right rules), same trick as the entry grid.
const PCELL = "border-b border-r border-line px-1 py-0.5 align-top text-[11px] leading-snug";
const PNUM = PCELL + " text-right tabular-nums whitespace-nowrap";

export const ReportSheet = forwardRef<HTMLDivElement, ReportSheetProps>(function ReportSheet(
  { property, date, sheet, lines },
  ref,
) {
  const { categories, income, expenses, totals, otherIncome, cashBlock, provenance, verifiedAt, verifiedBy, note, updatedBy } =
    sheet;

  const incomeCategories = activeSorted(categories, "income");
  // An archived category can still carry this day's figures (DaySheet ships
  // any archived category its data references). Printing only the active
  // ones would leave a total that doesn't add up on paper.
  const archivedWithData = categories
    .filter((c) => c.kind === "income" && c.archivedAt !== null && income[c.id] != null)
    .slice()
    .sort((a, b) => a.sort - b.sort);
  const incomeRows = [...incomeCategories, ...archivedWithData];

  // Drafts are proposals, not income: computeBookingTotals() excludes them,
  // so the printed sheet excludes them too and footnotes the count instead.
  const printedLines = lines.filter((line) => !line.draft).slice().sort((a, b) => a.seq - b.seq);
  const draftCount = lines.length - printedLines.length;
  const bookingTotals = computeBookingTotals(lines);
  const anyMismatch = printedLines.some((line) => lineArithmeticMismatch(line));

  // Entered (manager-overridden) figures win over derived, per field — this
  // is the same reading the booking page uses, so the banked figure on the
  // shared JPEG is the one the manager actually recorded.
  const cash = CASH_BLOCK_FIELDS.map(({ key, label }) => {
    const derived = cashBlock.derived[key];
    const entered = cashBlock.entered?.[key];
    return { key, label, shown: entered ?? derived, derived, overridden: entered != null && entered !== derived };
  });
  const bankedOverridden = cash.some((row) => row.key === "bankedSatang" && row.overridden);

  return (
    <div ref={ref} className="bg-white text-ink" style={{ width: REPORT_SHEET_WIDTH }}>
      <div className="h-1 bg-brand-800" />
      <div className="h-0.5 bg-gold-500" />

      <div className="py-6" style={{ paddingLeft: SHEET_PADDING, paddingRight: SHEET_PADDING }}>
        {/* 1. Title block — the way the workbook heads each sheet. */}
        <header className="mb-4 text-center">
          <h1 className="text-lg font-bold text-brand-800">รายงานรายรับของโรงแรม</h1>
          <div className="text-sm font-semibold text-ink">{PROPERTY_LABELS[property].th}</div>
          <div className="text-sm text-ink-muted">ประจำวันที่ {isoToThaiLong(date)}</div>
        </header>

        {/* 2. The booking grid, read-only, same frame as the entry screen. */}
        <section className="mb-5">
          <h2 className="mb-1 text-xs font-semibold text-ink-muted">รายการจอง</h2>
          <div className="border-t border-l border-line">
            <table
              className="border-separate border-spacing-0 bg-white"
              style={{ width: PRINT_TABLE_WIDTH, tableLayout: "fixed" }}
            >
              <BookingGridColgroup scale={PRINT_SCALE} />
              <BookingGridHead compact />
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
                    {TENDERS.map((tender) => (
                      <td key={tender} className={PNUM}>
                        {moneyText(line.tenders[tender])}
                      </td>
                    ))}
                    <td className={PCELL + " break-words"}>{line.remark ?? ""}</td>
                  </tr>
                ))}
              </tbody>
              <BookingGridFoot totals={bookingTotals} compact />
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

        {/* 3. Summary categories | cash-banking block. */}
        <div className="flex items-start gap-4">
          {/* สรุปยอดรายรับโรงแรม (+ รายจ่าย) */}
          <div className="flex-1">
            <div className={BOX}>
              <h2 className={BOX_HEAD}>สรุปยอดรายรับโรงแรม</h2>
              <table className="w-full border-separate border-spacing-0">
                <tbody>
                  {incomeRows.map((cat) => {
                    const cell = income[cat.id];
                    return (
                      <tr key={cat.id} className="align-baseline">
                        <td className={ROW_LABEL + " border-b border-line"}>
                          {cat.nameTh}
                          {cat.archivedAt !== null && (
                            <span className="ml-1 text-xs text-ink-muted">(เลิกใช้)</span>
                          )}
                          {cell?.note ? (
                            <span className="ml-1 text-xs italic text-ink-muted">{cell.note}</span>
                          ) : null}
                        </td>
                        <td className={ROW_AMOUNT + " border-b border-line"}>
                          {cell ? formatSatang(cell.amountSatang) : "-"}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td className={ROW_LABEL + " font-bold"}>รวมรายรับ</td>
                    <td className={ROW_AMOUNT + " font-bold"}>{formatSatang(totals.incomeSatang)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {expenses.length > 0 && (
              <div className={BOX + " mt-3"}>
                <h2 className={BOX_HEAD}>รายจ่าย</h2>
                <table className="w-full border-separate border-spacing-0">
                  <tbody>
                    {expenses.map((item) => (
                      <tr key={item.id} className="align-baseline">
                        <td className={ROW_LABEL + " border-b border-line"}>
                          {categoryName(categories, item.categoryId)}
                          {item.note ? <span className="text-ink-muted"> - {item.note}</span> : null}
                        </td>
                        <td className={ROW_AMOUNT + " border-b border-line"}>
                          {formatSatang(item.amountSatang)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className={ROW_LABEL + " font-bold"}>รวมรายจ่าย</td>
                      <td className={ROW_AMOUNT + " font-bold"}>{formatSatang(totals.expenseSatang)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* **หมายเหตุ (สรุปเงินสด) + รายการอื่นๆ */}
          <div className="flex-1">
            <div className={BOX + " bg-tint"}>
              <h2 className={BOX_HEAD}>**หมายเหตุ (สรุปเงินสด)</h2>
              <div className="px-3 py-2">
                {cash.map((row) => (
                  <div
                    key={row.key}
                    className={
                      "flex items-baseline justify-between gap-3 py-0.5 " +
                      (row.key === "bankedSatang" ? "mt-1 border-t border-line-strong pt-1.5" : "")
                    }
                  >
                    <span
                      className={
                        row.key === "bankedSatang" ? "text-sm font-bold text-brand-500" : "text-sm text-ink"
                      }
                    >
                      {/* The paper's own สรุปเงินสดฝากเข้าบัญชี line is the
                          GROSS cash banked; see src/shared/api.md "Report
                          labeling". It must never collapse into the netted
                          figure printed below it. */}
                      {row.key === "bankedSatang" ? `${row.label} (ยอดฝากจริง)` : row.label}
                      {row.overridden && (
                        <span className="ml-1.5 text-xs font-normal text-ink-muted">
                          (ปรับจาก {formatSatang(row.derived)})
                        </span>
                      )}
                    </span>
                    <span
                      className={
                        "tabular-nums whitespace-nowrap " +
                        (row.key === "bankedSatang" ? "text-base font-bold text-brand-500" : "text-sm")
                      }
                    >
                      {formatSatang(row.shown)}
                    </span>
                  </div>
                ))}

                <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-dotted border-line-strong pt-1.5 text-xs text-ink-muted">
                  <span>หัก รายจ่ายเงินสดวันนี้ (ไม่ได้หักออกจากยอดฝากข้างต้น)</span>
                  <span className="tabular-nums whitespace-nowrap">-{formatSatang(totals.cashExpenseSatang)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3 text-xs font-medium text-ink-muted">
                  <span>คงเหลือสุทธิหลังหักรายจ่ายเงินสด (ข้อมูลอ้างอิง)</span>
                  <span className="tabular-nums whitespace-nowrap">{formatSatang(totals.cashToDepositSatang)}</span>
                </div>
                {bankedOverridden && (
                  <p className="mt-1 text-[11px] leading-snug text-ink-muted">
                    ยอดฝากปรับโดยผู้จัดการ - ยอดคงเหลือสุทธิด้านบนคำนวณจากยอดเงินสดตามหมวดหมู่ (
                    {formatSatang(totals.cashIncomeSatang)})
                  </p>
                )}
                {note && (
                  <p className="mt-2 border-t border-line pt-1.5 text-xs leading-snug text-ink">
                    <span className="font-semibold">หมายเหตุประจำวัน: </span>
                    {note}
                  </p>
                )}
              </div>
            </div>

            {otherIncome.length > 0 && (
              <div className={BOX + " mt-3"}>
                <h2 className={BOX_HEAD}>รายการอื่นๆ</h2>
                <table className="w-full border-separate border-spacing-0">
                  <tbody>
                    {otherIncome.map((item) => (
                      <tr key={item.id} className="align-baseline">
                        <td className={ROW_LABEL + " border-b border-line"}>{item.description ?? "-"}</td>
                        <td className="border-b border-line px-2 py-1 text-xs text-ink-muted whitespace-nowrap">
                          {item.isCash ? "เงินสด" : "โอน/เครดิต"}
                        </td>
                        <td className={ROW_AMOUNT + " border-b border-line"}>
                          {formatSatang(item.amountSatang)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* 4. Provenance / sign-off / who touched it last. */}
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
      </div>
    </div>
  );
});
