// The UNION of both ledgers' date suites. They were completely disjoint:
// expense-ledger tested only isValidIso, income-ledger tested only
// timeBangkok, and neither repo had a single case in common with the other.
//
// isValidIso — H3 fix, made in expense-ledger only: a regex-only shape check
// let impossible dates (day 99, month 00, etc.) through, and Date.UTC/the
// Date constructor silently rolled them over into a real, later (or earlier)
// date, defeating both the no-future-date rule and the current-month lock.
// Income-ledger never got the fix, and its failure mode is worse than the one
// expense found, because it keys storage by the literal date string: a
// "2026-06-99" day sheet aggregates under June (the rollups match on
// `date LIKE 'YYYY-MM%'`), displays as 7 กันยายน 2569 (every display helper
// goes through parseIso, which rolls it over), and is unreachable from the
// date stepper, so money can sit in a day nobody can navigate to. See
// date.ts's isValidIso doc for the round-trip fix.
//
// timeBangkok — income-ledger only, added after the port that created the
// drift. The payment-time chip on the day-audit and slips queues.
//
// isValidMonth — the follow-up the isValidIso merge commit carried to the
// board: the same class of bug one level up. A regex-only shape check let
// "2026-13" and "2026-00" through at six call sites across both apps. Fixed
// with the same round-trip shape as isValidIso, so the two predicates agree
// on every boundary, year bounds included.

import { describe, expect, test } from "bun:test";
import { isValidIso, isValidMonth, timeBangkok } from "./date.ts";

describe("isValidIso — rejects impossible calendar dates", () => {
  const impossible = [
    "2026-06-99", // day out of range for any month — used to roll over to 2026-09-07
    "2026-02-31", // February never has 31 days
    "2026-00-99", // month 00 is not a real month
    "0000-01-01", // year 0 (also a Date.UTC two-digit-year special case)
  ];

  for (const s of impossible) {
    test(`rejects ${s}`, () => {
      expect(isValidIso(s)).toBe(false);
    });
  }
});

describe("isValidIso — accepts valid boundary dates", () => {
  const valid = [
    "2026-02-28", // last day of February in a non-leap year
    "2024-02-29", // leap day
    "2026-07-15", // an ordinary date, for baseline sanity
    "2026-01-31",
    "2026-12-31",
  ];

  for (const s of valid) {
    test(`accepts ${s}`, () => {
      expect(isValidIso(s)).toBe(true);
    });
  }
});

describe("isValidIso — still rejects malformed shapes (the original regex's job)", () => {
  const malformed = ["not-a-date", "2026-7-15", "2026/07/15", "20260715", ""];

  for (const s of malformed) {
    test(`rejects ${JSON.stringify(s)}`, () => {
      expect(isValidIso(s)).toBe(false);
    });
  }
});

describe("isValidMonth — rejects impossible months", () => {
  const impossible = [
    "2026-00", // month 00 is not a real month — Date.UTC rolls it to December 2025
    "2026-13", // month 13 — Date.UTC rolls it to January 2027
    "2026-99", // far out of range, same rollover
    "0000-01", // year 0 — the same Date.UTC two-digit-year special case isValidIso rejects
  ];

  for (const s of impossible) {
    test(`rejects ${s}`, () => {
      expect(isValidMonth(s)).toBe(false);
    });
  }
});

describe("isValidMonth — accepts the real boundary months", () => {
  const valid = ["2026-01", "2026-12", "2026-07", "2024-02"];

  for (const s of valid) {
    test(`accepts ${s}`, () => {
      expect(isValidMonth(s)).toBe(true);
    });
  }
});

describe("isValidMonth — still rejects malformed shapes (the original regex's job)", () => {
  const malformed = [
    "2026-1", // unpadded month
    "2026-001", // three-digit month
    "2026-07-15", // a full date is not a month
    "2026/07", // wrong separator
    "202607", // no separator
    "abcd-ef", // non-numeric
    "not-a-month",
    "",
  ];

  for (const s of malformed) {
    test(`rejects ${JSON.stringify(s)}`, () => {
      expect(isValidMonth(s)).toBe(false);
    });
  }
});

describe("isValidMonth agrees with isValidIso on the first of the month", () => {
  // The two predicates share one mechanism on purpose: any "YYYY-MM" that
  // isValidMonth accepts must be one that "YYYY-MM-01" passes isValidIso,
  // and vice versa — otherwise a month route and a day route could disagree
  // about whether the same month exists.
  const months = ["2026-00", "2026-01", "2026-12", "2026-13", "0000-01", "0099-12", "0100-01", "9999-12"];

  for (const m of months) {
    test(`${m} <-> ${m}-01`, () => {
      expect(isValidMonth(m)).toBe(isValidIso(`${m}-01`));
    });
  }
});

describe("timeBangkok", () => {
  test("formats an ISO instant as Bangkok HH:MM (UTC+7), no seconds", () => {
    expect(timeBangkok("2026-08-15T08:00:00.000Z")).toBe("15:00");
    expect(timeBangkok("2026-08-15T00:00:00.000Z")).toBe("07:00");
  });

  test("null in -> null out", () => {
    expect(timeBangkok(null)).toBeNull();
  });

  test("an unparseable instant -> null, never a guessed string", () => {
    expect(timeBangkok("not-a-real-date")).toBeNull();
  });
});
