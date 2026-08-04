import { useEffect, useRef, useState } from "react";

interface StagedFile {
  file: File;
  previewUrl: string;
  status: "pending" | "uploading" | "done" | "error";
  error: string | null;
}

interface Props {
  auditKey: string;
  guestName: string | null;
  initialFiles: File[];
  onCancel: () => void;
  /** Uploads one file — the modal drives the sequence + per-file progress
   * state, the caller owns the actual network call. Always an ADD now: the
   * จัดการสลิป redesign retired เปลี่ยน (whole-settlement replace) in favor of
   * per-picture นำออก (supersede) on the gallery itself, so this modal only
   * ever appends fresh current pictures — never supersedes anything first. */
  onSave: (files: File[]) => Promise<void>;
}

const ACCEPTED_TYPES = ["image/jpeg", "image/png"];

function thaiFileError(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type) && file.type !== "") {
    // Declared type only rejected here for a FAST client-side hint — the
    // server's own magic-byte sniff is the real gate, never this check.
    return "รองรับเฉพาะไฟล์รูปภาพ JPG หรือ PNG";
  }
  if (file.size > 15 * 1024 * 1024) return "ไฟล์ใหญ่เกินไป (สูงสุด 15MB)";
  return null;
}

/**
 * แนบสลิป modal: preview, multi-file, upload progress, Thai errors. Only
 * ever adds fresh pictures — see this file's own Props doc comment on why
 * เปลี่ยน/replace mode no longer exists.
 */
export function AttachModal({ auditKey, guestName, initialFiles, onCancel, onSave }: Props) {
  const [staged, setStaged] = useState<StagedFile[]>(() => toStaged(initialFiles));
  const [saving, setSaving] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      for (const s of staged) URL.revokeObjectURL(s.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toStaged(files: File[]): StagedFile[] {
    return files.map((file) => ({ file, previewUrl: URL.createObjectURL(file), status: "pending", error: thaiFileError(file) }));
  }

  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setStaged((prev) => [...prev, ...toStaged(arr)]);
  }

  function removeAt(index: number) {
    setStaged((prev) => {
      const target = prev[index];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }

  async function handleSave() {
    const valid = staged.filter((s) => s.error === null);
    if (valid.length === 0) {
      setGlobalError("กรุณาเลือกไฟล์รูปภาพก่อนบันทึก");
      return;
    }
    setSaving(true);
    setGlobalError(null);
    setStaged((prev) => prev.map((s) => (s.error === null ? { ...s, status: "uploading" } : s)));
    try {
      await onSave(valid.map((s) => s.file));
      setStaged((prev) => prev.map((s) => (s.error === null ? { ...s, status: "done" } : s)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "บันทึกสลิปไม่สำเร็จ";
      setGlobalError(message);
      setStaged((prev) => prev.map((s) => (s.status === "uploading" ? { ...s, status: "error", error: message } : s)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg bg-panel shadow-xl">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">แนบสลิป</h2>
          <p className="text-xs text-ink-muted">
            {guestName ? `${guestName} · ` : ""}
            {auditKey}
          </p>
        </div>

        <div
          className="mx-4 mt-3 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line-strong px-4 py-6 text-center text-sm text-ink-muted"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <p>ลากรูปมาวาง หรือ</p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600"
          >
            เลือกไฟล์
          </button>
          <p className="text-[11px]">วางรูปด้วย Ctrl+V ก็ได้</p>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {staged.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-muted">ยังไม่ได้เลือกรูป</p>
          ) : (
            <ul className="grid grid-cols-3 gap-2">
              {staged.map((s, i) => (
                <li key={s.previewUrl} className="relative overflow-hidden rounded-md border border-line">
                  <img src={s.previewUrl} alt="ตัวอย่างสลิป" className="aspect-square w-full object-cover" />
                  <div className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-center text-[10px] text-white">
                    {s.status === "pending" && "รอบันทึก"}
                    {s.status === "uploading" && "กำลังบันทึก..."}
                    {s.status === "done" && "บันทึกแล้ว"}
                    {s.status === "error" && "ผิดพลาด"}
                  </div>
                  {s.error && <div className="absolute inset-x-0 top-0 bg-bad px-1 py-0.5 text-center text-[10px] text-white">{s.error}</div>}
                  {s.status === "pending" && (
                    <button
                      type="button"
                      onClick={() => removeAt(i)}
                      aria-label="เอารูปนี้ออกจากรายการที่จะบันทึก"
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-white"
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {globalError && <p className="px-4 text-xs text-bad">{globalError}</p>}

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
            onClick={() => void handleSave()}
            disabled={saving || staged.every((s) => s.error !== null)}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {saving ? "กำลังบันทึก..." : "บันทึกสลิป"}
          </button>
        </div>
      </div>
    </div>
  );
}
