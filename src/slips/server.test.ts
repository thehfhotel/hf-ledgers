// Route-wiring tests for ส่งสลิป's own server — same pattern
// src/server/server.test.ts established: point storage at a temp dir /
// :memory: db, force the dev auth bypass, then drive api.handle()/
// internalApi.handle() directly (no real HTTP socket). Env vars are set
// BEFORE the dynamic import of server.ts, since db.ts opens the database at
// import time (see storage.test.ts's own comment for why this MUST be a
// dynamic import, not a static one).

process.env.SLIPS_DB_PATH = ":memory:";
process.env.SLIPS_DATA_DIR = `/tmp/slips-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
process.env.NODE_ENV = "development";
process.env.DEV_USER = "tester@thehfhotel.org";
process.env.PORT = "0"; // let the OS pick a free port — avoids clashing with `bun run dev`
process.env.SLIPS_INGRESS_TOKEN = "test-ingress-token";

import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import type { DayAuditCheckinRow, DayAuditRow } from "../server/day-audit.ts";

const { api, internalApi } = await import("./server.ts");
const { _internal: dayAuditInternal } = await import("../server/day-audit.ts");

interface Call<T> {
  status: number;
  body: T;
}

interface HandleableApp {
  handle: (req: Request) => Promise<Response>;
}

async function call<T>(app: HandleableApp, method: string, path: string, init?: RequestInit): Promise<Call<T>> {
  const res = await app.handle(new Request(`http://localhost${path}`, { method, ...init }));
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, body };
}

async function callRaw(app: HandleableApp, method: string, path: string, init?: RequestInit): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { method, ...init }));
}

// Large enough (long edge > both the 2200px main cap and the 480px thumb
// cap) that BOTH outputs actually get resized proportionally — a
// small/flat fixture would leave both uncapped and near-identical in size,
// which isn't a meaningful "thumbnail is smaller" proof (see image.test.ts,
// which established this same large-fixture requirement).
async function jpegBytes(width = 3000, height = 2000): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = i % 256;
    raw[i + 1] = (i / 3) % 256;
    raw[i + 2] = 128;
  }
  const out = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
  return new Uint8Array(out);
}

// TS 5.9's stricter BlobPart typing wants an ArrayBufferView<ArrayBuffer>
// specifically, not the ArrayBufferLike a Node Buffer-derived Uint8Array
// carries generically — this is purely a type-level cast (the runtime
// bytes are identical either way), not a real ArrayBuffer/SharedArrayBuffer
// distinction this test cares about.
function blobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes as unknown as ArrayBuffer;
}

/** `fetch`/`Request` default to `text/plain` for a plain string body — the
 * cash-mark/cash-unmark routes need an explicit `application/json`
 * content-type for Elysia's `t.Object` body parser to engage, same as the
 * ledger's own `call()` helper (src/server/server.test.ts) does automatically. */
function jsonInit(body: unknown): RequestInit {
  return { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
}

function checkinRow(overrides: Partial<DayAuditCheckinRow> = {}): DayAuditCheckinRow {
  return {
    kind: "checkin",
    auditKey: "CH900001",
    chRef: "CH900001",
    paidAtIso: "2026-08-15T08:00:00.000Z",
    guestName: "ทดสอบ ระบบ",
    receiptPayNos: ["R2608-9001"],
    grossSatang: 100_000,
    composition: { cashSatang: 0, transferSatang: 100_000, creditSatang: 0, webSatang: 0, penaltySatang: 0 },
    depositApplied: null,
    ...overrides,
  };
}

describe("GET /slips-api/me", () => {
  test("401 without an identity", async () => {
    const savedDevUser = process.env.DEV_USER;
    delete process.env.DEV_USER;
    const res = await call(api, "GET", "/slips-api/me");
    expect(res.status).toBe(401);
    process.env.DEV_USER = savedDevUser;
  });

  test("200: identity + a default property from the kiosk email map", async () => {
    const saved = process.env.DEV_USER;
    process.env.DEV_USER = "theharbourfront.hotel@gmail.com";
    const res = await call<{ email: string; defaultProperty: string }>(api, "GET", "/slips-api/me");
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("theharbourfront.hotel@gmail.com");
    expect(res.body.defaultProperty).toBe("hf");
    process.env.DEV_USER = saved;
  });

  test("defaults to hf for an unmapped identity", async () => {
    const res = await call<{ defaultProperty: string }>(api, "GET", "/slips-api/me");
    expect(res.body.defaultProperty).toBe("hf");
  });
});

describe("GET /slips-api/:property/day/:date — the queue", () => {
  afterEach(() => {
    dayAuditInternal.setFetchDayAuditForTests(null);
  });

  test("400 on an invalid property or date", async () => {
    expect((await call(api, "GET", "/slips-api/xx/day/2026-08-03")).status).toBe(400);
    expect((await call(api, "GET", "/slips-api/hf/day/not-a-date")).status).toBe(400);
  });

  test("503 when the property's PMS env URL is unset", async () => {
    delete process.env.PMS_DB_URL_HF;
    const res = await call(api, "GET", "/slips-api/hf/day/2026-08-03");
    expect(res.status).toBe(503);
  });

  test("502 when the PMS query fails", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    dayAuditInternal.setFetchDayAuditForTests(async () => {
      throw new Error("connection refused");
    });
    const res = await call(api, "GET", "/slips-api/hf/day/2026-08-03");
    expect(res.status).toBe(502);
    delete process.env.PMS_DB_URL_HF;
  });

  test("200: only transfer-tendered rows appear", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    const rows: DayAuditRow[] = [
      checkinRow({ auditKey: "CH900010", chRef: "CH900010" }),
      checkinRow({
        auditKey: "CH900011",
        chRef: "CH900011",
        composition: { cashSatang: 100_000, transferSatang: 0, creditSatang: 0, webSatang: 0, penaltySatang: 0 },
      }),
    ];
    dayAuditInternal.setFetchDayAuditForTests(async () => rows);
    const res = await call<{ rows: Array<{ auditKey: string }> }>(api, "GET", "/slips-api/hf/day/2026-08-03");
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.auditKey)).toEqual(["CH900010"]);
    delete process.env.PMS_DB_URL_HF;
  });
});

describe("attach -> re-encode -> serve -> supersede -> history round-trip", () => {
  afterEach(() => {
    dayAuditInternal.setFetchDayAuditForTests(null);
  });

  test("full lifecycle with a real generated JPEG", async () => {
    const bytes = await jpegBytes();
    const form1 = new FormData();
    form1.append("file", new Blob([blobPart(bytes)], { type: "image/jpeg" }), "slip1.jpg");
    form1.append("date", "2026-08-03");

    const attach1 = await call<{ auditKey: string; version: number; superseded: boolean; width: number; height: number }>(
      api,
      "POST",
      "/slips-api/hf/attach/CH900100",
      { body: form1 },
    );
    expect(attach1.status).toBe(201);
    expect(attach1.body.version).toBe(1);
    expect(attach1.body.superseded).toBe(false);
    expect(Math.max(attach1.body.width, attach1.body.height)).toBeLessThanOrEqual(2200);

    // Serve the original + thumb back.
    const picture = await callRaw(api, "GET", "/slips-api/hf/picture/CH900100/1");
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/jpeg");
    const pictureBytes = new Uint8Array(await picture.arrayBuffer());
    expect(pictureBytes.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(pictureBytes).includes(Buffer.from("Exif"))).toBe(false);

    const thumb = await callRaw(api, "GET", "/slips-api/hf/picture/CH900100/1/thumb");
    expect(thumb.status).toBe(200);
    const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
    expect(thumbBytes.byteLength).toBeGreaterThan(0);
    expect(thumbBytes.byteLength).toBeLessThan(pictureBytes.byteLength);

    // A second attach is a fresh version 2, not an overwrite of version 1.
    const form2 = new FormData();
    form2.append("file", new Blob([blobPart(await jpegBytes(200, 200))], { type: "image/jpeg" }), "slip2.jpg");
    form2.append("date", "2026-08-03");
    const attach2 = await call<{ version: number }>(api, "POST", "/slips-api/hf/attach/CH900100", { body: form2 });
    expect(attach2.status).toBe(201);
    expect(attach2.body.version).toBe(2);
    expect((await callRaw(api, "GET", "/slips-api/hf/picture/CH900100/1")).status).toBe(200); // v1 still fully servable

    // supersede v1 — v1 stays servable (history never deletes), but is
    // flagged superseded.
    const supersedeRes = await call<{ version: number; superseded: boolean; supersededBy: string }>(
      api,
      "POST",
      "/slips-api/hf/supersede/CH900100/1",
    );
    expect(supersedeRes.status).toBe(200);
    expect(supersedeRes.body.superseded).toBe(true);
    expect(supersedeRes.body.supersededBy).toBe("tester@thehfhotel.org");
    expect((await callRaw(api, "GET", "/slips-api/hf/picture/CH900100/1")).status).toBe(200);

    // history shows both versions with the right superseded flags.
    const history = await call<{ versions: Array<{ version: number; superseded: boolean }> }>(
      api,
      "GET",
      "/slips-api/hf/history/CH900100",
    );
    expect(history.status).toBe(200);
    expect(history.body.versions).toEqual([
      expect.objectContaining({ version: 1, superseded: true }),
      expect.objectContaining({ version: 2, superseded: false }),
    ]);

    // supersede on a nonexistent version 404s.
    expect((await call(api, "POST", "/slips-api/hf/supersede/CH900100/99")).status).toBe(404);

    // the day-audit queue now reflects the real attachment state, no PMS override interference on the property gate.
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    dayAuditInternal.setFetchDayAuditForTests(async () => [checkinRow({ auditKey: "CH900100", chRef: "CH900100" })]);
    const queue = await call<{
      rows: Array<{ auditKey: string; attachment: { count: number; latestVersion: number | null }; currentAttachments: Array<{ version: number }> }>;
    }>(api, "GET", "/slips-api/hf/day/2026-08-03");
    expect(queue.body.rows[0]!.attachment.count).toBe(1); // only v2 is current
    expect(queue.body.rows[0]!.attachment.latestVersion).toBe(2);
    expect(queue.body.rows[0]!.currentAttachments.map((a) => a.version)).toEqual([2]);
    delete process.env.PMS_DB_URL_HF;

    // กู้คืน: restoring v1 brings it back as current WITHOUT touching v2.
    const restoreRes = await call<{ version: number; superseded: boolean; supersededBy: string | null }>(
      api,
      "POST",
      "/slips-api/hf/restore/CH900100/1",
    );
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.superseded).toBe(false);
    expect(restoreRes.body.supersededBy).toBeNull();

    const historyAfterRestore = await call<{ versions: Array<{ version: number; superseded: boolean }> }>(
      api,
      "GET",
      "/slips-api/hf/history/CH900100",
    );
    expect(historyAfterRestore.body.versions).toEqual([
      expect.objectContaining({ version: 1, superseded: false }),
      expect.objectContaining({ version: 2, superseded: false }),
    ]);

    // restore on a nonexistent version 404s.
    expect((await call(api, "POST", "/slips-api/hf/restore/CH900100/99")).status).toBe(404);

    // Take v1 back out again over HTTP — proves a restored version stays
    // supersede-able through the real route (storage.test.ts's own
    // multi-author unit test proves this writes a genuinely FRESH event,
    // not a no-op against the original supersede). This also returns
    // CH900100 to its pre-restore state (only v2 current) for the
    // downstream /slips-internal test below.
    const reSupersede = await call<{ superseded: boolean }>(api, "POST", "/slips-api/hf/supersede/CH900100/1");
    expect(reSupersede.status).toBe(200);
    expect(reSupersede.body.superseded).toBe(true);
  });

  test("400 for a non-image upload", async () => {
    const form = new FormData();
    form.append("file", new Blob([new TextEncoder().encode("not an image")], { type: "text/plain" }), "not-image.txt");
    form.append("date", "2026-08-03");
    const res = await call<{ error: string }>(api, "POST", "/slips-api/hf/attach/CH900200", { body: form });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unrecognized image format/);
  });

  test("400 for an invalid auditKey or date", async () => {
    const form = new FormData();
    form.append("file", new Blob([blobPart(await jpegBytes())], { type: "image/jpeg" }), "slip.jpg");
    form.append("date", "not-a-date");
    expect((await call(api, "POST", "/slips-api/hf/attach/CH900300", { body: form })).status).toBe(400);

    const form2 = new FormData();
    form2.append("file", new Blob([blobPart(await jpegBytes())], { type: "image/jpeg" }), "slip.jpg");
    form2.append("date", "2026-08-03");
    expect((await call(api, "POST", `/slips-api/hf/attach/${"X".repeat(999)}`, { body: form2 })).status).toBe(400);
  });

  test("404 for a picture/thumb that doesn't exist", async () => {
    expect((await callRaw(api, "GET", "/slips-api/hf/picture/CH-NEVER-ATTACHED/1")).status).toBe(404);
    expect((await callRaw(api, "GET", "/slips-api/hf/picture/CH-NEVER-ATTACHED/1/thumb")).status).toBe(404);
  });

  test("400 for an invalid auditKey on picture/thumb routes (B2 consistency fix, 2026-08-03 review)", async () => {
    const tooLong = "X".repeat(999);
    expect((await callRaw(api, "GET", `/slips-api/hf/picture/${tooLong}/1`)).status).toBe(400);
    expect((await callRaw(api, "GET", `/slips-api/hf/picture/${tooLong}/1/thumb`)).status).toBe(400);
  });

  test("picture/thumb responses are never cached on a shared device (2026-08-03 review cheap fix)", async () => {
    const res = await callRaw(api, "GET", "/slips-api/hf/picture/CH900100/1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const thumbRes = await callRaw(api, "GET", "/slips-api/hf/picture/CH900100/1/thumb");
    expect(thumbRes.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("POST /slips-api/:property/cash-mark & cash-unmark — ยืนยันชำระเงินสด (paid-in-cash reversal)", () => {
  afterEach(() => {
    dayAuditInternal.setFetchDayAuditForTests(null);
    delete process.env.PMS_DB_URL_HF;
  });

  test("400 on an invalid property, auditKey, or date — both routes", async () => {
    expect((await call(api, "POST", "/slips-api/xx/cash-mark/CH1", jsonInit({ date: "2026-08-03" }))).status).toBe(400);
    expect((await call(api, "POST", `/slips-api/hf/cash-mark/${"X".repeat(999)}`, jsonInit({ date: "2026-08-03" }))).status).toBe(400);
    expect((await call(api, "POST", "/slips-api/hf/cash-mark/CH1", jsonInit({ date: "not-a-date" }))).status).toBe(400);

    expect((await call(api, "POST", "/slips-api/xx/cash-unmark/CH1", jsonInit({ date: "2026-08-03" }))).status).toBe(400);
    expect((await call(api, "POST", `/slips-api/hf/cash-unmark/${"X".repeat(999)}`, jsonInit({ date: "2026-08-03" }))).status).toBe(400);
    expect((await call(api, "POST", "/slips-api/hf/cash-unmark/CH1", jsonInit({ date: "not-a-date" }))).status).toBe(400);
  });

  test("mark: 200 { auditKey, cashMark } and the day queue reflects it", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    dayAuditInternal.setFetchDayAuditForTests(async () => [checkinRow({ auditKey: "CH900400", chRef: "CH900400" })]);

    const mark = await call<{ auditKey: string; cashMark: { at: string; by: string } }>(
      api,
      "POST",
      "/slips-api/hf/cash-mark/CH900400",
      jsonInit({ date: "2026-08-03" }),
    );
    expect(mark.status).toBe(200);
    expect(mark.body.auditKey).toBe("CH900400");
    expect(mark.body.cashMark.by).toBe("tester@thehfhotel.org");
    expect(mark.body.cashMark.at).toBeTruthy();

    const queue = await call<{ rows: Array<{ auditKey: string; cashMark: { at: string; by: string } | null }> }>(
      api,
      "GET",
      "/slips-api/hf/day/2026-08-03",
    );
    expect(queue.body.rows[0]!.cashMark).toEqual(mark.body.cashMark);
  });

  test("re-marking is idempotent over HTTP too: the response is the SAME original mark", async () => {
    const first = await call<{ cashMark: { at: string; by: string } }>(api, "POST", "/slips-api/hf/cash-mark/CH900401", jsonInit({ date: "2026-08-03" }));
    const second = await call<{ cashMark: { at: string; by: string } }>(api, "POST", "/slips-api/hf/cash-mark/CH900401", jsonInit({ date: "2026-08-03" }));
    expect(second.body.cashMark).toEqual(first.body.cashMark);
  });

  test("unmark: 200 { auditKey, cashMark: null } and the queue reverts to pending", async () => {
    process.env.PMS_DB_URL_HF = "postgresql://readonly@fake-pms-test/hf";
    dayAuditInternal.setFetchDayAuditForTests(async () => [checkinRow({ auditKey: "CH900402", chRef: "CH900402" })]);

    await call(api, "POST", "/slips-api/hf/cash-mark/CH900402", jsonInit({ date: "2026-08-03" }));

    const unmark = await call<{ auditKey: string; cashMark: null }>(api, "POST", "/slips-api/hf/cash-unmark/CH900402", jsonInit({ date: "2026-08-03" }));
    expect(unmark.status).toBe(200);
    expect(unmark.body.auditKey).toBe("CH900402");
    expect(unmark.body.cashMark).toBeNull();

    const queue = await call<{ rows: Array<{ auditKey: string; cashMark: unknown }> }>(api, "GET", "/slips-api/hf/day/2026-08-03");
    expect(queue.body.rows[0]!.cashMark).toBeNull();
  });

  test("un-marking a never-marked settlement is a harmless 200 no-op", async () => {
    const res = await call<{ cashMark: null }>(api, "POST", "/slips-api/hf/cash-unmark/CH900403-NEVER-MARKED", jsonInit({ date: "2026-08-03" }));
    expect(res.status).toBe(200);
    expect(res.body.cashMark).toBeNull();
  });
});

describe("/slips-internal/:property/status — cashMarkedAt/cashMarkedBy", () => {
  test("carries cashMarkedAt/cashMarkedBy for a marked key, nulls for an unmarked one", async () => {
    await call(api, "POST", "/slips-api/hf/cash-mark/CH900500", jsonInit({ date: "2026-08-03" }));

    const res = await call<Record<string, { cashMarkedAt: string | null; cashMarkedBy: string | null }>>(
      internalApi,
      "GET",
      "/slips-internal/hf/status?keys=CH900500,CH900500-NEVER-MARKED",
      { headers: { authorization: "Bearer test-ingress-token" } },
    );
    expect(res.status).toBe(200);
    expect(res.body["CH900500"]!.cashMarkedAt).not.toBeNull();
    expect(res.body["CH900500"]!.cashMarkedBy).toBe("tester@thehfhotel.org");
    expect(res.body["CH900500-NEVER-MARKED"]!.cashMarkedAt).toBeNull();
    expect(res.body["CH900500-NEVER-MARKED"]!.cashMarkedBy).toBeNull();
  });
});

describe("B2 (Opus security review, 2026-08-03) — path traversal via the real HTTP attach/supersede/history endpoints", () => {
  test("a '../../../HTTP_PWNED'-shaped auditKey is accepted (auditKey format is intentionally permissive — real PMS refs aren't charset-clean) but writes land safely inside the sanitized tree, never escaping", async () => {
    const maliciousKey = "..%2F..%2F..%2FHTTP_PWNED"; // literal characters, not URL-decoded by the test harness — proves the RAW string (with %2F as literal text) is what's defended against too
    const form = new FormData();
    form.append("file", new Blob([blobPart(await jpegBytes(600, 400))], { type: "image/jpeg" }), "slip.jpg");
    form.append("date", "2026-08-03");
    const res = await call<{ auditKey: string; version: number }>(api, "POST", `/slips-api/hf/attach/${encodeURIComponent(maliciousKey)}`, { body: form });
    expect(res.status).toBe(201);

    // The attachment is fully retrievable through the NORMAL API (proving
    // the write landed somewhere sane and is tracked correctly by the raw
    // key in the DB, never by re-deriving a path from it).
    const picture = await callRaw(api, "GET", `/slips-api/hf/picture/${encodeURIComponent(maliciousKey)}/1`);
    expect(picture.status).toBe(200);
  });

  test("a crafted auditKey containing '../hfville/...' never writes into hfville's tree when property is hf", async () => {
    const crossPropertyKey = "../hfville/2026-08/CH-CROSS-TEST";
    const form = new FormData();
    form.append("file", new Blob([blobPart(await jpegBytes(600, 400))], { type: "image/jpeg" }), "slip.jpg");
    form.append("date", "2026-08-03");
    const res = await call<{ version: number }>(api, "POST", `/slips-api/hf/attach/${encodeURIComponent(crossPropertyKey)}`, { body: form });
    expect(res.status).toBe(201);

    // hfville's own queue/history for a similarly-shaped key must be
    // completely unaffected — the two properties never share a tree.
    const hfvilleHistory = await call<{ versions: unknown[] }>(api, "GET", `/slips-api/hfville/history/${encodeURIComponent(crossPropertyKey)}`);
    expect(hfvilleHistory.body.versions).toEqual([]);
  });

  test("a null byte in the auditKey never 500s and never reaches the filesystem raw", async () => {
    const nullByteKey = "CH001 ../../etc/passwd";
    const form = new FormData();
    form.append("file", new Blob([blobPart(await jpegBytes(600, 400))], { type: "image/jpeg" }), "slip.jpg");
    form.append("date", "2026-08-03");
    const res = await call(api, "POST", `/slips-api/hf/attach/${encodeURIComponent(nullByteKey)}`, { body: form });
    // Either accepted (and safely sanitized — the storage.test.ts suite
    // proves the sanitizer's own behavior in detail) or rejected outright;
    // the one thing that must NEVER happen is a 500 leaking a raw path.
    expect([201, 400]).toContain(res.status);
    if (res.status !== 201) {
      const body = res.body as { error?: string };
      expect(body.error ?? "").not.toMatch(/\/Users\/|\/app\/|\/tmp\//);
    }
  });
});

describe("B3 (Opus security review, 2026-08-03) — decompression bomb rejected over the real HTTP attach endpoint", () => {
  function craftLyingPng(width: number, height: number): Uint8Array {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8;
    ihdrData[9] = 2;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(ihdrData.length, 0);
    const crc = Buffer.alloc(4);
    return new Uint8Array(Buffer.concat([Buffer.from(sig), length, Buffer.from("IHDR"), ihdrData, crc]));
  }

  test("a crafted 20000x20000 'lying header' PNG (tiny file, huge claimed pixel count) is rejected with 400, fast", async () => {
    const bomb = craftLyingPng(20000, 20000);
    expect(bomb.byteLength).toBeLessThan(100);
    const form = new FormData();
    form.append("file", new Blob([blobPart(bomb)], { type: "image/png" }), "bomb.png");
    form.append("date", "2026-08-03");

    const start = Date.now();
    const res = await call<{ error: string }>(api, "POST", "/slips-api/hf/attach/CH-BOMB-TEST", { body: form });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pixel limit/);
    expect(elapsed).toBeLessThan(500); // proves no decode was attempted through the real HTTP/multipart path either
  });

  test("a genuinely corrupted (truncated) but magic-valid, within-budget image never 500s — 400 only", async () => {
    const real = await jpegBytes(1200, 900);
    const truncated = real.slice(0, Math.floor(real.byteLength / 3));
    const form = new FormData();
    form.append("file", new Blob([blobPart(truncated)], { type: "image/jpeg" }), "corrupt.jpg");
    form.append("date", "2026-08-03");
    const res = await call(api, "POST", "/slips-api/hf/attach/CH-CORRUPT-TEST", { body: form });
    expect(res.status).toBe(400);
  });
});

describe("/slips-internal/* — bearer-token gated, server-to-server only", () => {
  test("401 without a valid bearer token", async () => {
    expect((await callRaw(internalApi, "GET", "/slips-internal/hf/status?keys=CH900100")).status).toBe(401);
    expect(
      (await callRaw(internalApi, "GET", "/slips-internal/hf/status?keys=CH900100", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
  });

  test("200: status reflects real attachment state with the correct token", async () => {
    const res = await call<Record<string, { count: number; latestVersion: number | null }>>(
      internalApi,
      "GET",
      "/slips-internal/hf/status?keys=CH900100,CH-NEVER-ATTACHED",
      { headers: { authorization: "Bearer test-ingress-token" } },
    );
    expect(res.status).toBe(200);
    expect(res.body["CH900100"]!.count).toBe(1);
    expect(res.body["CH900100"]!.latestVersion).toBe(2);
    expect(res.body["CH-NEVER-ATTACHED"]!.count).toBe(0);
  });

  test("thumb: 404 when nothing attached, 200 bytes when it is", async () => {
    const missing = await callRaw(internalApi, "GET", "/slips-internal/hf/thumb/CH-NEVER-ATTACHED", {
      headers: { authorization: "Bearer test-ingress-token" },
    });
    expect(missing.status).toBe(404);

    const found = await callRaw(internalApi, "GET", "/slips-internal/hf/thumb/CH900100", {
      headers: { authorization: "Bearer test-ingress-token" },
    });
    expect(found.status).toBe(200);
    expect((await found.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
