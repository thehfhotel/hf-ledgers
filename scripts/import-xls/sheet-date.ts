// Three-source date resolution: sheet name, Buddhist-era date cell, and the
// Thai "ประจำวันที่ ..." header. No single source is trustworthy on its own —
// see the module-level notes in each parser for the measured failure rates.
//
// Buddhist Era (BE) to Christian Era (CE): subtract 543. We read with
// `cellDates: false` and convert BE serials via XLSX.SSF.parse_date_code
// ourselves — `cellDates: true` yields BE-year Date literals and
// `toISOString()` shifts the day backwards in Asia/Bangkok.

import * as XLSX from "xlsx";
import type {
  DateResolution,
  DateSourceName,
  DateSourceReading,
  DiscardedDateCandidate,
  PlainDate,
} from "./types.ts";
import { decodeRange, cellAt, isNumericCell } from "./xlsx-cells.ts";

const BUDDHIST_TO_CHRISTIAN_OFFSET = 543;

const THAI_MONTHS: Record<string, number> = {
  "มกราคม": 1,
  "กุมภาพันธ์": 2,
  "มีนาคม": 3,
  "เมษายน": 4,
  "พฤษภาคม": 5,
  "มิถุนายน": 6,
  "กรกฎาคม": 7,
  "สิงหาคม": 8,
  "กันยายน": 9,
  "ตุลาคม": 10,
  "พฤศจิกายน": 11,
  "ธันวาคม": 12,
};

const SHEET_NAME_DATE_PATTERN = /^(\d{1,2})-(\d{1,2})-(\d{2,4})$/;
const HEADER_DATE_PATTERN = /ประจำวันที่\s*(\d{1,2})\s*([ก-๙]+)\s*(\d{4})/;
const HEADER_MARKER = "ประจำวันที่";
const SHEET_NAME_PREFIX_PATTERN = /^HF[-\s]?ViLLE\s*/i;
const SHEET_NAME_SUFFIX_PATTERN = /\s*\(\d+\)\s*$/;

/** Plausible BE-year window for date-cell scanning — wide enough to cover
 *  the operational data range with margin, narrow enough that ordinary
 *  money amounts (always well under six figures) can never collide. */
const PLAUSIBLE_BUDDHIST_YEAR_MIN = 2560;
const PLAUSIBLE_BUDDHIST_YEAR_MAX = 2580;

function fromBuddhistYear(day: number, month: number, buddhistYear: number): PlainDate | null {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(buddhistYear)) return null;
  return { year: buddhistYear - BUDDHIST_TO_CHRISTIAN_OFFSET, month, day };
}

/** Parse a trimmed sheet name like "22-4-68", "HF-ViLLE 23-7-69", or
 *  "1-5-2568" into a CE date. Returns null for names with no date pattern
 *  at all (e.g. the bare-number sheets). */
export function parseSheetNameDate(rawSheetName: string): PlainDate | null {
  const cleaned = rawSheetName
    .trim()
    .replace(SHEET_NAME_PREFIX_PATTERN, "")
    .trim()
    .replace(SHEET_NAME_SUFFIX_PATTERN, "")
    .trim();
  const match = cleaned.match(SHEET_NAME_DATE_PATTERN);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let buddhistYear = Number(match[3]);
  if (buddhistYear < 100) buddhistYear += 2500;
  return fromBuddhistYear(day, month, buddhistYear);
}

/** Parse a Thai "ประจำวันที่ 1 มีนาคม 2568" style header string into a CE date. */
export function parseHeaderDate(headerText: string): PlainDate | null {
  const match = headerText.match(HEADER_DATE_PATTERN);
  if (!match) return null;
  const day = Number(match[1]);
  const monthNumber = THAI_MONTHS[match[2]];
  if (!monthNumber) return null;
  const buddhistYear = Number(match[3]);
  return fromBuddhistYear(day, monthNumber, buddhistYear);
}

/** Find the raw header text (if any) containing the "ประจำวันที่" marker. */
export function findHeaderText(ws: XLSX.WorkSheet): string | null {
  const range = decodeRange(ws);
  for (let row = range.s.r; row <= range.e.r; row++) {
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = cellAt(ws, row, col);
      if (cell != null && typeof cell.v === "string" && cell.v.includes(HEADER_MARKER)) {
        return cell.v;
      }
    }
  }
  return null;
}

/** Scan every numeric cell for a plausible Buddhist-Era date serial and
 *  return the first match in row-major order. Returns null when no cell in
 *  the sheet parses to a plausible date. */
export function findDateCellDate(ws: XLSX.WorkSheet): PlainDate | null {
  const range = decodeRange(ws);
  for (let row = range.s.r; row <= range.e.r; row++) {
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = cellAt(ws, row, col);
      if (!isNumericCell(cell)) continue;
      const parsed = XLSX.SSF.parse_date_code(cell!.v as number);
      if (
        parsed &&
        parsed.y >= PLAUSIBLE_BUDDHIST_YEAR_MIN &&
        parsed.y <= PLAUSIBLE_BUDDHIST_YEAR_MAX &&
        parsed.m >= 1 &&
        parsed.m <= 12 &&
        parsed.d >= 1 &&
        parsed.d <= 31
      ) {
        const date = fromBuddhistYear(parsed.d, parsed.m, parsed.y);
        if (date) return date;
      }
    }
  }
  return null;
}

function dateKey(date: PlainDate): string {
  return `${date.year}-${date.month}-${date.day}`;
}

/**
 * A candidate must fall in this window to be trusted as a vote at all. Wide
 * enough to cover the estate's whole operating history with margin, narrow
 * enough that a sheet-name typo (verified real case: "18-6-8568" parses to
 * Buddhist year 8568 / CE 8025) can never be counted as a genuine, merely
 * disagreeing, source — it is garbage, not a candidate.
 */
const PLAUSIBLE_MIN_DATE: PlainDate = { year: 2024, month: 1, day: 1 };
const PLAUSIBLE_MAX_DATE: PlainDate = { year: 2027, month: 12, day: 31 };

function comparePlainDates(a: PlainDate, b: PlainDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

function isWithinPlausibleWindow(date: PlainDate): boolean {
  return comparePlainDates(date, PLAUSIBLE_MIN_DATE) >= 0 && comparePlainDates(date, PLAUSIBLE_MAX_DATE) <= 0;
}

/**
 * Majority vote across up to three date sources.
 *
 * Candidates outside the plausible-year window are discarded before voting
 * — they never count as a disagreeing source, only as noise recorded in
 * `discarded` for the report. Among the surviving candidates: two or more
 * agreeing resolves confidently; exactly one survivor resolves confidently
 * too (`singleSource: true` — nothing else contradicts it, since summary
 * sheets structurally have no header and plenty of sheet names don't parse
 * as dates at all). Only a genuine disagreement among two or more survivors,
 * or zero survivors, resolves to `unresolved: true`.
 */
export function voteDate(sources: DateSourceReading[]): DateResolution {
  const discarded: DiscardedDateCandidate[] = [];
  const survivors: Array<{ source: DateSourceName; date: PlainDate }> = [];

  for (const { source, date } of sources) {
    if (date === null) continue;
    if (isWithinPlausibleWindow(date)) {
      survivors.push({ source, date });
    } else {
      discarded.push({ source, date });
    }
  }

  if (survivors.length === 0) {
    return {
      date: null,
      sources,
      agreementCount: 0,
      hasDisagreement: false,
      unresolved: true,
      singleSource: false,
      discarded,
    };
  }

  const groups = new Map<string, { date: PlainDate; sourceNames: DateSourceName[] }>();
  for (const { source, date } of survivors) {
    const key = dateKey(date);
    const existing = groups.get(key);
    if (existing) existing.sourceNames.push(source);
    else groups.set(key, { date, sourceNames: [source] });
  }

  if (groups.size === 1) {
    // Every surviving candidate agrees — including the trivial case of
    // exactly one survivor, since there is nothing left to contradict it.
    const [only] = groups.values();
    return {
      date: only.date,
      sources,
      agreementCount: only.sourceNames.length,
      hasDisagreement: false,
      unresolved: false,
      singleSource: survivors.length === 1,
      discarded,
    };
  }

  const ranked = [...groups.values()].sort((a, b) => b.sourceNames.length - a.sourceNames.length);
  const [winner, runnerUp] = ranked;

  if (winner.sourceNames.length > runnerUp.sourceNames.length) {
    // A clear majority among survivors (e.g. 2 agree, 1 stale outlier).
    return {
      date: winner.date,
      sources,
      agreementCount: winner.sourceNames.length,
      hasDisagreement: true,
      unresolved: false,
      singleSource: false,
      discarded,
    };
  }

  // A genuine tie among surviving candidates (1-vs-1, or every group size 1
  // in a three-way split) — hard-fail rather than guess.
  return {
    date: null,
    sources,
    agreementCount: 0,
    hasDisagreement: true,
    unresolved: true,
    singleSource: false,
    discarded,
  };
}

export interface ResolveSheetDateOptions {
  sheetName: string;
  worksheet: XLSX.WorkSheet;
  /** Per the verified facts, the header is present on per-booking sheets
   *  and absent from every summary sheet — pass false there so the vote
   *  never treats "structurally absent" as a disagreeing source. */
  includeHeader: boolean;
}

export function resolveSheetDate(options: ResolveSheetDateOptions): DateResolution {
  const { sheetName, worksheet, includeHeader } = options;

  const nameDate = parseSheetNameDate(sheetName);
  const cellDate = findDateCellDate(worksheet);
  const headerDate = includeHeader ? parseHeaderDate(findHeaderText(worksheet) ?? "") : null;

  return voteDate([
    { source: "sheetName", date: nameDate },
    { source: "dateCell", date: cellDate },
    { source: "header", date: headerDate },
  ]);
}
