// THE HUMAN-EDIT GUARD.
//
// THE RULE, in one sentence: this importer may only ever overwrite what this
// importer itself wrote. Anything a human owns — a corrected income cell, a
// day note, a cash-block figure, a verification stamp — wins over the
// workbook, on every re-run, forever.
//
// WHY IT HAS TO BE ENFORCED HERE AND NOT TRUSTED TO THE WRITE PATH:
// booking_lines and other_income_items are safe by construction, because
// their idempotent "replace" step deletes only rows with
// created_by = 'import:excel' (see deletePriorImportRows in import.ts).
// Everything else in the write path had no such protection: saveIncomeCell
// is a blind upsert on (property, date, category_id), and the sheet_days
// writes are blind upserts on (property, date). A re-run therefore used to
// silently clobber hand-entered figures. This is not hypothetical — the
// owner corrected hf 2025-05-06 in the live app (a บาร์น้ำ เงินสด figure the
// summary sheet's own total omits); that cell is stamped source='manual',
// updated_by=<the owner's email> and MUST survive every future run.
//
// OWNERSHIP TEST, income cell: importer-owned iff source === 'import' AND
// updated_by === 'import:excel'. Both, because the app writes source
// 'manual' or 'booking' under a person's email, and a future writer could
// reuse either half.
//
// OWNERSHIP TEST, day-level (sheet_days): importer-owned iff the row does
// not exist yet, or its updated_by === 'import:excel'. Coarse on purpose —
// one row carries the note, the four cash-block override fields, the
// verification stamp and the provenance, so ANY human touch on that day
// takes the whole row out of the importer's hands. Erring the other way
// would mean reasoning per-field about a row a person is actively editing.
//
// THE TRAP THIS AVOIDS, and the reason the day-level write must be skipped
// wholesale rather than "written but preserving the note": if a run stamped
// updated_by = 'import:excel' onto a day a human owns, it would erase the
// very evidence the guard depends on, and the NEXT run would happily
// clobber that human's cash block. The guard has to be stable across runs,
// so a human-owned sheet_days row is left completely untouched.
//
// IDEMPOTENCY IS PRESERVED: an importer-owned cell stays freely re-writable,
// so running twice is still a no-op on row counts.

import type { PropertyCode } from "./types.ts";
import type { CategoryKey } from "../../src/shared/types.ts";

/** The one actor string this importer writes under, everywhere. */
export const IMPORT_ACTOR = "import:excel";

/** The `source` value this importer stamps on every income cell it writes. */
export const IMPORT_CELL_SOURCE = "import";

/** The subset of an income cell that decides who owns it. */
export interface IncomeCellOwnership {
  source: string;
  updatedBy: string;
}

/** The subset of a sheet_days row that decides who owns the day. */
export interface SheetDayOwnership {
  updatedBy: string;
}

/**
 * True when the importer is allowed to write this income cell: either
 * nothing is stored yet, or what is stored was written by this importer.
 * False means a human owns the cell and the workbook value must be skipped
 * (and reported).
 */
export function importerMayWriteIncomeCell(existing: IncomeCellOwnership | null | undefined): boolean {
  if (!existing) return true;
  return existing.source === IMPORT_CELL_SOURCE && existing.updatedBy === IMPORT_ACTOR;
}

/**
 * True when the importer is allowed to write this day's sheet_days row (the
 * note, the four cash-block override fields, the verification stamp and the
 * provenance): either the row does not exist yet, or the importer wrote it
 * last.
 */
export function importerMayWriteDayLevel(existing: SheetDayOwnership | null | undefined): boolean {
  if (!existing) return true;
  return existing.updatedBy === IMPORT_ACTOR;
}

/** One skipped income cell — reported so a run is auditable rather than
 *  silently partial. `workbookSatang` is what the sheet said; `existing*`
 *  is the human value that won. */
export interface HumanCellSkipRow {
  property: PropertyCode;
  date: string;
  categoryId: number;
  categoryKey: CategoryKey | null;
  workbookSatang: number;
  existingSatang: number;
  existingSource: string;
  existingUpdatedBy: string;
}

/** One skipped day-level write, with the fields that were NOT applied. */
export interface HumanDaySkipRow {
  property: PropertyCode;
  date: string;
  existingUpdatedBy: string;
  /** e.g. ["cash-block override", "provenance stamp"] — what the workbook
   *  wanted to write and did not. */
  skippedFields: string[];
}

export interface HumanEditGuardTotals {
  cellsSkipped: number;
  daysSkipped: number;
}

export function guardTotals(cells: readonly HumanCellSkipRow[], days: readonly HumanDaySkipRow[]): HumanEditGuardTotals {
  return { cellsSkipped: cells.length, daysSkipped: days.length };
}
