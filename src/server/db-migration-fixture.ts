// Standalone fixture script for db.test.ts — NOT itself a *.test.ts file,
// so `bun test` never picks it up directly. Run as its own `bun run`
// subprocess (see db.test.ts) with a private DB_PATH, because db.ts's `db`
// export is a genuine process-wide singleton (module-level `new
// Database(...)` + a `migrate()` call at import time) that every *.test.ts
// file in one `bun test` run shares — confirmed the hard way: an earlier
// draft of this test mutated the shared `hf` category rows in place and
// broke server.test.ts's unrelated assertions in the same run. A real
// subprocess is the only way to exercise migrate() against a
// deliberately-mutated "legacy-shaped" database without touching that
// shared state.
//
// Two modes, selected by env var FIXTURE_MODE (db.test.ts spawns this
// script once per mode, each against its own fresh DB_PATH):
//
// - "normal" (default): simulates the pre-Wave-B shape
//   (docs/plan-unify-exports-tender-split.md item 2) by rolling
//   property=hf's freshly-seeded (already pre-split) categories back to
//   eleven rows — delete the three เครดิต siblings, renumber the remaining
//   rows densely, then restore two names to their stock seed default (so
//   the rename SHOULD fire on the real migrate() call below) and one to a
//   manager-customized name (so it should NOT). Also seeds income_amounts
//   (+ history) on the categories the migration renames, plus one
//   unrelated key, so the money-preservation guarantee (rename never
//   touches category_id or amount_satang) is checked, not assumed.
//   property hfville is left exactly as its own fresh seed produced it,
//   exercising the split migration's no-op path on an already-split
//   property in the same run.
// - "collision": F2 regression coverage. Same legacy-shaped hf, PLUS two
//   manager-created categories that independently occupy two of the six
//   target names (one blocks a RENAME target, one blocks an INSERT
//   target) — migrate() must skip exactly those two operations, log, and
//   complete every other pair normally, never throw. If it throws, this
//   script exits non-zero / prints no valid JSON, which is itself the
//   assertion surface for "must not throw" (see db.test.ts).

export {}; // marks this a module so the top-level `await` below is allowed

const dbModule = await import("./db.ts");

const CUSTOM_OTHER_TRANSFER_NAME = "รายการอื่นๆ โอน/เครดิต (ผู้จัดการแก้ไขชื่อแล้ว)";
const AMOUNTS_DATE = "2026-01-15";
// deposit/other_transfer/bar_transfer are the three the migration touches;
// room_cash is an unrelated key the migration must never go near.
const AMOUNTS_BY_KEY: Readonly<Record<string, number>> = {
  deposit: 12_345_00,
  other_transfer: 6_789_00,
  bar_transfer: 4_321_00,
  room_cash: 9_999_00,
};

function rollHfBackToLegacyShape(): void {
  const removeCredit = dbModule.db.prepare("DELETE FROM categories WHERE property = 'hf' AND category_key = ?");
  for (const key of ["deposit_credit", "other_credit", "bar_credit"]) removeCredit.run(key);

  const remaining = dbModule.db
    .query<{ id: number }, []>(
      "SELECT id FROM categories WHERE property = 'hf' AND kind = 'income' ORDER BY sort ASC",
    )
    .all();
  const renumber = dbModule.db.prepare("UPDATE categories SET sort = ? WHERE id = ?");
  remaining.forEach((row, i) => renumber.run(i, row.id));

  const rename = dbModule.db.prepare("UPDATE categories SET name_th = ? WHERE property = 'hf' AND category_key = ?");
  rename.run("มัดจำล่วงหน้า", "deposit");
  rename.run("บาร์น้ำ โอน/เครดิต", "bar_transfer");
  rename.run(CUSTOM_OTHER_TRANSFER_NAME, "other_transfer"); // manager-customized — must survive
}

function categoryIdByKey(property: "hf" | "hfville"): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of dbModule.listCategories(property, false)) if (c.categoryKey) map.set(c.categoryKey, c.id);
  return map;
}

/** T1: seeds real money on the three categories this migration renames
 * (plus one unrelated key) BEFORE migrate() runs, so "rename never
 * disturbs category_id/amount_satang" is an assertion, not an assumption. */
function seedIncomeAmounts(property: "hf" | "hfville"): void {
  const byKey = categoryIdByKey(property);
  const insertAmount = dbModule.db.prepare(
    `INSERT INTO income_amounts (property, date, category_id, amount_satang, note, source, manual, updated_at, updated_by)
     VALUES (?, ?, ?, ?, NULL, 'manual', 1, datetime('now'), 'fixture@test')`,
  );
  const insertHistory = dbModule.db.prepare(
    `INSERT INTO income_amount_history (property, date, category_id, old_satang, new_satang, source, by)
     VALUES (?, ?, ?, 0, ?, 'manual', 'fixture@test')`,
  );
  for (const [key, amountSatang] of Object.entries(AMOUNTS_BY_KEY)) {
    const categoryId = byKey.get(key);
    if (categoryId === undefined) throw new Error(`fixture setup: no category for key ${key} on property=${property}`);
    insertAmount.run(property, AMOUNTS_DATE, categoryId, amountSatang);
    insertHistory.run(property, AMOUNTS_DATE, categoryId, amountSatang);
  }
}

function incomeAmountsSnapshot(property: "hf" | "hfville"): Array<{ categoryId: number; amountSatang: number }> {
  return dbModule.db
    .query<{ category_id: number; amount_satang: number }, [string, string]>(
      "SELECT category_id, amount_satang FROM income_amounts WHERE property = ? AND date = ? ORDER BY category_id",
    )
    .all(property, AMOUNTS_DATE)
    .map((r) => ({ categoryId: r.category_id, amountSatang: r.amount_satang }));
}

function incomeSnapshot(property: "hf" | "hfville") {
  return dbModule
    .listCategories(property, false)
    .filter((c) => c.kind === "income")
    .sort((a, b) => a.sort - b.sort)
    .map((c) => ({ key: c.categoryKey, name: c.nameTh, sort: c.sort, isCash: c.isCash }));
}

const mode = process.env.FIXTURE_MODE ?? "normal";

if (mode === "collision") {
  rollHfBackToLegacyShape();

  // Two manager-created (category_key NULL) categories that happen to
  // occupy exactly two of the six target names — one blocks bar_credit's
  // INSERT, the other blocks deposit's RENAME target. Both stay well clear
  // of the dense 0..N sort range so they never disturb the adjacency of
  // the unaffected pairs.
  const blocker = dbModule.db.prepare(
    "INSERT INTO categories (property, kind, name_th, sort, is_cash, category_key) VALUES ('hf', 'income', ?, 999, 0, NULL)",
  );
  blocker.run("บาร์น้ำ เครดิต"); // blocks the bar_credit INSERT target
  blocker.run("มัดจำล่วงหน้า โอน"); // blocks the deposit RENAME target

  dbModule.migrate(); // must not throw — see the module comment above

  console.log(JSON.stringify({ hf: incomeSnapshot("hf") }));
} else {
  rollHfBackToLegacyShape();
  seedIncomeAmounts("hf");

  // T2: confirm the roll-back actually produced a legacy shape before
  // trusting anything migrate() does to it below.
  const beforeMigrate = { hf: incomeSnapshot("hf") };
  const amountsBeforeMigrate = incomeAmountsSnapshot("hf");

  dbModule.migrate(); // the boot migration under test, against the now-legacy-shaped hf

  const afterFirstMigrate = { hf: incomeSnapshot("hf"), hfville: incomeSnapshot("hfville") };
  const amountsAfterFirstMigrate = incomeAmountsSnapshot("hf");

  dbModule.migrate();
  dbModule.migrate(); // twice more, so any drift only visible on a third pass would still show up

  const afterIdempotentMigrate = { hf: incomeSnapshot("hf"), hfville: incomeSnapshot("hfville") };

  console.log(
    JSON.stringify({
      beforeMigrate,
      afterFirstMigrate,
      afterIdempotentMigrate,
      amountsBeforeMigrate,
      amountsAfterFirstMigrate,
      CUSTOM_OTHER_TRANSFER_NAME,
    }),
  );
}
