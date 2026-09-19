// computeExpenseLedgerRollup, tested against real data dumped from
// production (src/shared/rollup.fixtures/ — see that directory's own
// note). Known real totals (docs/overall-cost-sources.md, hf-data):
// 2026-07 has 63 transactions / ฿348,667.65 entered.
//
// ap_rows.json was REFRESHED 2026-09-17 from a fresh copy of prod's ap.db
// (CARD CL-2) — it carries 52 AP rows (was 43) across 2026-07/08/09,
// including the two real payroll-synced rows. Prod had zero reimbursement
// AP rows as of the refresh, so filedBySource's "reimbursement" bucket is
// exercised only by the hand-built fixture further down, not by real data.
//
// วันที่ลงบิล (2026-09-19, ADR-0001): every fixture row gained a `billDate`,
// backfilled by the SAME rules src/server/apStore.ts's migrateBillDate
// applies to the real volume — a payroll row takes the last day of its
// batch's period, every other row keeps its filing date. The two payroll
// batches are therefore the only rows that MOVE งวด (2026-08 -> 2026-07 and
// 2026-09 -> 2026-08), and the per-งวด totals every test below asserts were
// re-verified against a fresh prod ap.db copy on 2026-09-19: 2026-07 and
// 2026-08 match prod's own migrated figures to the satang.

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
  /** วันที่ลงบิล — the row's งวด (ADR-0001). Backfilled into this dump by
   * migrateBillDate's rules; see the file header. */
  billDate: string;
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
    billDate: raw.billDate,
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

  test("งวด 2026-07 holds exactly 17 bills totalling ฿301,729.42 (16 filed that month + July's payroll batch, which was FILED in August)", () => {
    const rowCount = Object.values(rollup.filed).reduce((sum, bucket) => sum + (bucket?.count ?? 0), 0);
    expect(rowCount).toBe(17);
    expect(rollup.filedGrossSatang).toBe(30_172_942);
    expect(rollup.filedOutstandingSatang).toBe(11_213_668);
  });

  test("basis is always the explicit string 'bill-date' — never absent, never inferred", () => {
    expect(rollup.basis).toBe("bill-date");
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
    ...fixtureApRows.map((r) => r.billDate.slice(0, 7)),
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
      { id: "row-1", entity: "HF", categoryCode: null, billDate: "2026-08-01", grossSatang: 5_000, outstandingSatang: 5_000 },
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
        billDate: "2026-08-01",
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
          billDate: "2026-08-01",
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

describe("computeExpenseLedgerRollup — per-งวด totals by source, real fixtures on the วันที่ลงบิล basis (ADR-0001)", () => {
  const forMonth = (month: string) =>
    computeExpenseLedgerRollup(month, allTransactions, apManagedIdsFromFixture(), allApRows, "2026-09-15T00:00:00.000Z");

  // THE CHANGE, in one test: the July payroll batch was FILED 2026-08-04
  // and used to count as August cost. Its งวด is July, so it now lands
  // here — with the 16 bills actually filed in July, which were already
  // July's.
  test("งวด 2026-07 = ฿301,729.42 over 17 bills: 16 manual (฿126,666.68) + the July payroll batch ฿175,062.74 (filed 2026-08-04)", () => {
    const rollup = forMonth("2026-07");
    expect(rollup.filedBySource).toEqual({
      manual: { count: 16, grossSatang: 12_666_668, outstandingSatang: 11_213_668 },
      payroll: { count: 1, grossSatang: 17_506_274, outstandingSatang: 0 },
    });
    expect(rollup.filedGrossSatang).toBe(30_172_942);
    expect(rollup.filedBySource?.reimbursement).toBeUndefined();
  });

  // Symmetrically: August loses the July batch it used to carry and gains
  // the August one (filed 2026-09-04), which is what "cost lines up with
  // revenue month for month" actually means here.
  test("งวด 2026-08 = ฿290,403.79 over 15 bills: 14 manual (฿108,812.43) + the August payroll batch ฿181,591.36 (filed 2026-09-04)", () => {
    const rollup = forMonth("2026-08");
    expect(rollup.filedBySource).toEqual({
      manual: { count: 14, grossSatang: 10_881_243, outstandingSatang: 7_136_190 },
      payroll: { count: 1, grossSatang: 18_159_136, outstandingSatang: 0 },
    });
    expect(rollup.filedGrossSatang).toBe(29_040_379);
    expect(rollup.filedBySource?.reimbursement).toBeUndefined();
  });

  // September keeps every bill filed in September EXCEPT the payroll batch
  // that moved to August — including the manually-filed 750,000-satang
  // salary row (2026-09-16), which is NOT payroll-synced (no _payroll_runs
  // link) and therefore stays "manual" in its own filing month.
  test("งวด 2026-09 = ฿246,873.79 over 20 bills, all manual — the August payroll batch filed on 2026-09-04 has left for งวด 2026-08", () => {
    const rollup = forMonth("2026-09");
    expect(rollup.filedBySource).toEqual({
      manual: { count: 20, grossSatang: 24_687_379, outstandingSatang: 11_669_169 },
    });
    expect(rollup.filedGrossSatang).toBe(24_687_379);
    expect(rollup.filedBySource?.payroll).toBeUndefined();
  });

  test("no bill is lost or double-counted by the move: the three งวด still sum to the fixture's whole gross", () => {
    const perMonth = ["2026-07", "2026-08", "2026-09"].map((m) => forMonth(m).filedGrossSatang);
    const everyRowGross = allApRows.reduce((sum, r) => sum + r.grossSatang, 0);
    expect(perMonth.reduce((a, b) => a + b, 0)).toBe(everyRowGross);
    expect(everyRowGross).toBe(30_172_942 + 29_040_379 + 24_687_379);
  });

  test("every month's payload carries basis: 'bill-date'", () => {
    for (const month of ["2026-07", "2026-08", "2026-09"]) {
      expect(forMonth(month).basis).toBe("bill-date");
    }
  });
});

describe("computeExpenseLedgerRollup — a bill's งวด is its วันที่ลงบิล, never its filing month", () => {
  // PEA's own case: the August electricity bill arrives and is filed in
  // September, and the accountant sets วันที่ลงบิล to the day the reading
  // period ends (2026-08-31 — "a bill spanning months belongs to the month
  // its span ENDS in").
  const peaBill: RollupApRowInput = {
    id: "pea-august",
    entity: "HF",
    categoryCode: "electricity-hopinn47",
    billDate: "2026-08-31",
    grossSatang: 9_000_000,
    outstandingSatang: 9_000_000,
  };

  test("it counts in the งวด its วันที่ลงบิล falls in", () => {
    const rollup = computeExpenseLedgerRollup("2026-08", [], new Set(), [peaBill], "2026-09-20T00:00:00.000Z");
    expect(rollup.filedGrossSatang).toBe(9_000_000);
    expect(rollup.filed["electricity-hopinn47"]).toEqual({ count: 1, grossSatang: 9_000_000, outstandingSatang: 9_000_000 });
  });

  test("and contributes nothing to the month it was filed in", () => {
    const rollup = computeExpenseLedgerRollup("2026-09", [], new Set(), [peaBill], "2026-09-20T00:00:00.000Z");
    expect(rollup.filed).toEqual({});
    expect(rollup.filedGrossSatang).toBe(0);
  });

  test("paying it later never moves it either — ค้างจ่าย is a payment state, not a second cost", () => {
    const paid: RollupApRowInput = { ...peaBill, outstandingSatang: 0 };
    const september = computeExpenseLedgerRollup("2026-09", [], new Set(), [paid], "2026-10-05T00:00:00.000Z");
    const august = computeExpenseLedgerRollup("2026-08", [], new Set(), [paid], "2026-10-05T00:00:00.000Z");
    expect(september.filedGrossSatang).toBe(0);
    expect(august.filedGrossSatang).toBe(9_000_000);
    expect(august.filedOutstandingSatang).toBe(0);
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
      billDate: "2026-10-04",
      grossSatang: 17_000_000,
      outstandingSatang: 0,
      payroll: { runId: "run-1", period: "2026-09", effectiveDate: "2026-10-05", employeeCount: 15, status: "PAID", error: false, paidDate: "2026-10-05" },
    },
    {
      id: "reimbursement-row-1",
      entity: "HF",
      categoryCode: "other",
      billDate: "2026-10-10",
      grossSatang: 1_500,
      outstandingSatang: 1_500,
      reimbursement: { receiptId: "r1", bundleId: "b1", requestName: "แม่บ้าน A", purchaseDate: "2026-10-09", note: "", status: "PENDING", error: false },
    },
    {
      id: "reimbursement-row-2",
      entity: "HF Ville",
      categoryCode: "other",
      billDate: "2026-10-11",
      grossSatang: 2_500,
      outstandingSatang: 0,
      reimbursement: { receiptId: "r2", bundleId: "b2", requestName: "แม่บ้าน B", purchaseDate: "2026-10-09", note: "", status: "PAID", error: false },
    },
    {
      id: "manual-row-1",
      entity: "HF",
      categoryCode: "electricity-hopinn47",
      billDate: "2026-10-12",
      grossSatang: 500_000,
      outstandingSatang: 500_000,
    },
    {
      id: "manual-row-2",
      entity: "HF Ville",
      categoryCode: "water-utility-saichon",
      billDate: "2026-10-13",
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
      { id: "row-1", entity: "HF", categoryCode: "other", billDate: "2026-11-01", grossSatang: 1_000, outstandingSatang: 1_000 },
      { id: "row-2", entity: "HF Ville", categoryCode: "other", billDate: "2026-11-02", grossSatang: 2_000, outstandingSatang: 0 },
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
