// See storage.test.ts's own comment: env vars must be set BEFORE db.ts
// opens the database — a plain top-level `import` would be hoisted ahead of
// these assignments, so both modules are loaded via a dynamic import below,
// after the env is set.
process.env.SLIPS_DB_PATH = ":memory:";
process.env.SLIPS_DATA_DIR = `/tmp/slips-cash-marks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

import { describe, expect, test } from "bun:test";
const { db } = await import("./db.ts");
const { cashMarkStates, markCash, unmarkCash } = await import("./cash-marks.ts");

/** Direct row-count assertion against the append-only event log itself —
 * the strongest possible proof that "idempotent" really means "wrote no
 * row", not just "returned the same-looking value". */
function eventCount(property: string, auditKey: string): number {
  return db
    .query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n FROM cash_mark_events WHERE property = ? AND audit_key = ?`)
    .get(property, auditKey)!.n;
}

describe("markCash", () => {
  test("marks a settlement, returning the fresh event's at/by", () => {
    const result = markCash("hf", "CH-MARK-1", "2026-08-10", "reception@thehfhotel.org");
    expect(result.by).toBe("reception@thehfhotel.org");
    expect(result.at).toBeTruthy();
    expect(eventCount("hf", "CH-MARK-1")).toBe(1);
  });

  test("re-marking an already-marked settlement is idempotent: inserts NO extra event row, and the FIRST mark stands", () => {
    const first = markCash("hf", "CH-MARK-2", "2026-08-10", "a@x.com");
    expect(eventCount("hf", "CH-MARK-2")).toBe(1);

    const second = markCash("hf", "CH-MARK-2", "2026-08-10", "b@x.com"); // a different actor tapping the same button again
    expect(eventCount("hf", "CH-MARK-2")).toBe(1); // still exactly one row
    expect(second).toEqual(first); // the original mark's at/by, never overwritten by the second caller
  });
});

describe("unmarkCash", () => {
  test("unmarks a previously-marked settlement — the key becomes absent from a batch lookup", () => {
    markCash("hf", "CH-UNMARK-1", "2026-08-10", "a@x.com");
    unmarkCash("hf", "CH-UNMARK-1", "2026-08-10", "b@x.com");
    const out = cashMarkStates("hf", ["CH-UNMARK-1"]);
    expect(out.has("CH-UNMARK-1")).toBe(false);
  });

  test("un-marking a settlement that was NEVER marked is a harmless no-op: inserts NO event row", () => {
    expect(eventCount("hf", "CH-UNMARK-NEVER")).toBe(0);
    unmarkCash("hf", "CH-UNMARK-NEVER", "2026-08-10", "a@x.com");
    expect(eventCount("hf", "CH-UNMARK-NEVER")).toBe(0);
  });

  test("re-unmarking an already-unmarked settlement is idempotent: inserts NO extra event row", () => {
    markCash("hf", "CH-UNMARK-2", "2026-08-10", "a@x.com");
    unmarkCash("hf", "CH-UNMARK-2", "2026-08-10", "b@x.com");
    expect(eventCount("hf", "CH-UNMARK-2")).toBe(2); // mark + unmark

    unmarkCash("hf", "CH-UNMARK-2", "2026-08-10", "c@x.com"); // already unmarked
    expect(eventCount("hf", "CH-UNMARK-2")).toBe(2); // no third row
  });
});

describe("mark -> unmark -> mark (append-only proof)", () => {
  test("leaves exactly 3 event rows — every toggle survives as its own row, and the LATEST mark is what current state reads", () => {
    const firstMark = markCash("hf", "CH-CYCLE-1", "2026-08-10", "a@x.com");
    unmarkCash("hf", "CH-CYCLE-1", "2026-08-10", "b@x.com");
    const secondMark = markCash("hf", "CH-CYCLE-1", "2026-08-10", "c@x.com");

    expect(eventCount("hf", "CH-CYCLE-1")).toBe(3);
    expect(secondMark.by).toBe("c@x.com"); // the FRESH event, not the first mark
    expect(secondMark).not.toEqual(firstMark);
    expect(cashMarkStates("hf", ["CH-CYCLE-1"]).get("CH-CYCLE-1")).toEqual(secondMark);
  });
});

describe("cashMarkStates", () => {
  test("a key that was never marked is ABSENT from the map, not present with a null/zero placeholder", () => {
    const out = cashMarkStates("hf", ["CH-BATCH-NEVER"]);
    expect(out.has("CH-BATCH-NEVER")).toBe(false);
    expect(out.get("CH-BATCH-NEVER")).toBeUndefined();
  });

  test("batch mixes marked and unmarked keys correctly in one call", () => {
    markCash("hf", "CH-BATCH-1", "2026-08-10", "a@x.com");
    markCash("hf", "CH-BATCH-2", "2026-08-10", "b@x.com");
    unmarkCash("hf", "CH-BATCH-2", "2026-08-10", "c@x.com");
    // CH-BATCH-3 never touched at all.

    const out = cashMarkStates("hf", ["CH-BATCH-1", "CH-BATCH-2", "CH-BATCH-3"]);
    expect(out.get("CH-BATCH-1")?.by).toBe("a@x.com");
    expect(out.has("CH-BATCH-2")).toBe(false);
    expect(out.has("CH-BATCH-3")).toBe(false);
  });

  test("scoped per property — the SAME auditKey marked on one property never leaks into the other's batch lookup", () => {
    markCash("hf", "CH-PROP-SHARED", "2026-08-10", "hf-reception@x.com");
    // hfville never marks this key.

    expect(cashMarkStates("hf", ["CH-PROP-SHARED"]).get("CH-PROP-SHARED")?.by).toBe("hf-reception@x.com");
    expect(cashMarkStates("hfville", ["CH-PROP-SHARED"]).has("CH-PROP-SHARED")).toBe(false);
  });

  test("empty key list returns an empty map without querying", () => {
    expect(cashMarkStates("hf", []).size).toBe(0);
  });
});
