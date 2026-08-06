import { describe, expect, test } from "bun:test";
import { computeIncomeLedgerRollup } from "./rollup.ts";
import type { Category, DepositEvent, ExpenseItem, IncomeCell, Property } from "./types.ts";

const PROPERTY = "hf";
const DATE = "2026-06-15";

// `property` defaults to the module-level PROPERTY ("hf") so every
// pre-existing call site is unaffected — the hfville-parity describe block
// below is the only caller that ever passes it explicitly.
function category(
  id: number,
  categoryKey: Category["categoryKey"],
  kind: Category["kind"] = "income",
  property: Property = PROPERTY,
): Category {
  return {
    id,
    property,
    kind,
    nameTh: `cat-${id}`,
    sort: id,
    isCash: false,
    categoryKey,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function incomeCell(categoryId: number, amountSatang: number): IncomeCell {
  return {
    categoryId,
    amountSatang,
    note: null,
    source: "manual",
    manual: true,
    updatedAt: "2026-06-15T10:00:00Z",
    updatedBy: "tester@thehfhotel.org",
  };
}

function expenseItem(categoryId: number, amountSatang: number, property: Property = PROPERTY): ExpenseItem {
  return {
    id: 1,
    property,
    date: DATE,
    categoryId,
    note: null,
    amountSatang,
    createdAt: "2026-06-15T10:00:00Z",
    createdBy: "tester@thehfhotel.org",
    updatedAt: "2026-06-15T10:00:00Z",
    updatedBy: "tester@thehfhotel.org",
  };
}

describe("computeIncomeLedgerRollup", () => {
  test("sums cells into their CategoryKey and omits zero-amount categories", () => {
    const categories = [category(1, "room_cash"), category(2, "web"), category(3, "deposit")];
    const income: Record<number, IncomeCell> = {
      1: incomeCell(1, 10_000),
      2: incomeCell(2, 0), // must be omitted, never sent as an explicit 0
      3: incomeCell(3, 5_000),
    };
    const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, categories, income, [], false, "app");

    expect(rollup.amounts).toEqual({ room_cash: 10_000, deposit: 5_000 });
    expect(rollup.amounts.web).toBeUndefined();
    expect(rollup.uncategorizedSatang).toBe(0);
    expect(rollup.totalSatang).toBe(15_000);
  });

  test("a nonzero deposit_credit amount (Wave B โอน/เครดิต split) sums into amounts and foots into totalSatang", () => {
    const categories = [category(1, "deposit"), category(2, "deposit_credit"), category(3, "room_cash")];
    const income: Record<number, IncomeCell> = {
      1: incomeCell(1, 4_000), // deposit (โอน half)
      2: incomeCell(2, 6_500), // deposit_credit (เครดิต half)
      3: incomeCell(3, 10_000),
    };
    const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, categories, income, [], false, "app");

    expect(rollup.amounts.deposit_credit).toBe(6_500);
    expect(rollup.amounts).toEqual({ deposit: 4_000, deposit_credit: 6_500, room_cash: 10_000 });
    expect(rollup.uncategorizedSatang).toBe(0);
    const sumOfAmounts = Object.values(rollup.amounts).reduce((a, b) => a + b, 0);
    expect(rollup.totalSatang).toBe(sumOfAmounts);
    expect(rollup.totalSatang).toBe(20_500);
  });

  test("routes manager-created (categoryKey null) cells into uncategorizedSatang", () => {
    const categories = [category(1, "room_cash"), category(2, null)];
    const income: Record<number, IncomeCell> = {
      1: incomeCell(1, 10_000),
      2: incomeCell(2, 2_500),
    };
    const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, categories, income, [], false, "app");

    expect(rollup.amounts).toEqual({ room_cash: 10_000 });
    expect(rollup.uncategorizedSatang).toBe(2_500);
    expect(rollup.totalSatang).toBe(12_500);
  });

  test("aggregates two cells sharing the same CategoryKey (defensive — shouldn't happen via one categoryId per key, but the map must still sum correctly)", () => {
    // Two categories can't share a categoryKey in practice (seed is unique
    // per key), but the function must not silently drop a collision if it
    // ever occurred — it should sum, not overwrite.
    const categories = [category(1, "room_cash"), category(2, "room_cash")];
    const income: Record<number, IncomeCell> = {
      1: incomeCell(1, 1_000),
      2: incomeCell(2, 2_000),
    };
    const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, categories, income, [], false, "app");
    expect(rollup.amounts.room_cash).toBe(3_000);
  });

  test("totalSatang always equals sum(amounts) + uncategorizedSatang, matching computeDayTotals' incomeSatang", () => {
    const categories = [category(1, "room_cash"), category(2, "web"), category(3, null)];
    const income: Record<number, IncomeCell> = {
      1: incomeCell(1, 7_000),
      2: incomeCell(2, 3_000),
      3: incomeCell(3, 1_000),
    };
    const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, categories, income, [], false, "app");
    const sumOfAmounts = Object.values(rollup.amounts).reduce((a, b) => a + b, 0);
    expect(rollup.totalSatang).toBe(sumOfAmounts + rollup.uncategorizedSatang);
    expect(rollup.totalSatang).toBe(11_000);
  });

  test("expenseSatang sums expense items regardless of category", () => {
    const categories = [category(1, "room_cash"), category(10, null, "expense")];
    const income: Record<number, IncomeCell> = { 1: incomeCell(1, 5_000) };
    const expenses = [expenseItem(10, 1_200), expenseItem(10, 300)];
    const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, categories, income, expenses, false, "app");
    expect(rollup.expenseSatang).toBe(1_500);
  });

  test("passes through verified and provenance unchanged", () => {
    const categories = [category(1, "room_cash")];
    const income: Record<number, IncomeCell> = { 1: incomeCell(1, 100) };
    const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, categories, income, [], true, "transcribed");
    expect(rollup.verified).toBe(true);
    expect(rollup.provenance).toBe("transcribed");
  });

  test("a day with no data at all produces an all-empty/zero rollup", () => {
    const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, [], {}, [], false, "app");
    expect(rollup.amounts).toEqual({});
    expect(rollup.uncategorizedSatang).toBe(0);
    expect(rollup.totalSatang).toBe(0);
    expect(rollup.expenseSatang).toBe(0);
  });

  test("carries property and date through unchanged", () => {
    const rollup = computeIncomeLedgerRollup("hfville", DATE, [], {}, [], false, "app");
    expect(rollup.property).toBe("hfville");
    expect(rollup.date).toBe(DATE);
  });

  // Wave C (docs/adr/0001): deposit_applied foots INSIDE amounts like any
  // ordinary key; received/refunded ride OUTSIDE amounts entirely — never
  // weaken the footing rule with an excluded key.
  describe("Wave C: deposit_applied inside amounts, received/refunded outside (docs/adr/0001)", () => {
    function depositEvent(overrides: Partial<DepositEvent> = {}): DepositEvent {
      return {
        id: 1,
        property: PROPERTY,
        date: DATE,
        kind: "received",
        bookingNo: "R014843",
        guestName: null,
        tender: "cash",
        amountSatang: 1_000,
        note: null,
        source: "manual",
        pmsRef: null,
        createdAt: "2026-06-15T10:00:00Z",
        createdBy: "tester@thehfhotel.org",
        updatedAt: "2026-06-15T10:00:00Z",
        updatedBy: "tester@thehfhotel.org",
        ...overrides,
      };
    }

    test("deposit_applied sums into amounts and foots into totalSatang like any other key", () => {
      const categories = [category(1, "deposit_applied"), category(2, "room_cash")];
      const income: Record<number, IncomeCell> = {
        1: incomeCell(1, 79_000),
        2: incomeCell(2, 10_000),
      };
      const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, categories, income, [], false, "app");
      expect(rollup.amounts).toEqual({ deposit_applied: 79_000, room_cash: 10_000 });
      expect(rollup.totalSatang).toBe(89_000);
    });

    test("no deposit events -> depositReceivedSatang/depositRefundedSatang are both omitted, never an explicit 0", () => {
      const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, [], {}, [], false, "app", []);
      expect(rollup.depositReceivedSatang).toBeUndefined();
      expect(rollup.depositRefundedSatang).toBeUndefined();
    });

    test("received deposits sum into depositReceivedSatang, OUTSIDE amounts and totalSatang", () => {
      const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, [], {}, [], false, "app", [
        depositEvent({ id: 1, kind: "received", amountSatang: 89_000 }),
        depositEvent({ id: 2, kind: "received", amountSatang: 10_000 }),
      ]);
      expect(rollup.depositReceivedSatang).toBe(99_000);
      expect(rollup.depositRefundedSatang).toBeUndefined();
      expect(rollup.amounts).toEqual({});
      expect(rollup.totalSatang).toBe(0);
    });

    test("refunded deposits sum into depositRefundedSatang, OUTSIDE amounts and totalSatang", () => {
      const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, [], {}, [], false, "app", [
        depositEvent({ kind: "refunded", amountSatang: 30_000 }),
      ]);
      expect(rollup.depositRefundedSatang).toBe(30_000);
      expect(rollup.depositReceivedSatang).toBeUndefined();
      expect(rollup.totalSatang).toBe(0);
    });

    test("applied (inside) and received/refunded (outside) coexist without conflating footing", () => {
      const categories = [category(1, "deposit_applied")];
      const income: Record<number, IncomeCell> = { 1: incomeCell(1, 79_000) };
      const rollup = computeIncomeLedgerRollup(PROPERTY, DATE, categories, income, [], false, "app", [
        depositEvent({ kind: "received", amountSatang: 89_000 }),
      ]);
      expect(rollup.amounts).toEqual({ deposit_applied: 79_000 });
      expect(rollup.totalSatang).toBe(79_000); // received deposit never inflates this
      expect(rollup.depositReceivedSatang).toBe(89_000);
    });
  });
});

// hfville parity: computeIncomeLedgerRollup takes `property` only to stamp
// it onto the returned payload — it drives none of the arithmetic (unlike
// e.g. db.ts's candidateTenderPatch, which genuinely branches on property
// for credit-bank auto-placement). These tests exist anyway because the
// task brief that produced this file's HF-shaped fixtures is exactly the
// class of bug this project has shipped before (see this file's sibling
// db.test.ts / server.test.ts for the property-BRANCHING cases): a rollup
// payload that only ever gets built from "hf" fixtures could silently grow
// an hf-only assumption (e.g. a hardcoded property string) without any test
// ever catching it. Every fixture below uses hfville-real shapes where one
// exists (R-numbers per the live survey's book_no/pay_no formats).
describe("hfville parity (property is a pure passthrough — no arithmetic branches on it)", () => {
  const HFVILLE: Property = "hfville";

  test("footing invariant (totalSatang = sum(amounts) + uncategorizedSatang) holds identically for hfville-shaped data", () => {
    const categories = [
      category(1, "room_cash", "income", HFVILLE),
      category(2, "web", "income", HFVILLE),
      category(3, null, "income", HFVILLE), // manager-created, uncategorized
    ];
    const income: Record<number, IncomeCell> = {
      1: incomeCell(1, 7_000),
      2: incomeCell(2, 3_000),
      3: incomeCell(3, 1_000),
    };
    const rollup = computeIncomeLedgerRollup(HFVILLE, DATE, categories, income, [], false, "app");
    expect(rollup.property).toBe(HFVILLE);
    const sumOfAmounts = Object.values(rollup.amounts).reduce((a, b) => a + b, 0);
    expect(rollup.totalSatang).toBe(sumOfAmounts + rollup.uncategorizedSatang);
    expect(rollup.totalSatang).toBe(11_000);
  });

  test("expenseSatang sums expense items regardless of category, for hfville too", () => {
    const categories = [category(1, "room_cash", "income", HFVILLE), category(10, null, "expense", HFVILLE)];
    const income: Record<number, IncomeCell> = { 1: incomeCell(1, 5_000) };
    const expenses = [expenseItem(10, 1_200, HFVILLE), expenseItem(10, 300, HFVILLE)];
    const rollup = computeIncomeLedgerRollup(HFVILLE, DATE, categories, income, expenses, false, "app");
    expect(rollup.expenseSatang).toBe(1_500);
  });

  // Wave C accrual rule (docs/adr/0001) — deposit_applied INSIDE amounts,
  // received/refunded OUTSIDE — must hold on hfville identically to hf, even
  // though the live survey shows hfville's own deposit-lifecycle activity is
  // far rarer (9 groups total vs hf's 669) and, as of the survey date, has
  // never been observed multi-line there. The rule itself is property-
  // agnostic code, so rarity of the real data must never translate into
  // weaker test coverage of the rule.
  describe("Wave C: deposit_applied inside amounts, received/refunded outside — hfville", () => {
    function depositEvent(overrides: Partial<DepositEvent> = {}): DepositEvent {
      return {
        id: 1,
        property: HFVILLE,
        date: DATE,
        kind: "received",
        bookingNo: "R001511", // real hfville-shaped book_no (bare R+6-digit, per the live survey)
        guestName: null,
        tender: "cash",
        amountSatang: 1_000,
        note: null,
        source: "manual",
        pmsRef: null,
        createdAt: "2026-06-15T10:00:00Z",
        createdBy: "tester@thehfhotel.org",
        updatedAt: "2026-06-15T10:00:00Z",
        updatedBy: "tester@thehfhotel.org",
        ...overrides,
      };
    }

    test("deposit_applied sums into amounts and foots into totalSatang like any other key", () => {
      const categories = [category(1, "deposit_applied", "income", HFVILLE), category(2, "room_cash", "income", HFVILLE)];
      const income: Record<number, IncomeCell> = { 1: incomeCell(1, 79_000), 2: incomeCell(2, 10_000) };
      const rollup = computeIncomeLedgerRollup(HFVILLE, DATE, categories, income, [], false, "app");
      expect(rollup.amounts).toEqual({ deposit_applied: 79_000, room_cash: 10_000 });
      expect(rollup.totalSatang).toBe(89_000);
    });

    test("received + refunded deposits net separately into their own OUTSIDE-of-amounts totals", () => {
      const rollup = computeIncomeLedgerRollup(HFVILLE, DATE, [], {}, [], false, "app", [
        depositEvent({ id: 1, kind: "received", amountSatang: 50_000 }),
        depositEvent({ id: 2, kind: "refunded", amountSatang: 20_000 }),
      ]);
      expect(rollup.depositReceivedSatang).toBe(50_000);
      expect(rollup.depositRefundedSatang).toBe(20_000);
      expect(rollup.amounts).toEqual({});
      expect(rollup.totalSatang).toBe(0);
    });

    test("no deposit events -> both totals omitted, never an explicit 0, same as hf", () => {
      const rollup = computeIncomeLedgerRollup(HFVILLE, DATE, [], {}, [], false, "app", []);
      expect(rollup.depositReceivedSatang).toBeUndefined();
      expect(rollup.depositRefundedSatang).toBeUndefined();
    });
  });

  // Table-driven: the identical income shape must produce IDENTICAL
  // arithmetic for both properties — the one shared helper both properties'
  // tests in this describe block funnel through, per the task brief's
  // "prefer a shared table-driven helper" guidance.
  for (const property of ["hf", "hfville"] as const) {
    test(`property=${property}: identical arithmetic (deposit + deposit_credit foot into totalSatang the same way)`, () => {
      const categories = [category(1, "deposit", "income", property), category(2, "deposit_credit", "income", property)];
      const income: Record<number, IncomeCell> = { 1: incomeCell(1, 4_000), 2: incomeCell(2, 6_500) };
      const rollup = computeIncomeLedgerRollup(property, DATE, categories, income, [], false, "app");
      expect(rollup.property).toBe(property);
      expect(rollup.amounts).toEqual({ deposit: 4_000, deposit_credit: 6_500 });
      expect(rollup.totalSatang).toBe(10_500);
    });
  }
});
