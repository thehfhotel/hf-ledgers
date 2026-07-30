import { describe, expect, it } from "bun:test";
import { shouldLeaveCell, stepColumn, stepRow } from "./gridNav.ts";

// The column order the booking grid navigates, in miniature.
const COLS = ["bookingNo", "guestName", "roomCount", "cash", "remark"];

describe("stepColumn", () => {
  it("moves one column each way", () => {
    expect(stepColumn("guestName", "left", COLS)).toBe("bookingNo");
    expect(stepColumn("guestName", "right", COLS)).toBe("roomCount");
  });

  it("stops at the row's edges rather than wrapping into another booking", () => {
    expect(stepColumn("bookingNo", "left", COLS)).toBeNull();
    expect(stepColumn("remark", "right", COLS)).toBeNull();
  });

  it("ignores a column that is not navigable (seq, delete button)", () => {
    expect(stepColumn("seq", "right", COLS)).toBeNull();
  });
});

describe("stepRow", () => {
  it("moves one row each way", () => {
    expect(stepRow(3, "up")).toBe(2);
    expect(stepRow(3, "down")).toBe(4);
  });

  it("stops at the top", () => {
    expect(stepRow(0, "up")).toBeNull();
  });

  it("has no bottom bound — the blank row is just the next row down, and the caller's lookup finds nothing past it", () => {
    expect(stepRow(99, "down")).toBe(100);
  });
});

describe("shouldLeaveCell", () => {
  it("keeps Left/Right inside the text while the caret has somewhere to go", () => {
    // "somchai", caret in the middle
    expect(shouldLeaveCell("left", 3, 3, 7)).toBe(false);
    expect(shouldLeaveCell("right", 3, 3, 7)).toBe(false);
  });

  it("leaves the cell once the caret is parked at that edge", () => {
    expect(shouldLeaveCell("left", 0, 0, 7)).toBe(true);
    expect(shouldLeaveCell("right", 7, 7, 7)).toBe(true);
  });

  it("does not leave from the wrong edge", () => {
    expect(shouldLeaveCell("right", 0, 0, 7)).toBe(false);
    expect(shouldLeaveCell("left", 7, 7, 7)).toBe(false);
  });

  it("leaves an empty cell in either direction — both edges at once", () => {
    expect(shouldLeaveCell("left", 0, 0, 0)).toBe(true);
    expect(shouldLeaveCell("right", 0, 0, 0)).toBe(true);
  });

  it("lets an active selection keep the key", () => {
    expect(shouldLeaveCell("left", 0, 4, 7)).toBe(false);
    expect(shouldLeaveCell("right", 3, 7, 7)).toBe(false);
  });

  it("stays put when the browser cannot report a caret position", () => {
    expect(shouldLeaveCell("left", null, null, 7)).toBe(false);
    expect(shouldLeaveCell("right", null, null, 7)).toBe(false);
  });
});
