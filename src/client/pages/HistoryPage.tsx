import { useEffect, useState } from "react";
import {
  currentMonthBangkok,
  isoToBuddhist,
  monthToThaiLong,
  shiftMonths,
  todayBangkok,
} from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import type { DaySummary, Property } from "../../shared/types.ts";
import { listDays } from "../api.ts";
import { navigate } from "../App.tsx";

interface Props {
  property: Property;
}

const WEEKDAYS_TH = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

function weekdayTh(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAYS_TH[new Date(y!, m! - 1, d!).getDay()]!;
}

export function HistoryPage({ property }: Props) {
  const [month, setMonth] = useState(currentMonthBangkok());
  const [days, setDays] = useState<DaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDays(null);
    setError(null);
    listDays(property, month)
      .then((res) => setDays(res.days))
      .catch((err) => setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ"));
  }, [property, month]);

  const today = todayBangkok();
  const isCurrentMonth = month === currentMonthBangkok();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2">
        <button
          type="button"
          onClick={() => setMonth((m) => shiftMonths(m, -1))}
          aria-label="เดือนก่อนหน้า"
          className="rounded-md border border-line-strong px-2.5 py-1.5 text-sm leading-none hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        >
          ‹
        </button>
        <span className="text-sm font-semibold text-ink">{monthToThaiLong(month)}</span>
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

      {error && (
        <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">
          โหลดข้อมูลไม่สำเร็จ: {error}
        </div>
      )}

      {!error && days === null && <div className="p-6 text-sm text-ink-muted">กำลังโหลด...</div>}

      {!error && days !== null && days.length === 0 && (
        <div className="rounded-lg border border-line bg-panel p-6 text-center text-sm text-ink-muted">
          <p>ยังไม่มีข้อมูลเดือนนี้ - เริ่มบันทึกวันนี้</p>
          <button
            type="button"
            onClick={() => navigate(`/${property}/day/${today}`)}
            className="mt-3 rounded-md bg-brand-500 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-600"
          >
            ไปที่วันนี้
          </button>
        </div>
      )}

      {!error && days !== null && days.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-2 border-b border-line bg-tint px-3 py-2 text-xs font-semibold text-ink-muted">
            <span>วันที่</span>
            <span className="text-right">รายรับ</span>
            <span className="text-right">รายจ่าย</span>
            <span className="text-right">เงินฝาก</span>
          </div>
          <div className="divide-y divide-line">
            {days.map((d) => (
              <button
                key={d.date}
                type="button"
                onClick={() => navigate(`/${property}/day/${d.date}`)}
                className="grid w-full grid-cols-[auto_1fr_1fr_1fr] gap-2 px-3 py-2.5 text-left text-sm hover:bg-tint focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500/40"
              >
                <span className="flex items-center gap-1 text-ink">
                  {isoToBuddhist(d.date)} <span className="text-ink-muted">{weekdayTh(d.date)}</span>
                  {d.verified && (
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
                <span className="text-right tabular-nums text-ink">{formatSatang(d.incomeSatang)}</span>
                <span className="text-right tabular-nums text-ink">{formatSatang(d.expenseSatang)}</span>
                <span className="text-right tabular-nums font-medium text-brand-500">
                  {formatSatang(d.cashToDepositSatang)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
