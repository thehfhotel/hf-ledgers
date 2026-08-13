#!/usr/bin/env bash
# packages/shared must import nothing but node:/bun: builtins and its own
# relative modules.
#
# Why this is a CI gate and not a convention: packages/shared is imported by
# BOTH apps through a tsconfig path alias, but the two apps keep independent
# package.json files and independent lockfiles. A third-party import added
# here would resolve fine in whichever app happens to have that package
# installed and fail in the other — and because the apps ship as separate
# containers with `bun install --production`, that failure surfaces at
# container start in production, not at build time. Same failure class the
# Dockerfiles' COPY comments warn about, from the opposite direction.
#
# Run from the repo root. Also run by .github/workflows/ci.yml.

set -euo pipefail

cd "$(dirname "$0")/.."

SHARED_DIR="packages/shared/src"

if [[ ! -d "$SHARED_DIR" ]]; then
  echo "error: $SHARED_DIR does not exist (run me from the repo root)" >&2
  exit 1
fi

# Every module specifier in the tree: static `from "x"`, bare side-effect
# `import "x"`, dynamic `import("x")`, and `require("x")`. Then drop the two
# allowed shapes — relative paths ("./x", "../x") and node:/bun: builtins —
# and anything left is a dependency.
offenders=$(
  grep -rnoE '(from|import|require)[[:space:]]*\(?[[:space:]]*"[^"]+"' "$SHARED_DIR" \
    | grep -vE '"\.{1,2}/' \
    | grep -vE '"(node|bun):' \
  || true
)

if [[ -n "$offenders" ]]; then
  echo "$offenders" >&2
  echo >&2
  echo "error: packages/shared must stay dependency-free — the imports above are neither relative nor node:/bun: builtins." >&2
  echo "       See packages/shared/README.md. If a shared module genuinely needs a package, it does not belong in packages/shared." >&2
  exit 1
fi

echo "packages/shared is dependency-free (relative + node:/bun: imports only)"
