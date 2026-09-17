// computeExpenseLedgerRollup, tested against real data dumped from
// production (src/shared/rollup.fixtures/ — see that directory's own
// note). Known real totals (docs/overall-cost-sources.md, hf-data):
// 2026-07 has 63 transactions / ฿348,667.65 and 16 AP rows / ฿126,667
// gross (rounded; the exact satang figure is asserted below).
//
// ap_rows.json was REFRESHED 2026-09-17 from a fresh copy of prod's ap.db
// (CARD CL-2) — it now carries 52 AP rows (was 43) across 2026-07/08/09,
// including the two real payroll-synced rows (see the filedBySource
// describe block below, which records the exact per-source satang for
// 2026-08 and 2026-09 in its test names). Prod had zero reimbursement AP
// rows as of the refresh, so filedBySource's "reimbursement" bucket is
// exercised only by the hand-built fixture further down, not by real data.

import { describe, expect, test } from "bun:test";
import { computeGross, computeOutstanding } from "./apTypes.ts";
import { categoryCodeForEngineNames, isExpenseCategoryCode, RECURRING_CATEGORY_COUNT } from "./categories.ts";
import type { ExpenseCategoryCode } from "./categories.ts";
import {
  apRowSource,
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
  /** Present only on a real payroll-synced/reimbursement-synced row
   * (payrollRowView/reimbursementRowView's markers) — shape irrelevant,
   * only presence (see rollup.ts's apRowSource()), so the fixture dump
   * keeps whatever nested shape the source query produced. */
  payroll?: unknown;
  reimbursement?: unknown;
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
    ...(raw.payroll !== undefined ? { payroll: raw.payroll } : {}),
    ...(raw.reimbursement !== undefined ? { reimbursement: raw.reimbursement } : {}),
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

      // filedBySource is a THIRD partition of the exact same rows — must
      // foot both totals too (LOCKED CONTRACT EXTENSION, 2026-09-17).
      const filedBySourceGrossSum = Object.values(rollup.filedBySource ?? {}).reduce(
        (sum, b) => sum + (b?.grossSatang ?? 0),
        0,
      );
      expect(filedBySourceGrossSum).toBe(rollup.filedGrossSatang);
      const filedBySourceOutstandingSum = Object.values(rollup.filedBySource ?? {}).reduce(
        (sum, b) => sum + (b?.outstandingSatang ?? 0),
        0,
      );
      expect(filedBySourceOutstandingSum).toBe(rollup.filedOutstandingSatang);
    });
  }
});

describe("computeExpenseLedgerRollup — zero-amount keys are never present", () => {
  test("a month with no data at all produces empty buckets, not zero-valued entries", () => {
    const rollup = computeExpenseLedgerRollup("2099-01", [], new Set(), [], "2026-09-15T00:00:00.000Z");
    expect(rollup.entered).toEqual({});
    expect(rollup.filed).toEqual({});
    expect(rollup.filedByEntity).toEqual({});
    expect(rollup.filedBySource).toEqual({});
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

// ── CARD CL-2: filedBySource (LOCKED CONTRACT EXTENSION, 2026-09-17) ──────

describe("apRowSource", () => {
  test("payroll wins over reimbursement when (impossibly) both are set", () => {
    expect(apRowSource({ payroll: {}, reimbursement: {} })).toBe("payroll");
  });
  test("reimbursement, when only that marker is set", () => {
    expect(apRowSource({ reimbursement: {} })).toBe("reimbursement");
  });
  test("manual, when neither marker is set", () => {
    expect(apRowSource({})).toBe("manual");
    expect(apRowSource({ payroll: undefined, reimbursement: undefined })).toBe("manual");
  });
});

describe("computeExpenseLedgerRollup — filedBySource against the real (refreshed 2026-09-17) fixtures", () => {
  // 2026-07 predates the payroll sync going live (first batch filed
  // 2026-08-04) — every one of its 16 rows is manual.
  test("2026-07: no synced rows at all -> filedBySource carries only 'manual' (16 rows, ฿126,666.68)", () => {
    const rollup = computeExpenseLedgerRollup(
      "2026-07",
      allTransactions,
      apManagedIdsFromFixture(),
      allApRows,
      "2026-09-15T00:00:00.000Z",
    );
    expect(rollup.filedBySource).toEqual({
      manual: { count: 16, grossSatang: 12_666_668, outstandingSatang: 11_213_668 },
    });
  });

  // เงินเดือน กรกฎาคม 2569, filed 2026-08-04, the July payroll batch —
  // src/server/payroll-sync.ts's payrollRowView marks it, the other 14
  // rows that month (including a manual salary-category row is NOT among
  // them this month) are plain AP filings.
  test("2026-08: 1 payroll row (฿175,062.74) + 14 manual rows (฿108,812.43), zero reimbursement key", () => {
    const rollup = computeExpenseLedgerRollup(
      "2026-08",
      allTransactions,
      apManagedIdsFromFixture(),
      allApRows,
      "2026-09-15T00:00:00.000Z",
    );
    expect(rollup.filedBySource).toEqual({
      payroll: { count: 1, grossSatang: 17_506_274, outstandingSatang: 0 },
      manual: { count: 14, grossSatang: 10_881_243, outstandingSatang: 7_136_190 },
    });
    expect(rollup.filedBySource?.reimbursement).toBeUndefined();
  });

  // เงินเดือน สิงหาคม 2569, filed 2026-09-04, PLUS a second, manually-filed
  // 750,000-satang salary row (2026-09-16) that is NOT payroll-synced (no
  // _payroll_runs link) — together they're the 18,909,136 satang "2026-09
  // salary, 2 rows" figure from prod, but split across sources: only the
  // synced batch counts as "payroll", the manual top-up stays "manual".
  test("2026-09: 1 payroll row (฿181,591.36) + 20 manual rows (฿246,873.79), zero reimbursement key", () => {
    const rollup = computeExpenseLedgerRollup(
      "2026-09",
      allTransactions,
      apManagedIdsFromFixture(),
      allApRows,
      "2026-09-15T00:00:00.000Z",
    );
    expect(rollup.filedBySource).toEqual({
      payroll: { count: 1, grossSatang: 18_159_136, outstandingSatang: 0 },
      manual: { count: 20, grossSatang: 24_687_379, outstandingSatang: 11_669_169 },
    });
    expect(rollup.filedBySource?.reimbursement).toBeUndefined();
  });
});

describe("computeExpenseLedgerRollup — filedBySource with a synthetic payroll + reimbursement + manual mix", () => {
  // Prod (as of the 2026-09-17 fixture refresh) has zero reimbursement AP
  // rows, so this hand-built set is what exercises that bucket — one
  // payroll row, two reimbursement rows, two manual rows, all filed the
  // same month, with distinct amounts so a mis-attributed row changes
  // every assertion below.
  const rows: RollupApRowInput[] = [
    {
      id: "payroll-row",
      entity: "รวมทุกโรงแรม",
      categoryCode: "salary",
      filedDate: "2026-10-04",
      grossSatang: 17_000_000,
      outstandingSatang: 0,
      payroll: { runId: "run-1", period: "2026-09", effectiveDate: "2026-10-05", employeeCount: 15, status: "PAID", error: false, paidDate: "2026-10-05" },
    },
    {
      id: "reimbursement-row-1",
      entity: "HF",
      categoryCode: "other",
      filedDate: "2026-10-10",
      grossSatang: 1_500,
      outstandingSatang: 1_500,
      reimbursement: { receiptId: "r1", bundleId: "b1", requestName: "แม่บ้าน A", purchaseDate: "2026-10-09", note: "", status: "PENDING", error: false },
    },
    {
      id: "reimbursement-row-2",
      entity: "HF Ville",
      categoryCode: "other",
      filedDate: "2026-10-11",
      grossSatang: 2_500,
      outstandingSatang: 0,
      reimbursement: { receiptId: "r2", bundleId: "b2", requestName: "แม่บ้าน B", purchaseDate: "2026-10-09", note: "", status: "PAID", error: false },
    },
    {
      id: "manual-row-1",
      entity: "HF",
      categoryCode: "electricity-hopinn47",
      filedDate: "2026-10-12",
      grossSatang: 500_000,
      outstandingSatang: 500_000,
    },
    {
      id: "manual-row-2",
      entity: "HF Ville",
      categoryCode: "water-utility-saichon",
      filedDate: "2026-10-13",
      grossSatang: 8_000,
      outstandingSatang: 0,
    },
  ];
  const rollup = computeExpenseLedgerRollup("2026-10", [], new Set(), rows, "2026-10-15T00:00:00.000Z");

  test("foots per source: 1 payroll, 2 reimbursement, 2 manual", () => {
    expect(rollup.filedBySource).toEqual({
      payroll: { count: 1, grossSatang: 17_000_000, outstandingSatang: 0 },
      reimbursement: { count: 2, grossSatang: 4_000, outstandingSatang: 1_500 },
      manual: { count: 2, grossSatang: 508_000, outstandingSatang: 500_000 },
    });
  });

  test("the three grand totals still foot against filedBySource's sum", () => {
    expect(rollup.filedGrossSatang).toBe(17_512_000);
    expect(rollup.filedOutstandingSatang).toBe(501_500);
    const sourceGrossSum = Object.values(rollup.filedBySource ?? {}).reduce((sum, b) => sum + (b?.grossSatang ?? 0), 0);
    const sourceOutstandingSum = Object.values(rollup.filedBySource ?? {}).reduce((sum, b) => sum + (b?.outstandingSatang ?? 0), 0);
    expect(sourceGrossSum).toBe(rollup.filedGrossSatang);
    expect(sourceOutstandingSum).toBe(rollup.filedOutstandingSatang);
  });

  test("no zero-amount source key is present when every source has rows", () => {
    expect(Object.keys(rollup.filedBySource ?? {}).sort()).toEqual(["manual", "payroll", "reimbursement"]);
  });
});

describe("computeExpenseLedgerRollup — filedBySource with no synced rows at all", () => {
  test("a rollup built from AP rows that are ALL manual carries only the 'manual' key", () => {
    const rows: RollupApRowInput[] = [
      { id: "row-1", entity: "HF", categoryCode: "other", filedDate: "2026-11-01", grossSatang: 1_000, outstandingSatang: 1_000 },
      { id: "row-2", entity: "HF Ville", categoryCode: "other", filedDate: "2026-11-02", grossSatang: 2_000, outstandingSatang: 0 },
    ];
    const rollup = computeExpenseLedgerRollup("2026-11", [], new Set(), rows, "2026-11-05T00:00:00.000Z");
    expect(rollup.filedBySource).toEqual({
      manual: { count: 2, grossSatang: 3_000, outstandingSatang: 1_000 },
    });
    expect(rollup.filedBySource?.payroll).toBeUndefined();
    expect(rollup.filedBySource?.reimbursement).toBeUndefined();
  });

  test("a month with zero AP rows carries an empty filedBySource, same convention as filed/filedByEntity", () => {
    const rollup = computeExpenseLedgerRollup("2026-11", [], new Set(), [], "2026-11-05T00:00:00.000Z");
    expect(rollup.filedBySource).toEqual({});
  });
});
