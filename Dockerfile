# syntax=docker/dockerfile:1.7
# ────────────────────────────────────────────────────────────────────────────
# Build stage: install deps and pre-bundle the React client.
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS build

WORKDIR /app

# Install all deps (including dev) for the build step.
COPY package.json bun.lock* bunfig.toml ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN bun run build

# ────────────────────────────────────────────────────────────────────────────
# Runtime stage: production-only deps + bundled assets + server source.
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# bun:sqlite is built in — production deps only.
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY tsconfig.json ./
# Copies ALL of src/ (server + client + shared + slips), not a subset. A new
# top-level src/ directory needs no Dockerfile change as a result — but a
# new import path OUTSIDE src/ (or scripts/) does. See CLAUDE.md. This is
# ALSO how ส่งสลิป (src/slips/, Wave 2, docs/plan-audit-hub-slips.md) ships:
# same image, same COPY, a different CMD (see docker-compose.yml's hf-slips
# service) — verified this needed no Dockerfile change here.
COPY src ./src
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

# SQLite lives on a mounted volume. /app/slips-data is ส่งสลิป's OWN volume
# (a SEPARATE container/volume — see docker-compose.yml's hf-slips service
# — never shares ledger_data); harmless to create here even though the
# ledger's own CMD never touches it.
RUN mkdir -p /app/data /app/slips-data
VOLUME ["/app/data", "/app/slips-data"]

EXPOSE 3000

# /healthz is DB-free by design (see src/server/server.ts) so this stays
# fast even if the DB is briefly unavailable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["bun", "src/server/server.ts"]
