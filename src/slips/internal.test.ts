// See storage.test.ts's own comment: env vars must be set BEFORE db.ts
// (imported transitively via storage.ts) opens the database — a plain
// top-level `import` would be hoisted ahead of these assignments, so both
// modules are loaded via a dynamic import below, after the env is set.
process.env.SLIPS_DB_PATH = ":memory:";
process.env.SLIPS_DATA_DIR = `/tmp/slips-internal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

import { afterEach, describe, expect, test } from "bun:test";
const { buildStatusResponse, constantTimeEqual, isValidIngressToken, latestThumbPath, parseStatusKeys } = await import("./internal.ts");
const { createAttachment } = await import("./storage.ts");

describe("constantTimeEqual", () => {
  test("equal strings match", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });
  test("different strings of the same length don't match", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });
  test("different-length strings don't match (and never throw)", () => {
    expect(constantTimeEqual("short", "much-longer-token")).toBe(false);
    expect(constantTimeEqual("", "nonempty")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("isValidIngressToken", () => {
  afterEach(() => {
    delete process.env.SLIPS_INGRESS_TOKEN;
  });

  test("fails closed when SLIPS_INGRESS_TOKEN is unset, even with a matching-looking header", () => {
    delete process.env.SLIPS_INGRESS_TOKEN;
    expect(isValidIngressToken("Bearer anything")).toBe(false);
    expect(isValidIngressToken(null)).toBe(false);
  });

  test("accepts the correct bearer token", () => {
    process.env.SLIPS_INGRESS_TOKEN = "s3cr3t-token";
    expect(isValidIngressToken("Bearer s3cr3t-token")).toBe(true);
  });

  test("rejects a wrong token, a missing header, or a non-Bearer scheme", () => {
    process.env.SLIPS_INGRESS_TOKEN = "s3cr3t-token";
    expect(isValidIngressToken("Bearer wrong-token")).toBe(false);
    expect(isValidIngressToken(null)).toBe(false);
    expect(isValidIngressToken("Basic s3cr3t-token")).toBe(false);
    expect(isValidIngressToken("s3cr3t-token")).toBe(false);
  });
});

describe("parseStatusKeys", () => {
  test("splits, trims, and drops blanks", () => {
    expect(parseStatusKeys("CH001, R2608-0001 ,, CH002")).toEqual(["CH001", "R2608-0001", "CH002"]);
  });
  test("null/empty input yields an empty list", () => {
    expect(parseStatusKeys(null)).toEqual([]);
    expect(parseStatusKeys("")).toEqual([]);
  });
  test("drops entries longer than the bound and caps the total count", () => {
    const tooLong = "X".repeat(41);
    expect(parseStatusKeys(`CH001,${tooLong}`)).toEqual(["CH001"]);
    const many = Array.from({ length: 250 }, (_, i) => `K${i}`).join(",");
    expect(parseStatusKeys(many)).toHaveLength(200);
  });
});

describe("buildStatusResponse", () => {
  test("every requested key is present, zero-valued when unknown", () => {
    const res = buildStatusResponse("hf", ["CH-UNKNOWN"]);
    expect(res["CH-UNKNOWN"]).toEqual({ count: 0, latestAt: null, latestVersion: null, superseded: 0 });
  });

  test("reflects a real attachment", async () => {
    await createAttachment({
      property: "hf",
      auditKey: "CH-STATUS-1",
      auditDate: "2026-08-03",
      by: "a@x.com",
      buffer: new Uint8Array([1, 2, 3]),
      thumbBuffer: new Uint8Array([4, 5]),
      width: 10,
      height: 10,
      format: "jpeg",
      engine: "jimp",
    });
    const res = buildStatusResponse("hf", ["CH-STATUS-1"]);
    expect(res["CH-STATUS-1"]!.count).toBe(1);
    expect(res["CH-STATUS-1"]!.latestAt).not.toBeNull();
  });
});

describe("latestThumbPath", () => {
  test("null when nothing attached", () => {
    expect(latestThumbPath("hf", "CH-NEVER-THUMB")).toBeNull();
  });
  test("points at the latest CURRENT attachment's thumb file", async () => {
    const rec = await createAttachment({
      property: "hf",
      auditKey: "CH-THUMB-1",
      auditDate: "2026-08-03",
      by: "a@x.com",
      buffer: new Uint8Array([1]),
      thumbBuffer: new Uint8Array([2]),
      width: 5,
      height: 5,
      format: "jpeg",
      engine: "jimp",
    });
    expect(latestThumbPath("hf", "CH-THUMB-1")).toBe(rec.thumbPath);
  });
});
