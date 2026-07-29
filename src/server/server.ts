import { Elysia } from "elysia";
import { existsSync } from "node:fs";
import { join } from "node:path";

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3000);

// Paths that look like a static asset (have a recognized file extension)
// must 404 when missing — never SPA-fallback them to index.html. Otherwise
// a stale client requesting a chunk purged by a newer deploy gets an HTML
// document served as JS/CSS, which fails silently instead of erroring
// cleanly.
const ASSET_PATH_RE = /\.(js|css|map|png|svg|woff2?)$/i;

// ── /api routes ────────────────────────────────────────────────────────
// Phase 0 stubs every endpoint from src/shared/api.md as 501. WP-A (owns
// src/server/** only) replaces each handler body with the real
// implementation; the method + path here IS the locked contract shape.
const notImplemented = ({ status }: { status: (code: number, body: unknown) => unknown }) =>
  status(501, { error: "not implemented" });

export const api = new Elysia({ prefix: "/api" })
  .get("/me", notImplemented) // 1
  .get("/:property/categories", notImplemented) // 2
  .post("/:property/categories", notImplemented) // 3 (mgr)
  .patch("/:property/categories/:id", notImplemented) // 4 (mgr)
  .post("/:property/categories/reorder", notImplemented) // 5 (mgr)
  .get("/:property/days", notImplemented) // 6
  .get("/:property/day/:date", notImplemented) // 7
  .put("/:property/day/:date/income/:categoryId", notImplemented) // 8
  .put("/:property/day/:date/note", notImplemented) // 9
  .post("/:property/day/:date/expenses", notImplemented) // 10
  .patch("/:property/expenses/:id", notImplemented) // 11
  .delete("/:property/expenses/:id", notImplemented); // 12

const apiFetch = (req: Request) => api.handle(req);

// GET /healthz lives OUTSIDE /api, needs no auth, and never touches the DB
// (the deploy shim only allows 15 attempts x 2s) — see src/shared/api.md.
const healthz = () => Response.json({ ok: true });

if (isProd) {
  // ────────────────────────────────────────────────────────────────────
  // Production: serve precompiled client from ./dist/client/
  // ────────────────────────────────────────────────────────────────────
  const distDir = join(process.cwd(), "dist", "client");
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) {
    console.error(`[fatal] missing ${indexPath}. Run \`bun run build\` first.`);
    process.exit(1);
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") return healthz();
      if (url.pathname.startsWith("/api/")) return apiFetch(req);

      // Try a real file in dist/client
      const filePath = url.pathname === "/" ? indexPath : join(distDir, url.pathname);
      // Prevent path traversal: ensure resolved file is inside distDir
      if (!filePath.startsWith(distDir)) return new Response("nope", { status: 400 });

      const f = Bun.file(filePath);
      if (await f.exists()) return new Response(f);

      // A missing path that looks like an asset (has a file extension) is a
      // real 404 — e.g. a stale client asking for a chunk a newer deploy
      // purged. Only HTML-ish navigations (no extension) get the SPA shell.
      if (ASSET_PATH_RE.test(url.pathname)) {
        return new Response("not found", { status: 404 });
      }

      // SPA fallback for /:property/day/:date, /:property/history, etc.
      return new Response(Bun.file(indexPath), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  console.log(`▶︎ http://localhost:${server.port} (prod)`);
} else {
  // ────────────────────────────────────────────────────────────────────
  // Dev: HTML import lets Bun bundle the React client on the fly with HMR.
  // The Tailwind plugin is registered through bunfig.toml's
  // [serve.static.plugins] (it cannot be globally preloaded).
  // ────────────────────────────────────────────────────────────────────
  const indexHtml = (await import("../client/index.html")).default;
  const server = Bun.serve({
    port,
    development: true,
    routes: {
      "/": indexHtml,
      "/:property/day/:date": indexHtml,
      "/:property/history": indexHtml,
      "/:property/categories": indexHtml,
      "/:property/report/:date": indexHtml,
      "/healthz": healthz,
      "/api/*": (req) => apiFetch(req),
    },
  });
  console.log(`▶︎ http://localhost:${server.port} (dev)`);
}
