// Regression test (Opus security review, 2026-08-03, reviewer's own ask):
// asserts the IMPORT-GRAPH isolation invariant that stands between this
// design ("the reception origin must physically contain no ledger
// routes") and a future accidental import undoing it. src/slips must NEVER
// transitively import src/server/server.ts (starts a SECOND Bun.serve +
// opens the LEDGER's own database as a module-top-level side effect) or
// src/server/db.ts (the ledger's own SQLite — a totally separate
// database/volume/container from ส่งสลิป's own db.ts).
//
// Walks the REAL import graph (parsing every relative `import`/dynamic
// `import()` specifier — this codebase's convention is to always include
// the literal `.ts`/`.tsx` extension, so no extension-guessing is needed)
// starting from every non-test file under src/slips, transitively,
// following into src/server/*.ts, src/shared/*.ts and packages/shared
// wherever those get pulled in — and fails loudly if either forbidden file
// is ever reached.
//
// `@shared/*` is resolved here rather than skipped as a package import. It
// is a tsconfig path alias to packages/shared/src, i.e. first-party source
// in this repo, and treating it as an opaque package would put a hole in
// exactly the graph this test exists to keep whole: a shared module that
// grew an import of src/server/db.ts would become invisible to the walk.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "../.."); // src/slips -> repo root
const SLIPS_ROOT = resolve(import.meta.dir);

const FORBIDDEN = new Set([resolve(REPO_ROOT, "src/server/server.ts"), resolve(REPO_ROOT, "src/server/db.ts")]);

// Three shapes: `import ... from "spec"` / `export ... from "spec"`,
// `import("spec")` (dynamic, incl. `await import(...)`), and the bare
// side-effect form `import "spec";` (no `from` at all) — a bug in an
// earlier version of this test missed exactly this last shape (verified by
// deliberately adding one and confirming the test failed to catch it
// before this fix, then passed after).
const FROM_IMPORT_RE = /\bfrom\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const BARE_IMPORT_RE = /\bimport\s+["']([^"']+)["']/g;

function extractSpecs(content: string): string[] {
  const specs: string[] = [];
  for (const re of [FROM_IMPORT_RE, DYNAMIC_IMPORT_RE, BARE_IMPORT_RE]) {
    const regex = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content))) specs.push(m[1]!);
  }
  return specs;
}

const SHARED_ALIAS = "@shared/";
const SHARED_ROOT = resolve(REPO_ROOT, "packages/shared/src");

function resolveSpec(fromFile: string, spec: string): string | null {
  if (spec.startsWith(SHARED_ALIAS)) return resolve(SHARED_ROOT, spec.slice(SHARED_ALIAS.length));
  if (!spec.startsWith(".")) return null; // bare package import (react, elysia, sharp, ...) — not part of THIS repo's graph
  return resolve(dirname(fromFile), spec);
}

function walkImportGraph(entryFiles: readonly string[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // a resolved-but-missing path shouldn't crash this test in a confusing way — it just can't be walked further
    }
    for (const spec of extractSpecs(content)) {
      const resolved = resolveSpec(file, spec);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

/** Every non-test .ts/.tsx file under src/slips — entry points in their own
 * right, not just whatever server.ts happens to import today. A client-only
 * file with no path to server.ts today could still, in principle, gain one
 * later; this test should catch that too. */
function listSlipsSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".test.ts")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listSlipsSourceFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("import-graph isolation: src/slips never reaches the ledger's own server/db", () => {
  test("no file under src/slips transitively imports src/server/server.ts or src/server/db.ts", () => {
    const entryFiles = listSlipsSourceFiles(SLIPS_ROOT);
    expect(entryFiles.length).toBeGreaterThan(5); // sanity: the walk actually found real files, not an empty/misconfigured glob

    const visited = walkImportGraph(entryFiles);
    const offenders = [...visited].filter((f) => FORBIDDEN.has(f));
    expect(offenders).toEqual([]);
  });

  test("sanity: the graph DOES legitimately reach the side-effect-free modules this design deliberately reuses", () => {
    const entryFiles = listSlipsSourceFiles(SLIPS_ROOT);
    const visited = walkImportGraph(entryFiles);
    // packages/shared/src/access.ts is the CF Access verifier, which used to
    // live at src/server/auth.ts — its presence here also proves the
    // @shared/ alias is actually being followed, not silently skipped.
    for (const expected of ["packages/shared/src/access.ts", "src/server/day-audit.ts", "src/server/pms-prefill.ts"]) {
      expect(visited.has(resolve(REPO_ROOT, expected))).toBe(true);
    }
  });
});
