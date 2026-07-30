import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import {
  findDateCellDate,
  findHeaderText,
  parseHeaderDate,
  parseSheetNameDate,
  resolveSheetDate,
  voteDate,
} from "./sheet-date.ts";

describe("parseSheetNameDate", () => {
  test("converts a two-digit Buddhist-Era sheet name to CE", () => {
    expect(parseSheetNameDate("22-4-68")).toEqual({ year: 2025, month: 4, day: 22 });
  });

  test("converts a four-digit Buddhist-Era sheet name to CE", () => {
    expect(parseSheetNameDate("1-5-2568")).toEqual({ year: 2025, month: 5, day: 1 });
  });

  test("strips a leading HF-ViLLE prefix before parsing", () => {
    expect(parseSheetNameDate("HF-ViLLE 23-7-69")).toEqual({ year: 2026, month: 7, day: 23 });
  });

  test("tolerates trailing whitespace (real examples carry 1-3 trailing spaces)", () => {
    expect(parseSheetNameDate("18-4-68 ")).toEqual({ year: 2025, month: 4, day: 18 });
    expect(parseSheetNameDate("19-4-68  ")).toEqual({ year: 2025, month: 4, day: 19 });
    expect(parseSheetNameDate("20-4-68   ")).toEqual({ year: 2025, month: 4, day: 20 });
  });

  test("strips a trailing duplicate-sheet suffix like ' (2)'", () => {
    expect(parseSheetNameDate("13-6-69  (2)")).toEqual({ year: 2026, month: 6, day: 13 });
  });

  test("returns null for bare-number sheet names with no date pattern", () => {
    expect(parseSheetNameDate("1")).toBeNull();
    expect(parseSheetNameDate("42")).toBeNull();
  });

  test("returns null for an out-of-range day", () => {
    expect(parseSheetNameDate("35-4-68")).toBeNull();
  });
});

describe("parseHeaderDate", () => {
  test("parses the single-spaced header form", () => {
    expect(parseHeaderDate("ประจำวันที่ 1 มีนาคม 2568")).toEqual({ year: 2025, month: 3, day: 1 });
  });

  test("parses the multi-spaced header form", () => {
    expect(parseHeaderDate("ประจำวันที่   25  มีนาคม   2569")).toEqual({ year: 2026, month: 3, day: 25 });
  });

  test("rejects an impossible day (corrupted header text)", () => {
    // Real corrupt case observed on sheet "5-4-69": header read as day 35.
    expect(parseHeaderDate("ประจำวันที่ 35 เมษายน 2569")).toBeNull();
  });

  test("returns null when the Thai month name is unrecognized", () => {
    expect(parseHeaderDate("ประจำวันที่ 1 ไม่รู้จัก 2568")).toBeNull();
  });
});

describe("voteDate", () => {
  test("resolves confidently when all three sources agree", () => {
    const date = { year: 2026, month: 3, day: 25 };
    const result = voteDate([
      { source: "sheetName", date },
      { source: "dateCell", date },
      { source: "header", date },
    ]);
    expect(result.unresolved).toBe(false);
    expect(result.date).toEqual(date);
    expect(result.agreementCount).toBe(3);
    expect(result.hasDisagreement).toBe(false);
  });

  test("real stale-date-cell case: sheet '25-3-69' — name and header agree on 25 Mar, the cell reads a stale 24 Mar", () => {
    // Genuine data from รายงานรายรับโรงแรม(รายวัน).xlsx, sheet "25-3-69".
    const result = voteDate([
      { source: "sheetName", date: { year: 2026, month: 3, day: 25 } },
      { source: "dateCell", date: { year: 2026, month: 3, day: 24 } },
      { source: "header", date: { year: 2026, month: 3, day: 25 } },
    ]);
    expect(result.unresolved).toBe(false);
    expect(result.date).toEqual({ year: 2026, month: 3, day: 25 });
    expect(result.agreementCount).toBe(2);
    expect(result.hasDisagreement).toBe(true);
  });

  test("hard-fails a genuine three-way split rather than guessing", () => {
    const result = voteDate([
      { source: "sheetName", date: { year: 2026, month: 3, day: 25 } },
      { source: "dateCell", date: { year: 2026, month: 3, day: 24 } },
      { source: "header", date: { year: 2026, month: 3, day: 26 } },
    ]);
    expect(result.unresolved).toBe(true);
    expect(result.date).toBeNull();
  });

  test("resolves confidently from a single surviving candidate — nothing else contradicts it (real case: bare-number sheet name, summary sheet has no header)", () => {
    const result = voteDate([
      { source: "sheetName", date: null },
      { source: "dateCell", date: { year: 2025, month: 4, day: 20 } },
      { source: "header", date: null },
    ]);
    expect(result.unresolved).toBe(false);
    expect(result.date).toEqual({ year: 2025, month: 4, day: 20 });
    expect(result.singleSource).toBe(true);
    expect(result.agreementCount).toBe(1);
  });

  test("is unresolved when no candidate survives at all", () => {
    const result = voteDate([
      { source: "sheetName", date: null },
      { source: "dateCell", date: null },
      { source: "header", date: null },
    ]);
    expect(result.unresolved).toBe(true);
    expect(result.date).toBeNull();
    expect(result.singleSource).toBe(false);
  });

  test("discards an implausible sheet-name typo (year 8568 BE / CE 8025) instead of counting it as a disagreeing vote (real case: sheet '18-6-8568')", () => {
    const result = voteDate([
      { source: "sheetName", date: { year: 8025, month: 6, day: 18 } },
      { source: "dateCell", date: { year: 2026, month: 6, day: 18 } },
      { source: "header", date: null },
    ]);
    expect(result.unresolved).toBe(false);
    expect(result.date).toEqual({ year: 2026, month: 6, day: 18 });
    expect(result.singleSource).toBe(true);
    expect(result.discarded).toEqual([{ source: "sheetName", date: { year: 8025, month: 6, day: 18 } }]);
  });

  test("hard-fails when two surviving (plausible) candidates genuinely disagree, even with one implausible candidate also present", () => {
    const result = voteDate([
      { source: "sheetName", date: { year: 2025, month: 5, day: 30 } },
      { source: "dateCell", date: { year: 2025, month: 4, day: 30 } },
      { source: "header", date: { year: 9999, month: 1, day: 1 } },
    ]);
    expect(result.unresolved).toBe(true);
    expect(result.date).toBeNull();
    expect(result.discarded).toHaveLength(1);
  });

  test("resolves confidently from just two present, agreeing sources (summary sheet has no header)", () => {
    const date = { year: 2025, month: 4, day: 20 };
    const result = voteDate([
      { source: "sheetName", date },
      { source: "dateCell", date },
      { source: "header", date: null },
    ]);
    expect(result.unresolved).toBe(false);
    expect(result.date).toEqual(date);
    expect(result.agreementCount).toBe(2);
  });

  test("is unresolved when the only two present sources disagree (a tie)", () => {
    const result = voteDate([
      { source: "sheetName", date: { year: 2025, month: 4, day: 20 } },
      { source: "dateCell", date: { year: 2025, month: 4, day: 21 } },
      { source: "header", date: null },
    ]);
    expect(result.unresolved).toBe(true);
  });
});

describe("worksheet scanning", () => {
  test("findDateCellDate finds a real BE serial (244094 -> 20 Apr 2568) among unrelated numbers", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["สรุปยอดรายรับโรงแรม", undefined, "มัดจำล่วงหน้า", undefined, undefined, undefined, 0],
      [244094, undefined, "ค่าห้องเงินสด", undefined, undefined, undefined, 4160],
    ]);
    expect(findDateCellDate(ws)).toEqual({ year: 2025, month: 4, day: 20 });
  });

  test("findDateCellDate ignores small integers and money amounts (no false positives)", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      [1, 2, 3, 890.53, 23838.93],
      [12, 21, 14750.59],
    ]);
    expect(findDateCellDate(ws)).toBeNull();
  });

  test("findHeaderText finds the Thai header cell wherever it sits", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["รายงานรายรับของโรงแรม"],
      [],
      ["ประจำวันที่ 1 มีนาคม 2568"],
    ]);
    expect(findHeaderText(ws)).toBe("ประจำวันที่ 1 มีนาคม 2568");
  });

  test("resolveSheetDate excludes the header source for summary sheets", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["สรุปยอดรายรับโรงแรม", undefined, "มัดจำล่วงหน้า", undefined, undefined, undefined, 0],
      [244094, undefined, "ค่าห้องเงินสด", undefined, undefined, undefined, 4160],
    ]);
    const result = resolveSheetDate({ sheetName: "20-4-68", worksheet: ws, includeHeader: false });
    expect(result.date).toEqual({ year: 2025, month: 4, day: 20 });
    const headerSource = result.sources.find((s) => s.source === "header");
    expect(headerSource?.date).toBeNull();
  });
});
