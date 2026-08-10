import { useState } from "react";

interface Props {
  onCancel: () => void;
  /** Performs the actual markCash call — the dialog only drives the
   * confirm/cancel UI and its own saving state, same "caller owns the
   * network call" split RemoveConfirmDialog's own `onConfirm` establishes. */
  onConfirm: () => Promise<void>;
}

/**
 * The จ่ายเงินสด confirm dialog — modeled directly on RemoveConfirmDialog:
 * a payment settlement with no slip is a data claim reception is asserting
 * on trust ("this WAS paid, in cash, no photographic proof exists"), so it
 * gets the same one-tap-isn't-enough confirm gate a supersede does, not a
 * silent button press. The body copy is reassurance in the other direction
 * from นำออก's — not "this is reversible", but "this is where it goes and
 * it CAN be undone" — since ยกเลิกเงินสด (App.tsx's AttachedCard) is the
 * actual undo path and needs to be discoverable from here, before committing.
 */
export function CashConfirmDialog({ onCancel, onConfirm }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setSaving(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "บันทึกเงินสดไม่สำเร็จ");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-panel shadow-xl">
        <div className="px-4 py-4">
          <p className="text-sm font-semibold text-ink">บันทึกเป็นจ่ายเงินสด</p>
          <p className="mt-1 text-sm text-ink">
            รายการนี้จะย้ายไปแท็บ จัดการสลิป และยกเลิกได้ภายหลัง
          </p>
          {error && <p className="mt-2 text-xs text-bad">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-md border border-line-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={saving}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "กำลังบันทึก..." : "บันทึกเงินสด"}
          </button>
        </div>
      </div>
    </div>
  );
}
