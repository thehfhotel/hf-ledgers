import { describe, expect, test } from "bun:test";
import {
  computeWeekWindow,
  isFutureDay,
  overrideDayIncome,
  scaleWeekBars,
  weekWindowMonths,
  zeroFillWeek,
  type WeekDayIncome,
} from "./printWeekChart.ts";

// Reference calendar facts (verified against JS Date, not hand calculation):
//   2026-07-13 Mon, 2026-07-15 Wed, 2026-07-19 Sun  — one week, mid-July
//   2026-07-27 Mon .. 2026-08-02 Sun                — week straddling Jul/Aug
//   2026-12-28 Mon .. 2027-01-03 Sun                — week straddling 2026/2027

const MID_JULY_WEEK = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"];
const MONTH_BOUNDARY_WEEK = ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"];
const YEAR_BOUNDARY_WEEK = ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"];

describe("computeWeekWindow", () => {
  test("a mid-week date resolves to its Monday-start week", () => {
    const window = computeWeekWindow("2026-07-15"); // Wednesday
    expect(window.days).toEqual(MID_JULY_WEEK);
    expect(window.startIso).toBe("2026-07-13");
    expect(window.endIso).toBe("2026-07-19");
  });

  test("a Monday is already the week's start", () => {
    const window = computeWeekWindow("2026-07-13");
    expect(window.days).toEqual(MID_JULY_WEEK);
    expect(window.startIso).toBe("2026-07-13");
  });

  test("a Sunday is already the week's end", () => {
    const window = computeWeekWindow("2026-07-19");
    expect(window.days).toEqual(MID_JULY_WEEK);
    expect(window.endIso).toBe("2026-07-19");
  });

  test("a week straddling a month boundary spans both months in order", () => {
    const window = computeWeekWindow("2026-07-29"); // Wednesday
    expect(window.days).toEqual(MONTH_BOUNDARY_WEEK);
    expect(window.startIso).toBe("2026-07-27");
    expect(window.endIso).toBe("2026-08-02");
  });

  test("a week straddling a year boundary spans both years in order", () => {
    const window = computeWeekWindow("2026-12-31"); // Thursday
    expect(window.days).toEqual(YEAR_BOUNDARY_WEEK);
    expect(window.startIso).toBe("2026-12-28");
    expect(window.endIso).toBe("2027-01-03");
  });
});

describe("weekWindowMonths", () => {
  test("a week entirely inside one month returns that one month", () => {
    const window = computeWeekWindow("2026-07-15");
    expect(weekWindowMonths(window)).toEqual(["2026-07"]);
  });

  test("a week straddling a month boundary returns both months", () => {
    const window = computeWeekWindow("2026-07-29");
    expect(weekWindowMonths(window)).toEqual(["2026-07", "2026-08"]);
  });

  test("a week straddling a year boundary returns both YYYY-MM months", () => {
    const window = computeWeekWindow("2026-12-31");
    expect(weekWindowMonths(window)).toEqual(["2026-12", "2027-01"]);
  });
});

describe("zeroFillWeek", () => {
  test("fills every day of the window, defaulting missing dates (including future days) to zero", () => {
    const window = computeWeekWindow("2026-07-15");
    // Only three of the seven days have data — the other four (including a
    // "future" day past today for this fixture) must still appear, at zero.
    const incomeByDate = new Map<string, number>([
      ["2026-07-13", 10_000],
      ["2026-07-15", 25_000],
      ["2026-07-18", 5_000],
    ]);
    const filled = zeroFillWeek(window, incomeByDate);
    expect(filled).toEqual([
      { date: "2026-07-13", incomeSatang: 10_000 },
      { date: "2026-07-14", incomeSatang: 0 },
      { date: "2026-07-15", incomeSatang: 25_000 },
      { date: "2026-07-16", incomeSatang: 0 },
      { date: "2026-07-17", incomeSatang: 0 },
      { date: "2026-07-18", incomeSatang: 5_000 },
      { date: "2026-07-19", incomeSatang: 0 },
    ]);
  });

  test("an entirely empty map zero-fills all seven days", () => {
    const window = computeWeekWindow("2026-07-29");
    const filled = zeroFillWeek(window, new Map());
    expect(filled).toHaveLength(7);
    expect(filled.every((d) => d.incomeSatang === 0)).toBe(true);
    expect(filled.map((d) => d.date)).toEqual(MONTH_BOUNDARY_WEEK);
  });
});

describe("scaleWeekBars", () => {
  test("scales each day's height proportionally to the week's own max", () => {
    const days: WeekDayIncome[] = [
      { date: "2026-07-13", incomeSatang: 0 },
      { date: "2026-07-14", incomeSatang: 1_000 },
      { date: "2026-07-15", incomeSatang: 2_000 },
      { date: "2026-07-16", incomeSatang: 500 },
      { date: "2026-07-17", incomeSatang: 0 },
      { date: "2026-07-18", incomeSatang: 3_000 },
      { date: "2026-07-19", incomeSatang: 1_500 },
    ];
    const bars = scaleWeekBars(days, 140);
    expect(bars.map((b) => b.heightPx)).toEqual([0, 47, 93, 23, 0, 140, 70]);
    // The day identity + incomeSatang carry through untouched.
    expect(bars[5]).toEqual({ date: "2026-07-18", incomeSatang: 3_000, heightPx: 140 });
  });

  test("an all-zero week scales every bar to zero height, never NaN/Infinity", () => {
    const window = computeWeekWindow("2026-07-15");
    const days = zeroFillWeek(window, new Map());
    const bars = scaleWeekBars(days, 140);
    expect(bars.every((b) => b.heightPx === 0)).toBe(true);
  });

  test("a single non-zero day scales to exactly maxHeightPx", () => {
    const days: WeekDayIncome[] = [{ date: "2026-07-13", incomeSatang: 42_000 }];
    const bars = scaleWeekBars(days, 150);
    expect(bars[0]!.heightPx).toBe(150);
  });
});

describe("overrideDayIncome", () => {
  test("replaces only the matching date's incomeSatang, leaving every other day untouched", () => {
    const window = computeWeekWindow("2026-07-15");
    const days = zeroFillWeek(window, new Map([["2026-07-13", 10_000]]));
    const overridden = overrideDayIncome(days, "2026-07-15", 99_999);
    expect(overridden).toEqual([
      { date: "2026-07-13", incomeSatang: 10_000 },
      { date: "2026-07-14", incomeSatang: 0 },
      { date: "2026-07-15", incomeSatang: 99_999 },
      { date: "2026-07-16", incomeSatang: 0 },
      { date: "2026-07-17", incomeSatang: 0 },
      { date: "2026-07-18", incomeSatang: 0 },
      { date: "2026-07-19", incomeSatang: 0 },
    ]);
  });

  test("overrides even when the live value is lower than what was loaded (an edit that removed income)", () => {
    const days: WeekDayIncome[] = [{ date: "2026-07-13", incomeSatang: 50_000 }];
    expect(overrideDayIncome(days, "2026-07-13", 0)).toEqual([{ date: "2026-07-13", incomeSatang: 0 }]);
  });

  test("a date not present in the week is a no-op", () => {
    const days: WeekDayIncome[] = [{ date: "2026-07-13", incomeSatang: 10_000 }];
    expect(overrideDayIncome(days, "2026-08-01", 5_000)).toEqual(days);
  });

  test("never mutates the input array", () => {
    const days: WeekDayIncome[] = [{ date: "2026-07-13", incomeSatang: 10_000 }];
    const original = JSON.parse(JSON.stringify(days));
    overrideDayIncome(days, "2026-07-13", 5_000);
    expect(days).toEqual(original);
  });
});

describe("isFutureDay", () => {
  test("a date after the reference date is future", () => {
    expect(isFutureDay("2026-07-16", "2026-07-15")).toBe(true);
  });

  test("the reference date itself is not future", () => {
    expect(isFutureDay("2026-07-15", "2026-07-15")).toBe(false);
  });

  test("a date before the reference date is not future", () => {
    expect(isFutureDay("2026-07-14", "2026-07-15")).toBe(false);
  });

  test("correctly orders dates across a month boundary", () => {
    expect(isFutureDay("2026-08-01", "2026-07-31")).toBe(true);
    expect(isFutureDay("2026-07-31", "2026-08-01")).toBe(false);
  });
});
