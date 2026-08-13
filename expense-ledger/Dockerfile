# syntax=docker/dockerfile:1.7
#
# THE BUILD CONTEXT IS THE MONOREPO ROOT, NOT THIS DIRECTORY.
#
#     docker build -f expense-ledger/Dockerfile -t expense-ledger .
#
# It has to be, because this app imports packages/shared (the date/money/
# textAmount/access modules both ledgers share) through tsconfig.json's
# `@shared/*` alias, which points at `../packages/shared/src`. A build whose
# context is expense-ledger/ cannot see that directory, and the failure is
# the nasty kind the runtime-stage comment below warns about: the image
# builds green and the container crash-loops at start.
#
# The image mirrors the repo layout — /app/expense-ledger for this app,
# /app/packages for the shared modules — so the `../packages/...` alias
# resolves inside the container exactly as it does in the checkout.
#
# NOT YET EXERCISED BY A REAL BUILD. Both deploy workflows are parked/removed
# for the duration of the M3 merge (see the repo root's
# .github/workflows/deploy.yml.pre-hf-ledgers), so nothing has built this
# file since the context changed. The monorepo CI restructure step owns
# proving it: build it, run it, and confirm the AP register and the served
# client both come up before wiring it back to a deploy.

# ────────────────────────────────────────────────────────────────────────────
# Build stage: install deps and produce dist/client.
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS build

WORKDIR /app/expense-ledger

COPY expense-ledger/package.json expense-ledger/bun.lock* expense-ledger/bunfig.toml ./
RUN bun install --frozen-lockfile

COPY expense-ledger/tsconfig.json expense-ledger/build.ts ./
COPY expense-ledger/src ./src
COPY expense-ledger/scripts ./scripts
COPY packages /app/packages

RUN bun run build

# ────────────────────────────────────────────────────────────────────────────
# Runtime stage: production-only deps + built client + server source.
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime

WORKDIR /app/expense-ledger

ENV NODE_ENV=production \
    PORT=3000

COPY expense-ledger/package.json expense-ledger/bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY expense-ledger/tsconfig.json ./
# Copies ALL of src/ (server + client), not a subset — a new top-level src/
# directory needs no Dockerfile change as a result. A new import path
# OUTSIDE src/ (or scripts/, or the shared packages/ copied below) DOES need
# a Dockerfile `COPY` added, in both stages (a missed one crash-loops prod at
# container start, not at build time — verify working before every deploy).
COPY expense-ledger/src ./src
COPY expense-ledger/scripts ./scripts
COPY packages /app/packages
COPY --from=build /app/expense-ledger/dist ./dist

# The AP register's sqlite store is an ABSOLUTE path (AP_DB_PATH, default
# /app/data/ap.db, volume expense_ap:/app/data) and so is unaffected by this
# stage's WORKDIR. The served client is not: server.ts resolves dist/client
# from process.cwd(), which is the WORKDIR above.

EXPOSE 3000

# /healthz is DB- and engine-free by design (see src/server/server.ts) so
# this stays fast even if expense-ledger-engine is briefly unavailable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["bun", "src/server/server.ts"]
