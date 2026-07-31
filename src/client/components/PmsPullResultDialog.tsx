import { useState } from "react";
import { formatSatang } from "../../shared/money.ts";
import type { Property } from "../../shared/types.ts";
import { acceptPmsUpdate, type PmsBookingLineChange, type pullFromPms } from "../api.ts";
import { normalizeChangedRows, runAcceptFlow } from "./pmsPullAccept.ts";

type PmsPullResult = Awaited<ReturnType<typeof pullFromPms>>;

interface Props {
  property: Property;
  result: PmsPullResult;
  onClose: () => void;
  /** Called once, after ANY row is successfully accepted — re-fetches
   * booking lines + the day sheet the same way the initial page load does
   * (BookingDayPage.tsx's `refetchLinesAndSheet`). */
  onAccepted: () => Promise<void>;
}

/** Thai labels for the diffable fields `db.ts`'s `diffCandidateAgainstBookingLine`
 * can report — money fields render via `formatSatang`, everything else as
 * plain text. Kept in this file (not shared) since only this dialog ever
 * renders a raw field name back to a human. */
const FIELD_LABELS_TH: Record<string, string> = {
  bookingNo: "เลขที่การจอง",
  guestName: "ชื่อลูกค้า",
  roomNo: "ห้อง",
  roomCount: "จำนวนห้อง",
  nights: "จำนวนคืน",
  grossRoomSatang: "ค่าห้อง",
  grossOtherSatang: "รายรับอื่นๆ",
  cash: "เงินสด",
  web: "แอพฯ/เว็บไซต์",
  deposit_applied: "ตัดยอดมัดจำ",
  transfer_kbank: "โอน กสิกร",
  credit_kbank: "บัตรเครดิต กสิกร",
};

const MONEY_FIELDS = new Set([
  "grossRoomSatang",
  "grossOtherSatang",
  "cash",
  "web",
  "deposit_applied",
  "transfer_kbank",
  "credit_kbank",
]);

function formatFieldValue(field: string, value: string | number | null): string {
  if (value === null) return "-";
  if (MONEY_FIELDS.has(field) && typeof value === "number") return formatSatang(value);
  return String(value);
}

/**
 * Replaces the ดึงข้อมูล button's old `window.alert(formatPmsPullResult(...))`
 * (Wave D, D5) — same modal shell convention as HistoryPage.tsx's
 * MonthCloseDialog (fixed overlay, header/scrollable-body/footer), widened
 * for the before->after diff cards. Keeps every section the alert used to
 * show (inserted/skipped, skippedRefunds, deposits, autoPlaced, unplaced,
 * anomalies) and adds "รายการที่ข้อมูลใน PMS เปลี่ยนไป" — one card per
 * `result.changed` row, a "เคยแก้ไขด้วยมือ" chip when `handEdited`, and a
 * per-row "ยอมรับการเปลี่ยนแปลง" button that calls the accept endpoint and
 * removes the row from view only once the post-accept refetch has ALSO
 * succeeded (never removes it on either failure — see `accept()` below for
 * why the two are ordered this way).
 */
export function PmsPullResultDialog({ property, result, onClose, onAccepted }: Props) {
  // `normalizeChangedRows` (review fix 1, pmsPullAccept.ts) — defensive
  // fallback in case an older cached response (or a future contract change)
  // ever omits `result.changed`, since `changed.length`/`.map` below would
  // otherwise throw on `undefined` with no ErrorBoundary in this app to
  // catch it.
  const [changed, setChanged] = useState<PmsBookingLineChange[]>(normalizeChangedRows(result.changed));
  const [acceptingId, setAcceptingId] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  // Dialog-level banner — used ONLY for "the accept itself succeeded but the
  // post-accept refetch failed" (see runAcceptFlow's doc comment,
  // pmsPullAccept.ts); per-row failures use rowErrors instead, since those
  // rows are still visible to retry.
  const [dialogError, setDialogError] = useState<string | null>(null);

  async function accept(row: PmsBookingLineChange) {
    setAcceptingId(row.id);
    setDialogError(null);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });

    const outcome = await runAcceptFlow(() => acceptPmsUpdate(property, row.id), onAccepted);
    switch (outcome.kind) {
      case "accept-failed":
        // The accept call itself failed — the row is untouched
        // server-side, so it stays visible with its own inline error to
        // retry.
        setRowErrors((prev) => ({ ...prev, [row.id]: outcome.message }));
        break;
      case "accepted-and-refreshed":
        setChanged((prev) => prev.filter((r) => r.id !== row.id));
        break;
      case "accepted-but-refresh-failed":
        // Review fix 2: the row is deliberately NOT removed here — the
        // accept succeeded, but the screen hasn't caught up with it, so
        // hiding the row would strand the office with stale numbers and no
        // visible next step. Reload picks the correction up either way.
        setDialogError("บันทึกแล้ว แต่โหลดข้อมูลใหม่ไม่สำเร็จ — รีเฟรชหน้า");
        break;
    }
    setAcceptingId(null);
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-panel shadow-lg">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">ผลการดึงข้อมูลจาก PMS</h2>
        </div>

        {dialogError && (
          <p className="border-b border-line bg-gold-50 px-4 py-2 text-xs font-medium text-warn">{dialogError}</p>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex flex-col gap-2 text-sm text-ink">
            <p>
              เพิ่มรายการจาก PMS แล้ว <span className="font-semibold tabular-nums">{result.inserted}</span> รายการ
              ข้ามไป <span className="font-semibold tabular-nums">{result.skipped}</span> รายการ (มีอยู่แล้ว)
            </p>
            {result.skippedRefunds > 0 && (
              <p className="text-ink-muted">
                ข้ามรายการคืนเงิน <span className="tabular-nums">{result.skippedRefunds}</span> รายการ
                (ไม่นำเข้ารายการติดลบ)
              </p>
            )}
            {(result.depositsInserted > 0 || result.depositsSkipped > 0) && (
              <p className="text-ink-muted">
                มัดจำล่วงหน้า: เพิ่ม <span className="tabular-nums">{result.depositsInserted}</span> รายการ ข้ามไป{" "}
                <span className="tabular-nums">{result.depositsSkipped}</span> รายการ (มีอยู่แล้ว)
              </p>
            )}
          </div>

          {result.autoPlaced.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-line-strong px-2.5 py-2">
              <p className="text-xs font-semibold text-ink-muted">รายการที่ลงช่องธนาคารให้อัตโนมัติ — ตรวจสอบธนาคารด้วย</p>
              {result.autoPlaced.map((row) => (
                <div key={row.pmsRef} className="text-xs text-ink">
                  เลขที่ {row.bookingNo ?? row.pmsRef}:{" "}
                  {row.transferSatang > 0 && <>โอน/กสิกร {formatSatang(row.transferSatang)} บาท </>}
                  {row.creditSatang > 0 && <>บัตรเครดิต/กสิกร {formatSatang(row.creditSatang)} บาท</>}
                </div>
              ))}
            </div>
          )}

          {result.unplaced.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-warn/40 bg-gold-50 px-2.5 py-2">
              <p className="text-xs font-semibold text-warn">รายการที่ยังไม่ได้ระบุธนาคาร</p>
              {result.unplaced.map((row) => (
                <div key={row.pmsRef} className="text-xs text-ink">
                  เลขที่ {row.bookingNo ?? row.pmsRef}:{" "}
                  {row.creditSatang > 0 && <>บัตรเครดิต {formatSatang(row.creditSatang)} บาท </>}
                  {row.tranSatang > 0 && <>เงินโอน {formatSatang(row.tranSatang)} บาท</>} — กรอกในช่องธนาคารเอง
                </div>
              ))}
            </div>
          )}

          {result.anomalies.length > 0 && (
            <p className="mt-3 text-xs font-medium text-warn">
              พบรายการผิดปกติ {result.anomalies.length} รายการ (ไม่ได้นำเข้าเป็นเงิน) — ตรวจสอบใน PMS
            </p>
          )}

          {changed.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-ink-muted">รายการที่ข้อมูลใน PMS เปลี่ยนไป</h3>
              {changed.map((row) => (
                <div key={row.id} className="flex flex-col gap-2 rounded-md border border-warn/40 bg-gold-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-ink">
                      {row.bookingNo ?? row.pmsRef}
                      {row.handEdited && (
                        <span className="ml-2 rounded-full bg-tint px-2 py-0.5 text-[11px] font-normal text-ink-muted">
                          เคยแก้ไขด้วยมือ
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => void accept(row)}
                      disabled={acceptingId === row.id}
                      className="rounded-md bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                    >
                      {acceptingId === row.id ? "กำลังยอมรับ..." : "ยอมรับการเปลี่ยนแปลง"}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {row.fields.map((f) => (
                      <div key={f.field} className="flex items-center justify-between gap-2 rounded bg-panel px-2 py-1 text-xs">
                        <span className="text-ink-muted">{FIELD_LABELS_TH[f.field] ?? f.field}</span>
                        <span className="tabular-nums text-ink">
                          {formatFieldValue(f.field, f.before)} → {formatFieldValue(f.field, f.after)}
                        </span>
                      </div>
                    ))}
                  </div>
                  {rowErrors[row.id] && <p className="text-xs text-bad">{rowErrors[row.id]}</p>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600"
          >
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}
