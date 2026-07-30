// Low-level worksheet cell helpers shared by the summary and per-booking
// parsers. Kept tiny and dependency-free apart from `xlsx` itself.

import * as XLSX from "xlsx";

export function decodeRange(ws: XLSX.WorkSheet): XLSX.Range {
  return XLSX.utils.decode_range(ws["!ref"] ?? "A1:A1");
}

export function cellAt(ws: XLSX.WorkSheet, row: number, col: number): XLSX.CellObject | undefined {
  return ws[XLSX.utils.encode_cell({ r: row, c: col })];
}

export function cellAddress(row: number, col: number): string {
  return XLSX.utils.encode_cell({ r: row, c: col });
}

export function isPresent(cell: XLSX.CellObject | undefined): boolean {
  return cell != null && cell.v !== undefined && cell.v !== null && cell.v !== "";
}

/**
 * Coerce a cell to a number, tolerating numeric-looking TEXT cells (verified
 * real case: a totals row's room-count/nights cells stored as the strings
 * "13"/"16" instead of numbers — a strict `t === "n"` check misses them
 * entirely, which silently zeroes a real amount or breaks totals-row
 * detection). Never invents a value: non-numeric text yields null.
 */
export function coercedNumber(cell: XLSX.CellObject | undefined): number | null {
  if (cell == null || cell.v == null) return null;
  if (typeof cell.v === "number") return cell.v;
  if (typeof cell.v === "string") {
    const trimmed = cell.v.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

export function isNumericCell(cell: XLSX.CellObject | undefined): boolean {
  return coercedNumber(cell) !== null;
}

/** True only for a real, non-zero amount — an explicit zero (a real,
 *  written "0") does not count as "carrying financial data" for row
 *  classification purposes. */
export function hasNonZeroValue(cell: XLSX.CellObject | undefined): boolean {
  const value = coercedNumber(cell);
  return value !== null && value !== 0;
}

export function numberOrZero(cell: XLSX.CellObject | undefined): number {
  return coercedNumber(cell) ?? 0;
}

export function numberOrNull(cell: XLSX.CellObject | undefined): number | null {
  return coercedNumber(cell);
}

export function textOrEmpty(cell: XLSX.CellObject | undefined): string {
  if (cell == null || cell.v == null) return "";
  return String(cell.v).trim();
}

export function textOrNull(cell: XLSX.CellObject | undefined): string | null {
  const text = textOrEmpty(cell);
  return text === "" ? null : text;
}

/** Iterate every populated cell of a sheet in row-major order. */
export function* iterateCells(
  ws: XLSX.WorkSheet,
): Generator<{ row: number; col: number; cell: XLSX.CellObject }> {
  const range = decodeRange(ws);
  for (let row = range.s.r; row <= range.e.r; row++) {
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = cellAt(ws, row, col);
      if (cell != null) yield { row, col, cell };
    }
  }
}
