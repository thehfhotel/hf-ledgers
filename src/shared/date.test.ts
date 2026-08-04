import { describe, expect, test } from "bun:test";
import { timeBangkok } from "./date.ts";

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
