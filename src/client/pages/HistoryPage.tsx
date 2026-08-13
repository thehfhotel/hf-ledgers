import { useEffect, useMemo, useRef, useState } from "react";
import { RECONCILE_TOLERANCE_SATANG, deriveIncomeFromBookings } from "../../shared/bookings.ts";
import {
  currentMonthBangkok,
  isoToBuddhist,
  monthToThaiLong,
  shiftMonths,
  todayBangkok,
} from "../../shared/date.ts";
import { formatSatang } from "@shared/money.ts";
import { TENDER_TO_CATEGORY_KEY, type CategoryKey, type DaySummary, type Property } from "../../shared/types.ts";
import { getDay, getMonthClose, listBookingLines, listDays, putMonthClose } from "../api.ts";
import { navigate } from "../App.tsx";
import { PROVENANCE_LABELS_TH, PROVENANCE_SHORT_TH } from "../labels.ts";
import { PropertyBadge } from "./PropertyBadge.tsx";

interface Props {
  property: Property;
}

const WEEKDAYS_TH = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

function weekdayTh(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAYS_TH[new Date(y!, m! - 1, d!).getDay()]!;
}

function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  // Day 0 of the NEXT month is the last day of this one.
  return new Date(y!, m!, 0).getDate();
}

function isoForDayOfMonth(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, "0")}`;
}

/**
 * One line of the month table. `summary` is null for a day the ledger has no
 * data for at all — those days are rendered, not omitted, because a day
 * nobody entered is exactly the failure the old workbooks had (the Excel
 * import found real gaps: 30 May 2025 has no sheet in any workbook while the
 * front-desk report shows takings for it). A day AFTER today is a normal
 * empty future day, not a gap.
 */
interface MonthRow {
  date: string;
  summary: DaySummary | null;
  isFuture: boolean;
  isToday: boolean;
}

// ── Close preflight ──────────────────────────────────────────────────────
// Closing a month is the office's monthly ritual, so the dialog first says
// what the month still has outstanding. It WARNS, never blocks: a month with
// leftovers can still be closed (and reopened) — the point is that nobody
// files a bad month without having been told.

/** The seven income categories a booking row can derive (see
 * TENDER_TO_CATEGORY_KEY). Tender "other" has no CategoryKey, and bar /
 * รายการอื่นๆ income has no booking column at all, so both sides of the
 * variance are summed over THIS set only — otherwise every day with bar
 * sales would look like a mismatch. */
const DERIVABLE_CATEGORY_KEYS: CategoryKey[] = [
  ...new Set(Object.values(TENDER_TO_CATEGORY_KEY) as CategoryKey[]),
];

interface VarianceDay {
  date: string;
  /** derived-from-bookings minus typed-into-the-summary, in satang. */
  varianceSatang: number;
}

interface PreflightState {
  running: boolean;
  checked: number;
  total: number;
  variance: VarianceDay[];
  /** Days whose variance check failed outright (network/500) — reported so a
   * clean-looking preflight can never be a silently incomplete one. */
  failed: string[];
}

/**
 * Booking-derived income minus the typed summary income for one day, over
 * DERIVABLE_CATEGORY_KEYS. Same comparison the booking page's variance strip
 * makes, computed with the SAME shared function (deriveIncomeFromBookings) —
 * but deliberately NOT via `POST fill-from-bookings` preview: that endpoint
 * reports `afterSatang === beforeSatang` for any cell flagged `manual`, and
 * the Excel importer stamped every backfilled cell manual, so the preview
 * reads 0 variance on precisely the 772 days this preflight exists for.
 *
 * A day with no booking lines has no derived side and is never a variance —
 * it is a summary-only day, which the ที่มา column already reports.
 */
async function dayVarianceSatang(property: Property, date: string): Promise<number> {
  const sheet = await getDay(property, date);
  if (sheet.bookingLineCount === 0) return 0;

  const { lines } = await listBookingLines(property, date);
  const derived = deriveIncomeFromBookings(lines);

  const categoryKeyById = new Map(sheet.categories.map((c) => [c.id, c.categoryKey]));
  let derivedSatang = 0;
  let typedSatang = 0;
  for (const key of DERIVABLE_CATEGORY_KEYS) derivedSatang += derived[key] ?? 0;
  for (const cell of Object.values(sheet.income)) {
    const key = categoryKeyById.get(cell.categoryId);
    if (key && DERIVABLE_CATEGORY_KEYS.includes(key)) typedSatang += cell.amountSatang;
  }
  return derivedSatang - typedSatang;
}

/** Sequential-ish scan with a small pool: a month is at most 31 days, and
 * the office runs this on a shared desktop — 31 simultaneous requests would
 * be rude to a Bun server that is also serving the rest of the estate. */
const PREFLIGHT_CONCURRENCY = 5;

export function HistoryPage({ property }: Props) {
  const [month, setMonth] = useState(currentMonthBangkok());
  const [days, setDays] = useState<DaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<null | "close" | "reopen">(null);
  const [preflight, setPreflight] = useState<PreflightState | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  // Bumped whenever a preflight scan must abandon its in-flight results
  // (dialog closed, month switched) — the scan checks it between days.
  const scanToken = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setDays(null);
    setError(null);
    setClosed(null);
    setDialog(null);
    setPreflight(null);
    setCloseError(null);
    scanToken.current += 1;

    listDays(property, month)
      .then((res) => {
        if (!cancelled) setDays(res.days);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      });

    getMonthClose(property, month)
      .then((res) => {
        if (!cancelled) setClosed(res.closed);
      })
      .catch(() => {
        /* the close state is a badge + a control; failing to read it just
           leaves both out rather than blocking the month list */
      });

    return () => {
      cancelled = true;
    };
  }, [property, month]);

  const today = todayBangkok();
  const isCurrentMonth = month === currentMonthBangkok();
  const monthLabel = monthToThaiLong(month);

  // Full calendar month, newest first (same order GET /days returns).
  const rows = useMemo<MonthRow[]>(() => {
    const byDate = new Map((days ?? []).map((d) => [d.date, d]));
    const out: MonthRow[] = [];
    for (let day = daysInMonth(month); day >= 1; day--) {
      const date = isoForDayOfMonth(month, day);
      out.push({
        date,
        summary: byDate.get(date) ?? null,
        isFuture: date > today,
        isToday: date === today,
      });
    }
    return out;
  }, [days, month, today]);

  const unverifiedDates = useMemo(
    () => (days ?? []).filter((d) => !d.verified).map((d) => d.date).sort(),
    [days],
  );
  /** Gaps only: a day past (or on) today with no data at all. Future days of
   * the current month are empty by nature, not missing. */
  const missingDates = useMemo(
    () => rows.filter((r) => !r.summary && !r.isFuture).map((r) => r.date).sort(),
    [rows],
  );

  function openCloseDialog() {
    if (!days) return;
    setCloseError(null);
    setDialog("close");

    const dates = days.map((d) => d.date);
    const token = ++scanToken.current;
    setPreflight({ running: true, checked: 0, total: dates.length, variance: [], failed: [] });
    if (dates.length === 0) {
      setPreflight({ running: false, checked: 0, total: 0, variance: [], failed: [] });
      return;
    }

    let next = 0;
    const workers = Array.from({ length: Math.min(PREFLIGHT_CONCURRENCY, dates.length) }, async () => {
      while (scanToken.current === token) {
        const index = next++;
        if (index >= dates.length) return;
        const date = dates[index]!;
        try {
          const varianceSatang = await dayVarianceSatang(property, date);
          if (scanToken.current !== token) return;
          setPreflight((prev) =>
            prev
              ? {
                  ...prev,
                  checked: prev.checked + 1,
                  variance:
                    Math.abs(varianceSatang) > RECONCILE_TOLERANCE_SATANG
                      ? [...prev.variance, { date, varianceSatang }]
                      : prev.variance,
                }
              : prev,
          );
        } catch {
          if (scanToken.current !== token) return;
          setPreflight((prev) =>
            prev ? { ...prev, checked: prev.checked + 1, failed: [...prev.failed, date] } : prev,
          );
        }
      }
    });

    void Promise.all(workers).then(() => {
      if (scanToken.current !== token) return;
      setPreflight((prev) => (prev ? { ...prev, running: false } : prev));
    });
  }

  function openReopenDialog() {
    setCloseError(null);
    setPreflight(null);
    setDialog("reopen");
  }

  function closeDialog() {
    scanToken.current += 1;
    setDialog(null);
    setPreflight(null);
    setCloseError(null);
  }

  async function confirmClose(nextClosed: boolean) {
    setCloseBusy(true);
    setCloseError(null);
    try {
      const res = await putMonthClose(property, month, nextClosed);
      setClosed(res.closed);
      scanToken.current += 1;
      setDialog(null);
      setPreflight(null);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setCloseBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full max-w-sm items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2">
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonths(m, -1))}
          aria-label="เดือนก่อนหน้า"
          className="rounded-md border border-line-strong px-2.5 py-1.5 text-sm leading-none hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        >
          ‹
        </button>
        <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          {monthLabel}
          <PropertyBadge property={property} />
        </span>
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonths(m, 1))}
          aria-label="เดือนถัดไป"
          className="rounded-md border border-line-strong px-2.5 py-1.5 text-sm leading-none hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        >
          ›
        </button>
      </div>
      {!isCurrentMonth && (
        <button
          type="button"
          onClick={() => setMonth(currentMonthBangkok())}
          className="self-start text-xs font-medium text-brand-500 hover:underline"
        >
          กลับไปเดือนนี้
        </button>
      )}

      {/* สถานะการปิดบัญชีของเดือน — one strip carrying both the state and the
          control. A closed month has to be unmissable: every entry screen
          refuses writes once it is set, in the same warn/gold wording
          DaySheetPage and BookingDayPage already use. */}
      {closed !== null && (
        <div
          className={
            "flex w-full max-w-4xl flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 text-sm " +
            (closed ? "border-warn/40 bg-gold-50" : "border-line bg-panel")
          }
        >
          {closed ? (
            <span className="font-medium text-warn">
              เดือน {monthLabel} ปิดบัญชีแล้ว - แก้ไขรายรับ รายจ่าย และการยืนยันของเดือนนี้ไม่ได้
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <span className="text-ink-muted">สถานะบัญชีเดือนนี้:</span>
              <span className="inline-flex items-center rounded-full bg-tint px-2.5 py-1 text-xs font-medium text-ink-muted">
                ยังเปิดอยู่
              </span>
            </span>
          )}
          {closed ? (
            <button
              type="button"
              onClick={openReopenDialog}
              className="rounded-md border border-line-strong bg-panel px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-tint"
            >
              เปิดบัญชีอีกครั้ง
            </button>
          ) : (
            <button
              type="button"
              onClick={openCloseDialog}
              disabled={days === null}
              className="rounded-md bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              ปิดบัญชีเดือนนี้
            </button>
          )}
        </div>
      )}
      {closeError && dialog === null && <p className="text-xs text-bad">{closeError}</p>}

      {error && (
        <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">
          โหลดข้อมูลไม่สำเร็จ: {error}
        </div>
      )}

      {!error && days === null && <div className="p-6 text-sm text-ink-muted">กำลังโหลด...</div>}

      {!error && days !== null && days.length === 0 && (
        <div className="flex w-full max-w-4xl flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-sm text-ink-muted">
          <span>ยังไม่มีข้อมูลเดือนนี้ - เริ่มบันทึกวันนี้</span>
          <button
            type="button"
            onClick={() => navigate(`/${property}/day/${today}`)}
            className="rounded-md bg-brand-500 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-600"
          >
            ไปที่วันนี้
          </button>
        </div>
      )}

      {!error && days !== null && (
        // Five short columns: held to a readable measure rather than
        // stretched across the full 1400px shell.
        <div className="w-full max-w-4xl overflow-hidden rounded-lg border border-line bg-panel">
          <div className="grid grid-cols-[10rem_1fr_1fr_1fr_9rem] gap-3 border-b border-line bg-tint px-4 py-2 text-xs font-semibold text-ink-muted">
            <span>วันที่</span>
            <span className="text-right">รายรับ</span>
            <span className="text-right">รายจ่าย</span>
            <span className="text-right">เงินฝาก</span>
            <span>ที่มา</span>
          </div>
          <div className="divide-y divide-line">
            {rows.map((row) => {
              const isGap = !row.summary && !row.isFuture;
              return (
                <button
                  key={row.date}
                  type="button"
                  onClick={() => navigate(`/${property}/day/${row.date}`)}
                  className={
                    "grid w-full grid-cols-[10rem_1fr_1fr_1fr_9rem] gap-3 px-4 py-2.5 text-left text-sm hover:bg-tint focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500/40 " +
                    (isGap
                      ? "border-l-2 border-l-warn/60 bg-gold-50/60"
                      : row.summary
                        ? ""
                        : "bg-shell/60 text-ink-muted")
                  }
                >
                  <span className="flex items-center gap-1 text-ink">
                    {isoToBuddhist(row.date)}{" "}
                    <span className="text-ink-muted">{weekdayTh(row.date)}</span>
                    {row.isToday && (
                      <span className="rounded-full bg-tint px-1.5 py-0.5 text-[11px] font-medium leading-none text-ink-muted">
                        วันนี้
                      </span>
                    )}
                    {row.summary?.verified && (
                      <span
                        title="ตรวจสอบยืนยันแล้ว"
                        aria-label="ตรวจสอบยืนยันแล้ว"
                        className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-ok/15 text-ok"
                      >
                        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
                          <path
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M3 8.5 6.5 12 13 4.5"
                          />
                        </svg>
                      </span>
                    )}
                  </span>
                  {row.summary ? (
                    <>
                      <span className="text-right tabular-nums text-ink">
                        {formatSatang(row.summary.incomeSatang)}
                      </span>
                      <span className="text-right tabular-nums text-ink">
                        {formatSatang(row.summary.expenseSatang)}
                      </span>
                      <span className="text-right tabular-nums font-medium text-brand-500">
                        {formatSatang(row.summary.cashToDepositSatang)}
                      </span>
                      {/* 772 backfilled days sit in here, so how a day came to
                          exist is what the month list most wants to show at a
                          glance. Short label in the cell, full sentence on hover. */}
                      <span
                        title={PROVENANCE_LABELS_TH[row.summary.provenance]}
                        className="min-w-0 truncate text-xs text-ink-muted"
                      >
                        {PROVENANCE_SHORT_TH[row.summary.provenance]}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-right tabular-nums text-ink-muted">-</span>
                      <span className="text-right tabular-nums text-ink-muted">-</span>
                      <span className="text-right tabular-nums text-ink-muted">-</span>
                      <span
                        title={
                          isGap
                            ? "ยังไม่มีการบันทึกของวันนี้ - กดเพื่อเปิดวันนี้และกรอกข้อมูล"
                            : "ยังไม่ถึงวันนี้"
                        }
                        className={
                          "min-w-0 truncate text-xs " + (isGap ? "font-medium text-warn" : "text-ink-muted")
                        }
                      >
                        {isGap ? "ไม่มีข้อมูล" : "ยังไม่ถึงวัน"}
                      </span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {dialog !== null && (
        <MonthCloseDialog
          mode={dialog}
          monthLabel={monthLabel}
          dataDayCount={days?.length ?? 0}
          unverifiedDates={unverifiedDates}
          missingDates={missingDates}
          preflight={preflight}
          busy={closeBusy}
          error={closeError}
          onConfirm={() => void confirmClose(dialog === "close")}
          onCancel={closeDialog}
        />
      )}
    </div>
  );
}

// ── ปิดบัญชีเดือน — confirm dialog with a preflight ──────────────────────

interface MonthCloseDialogProps {
  mode: "close" | "reopen";
  monthLabel: string;
  dataDayCount: number;
  unverifiedDates: string[];
  missingDates: string[];
  preflight: PreflightState | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const DATE_CHIP_LIMIT = 14;

function DateChips({ dates }: { dates: string[] }) {
  const shown = dates.slice(0, DATE_CHIP_LIMIT);
  const rest = dates.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((date) => (
        <span key={date} className="rounded-md bg-tint px-1.5 py-0.5 text-[11px] tabular-nums text-ink">
          {isoToBuddhist(date)}
        </span>
      ))}
      {rest > 0 && <span className="px-1 py-0.5 text-[11px] text-ink-muted">และอีก {rest} วัน</span>}
    </div>
  );
}

function MonthCloseDialog({
  mode,
  monthLabel,
  dataDayCount,
  unverifiedDates,
  missingDates,
  preflight,
  busy,
  error,
  onConfirm,
  onCancel,
}: MonthCloseDialogProps) {
  const varianceDays = [...(preflight?.variance ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const failedDays = [...(preflight?.failed ?? [])].sort();
  const scanning = preflight?.running === true;
  const outstanding =
    mode === "close" &&
    (unverifiedDates.length > 0 || missingDates.length > 0 || varianceDays.length > 0);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-panel shadow-lg">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">
            {mode === "close" ? `ปิดบัญชีเดือน ${monthLabel}` : `เปิดบัญชีเดือน ${monthLabel} อีกครั้ง`}
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {mode === "close"
              ? "ตรวจรายการค้างก่อนปิด - ปิดแล้วจะแก้ไขรายรับ รายจ่าย และการยืนยันของเดือนนี้ไม่ได้ จนกว่าจะเปิดอีกครั้ง"
              : "เปิดให้แก้ไขรายรับ รายจ่าย และการยืนยันของเดือนนี้ได้อีกครั้ง"}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {mode === "reopen" && (
            <p className="text-sm text-ink">
              เดือนนี้ปิดบัญชีอยู่ เปิดอีกครั้งเพื่อแก้ไขข้อมูลได้ตามปกติ
            </p>
          )}

          {mode === "close" && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-ink-muted">
                มีข้อมูล <span className="font-semibold tabular-nums text-ink">{dataDayCount}</span> วันในเดือนนี้
                {scanning && (
                  <>
                    {" - "}กำลังตรวจสอบ{" "}
                    <span className="tabular-nums">
                      {preflight?.checked ?? 0}/{preflight?.total ?? 0}
                    </span>{" "}
                    วัน...
                  </>
                )}
              </p>

              {unverifiedDates.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-md border border-warn/40 bg-gold-50 px-2.5 py-2">
                  <p className="text-xs font-semibold text-warn">
                    ยังไม่ยืนยัน <span className="tabular-nums">{unverifiedDates.length}</span> วัน
                  </p>
                  <DateChips dates={unverifiedDates} />
                </div>
              )}

              {varianceDays.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-md border border-warn/40 bg-gold-50 px-2.5 py-2">
                  <p className="text-xs font-semibold text-warn">
                    ยอดที่กรอกไม่ตรงกับรายการจอง <span className="tabular-nums">{varianceDays.length}</span> วัน
                    <span className="font-normal text-ink-muted">
                      {" "}
                      (ต่างเกิน {formatSatang(RECONCILE_TOLERANCE_SATANG)} บาท)
                    </span>
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {varianceDays.map((day) => (
                      <div key={day.date} className="flex items-center justify-between text-xs">
                        <span className="tabular-nums text-ink">{isoToBuddhist(day.date)}</span>
                        <span className="tabular-nums text-warn">
                          {day.varianceSatang > 0 ? "+" : "-"}
                          {formatSatang(Math.abs(day.varianceSatang))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {missingDates.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-md border border-warn/40 bg-gold-50 px-2.5 py-2">
                  <p className="text-xs font-semibold text-warn">
                    ไม่มีข้อมูล <span className="tabular-nums">{missingDates.length}</span> วัน
                  </p>
                  <DateChips dates={missingDates} />
                </div>
              )}

              {failedDays.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-md border border-line-strong px-2.5 py-2">
                  <p className="text-xs font-semibold text-ink-muted">
                    ตรวจสอบไม่สำเร็จ <span className="tabular-nums">{failedDays.length}</span> วัน
                  </p>
                  <DateChips dates={failedDays} />
                </div>
              )}

              {!scanning && !outstanding && failedDays.length === 0 && (
                <p className="rounded-md border border-ok/30 bg-panel px-2.5 py-2 text-sm text-ok">
                  ไม่มีรายการค้าง - เดือนนี้พร้อมปิดบัญชี
                </p>
              )}

              {outstanding && (
                <p className="text-xs text-ink-muted">
                  ยังปิดบัญชีได้ แม้มีรายการค้าง - แต่ควรตรวจให้เรียบร้อยก่อน
                </p>
              )}
            </div>
          )}

          {error && <p className="mt-3 text-sm text-bad">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-line-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? "กำลังบันทึก..." : mode === "close" ? "ยืนยันปิดบัญชี" : "ยืนยันเปิดบัญชี"}
          </button>
        </div>
      </div>
    </div>
  );
}
