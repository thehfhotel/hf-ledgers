# Claude Code Instructions — HF Ledgers (`hf-ledgers`)

This repo is a two-app monorepo. **This file is the income ledger's** — it is
the host app, at the repo root — and it also carries the map below. The
expense ledger has its own `expense-ledger/CLAUDE.md`; read that one before
touching anything under `expense-ledger/`.

## Monorepo map

| Path | What | Notes |
|---|---|---|
| `src/`, `scripts/`, `docs/` | **income ledger** (สรุปรายรับ-รายจ่าย) + ส่งสลิป | The host app. Everything in the rest of THIS file is about it. |
| `expense-ledger/` | **expense ledger** + its ezBookkeeping engine | Absorbed 2026-08-13 as a git subtree, full history preserved. Own `package.json`, own lockfile, own `tsconfig.json`, own `CLAUDE.md`. |
| `packages/shared/` | the modules BOTH apps import | `date.ts`, `money.ts`, `textAmount.ts`, `access.ts` (CF Access verifier), `shell.ts` (the estate band's per-identity `data-property` hint) + their tests. Imported as `@shared/*`. See `packages/shared/README.md`. |
| `.github/workflows/` | CI for the whole repo | GitHub only runs workflows from HERE — a workflow under `expense-ledger/` is a dead file. |

Why one repo: these two apps are one bookkeeping surface for one office — the
same people, the same Bangkok calendar day, the same satang-integer money
rules. Four source files had already been copy-pasted between the two repos
with a "must never drift" comment, and had drifted in both directions within
the hour. See hf-erp `docs/adr/0006-repos-group-by-change-not-audience.md`.

**Estate task board: `hf-tasks`.** Cross-repo work (consolidation waves,
CI restructure, follow-ups this merge deliberately deferred) is tracked in
`tasks/consolidation.md` there, not here. Check it before starting anything
that touches deploys, workflows or repo layout, and update it in the same
session if you close or unblock something.

## Working across the two apps

- `packages/shared` is dependency-free by rule — nothing but `node:`/`bun:`
  builtins and its own relative imports. `scripts/check-shared-dependency-free.sh`
  enforces it in CI. A third-party import there would resolve in whichever
  app happens to have the package and crash-loop the other in production.
- **Changing anything in `packages/shared` is a contract change for BOTH
  apps.** Run `bun test` at the root (it walks the whole tree — both apps
  and shared) plus `bun run typecheck` in each app. Never assume the app you
  weren't working in is fine.
- The two apps do NOT share a lockfile or `node_modules`. `bun install` at
  the root covers the income ledger; `expense-ledger/` needs its own.

## What this is (the income ledger)

สรุปรายรับ-รายจ่าย — a daily income + expense ledger for HF Hotel front
desk. Digitizes the paper daily income summary (income by tender category:
ค่าห้องเงินสด, บัตรเครดิต/กสิกร, บัตรเครดิต ICBC, โอน/กสิกร, โอน ICBC,
เว็ปไซด์, บาร์น้ำ…), adds itemized daily expenses, exports a clean JPEG
day report the user shares onward (LINE) themselves, and can move a day's
bookings and other-income to the other property (merge into the
destination; the day sheet itself is not moved) via `POST
/:property/day/:date/move`. Front desk enters the data.

**The ดึงข้อมูล button (`POST /:property/day/:date/pull-from-pms`,
`src/server/pms-prefill.ts`) prefills the bookings page from the PMS
payment ledger.** Insert-only and idempotent: a payment already on that
`(property, date)` by `pms_ref` is skipped, an existing row is never
updated — hand edits stay sacred, pressing it twice is harmless. Dark
unless both `PMS_DB_URL_HF` and `PMS_DB_URL_HFVILLE` are set (each
property is independently dark/live on its own env var). The PMS never
records the acquiring bank, so credit/transfer amounts are reported back
as "unplaced" for the operator to file into the right bank column by
hand — never guessed, never written to a bank-specific tender column.

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
`totals.ts` and `bookings.ts` are this app's locked shared types/helpers;
`money.ts`, `date.ts`, `textAmount.ts` and the CF Access verifier now live in
`packages/shared/` and are locked for BOTH apps. Changing any of these is a
contract change, not a routine edit — and for the `packages/shared` ones it
is a contract change the expense ledger also has to survive.

## Identity table

| Item | Value |
|---|---|
| Hostname | `income.thehfhotel.org` |
| Host port | `4040` |
| Container | `income-ledger` (internal `:3000`) |
| Volume | `ledger_data:/app/data`, DB `/app/data/ledger.db` |
| Image | `ghcr.io/thehfhotel/income-ledger` (+`:buildcache`) — image and container names deliberately keep the old app name after the repo rename to `hf-ledgers`; they are decoupled from the repo slug and renaming them would mean a prod cutover for no benefit |
| Portal module | `finance`, tool id `income-ledger` |

## Commands

```sh
bun install
bun run dev          # Bun --hot on http://localhost:3000
bun run build         # scripts/build.ts -> dist/client
bun run start          # NODE_ENV=production bun src/server/server.ts
bun run typecheck      # tsc --noEmit
bun test               # walks the WHOLE monorepo: this app, packages/shared,
                       # and expense-ledger/ — currently 1318 across 56 files
./scripts/check-shared-dependency-free.sh   # packages/shared has no deps
```

`bun test` at the root is deliberately not scoped to `src/` — both apps
import `packages/shared`, so the run that matters is the one that proves both.
`expense-ledger/` still needs its own `bun install` and its own
`bun run typecheck`/`bun run build` (separate lockfile, separate tsconfig).

CI (`.github/workflows/ci.yml`) runs the dependency-free guard plus one
`estate-ci` bun-ci call per app — install, typecheck, test, build in each —
on every push and pull request, never path-filtered, because a
`packages/shared` change has to prove both apps.

`.github/workflows/deploy.yml` deploys on push to `main`, path-filtered per
app (root paths -> income, `expense-ledger/**` -> expense, `packages/**` ->
both), each deploy gated on that app's own bun-ci run and on the shared
guard. Both call `thehfhotel/estate-ci`'s reusable workflows at a pinned SHA;
the app-specific secrets are prefixed `INCOME_*` / `EXPENSE_*` because
GitHub Environments cannot be used from a reusable-workflow caller (the
reasoning is in the workflow header). `expense-engine-mirror.yml` stays
manual-dispatch only and must never gain an automatic trigger.

Shared pure logic (`src/shared/totals.ts`, `bookings.ts`, and everything in
`packages/shared/`) is unit-tested; `src/server/server.test.ts` drives `api.handle()` against
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
  Convert to/from baht ONLY at the UI edge, via `@shared/money.ts`
  (`packages/shared/src/money.ts` — `formatSatang`, `parseAmountToSatang`).
  Never do float baht arithmetic server-side or in totals.
- **Business dates are Bangkok calendar strings `YYYY-MM-DD`**
  (`todayBangkok()` in `@shared/date.ts`), displayed in Buddhist Era. Never
  use the server's or browser's own local date for "today". `isValidIso()`
  rejects impossible calendar dates (`2026-06-99`, `2026-02-31`), not just
  the wrong shape — this app keys storage by the literal date string, so a
  rolled-over date would persist a day sheet that aggregates under one month
  and displays as another.
- **No emojis anywhere** — UI text, code, comments, commit messages.
- **A new top-level directory under `src/` needs no Dockerfile change** —
  the Dockerfile's `COPY src ./src` already copies everything. A new
  import path OUTSIDE `src/`, `scripts/` or `packages/` DOES need a
  Dockerfile `COPY` added, in both the build and runtime stages (a missed
  one crash-loops prod at container start, not at build time — verify
  working before every deploy). `packages/` is copied explicitly for exactly
  this reason: `@shared/*` resolves outside `src/`.
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
  (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `ACCESS_AUD_SLIPS`, which
  `docker-compose.yml` maps onto the slips container's own `ACCESS_AUD`) is
  materialized into the container's `.env` by the deploy workflow from
  GitHub secrets (`INCOME_ACCESS_AUD`, `INCOME_ACCESS_AUD_SLIPS`, and the
  shared `ACCESS_TEAM_DOMAIN` — the workflow renders them into the
  `env_payload` block) — reference locations, never values, in this repo.
  **`ACCESS_AUD` and
  `ACCESS_AUD_SLIPS` must be non-empty in production**: the verifier fails
  CLOSED without them, by design — an empty one 401s every request rather
  than accepting any token from the team domain. `PORTAL_DIRECTORY_URL`,
  `PORTAL_DIRECTORY_TOKEN`, and `PROTECTED_MANAGER` (with
  `src/server/directory-client.ts`) are retired — the app no longer
  depends on the HF portal being reachable at runtime; `ACCESS_TEAM_DOMAIN`
  and `ACCESS_AUD` remain, still required for JWT verification.
- **This repo is public**, and now holds both ledgers, so the rule covers
  everything under `expense-ledger/` too. Keep LAN IPs and internal network
  topology out of it; that context lives in the (private) `hf-erp` repo,
  which owns Cloudflare-as-code for the whole estate. Public hostnames and
  container names are fine to state.
