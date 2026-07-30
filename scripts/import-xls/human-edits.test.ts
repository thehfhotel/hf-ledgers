import { describe, expect, test } from "bun:test";
import {
  IMPORT_ACTOR,
  IMPORT_CELL_SOURCE,
  guardTotals,
  importerMayWriteDayLevel,
  importerMayWriteIncomeCell,
} from "./human-edits.ts";

describe("importerMayWriteIncomeCell", () => {
  test("an absent cell is writable", () => {
    expect(importerMayWriteIncomeCell(undefined)).toBe(true);
    expect(importerMayWriteIncomeCell(null)).toBe(true);
  });

  test("a cell this importer wrote is re-writable, so re-running stays idempotent", () => {
    expect(importerMayWriteIncomeCell({ source: IMPORT_CELL_SOURCE, updatedBy: IMPORT_ACTOR })).toBe(true);
  });

  test("a manual cell entered by a person is protected", () => {
    // The real case: the owner added a บาร์น้ำ เงินสด figure to hf 2025-05-06.
    expect(importerMayWriteIncomeCell({ source: "manual", updatedBy: "winut.hf@gmail.com" })).toBe(false);
  });

  test("both halves must match — a person cannot be impersonated by source alone", () => {
    expect(importerMayWriteIncomeCell({ source: "import", updatedBy: "winut.hf@gmail.com" })).toBe(false);
    expect(importerMayWriteIncomeCell({ source: "manual", updatedBy: IMPORT_ACTOR })).toBe(false);
  });

  test("a booking-derived cell is not the importer's to overwrite either", () => {
    expect(importerMayWriteIncomeCell({ source: "booking", updatedBy: "frontdesk@thehfhotel.org" })).toBe(false);
  });
});

describe("importerMayWriteDayLevel", () => {
  test("a day with no sheet_days row yet is writable", () => {
    expect(importerMayWriteDayLevel(null)).toBe(true);
    expect(importerMayWriteDayLevel(undefined)).toBe(true);
  });

  test("a day the importer stamped last is writable", () => {
    expect(importerMayWriteDayLevel({ updatedBy: IMPORT_ACTOR })).toBe(true);
  });

  test("any human touch on the day takes the whole sheet_days row out of scope", () => {
    expect(importerMayWriteDayLevel({ updatedBy: "winut.hf@gmail.com" })).toBe(false);
  });
});

describe("guardTotals", () => {
  test("counts both kinds of skip", () => {
    const totals = guardTotals(
      [
        {
          property: "hf",
          date: "2025-05-06",
          categoryId: 9,
          categoryKey: "bar_cash",
          workbookSatang: 0,
          existingSatang: 19_500,
          existingSource: "manual",
          existingUpdatedBy: "winut.hf@gmail.com",
        },
      ],
      [{ property: "hf", date: "2025-05-06", existingUpdatedBy: "winut.hf@gmail.com", skippedFields: ["cash-block override"] }],
    );
    expect(totals).toEqual({ cellsSkipped: 1, daysSkipped: 1 });
  });
});
