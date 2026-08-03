import { useEffect, useMemo, useRef, useState } from "react";
import { shiftDays, todayBangkok } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import { PROPERTIES, type Property } from "../../shared/types.ts";
import { PROPERTY_BADGE_LABELS } from "../../client/labels.ts";
import { DateBar } from "../../client/components/DateBar.tsx";
import {
  ApiError,
  attachSlip,
  getHistory,
  getMe,
  getSlipQueue,
  supersedeSlip,
  thumbUrl,
  type Me,
  type SlipQueueRow,
} from "./api.ts";
import { AttachModal, type AttachMode } from "./components/AttachModal.tsx";
import { HistoryDrawer } from "./components/HistoryDrawer.tsx";

const KIND_LABEL_TH: Record<SlipQueueRow["kind"], string> = {
  checkin: "เช็คอิน",
  deposit: "รับมัดจำ",
  refund: "คืนเงิน",
};

function matchesSearch(row: SlipQueueRow, query: string): boolean {
  if (query.trim() === "") return true;
  const needle = query.trim().toLowerCase();
  if (row.guestName?.toLowerCase().includes(needle)) return true;
  return row.refs.some((r) => r.toLowerCase().includes(needle));
}

function formatWhen(utc: string): string {
  const iso = utc.includes("T") ? utc : `${utc.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return utc;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

interface ModalState {
  row: SlipQueueRow;
  mode: AttachMode;
  initialFiles: File[];
}

/** ส่งสลิป — the reception slip inbox (Wave 2, docs/plan-audit-hub-slips.md).
 * A SEPARATE origin/app from the income ledger — this component tree never
 * imports anything from src/client/pages (only tiny, ledger-agnostic UI kit
 * pieces: DateBar, PROPERTY_BADGE_LABELS). */
export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [property, setProperty] = useState<Property>("hf");
  const [date, setDate] = useState(todayBangkok());
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<SlipQueueRow[] | null>(null);
  const [pmsNotConfigured, setPmsNotConfigured] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [pasteTargetKey, setPasteTargetKey] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((res) => {
        setMe(res);
        setProperty(res.defaultProperty);
      })
      .catch(() => {
        /* GET /me only 401s when unauthenticated — CF Access already gates
         * the whole host, so this can only fail on a genuine network hiccup;
         * the property pill still defaults to "hf" either way. */
      });
  }, []);

  async function reloadQueue() {
    setLoadError(null);
    setPmsNotConfigured(false);
    try {
      const res = await getSlipQueue(property, date);
      setRows(res.rows);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setPmsNotConfigured(true);
        setRows(null);
        return;
      }
      setLoadError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      setRows(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    (async () => {
      await reloadQueue();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property, date]);

  // Ctrl+V paste support: whichever pending card's drop zone last held
  // keyboard focus is the paste target (see the tabIndex/onFocus wiring on
  // each dashed zone below).
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (!pasteTargetKey || !e.clipboardData) return;
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      const row = rows?.find((r) => r.auditKey === pasteTargetKey);
      if (!row) return;
      e.preventDefault();
      setModal({ row, mode: "add", initialFiles: files });
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [pasteTargetKey, rows]);

  const filtered = useMemo(() => (rows ?? []).filter((r) => matchesSearch(r, search)), [rows, search]);
  const pending = filtered.filter((r) => r.attachment.count === 0);
  const attached = filtered.filter((r) => r.attachment.count > 0);

  async function handleSave(row: SlipQueueRow, mode: AttachMode, files: File[]) {
    if (mode === "replace") {
      const history = await getHistory(property, row.auditKey);
      const current = history.versions.filter((v) => !v.superseded);
      for (const v of current) await supersedeSlip(property, row.auditKey, v.version);
    }
    for (const file of files) await attachSlip(property, row.auditKey, date, file);
    setModal(null);
    await reloadQueue();
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 p-3 pb-16">
      <header className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-4 py-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-brand-600">ส่งสลิป</h1>
          <div className="flex overflow-hidden rounded-full border border-brand-300">
            {PROPERTIES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProperty(p)}
                className={
                  "px-2.5 py-1 text-xs font-semibold " +
                  (p === property ? "bg-brand-500 text-white" : "bg-brand-50 text-brand-600 hover:bg-brand-100")
                }
              >
                {PROPERTY_BADGE_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
        {me && <span className="rounded-full bg-tint px-2.5 py-1 text-xs font-medium text-ink-muted">{me.email}</span>}
      </header>

      <DateBar date={date} onPick={setDate} onShift={(d) => setDate(shiftDays(date, d))} />

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="ค้นหาชื่อผู้เข้าพัก หรือเลขที่อ้างอิง"
        className="rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
      />

      {pmsNotConfigured && (
        <div className="rounded-lg border border-line bg-panel px-4 py-6 text-center text-sm text-ink-muted">
          ยังไม่ได้เชื่อมต่อ PMS สำหรับโรงแรมนี้
        </div>
      )}
      {loadError && <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">โหลดข้อมูลไม่สำเร็จ: {loadError}</div>}
      {rows === null && !pmsNotConfigured && !loadError && <div className="p-6 text-center text-sm text-ink-muted">กำลังโหลด...</div>}

      {rows !== null && (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-ink">รอแนบสลิป ({pending.length})</h2>
            {pending.length === 0 ? (
              <p className="rounded-lg border border-line bg-panel px-4 py-6 text-center text-sm text-ink-muted">
                {filtered.length === 0 && rows.length > 0 ? "ไม่พบรายการที่ค้นหา" : "ไม่มีรายการที่รอแนบสลิป"}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {pending.map((row) => (
                  <PendingCard
                    key={row.auditKey}
                    row={row}
                    onFocusZone={() => setPasteTargetKey(row.auditKey)}
                    onBlurZone={() => setPasteTargetKey((prev) => (prev === row.auditKey ? null : prev))}
                    onFilesChosen={(files) => setModal({ row, mode: "add", initialFiles: files })}
                  />
                ))}
              </ul>
            )}
          </section>

          {attached.length > 0 && (
            <section className="flex flex-col gap-2 opacity-95">
              <h2 className="text-sm font-semibold text-ink">แนบแล้ว ({attached.length})</h2>
              <ul className="flex flex-col gap-2">
                {attached.map((row) => (
                  <AttachedCard
                    key={row.auditKey}
                    property={property}
                    row={row}
                    onAddMore={() => setModal({ row, mode: "add", initialFiles: [] })}
                    onReplace={() => setModal({ row, mode: "replace", initialFiles: [] })}
                    onShowHistory={() => setHistoryKey(row.auditKey)}
                  />
                ))}
              </ul>
            </section>
          )}

          <p className="text-center text-[11px] text-ink-muted">ข้อมูลอาจล่าช้ากว่าระบบจริงเล็กน้อย — ถ้าไม่เห็นรายการล่าสุด ลองรีเฟรชอีกครั้ง</p>
        </>
      )}

      {modal && (
        <AttachModal
          auditKey={modal.row.auditKey}
          guestName={modal.row.guestName}
          mode={modal.mode}
          initialFiles={modal.initialFiles}
          onCancel={() => setModal(null)}
          onSave={(files) => handleSave(modal.row, modal.mode, files)}
        />
      )}

      {historyKey && <HistoryDrawer property={property} auditKey={historyKey} onClose={() => setHistoryKey(null)} />}
    </div>
  );
}

function RefsLine({ row }: { row: SlipQueueRow }) {
  return <span className="text-[11px] text-ink-muted">{row.refs.join(" · ")}</span>;
}

interface PendingCardProps {
  row: SlipQueueRow;
  onFocusZone: () => void;
  onBlurZone: () => void;
  onFilesChosen: (files: File[]) => void;
}

function PendingCard({ row, onFocusZone, onBlurZone, onFilesChosen }: PendingCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <li className="rounded-lg border border-line bg-panel p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium text-ink-muted">{KIND_LABEL_TH[row.kind]}</span>
          <span className="text-base font-semibold text-ink">{row.guestName ?? "ไม่ทราบชื่อ"}</span>
          <RefsLine row={row} />
        </div>
        <div className="flex flex-col items-end text-sm">
          <span className="font-semibold tabular-nums text-ink">{formatSatang(row.amountSatang)}</span>
          <span className="text-[11px] text-ink-muted">โอน {formatSatang(row.transferSatang)}</span>
        </div>
      </div>

      <div
        tabIndex={0}
        onFocus={onFocusZone}
        onBlur={onBlurZone}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length > 0) onFilesChosen(Array.from(e.dataTransfer.files));
        }}
        onClick={() => inputRef.current?.click()}
        className="mt-2 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line-strong px-3 py-4 text-center text-xs text-ink-muted hover:border-brand-300 hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
      >
        <span className="font-medium text-brand-500">แนบสลิป</span>
        <span>คลิกเพื่อเลือกไฟล์ ลากรูปมาวาง หรือวางด้วย Ctrl+V</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) onFilesChosen(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
    </li>
  );
}

interface AttachedCardProps {
  property: Property;
  row: SlipQueueRow;
  onAddMore: () => void;
  onReplace: () => void;
  onShowHistory: () => void;
}

function AttachedCard({ property, row, onAddMore, onReplace, onShowHistory }: AttachedCardProps) {
  const { attachment } = row;
  return (
    <li className="flex items-center gap-3 rounded-lg border border-line bg-panel p-3">
      {attachment.latestVersion !== null ? (
        <button type="button" onClick={onShowHistory} className="relative shrink-0">
          <img
            src={thumbUrl(property, row.auditKey, attachment.latestVersion)}
            alt={`สลิปล่าสุดของ ${row.auditKey}`}
            className="h-14 w-14 rounded-md object-cover"
          />
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-semibold text-white">
            {attachment.count}
          </span>
        </button>
      ) : (
        <div className="h-14 w-14 shrink-0 rounded-md bg-tint" />
      )}

      <div className="flex flex-1 flex-col gap-0.5">
        <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium text-ink-muted w-fit">{KIND_LABEL_TH[row.kind]}</span>
        <span className="font-semibold text-ink">{row.guestName ?? "ไม่ทราบชื่อ"}</span>
        <RefsLine row={row} />
        {attachment.latestAt && <span className="text-[11px] text-ink-muted">แนบล่าสุด {formatWhen(attachment.latestAt)}</span>}
      </div>

      <div className="flex flex-col items-end gap-1">
        <span className="text-sm font-semibold tabular-nums text-ink">{formatSatang(row.amountSatang)}</span>
        <div className="flex gap-1">
          <button type="button" onClick={onAddMore} className="rounded-md border border-line-strong px-2 py-1 text-[11px] font-medium text-ink hover:bg-tint">
            เพิ่มรูป
          </button>
          <button type="button" onClick={onReplace} className="rounded-md border border-line-strong px-2 py-1 text-[11px] font-medium text-ink hover:bg-tint">
            เปลี่ยน
          </button>
        </div>
        <button type="button" onClick={onShowHistory} className="text-[11px] text-brand-500 hover:underline">
          ประวัติ
        </button>
      </div>
    </li>
  );
}
