// Integration test for the human-edit guard: drives the importer's real
// per-day write path (writeDay) against a real SQLite database, because the
// bug this guards against — a re-run clobbering hand-entered figures — lives
// in the interaction between the write path and db.ts, not in any pure
// function. Env must be set before importing db.ts, which opens the database
// and migrates at import time (same pattern as src/server/server.test.ts).

process.env.DB_PATH = ":memory:";

import { beforeAll, describe, expect, test } from "bun:test";
import { writeDay } from "./import.ts";
import { IMPORT_ACTOR } from "./human-edits.ts";
import type { DayImportPlan } from "./plan.ts";
import type { BookingRow, OwnSummaryLine, ReportSheetRecord, SummaryDayRecord } from "./types.ts";
import type * as DbModule from "../../src/server/db.ts";

const dbModule: typeof DbModule = await import("../../src/server/db.ts");

const HUMAN = "winut.hf@gmail.com";

let roomCashId = 0;
let barCashId = 0;
let barTransferId = 0;
let webId = 0;

beforeAll(() => {
  const categories = dbModule.listCategories("hf", false);
  roomCashId = categories.find((c) => c.categoryKey === "room_cash")!.id;
  barCashId = categories.find((c) => c.categoryKey === "bar_cash")!.id;
  barTransferId = categories.find((c) => c.categoryKey === "bar_transfer")!.id;
  webId = categories.find((c) => c.categoryKey === "web")!.id;
});

function summary(overrides: Partial<SummaryDayRecord> = {}): SummaryDayRecord {
  return {
    sheetName: "test-sheet",
    property: "hf",
    dateResolution: {
      date: { year: 2099, month: 1, day: 1 },
      sources: [],
      agreementCount: 1,
      hasDisagreement: false,
      unresolved: false,
      singleSource: true,
      discarded: [],
    },
    categories: { roomCash: 890_00 },
    otherIncomeItems: [],
    cashBlock: { hotelRevenueCash: 890_00, bankedTotal: 1_085_00 },
    printedTotalSatang: 890_00,
    unknownLabels: [],
    ...overrides,
  };
}

function plan(date: string, overrides: Partial<DayImportPlan> = {}): DayImportPlan {
  return {
    property: "hf",
    date,
    provenance: "summary_only",
    summary: summary(),
    reportSheet: null,
    reportWorkbookLabel: null,
    contradictsSourceMap: null,
    ...overrides,
  };
}

function cellAmount(date: string, categoryId: number): number | undefined {
  return dbModule.getIncomeForDay("hf", date)[categoryId]?.amountSatang;
}

function ownSummaryLine(label: string, amountSatang: number | null, rowIndex = 0): OwnSummaryLine {
  return { label, amountSatang, rowIndex };
}

function bookingRow(overrides: Partial<BookingRow> = {}): BookingRow {
  return {
    rowIndex: 0,
    seq: 1,
    bookingNo: null,
    guestName: "Guest",
    roomRaw: "301",
    roomTokens: ["301"],
    property: "hf",
    roomCount: 1,
    nights: 1,
    grossRoomSatang: 0,
    grossOtherSatang: 0,
    discountSatang: 0,
    tenders: {
      depositSatang: 0,
      cashSatang: 0,
      creditKbankSatang: 0,
      creditIcbcSatang: 0,
      transferKbankSatang: 0,
      transferIcbcSatang: 0,
      appWebsiteSatang: 0,
      otherSatang: 0,
    },
    remark: null,
    missingSeqAnomaly: false,
    ...overrides,
  };
}

function reportSheetRecord(overrides: Partial<ReportSheetRecord> = {}): ReportSheetRecord {
  return {
    sheetName: "test-report-sheet",
    dateResolution: {
      date: { year: 2099, month: 5, day: 5 },
      sources: [],
      agreementCount: 1,
      hasDisagreement: false,
      unresolved: false,
      singleSource: true,
      discarded: [],
    },
    property: "hf",
    quarantineReason: null,
    quarantineDetail: null,
    bookingRows: [],
    totalsRow: null,
    ownSummaryBlock: { lines: [], reconciliationTotalSatang: null },
    skippedBlankRowCount: 0,
    unclassifiedRows: [],
    ...overrides,
  };
}

describe("writeDay — a fresh day", () => {
  const date = "2099-01-01";

  test("writes the workbook's cells, cash block and provenance", () => {
    const outcome = writeDay(dbModule, plan(date), true);
    expect(outcome.humanCellSkips).toHaveLength(0);
    expect(outcome.humanDaySkips).toHaveLength(0);
    expect(cellAmount(date, roomCashId)).toBe(890_00);
    const day = dbModule.getSheetDay("hf", date)!;
    expect(day.provenance).toBe("summary_only");
    expect(day.updatedBy).toBe(IMPORT_ACTOR);
    expect(day.cashOverride.bankedSatang).toBe(1_085_00);
  });

  test("re-running is a no-op on row counts (idempotency preserved)", () => {
    const before = dbModule.db.query<{ n: number }, []>("SELECT count(*) AS n FROM income_amounts").get()!.n;
    const outcome = writeDay(dbModule, plan(date), true);
    const after = dbModule.db.query<{ n: number }, []>("SELECT count(*) AS n FROM income_amounts").get()!.n;
    expect(after).toBe(before);
    expect(outcome.humanCellSkips).toHaveLength(0);
    expect(cellAmount(date, roomCashId)).toBe(890_00);
  });
});

describe("writeDay — the human-edit guard", () => {
  // The real case this exists for: hf 2025-05-06, where the owner corrected
  // the day in the live app after the first import.
  const date = "2099-02-02";

  test("a human's corrected cell survives, and is reported rather than silently kept", () => {
    writeDay(dbModule, plan(date), true);

    // The owner corrects the day in the app: overwrites a cell the workbook
    // also carries, and adds one the workbook does not mention at all.
    dbModule.saveIncomeCell("hf", date, roomCashId, 761_00, null, HUMAN, "manual", true);
    dbModule.saveIncomeCell("hf", date, barCashId, 195_00, null, HUMAN, "manual", true);

    const outcome = writeDay(dbModule, plan(date), true);

    expect(cellAmount(date, roomCashId)).toBe(761_00);
    expect(cellAmount(date, barCashId)).toBe(195_00);
    expect(outcome.humanCellSkips).toHaveLength(1);
    expect(outcome.humanCellSkips[0]).toMatchObject({
      property: "hf",
      date,
      categoryKey: "room_cash",
      workbookSatang: 890_00,
      existingSatang: 761_00,
      existingSource: "manual",
      existingUpdatedBy: HUMAN,
    });
    // The skipped cell still counts toward the day's total, because that IS
    // what the ledger now holds for the day.
    expect(outcome.incomeSatangWritten).toBe(761_00);
    expect(outcome.dayRow.incomeCategoriesWritten).toBe(0);
  });

  test("the guard is stable: a second and third re-run keep skipping, never re-claiming the cell", () => {
    for (let run = 0; run < 2; run++) {
      const outcome = writeDay(dbModule, plan(date), true);
      expect(outcome.humanCellSkips).toHaveLength(1);
      expect(cellAmount(date, roomCashId)).toBe(761_00);
    }
  });
});

describe("writeDay — day-level fields a human owns", () => {
  const date = "2099-03-03";

  test("a human's note, cash block and verification survive, and the day-level write is skipped", () => {
    writeDay(dbModule, plan(date), true);

    // A manager edits the day: note, own cash-block figures, verification.
    // Fixture text is deliberately English: nothing here should ever be
    // mistaken for real Thai ledger data.
    dbModule.setSheetDayNote("hf", date, "manager note, keep this", HUMAN);
    dbModule.setCashBlockOverride("hf", date, { bankedSatang: 2_000_00 }, HUMAN);
    dbModule.setDayVerified("hf", date, true, HUMAN);

    const outcome = writeDay(dbModule, plan(date), true);

    const day = dbModule.getSheetDay("hf", date)!;
    expect(day.note).toBe("manager note, keep this");
    expect(day.cashOverride.bankedSatang).toBe(2_000_00);
    expect(day.verifiedBy).toBe(HUMAN);
    expect(day.verifiedAt).not.toBeNull();
    expect(day.updatedBy).toBe(HUMAN);
    expect(outcome.dayRow.cashBlockOverrideWritten).toBe(false);
    expect(outcome.humanDaySkips).toHaveLength(1);
    expect(outcome.humanDaySkips[0]!.skippedFields).toEqual([
      "cash-block override",
      "provenance stamp (summary_only)",
    ]);
  });

  test("the day-level guard is stable across runs: updated_by is never re-stamped to the importer", () => {
    // This is the trap: if a run stamped updated_by = import:excel here, the
    // NEXT run would think it owned the day again and clobber the manager's
    // cash block.
    writeDay(dbModule, plan(date), true);
    const outcome = writeDay(dbModule, plan(date), true);
    expect(dbModule.getSheetDay("hf", date)!.updatedBy).toBe(HUMAN);
    expect(dbModule.getSheetDay("hf", date)!.cashOverride.bankedSatang).toBe(2_000_00);
    expect(outcome.humanDaySkips).toHaveLength(1);
  });
});

describe("writeDay — booking lines and other-income keep their existing protection", () => {
  const date = "2099-04-04";

  test("a human's other-income item is not deleted by the importer's replace step", () => {
    writeDay(dbModule, plan(date), true);
    dbModule.createOtherIncomeItem("hf", date, "human-entered item", 300_00, false, HUMAN);
    writeDay(dbModule, plan(date), true);
    const items = dbModule.getOtherIncomeForDay("hf", date);
    expect(items).toHaveLength(1);
    expect(items[0]!.createdBy).toBe(HUMAN);
  });
});

describe("writeDay — Fix 1: a reconstructed day reads its per-booking sheet's own recap block", () => {
  const date = "2099-05-05";

  test("real case (hfville 2025-09-27 shape): a zero bar block plus one itemized อื่นๆ entry embedded on the marker row", () => {
    const report = reportSheetRecord({
      sheetName: "HF-Ville27-9-68  ",
      bookingRows: [
        bookingRow({ tenders: { depositSatang: 0, cashSatang: 0, creditKbankSatang: 0, creditIcbcSatang: 0, transferKbankSatang: 0, transferIcbcSatang: 0, appWebsiteSatang: 129_000, otherSatang: 0 } }),
        bookingRow({ tenders: { depositSatang: 0, cashSatang: 0, creditKbankSatang: 0, creditIcbcSatang: 0, transferKbankSatang: 0, transferIcbcSatang: 0, appWebsiteSatang: 139_000, otherSatang: 0 } }),
      ],
      ownSummaryBlock: {
        lines: [
          ownSummaryLine("เว็บไซด์ Agoda", 268_000),
          ownSummaryLine("รายการ อื่นๆ ค่าคีการด์ห้อง  108  ลูกค้าทำหายปรับเป็นเงิน 200 (เงินสด)", 200_00),
          ownSummaryLine("บาร์น้ำ เงินสด", 0),
          ownSummaryLine("โอน", 0),
          ownSummaryLine("เครดิต", 0),
        ],
        reconciliationTotalSatang: 288_000,
      },
    });

    const outcome = writeDay(
      dbModule,
      plan(date, { provenance: "reconstructed", summary: null, reportSheet: report, reportWorkbookLabel: "Ville per-booking" }),
      true,
    );

    // The web tender still comes from the booking rows, unchanged.
    expect(cellAmount(date, webId)).toBe(268_000);
    // No bar income was written — the recap block itself is genuinely zero.
    expect(cellAmount(date, barCashId)).toBeUndefined();
    expect(cellAmount(date, barTransferId)).toBeUndefined();
    // The 200.00 THB is now imported as an itemized other-income entry.
    const items = dbModule.getOtherIncomeForDay("hf", date);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      description: "ค่าคีการด์ห้อง  108  ลูกค้าทำหายปรับเป็นเงิน 200 (เงินสด)",
      amountSatang: 200_00,
      isCash: true,
    });
    // The day now foots to 2,880.00 THB (2,680.00 booking web + 200.00 recap-only), not 2,680.00.
    expect(outcome.incomeSatangWritten).toBe(268_000 + 200_00);
    expect(outcome.warnings.some((w) => w.includes("recap block") && w.includes("200"))).toBe(true);
  });

  test("bar_cash and bar_transfer are written directly (not itemized) when the recap block carries a positive amount", () => {
    const report = reportSheetRecord({
      bookingRows: [],
      ownSummaryBlock: {
        lines: [ownSummaryLine("บาร์น้ำ เงินสด", 100_00), ownSummaryLine("โอน", 50_00), ownSummaryLine("เครดิต", 25_00)],
        reconciliationTotalSatang: 175_00,
      },
    });
    const barDate = "2099-05-06";
    const outcome = writeDay(
      dbModule,
      plan(barDate, { provenance: "reconstructed", summary: null, reportSheet: report }),
      true,
    );
    expect(cellAmount(barDate, barCashId)).toBe(100_00);
    expect(cellAmount(barDate, barTransferId)).toBe(75_00); // โอน + เครดิต
    expect(outcome.warnings.some((w) => w.includes("bar_cash") && w.includes("recap block"))).toBe(true);
    expect(outcome.warnings.some((w) => w.includes("bar_transfer") && w.includes("recap block"))).toBe(true);
  });

  test("re-running a reconstructed day is idempotent: row counts don't grow and the item isn't duplicated", () => {
    const idempotentDate = "2099-05-07";
    const report = reportSheetRecord({
      bookingRows: [],
      ownSummaryBlock: {
        lines: [ownSummaryLine("รายการ อื่นๆ ค่าอาหารเช้า เงินสด", 60_00), ownSummaryLine("บาร์น้ำ เงินสด", 0)],
        reconciliationTotalSatang: 60_00,
      },
    });
    const runPlan = plan(idempotentDate, { provenance: "reconstructed", summary: null, reportSheet: report });
    writeDay(dbModule, runPlan, true);
    writeDay(dbModule, runPlan, true);
    const items = dbModule.getOtherIncomeForDay("hf", idempotentDate);
    expect(items).toHaveLength(1);
    expect(items[0]!.amountSatang).toBe(60_00);
  });
});

describe("writeDay — transcribed days are unaffected by the Fix 1 recap-block read (regression)", () => {
  const date = "2099-05-08";

  test("a transcribed day's own report-sheet recap block is never read — the typed summary alone still governs", () => {
    const report = reportSheetRecord({
      bookingRows: [bookingRow()],
      // A recap block that, if wrongly read on a transcribed day, would
      // fabricate bar income and an other-income item nobody typed.
      ownSummaryBlock: {
        lines: [
          ownSummaryLine("รายการ อื่นๆ ควรถูกละเว้นในวันที่พิมพ์สรุปแล้ว", 999_00),
          ownSummaryLine("บาร์น้ำ เงินสด", 999_00),
          ownSummaryLine("โอน", 999_00),
          ownSummaryLine("เครดิต", 0),
        ],
        reconciliationTotalSatang: null,
      },
    });

    writeDay(dbModule, plan(date, { provenance: "transcribed", summary: summary(), reportSheet: report }), true);

    expect(cellAmount(date, barCashId)).toBeUndefined();
    expect(cellAmount(date, barTransferId)).toBeUndefined();
    expect(dbModule.getOtherIncomeForDay("hf", date)).toHaveLength(0);
    // The typed summary's own roomCash figure is what actually landed.
    expect(cellAmount(date, roomCashId)).toBe(890_00);
  });
});

describe("writeDay — Fix 2: the report states the provenance actually stored, not the planned one", () => {
  const date = "2099-05-09";

  test("a day the human owns via an ordinary income-cell edit (touchSheetDay, matching src/server/server.ts) keeps its stored provenance in the report", () => {
    // Initial import: a fresh, importer-owned day.
    writeDay(dbModule, plan(date, { provenance: "summary_only" }), true);
    expect(dbModule.getSheetDay("hf", date)!.provenance).toBe("summary_only");

    // The owner corrects the day in the live app — the real hf 2025-05-06
    // case (adding บาร์น้ำ เงินสด). server.ts's income-save route calls
    // saveIncomeCell then touchSheetDay, which marks the WHOLE sheet_days
    // row human-owned (human-edits.ts is coarse on purpose).
    dbModule.saveIncomeCell("hf", date, barCashId, 195_00, null, HUMAN, "manual", true);
    dbModule.touchSheetDay("hf", date, HUMAN);

    // A later run now classifies the day as transcribed (e.g. a newly
    // accepted summary sheet for it).
    const outcome = writeDay(dbModule, plan(date, { provenance: "transcribed" }), true);

    // The skip itself is correct: no money is affected, and the day-level
    // guard must not clobber the human's ownership of the row.
    expect(outcome.humanDaySkips).toHaveLength(1);
    expect(dbModule.getSheetDay("hf", date)!.provenance).toBe("summary_only"); // never upgraded
    expect(cellAmount(date, barCashId)).toBe(195_00); // human's cell survives untouched

    // THE FIX: `provenance` is what this run WANTED to stamp (the freshly
    // planned classification); `storedProvenance` is what sheet_days
    // actually holds. The report must never conflate the two.
    expect(outcome.dayRow.provenance).toBe("transcribed");
    expect(outcome.dayRow.storedProvenance).toBe("summary_only");
  });
});
