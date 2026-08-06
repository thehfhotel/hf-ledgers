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
  test("sanity: the fixture's pre-migrate hf is genuinely legacy-shaped (eleven income categories, old names, no เครดิต siblings, no deposit_applied)", () => {
    const income = beforeMigrate.hf;
    expect(income).toHaveLength(11);
    expect(income.some((c) => c.key === "deposit_credit")).toBe(false);
    expect(income.some((c) => c.key === "other_credit")).toBe(false);
    expect(income.some((c) => c.key === "bar_credit")).toBe(false);
    expect(income.some((c) => c.key === "deposit_applied")).toBe(false);
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

  test("hf: seeds the three เครดิต siblings AND deposit_applied exactly once, each adjacent to its partner in sort order", () => {
    const income = afterFirstMigrate.hf;
    expect(income).toHaveLength(15);

    expect(byKey(income, "deposit_credit").name).toBe("มัดจำล่วงหน้า เครดิต");
    expect(byKey(income, "other_credit").name).toBe("รายการอื่นๆ เครดิต");
    expect(byKey(income, "bar_credit").name).toBe("บาร์น้ำ เครดิต");
    expect(byKey(income, "deposit_applied").name).toBe("มัดจำล่วงหน้า (ตัดยอด)");
    for (const key of ["deposit_credit", "other_credit", "bar_credit", "deposit_applied"]) {
      expect(byKey(income, key).isCash).toBe(false);
    }

    // Adjacency: each เครดิต sibling (and deposit_applied) sits immediately
    // after its partner once sorted, and sort stays a dense, gap-free,
    // duplicate-free 0..14 sequence — the migrations shifted everything
    // after each insertion point rather than leaving a hole or colliding
    // two rows on one value.
    expect(income.map((c) => c.sort)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const indexOf = (key: string) => income.findIndex((c) => c.key === key);
    expect(indexOf("deposit_credit")).toBe(indexOf("deposit") + 1);
    expect(indexOf("deposit_applied")).toBe(indexOf("deposit_credit") + 1);
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

  test("hfville: a property untouched since its original fresh seed is already pre-split (fifteen income categories, no rename needed)", () => {
    const income = afterFirstMigrate.hfville;
    expect(income).toHaveLength(15);
    expect(byKey(income, "deposit").name).toBe("มัดจำล่วงหน้า โอน");
    expect(byKey(income, "deposit_credit").name).toBe("มัดจำล่วงหน้า เครดิต");
    expect(byKey(income, "deposit_applied").name).toBe("มัดจำล่วงหน้า (ตัดยอด)");
  });

  // Category seeding parity (task brief): both properties must land on the
  // SAME set of fifteen category keys in the SAME sort order once migrate()
  // has run — hf gets there via the legacy-shape roll-back + real
  // migration path exercised above, hfville gets there because its fresh
  // seed is already pre-split (the "no rename needed" test above), but the
  // END STATE the office actually sees must be identical either way. A
  // property-blind assertion here would have missed a bug where the two
  // paths silently diverge in ORDER even though both happen to have length
  // 15 (e.g. deposit_applied landing in a different slot relative to its
  // siblings on one property but not the other).
  test("both properties: identical ordered list of fifteen category keys after migrate() — hf's real migration path and hfville's pre-split fresh seed converge on the same shape", () => {
    const hfKeys = afterFirstMigrate.hf.map((c) => c.key);
    const hfvilleKeys = afterFirstMigrate.hfville.map((c) => c.key);
    expect(hfKeys).toHaveLength(15);
    expect(hfKeys).toEqual(hfvilleKeys);
    // Spelled out explicitly (not just "arrays match") so a future reorder
    // of INCOME_SEED/the migration splice order shows up as a readable
    // diff, not just "expected [...] to equal [...]" noise.
    expect(hfKeys).toEqual([
      "deposit",
      "deposit_credit",
      "deposit_applied",
      "room_cash",
      "credit_kbank",
      "credit_icbc",
      "transfer_kbank",
      "transfer_icbc",
      "web",
      "other_cash",
      "other_transfer",
      "other_credit",
      "bar_cash",
      "bar_transfer",
      "bar_credit",
    ]);
  });

  // deposit_applied seeded on both properties (task brief), immediately
  // after its deposit_credit sibling — hf via the migration path (already
  // covered above by "seeds the three เครดิต siblings..."), hfville via the
  // pre-split fresh seed. Asserted explicitly for both rather than assumed
  // from the ordered-list equality above, since that's the one field the
  // task brief calls out by name.
  for (const property of ["hf", "hfville"] as const) {
    test(`${property}: deposit_applied is seeded, non-cash, immediately after deposit_credit`, () => {
      const income = afterFirstMigrate[property];
      const applied = byKey(income, "deposit_applied");
      expect(applied.name).toBe("มัดจำล่วงหน้า (ตัดยอด)");
      expect(applied.isCash).toBe(false);
      const indexOf = (key: string) => income.findIndex((c) => c.key === key);
      expect(indexOf("deposit_applied")).toBe(indexOf("deposit_credit") + 1);
    });
  }

  test("idempotent: calling migrate() again (twice more) does not duplicate categories, re-touch names, or disturb sort", () => {
    expect(afterIdempotentMigrate.hf).toHaveLength(afterFirstMigrate.hf.length);
    expect(afterIdempotentMigrate.hfville).toHaveLength(afterFirstMigrate.hfville.length);
    expect(afterIdempotentMigrate.hf).toEqual(afterFirstMigrate.hf);
    expect(byKey(afterIdempotentMigrate.hf, "other_transfer").name).toBe(CUSTOM_OTHER_TRANSFER_NAME);
    // hfville had only a length check here before — extended to the same
    // full deep-equality hf already gets, since hfville's own idempotence
    // (its migrations are all no-ops from a fresh, already-split seed) is
    // just as much part of the "safe to call on every boot" contract as
    // hf's is, and a length-only check would miss a drifted name or sort
    // value while still reporting green.
    expect(afterIdempotentMigrate.hfville).toEqual(afterFirstMigrate.hfville);
  });
});

// F2 / T3: the active-name UNIQUE index (idx_categories_active_name) means
// a manager-created category can independently collide with one of the
// rename/insert targets (six from Wave B, plus deposit_applied's own INSERT
// target from Wave C). Before the fix, that collision threw inside
// migrate() at module top level — the process died before Bun.serve, and
// restart:unless-stopped crash-looped the container. This must now be
// structurally impossible: skip the individual colliding operation, log
// it, and complete everything else.
//
// KNOWN GAP (property parity, task brief): this collision scenario is only
// exercised against "hf" — db-migration-fixture.ts's "collision" mode rolls
// ONLY hf back to a legacy shape and plants blocker categories only there
// (see that file); hfville is left at its normal fresh (already fully
// split) seed for the whole run, so every one of splitTransferCreditCategory/
// migrateDepositAppliedCategoryForProperty's collision-guard branches for
// hfville short-circuit on the (harmless, real) "already seeded" no-op path
// before ever reaching activeNameCollision() — there is no live code path in
// THIS fixture run that would exercise hfville hitting the actual
// collision-and-skip branch, and this test file's touch-scope for this task
// does not include modifying db-migration-fixture.ts to add an hfville
// collision scenario. splitTransferCreditCategory/
// migrateDepositAppliedCategoryForProperty are themselves per-property pure
// functions called in an identical `for (const property of PROPERTIES)`
// loop for both collision-guard checks (see db.ts), so there is no
// property-conditional code here to miss — but that symmetry is inferred
// from reading db.ts, not independently verified by a passing hfville
// collision test. A follow-up that extends the fixture script to also roll
// hfville back to legacy shape (with its own blocker categories) would close
// this gap for real; flagging it here rather than silently claiming
// "collision guard: covered for both properties".
describe("F2 collision guard: a manager-created category blocking a target name", () => {
  const collisionResult = runFixture("collision");

  test("migrate() does not throw / crash the process when three target names are already taken", () => {
    expect(collisionResult.success).toBe(true);
  });

  test("the colliding INSERTs (bar_credit, deposit_applied) and RENAME (deposit) are skipped; every unaffected pair still completes", () => {
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

    // Blocked (Wave C): deposit_applied's insert target "มัดจำล่วงหน้า
    // (ตัดยอด)" was already active on a manager-created category — the
    // insert must be skipped, not crash, and not hijack the manager's
    // category.
    expect(hf.some((c) => c.key === "deposit_applied")).toBe(false);
    expect(hf.filter((c) => c.key === null && c.name === "มัดจำล่วงหน้า (ตัดยอด)")).toHaveLength(1);

    // Unaffected pairs still complete fully, proving the guard is scoped to
    // exactly the three colliding operations and nothing else stalls with it.
    expect(byKey(hf, "deposit_credit").name).toBe("มัดจำล่วงหน้า เครดิต"); // insert unblocked, even though deposit's OWN rename was blocked
    expect(byKey(hf, "bar_transfer").name).toBe("บาร์น้ำ โอน"); // rename unblocked, even though bar's OWN insert was blocked
    expect(byKey(hf, "other_credit").name).toBe("รายการอื่นๆ เครดิต");
  });
});
