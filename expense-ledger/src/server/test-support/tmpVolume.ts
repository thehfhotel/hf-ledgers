// TEST-ONLY. Creates the throwaway "expense_ap volume" every AP store test
// runs against — a real directory holding a real `ap.db` (plus its WAL side
// files and the row photo tree), because that is exactly what the store
// opens in production.
//
// WHY THIS EXISTS RATHER THAN A PLAIN mkdtempSync(tmpdir()):
//
// Those tests are synchronous and assert on satang arithmetic, but ~99% of
// each one's wall clock is the volume fixture, not the assertion. Measured
// on the author's machine, per test: 3.45ms building and tearing the volume
// down (mkdtemp, open ap.db, `PRAGMA journal_mode = WAL`, five DDL
// statements that each commit separately, close -> WAL checkpoint + unlink
// of -wal/-shm, recursive rm) against 0.04ms of the work actually under
// test. Every one of those commits is a DURABLE commit: sqlite fsyncs at
// each one.
//
// That makes each test an implicit assertion that the host can service ~10
// fsyncs in under bun test's 5000ms timeout — an assertion no test here
// means to make, and one the test cannot fail gracefully because a
// synchronous body blocked in fsync cannot be preempted. On a developer
// machine it is invisible (macOS fsync on a local APFS SSD returns without
// forcing a device flush, so even `PRAGMA fullfsync = 1` measures the same
// 2.8ms). On a GitHub-hosted runner the root disk is shared and
// network-backed, and while the job's earlier steps' dirty pages are still
// being written back, a single fsync can stall for seconds. It did: run
// 35449745814 spent 18s inside apStore.test.ts, blew the timeout on two
// tests, and the IDENTICAL commit was green 19 minutes later on run
// 35450712218. Neighbouring tests running the very same code path came in
// at 1149ms and 5608ms in that one run — the spread is ambient I/O latency,
// nothing in the code under test.
//
// So: put the volume on a RAM-backed filesystem where the platform has one
// (/dev/shm on Linux, which covers every CI runner). Nothing about the
// tests changes — still a real file-backed sqlite database, real WAL, real
// migrations, real photo files on a real filesystem — they simply stop
// waiting on a disk they were never trying to measure. Platforms without
// one (macOS) fall back to the OS temp dir, exactly as before.
//
// Volumes made here are tiny (tens of KB; the largest photo fixture is a
// few bytes and the 10 MiB upload cap is rejected before anything is
// written), so a default-sized /dev/shm is never a constraint. Callers
// still remove their own directory in afterEach.

import { accessSync, constants, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Linux exposes a tmpfs here on every distribution we run on, CI included.
 * Checked for real (a directory, writable by us) rather than assumed, so a
 * container that masks it just falls back. */
const RAM_BACKED_ROOT = "/dev/shm";

let scratchRootCache: string | null = null;

function scratchRoot(): string {
  if (scratchRootCache !== null) return scratchRootCache;
  scratchRootCache = tmpdir();
  if (process.platform === "linux") {
    try {
      if (statSync(RAM_BACKED_ROOT).isDirectory()) {
        accessSync(RAM_BACKED_ROOT, constants.W_OK);
        scratchRootCache = RAM_BACKED_ROOT;
      }
    } catch {
      // Not there, not a directory, or not writable — keep the temp dir.
    }
  }
  return scratchRootCache;
}

/** Creates an empty throwaway directory for one test's AP volume, named
 * with `prefix` the same way `mkdtempSync` would. The caller owns it and
 * removes it (`rmSync(dir, { recursive: true, force: true })`). */
export function makeTmpVolume(prefix: string): string {
  return mkdtempSync(join(scratchRoot(), prefix));
}
