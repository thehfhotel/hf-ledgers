// Covers the test-volume helper itself — in particular that on Linux (every
// CI runner) a volume really does land on the RAM-backed filesystem, which
// is the whole point of the file: see tmpVolume.ts's header for the CI
// timeout it exists to remove.

import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTmpVolume } from "./tmpVolume.ts";

function ramBackedRootIsUsable(): boolean {
  try {
    if (!statSync("/dev/shm").isDirectory()) return false;
    accessSync("/dev/shm", constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

describe("makeTmpVolume", () => {
  test("hands back a fresh, empty, writable directory named after the prefix", () => {
    const dir = makeTmpVolume("tmp-volume-test-");
    try {
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
      expect(dir.includes("tmp-volume-test-")).toBe(true);
      writeFileSync(join(dir, "ap.db"), "x");
      expect(existsSync(join(dir, "ap.db"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two volumes never collide", () => {
    const a = makeTmpVolume("tmp-volume-test-");
    const b = makeTmpVolume("tmp-volume-test-");
    try {
      expect(a).not.toBe(b);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("lands on the RAM-backed filesystem on Linux, and on the OS temp dir elsewhere", () => {
    const dir = makeTmpVolume("tmp-volume-test-");
    try {
      // On Linux /dev/shm is tmpfs on every distribution we run on, CI
      // included — that is the branch this whole helper exists for, so
      // assert it rather than accepting either answer. A platform without
      // one (macOS) must still get a usable temp dir.
      const expectedRoot = process.platform === "linux" && ramBackedRootIsUsable() ? "/dev/shm" : tmpdir();
      expect(dir.startsWith(expectedRoot)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
