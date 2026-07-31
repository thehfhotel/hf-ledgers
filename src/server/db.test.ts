// Migration-behavior tests for db.ts's boot-time migrate(), focused on the
// โอน/เครดิต split (Wave B, docs/plan-unify-exports-tender-split.md item 2)
// — the newest additive migration. Runs the actual scenarios in SEPARATE
// `bun run` subprocesses (db-migration-fixture.ts, one per FIXTURE_MODE)
// rather than importing db.ts directly in this file: db.ts's `db` export
// is a genuine process-wide singleton (module-level `new Database(...)`
// plus a `migrate()` call at import time) that every *.test.ts file in one
// `bun test` run shares — confirmed empirically: an earlier draft imported
// db.ts here and mutated the shared `hf` category rows in place to
// simulate a legacy shape, which silently broke server.test.ts's
// unrelated category assertions whenever both files ran in the same `bun
// test` invocation. A real subprocess with its own private DB_PATH is the
// only reliable way to drive migrate() against a deliberately-mutated
// database without touching that shared state.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface IncomeCategorySnapshot {
  key: string | null;
  name: string;
  sort: number;
  isCash: boolean;
}

interface AmountSnapshot {
  categoryId: number;
  amountSatang: number;
}

interface NormalFixtureOutput {
  beforeMigrate: { hf: IncomeCategorySnapshot[] };
  afterFirstMigrate: { hf: IncomeCategorySnapshot[]; hfville: IncomeCategorySnapshot[] };
  afterIdempotentMigrate: { hf: IncomeCategorySnapshot[]; hfville: IncomeCategorySnapshot[] };
  amountsBeforeMigrate: AmountSnapshot[];
  amountsAfterFirstMigrate: AmountSnapshot[];
  CUSTOM_OTHER_TRANSFER_NAME: string;
}

interface CollisionFixtureOutput {
  hf: IncomeCategorySnapshot[];
}

const fixturePath = join(import.meta.dir, "db-migration-fixture.ts");

/** Spawns db-migration-fixture.ts in a fresh subprocess against a fresh
 * temp DB_PATH, with an optional FIXTURE_MODE. Returns the raw spawn
 * result (never throws on a non-zero exit) so callers can assert on
 * success/failure themselves — see the "collision" describe block below,
 * where a non-zero exit IS the "did it throw" signal under test. */
function runFixture(mode?: string) {
  const dbDir = mkdtempSync(join(tmpdir(), "income-ledger-db-test-"));
  const env: Record<string, string | undefined> = { ...process.env, DB_PATH: join(dbDir, "legacy.db") };
  if (mode) env.FIXTURE_MODE = mode;
  else delete env.FIXTURE_MODE;

  const result = Bun.spawnSync([process.execPath, "run", fixturePath], { env });
  rmSync(dbDir, { recursive: true, force: true });
  return result;
}

function byKey(snapshot: IncomeCategorySnapshot[], key: string): IncomeCategorySnapshot {
  const found = snapshot.find((c) => c.key === key);
  if (!found) throw new Error(`no category with key ${key} in snapshot`);
  return found;
}

const normalResult = runFixture();
if (!normalResult.success) {
  throw new Error(
    `db-migration-fixture.ts (normal mode) subprocess failed (exit ${normalResult.exitCode}):\n${normalResult.stderr.toString()}`,
  );
}
const normalLastLine = normalResult.stdout.toString().trim().split("\n").pop() ?? "";
const output: NormalFixtureOutput = JSON.parse(normalLastLine);
const {
  beforeMigrate,
  afterFirstMigrate,
  afterIdempotentMigrate,
  amountsBeforeMigrate,
  amountsAfterFirstMigrate,
  CUSTOM_OTHER_TRANSFER_NAME,
} = output;

describe("Wave B โอน/เครดิต split migration (migrateTransferCreditSplit, via a real migrate() boot)", () => {
  // T2: the roll-back fixture must actually produce a legacy shape, or
  // every assertion below would pass vacuously against an already-split DB.
  test("sanity: the fixture's pre-migrate hf is genuinely legacy-shaped (eleven income categories, old names, no เครดิต siblings)", () => {
    const income = beforeMigrate.hf;
    expect(income).toHaveLength(11);
    expect(income.some((c) => c.key === "deposit_credit")).toBe(false);
    expect(income.some((c) => c.key === "other_credit")).toBe(false);
    expect(income.some((c) => c.key === "bar_credit")).toBe(false);
    expect(byKey(income, "deposit").name).toBe("มัดจำล่วงหน้า");
    expect(byKey(income, "bar_transfer").name).toBe("บาร์น้ำ โอน/เครดิต");
    expect(byKey(income, "other_transfer").name).toBe(CUSTOM_OTHER_TRANSFER_NAME);
  });

  test("hf: renames still-default transfer categories to โอน-only wording", () => {
    const income = afterFirstMigrate.hf;
    expect(byKey(income, "deposit").name).toBe("มัดจำล่วงหน้า โอน");
    expect(byKey(income, "bar_transfer").name).toBe("บาร์น้ำ โอน");
  });

  test("hf: a manager-customized name is left alone, never clobbered by the rename", () => {
    expect(byKey(afterFirstMigrate.hf, "other_transfer").name).toBe(CUSTOM_OTHER_TRANSFER_NAME);
  });

  test("hf: seeds the three เครดิต siblings exactly once, adjacent to their โอน partner in sort order", () => {
    const income = afterFirstMigrate.hf;
    expect(income).toHaveLength(14);

    expect(byKey(income, "deposit_credit").name).toBe("มัดจำล่วงหน้า เครดิต");
    expect(byKey(income, "other_credit").name).toBe("รายการอื่นๆ เครดิต");
    expect(byKey(income, "bar_credit").name).toBe("บาร์น้ำ เครดิต");
    for (const key of ["deposit_credit", "other_credit", "bar_credit"]) expect(byKey(income, key).isCash).toBe(false);

    // Adjacency: each เครดิต sibling sits immediately after its โอน partner
    // once sorted, and sort stays a dense, gap-free, duplicate-free 0..13
    // sequence — the migration shifted everything after each insertion
    // point rather than leaving a hole or colliding two rows on one value.
    expect(income.map((c) => c.sort)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const indexOf = (key: string) => income.findIndex((c) => c.key === key);
    expect(indexOf("deposit_credit")).toBe(indexOf("deposit") + 1);
    expect(indexOf("other_credit")).toBe(indexOf("other_transfer") + 1);
    expect(indexOf("bar_credit")).toBe(indexOf("bar_transfer") + 1);
  });

  // T1: the rename must be a pure name_th UPDATE — same category_id, same
  // amount_satang, on every row this migration touches (including a key it
  // must never go near at all).
  test("T1: renaming/seeding never disturbs an existing income_amounts row's category_id or amount_satang", () => {
    expect(amountsBeforeMigrate.length).toBeGreaterThan(0);
    expect(amountsAfterFirstMigrate).toEqual(amountsBeforeMigrate);
  });

  test("hfville: a property untouched since its original fresh seed is already pre-split (fourteen income categories, no rename needed)", () => {
    const income = afterFirstMigrate.hfville;
    expect(income).toHaveLength(14);
    expect(byKey(income, "deposit").name).toBe("มัดจำล่วงหน้า โอน");
    expect(byKey(income, "deposit_credit").name).toBe("มัดจำล่วงหน้า เครดิต");
  });

  test("idempotent: calling migrate() again (twice more) does not duplicate categories, re-touch names, or disturb sort", () => {
    expect(afterIdempotentMigrate.hf).toHaveLength(afterFirstMigrate.hf.length);
    expect(afterIdempotentMigrate.hfville).toHaveLength(afterFirstMigrate.hfville.length);
    expect(afterIdempotentMigrate.hf).toEqual(afterFirstMigrate.hf);
    expect(byKey(afterIdempotentMigrate.hf, "other_transfer").name).toBe(CUSTOM_OTHER_TRANSFER_NAME);
  });
});

// F2 / T3: the active-name UNIQUE index (idx_categories_active_name) means
// a manager-created category can independently collide with one of the six
// rename/insert targets. Before the fix, that collision threw inside
// migrate() at module top level — the process died before Bun.serve, and
// restart:unless-stopped crash-looped the container. This must now be
// structurally impossible: skip the individual colliding operation, log
// it, and complete everything else.
describe("F2 collision guard: a manager-created category blocking a target name", () => {
  const collisionResult = runFixture("collision");

  test("migrate() does not throw / crash the process when two target names are already taken", () => {
    expect(collisionResult.success).toBe(true);
  });

  test("the colliding INSERT (bar_credit) and RENAME (deposit) are skipped; every unaffected pair still completes", () => {
    const lastLine = collisionResult.stdout.toString().trim().split("\n").pop() ?? "";
    const { hf }: CollisionFixtureOutput = JSON.parse(lastLine);

    // Blocked: bar_credit's target name "บาร์น้ำ เครดิต" was already active
    // on a manager-created category — the insert must be skipped, not
    // crash, and not silently rename/hijack the manager's category either.
    expect(hf.some((c) => c.key === "bar_credit")).toBe(false);
    expect(hf.filter((c) => c.key === null && c.name === "บาร์น้ำ เครดิต")).toHaveLength(1);

    // Blocked: deposit's rename target "มัดจำล่วงหน้า โอน" was already
    // active on a manager-created category — deposit must keep its OLD
    // name rather than crash or silently overwrite the manager's category.
    expect(byKey(hf, "deposit").name).toBe("มัดจำล่วงหน้า");
    expect(hf.filter((c) => c.key === null && c.name === "มัดจำล่วงหน้า โอน")).toHaveLength(1);

    // Unaffected pairs still complete fully, proving the guard is scoped to
    // exactly the two colliding operations and nothing else stalls with it.
    expect(byKey(hf, "deposit_credit").name).toBe("มัดจำล่วงหน้า เครดิต"); // insert unblocked, even though deposit's OWN rename was blocked
    expect(byKey(hf, "bar_transfer").name).toBe("บาร์น้ำ โอน"); // rename unblocked, even though bar's OWN insert was blocked
    expect(byKey(hf, "other_credit").name).toBe("รายการอื่นๆ เครดิต");
  });
});
