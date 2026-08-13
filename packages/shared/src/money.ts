// Money = integer satang end to end (1 baht = 100 satang). SQL SUMs stay
// exact because nothing but this module ever converts to/from baht, and
// only at the UI edge. True of both ledgers: the income ledger's
// `amount_satang INTEGER` columns and the expense ledger's engine postings
// alike.

/** 298380 -> "2,983.80" */
export function formatSatang(satang: number): string {
  const baht = satang / 100;
  return baht.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Parse a user-typed baht amount ("2,983.80", "20", " 490.5 ") into satang.
 * Returns null for anything that isn't a valid non-negative amount with at
 * most 2 decimal places — including empty input. Callers treat null as
 * "clear this cell" or as a validation error, never as a coerced 0. A
 * client-side `?? 0` fallback on this return value is a bug: it turns a
 * clerk's typo into a silent zero.
 */
export function parseAmountToSatang(input: string): number | null {
  const trimmed = input.trim().replace(/,/g, "");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const baht = Number(trimmed);
  if (!Number.isFinite(baht)) return null;
  return Math.round(baht * 100);
}

/**
 * Whether `AmountInput` (components/AmountInput.tsx) should actually fire
 * `onCommit` for a blur that parsed to `parsed`, given the field's current
 * controlled `value`. Extracted as a pure function so this no-op decision
 * — subtle, previously wrong for one real case — is unit-testable without
 * a component-rendering harness (neither app ships one).
 *
 * Income cells and expense lines (`zeroIsMeaningful` false) treat a
 * committed 0 as equivalent to "empty" (the caller deletes the cell/row
 * rather than storing a literal 0 — see `parseAmountToSatang`'s doc), so
 * re-typing "0.00"/"0" into an already-empty field is a genuine no-op
 * there. `zeroIsMeaningful` callers (the cash-block override/adjustment
 * fields, `src/shared/types.ts` `CashBlockAmounts`/`CashAdjustmentAmounts`)
 * must NOT get that normalization: an explicit 0 is a real, distinct value
 * from "unset" there, so typing "0.00" into a previously-unset
 * `zeroIsMeaningful` field must always fire `onCommit(0)` — applying the
 * income-cell normalization made it compare equal to the unset `null`
 * baseline and silently skip the commit entirely (Opus money-review P5,
 * 2026-07-31).
 */
export function shouldCommitAmount(value: number | null, parsed: number | null, zeroIsMeaningful: boolean): boolean {
  const prevNormalized = value ?? null;
  const parsedNormalized = zeroIsMeaningful ? parsed : parsed === 0 ? null : parsed;
  return parsedNormalized !== prevNormalized;
}
