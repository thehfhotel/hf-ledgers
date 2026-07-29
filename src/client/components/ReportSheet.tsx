import { forwardRef } from "react";
import { isoToThaiLong } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import { PROPERTY_LABELS, type Category, type DaySheet, type Property } from "../../shared/types.ts";

// The exported day-report sheet. Fixed 720px-wide white sheet rendered
// VISIBLE (never offscreen — see exportJpeg.ts / ReportPage.tsx), captured
// verbatim by html2canvas-pro. Layout is paper-faithful to the front
// desk's old handwritten sheet (สรุปยอดรายรับโรงแรม): all active income
// categories in sort order, blanks render as "-", a bold double-rule
// total, an itemized expense section (only when there are expenses), and
// a tinted cash-deposit summary box.

export const REPORT_SHEET_WIDTH = 720;

interface ReportSheetProps {
  property: Property;
  date: string;
  sheet: DaySheet;
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

/** "29/7/2569 14:35" — Bangkok wall-clock time of export, Buddhist Era,
 * matching the D/M/YYYY shape of shared date.ts's isoToBuddhist(). Kept
 * local to the report sheet: it stamps "now", not a stored business date,
 * so it doesn't belong in the shared date helpers. */
function nowBangkokBuddhist(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const buddhistYear = Number(get("year")) + 543;
  return `${get("day")}/${get("month")}/${buddhistYear} ${get("hour")}:${get("minute")}`;
}

export const ReportSheet = forwardRef<HTMLDivElement, ReportSheetProps>(function ReportSheet(
  { property, date, sheet },
  ref,
) {
  const { categories, income, expenses, totals, updatedBy } = sheet;
  const incomeCategories = activeSorted(categories, "income");

  const cashIncomeLines = incomeCategories
    .filter((cat) => cat.isCash)
    .map((cat) => ({ cat, cell: income[cat.id] }))
    .filter((row): row is { cat: Category; cell: NonNullable<(typeof row)["cell"]> } => row.cell != null);

  return (
    <div ref={ref} className="bg-white text-ink" style={{ width: REPORT_SHEET_WIDTH }}>
      <div className="h-1 bg-brand-800" />
      <div className="h-0.5 bg-gold-500" />

      <div className="px-10 py-8">
        <header className="mb-6">
          <div className="text-sm font-medium text-ink-muted">{PROPERTY_LABELS[property].th}</div>
          <h1 className="mt-1 text-xl font-bold text-brand-800">สรุปยอดรายรับ-รายจ่ายประจำวัน</h1>
          <div className="mt-1 text-sm text-ink-muted">{isoToThaiLong(date)}</div>
        </header>

        <section className="mb-6">
          <h2 className="mb-1 text-sm font-semibold text-ink">รายรับ</h2>
          <div>
            {incomeCategories.map((cat) => {
              const cell = income[cat.id];
              return (
                <div key={cat.id}>
                  <div className="flex items-baseline justify-between border-b border-dotted border-line-strong py-1.5">
                    <span className="text-sm">{cat.nameTh}</span>
                    <span className="tabular-nums text-sm">
                      {cell ? formatSatang(cell.amountSatang) : "-"}
                    </span>
                  </div>
                  {cell?.note ? (
                    <div className="-mt-0.5 pb-1 pl-2 text-xs italic text-ink-muted">{cell.note}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex items-baseline justify-between border-t-4 border-double border-ink pt-2">
            <span className="text-sm font-bold">รวมรายรับ</span>
            <span className="tabular-nums text-sm font-bold">{formatSatang(totals.incomeSatang)}</span>
          </div>
        </section>

        {expenses.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-1 text-sm font-semibold text-ink">รายจ่าย</h2>
            <div>
              {expenses.map((item) => (
                <div
                  key={item.id}
                  className="flex items-baseline justify-between border-b border-dotted border-line-strong py-1.5"
                >
                  <span className="text-sm">
                    {categoryName(categories, item.categoryId)}
                    {item.note ? <span className="text-ink-muted"> - {item.note}</span> : null}
                  </span>
                  <span className="tabular-nums text-sm">{formatSatang(item.amountSatang)}</span>
                </div>
              ))}
            </div>
            <div className="mt-1 flex items-baseline justify-between border-t border-ink pt-2">
              <span className="text-sm font-bold">รวมรายจ่าย</span>
              <span className="tabular-nums text-sm font-bold">{formatSatang(totals.expenseSatang)}</span>
            </div>
          </section>
        )}

        <section className="rounded-lg border border-line bg-tint px-4 py-3">
          <h3 className="mb-2 text-sm font-semibold text-ink">สรุปเงินสดฝากเข้าบัญชี</h3>
          <div>
            {cashIncomeLines.map(({ cat, cell }) => (
              <div key={cat.id} className="flex items-baseline justify-between py-0.5 text-sm">
                <span>{cat.nameTh}</span>
                <span className="tabular-nums">{formatSatang(cell.amountSatang)}</span>
              </div>
            ))}
            {totals.cashExpenseSatang > 0 && (
              <div className="flex items-baseline justify-between py-0.5 text-sm text-bad">
                <span>หัก รายจ่ายเงินสด</span>
                <span className="tabular-nums">-{formatSatang(totals.cashExpenseSatang)}</span>
              </div>
            )}
          </div>
          <div className="mt-2 flex items-baseline justify-between border-t border-line-strong pt-2">
            <span className="text-sm font-bold text-brand-500">รวมฝากเข้าบัญชี</span>
            <span className="tabular-nums text-lg font-bold text-brand-500">
              {formatSatang(totals.cashToDepositSatang)}
            </span>
          </div>
        </section>

        <footer className="mt-6 text-[11px] text-ink-muted">
          บันทึกโดย {updatedBy} - ออกรายงาน {nowBangkokBuddhist()}
        </footer>
      </div>
    </div>
  );
});
