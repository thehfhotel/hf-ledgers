import { useState } from "react";

interface Props {
  onCancel: () => void;
  /** Performs the actual นำออก (supersede) call — the dialog only drives
   * the confirm/cancel UI and its own saving state, same "caller owns the
   * network call" split AttachModal's own `onSave` establishes. */
  onConfirm: () => Promise<void>;
}

/**
 * The นำออก confirm dialog (owner-approved จัดการสลิป design) — wording is
 * VERBATIM from the design, never paraphrased: this is the one place in the
 * app that spells out, in front of reception, that "นำออก" is a supersede,
 * not a delete. The word ลบ deliberately never appears on either BUTTON
 * (ยกเลิก / นำออก) — only inside the reassurance sentence itself
 * ("ไม่ถูกลบออกจากระบบ"), where it's explicitly negating deletion, not
 * offering it as an action.
 */
export function RemoveConfirmDialog({ onCancel, onConfirm }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setSaving(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "นำออกไม่สำเร็จ");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-panel shadow-xl">
        <div className="px-4 py-4">
          <p className="text-sm text-ink">
            รูปนี้จะถูกนำออกจากรายการปัจจุบัน — ไม่ถูกลบออกจากระบบ ยังดูย้อนหลังและกู้คืนได้จาก ประวัติ เสมอ
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
            className="rounded-md bg-bad px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "กำลังนำออก..." : "นำออก"}
          </button>
        </div>
      </div>
    </div>
  );
}
