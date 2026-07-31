import { useEffect, useState } from "react";
import { DEPOSIT_NOTE_MAX_LEN, type Property } from "../../shared/types.ts";
import { putDepositNote } from "../api.ts";

interface Props {
  property: Property;
  rNumber: string;
  note: string | null;
  resolvedAt: string | null;
  /** Fires after a successful save with the freshly-saved fields — the
   * caller applies this onto every row (aging AND exceptions) sharing this
   * `rNumber`, since a thread can appear in both lists at once and the note
   * is the same conversation either way. */
  onSaved: (fields: { note: string | null; resolvedAt: string | null; resolvedBy: string | null }) => void;
}

/**
 * Inline note editor for one deposit R-number thread (Wave D, D3/D4) — a
 * textarea plus a "ทำเครื่องหมายว่าแก้ไขแล้ว" resolved checkbox, used both by
 * the aging section (behind a collapsed badge) and unconditionally inline
 * in the ข้อยกเว้น (exceptions) section. Saves on textarea blur and on every
 * checkbox toggle — there is no separate "save" button, matching this app's
 * blur-commits-a-cell convention elsewhere (AmountInput, the other-income/
 * deposit-event free-text fields on BookingDayPage.tsx).
 */
export function DepositNoteEditor({ property, rNumber, note, resolvedAt, onSaved }: Props) {
  const [text, setText] = useState(note ?? "");
  const [resolved, setResolved] = useState(resolvedAt !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The parent re-renders this component with fresh props after a save
  // lands (via onSaved updating its own state) — keep the local draft in
  // sync whenever the SAVED value itself changes from outside (e.g. this
  // same rNumber's note was also edited from the aging section's expando).
  useEffect(() => {
    setText(note ?? "");
    setResolved(resolvedAt !== null);
  }, [note, resolvedAt]);

  async function save(nextResolved: boolean) {
    setSaving(true);
    setError(null);
    try {
      const trimmed = text.trim();
      const saved = await putDepositNote(property, rNumber, {
        note: trimmed === "" ? null : trimmed,
        resolved: nextResolved,
      });
      onSaved({ note: saved.note, resolvedAt: saved.resolvedAt, resolvedBy: saved.resolvedBy });
    } catch (err) {
      setError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text.trim() !== (note ?? "").trim()) void save(resolved);
        }}
        maxLength={DEPOSIT_NOTE_MAX_LEN}
        rows={2}
        placeholder="บันทึกเหตุผล..."
        aria-label={`บันทึกเหตุผล ${rNumber}`}
        className="w-full rounded-md border border-line-strong bg-panel px-2 py-1.5 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
      />
      <label className="flex items-center gap-1.5 text-xs text-ink-muted">
        <input
          type="checkbox"
          checked={resolved}
          onChange={(e) => {
            const next = e.target.checked;
            setResolved(next);
            void save(next);
          }}
        />
        ทำเครื่องหมายว่าแก้ไขแล้ว
      </label>
      {saving && <span className="text-xs text-ink-muted">กำลังบันทึก...</span>}
      {error && <span className="text-xs text-bad">{error}</span>}
    </div>
  );
}
