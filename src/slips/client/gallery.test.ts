import { describe, expect, test } from "bun:test";
import { historyCount, shouldShowCountBadge } from "./gallery.ts";

describe("shouldShowCountBadge", () => {
  test("hidden at 0 and 1 — a lone (or absent) picture needs no badge", () => {
    expect(shouldShowCountBadge(0)).toBe(false);
    expect(shouldShowCountBadge(1)).toBe(false);
  });

  test("shown from 2 up", () => {
    expect(shouldShowCountBadge(2)).toBe(true);
    expect(shouldShowCountBadge(3)).toBe(true);
    expect(shouldShowCountBadge(10)).toBe(true);
  });

  test("reads the CURRENT-picture count, never a version number — a lone current picture at a high version (repeatedly เปลี่ยน'd) still hides the badge", () => {
    // Simulates: 3 supersedes then 1 fresh attach -> latestVersion 4, count 1.
    expect(shouldShowCountBadge(1)).toBe(false);
  });
});

describe("historyCount", () => {
  test("current + superseded — every version ever attached", () => {
    expect(historyCount({ count: 1, superseded: 0 })).toBe(1);
    expect(historyCount({ count: 1, superseded: 2 })).toBe(3);
    expect(historyCount({ count: 0, superseded: 3 })).toBe(3); // every picture taken out, history still remembers all 3
  });

  test("deliberately differs from the badge's own current-only count whenever anything has ever been superseded", () => {
    const attachment = { count: 1, superseded: 2 };
    expect(shouldShowCountBadge(attachment.count)).toBe(false); // badge: hidden, only 1 current
    expect(historyCount(attachment)).toBe(3); // ประวัติ: 3 รายการ, full history
  });
});
