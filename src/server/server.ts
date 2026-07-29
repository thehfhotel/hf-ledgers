import { Elysia, t } from "elysia";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { identify } from "./auth.ts";
import {
  categoriesForDay,
  createCategory,
  createExpenseItem,
  deleteExpenseItem,
  getCategoryById,
  getExpenseById,
  getExpensesForDay,
  getIncomeForDay,
  getSheetDay,
  listCategories,
  listDaysWithData,
  reorderCategories,
  saveIncomeCell,
  setSheetDayNote,
  touchSheetDay,
  updateCategory,
  updateExpenseItem,
} from "./db.ts";
import { computeDayTotals } from "../shared/totals.ts";
import { isValidIso, isValidMonth } from "../shared/date.ts";
import {
  AMOUNT_SATANG_MAX,
  AMOUNT_SATANG_MIN,
  NAME_TH_MAX_LEN,
  NAME_TH_MIN_LEN,
  NOTE_MAX_LEN,
  isProperty,
} from "../shared/types.ts";
import type { DaySheet, DaySummary, Me } from "../shared/types.ts";

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3000);

// Paths that look like a static asset (have a recognized file extension)
// must 404 when missing — never SPA-fallback them to index.html. Otherwise
// a stale client requesting a chunk purged by a newer deploy gets an HTML
// document served as JS/CSS, which fails silently instead of erroring
// cleanly.
const ASSET_PATH_RE = /\.(js|css|map|png|svg|woff2?)$/i;

// ── validation helpers (bounds per src/shared/api.md) ────────────────────

function isValidAmount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= AMOUNT_SATANG_MIN && n <= AMOUNT_SATANG_MAX;
}

function isValidNote(n: unknown): n is string {
  return typeof n === "string" && n.length <= NOTE_MAX_LEN;
}

function isValidNameTh(n: unknown): n is string {
  return typeof n === "string" && n.length >= NAME_TH_MIN_LEN && n.length <= NAME_TH_MAX_LEN;
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

// ── /api routes ────────────────────────────────────────────────────────
// Every handler implements one endpoint from src/shared/api.md — the
// contract of record. Auth: a scoped derive resolves identity and a
// top-level onBeforeHandle 401s when absent; requireManager (via .guard())
// 403s non-managers on the three admin endpoints (create/patch/reorder
// categories). Static assets and GET /healthz (outside this group) are
// unguarded — Cloudflare Access fronts the whole host.

export const api = new Elysia({ prefix: "/api" })
  .derive(async ({ request }) => ({ identity: await identify(request) }))
  .onBeforeHandle(({ identity, status }) => {
    if (!identity) return status(401, { error: "unauthenticated" });
  })

  // 1. GET /api/me
  .get("/me", ({ identity }): Me => ({ email: identity!.email, isManager: identity!.isManager }))

  // 2. GET /api/:property/categories?includeArchived=1
  .get("/:property/categories", ({ params, query, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const includeArchived = query.includeArchived === "1";
    return { categories: listCategories(property, includeArchived) };
  })

  // 3-5. Manager-only category admin.
  .guard({}, (app) =>
    app
      .onBeforeHandle(({ identity, status }) => {
        if (!identity?.isManager) return status(403, { error: "manager only" });
      })
      // 3. POST /api/:property/categories
      .post(
        "/:property/categories",
        ({ params, body, status }) => {
          const { property } = params;
          if (!isProperty(property)) return status(400, { error: "invalid property" });
          if (body.kind !== "income" && body.kind !== "expense") {
            return status(400, { error: "invalid kind" });
          }
          if (!isValidNameTh(body.nameTh)) return status(400, { error: "invalid nameTh" });
          if (typeof body.isCash !== "boolean") return status(400, { error: "invalid isCash" });

          try {
            const category = createCategory(property, body.kind, body.nameTh, body.isCash);
            return status(201, category);
          } catch (err) {
            if (isUniqueConstraintError(err)) return status(409, { error: "duplicate category name" });
            throw err;
          }
        },
        { body: t.Object({ kind: t.String(), nameTh: t.String(), isCash: t.Boolean() }) },
      )

      // 4. PATCH /api/:property/categories/:id
      .patch(
        "/:property/categories/:id",
        ({ params, body, status }) => {
          const { property } = params;
          if (!isProperty(property)) return status(400, { error: "invalid property" });
          const id = Number(params.id);
          if (!Number.isInteger(id)) return status(404, { error: "category not found" });
          if (body.nameTh !== undefined && !isValidNameTh(body.nameTh)) {
            return status(400, { error: "invalid nameTh" });
          }
          if (body.isCash !== undefined && typeof body.isCash !== "boolean") {
            return status(400, { error: "invalid isCash" });
          }
          if (body.archived !== undefined && typeof body.archived !== "boolean") {
            return status(400, { error: "invalid archived" });
          }

          try {
            const updated = updateCategory(property, id, body);
            if (!updated) return status(404, { error: "category not found" });
            return updated;
          } catch (err) {
            if (isUniqueConstraintError(err)) return status(409, { error: "duplicate category name" });
            throw err;
          }
        },
        {
          body: t.Object({
            nameTh: t.Optional(t.String()),
            isCash: t.Optional(t.Boolean()),
            archived: t.Optional(t.Boolean()),
          }),
        },
      )

      // 5. POST /api/:property/categories/reorder
      .post(
        "/:property/categories/reorder",
        ({ params, body, status }) => {
          const { property } = params;
          if (!isProperty(property)) return status(400, { error: "invalid property" });
          if (body.kind !== "income" && body.kind !== "expense") {
            return status(400, { error: "invalid kind" });
          }
          if (!body.orderedIds.every((n) => Number.isInteger(n))) {
            return status(400, { error: "invalid orderedIds" });
          }
          const categories = reorderCategories(property, body.kind, body.orderedIds);
          if (categories === null) {
            return status(400, { error: "orderedIds must be exactly the active category ids" });
          }
          return { categories };
        },
        { body: t.Object({ kind: t.String(), orderedIds: t.Array(t.Number()) }) },
      ),
  )

  // 6. GET /api/:property/days?month=YYYY-MM
  .get("/:property/days", ({ params, query, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const month = query.month;
    if (typeof month !== "string" || !isValidMonth(month)) return status(400, { error: "invalid month" });

    const dates = listDaysWithData(property, month);
    const days: DaySummary[] = dates.map((date) => {
      const categories = categoriesForDay(property, date);
      const income = getIncomeForDay(property, date);
      const expenses = getExpensesForDay(property, date);
      const totals = computeDayTotals(categories, income, expenses);
      return {
        date,
        incomeSatang: totals.incomeSatang,
        expenseSatang: totals.expenseSatang,
        cashToDepositSatang: totals.cashToDepositSatang,
      };
    });
    return { month, days };
  })

  // 7. GET /api/:property/day/:date
  .get("/:property/day/:date", ({ params, status }) => {
    const { property, date } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidIso(date)) return status(400, { error: "invalid date" });

    const categories = categoriesForDay(property, date);
    const income = getIncomeForDay(property, date);
    const expenses = getExpensesForDay(property, date);
    const totals = computeDayTotals(categories, income, expenses);
    const sheetDay = getSheetDay(property, date);

    const sheet: DaySheet = {
      categories,
      income,
      expenses,
      note: sheetDay?.note ?? null,
      totals,
      updatedAt: sheetDay?.updatedAt ?? "",
      updatedBy: sheetDay?.updatedBy ?? "",
    };
    return sheet;
  })

  // 8. PUT /api/:property/day/:date/income/:categoryId
  .put(
    "/:property/day/:date/income/:categoryId",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      const categoryId = Number(params.categoryId);
      if (!Number.isInteger(categoryId)) return status(404, { error: "category not found" });
      const category = getCategoryById(property, categoryId);
      if (!category || category.kind !== "income") return status(404, { error: "category not found" });

      const { amountSatang, note } = body;
      if (amountSatang !== null && !isValidAmount(amountSatang)) {
        return status(400, { error: "invalid amountSatang" });
      }
      if (note !== undefined && note !== null && !isValidNote(note)) {
        return status(400, { error: "invalid note" });
      }

      const by = identity!.email;
      saveIncomeCell(property, date, categoryId, amountSatang, note ?? null, by);
      touchSheetDay(property, date, by);

      const incomeAfter = getIncomeForDay(property, date);
      const categoriesAfter = categoriesForDay(property, date);
      const expensesAfter = getExpensesForDay(property, date);
      const totals = computeDayTotals(categoriesAfter, incomeAfter, expensesAfter);
      return { income: incomeAfter, totals };
    },
    {
      body: t.Object({
        amountSatang: t.Union([t.Number(), t.Null()]),
        note: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  // 9. PUT /api/:property/day/:date/note
  .put(
    "/:property/day/:date/note",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      if (body.note !== null && !isValidNote(body.note)) return status(400, { error: "invalid note" });

      setSheetDayNote(property, date, body.note, identity!.email);
      return { note: body.note };
    },
    { body: t.Object({ note: t.Union([t.String(), t.Null()]) }) },
  )

  // 10. POST /api/:property/day/:date/expenses
  .post(
    "/:property/day/:date/expenses",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      const category = getCategoryById(property, body.categoryId);
      if (!category || category.kind !== "expense") return status(404, { error: "category not found" });
      if (
        !Number.isInteger(body.amountSatang) ||
        body.amountSatang <= 0 ||
        body.amountSatang > AMOUNT_SATANG_MAX
      ) {
        return status(400, { error: "invalid amountSatang" });
      }
      if (body.note !== undefined && body.note !== null && !isValidNote(body.note)) {
        return status(400, { error: "invalid note" });
      }

      const by = identity!.email;
      const item = createExpenseItem(property, date, body.categoryId, body.amountSatang, body.note ?? null, by);
      touchSheetDay(property, date, by);
      return status(201, item);
    },
    {
      body: t.Object({
        categoryId: t.Number(),
        amountSatang: t.Number(),
        note: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  // 11. PATCH /api/:property/expenses/:id
  .patch(
    "/:property/expenses/:id",
    ({ params, body, identity, status }) => {
      const { property } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      const id = Number(params.id);
      if (!Number.isInteger(id)) return status(404, { error: "expense not found" });
      const existing = getExpenseById(property, id);
      if (!existing) return status(404, { error: "expense not found" });

      if (body.categoryId !== undefined) {
        const category = getCategoryById(property, body.categoryId);
        if (!category || category.kind !== "expense") return status(404, { error: "category not found" });
      }
      if (body.amountSatang !== undefined) {
        if (
          !Number.isInteger(body.amountSatang) ||
          body.amountSatang <= 0 ||
          body.amountSatang > AMOUNT_SATANG_MAX
        ) {
          return status(400, { error: "invalid amountSatang" });
        }
      }
      if (body.note !== undefined && body.note !== null && !isValidNote(body.note)) {
        return status(400, { error: "invalid note" });
      }

      const by = identity!.email;
      const updated = updateExpenseItem(property, id, body, by);
      if (!updated) return status(404, { error: "expense not found" });
      touchSheetDay(property, updated.date, by);
      return updated;
    },
    {
      body: t.Object({
        categoryId: t.Optional(t.Number()),
        amountSatang: t.Optional(t.Number()),
        note: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  // 12. DELETE /api/:property/expenses/:id
  .delete("/:property/expenses/:id", ({ params, identity, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const id = Number(params.id);
    if (!Number.isInteger(id)) return status(404, { error: "expense not found" });
    const existing = getExpenseById(property, id);
    if (!existing) return status(404, { error: "expense not found" });

    deleteExpenseItem(property, id);
    touchSheetDay(property, existing.date, identity!.email);
    return status(204);
  });

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
