import { useRef, useState } from "react";
import { formatSatang, parseAmountToSatang, shouldCommitAmount } from "@shared/money.ts";

type SaveState = "idle" | "saving" | "saved" | "error";

interface Props {
  /** Current committed value in satang, or null when the cell is empty. */
  value: number | null;
  /**
   * Called on blur with the parsed satang value (or null when the field was
   * cleared/invalid). Throw to reject the change — AmountInput shows the
   * error mark and, since `value` is controlled by the caller, reverts to
   * whatever the caller kept as the committed value.
   */
  onCommit: (satang: number | null) => void | Promise<void>;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Income cells and expense lines treat a committed 0 as "empty" (the
   * caller deletes the cell/row rather than storing a literal 0), so the
   * default blanks the field to the placeholder for `value === 0` too.
   * Cash-block override fields (src/shared/types.ts CashBlockAmounts) are
   * different: an explicit override of exactly 0 is a real, distinct value
   * from "no override" (null), and MUST render as "0.00", not fall back to
   * the placeholder ghost text — a manager who zeroed out a component
   * needs to see that it stuck, not something indistinguishable from an
   * empty/untouched field. Set true for those callers only.
   */
  zeroIsMeaningful?: boolean;
}

/**
 * Money input for income cells and expense-line amounts: inputmode="decimal",
 * right-aligned tabular-nums, save-on-blur. Parses via the shared
 * parseAmountToSatang, displays via the shared formatSatang — per
 * src/shared/api.md, money is integer satang end to end and this is the only
 * place on this page that converts to/from baht text.
 *
 * While focused the field is an uncontrolled `draft` (plain "1234.50", no
 * thousands separators — easier to type/edit) so the formatted display never
 * fights the user mid-keystroke. On blur it reformats via formatSatang and
 * fires onCommit; if the caller doesn't update `value` (rejected or failed),
 * the field simply reverts to the last-committed value on the next render.
 */
export function AmountInput({
  value,
  onCommit,
  ariaLabel,
  placeholder = "0.00",
  disabled,
  zeroIsMeaningful,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const zeroIsVisible = (v: number) => zeroIsMeaningful || v !== 0;

  const shown = editing ? draft : value != null && zeroIsVisible(value) ? formatSatang(value) : "";

  function startEdit() {
    setDraft(value != null && zeroIsVisible(value) ? (value / 100).toFixed(2) : "");
    setEditing(true);
  }

  async function commit() {
    setEditing(false);
    const parsed = parseAmountToSatang(draft);
    // See shouldCommitAmount's doc (packages/shared/src/money.ts) for why
    // zeroIsMeaningful changes this: without it, typing "0.00" into an
    // UNSET zeroIsMeaningful field (cash-block override/adjustment) would
    // never fire onCommit at all.
    if (!shouldCommitAmount(value, parsed, Boolean(zeroIsMeaningful))) {
      setState("idle");
      return;
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setState("saving");
    try {
      await onCommit(parsed);
      setState("saved");
      resetTimer.current = setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("error");
      resetTimer.current = setTimeout(() => setState("idle"), 2500);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        disabled={disabled || state === "saving"}
        value={shown}
        placeholder={placeholder}
        onFocus={startEdit}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
        className="w-24 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-right text-sm font-medium tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint disabled:text-ink-muted sm:w-28"
      />
      <SaveMark state={state} />
    </div>
  );
}

function SaveMark({ state }: { state: SaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-block w-4 text-center text-xs text-ink-muted" aria-hidden="true">
        …
      </span>
    );
  }
  if (state === "saved") {
    return (
      <svg viewBox="0 0 16 16" role="img" aria-label="บันทึกแล้ว" className="h-4 w-4 shrink-0 text-ok">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 8.5 6.5 12 13 4.5"
        />
      </svg>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-block w-4 text-center text-xs font-bold text-bad" role="img" aria-label="บันทึกไม่สำเร็จ">
        !
      </span>
    );
  }
  return <span className="inline-block w-4" aria-hidden="true" />;
}
