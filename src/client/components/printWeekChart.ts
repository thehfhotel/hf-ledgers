import { parseIso, shiftDays } from "../../shared/date.ts";

// Pure week-window + zero-fill + scaling logic for the day-summary print's
// weekly income bar chart (PrintableDaySummary.tsx's "รายรับรายวัน
// สัปดาห์นี้" section). Kept dependency-free (no DOM, no fetch) so the
// Monday-start week math and the scaling math are unit-tested directly;
// DaySheetPage.tsx does the actual listDays() fetching and hands this
// module's zero-filled output straight to the print component as a prop.
//
// The week is the Monday-start CALENDAR week containing the printed date —
// NOT a rolling 7 days back from it — so the chart reads the same paper
// week the front desk already thinks in, and the printed date can fall
// anywhere in it (a Monday, a Sunday, or any day between).

/** Thai weekday initials, Monday-first, matching WeekWindow.days order. */
export const WEEKDAY_LABELS_TH = ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"] as const;

export interface WeekWindow {
  /** The 7 ISO dates Monday..Sunday, in order, containing the source date. */
  days: string[];
  /** First day of the week (Monday), ISO — same as days[0]. */
  startIso: string;
  /** Last day of the week (Sunday), ISO — same as days[6]. */
  endIso: string;
}

/** The Monday-start calendar week containing `dateIso`, wherever in the
 * week it falls. Correct across a month or year boundary because it's
 * built on shared date.ts's shiftDays()/parseIso(), which delegate to the
 * JS Date object's own day-of-month rollover rather than any manual
 * calendar math here. */
export function computeWeekWindow(dateIso: string): WeekWindow {
  const jsDay = parseIso(dateIso).getDay(); // 0=Sun..6=Sat
  const mondayOffset = (jsDay + 6) % 7; // 0=Mon..6=Sun
  const startIso = shiftDays(dateIso, -mondayOffset);
  const days = Array.from({ length: 7 }, (_, i) => shiftDays(startIso, i));
  return { days, startIso, endIso: days[6]! };
}

/** The one or two "YYYY-MM" months a week window's days fall in — a
 * Monday-start week spans at most two calendar months. Used to decide how
 * many listDays() calls DaySheetPage needs to cover the chart. */
export function weekWindowMonths(weekWindow: WeekWindow): string[] {
  const startMonth = weekWindow.startIso.slice(0, 7);
  const endMonth = weekWindow.endIso.slice(0, 7);
  return startMonth === endMonth ? [startMonth] : [startMonth, endMonth];
}

export interface WeekDayIncome {
  date: string;
  incomeSatang: number;
}

/** Zero-fills a week window against sparse per-day income data (e.g. merged
 * from one or two listDays() month responses), keyed by ISO date. Always
 * returns exactly 7 rows in weekWindow.days (Monday..Sunday) order; a date with
 * no entry — no data yet, or a future day — reads as incomeSatang: 0, the
 * same empty slot the chart renders at zero height rather than an omitted
 * bar. */
export function zeroFillWeek(weekWindow: WeekWindow, incomeByDate: Map<string, number>): WeekDayIncome[] {
  return weekWindow.days.map((date) => ({ date, incomeSatang: incomeByDate.get(date) ?? 0 }));
}

/**
 * Overrides one day's income in an already zero-filled week — used so the
 * printed date's chart bar always equals the day sheet's own LIVE
 * totals.incomeSatang, never the possibly-stale figure DaySheetPage's
 * listDays() fetch captured at load time. Editing income and then printing
 * must never show two different numbers for the same day on one page. No
 * day is added or removed; a `date` absent from `days` is a no-op (should
 * not happen in practice — DaySheetPage always computes the week window
 * FROM the printed date, so it is always one of the 7).
 */
export function overrideDayIncome(days: WeekDayIncome[], date: string, incomeSatang: number): WeekDayIncome[] {
  return days.map((d) => (d.date === date ? { ...d, incomeSatang } : d));
}

/**
 * Whether `candidateDate` falls strictly after `referenceDate` — both ISO
 * "YYYY-MM-DD" business-date strings, safe to compare lexicographically in
 * chronological order. Used to visually mute chart columns for days after
 * the printed date: those days have not happened yet, so a Monday printout
 * must not read as if the rest of the week already earned zero.
 */
export function isFutureDay(candidateDate: string, referenceDate: string): boolean {
  return candidateDate > referenceDate;
}

export interface WeekBar extends WeekDayIncome {
  /** Bar height in px, scaled against the week's own max incomeSatang and
   * capped at maxHeightPx. An all-zero week (max = 0) makes every bar 0 —
   * the component renders a centered placeholder ("-") in that case rather
   * than seven identical full-height bars. */
  heightPx: number;
}

/** Scales a week's incomeSatang values into bar heights against the WEEK'S
 * OWN max, never a fixed/absolute money scale — the chart is a
 * within-week shape comparison, not a cross-week one. */
export function scaleWeekBars(days: WeekDayIncome[], maxHeightPx: number): WeekBar[] {
  const max = Math.max(0, ...days.map((d) => d.incomeSatang));
  return days.map((d) => ({
    ...d,
    heightPx: max > 0 ? Math.round((d.incomeSatang / max) * maxHeightPx) : 0,
  }));
}
