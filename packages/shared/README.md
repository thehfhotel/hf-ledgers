# `packages/shared`

The modules both ledgers import. Not a published package and not a bun
workspace — the two apps resolve it through the `@shared/*` tsconfig path
alias (`tsconfig.json` at the repo root for the income app, and
`expense-ledger/tsconfig.json` for the expense app), which Bun honours at
runtime, at bundle time and in `tsc --noEmit`.

## Why it exists

`date.ts`, `money.ts` and `textAmount.ts` were copied from income-ledger into
expense-ledger on 2026-07-31 with a comment saying they must never drift, and
they drifted in both directions within the hour: expense hardened `isValidIso`
against impossible calendar dates and income never got the fix, while income
grew `timeBangkok`, `daysBetween` and `shouldCommitAmount` that expense never
got. The CF Access verifier drifted the same way and worse — expense wrote
down why an unset `ACCESS_AUD` was dangerous and left the code fail-open,
income implemented the fail-closed gate three days later and left a comment
saying the check was "never the only gate", which its own compose file
contradicts. One copy makes that class of drift structurally impossible.

## Hard rules

- **Dependency-free.** Nothing in here may import anything but `node:`/`bun:`
  builtins and its own relative modules. Two apps with two independent
  `package.json` files import these files directly; a third-party import here
  would resolve in whichever app happens to have that package installed and
  fail in the other, at runtime, in production.
  `scripts/check-shared-dependency-free.sh` enforces this in CI — run it
  locally before pushing.
- **Pure and platform-neutral.** No DOM, no `bun:sqlite`, no `process.env`
  reads outside `access.ts` (which is server-only by nature, as is `shell.ts`,
  which builds on it). These modules are imported by React client code that
  gets bundled for the browser — never import a server-only one from there.
- **Changing a signature here is a contract change for BOTH apps.** Run both
  suites — `bun test` at the root and `bun test` in `expense-ledger/` — not
  just the one you were working in.
- **Tests live beside the source here, not in the apps.** When a module moved
  in, its tests from both repos were unioned rather than chosen between:
  neither repo's suite was a superset of the other's.
