// Env vars must be set BEFORE importing storage.ts, since db.ts opens the
// database (and picturesRoot() reads SLIPS_DATA_DIR) at import time — same
// gotcha src/server/server.test.ts documents for DB_PATH. A plain top-level
// `import` would be hoisted ahead of these assignments (ESM import
// evaluation order), so storage.ts is loaded via a DYNAMIC import below,
// after the env is set, same fix server.test.ts already established.
process.env.SLIPS_DB_PATH = ":memory:";
process.env.SLIPS_DATA_DIR = `/tmp/slips-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
const {
  attachmentDir,
  attachmentFileName,
  contentHashHex,
  createAttachment,
  getAttachment,
  latestCurrent,
  listCurrent,
  listHistory,
  nextVersion,
  sanitizeAuditKeyForPath,
  summarize,
  supersede,
  thumbFileName,
} = await import("./storage.ts");

describe("nextVersion", () => {
  test("1 for a brand-new settlement", () => {
    expect(nextVersion([])).toBe(1);
  });
  test("one past the highest existing version", () => {
    expect(nextVersion([1])).toBe(2);
    expect(nextVersion([1, 2, 3])).toBe(4);
    expect(nextVersion([1, 3])).toBe(4); // never reuses a gap
  });
});

describe("contentHashHex", () => {
  test("deterministic and distinguishes different content", () => {
    const a = contentHashHex(new TextEncoder().encode("hello"));
    const b = contentHashHex(new TextEncoder().encode("hello"));
    const c = contentHashHex(new TextEncoder().encode("world"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });
});

describe("path helpers", () => {
  test("attachmentDir keys by the AUDITED day's month, not upload time, and sanitizes the auditKey component", () => {
    expect(attachmentDir("hf", "2026-08-03", "CH00123")).toBe(`hf/2026-08/${sanitizeAuditKeyForPath("CH00123")}`);
    expect(attachmentDir("hfville", "2026-01-15", "R014843")).toBe(`hfville/2026-01/${sanitizeAuditKeyForPath("R014843")}`);
  });
  test("file names embed version + content hash", () => {
    expect(attachmentFileName(3, "abc123", "jpg")).toBe("v3-abc123.jpg");
    expect(thumbFileName(3, "abc123", "jpg")).toBe("v3-abc123.thumb.jpg");
  });
});

describe("sanitizeAuditKeyForPath — B2 path-traversal defense (Opus security review, 2026-08-03)", () => {
  test("a clean key still gets a hash suffix (never a bare pass-through)", () => {
    const out = sanitizeAuditKeyForPath("CH00123");
    expect(out.startsWith("CH00123-")).toBe(true);
    expect(out).not.toBe("CH00123");
  });

  test("path-traversal payloads never produce a '/' or '..' segment in the output", () => {
    const payloads = ["../../../etc/passwd", "..%2F..%2F..%2FHTTP_PWNED", "../../hfville/2026-08/CH999999", "a/../../b", "....//....//etc"];
    for (const payload of payloads) {
      const out = sanitizeAuditKeyForPath(payload);
      expect(out.includes("/")).toBe(false);
      expect(out.includes("..")).toBe(false);
      expect(out.includes("\\")).toBe(false);
    }
  });

  test("a null byte or other control character is stripped, never reaches the output raw", () => {
    const out = sanitizeAuditKeyForPath("CH001\x0000/../../etc");
    expect(out).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  test("two different raw keys that sanitize to the same allowlisted string never collide (the hash suffix disambiguates)", () => {
    const a = sanitizeAuditKeyForPath("CH/001");
    const b = sanitizeAuditKeyForPath("CH:001");
    // Both strip their separator to "_", so the CLEANED prefix collides —
    // the point of the hash suffix is that the FULL outputs still differ.
    expect(a).not.toBe(b);
  });

  test("bounded length even for a pathologically long key", () => {
    const out = sanitizeAuditKeyForPath("A".repeat(500));
    expect(out.length).toBeLessThan(60);
  });

  test("deterministic — the same raw key always sanitizes to the same output", () => {
    expect(sanitizeAuditKeyForPath("R014843")).toBe(sanitizeAuditKeyForPath("R014843"));
  });
});

describe("createAttachment — B2 live traversal probe: a malicious auditKey can never escape picturesRoot() or cross into another property's tree", () => {
  test("a '../../../HTTP_PWNED'-shaped auditKey writes ONLY inside this property's own sanitized directory", async () => {
    const maliciousKey = "../../../HTTP_PWNED";
    const rec = await createAttachment({
      property: "hf",
      auditKey: maliciousKey,
      auditDate: "2026-08-03",
      by: "attacker@example.com",
      buffer: fakeImage(200),
      thumbBuffer: fakeImage(201),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });

    const dataRoot = resolve(process.env.SLIPS_DATA_DIR!);
    const picturesRoot = resolve(dataRoot, "pictures");
    // The write landed strictly INSIDE picturesRoot() — never escaped it.
    expect(resolve(rec.filePath).startsWith(picturesRoot + "/")).toBe(true);
    expect(resolve(rec.thumbPath).startsWith(picturesRoot + "/")).toBe(true);
    // And specifically inside "hf"'s own subtree, never e.g. "hfville"'s,
    // and never literally at a top-level "HTTP_PWNED" outside pictures/.
    expect(rec.filePath).toContain(`${picturesRoot}/hf/`);
    expect(rec.filePath).not.toContain("HTTP_PWNED/"); // the raw key never survives as a real directory segment
  });

  test("a crafted key that names another property never writes into that property's tree", async () => {
    // Even though this key's TEXT contains "hfville", createAttachment is
    // called with property: "hf" — the sanitizer treats the whole string as
    // an opaque blob (replacing "/" with "_"), so it can never be
    // interpreted as a "hfville/..." path segment.
    const crossPropertyKey = "../hfville/2026-08/CH999999";
    const rec = await createAttachment({
      property: "hf",
      auditKey: crossPropertyKey,
      auditDate: "2026-08-03",
      by: "attacker@example.com",
      buffer: fakeImage(210),
      thumbBuffer: fakeImage(211),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    expect(rec.filePath).toContain("/pictures/hf/2026-08/");
    expect(rec.filePath).not.toContain("/pictures/hfville/");
  });

  test("a null-byte-carrying auditKey never reaches the filesystem raw", async () => {
    const rec = await createAttachment({
      property: "hf",
      auditKey: "CH\x00../../etc/passwd",
      auditDate: "2026-08-03",
      by: "attacker@example.com",
      buffer: fakeImage(220),
      thumbBuffer: fakeImage(221),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    const dataRoot = resolve(process.env.SLIPS_DATA_DIR!);
    expect(resolve(rec.filePath).startsWith(resolve(dataRoot, "pictures") + "/")).toBe(true);
  });
});

function fakeImage(byte: number): Uint8Array {
  return new Uint8Array(64).fill(byte);
}

describe("createAttachment / supersede / history (round-trip against a real temp dir)", () => {
  test("first attach is version 1, current, not superseded", async () => {
    const rec = await createAttachment({
      property: "hf",
      auditKey: "CH00001",
      auditDate: "2026-08-03",
      by: "reception@thehfhotel.org",
      buffer: fakeImage(1),
      thumbBuffer: fakeImage(2),
      width: 100,
      height: 200,
      format: "jpeg",
      engine: "sharp",
    });
    expect(rec.version).toBe(1);
    expect(rec.superseded).toBe(false);
    expect(rec.supersededAt).toBeNull();
    expect(listCurrent("hf", "CH00001")).toHaveLength(1);
  });

  test("a second attach on the same settlement gets version 2, both current", async () => {
    await createAttachment({
      property: "hf",
      auditKey: "CH00002",
      auditDate: "2026-08-03",
      by: "a@x.com",
      buffer: fakeImage(3),
      thumbBuffer: fakeImage(4),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    const second = await createAttachment({
      property: "hf",
      auditKey: "CH00002",
      auditDate: "2026-08-03",
      by: "b@x.com",
      buffer: fakeImage(5),
      thumbBuffer: fakeImage(6),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    expect(second.version).toBe(2);
    expect(listCurrent("hf", "CH00002")).toHaveLength(2);
    expect(listHistory("hf", "CH00002")).toHaveLength(2);
  });

  test("supersede moves a version out of current but keeps it in history", async () => {
    const v1 = await createAttachment({
      property: "hf",
      auditKey: "CH00003",
      auditDate: "2026-08-03",
      by: "a@x.com",
      buffer: fakeImage(7),
      thumbBuffer: fakeImage(8),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    expect(listCurrent("hf", "CH00003")).toHaveLength(1);

    const superseded = supersede("hf", "CH00003", v1.version, "manager@x.com");
    expect(superseded?.superseded).toBe(true);
    expect(superseded?.supersededBy).toBe("manager@x.com");
    expect(listCurrent("hf", "CH00003")).toHaveLength(0);
    expect(listHistory("hf", "CH00003")).toHaveLength(1); // the file/row survives, just not "current"
  });

  test("supersede on an unknown version returns null (caller 404s)", () => {
    expect(supersede("hf", "CH00003", 99, "x@x.com")).toBeNull();
  });

  test("re-superseding an already-superseded version is a harmless no-op", async () => {
    const v1 = await createAttachment({
      property: "hf",
      auditKey: "CH00004",
      auditDate: "2026-08-03",
      by: "a@x.com",
      buffer: fakeImage(9),
      thumbBuffer: fakeImage(10),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    supersede("hf", "CH00004", v1.version, "m1@x.com");
    const again = supersede("hf", "CH00004", v1.version, "m2@x.com");
    // ON CONFLICT DO NOTHING: the FIRST supersede wins, second is a no-op.
    expect(again?.supersededBy).toBe("m1@x.com");
  });

  test("getAttachment returns null for a settlement that never had one", () => {
    expect(getAttachment("hf", "CH-NEVER", 1)).toBeNull();
  });

  test("latestCurrent picks the highest current version, ignoring superseded ones", async () => {
    const v1 = await createAttachment({
      property: "hfville",
      auditKey: "R099999",
      auditDate: "2026-08-01",
      by: "a@x.com",
      buffer: fakeImage(11),
      thumbBuffer: fakeImage(12),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    const v2 = await createAttachment({
      property: "hfville",
      auditKey: "R099999",
      auditDate: "2026-08-01",
      by: "a@x.com",
      buffer: fakeImage(13),
      thumbBuffer: fakeImage(14),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    expect(latestCurrent("hfville", "R099999")?.version).toBe(v2.version);
    supersede("hfville", "R099999", v2.version, "m@x.com");
    expect(latestCurrent("hfville", "R099999")?.version).toBe(v1.version);
    supersede("hfville", "R099999", v1.version, "m@x.com");
    expect(latestCurrent("hfville", "R099999")).toBeNull();
  });
});

describe("summarize", () => {
  test("every requested key is present, zero-valued when never attached", () => {
    const out = summarize("hf", ["CH-NEVER-1", "CH-NEVER-2"]);
    expect(out.get("CH-NEVER-1")).toEqual({ count: 0, latestAt: null, latestVersion: null, superseded: 0 });
    expect(out.get("CH-NEVER-2")).toEqual({ count: 0, latestAt: null, latestVersion: null, superseded: 0 });
  });

  test("counts current vs. superseded separately", async () => {
    const v1 = await createAttachment({
      property: "hf",
      auditKey: "CH-SUM-1",
      auditDate: "2026-08-03",
      by: "a@x.com",
      buffer: fakeImage(21),
      thumbBuffer: fakeImage(22),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    await createAttachment({
      property: "hf",
      auditKey: "CH-SUM-1",
      auditDate: "2026-08-03",
      by: "a@x.com",
      buffer: fakeImage(23),
      thumbBuffer: fakeImage(24),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    supersede("hf", "CH-SUM-1", v1.version, "m@x.com");

    const out = summarize("hf", ["CH-SUM-1"]);
    const summary = out.get("CH-SUM-1")!;
    expect(summary.count).toBe(1);
    expect(summary.superseded).toBe(1);
    expect(summary.latestAt).not.toBeNull();
  });

  test("empty key list returns an empty map without querying", () => {
    expect(summarize("hf", []).size).toBe(0);
  });
});

describe("append-only rule: no file-delete primitive is ever imported under src/slips", () => {
  // Import-statement-shaped, not a raw substring search — this doc comment
  // (and every sibling file's) is free to NAME the banned functions in
  // prose without tripping this check; only an actual `import { X } from
  // "node:fs"` naming one of them counts.
  const BANNED = ["unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync"];

  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".test.ts")) continue; // this file itself may legitimately reference the banned names as plain strings, as above
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) out.push(...listSourceFiles(full));
      else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
    }
    return out;
  }

  test("grep-provable: no src/slips file imports a delete primitive from node:fs", () => {
    const root = join(import.meta.dir); // src/slips
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const content = readFileSync(file, "utf8");
      const fsImportLines = content.split("\n").filter((l) => /from\s+["']node:fs/.test(l));
      for (const line of fsImportLines) {
        for (const banned of BANNED) {
          if (new RegExp(`\\b${banned}\\b`).test(line)) offenders.push(`${file}: "${line.trim()}" names "${banned}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
