// The owner-approved resolutions for the 26 sheets the first import run
// QUARANTINED — declared as data, one reviewable row per physical sheet.
//
// WHY THIS FILE EXISTS
// A sheet is quarantined when the importer cannot decide safely on its own:
// either two sheets resolved to the same (property, date) — it refuses to
// merge — or the three date signals (sheet name / in-sheet DATE cell /
// header) disagreed, or the property classifier found the room numbers and
// the title row contradicting each other. Every such sheet was then
// investigated against the source workbooks and, for HF Ville, cross-checked
// against the estate's independent front-desk daily report. The owner
// approved the outcome. Those decisions live HERE, as a table keyed by
// workbook + VERBATIM sheet name, so a reviewer can read them without
// reading the importer, and so nobody has to hand-patch the database.
//
// THE RULE FOR ANYTHING NOT LISTED: unchanged behaviour. A sheet with no
// entry here goes through exactly the same date vote, property classifier
// and quarantine as before. This table only ever un-blocks a sheet that a
// human has already ruled on.
//
// SHEET NAMES ARE VERBATIM AND SIGNIFICANT. Several pairs differ only by
// trailing spaces or a single full stop ('13-12-2568' vs '13-12-2568.',
// 'HF-Ville1-10-68' vs 'HF-Ville1-10-68 '). They are copied byte-for-byte
// from the workbooks; never retype one, and never "tidy" the whitespace.
// A name that matches no sheet in its workbook is a hard error at import
// time (see assertEveryResolutionMatched) rather than a silent no-op.
//
// THE RECURRING PATTERN BEHIND MOST OF THIS: reception makes tomorrow's
// sheet by copying today's, so the sheet NAME gets updated and the date
// typed INSIDE the sheet does not. In every case where an independent
// figure existed, the sheet name was right and the in-sheet date was stale.
// That is why so many entries below accept the sheet-name date.
//
// No money figures appear in this file on purpose: this repository is
// public. Sheet names and dates are fine; totals are not.

import type { DateResolution, PlainDate, PropertyCode, ReportSheetRecord, SummaryDayRecord } from "./types.ts";

/** The four fixed source workbooks, as resolution keys. `*-summary` are the
 *  "สรุปยอด" day-summary books, `*-booking` the per-booking "รายงานรายรับ"
 *  books. A workbook's own file identity is NOT the same thing as a sheet's
 *  property: the HF summary book holds one genuine Ville day, and the Ville
 *  per-booking book holds many HF sheets. */
export type WorkbookId = "hf-summary" | "hf-booking" | "ville-summary" | "ville-booking";

export type ResolutionLayer = "summary" | "booking";

export interface AcceptResolution {
  workbook: WorkbookId;
  /** Verbatim, including trailing spaces and punctuation. */
  sheetName: string;
  action: "accept";
  /** Overrides both the date vote and the property classifier for this sheet. */
  property: PropertyCode;
  /** Bangkok calendar date, YYYY-MM-DD. */
  date: string;
  rationale: string;
}

export interface IgnoreResolution {
  workbook: WorkbookId;
  sheetName: string;
  action: "ignore";
  rationale: string;
}

export type SheetResolution = AcceptResolution | IgnoreResolution;

const VILLE_SUMMARY_CLONE_RATIONALE =
  "The Ville summary workbook is a copy of the HF summary workbook for everything before " +
  "2025-12-12 (see VILLE_COPY_WINDOW_END_EXCLUSIVE in plan.ts). This sheet is byte-identical to the HF " +
  "summary sheet of the same name and is resolved there instead; it is not a Ville day and was never a " +
  "candidate for import as one.";

const VILLE_SEP_2025_TITLE_RATIONALE =
  "Quarantined only because the title row carries the generic รายงานรายรับของโรงแรม with no (Hf-Ville) " +
  "marker, while every room number on the sheet is a Ville room. Accepted as HF Ville under its " +
  "sheet-name date.";

const VILLE_STALE_INSHEET_DATE_RATIONALE =
  "Stale in-sheet date: reception copied the previous day's sheet, updated the tab name and left the " +
  "date typed inside pointing at the wrong day, which is what made the pair collide. The sheet name is " +
  "the correct one, confirmed against the independent front-desk daily report.";

/**
 * THE OWNER-APPROVED TABLE. 39 sheets, covering all 26 quarantined rows of
 * the first run (a duplicate-date quarantine names two sheets, so it takes
 * two entries to resolve).
 */
export const SHEET_RESOLUTIONS: readonly SheetResolution[] = [
  // ── HF summary ("สรุปยอด(รายวัน).xls") ───────────────────────────────────
  {
    workbook: "hf-summary",
    sheetName: "18-9-2568          ",
    action: "accept",
    property: "hf",
    date: "2025-09-18",
    rationale:
      "Not a duplicate of its FH-Ville twin — two properties share this one date. This plain sheet is The " +
      "Harbour Front; its typed categories include a bar-cash line the day's booking rows do not carry, so " +
      "accepting it upgrades the day from reconstructed to transcribed.",
  },
  {
    workbook: "hf-summary",
    sheetName: "18-9-2568 FH-Ville   ",
    action: "accept",
    property: "hfville",
    date: "2025-09-18",
    rationale:
      "The other half of the same date, and HF Ville's first ever day: a transfer-only sheet that matches the " +
      "Ville per-booking sheet 'Hf-ville18-9-68' exactly. It was typed into the HF workbook, so it is a " +
      "genuine Ville day rather than a stale HF copy — it therefore also bypasses the Ville copy window.",
  },
  {
    workbook: "hf-summary",
    sheetName: "30-5-68   ",
    action: "accept",
    property: "hf",
    date: "2025-04-30",
    rationale:
      "The sheet name is a typo for 30 April. The in-sheet DATE cell reads 2568-04-30, the per-booking sheet " +
      "'30-4-68 ' foots to the same five categories, and the tab sits immediately before '1-5-2568' — exactly " +
      "where an end-of-April sheet belongs. 2025-05-30 has no sheet in this workbook at all, and stays absent.",
  },
  {
    workbook: "hf-summary",
    sheetName: "6-5-2568",
    action: "accept",
    property: "hf",
    date: "2025-05-06",
    rationale:
      "Name says 6 May, the in-sheet DATE cell says 5 May, and 5 May already has its own sheet " +
      "('5-5-2568    ', imported). The per-booking sheet '6-5-2568' foots to this sheet's four categories, so " +
      "the name is right and the in-sheet date is the stale one.",
  },
  {
    workbook: "hf-summary",
    sheetName: "27-4-69 ",
    action: "ignore",
    rationale:
      "Byte-identical copy of '28-4-69  ' — same in-sheet DATE cell (2569-04-28) and the same figures, which " +
      "per-booking sheet '28-4-69    ' independently confirms as 28 April's. Nothing about 27 April is on it. " +
      "2026-04-27 is already correct in the ledger, reconstructed from its own per-booking sheet.",
  },
  {
    workbook: "hf-summary",
    sheetName: "15-6-69 )",
    action: "accept",
    property: "hf",
    date: "2026-06-15",
    rationale:
      "No real conflict: the sheet name and the DATE cell both say 2026-06-15. The resolver was defeated by " +
      "the stray ')' in the name plus an extra 'โรงแรม HF' header row that shifted the date cell down one.",
  },

  // ── Ville summary ("สรุปยอดรายวัน - HF-Ville.xls") ────────────────────────
  {
    workbook: "ville-summary",
    sheetName: "18-9-2568          ",
    action: "ignore",
    rationale: VILLE_SUMMARY_CLONE_RATIONALE,
  },
  {
    workbook: "ville-summary",
    sheetName: "18-9-2568 FH-Ville   ",
    action: "ignore",
    rationale:
      VILLE_SUMMARY_CLONE_RATIONALE +
      " The genuine 2025-09-18 Ville day is the identically-named sheet in the HF workbook, accepted above.",
  },
  {
    workbook: "ville-summary",
    sheetName: "30-5-68   ",
    action: "ignore",
    rationale: VILLE_SUMMARY_CLONE_RATIONALE,
  },
  {
    workbook: "ville-summary",
    sheetName: "6-5-2568",
    action: "ignore",
    rationale: VILLE_SUMMARY_CLONE_RATIONALE,
  },
  {
    workbook: "ville-summary",
    sheetName: "13-12-2568",
    action: "ignore",
    rationale:
      "Abandoned zeroed copy: every category is empty and it still carries a leftover HF label " +
      "(ค่าอาหารเช้า ห้อง 418 — 418 is an HF room, not a Ville room). The real day is the twin whose name " +
      "ends in a full stop.",
  },
  {
    workbook: "ville-summary",
    sheetName: "13-12-2568.",
    action: "accept",
    property: "hfville",
    date: "2025-12-13",
    rationale:
      "The real typed summary for the day: its categories match the Ville per-booking sheet " +
      "'HF-ViLLE 13-12-68' to the satang. Upgrades 2025-12-13 from reconstructed to transcribed.",
  },
  {
    workbook: "ville-summary",
    sheetName: "Sheet5",
    action: "ignore",
    rationale: "Completely empty — zero rows, zero cells. Nothing to date and nothing to import, permanently.",
  },
  {
    workbook: "ville-summary",
    sheetName: "Sheet6",
    action: "ignore",
    rationale: "Completely empty — zero rows, zero cells. Nothing to date and nothing to import, permanently.",
  },

  // ── HF per-booking ("รายงานรายรับโรงแรม(รายวัน).xlsx") ────────────────────
  {
    workbook: "hf-booking",
    sheetName: "5-4-69   (2)",
    action: "accept",
    property: "hf",
    date: "2026-04-05",
    rationale:
      "The two copies are identical row for row, guest for guest. This one's header names the correct day, " +
      "while '5-4-69  ' reads 'ประจำวันที่ 35 เมษายน 2569' — an impossible date. Restores the day's guest " +
      "rows; the money was already correct from the summary workbook.",
  },
  {
    workbook: "hf-booking",
    sheetName: "5-4-69  ",
    action: "ignore",
    rationale: "Duplicate of '5-4-69   (2)' with an impossible day number typed in its header.",
  },
  {
    workbook: "hf-booking",
    sheetName: "13-6-69 ",
    action: "accept",
    property: "hf",
    date: "2026-06-13",
    rationale:
      "The superset of the pair: identical guest rows and identical money to '13-6-69  (2)', but it keeps " +
      "BOTH other-income notes where the copy kept only one. Restores the day's guest rows.",
  },
  {
    workbook: "hf-booking",
    sheetName: "13-6-69  (2)",
    action: "ignore",
    rationale: "Lossy copy of '13-6-69 ' — one of the two other-income notes is missing from it.",
  },
  {
    workbook: "hf-booking",
    sheetName: "6-5-69 แรกทำ",
    action: "accept",
    property: "hf",
    date: "2026-05-06",
    rationale:
      "Differs from its copy on exactly one booking row (B2605-0105, a bill the customer asked to have split " +
      "per room): this sheet lists three rooms where the copy lists one. The HF summary sheet '6-5-69  ' types " +
      "the transfer figure and day total that follow from THIS sheet, so the summary book settles it.",
  },
  {
    workbook: "hf-booking",
    sheetName: "6-5-69 แรกทำ (2)",
    action: "ignore",
    rationale:
      "Copy that under-states booking B2605-0105 (one room instead of three) and therefore disagrees with the " +
      "typed HF summary sheet for the day.",
  },
  {
    workbook: "hf-booking",
    sheetName: "21-06-69",
    action: "ignore",
    rationale:
      "Blank to-do stub: no guest rows, every tender zero, the only content a reminder typed into the " +
      "customer-name cell asking for the day to be keyed in. The day's money is already correct from the " +
      "summary workbook — nothing is missing, but nobody ever typed the guest detail.",
  },
  {
    workbook: "hf-booking",
    sheetName: "22-06-69",
    action: "ignore",
    rationale:
      "Blank to-do stub like '21-06-69', and its in-sheet DATE cell says 2569-06-21 — which is why the two " +
      "collided and cost the 22nd its sheet as well. The day's money is already correct from the summary " +
      "workbook.",
  },

  // ── Ville per-booking ("รายงานรายรับโรงแรมรายวัน HF-VILLE.xls") ───────────
  {
    workbook: "ville-booking",
    sheetName: "Hf-ville18-9-68",
    action: "accept",
    property: "hfville",
    date: "2025-09-18",
    rationale: VILLE_SEP_2025_TITLE_RATIONALE + " Front-desk report confirms this day to the baht.",
  },
  {
    workbook: "ville-booking",
    sheetName: "Hf-ville19-9-68 ",
    action: "accept",
    property: "hfville",
    date: "2025-09-19",
    rationale:
      VILLE_SEP_2025_TITLE_RATIONALE +
      " No front-desk record exists for this day at all, so this sheet is the only evidence it happened.",
  },
  {
    workbook: "ville-booking",
    sheetName: "Hf-ville20-9-68  ",
    action: "accept",
    property: "hfville",
    date: "2025-09-20",
    rationale:
      VILLE_SEP_2025_TITLE_RATIONALE +
      " Known gap in the SOURCE, not in the import: the front-desk report shows one more room for this day " +
      "than the sheet does, so the sheet appears short one room. Imported exactly as written — never invented.",
  },
  {
    workbook: "ville-booking",
    sheetName: "Hf-ville21-9-68   ",
    action: "accept",
    property: "hfville",
    date: "2025-09-21",
    rationale: VILLE_SEP_2025_TITLE_RATIONALE + " Front-desk report agrees.",
  },
  {
    workbook: "ville-booking",
    sheetName: "Hf-ville22-9-68    ",
    action: "accept",
    property: "hfville",
    date: "2025-09-22",
    rationale: VILLE_SEP_2025_TITLE_RATIONALE + " Front-desk report confirms this day to the baht.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-Ville27-9-68  ",
    action: "accept",
    property: "hfville",
    date: "2025-09-27",
    rationale:
      "The real 27 September day. Its twin 'HF-Ville28-9-68 ' is an unedited copy of it — same two guests, " +
      "same in-sheet DATE cell (2568-09-27) — which is what made them collide.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-Ville28-9-68 ",
    action: "ignore",
    rationale:
      "Unedited copy of 'HF-Ville27-9-68  ': the same two guests and the same in-sheet date, with the keycard " +
      "fine's description stripped. 28 September was never filled in. The front-desk report shows only the " +
      "monthly room for that date, i.e. no collectable income, so leaving it out of the ledger is faithful.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-Ville1-10-68",
    action: "accept",
    property: "hfville",
    date: "2025-10-01",
    rationale:
      "The real 1 October day (four guest rows, one of them a monthly prepayment). Confirmed against the " +
      "front-desk report once the monthly room is accounted for. This day is currently missing from the " +
      "ledger entirely.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-Ville1-10-68 ",
    action: "ignore",
    rationale:
      "Empty shell (note the trailing space in the name): numbered rows with no guest names, no room numbers " +
      "and every figure zero.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-Ville7-10-68 ",
    action: "accept",
    property: "hfville",
    date: "2025-10-07",
    rationale:
      VILLE_STALE_INSHEET_DATE_RATIONALE +
      " This sheet's own header and DATE cell both still say 8 October, but its guests are entirely different " +
      "from the 8 October sheet's, so they are two real days.",
  },
  {
    workbook: "ville-booking",
    sheetName: "Hf-Ville8-10-68",
    action: "accept",
    property: "hfville",
    date: "2025-10-08",
    rationale:
      "The genuine 8 October day — different guests from 'HF-Ville7-10-68 ', and the larger of the two, which " +
      "matches the front-desk report's room count for the 8th.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-Ville22-10-68",
    action: "accept",
    property: "hfville",
    date: "2025-10-22",
    rationale: VILLE_STALE_INSHEET_DATE_RATIONALE + " This sheet's own date text is the correct one of the pair.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-Ville23-10-68 ",
    action: "accept",
    property: "hfville",
    date: "2025-10-23",
    rationale: VILLE_STALE_INSHEET_DATE_RATIONALE + " Its in-sheet date text wrongly says 22 October.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-ViLLE 26-10-68",
    action: "accept",
    property: "hfville",
    date: "2025-10-26",
    rationale: VILLE_STALE_INSHEET_DATE_RATIONALE + " Its in-sheet date text wrongly says 27 October.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-Ville27-10-68  ",
    action: "accept",
    property: "hfville",
    date: "2025-10-27",
    rationale: VILLE_STALE_INSHEET_DATE_RATIONALE + " This sheet's own date text is the correct one of the pair.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-ViLLE 13-7-69.",
    action: "accept",
    property: "hfville",
    date: "2026-07-13",
    rationale:
      "Holds the day's single real guest row (note the trailing full stop in the name). Restores that row to a " +
      "day whose money was already correct from the summary workbook.",
  },
  {
    workbook: "ville-booking",
    sheetName: "HF-ViLLE 13-7-69",
    action: "ignore",
    rationale: "Blank 15-row template: numbered rows, no guest, every figure zero.",
  },
];

// ── indexing + validation ──────────────────────────────────────────────────

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function layerOf(workbook: WorkbookId): ResolutionLayer {
  return workbook.endsWith("-summary") ? "summary" : "booking";
}

function indexKey(workbook: WorkbookId, sheetName: string): string {
  // U+0000 can never occur in a sheet name, so it is a safe separator for a
  // key whose second half legitimately ends in spaces.
  return `${workbook}\u0000${sheetName}`;
}

/**
 * Structural self-check on the table above, run once at module load so a
 * bad edit fails immediately rather than half-importing: no duplicate
 * (workbook, sheet) rows, well-formed dates, and — the one that actually
 * bites — no two accepted sheets aimed at the same (property, date) within
 * the same layer, which would just recreate the duplicate-date collision
 * this table exists to resolve.
 */
export function validateResolutions(resolutions: readonly SheetResolution[] = SHEET_RESOLUTIONS): void {
  const seen = new Set<string>();
  const acceptedTargets = new Map<string, string>();
  for (const r of resolutions) {
    const key = indexKey(r.workbook, r.sheetName);
    if (seen.has(key)) {
      throw new Error(`resolutions: duplicate entry for ${r.workbook} sheet "${r.sheetName}"`);
    }
    seen.add(key);
    if (r.action !== "accept") continue;
    if (!ISO_DATE_PATTERN.test(r.date)) {
      throw new Error(`resolutions: ${r.workbook} sheet "${r.sheetName}" has a non-ISO date "${r.date}"`);
    }
    const target = `${layerOf(r.workbook)} ${r.property} ${r.date}`;
    const clash = acceptedTargets.get(target);
    if (clash !== undefined) {
      throw new Error(
        `resolutions: "${r.sheetName}" and "${clash}" both accept ${target} — that recreates the duplicate ` +
          "collision the table exists to resolve",
      );
    }
    acceptedTargets.set(target, r.sheetName);
  }
}

validateResolutions();

const RESOLUTION_BY_KEY: ReadonlyMap<string, SheetResolution> = new Map(
  SHEET_RESOLUTIONS.map((r) => [indexKey(r.workbook, r.sheetName), r]),
);

export function resolutionFor(workbook: WorkbookId, sheetName: string): SheetResolution | null {
  return RESOLUTION_BY_KEY.get(indexKey(workbook, sheetName)) ?? null;
}

/** ISO dates a summary sheet was explicitly accepted for, per property. An
 *  explicit owner ruling outranks the Ville copy-window heuristic — see
 *  buildDayPlans' `resolvedVilleSummaryDates`. */
export function acceptedSummaryDates(property: PropertyCode): Set<string> {
  const dates = new Set<string>();
  for (const r of SHEET_RESOLUTIONS) {
    if (r.action === "accept" && layerOf(r.workbook) === "summary" && r.property === property) dates.add(r.date);
  }
  return dates;
}

// ── application to parsed records ──────────────────────────────────────────

/** One audit line per resolution actually applied to a parsed sheet — the
 *  report renders these so a run says out loud which human decisions it
 *  leaned on, and what the sheet itself had claimed. */
export interface AppliedResolutionRow {
  workbook: WorkbookId;
  sheetName: string;
  action: "accept" | "ignore";
  property: PropertyCode | null;
  date: string | null;
  /** What the sheet's own signals said before the resolution overrode them. */
  originalDetail: string;
  rationale: string;
}

export interface ResolutionApplication<T> {
  /** Input records minus the ignored ones, with accepted ones rewritten. */
  records: T[];
  applied: AppliedResolutionRow[];
  /** Entries listed for this workbook that matched no parsed sheet — always
   *  a mistake in the table (a mistyped or re-tidied sheet name). */
  unmatched: SheetResolution[];
}

export function isoToPlainDate(iso: string): PlainDate {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

function sameDate(a: PlainDate | null, b: PlainDate): boolean {
  return a !== null && a.year === b.year && a.month === b.month && a.day === b.day;
}

function describeOriginal(resolution: DateResolution, property: PropertyCode | null): string {
  const parts = resolution.sources
    .filter((s) => s.date !== null)
    .map((s) => `${s.source}=${s.date!.year}-${String(s.date!.month).padStart(2, "0")}-${String(s.date!.day).padStart(2, "0")}`);
  const dateText = parts.length > 0 ? parts.join(", ") : "no date candidate survived";
  return `${dateText}; classified property=${property ?? "quarantined"}`;
}

/**
 * Rewrites a sheet's date resolution to the human-approved date while KEEPING
 * every original source reading, so the report can still show what the sheet
 * itself claimed. Deliberately not a fresh object: an audit trail that
 * forgets the disagreement it overrode is worse than no audit trail.
 */
export function forcedDateResolution(original: DateResolution, forced: PlainDate): DateResolution {
  return {
    ...original,
    date: forced,
    unresolved: false,
    agreementCount: original.sources.filter((s) => sameDate(s.date, forced)).length,
    hasDisagreement: original.sources.some((s) => s.date !== null && !sameDate(s.date, forced)),
    singleSource: false,
  };
}

export function applyResolutionsToSummaryDays(
  workbook: WorkbookId,
  days: readonly SummaryDayRecord[],
): ResolutionApplication<SummaryDayRecord> {
  const records: SummaryDayRecord[] = [];
  const applied: AppliedResolutionRow[] = [];
  const matched = new Set<string>();

  for (const day of days) {
    const resolution = resolutionFor(workbook, day.sheetName);
    if (!resolution) {
      records.push(day);
      continue;
    }
    matched.add(day.sheetName);
    applied.push({
      workbook,
      sheetName: day.sheetName,
      action: resolution.action,
      property: resolution.action === "accept" ? resolution.property : null,
      date: resolution.action === "accept" ? resolution.date : null,
      originalDetail: describeOriginal(day.dateResolution, day.property),
      rationale: resolution.rationale,
    });
    if (resolution.action === "ignore") continue;
    records.push({
      ...day,
      property: resolution.property,
      dateResolution: forcedDateResolution(day.dateResolution, isoToPlainDate(resolution.date)),
    });
  }

  return { records, applied, unmatched: unmatchedFor(workbook, matched) };
}

export function applyResolutionsToReportSheets(
  workbook: WorkbookId,
  sheets: readonly ReportSheetRecord[],
): ResolutionApplication<ReportSheetRecord> {
  const records: ReportSheetRecord[] = [];
  const applied: AppliedResolutionRow[] = [];
  const matched = new Set<string>();

  for (const sheet of sheets) {
    const resolution = resolutionFor(workbook, sheet.sheetName);
    if (!resolution) {
      records.push(sheet);
      continue;
    }
    matched.add(sheet.sheetName);
    applied.push({
      workbook,
      sheetName: sheet.sheetName,
      action: resolution.action,
      property: resolution.action === "accept" ? resolution.property : null,
      date: resolution.action === "accept" ? resolution.date : null,
      originalDetail: describeOriginal(sheet.dateResolution, sheet.property),
      rationale: resolution.rationale,
    });
    if (resolution.action === "ignore") continue;
    records.push({
      ...sheet,
      property: resolution.property,
      // An accepted sheet is no longer quarantined — the human ruling IS the
      // classification. Clearing these keeps the downstream grouping honest:
      // a record with a property must never still claim a quarantine reason.
      quarantineReason: null,
      quarantineDetail: null,
      dateResolution: forcedDateResolution(sheet.dateResolution, isoToPlainDate(resolution.date)),
    });
  }

  return { records, applied, unmatched: unmatchedFor(workbook, matched) };
}

function unmatchedFor(workbook: WorkbookId, matched: ReadonlySet<string>): SheetResolution[] {
  return SHEET_RESOLUTIONS.filter((r) => r.workbook === workbook && !matched.has(r.sheetName));
}

/**
 * Fails the run when any listed sheet name matched nothing. A resolution
 * that silently applies to no sheet is the failure mode this table is most
 * likely to hit (several names differ from a sibling only by trailing
 * whitespace or a full stop), and it would quietly leave a day quarantined
 * while the report claimed it was resolved.
 */
export function assertEveryResolutionMatched(unmatched: readonly SheetResolution[]): void {
  if (unmatched.length === 0) return;
  const detail = unmatched.map((r) => `${r.workbook} "${r.sheetName}"`).join("; ");
  throw new Error(
    `resolutions: ${unmatched.length} entr(y/ies) matched no sheet in their workbook — check for trailing ` +
      `spaces or a full stop in the name: ${detail}`,
  );
}
