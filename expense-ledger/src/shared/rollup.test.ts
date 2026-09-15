// computeExpenseLedgerRollup, tested against real data dumped from
// production on 2026-09-15 (src/shared/rollup.fixtures/ — see that
// directory's own note). Known real totals (docs/overall-cost-sources.md,
// hf-data): 2026-07 has 63 transactions / ฿348,667.65 and 16 AP rows /
// ฿126,667 gross (rounded; the exact satang figure is asserted below).

import { describe, expect, test } from "bun:test";
import { computeGross, computeOutstanding } from "./apTypes.ts";
import { categoryCodeForEngineNames, isExpenseCategoryCode, RECURRING_CATEGORY_COUNT } from "./categories.ts";
import type { ExpenseCategoryCode } from "./categories.ts";
import {
  computeExpenseLedgerRollup,
  normalizeApEntity,
  type RollupApRowInput,
  type RollupTransactionInput,
} from "./rollup.ts";
import rawTransactions from "./rollup.fixtures/transactions.json";
import rawApRows from "./rollup.fixtures/ap_rows.json";

interface RawFixtureTransaction {
  id: number;
  date: string;
  amountSatang: number;
  categoryName: string;
  parentName: string;
  comment: string;
  apManaged: 0 | 1;
}

interface RawFixtureApRow {
  id: string;
  creditor: string;
  item: string;
  amountSatang: number;
  vatSatang: number | null;
  whtSatang: number | null;
  discountSatang: number;
  dueDate: string | null;
  entity: string;
  categoryCode: string | null;
  filedDate: string;
  paidSatang: number;
}

const fixtureTransactions = rawTransactions as unknown as RawFixtureTransaction[];
const fixtureApRows = rawApRows as unknown as RawFixtureApRow[];

/** Resolves a fixture transaction's raw (parentName, categoryName) pair —
 * exactly what ezBookkeeping's own category tree carries — to this app's
 * ExpenseCategoryCode via categories.ts, matching the same (label,
 * building ?? label) convention src/server/engine.ts's runtime category
 * cache uses. Throws on an unmapped pair rather than silently falling back,
 * so a fixture/categories.ts drift fails the test loudly instead of
 * quietly under-counting. */
function toRollupTransaction(raw: RawFixtureTransaction): RollupTransactionInput {
  const categoryCode = categoryCodeForEngineNames(raw.parentName, raw.categoryName);
  if (!categoryCode) {
    throw new Error(`fixture transaction ${raw.id} has an unmapped category (${raw.parentName} / ${raw.categoryName})`);
  }
  return { id: String(raw.id), date: raw.date, amountSatang: raw.amountSatang, categoryCode };
}

/** gross/outstanding are computed via apTypes.ts's own arithmetic — the
 * SAME functions src/server/apStore.ts's mapRow uses — never
 * reimplemented, so this fixture-to-input conversion cannot silently drift
 * from what a real ApRow actually carries. `paidSatang` (a fixture-only
 * flattening of the real payments list) is passed as a single synthetic
 * payment, which sums identically to a real multi-payment list. */
function toRollupApRow(raw: RawFixtureApRow): RollupApRowInput {
  const gross = computeGross(raw.amountSatang, raw.vatSatang, raw.whtSatang);
  const outstanding = computeOutstanding(gross, [{ amountSatang: raw.paidSatang }], raw.discountSatang);
  const categoryCode: ExpenseCategoryCode | null = isExpenseCategoryCode(raw.categoryCode) ? raw.categoryCode : null;
  return {
    id: raw.id,
    entity: raw.entity,
    categoryCode,
    filedDate: raw.filedDate,
    grossSatang: gross,
    outstandingSatang: outstanding,
  };
}

const allTransactions = fixtureTransactions.map(toRollupTransaction);
const allApRows = fixtureApRows.map(toRollupApRow);

function apManagedIdsFromFixture(): Set<string> {
  return new Set(fixtureTransactions.filter((t) => t.apManaged === 1).map((t) => String(t.id)));
}

describe("computeExpenseLedgerRollup — real fixtures (2026-07)", () => {
  const rollup = computeExpenseLedgerRollup(
    "2026-07",
    allTransactions,
    apManagedIdsFromFixture(),
    allApRows,
    "2026-09-15T00:00:00.000Z",
  );

  test("entered totals ฿348,667.65 (no AP-managed transactions that month)", () => {
    expect(rollup.enteredTotalSatang).toBe(34_866_765);
  });

  test("filed has exactly 16 AP rows", () => {
    const rowCount = Object.values(rollup.filed).reduce((sum, bucket) => sum + (bucket?.count ?? 0), 0);
    expect(rowCount).toBe(16);
  });

  test("month/generatedAt are threaded straight through", () => {
    expect(rollup.month).toBe("2026-07");
    expect(rollup.generatedAt).toBe("2026-09-15T00:00:00.000Z");
  });

  test("recurringTotal is always 17", () => {
    expect(rollup.recurringTotal).toBe(RECURRING_CATEGORY_COUNT);
    expect(rollup.recurringTotal).toBe(17);
  });
});

describe("computeExpenseLedgerRollup — the three totals foot, every month present in the fixtures", () => {
  const months = new Set<string>([
    ...fixtureTransactions.map((t) => t.date.slice(0, 7)),
    ...fixtureApRows.map((r) => r.filedDate.slice(0, 7)),
  ]);

  for (const month of months) {
    test(`${month}: enteredTotalSatang / filedGrossSatang / filedOutstandingSatang foot their buckets`, () => {
      const rollup = computeExpenseLedgerRollup(
        month,
        allTransactions,
        apManagedIdsFromFixture(),
        allApRows,
        "2026-09-15T00:00:00.000Z",
      );

      const enteredSum = Object.values(rollup.entered).reduce((sum, b) => sum + (b?.amountSatang ?? 0), 0);
      expect(rollup.enteredTotalSatang).toBe(enteredSum);

      const filedGrossSum = Object.values(rollup.filed).reduce((sum, b) => sum + (b?.grossSatang ?? 0), 0);
      expect(rollup.filedGrossSatang).toBe(filedGrossSum);

      const filedOutstandingSum = Object.values(rollup.filed).reduce((sum, b) => sum + (b?.outstandingSatang ?? 0), 0);
      expect(rollup.filedOutstandingSatang).toBe(filedOutstandingSum);

      // filedByEntity must foot the SAME grand total as the category split —
      // two different partitions of the exact same set of rows.
      const filedByEntityGrossSum = Object.values(rollup.filedByEntity).reduce(
        (sum, b) => sum + (b?.grossSatang ?? 0),
        0,
      );
      expect(filedByEntityGrossSum).toBe(rollup.filedGrossSatang);
    });
  }
});

describe("computeExpenseLedgerRollup — zero-amount keys are never present", () => {
  test("a month with no data at all produces empty buckets, not zero-valued entries", () => {
    const rollup = computeExpenseLedgerRollup("2099-01", [], new Set(), [], "2026-09-15T00:00:00.000Z");
    expect(rollup.entered).toEqual({});
    expect(rollup.filed).toEqual({});
    expect(rollup.filedByEntity).toEqual({});
    expect(rollup.recurringFiled).toEqual([]);
    expect(rollup.enteredTotalSatang).toBe(0);
    expect(rollup.filedGrossSatang).toBe(0);
    expect(rollup.filedOutstandingSatang).toBe(0);
  });
});

describe("computeExpenseLedgerRollup — AP-managed transactions are excluded from entered", () => {
  test("a transaction whose id is in apManagedIds contributes nothing to entered", () => {
    const transactions: RollupTransactionInput[] = [
      { id: "tx-1", date: "2026-08-05", amountSatang: 1_000, categoryCode: "other" },
      { id: "tx-2", date: "2026-08-06", amountSatang: 2_000, categoryCode: "other" },
    ];
    const rollup = computeExpenseLedgerRollup(
      "2026-08",
      transactions,
      new Set(["tx-1"]),
      [],
      "2026-09-15T00:00:00.000Z",
    );
    expect(rollup.enteredTotalSatang).toBe(2_000);
    expect(rollup.entered.other).toEqual({ count: 1, amountSatang: 2_000 });
  });
});

describe("computeExpenseLedgerRollup — uncategorized filed rows", () => {
  test("a null categoryCode files under the literal key 'uncategorized'", () => {
    const rows: RollupApRowInput[] = [
      { id: "row-1", entity: "HF", categoryCode: null, filedDate: "2026-08-01", grossSatang: 5_000, outstandingSatang: 5_000 },
    ];
    const rollup = computeExpenseLedgerRollup("2026-08", [], new Set(), rows, "2026-09-15T00:00:00.000Z");
    expect(rollup.filed.uncategorized).toEqual({ count: 1, grossSatang: 5_000, outstandingSatang: 5_000 });
  });

  test("outstandingSatang is floored at 0 (an overpaid/heavily-discounted row)", () => {
    const rows: RollupApRowInput[] = [
      {
        id: "row-1",
        entity: "HF",
        categoryCode: "other",
        filedDate: "2026-08-01",
        grossSatang: 5_000,
        outstandingSatang: -1_000, // overpaid/over-discounted
      },
    ];
    const rollup = computeExpenseLedgerRollup("2026-08", [], new Set(), rows, "2026-09-15T00:00:00.000Z");
    expect(rollup.filed.other?.outstandingSatang).toBe(0);
    expect(rollup.filedOutstandingSatang).toBe(0);
  });
});

describe("computeExpenseLedgerRollup — recurringFiled", () => {
  test("a recurring code counts from EITHER entered OR filed, not just one", () => {
    const rollup = computeExpenseLedgerRollup(
      "2026-08",
      [{ id: "tx-1", date: "2026-08-01", amountSatang: 500, categoryCode: "laundry" }],
      new Set(),
      [
        {
          id: "row-1",
          entity: "HF",
          categoryCode: "social-security",
          filedDate: "2026-08-01",
          grossSatang: 1_000,
          outstandingSatang: 1_000,
        },
      ],
      "2026-09-15T00:00:00.000Z",
    );
    expect(rollup.recurringFiled).toContain("laundry");
    expect(rollup.recurringFiled).toContain("social-security");
    // A non-recurring leaf ("other" has recurring: false) never appears,
    // even if it has data.
    expect(rollup.recurringFiled).not.toContain("other");
  });
});

describe("normalizeApEntity — every distinct entity string in the real fixtures", () => {
  test.each([
    ["", "unknown"],
    ["HF", "hf"],
    ["HF Ville", "hfville"],
    ["บจก.สายชล เฮอริเทจ", "hf"],
    ["บจก.สายชล เฮอริเทจ  HF", "hf"],
    ["บจก.สายชล เฮอริเทจ  HF-VILLE", "hfville"],
    ["บริษัท เอส ซี เอ็ม ทรานสปอร์ต จำกัด", "unknown"], // a vendor name, not HF/hfville
  ] as const)("%p -> %p", (entity, expected) => {
    expect(normalizeApEntity(entity)).toBe(expected);
  });

  test("every distinct entity actually present in ap_rows.json normalizes to one of the three buckets", () => {
    const distinctEntities = new Set(fixtureApRows.map((r) => r.entity));
    expect(distinctEntities.size).toBeGreaterThan(0);
    for (const entity of distinctEntities) {
      expect(["hf", "hfville", "unknown"]).toContain(normalizeApEntity(entity));
    }
  });
});
