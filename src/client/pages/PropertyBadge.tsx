import type { Property } from "../../shared/types.ts";
import { PROPERTY_BADGE_LABELS } from "../labels.ts";

interface Props {
  property: Property;
  /** True on the headless /demo route: the badge must never claim demo
   * fixture data belongs to a real property (see App.tsx's property-switcher
   * work — the demo route collapses to the "hf" label but is not real hf
   * data). */
  demo?: boolean;
  className?: string;
}

/**
 * Compact property tag for the data-entry screens (BookingDayPage,
 * DaySheetPage, HistoryPage, CategoriesPage, DepositRegisterPage) — the
 * office was entering days under the wrong hotel because nothing on the
 * page itself named the property (the printable report was the only place
 * it appeared). Same HF One tokens as the rest of the app; the distinction
 * is labelling only, not a second colour system.
 *
 * Label text is `PROPERTY_BADGE_LABELS` (client/labels.ts) — a compact
 * Latin form ("HF"/"HF Ville"), owner ask (2026-08-01) — NOT
 * `PROPERTY_LABELS[property].th` (shared/types.ts full Thai names, which
 * the printed report title still uses unchanged).
 */
export function PropertyBadge({ property, demo = false, className = "" }: Props) {
  return (
    <span
      className={
        "inline-flex shrink-0 items-center rounded-full border border-brand-300 bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-600 " +
        className
      }
    >
      {PROPERTY_BADGE_LABELS[property]}
      {demo && <span className="ml-1 font-normal text-brand-400">(ตัวอย่าง)</span>}
    </span>
  );
}
