import { isoToThaiLong } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import {
  PROPERTY_LABELS,
  type CashBlock,
  type Category,
  type DayProvenance,
  type DayTotals,
  type ExpenseItem,
  type IncomeCell,
  type OtherIncomeItem,
  type Property,
} from "../../shared/types.ts";
import { CASH_BLOCK_FIELDS, PROVENANCE_LABELS_TH } from "../labels.ts";

// Read-only report building blocks shared by the two printable renderings
// of a day's data:
//   - ReportSheet.tsx (full paper form: booking grid + this) — JPEG export
//     (ReportPage.tsx) and BookingDayPage's "bookingsOnly" print/PDF.
//   - PrintableDaySummary.tsx (DaySheetPage's print/PDF — no booking grid).
// One copy of each block so the two renderings can never drift into two
// different figures or wordings for the same day (see CLAUDE.md: never
// invent new wording for things that already have canonical strings).

export const BOX = "rounded-lg border border-line";
export const BOX_HEAD = "border-b border-line bg-tint px-3 py-1.5 text-xs font-semibold text-ink";
export const ROW_LABEL = "px-3 py-1 text-sm";
export const ROW_AMOUNT = "px-3 py-1 text-right text-sm tabular-nums whitespace-nowrap";

export function activeSorted(categories: Category[], kind: Category["kind"]): Category[] {
  return categories
    .filter((c) => c.kind === kind && c.archivedAt === null)
    .slice()
    .sort((a, b) => a.sort - b.sort);
}

export function categoryName(categories: Category[], categoryId: number): string {
  return categories.find((c) => c.id === categoryId)?.nameTh ?? "-";
}

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
  /** ONE line ("รายงานรายรับของโรงแรม {short} ประจำวันที่ {date}") instead
   * of the paper form's 3 stacked centered lines — for print/PDF output
   * only, where vertical space is scarce. ReportPage's JPEG export (the
   * familiar paper-photo look) never sets this; it keeps the stacked
   * default. See BookingDayPage.tsx (ReportSheet's inlineTitle prop) and
   * PrintableDaySummary.tsx (always inline — it is print-only). */
  inline?: boolean;
}

export function ReportSheetTitle({ property, date, demo = false, inline = false }: ReportSheetTitleProps) {
  if (inline) {
    const short = shortPropertyLabel(property);
    return (
      <header className="mb-4 text-center">
        <h1 className="text-lg font-bold text-brand-800">
          {`รายงานรายรับของโรงแรม ${short}${demo ? " (ตัวอย่าง)" : ""} ประจำวันที่ ${isoToThaiLong(date)}`}
        </h1>
      </header>
    );
  }
  return (
    <header className="mb-4 text-center">
      <h1 className="text-lg font-bold text-brand-800">รายงานรายรับของโรงแรม</h1>
      <div className="text-sm font-semibold text-ink">
        {PROPERTY_LABELS[property].th}
        {demo && <span className="ml-1 font-normal text-ink-muted">(ตัวอย่าง)</span>}
      </div>
      <div className="text-sm text-ink-muted">ประจำวันที่ {isoToThaiLong(date)}</div>
    </header>
  );
}

// ── สรุปยอดรายรับโรงแรม + รายจ่าย ──────────────────────────────────────

export interface IncomeExpenseSummaryCardProps {
  categories: Category[];
  income: Record<number, IncomeCell>;
  expenses: ExpenseItem[];
  totals: DayTotals;
}

export function IncomeExpenseSummaryCard({ categories, income, expenses, totals }: IncomeExpenseSummaryCardProps) {
  const incomeCategories = activeSorted(categories, "income");
  // An archived category can still carry this day's figures (DaySheet ships
  // any archived category its data references). Printing only the active
  // ones would leave a total that doesn't add up on paper.
  const archivedWithData = categories
    .filter((c) => c.kind === "income" && c.archivedAt !== null && income[c.id] != null)
    .slice()
    .sort((a, b) => a.sort - b.sort);
  const incomeRows = [...incomeCategories, ...archivedWithData];

  return (
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
                    {cell?.note ? <span className="ml-1 text-xs italic text-ink-muted">{cell.note}</span> : null}
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
                  <td className={ROW_AMOUNT + " border-b border-line"}>{formatSatang(item.amountSatang)}</td>
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
  );
}

// ── **หมายเหตุ (สรุปเงินสด) + รายการอื่นๆ + หมายเหตุประจำวัน ───────────

export interface CashSummaryCardProps {
  cashBlock: CashBlock;
  totals: DayTotals;
  note: string | null;
  otherIncome: OtherIncomeItem[];
}

export function CashSummaryCard({ cashBlock, totals, note, otherIncome }: CashSummaryCardProps) {
  // Entered (manager-overridden) figures win over derived, per field — the
  // same reading the booking page uses, so the banked figure on the
  // printed/exported sheet is the one the manager actually recorded.
  const cash = CASH_BLOCK_FIELDS.map(({ key, label }) => {
    const derived = cashBlock.derived[key];
    const entered = cashBlock.entered?.[key];
    return { key, label, shown: entered ?? derived, derived, overridden: entered != null && entered !== derived };
  });
  const bankedOverridden = cash.some((row) => row.key === "bankedSatang" && row.overridden);

  return (
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
                className={row.key === "bankedSatang" ? "text-sm font-bold text-brand-500" : "text-sm text-ink"}
              >
                {/* The paper's own สรุปเงินสดฝากเข้าบัญชี line is the GROSS
                    cash banked; see src/shared/api.md "Report labeling". It
                    must never collapse into the netted figure printed
                    below it. */}
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
                  <td className={ROW_AMOUNT + " border-b border-line"}>{formatSatang(item.amountSatang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
