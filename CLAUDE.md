# Claude Code Instructions — Income Ledger (`income-ledger`)

## What this is

สรุปรายรับ-รายจ่าย — a daily income + expense ledger for HF Hotel front
desk. Digitizes the paper daily income summary (income by tender category:
ค่าห้องเงินสด, บัตรเครดิต/กสิกร, บัตรเครดิต ICBC, โอน/กสิกร, โอน ICBC,
เว็ปไซด์, บาร์น้ำ…), adds itemized daily expenses, exports a clean JPEG
day report the user shares onward (LINE) themselves, and can move a day's
bookings and other-income to the other property (merge into the
destination; the day sheet itself is not moved) via `POST
/:property/day/:date/move`. Front desk enters the data.

**No in-app roles.** Cloudflare Access is the only gate on who reaches
income.thehfhotel.org — everyone it admits, including the office-1 and
reception kiosk identities, can use every feature, category list included.
A second, in-app permission tier would have permanently locked out those
shared kiosk terminals — they are place identities and can never hold a
manager role — which is the work the front desk actually does. What
survived: authentication (401 without a verified identity), the dev
bypass under `NODE_ENV=development` + `DEV_USER`, month-close as a
data-state lock returning 409, and the
created_by/updated_by/verified_by/closed_by provenance columns.

Stack: Bun + Elysia (`prefix:"/api"`, Typebox) mounted in `Bun.serve`,
serving the built React SPA + `/healthz`; `bun:sqlite` WAL with inline
`CREATE TABLE IF NOT EXISTS` DDL; Vite-less client built by
`scripts/build.ts` (Bun's HTML bundler + Tailwind v4 plugin); 2-stage
`oven/bun` Dockerfile; forced-command SSH deploy to evergreen (same pattern
as `hf-erp-portal` / `room-daily-reporter`).

**The contract of record is `src/shared/api.md`** — every endpoint, its
body shape, auth level, bounds, and error shape. `src/shared/types.ts`,
`money.ts`, `totals.ts`, `date.ts` are the locked shared types/helpers.
Changing any of these is a contract change, not a routine edit.

## Identity table

| Item | Value |
|---|---|
| Hostname | `income.thehfhotel.org` |
| Host port | `4040` |
| Container | `income-ledger` (internal `:3000`) |
| Volume | `ledger_data:/app/data`, DB `/app/data/ledger.db` |
| Image | `ghcr.io/thehfhotel/income-ledger` (+`:buildcache`) |
| Portal module | `finance`, tool id `income-ledger` |

## Commands

```sh
bun install
bun run dev          # Bun --hot on http://localhost:3000
bun run build         # scripts/build.ts -> dist/client
bun run start          # NODE_ENV=production bun src/server/server.ts
bun run typecheck      # tsc --noEmit
bun test               # 271 tests across 14 files
```

CI runs typecheck, `bun test`, then build — in that order, so broken code cannot
reach prod. Shared pure logic (`totals.ts`, `bookings.ts`, `textAmount.ts`) is
unit-tested; `src/server/server.test.ts` drives `api.handle()` against
`DB_PATH=:memory:` with the dev auth bypass (env must be set BEFORE importing the
server module, since `db.ts` opens the DB and migrates at import time);
`scripts/import-xls/*.test.ts` covers the one-time Excel backfill.

One-time Excel import lives in `scripts/import-xls/` — dry-run by default,
`--apply` commits, and `xlsx` is a devDependency ON PURPOSE (never ship SheetJS in
the runtime image). It writes by copy-and-swap outside the app process, so a future
run bypasses any outbox: re-run the analytics backfill after importing.

## Hard rules

- **UI language is Thai only, on every screen including admin.** There is
  no `name_en` field anywhere in the data model or the UI. Don't add one.
- **Money = integer satang end to end** (`amount_satang INTEGER` in SQLite).
  Convert to/from baht ONLY at the UI edge, via `src/shared/money.ts`
  (`formatSatang`, `parseAmountToSatang`). Never do float baht arithmetic
  server-side or in totals.
- **Business dates are Bangkok calendar strings `YYYY-MM-DD`**
  (`todayBangkok()` in `src/shared/date.ts`), displayed in Buddhist Era.
  Never use the server's or browser's own local date for "today".
- **No emojis anywhere** — UI text, code, comments, commit messages.
- **A new top-level directory under `src/` needs no Dockerfile change** —
  the Dockerfile's `COPY src ./src` already copies everything. A new
  import path OUTSIDE `src/` or `scripts/` DOES need a Dockerfile `COPY`
  added, in both the build and runtime stages (a missed one crash-loops
  prod at container start, not at build time — verified working before
  every deploy).
- **No service worker / no PWA in v1.** Don't add `sw.js`, a
  `manifest.webmanifest`, or `serviceWorker.register()`. This was a
  deliberate call — RDR's service worker caused a CDN-cache firefight this
  app intentionally avoids.
- **No CSP header.** The erp shell script (`hf-bar.js`, loaded from
  `erp.thehfhotel.org/shell/*`) must load unrestricted.
- **`GET /healthz` stays DB-free.** It lives outside `/api`, needs no auth,
  and must respond even if the DB is briefly unavailable — the deploy shim
  only retries 15 times at 2s intervals.
- **Never commit secrets.** `.env` is gitignored. Runtime env
  (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) is materialized into the container's
  `.env` by `.github/workflows/deploy.yml` from GitHub secrets — reference
  locations, never values, in this repo. `PORTAL_DIRECTORY_URL`,
  `PORTAL_DIRECTORY_TOKEN`, and `PROTECTED_MANAGER` (with
  `src/server/directory-client.ts`) are retired — the app no longer
  depends on the HF portal being reachable at runtime; `ACCESS_TEAM_DOMAIN`
  and `ACCESS_AUD` remain, still required for JWT verification.
- **This repo is public.** Keep LAN IPs and internal network topology out
  of it; that context lives in the (private) `HF-erp` repo, which owns
  Cloudflare-as-code for the whole estate.
