// ส่งสลิป — the reception slip inbox's OWN Bun server (Wave 2,
// docs/plan-audit-hub-slips.md). A SEPARATE entry point/process/origin from
// the income ledger (src/server/server.ts): this file never imports that
// one (importing it would start a SECOND Bun.serve + open the LEDGER'S
// SQLite database as an unwanted side effect of module top-level code) —
// the only src/server/* files this reuses are the three that are pure/
// side-effect-free at import time: auth.ts (identify()), day-audit.ts (the
// stay-merge machinery, via queue.ts), pms-prefill.ts (pmsConfigured()).
// This origin physically contains no ledger routes — grep this file: there
// is no /api/* route here, only /slips-api/* and /slips-internal/*.

import { Elysia, t } from "elysia";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { identify } from "../server/auth.ts";
import { pmsConfigured } from "../server/pms-prefill.ts";
import { isValidIso } from "../shared/date.ts";
import { BOOKING_NO_MAX_LEN, isProperty } from "../shared/types.ts";
import type { Property } from "../shared/types.ts";
import { encodeSlipImage, SlipImageError } from "./image.ts";
import { buildStatusResponse, isValidIngressToken, latestThumbPath, parseStatusKeys } from "./internal.ts";
import { buildSlipQueue } from "./queue.ts";
import { createAttachment, getAttachment, listHistory, supersede, type AttachmentRecord } from "./storage.ts";

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 4060);

// Cheap fix (Opus security review, 2026-08-03): a request body cap enforced
// at the Bun.serve level itself — BEFORE Elysia ever starts parsing/
// buffering a multipart body. Proven exploit: a 300MB body drove +590MB
// RSS because the app-level MAX_INPUT_BYTES check (image.ts) only runs
// AFTER the whole body is already buffered into memory. 20MB is a generous
// margin over MAX_INPUT_BYTES (15MB, image.ts) to cover multipart
// boundary/header overhead, while being nowhere near Bun's own 128MB
// default. Bun rejects an oversized request at the HTTP layer itself
// (before `fetch` is ever called for it) — this is real protection against
// a lying/absent Content-Length too, not just a header pre-check.
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

// Paths that look like a real static asset must 404 when missing, never
// SPA-fallback to index.html — same reasoning as src/server/server.ts's own
// ASSET_PATH_RE (a stale client asking for a chunk a newer deploy purged
// must fail loudly, not silently serve HTML as JS).
const ASSET_PATH_RE = /\.(js|css|map|png|svg|woff2?)$/i;

/** The kiosk-identity → default property map (owner ask, Wave 2 design):
 * the property pill still always switches freely, this only decides which
 * property loads FIRST for a given signed-in identity. */
const KIOSK_DEFAULT_PROPERTY: Record<string, Property> = {
  "theharbourfront.hotel@gmail.com": "hf",
  "hfville.hotel@gmail.com": "hfville",
};

function defaultPropertyForEmail(email: string): Property {
  return KIOSK_DEFAULT_PROPERTY[email.toLowerCase()] ?? "hf";
}

function mimeForFormat(format: string): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

/** Wire shape for one attachment version — never leaks the server
 * filesystem path (`filePath`/`thumbPath` stay server-internal; the client
 * fetches bytes via the picture/thumb routes, never a raw path). */
function toWireAttachment(record: AttachmentRecord) {
  return {
    auditKey: record.auditKey,
    version: record.version,
    bytes: record.bytes,
    width: record.width,
    height: record.height,
    format: record.format,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    superseded: record.superseded,
    supersededAt: record.supersededAt,
    supersededBy: record.supersededBy,
  };
}

function parseVersionParam(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isValidAuditKey(key: string): boolean {
  return key.length > 0 && key.length <= BOOKING_NO_MAX_LEN;
}

// ── /slips-api/* — the browser-facing app (Cloudflare Access + identify(),
// same JWT verification the ledger itself uses — a SEPARATE Access
// application/audience for this hostname, see ACCESS_AUD in this
// container's own env). ──────────────────────────────────────────────────

export const api = new Elysia({ prefix: "/slips-api" })
  .derive(async ({ request }) => ({ identity: await identify(request) }))
  .onBeforeHandle(({ identity, status }) => {
    if (!identity) return status(401, { error: "unauthenticated" });
  })

  .get("/me", ({ identity }) => ({
    email: identity!.email,
    defaultProperty: defaultPropertyForEmail(identity!.email),
  }))

  // GET /slips-api/:property/day/:date — the queue: settlements still
  // needing a transfer slip (src/slips/queue.ts). Same dark-by-default
  // gate as the ledger's own day-audit route.
  .get("/:property/day/:date", async ({ params, status }) => {
    const { property, date } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidIso(date)) return status(400, { error: "invalid date" });
    if (!pmsConfigured(property)) return status(503, { error: "pms prefill not configured" });

    try {
      const rows = await buildSlipQueue(property, date);
      return { rows };
    } catch (err) {
      return status(502, { error: err instanceof Error ? err.message : String(err) });
    }
  })

  // POST /slips-api/:property/attach/:auditKey — append-only: always
  // creates a brand-new version, never overwrites one. `date` (body) is the
  // settlement's own audited day — determines the month bucket the picture
  // files under (storage.ts), NOT upload time.
  .post(
    "/:property/attach/:auditKey",
    async ({ params, body, identity, status }) => {
      const { property, auditKey } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidAuditKey(auditKey)) return status(400, { error: "invalid auditKey" });
      if (!isValidIso(body.date)) return status(400, { error: "invalid date" });

      const bytes = new Uint8Array(await body.file.arrayBuffer());
      let encoded: Awaited<ReturnType<typeof encodeSlipImage>>;
      try {
        encoded = await encodeSlipImage(bytes);
      } catch (err) {
        if (err instanceof SlipImageError) return status(400, { error: err.message });
        // Error hygiene (2026-08-03 review): never let a raw error surface
        // to the client (a decode/library error can embed internal detail)
        // — log full detail server-side only, a generic message to the
        // client. encodeSlipImage's own SlipImageError is now the ONLY
        // expected throw shape for a bad/oversized image (see image.ts's
        // own B3 fix), so reaching here at all is already an unexpected
        // condition worth a loud server-side log.
        console.error(`slips: unexpected encodeSlipImage failure for ${property}/${auditKey}: ${err instanceof Error ? err.message : String(err)}`);
        return status(500, { error: "could not process this image" });
      }

      let record: AttachmentRecord;
      try {
        record = await createAttachment({
          property,
          auditKey,
          auditDate: body.date,
          by: identity!.email,
          buffer: encoded.buffer,
          thumbBuffer: encoded.thumbBuffer,
          width: encoded.width,
          height: encoded.height,
          format: encoded.format,
          engine: encoded.engine,
        });
      } catch (err) {
        // Error hygiene: an fs/storage failure (disk full, the
        // containment-assert backstop in storage.ts, a race) must never
        // leak a filesystem path or internal detail to the client.
        console.error(`slips: attach failed for ${property}/${auditKey}: ${err instanceof Error ? err.message : String(err)}`);
        return status(500, { error: "could not save this attachment" });
      }
      return status(201, toWireAttachment(record));
    },
    // `maxSize` (cheap fix, 2026-08-03 review): a schema-level size bound
    // in ADDITION to Bun.serve's own `maxRequestBodySize` below and
    // encodeSlipImage's own MAX_INPUT_BYTES check — three independent
    // layers, cheapest/earliest first. `type` is deliberately NOT
    // constrained: a legitimate photo can arrive with a generic declared
    // content-type from some browsers/share-sheets, and the declared type
    // is never trusted anyway (encodeSlipImage's own magic-byte sniff is
    // the authoritative format gate).
    { body: t.Object({ file: t.File({ maxSize: "15m" }), date: t.String() }) },
  )

  // POST /slips-api/:property/supersede/:auditKey/:version — เปลี่ยน/ลบ:
  // writes a supersede record only. Idempotent (re-superseding an
  // already-superseded version is a no-op — see storage.ts).
  .post("/:property/supersede/:auditKey/:version", ({ params, identity, status }) => {
    const { property, auditKey } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidAuditKey(auditKey)) return status(400, { error: "invalid auditKey" });
    const version = parseVersionParam(params.version);
    if (version === null) return status(400, { error: "invalid version" });

    const result = supersede(property, auditKey, version, identity!.email);
    if (!result) return status(404, { error: "attachment not found" });
    return toWireAttachment(result);
  })

  // GET /slips-api/:property/picture/:auditKey/:version — serves the
  // immutable original. Superseded versions stay servable (full history
  // stays viewable — the plan's binding storage rule), just labeled
  // superseded by the wire shape the history endpoint returns.
  //
  // Cache-Control (2026-08-03 review): `private, no-store` — these bytes
  // are bank-slip photos (account numbers, amounts) served to a browser on
  // a SHARED reception kiosk; the previous `max-age=31536000, immutable`
  // would have cached them on that shared machine's disk for a full year.
  // "Immutable content, cache forever" is the right call for a hashed JS
  // chunk (see the static-asset serving below); it is the WRONG call for a
  // sensitive photo on a shared device, even though the bytes themselves
  // never change under this URL.
  .get("/:property/picture/:auditKey/:version", async ({ params, status }) => {
    const { property, auditKey } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidAuditKey(auditKey)) return status(400, { error: "invalid auditKey" });
    const version = parseVersionParam(params.version);
    if (version === null) return status(400, { error: "invalid version" });
    const record = getAttachment(property, auditKey, version);
    if (!record) return status(404, { error: "not found" });
    const file = Bun.file(record.filePath);
    if (!(await file.exists())) return status(404, { error: "not found" });
    return new Response(file, {
      headers: { "content-type": mimeForFormat(record.format), "cache-control": "private, no-store" },
    });
  })

  // GET /slips-api/:property/picture/:auditKey/:version/thumb — the cached
  // derivative beside the original. Same no-store reasoning as the route above.
  .get("/:property/picture/:auditKey/:version/thumb", async ({ params, status }) => {
    const { property, auditKey } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidAuditKey(auditKey)) return status(400, { error: "invalid auditKey" });
    const version = parseVersionParam(params.version);
    if (version === null) return status(400, { error: "invalid version" });
    const record = getAttachment(property, auditKey, version);
    if (!record) return status(404, { error: "not found" });
    const file = Bun.file(record.thumbPath);
    if (!(await file.exists())) return status(404, { error: "not found" });
    return new Response(file, {
      headers: { "content-type": mimeForFormat(record.format), "cache-control": "private, no-store" },
    });
  })

  // GET /slips-api/:property/history/:auditKey — every version, current and
  // superseded alike.
  .get("/:property/history/:auditKey", ({ params, status }) => {
    const { property, auditKey } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidAuditKey(auditKey)) return status(400, { error: "invalid auditKey" });
    return { versions: listHistory(property, auditKey).map(toWireAttachment) };
  });

// ── /slips-internal/* — server-to-server only (the ledger's day-audit
// enrichment + proof-thumb proxy), bearer-token gated, NEVER behind
// Cloudflare Access (this is a private Docker-network call). ──────────────

export const internalApi = new Elysia({ prefix: "/slips-internal" })
  .onBeforeHandle(({ request, status }) => {
    if (!isValidIngressToken(request.headers.get("authorization"))) {
      return status(401, { error: "unauthorized" });
    }
  })

  .get("/:property/status", ({ params, query, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const keys = parseStatusKeys(typeof query.keys === "string" ? query.keys : null);
    return buildStatusResponse(property, keys);
  })

  .get("/:property/thumb/:auditKey", async ({ params, status }) => {
    const { property, auditKey } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const path = latestThumbPath(property, auditKey);
    if (!path) return status(404, { error: "not found" });
    const file = Bun.file(path);
    if (!(await file.exists())) return status(404, { error: "not found" });
    // no-store — same reasoning as /slips-api/.../picture above: the
    // ledger's own proxy (src/server/server.ts) forwards this response's
    // headers straight through to the office browser.
    return new Response(file, { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } });
  });

const apiFetch = (req: Request) => api.handle(req);
const internalFetch = (req: Request) => internalApi.handle(req);

// GET /healthz stays DB-free, outside both API groups, same reasoning as
// the ledger's own healthz (src/server/server.ts).
const healthz = () => Response.json({ ok: true });

if (isProd) {
  // ────────────────────────────────────────────────────────────────────
  // Production: serve the precompiled slips SPA from ./dist/slips-client/
  // — mirrors src/server/server.ts's static-serving block exactly (gzip
  // precompression, immutable hashed-asset caching, SPA fallback, real
  // 404s for missing hashed assets). Deliberately NOT imported from that
  // file — importing src/server/server.ts would run ITS module-top-level
  // side effects (its own Bun.serve + opening the LEDGER's database) as an
  // unwanted side effect of this file's own import.
  // ────────────────────────────────────────────────────────────────────
  const distDir = join(process.cwd(), "dist", "slips-client");
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) {
    console.error(`[fatal] missing ${indexPath}. Run \`bun run build\` first.`);
    process.exit(1);
  }

  const server = Bun.serve({
    port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") return healthz();
      if (url.pathname.startsWith("/slips-api/")) return apiFetch(req);
      if (url.pathname.startsWith("/slips-internal/")) return internalFetch(req);

      const filePath = url.pathname === "/" ? indexPath : join(distDir, url.pathname);
      if (!filePath.startsWith(distDir)) return new Response("nope", { status: 400 });

      const f = Bun.file(filePath);
      if (await f.exists()) {
        const immutable = /-[a-z0-9]{6,}\.[a-z.]+$/i.test(url.pathname);
        const headers: Record<string, string> = {
          "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          vary: "Accept-Encoding",
        };
        const gz = Bun.file(filePath + ".gz");
        if (/gzip/i.test(req.headers.get("accept-encoding") ?? "") && (await gz.exists())) {
          headers["content-encoding"] = "gzip";
          headers["content-type"] = f.type;
          return new Response(gz, { headers });
        }
        return new Response(f, { headers });
      }

      if (ASSET_PATH_RE.test(url.pathname)) {
        return new Response("not found", { status: 404 });
      }

      return new Response(Bun.file(indexPath), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    },
  });
  console.log(`▶︎ ส่งสลิป http://localhost:${server.port} (prod)`);
} else {
  // ────────────────────────────────────────────────────────────────────
  // Dev: HTML import lets Bun bundle the React client on the fly with HMR
  // — same pattern as src/server/server.ts's own dev branch.
  // ────────────────────────────────────────────────────────────────────
  const indexHtml = (await import("./client/index.html")).default;
  const server = Bun.serve({
    port,
    development: true,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    routes: {
      "/": indexHtml,
      "/:property": indexHtml,
      "/:property/day/:date": indexHtml,
      "/healthz": healthz,
      "/slips-api/*": (req) => apiFetch(req),
      "/slips-internal/*": (req) => internalFetch(req),
    },
  });
  console.log(`▶︎ ส่งสลิป http://localhost:${server.port} (dev)`);
}
