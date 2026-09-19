# Claude Code Instructions — Expense Ledger (`hf-ledgers/expense-ledger`)

**This app lives in a monorepo.** It was its own repo until 2026-08-13, when
it was absorbed into `hf-ledgers` as a git subtree (full history preserved).
Every path in this file is relative to `expense-ledger/` unless it says
otherwise. Read the repo root's `CLAUDE.md` too — it carries the monorepo
map, the rules for `packages/shared`, and the current state of CI and
deploys, all of which apply here.

What that means in practice:

- **This app has its own `package.json`, lockfile, `tsconfig.json` and
  `node_modules`.** `bun install` at the repo root does NOT cover it — run
  `bun install`, `bun run typecheck` and `bun run build` from
  `expense-ledger/`. The root `bun test` does walk this app's tests.
- **`@shared/*` is `../packages/shared/src`** — `date.ts`, `money.ts`,
  `textAmount.ts`, `access.ts` (the CF Access verifier) and `shell.ts` (the
  estate band's per-identity `data-property` hint) are ONE copy,
  shared with the income ledger. `src/shared/` still exists here for
  genuinely app-local types (`apTypes.ts`, `categories.ts`, `types.ts`).
  Changing anything under `packages/shared/` is a contract change for the
  income ledger too; run its suite, not just this one.
- **Workflows must live in the repo root's `.github/workflows/`.** GitHub
  does not load workflows from a subdirectory. This app's engine mirror
  workflow is there as `expense-engine-mirror.yml`; its old `ci.yml` and
  `deploy.yml` were dropped in the merge and replaced by the root's per-app
  `ci.yml` / `deploy.yml`, which path-filter `expense-ledger/**` (and
  `packages/**`) to this app's jobs.
- **The Dockerfile builds from the MONOREPO ROOT**, not from this directory,
  because it has to reach `packages/`. See its header for the exact
  invocation.

## What this is

HF Hotel's company expense ledger. A custom Bun frontend
(`src/server/server.ts` + a client the frontend implementation agent builds
out under `src/client/`) talks to a headless
[ezBookkeeping](https://ezbookkeeping.mayswind.net/) engine
(`expense-ledger-engine`, `mayswind/ezbookkeeping` mirrored to our own GHCR
and pinned by digest) over the compose `default` network. The engine owns
accounts, categories, transactions, and receipt photo storage — every baht
still lands there, reached only through `src/server/engine.ts`. **This repo's
server never talks to a database of its own, with ONE documented exception:**
the AP register ("ค้างจ่าย" tab)'s own bun:sqlite store
(`src/server/apStore.ts`) for creditor/due-date/payment-history bookkeeping
ezBookkeeping has no concept of — see the "AP register storage exception"
hard rule below before touching it or assuming the "engine-only" rule is
absolute elsewhere.

Stack: Bun runtime, 2-stage `oven/bun` Dockerfile, forced-command SSH deploy
to evergreen (same pattern as the income ledger / `hf-erp-portal` /
`room-daily-reporter`).

## Identity table

| Item | Value |
|---|---|
| Hostname | `expense.thehfhotel.org` |
| Host port (frontend) | `4050` |
| Engine host port | `127.0.0.1:4051` (loopback only) |
| Frontend container | `expense-ledger` (internal `:3000`) |
| Engine container | `expense-ledger-engine` (internal `:8080`) |
| Volume | `expense_data:/ezbookkeeping/data` (engine) |
| Volume | `expense_ap:/app/data` (frontend — AP register sqlite only) |
| Frontend image | `ghcr.io/thehfhotel/expense-ledger` |
| Engine image | `ghcr.io/thehfhotel/ezbookkeeping` (pinned by digest) |

See README.md for the full first-boot / upgrade / backup procedures.

## Commands

All of these run from `expense-ledger/`, not the repo root:

```sh
bun install            # this app's own lockfile — the root install does not cover it
bun run dev          # Bun --hot on http://localhost:3000
bun run build         # build.ts -> dist/client
bun run start          # NODE_ENV=production bun src/server/server.ts
bun run typecheck      # tsc --noEmit (resolves @shared/* via ../packages/shared/src)
bun test               # this app only; the root `bun test` covers it plus the rest
```

CI is the repo root's `.github/workflows/ci.yml`: the dependency-free guard
plus one bun-ci call per app (install, typecheck, test, build), on every push
and PR, never path-filtered. The root's `deploy.yml` deploys this app on a
push to `main` that touches `expense-ledger/**`, `packages/**`, the root
`.dockerignore`, or the workflow itself — gated on this app's own bun-ci run.
Its image builds from the MONOREPO ROOT context with
`-f expense-ledger/Dockerfile`, and it ships
`expense-ledger/docker-compose.yml`. See the root `CLAUDE.md`.

## Hard rules

- **`GET /healthz` stays engine-free and DB-free.** It lives outside any
  `/api` prefix, needs no auth, and must respond even if
  `expense-ledger-engine` is briefly unavailable — the deploy shim only
  retries a bounded number of times. Never make it call out to the engine,
  and never make it touch the AP register's sqlite store either (see the
  next rule) — both dependencies are lazy-opened on first actual use, never
  at boot. See `src/server/server.ts`.
- **AP register storage exception.** Ledger data (every transaction, every
  baht) stays engine-only, reached solely through `src/server/engine.ts` —
  that rule is unchanged. The ONE sanctioned exception is the AP register
  ("ค้างจ่าย" tab)'s own bun:sqlite database (`src/server/apStore.ts`,
  `AP_DB_PATH`, default `/app/data/ap.db`) on its own `expense_ap` volume
  mounted on the FRONTEND container — separate from `expense_data` (the
  engine's volume) — because the register tracks creditor/due-date/payment-
  history state ezBookkeeping has no concept of, while every payment still
  posts as a real ledger transaction via `engine.ts`. The store is
  lazy-opened on the first `/api/ap/*` request (a missing volume directory is
  created on demand); `GET /healthz` and server boot never touch it — see
  the rule above. This same database also holds the analytics-push outbox
  table (`_analytics_pending_pushes`, `src/server/analytics-push.ts`) —
  operational state, not AP register data, but kept in this one file rather
  than a database of its own — which means that when `ANALYTICS_URL` /
  `ANALYTICS_TOKEN` are set, this database is lazy-opened on the first
  enqueue from ANY mutating route (not just `/api/ap/*`), or from
  `startAnalyticsPush()`'s own enqueue of the last three months — which
  `server.ts` calls explicitly from its boot path only AFTER the listener is
  up, never merely by importing `analytics-push.ts` or `server.ts`, so
  `bun test` and a plain module import stay database-free. With neither env
  var set the outbox stays fully inert. Receipt syncing also uses this same
  AP database for `_reimbursement_receipts` (source identity and payment
  attempt journal) and `_reimbursement_meta` (fixed activation time, status).
  `getApDbForReimbursement()` exposes it only to `reimbursement-sync.ts`.
  Payroll uses `_payroll_runs` and `_payroll_meta` in the same AP database,
  exposed through `getApDbForPayroll()`. It keeps one net payroll batch per
  source request and settles only after verified bank success. All imported
  payroll and reimbursement rows share the AP write lock and cannot be edited
  or paid manually through the ledger. Both workers must stay single-process.
  A historical payroll backfill pins an explicit approved aggregate manifest in
  `_payroll_meta` and keeps the automatic cutoff unchanged. Every later snapshot
  checks the union of new submissions and those exact bank-confirmed historical
  runs; never widen the cutoff or run an out-of-process import to bypass this.
  Synced financial rows use the existing AP CRUD; settlement posts through
  `engine.ts`. The worker starts after the listener and is disabled unless
  all three `REIMBURSEMENT_*` settings are present. Never run multiple workers
  against this volume: receipt syncing and manual AP writes share one process
  lock. See README's receipt-sync section for recovery and activation. Do
  not add a second database-of-its-own for anything else without amending
  this rule first. Backed up nightly alongside `expense_ap` — see
  README.md's "Backup" section.
- **ต้นทุน is recognised in the งวด its วันที่ลงบิล falls in** (owner
  decision, 2026-09-19 — CONTEXT.md's glossary and
  `docs/adr/0001-cost-recognised-in-its-period.md`). One editable date per
  bill (`ap_row.bill_date`, `ApRow.billDate`) whose MONTH is the งวด;
  `filed_date` (วันที่ยื่นบิล) is record metadata and must never be used as a
  cost's date again, and ค้างจ่าย stays a payment state, never a second
  cost. `src/shared/rollup.ts` keys `filed`/`filedByEntity`/`filedBySource`
  on วันที่ลงบิล and stamps `basis: "bill-date"` on every payload — that
  field is LOCKED CONTRACT with hf-analytics: `"bill-date"` means งวด,
  `"filed-month"` means the old filing-month meaning, and an ABSENT basis
  must be read as `"filed-month"` and said so, never guessed. Any route that
  changes a row enqueues the row's BILL-DATE month (an edit that moves the
  date enqueues both the old and the new one — including a source correction
  in `payroll-sync.ts` / `reimbursement-sync.ts`, where a changed period or
  purchase date moves วันที่ลงบิล), never the clock's month.
- **Deploy hf-data's migration 027 BEFORE this app — the order is not
  free.** An un-migrated receiver accepts a bill-date payload (its
  `ingestSchema` is non-strict, so nothing 4xx's and nothing drops from the
  outbox) but silently discards `basis`, leaving งวด figures stored under a
  NULL basis — which hf-mcp reads as filed-month and SAYS SO out loud. That
  is a confidently wrong label on a งวด, precisely what the three-state
  contract exists to prevent. In the right order nothing needs a backfill:
  this app's boot (`startAnalyticsPush`) enqueues the current month and the
  two before it, which is the register's whole span, so every month is
  restated with its basis on the first deploy.
- **UI language is Thai only**, matching the income ledger's convention for
  this estate's front-of-house tools. No `name_en` field, no English-first
  copy.
- **No CSP header.** The estate shell script (`hf-bar.js`, served from
  `erp.thehfhotel.org/shell/*`) must load unrestricted, same rule as every
  other estate app under the erp shell.
- **The engine must never be reachable off-host.** Its compose service joins
  only the `default` network (never `shared-nginx`), and its host-port
  mapping is `127.0.0.1:4051:8080` — loopback only. Do not add a public
  hostname, do not join it to `shared-nginx`, do not widen that port
  mapping.
- **`ENGINE_API_TOKEN` is a server-only secret.** The frontend's
  `src/server/engine.ts` is the ONLY thing that may hold or send it.  Never
  forward it to the browser (no embedding in client JS, no proxying it
  through a client-readable header, no logging it). Every engine call must
  originate server-side.
- **Never commit secrets.** `.env` is gitignored; `.env.example` carries
  empty placeholders only. Runtime env (`ENGINE_API_TOKEN`, `ACCESS_AUD`,
  `ACCESS_TEAM_DOMAIN`, `EBK_SECURITY_SECRET_KEY`) is materialized into the
  container's `.env` by the deploy workflow from GitHub secrets — which are
  app-prefixed on this shared repo (`EXPENSE_ACCESS_AUD`,
  `EXPENSE_ENGINE_API_TOKEN`, `EXPENSE_EBK_SECURITY_SECRET_KEY`; only
  `ACCESS_TEAM_DOMAIN` is shared with the income ledger, because it is
  genuinely the same Cloudflare Access team domain). Reference
  locations, never values, in this repo. **`ACCESS_AUD` must be non-empty in
  production**: `packages/shared/src/access.ts` fails CLOSED without it, so
  an empty value 401s every request rather than accepting any token from the
  team domain. That is deliberate — on the LAN path this container's
  `0.0.0.0:4050` mapping is reachable without going through Cloudflare at
  all, and the JWT check is the only gate there is.
- **This repo is public** (`hf-ledgers`, and it was public before the merge
  too). Keep LAN IPs, internal network topology, and `hostnames.json`-level
  Cloudflare details out of it — that context lives in the (private)
  `hf-erp` repo, which owns Cloudflare-as-code for the whole estate. Public
  hostname and container names are fine to state.
- **No emojis anywhere** — UI text, code, comments, commit messages.
- **The engine image is pinned by digest, never a moving tag.** Bumping it
  is a deliberate action via the repo root's
  `.github/workflows/expense-engine-mirror.yml` — see
  README.md "Upgrade procedure". Don't hand-edit the digest without running
  that workflow first (a digest that was never actually mirrored to our GHCR
  will fail to pull).
- **`github.com/thehfhotel/ezbookkeeping` (the source fork) is insurance
  only.** We consume upstream's published image via our GHCR mirror; we do
  not build images from the fork under normal operation. Only fall back to
  building from it if upstream's Docker Hub image disappears.
