// Keyboard grid navigation — the pure part.
//
// The booking grid resolves keyboard moves by data attributes rather than a
// ref array (see components/BookingGrid.tsx), because rows and the blank
// bottom row come and go and an uncontrolled cell's <input> node is replaced
// whenever its committed value changes. Everything that can be decided
// WITHOUT the DOM lives here so it is unit-testable; the caller does the
// querySelector and the focus.

export type NavDirection = "up" | "down" | "left" | "right";

/**
 * The column one step left/right of `col`, or null at the row's edge.
 *
 * `columns` is the grid's left-to-right editable order. Deliberately no
 * wrapping: running off the end of a row lands you in a different booking,
 * which is never what an arrow key should mean on a paper-sheet layout.
 */
export function stepColumn(col: string, dir: "left" | "right", columns: readonly string[]): string | null {
  const at = columns.indexOf(col);
  if (at === -1) return null;
  const next = dir === "left" ? at - 1 : at + 1;
  return next >= 0 && next < columns.length ? columns[next] : null;
}

/**
 * Should a Left/Right press move to the next cell, or stay in this one and
 * move the caret? Text is the whole point of guestName/remark, so horizontal
 * arrows only leave a cell once the caret is already parked at that edge
 * with nothing selected — the same rule a spreadsheet's in-cell edit uses.
 *
 * `start`/`end` are the input's selectionStart/selectionEnd (null when the
 * browser cannot report them, in which case treat it as "not at an edge" and
 * leave the keypress alone).
 */
export function shouldLeaveCell(
  dir: "left" | "right",
  start: number | null,
  end: number | null,
  length: number,
): boolean {
  if (start === null || end === null) return false;
  if (start !== end) return false; // an active selection: let the key adjust it
  return dir === "left" ? start === 0 : start === length;
}

/**
 * The row a vertical move targets, or null when it would leave the grid.
 * Row 0 is the first booking; the blank bottom row is just `lines.length`,
 * so it needs no special case here — the caller's DOM lookup simply finds
 * nothing below it.
 */
export function stepRow(row: number, dir: "up" | "down"): number | null {
  const next = dir === "up" ? row - 1 : row + 1;
  return next >= 0 ? next : null;
}
