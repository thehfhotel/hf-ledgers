// Tests for pmsPullAccept.ts (review fixes 1 + 2, extracted out of
// PmsPullResultDialog.tsx so this control-flow logic is testable without a
// component-rendering harness — this repo has none, same reasoning as
// packages/shared/src/money.ts's shouldCommitAmount tests).

import { describe, expect, test } from "bun:test";
import type { PmsBookingLineChange } from "../api.ts";
import { normalizeChangedRows, runAcceptFlow } from "./pmsPullAccept.ts";

describe("normalizeChangedRows (review fix 1)", () => {
  test("undefined -> empty array — the defensive fallback for a `changed`-absent response", () => {
    expect(normalizeChangedRows(undefined)).toEqual([]);
  });

  test("an existing array passes through unchanged", () => {
    const rows: PmsBookingLineChange[] = [
      { id: 1, pmsRef: "R2610-0001", bookingNo: "CH26-000001", handEdited: false, fields: [] },
    ];
    expect(normalizeChangedRows(rows)).toBe(rows);
  });

  test("an empty array passes through as itself, not a fresh []", () => {
    const rows: PmsBookingLineChange[] = [];
    expect(normalizeChangedRows(rows)).toBe(rows);
  });
});

describe("runAcceptFlow (review fix 2 — accept/refetch ordering)", () => {
  test("the accept call fails: accept-failed with the error message, refetch is never called", async () => {
    let refetchCalled = false;
    const outcome = await runAcceptFlow(
      () => Promise.reject(new Error("pms candidate no longer available (vanished or became a refund)")),
      async () => {
        refetchCalled = true;
      },
    );
    expect(outcome).toEqual({
      kind: "accept-failed",
      message: "pms candidate no longer available (vanished or became a refund)",
    });
    expect(refetchCalled).toBe(false);
  });

  test("a non-Error rejection from the accept call still yields a Thai fallback message", async () => {
    const outcome = await runAcceptFlow(
      () => Promise.reject("boom"),
      async () => {},
    );
    expect(outcome).toEqual({ kind: "accept-failed", message: "ยอมรับการเปลี่ยนแปลงไม่สำเร็จ" });
  });

  test("accept succeeds, refetch succeeds: accepted-and-refreshed", async () => {
    let acceptCalled = false;
    let refetchCalled = false;
    const outcome = await runAcceptFlow(
      async () => {
        acceptCalled = true;
      },
      async () => {
        refetchCalled = true;
      },
    );
    expect(outcome).toEqual({ kind: "accepted-and-refreshed" });
    expect(acceptCalled).toBe(true);
    expect(refetchCalled).toBe(true);
  });

  // The exact gap the review flagged: removing the row before the refetch
  // resolves would strand a refetch failure with nowhere to render while
  // the on-screen booking data stays stale. This case must be
  // distinguishable from "accept-failed" so the caller can keep the row
  // visible (not retryable via the same button — the money already moved)
  // and show a dialog-level banner instead of a per-row error.
  test("accept succeeds but refetch fails: accepted-but-refresh-failed, distinct from accept-failed", async () => {
    const outcome = await runAcceptFlow(
      () => Promise.resolve(),
      () => Promise.reject(new Error("network error")),
    );
    expect(outcome).toEqual({ kind: "accepted-but-refresh-failed" });
  });

  test("ordering: acceptCall is always awaited to completion before refetch begins", async () => {
    const order: string[] = [];
    await runAcceptFlow(
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push("accept");
      },
      async () => {
        order.push("refetch");
      },
    );
    expect(order).toEqual(["accept", "refetch"]);
  });
});
