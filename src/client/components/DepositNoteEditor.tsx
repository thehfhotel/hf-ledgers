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
  /** Fires when "ยกเลิก" is pressed, AFTER local edits have already been
   * reverted — optional because only the togglable callers (the register's
   * unified thread table, behind a NoteBadge click) have anything to
   * collapse; the caller wires this to the same toggle that opened the
   * editor, so cancelling also closes the row. The ข้อยกเว้น section's rows
   * render this editor unconditionally (no expand/collapse state at all —
   * see DepositRegisterPage.tsx), so they omit this prop: ยกเลิก there just
   * discards the in-progress edit and leaves the (always-visible) editor in
   * place. */
  onCancel?: () => void;
}

/**
 * Inline note editor for one deposit R-number thread (Wave D, D3/D4) — a
 * textarea, a "ทำเครื่องหมายว่าแก้ไขแล้ว" resolved checkbox, and explicit
 * บันทึก/ยกเลิก buttons. Used both by the register's unified thread table
 * (behind a collapsed NoteBadge) and unconditionally inline in the
 * ข้อยกเว้น (exceptions) section.
 *
 * ROOT CAUSE of the "no way to save" bug (owner report, 2026-08-01, screenshot
 * from the live มัดจำ page): this component used to have NO save button at
 * all, on purpose — it saved on textarea blur and on every checkbox toggle
 * (the same "blur commits a cell" convention AmountInput and the other-
 * income/deposit-event free-text fields use elsewhere in this app). That
 * convention works for a SINGLE editable cell, where the one interaction
 * (leaving the field) unambiguously means "done." It does not work for a
 * compound note+checkbox control: a manager who types a note and then does
 * anything OTHER than blur the textarea or touch the checkbox — clicks
 * nowhere, or the row's own collapse control eats the next click — leaves
 * with the text still sitting in the DOM and never PUT to the server, with
 * zero visual affordance that an action was even needed. The screenshot
 * that prompted this fix shows exactly that: a typed note, a checkbox, and
 * nothing that looks like "save." Fix: replace the implicit blur/toggle
 * saves with an explicit บันทึก button (PUTs note+resolved together, single
 * request) plus an explicit ยกเลิก button (reverts local edits, collapses
 * the row when the caller wired `onCancel`) — the control now always shows
 * what will happen and always requires a deliberate click to persist.
 */
export function DepositNoteEditor({ property, rNumber, note, resolvedAt, onSaved, onCancel }: Props) {
  const [text, setText] = useState(note ?? "");
  const [resolved, setResolved] = useState(resolvedAt !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The parent re-renders this component with fresh props after a save
  // lands (via onSaved updating its own state) — keep the local draft in
  // sync whenever the SAVED value itself changes from outside (e.g. this
  // same rNumber's note was also edited from the exceptions section while
  // this one stayed open).
  useEffect(() => {
    setText(note ?? "");
    setResolved(resolvedAt !== null);
    setError(null);
  }, [note, resolvedAt]);

  const dirty = text.trim() !== (note ?? "").trim() || resolved !== (resolvedAt !== null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const trimmed = text.trim();
      const saved = await putDepositNote(property, rNumber, {
        note: trimmed === "" ? null : trimmed,
        resolved,
      });
      onSaved({ note: saved.note, resolvedAt: saved.resolvedAt, resolvedBy: saved.resolvedBy });
    } catch (err) {
      setError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setText(note ?? "");
    setResolved(resolvedAt !== null);
    setError(null);
    onCancel?.();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={DEPOSIT_NOTE_MAX_LEN}
        rows={2}
        placeholder="บันทึกเหตุผล..."
        aria-label={`บันทึกเหตุผล ${rNumber}`}
        className="w-full rounded-md border border-line-strong bg-panel px-2 py-1.5 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
      />
      <label className="flex items-center gap-1.5 text-xs text-ink-muted">
        <input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} />
        ทำเครื่องหมายว่าแก้ไขแล้ว
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {saving ? "กำลังบันทึก..." : "บันทึก"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          className="rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
        >
          ยกเลิก
        </button>
      </div>
      {error && <span className="text-xs text-bad">{error}</span>}
    </div>
  );
}
