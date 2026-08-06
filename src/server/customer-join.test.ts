// Regression test for the zero-padded-ledger_cust_no bug (owner-reported,
// 2026-08-06): iHOTEL writes ZERO-PADDED customer numbers in
// `ht_payment_ledger.ledger_cust_no` on hotelville ('C0720', ~37% of that
// property's rows) but the original join built its comparison key by
// STRING CONCATENATION (`'C' || legacy_id::text`), which only ever
// produces the unpadded form — so every padded row silently failed to
// join, `buildGuestName` got nulls, and the UI showed "ไม่ทราบชื่อ" for a
// real, on-file guest (confirmed: R2608-0036 / 'C0720' / legacy_id=720,
// นาย ศตพล วรกำเเหง).
//
// The fix, `CUSTOMER_JOIN_ON` (pms-prefill.ts), is ONE exported SQL
// fragment shared by every query that joins `ht_payment_ledger` to
// `ht_customers` — this file has two independent jobs:
//
//   1. Pin the fragment's INTENDED numeric-extraction behavior via its
//      pure-JS mirror, `extractLegacyIdFromCustNo` (see that function's own
//      doc comment for why a mirror, not the SQL itself, is what gets unit
//      tested here — no local Postgres in `bun test`).
//   2. Grep every `src/server/*.ts` source file (import-isolation.test.ts's
//      own walk-the-source-tree style) to assert NO query re-derives the
//      join condition by hand instead of interpolating
//      `${CUSTOMER_JOIN_ON}` — the exact way this bug shipped identically
//      copy-pasted into four separate call sites in the first place. A
//      future query that reintroduces a hand-rolled join fails this test
//      immediately, regardless of whether anyone remembers this history.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { extractLegacyIdFromCustNo } from "./pms-prefill.ts";

const SERVER_DIR = resolve(import.meta.dir);

/** Every non-test .ts file directly under src/server — the full set of
 * modules that could plausibly grow a fresh `ht_payment_ledger` /
 * `ht_customers` join. */
function listServerSourceFiles(): string[] {
  return readdirSync(SERVER_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SERVER_DIR, f));
}

describe("CUSTOMER_JOIN_ON is the sole ht_customers join condition in src/server", () => {
  test("no source file re-derives the join via the old string-concatenation form", () => {
    // The exact shape of the original bug: building the comparison key by
    // gluing a literal 'C' onto legacy_id, which can only ever produce the
    // UNPADDED form. Matched as CODE (`ledger_cust_no = 'C' || c.legacy_id`),
    // not as bare text — pms-prefill.ts's own doc comment on CUSTOMER_JOIN_ON
    // legitimately quotes this exact broken expression as history, and must
    // not itself trip this test.
    const OLD_BUGGY_JOIN_RE = /ledger_cust_no\s*=\s*'C'\s*\|\|\s*c\.legacy_id/;
    for (const file of listServerSourceFiles()) {
      const collapsed = readFileSync(file, "utf8").replace(/\s+/g, " ");
      expect(collapsed).not.toMatch(OLD_BUGGY_JOIN_RE);
    }
  });

  test("every 'LEFT JOIN ht_customers' site interpolates ${CUSTOMER_JOIN_ON} immediately after", () => {
    let joinSitesFound = 0;
    for (const file of listServerSourceFiles()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("LEFT JOIN ht_customers")) return;
        joinSitesFound++;
        const nearby = lines.slice(i, i + 3).join("\n");
        expect(nearby).toContain("${CUSTOMER_JOIN_ON}");
      });
    }
    // Guards the guard: pms-prefill.ts, deposit-register.ts, and
    // day-audit.ts (x2, including fetchReceivedLookup's own inline query)
    // are the four known call sites — if this count ever drops to 0 (e.g.
    // a refactor renames the join), the assertion above would pass
    // vacuously and silently stop protecting anything.
    expect(joinSitesFound).toBeGreaterThanOrEqual(4);
  });
});

describe("extractLegacyIdFromCustNo — pure mirror of CUSTOMER_JOIN_ON's CASE expression", () => {
  const matches: ReadonlyArray<readonly [string, number]> = [
    // zero-padded (hotelville's real shape — the bug) — leading zeros are
    // discarded by the numeric parse, same as the SQL's ::int cast.
    ["C0720", 720],
    // unpadded C-prefixed (hotelnew's real shape — must keep working)
    ["C720", 720],
    // bare digits, no C prefix at all (the third shape the join must
    // tolerate, per pms-prefill.ts's own doc comment)
    ["720", 720],
    // lowercase c — the SQL guard is [Cc], case-insensitive on the prefix only
    ["c0720", 720],
    // multiple leading zeros
    ["C00007", 7],
  ];

  for (const [input, expected] of matches) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(extractLegacyIdFromCustNo(input)).toBe(expected);
    });
  }

  const nonMatches: ReadonlyArray<string> = [
    "CXYZ", // non-numeric remainder — must never throw a cast error
    "", // empty string
    "C", // C with nothing after it
    "abc123", // garbage prefix, not a bare C
    "C-720", // a sign character the guard regex doesn't allow through
  ];

  for (const input of nonMatches) {
    test(`${JSON.stringify(input)} -> null, never throws`, () => {
      expect(() => extractLegacyIdFromCustNo(input)).not.toThrow();
      expect(extractLegacyIdFromCustNo(input)).toBeNull();
    });
  }

  test("null and undefined -> null, never throws", () => {
    expect(() => extractLegacyIdFromCustNo(null)).not.toThrow();
    expect(() => extractLegacyIdFromCustNo(undefined)).not.toThrow();
    expect(extractLegacyIdFromCustNo(null)).toBeNull();
    expect(extractLegacyIdFromCustNo(undefined)).toBeNull();
  });
});

// Real per-property ledger_cust_no shapes (2026-08-06 live survey, run
// directly against both PMS Postgres mirrors via hf-slips) — FIXTURE ADVICE
// #1/#2: never hand-invent a value, and give BOTH properties a realistic
// MIX of padded and unpadded forms, since hf is NOT padding-free either
// (5.6% of its own rows pad too — just far rarer than hfville's 36.9%). The
// join's numeric-extraction rule is intentionally property-agnostic (see
// CUSTOMER_JOIN_ON's own doc comment: "padding can never matter again, in
// either direction"), so these two lists exist to pin the literal values
// this feature actually sees per property, not to exercise a different code
// path per property.
describe("extractLegacyIdFromCustNo — real per-property ledger_cust_no shapes", () => {
  // hf: 94.4% unpadded live, but a real 5.6% padded minority too — a
  // fixture asserting "hf never pads" would itself be wrong (this is the
  // exact class of gap the calling brief flags: HF-shaped fixtures hid a
  // real hfville bug once already).
  const hfSamples: ReadonlyArray<readonly [string, number]> = [
    ["C830", 830],
    ["C578", 578],
    ["C242", 242],
    ["C0830", 830], // hf's own padded minority (~5.6% of hf's ht_payment_ledger rows)
    ["C0578", 578],
    ["C0242", 242],
    ["C0564", 564],
    ["C0068", 68],
  ];
  for (const [input, expected] of hfSamples) {
    test(`hf: ${JSON.stringify(input)} -> ${expected}`, () => {
      expect(extractLegacyIdFromCustNo(input)).toBe(expected);
    });
  }

  // hfville: padding is the LARGER share (36.9%) but still a minority
  // overall (63.1% unpadded) — both real shapes must resolve to the same id.
  const hfvilleSamples: ReadonlyArray<readonly [string, number]> = [
    ["C0578", 578],
    ["C0830", 830],
    ["C0564", 564],
    ["C0195", 195],
    ["C0074", 74],
    ["C578", 578], // hfville's unpadded majority-of-the-minority shape (63.1%)
    ["C830", 830],
    ["C195", 195],
  ];
  for (const [input, expected] of hfvilleSamples) {
    test(`hfville: ${JSON.stringify(input)} -> ${expected}`, () => {
      expect(extractLegacyIdFromCustNo(input)).toBe(expected);
    });
  }
});
