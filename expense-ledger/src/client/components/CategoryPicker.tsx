import { useId } from "react";
import { EXPENSE_CATEGORIES, categoryByCode, type ExpenseCategoryCode } from "../../shared/categories.ts";
import { FIELD_LABELS } from "../labels.ts";

interface Props {
  value: ExpenseCategoryCode | null;
  onChange: (code: ExpenseCategoryCode) => void;
  recentCodes: ExpenseCategoryCode[];
}

/** One familiar native selector instead of 21 tiles and a separate search box.
 * Keep the three most recent choices as optional one-tap shortcuts. */
export function CategoryPicker({ value, onChange, recentCodes }: Props) {
  const id = useId();
  return <div>
    <select id={id} value={value ?? ''} aria-label={FIELD_LABELS.category}
      onChange={e => { if (e.target.value) onChange(e.target.value as ExpenseCategoryCode); }}
      className="h-12 w-full rounded-md border border-line-strong bg-panel px-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40">
      <option value="" disabled>เลือกหมวดรายจ่าย</option>
      {EXPENSE_CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.label}{c.building ? ` (${c.building})` : ''}</option>)}
    </select>
    {recentCodes.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-muted">ใช้ล่าสุด</span>
      {recentCodes.slice(0, 3).map(code => { const c = categoryByCode(code); return <button key={code} type="button"
        onClick={() => onChange(code)} aria-pressed={value === code}
        className="min-h-10 rounded-full border border-line-strong bg-panel px-3 text-sm text-ink hover:bg-tint">
        {c.label}{c.building ? ` (${c.building})` : ''}
      </button>; })}
    </div>}
  </div>;
}
