import { useEffect, useRef } from "react";
import { isoToThaiLong, todayBangkok } from "../../shared/date.ts";

interface Props {
  date: string;
  onPick: (iso: string) => void;
  onShift: (deltaDays: number) => void;
}

/**
 * Date-navigation bar used on /:property/day/:date and /:property/report/:date:
 * prev/next arrows + a native date input, with the Buddhist-Era Thai long
 * date (isoToThaiLong) as the primary human-readable display next to it —
 * the native input itself renders in the browser's own (Gregorian) locale,
 * which is why the BE text sits alongside it as the thing people actually read.
 */
export function DateBar({ date, onPick, onShift }: Props) {
  const today = todayBangkok();
  const inputRef = useRef<HTMLInputElement>(null);

  // Commit only on the native `change` event (fires on a calendar pick, or
  // on blur/Enter after typing) — never on the DOM `input` event. React's
  // onChange prop maps to `input`, which fires on every keystroke while
  // typing a two-digit day/month; wiring onPick to that would navigate the
  // route mid-edit and unmount/remount this very input, swallowing the
  // second digit typed (the date appears to "skip" to the single-digit
  // value). Steals room-daily-reporter's DateBar fix: the input stays
  // uncontrolled (defaultValue + key=date) so React never resets the DOM
  // value out from under the user while they're still typing.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const commit = () => {
      if (el.value && el.value !== date) onPick(el.value);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [date, onPick]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onShift(-1)}
          aria-label="วันก่อนหน้า"
          className="rounded-md border border-line-strong px-2.5 py-1.5 text-sm leading-none hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        >
          ‹
        </button>
        <input
          ref={inputRef}
          key={date}
          type="date"
          defaultValue={date}
          aria-label="เลือกวันที่"
          className="rounded-md border border-line-strong px-2 py-1.5 text-xs tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        />
        <button
          type="button"
          onClick={() => onShift(1)}
          aria-label="วันถัดไป"
          className="rounded-md border border-line-strong px-2.5 py-1.5 text-sm leading-none hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        >
          ›
        </button>
        {date !== today && (
          <button
            type="button"
            onClick={() => onPick(today)}
            className="rounded-md bg-brand-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-600"
          >
            วันนี้
          </button>
        )}
      </div>
      <span className="text-sm font-semibold text-ink">{isoToThaiLong(date)}</span>
    </div>
  );
}
