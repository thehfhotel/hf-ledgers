#!/usr/bin/env bash
# packages/shared must import nothing but node:/bun: builtins and its own
# relative modules.
#
# Why this is a CI gate and not a convention: packages/shared is imported by
# BOTH apps through a tsconfig path alias, but the two apps keep independent
# package.json files and independent lockfiles. A third-party import added
# here would resolve fine in whichever app happens to have that package
# installed and fail in the other — and because the apps ship as separate
# containers built with `bun install --production`, that failure surfaces at
# container start in production, not at build time. Same failure class the
# Dockerfiles' COPY comments warn about, from the opposite direction.
#
# Run from anywhere. Also run by .github/workflows/ci.yml, before any install,
# so it needs nothing but grep.

set -euo pipefail

cd "$(dirname "$0")/.."

SHARED_DIR="packages/shared/src"

if [[ ! -d "$SHARED_DIR" ]]; then
  echo "error: $SHARED_DIR does not exist" >&2
  exit 1
fi

# Matches every module-specifier form: static `from "x"`, bare side-effect
# `import "x"`, dynamic `import("x")`, and `require("x")`.
SPECIFIER='(from|import|require)[[:space:]]*\(?[[:space:]]*["'"'"'][^"'"'"']+["'"'"']'

offenders=""

while IFS= read -r hit; do
  # grep -rn output is file:line:content — peel off the two prefixes.
  content="${hit#*:}"
  content="${content#*:}"

  # Skip comment lines. Without this the guard cries wolf on its own modules'
  # documentation: shouldCommitAmount's doc contains the phrase
  #     a real, distinct value from "unset"
  # which the specifier pattern matches perfectly. A guard that fails on prose
  # gets switched off, so it only reads lines that could actually be code.
  trimmed="${content#"${content%%[![:space:]]*}"}"
  case "$trimmed" in
    '*'* | '//'* | '/*'*) continue ;;
  esac

  while IFS= read -r spec; do
    [[ -z "$spec" ]] && continue
    case "$spec" in
      ./* | ../* | node:* | bun:*) continue ;;
    esac
    offenders+="$hit"$'\n'
    break
  done < <(printf '%s\n' "$content" | grep -oE "$SPECIFIER" | sed -E 's/.*["'"'"']([^"'"'"']+)["'"'"']$/\1/')
done < <(grep -rnE "$SPECIFIER" "$SHARED_DIR" --include='*.ts' --include='*.tsx' || true)

if [[ -n "$offenders" ]]; then
  printf '%s' "$offenders" >&2
  echo >&2
  echo "error: packages/shared must stay dependency-free — the imports above are neither relative nor node:/bun: builtins." >&2
  echo "       See packages/shared/README.md. If a shared module genuinely needs a package, it does not belong in packages/shared." >&2
  exit 1
fi

echo "packages/shared is dependency-free (relative + node:/bun: imports only)"
