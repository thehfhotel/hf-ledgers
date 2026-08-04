import { useEffect, useMemo, useRef, useState } from "react";
import { shiftDays, timeBangkok, todayBangkok } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import { PROPERTIES, type Property } from "../../shared/types.ts";
import { PROPERTY_BADGE_LABELS } from "../../client/labels.ts";
import { DateBar } from "../../client/components/DateBar.tsx";
import {
  ApiError,
  attachSlip,
  getMe,
  getSlipQueue,
  pictureUrl,
  supersedeSlip,
  thumbUrl,
  type Me,
  type SlipQueueRow,
} from "./api.ts";
import { AttachModal } from "./components/AttachModal.tsx";
import { HistoryDrawer } from "./components/HistoryDrawer.tsx";
import { RemoveConfirmDialog } from "./components/RemoveConfirmDialog.tsx";
import { historyCount, shouldShowCountBadge } from "./gallery.ts";
import { matchesSearch, partitionSlipQueue } from "./partition.ts";

const KIND_LABEL_TH: Record<SlipQueueRow["kind"], string> = {
  checkin: "เช็คอิน",
  deposit: "รับมัดจำ",
  refund: "คืนเงิน",
};

/** Which of the two tabs is active — owner feedback, 2026-08-04: the single
 * scrolling list (รอแนบสลิป on top, แนบแล้ว below) made a just-attached row's
 * move feel like a disappearance (แนบแล้ว could be off-screen, or plain
 * didn't exist yet as a section for the day's first slip). Splitting into
 * explicit tabs makes that move a navigable destination instead. */
type Tab = "pending" | "manage";

interface ModalState {
  row: SlipQueueRow;
  initialFiles: File[];
}

/** Which picture (auditKey + version) นำออก's confirm dialog is currently
 * asking about — `null` means the dialog is closed. */
interface RemoveTarget {
  auditKey: string;
  version: number;
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
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [pasteTargetKey, setPasteTargetKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  // Owner ask (2026-08-04): immediate, explicit feedback on a successful
  // attach — never let the row's move to จัดการสลิป read as a silent
  // vanish. `true` shows the toast; auto-dismisses below.
  const [showAttachToast, setShowAttachToast] = useState(false);

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
      setModal({ row, initialFiles: files });
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [pasteTargetKey, rows]);

  // Auto-dismiss the attach-success toast — a lingering confirmation is as
  // much noise as no confirmation at all; the tab pill itself (with its own
  // live count) stays the permanent record of where the row went.
  useEffect(() => {
    if (!showAttachToast) return;
    const t = setTimeout(() => setShowAttachToast(false), 6000);
    return () => clearTimeout(t);
  }, [showAttachToast]);

  const filtered = useMemo(() => (rows ?? []).filter((r) => matchesSearch(r, search)), [rows, search]);
  const { pending, attached } = useMemo(() => partitionSlipQueue(filtered), [filtered]);

  async function handleSave(row: SlipQueueRow, files: File[]) {
    for (const file of files) await attachSlip(property, row.auditKey, date, file);
    // Reload BEFORE closing the modal — by the time the modal disappears,
    // `rows` already reflects the attach (the row has already moved into
    // จัดการสลิป), so there is no brief window where the modal is gone but
    // the pending list still shows the stale (pre-attach) state.
    await reloadQueue();
    setModal(null);
    setShowAttachToast(true);
  }

  // นำออก: supersedes exactly the one version the confirm dialog is asking
  // about — never a delete (RemoveConfirmDialog's own wording is the
  // binding proof of that to reception). Reloads the queue on success so
  // the gallery/badge/ประวัติ count all drop that picture from "current" at
  // once; the dialog itself closes only after the reload lands, same
  // "never show a stale state behind a closed dialog" discipline
  // `handleSave` above already follows.
  async function handleConfirmRemove() {
    if (!removeTarget) return;
    await supersedeSlip(property, removeTarget.auditKey, removeTarget.version);
    await reloadQueue();
    setRemoveTarget(null);
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
          {/* Two tabs, not one scrolling list — see the Tab type's own doc
              comment for why. The tab bar mirrors this app's own pill
              language (same treatment as the property switcher above), and
              carries a live count on EACH tab so a settlement's move from
              รอแนบสลิป to จัดการสลิป is always visible at a glance, not just
              inferred from the list shrinking. Counts (like the search box
              and DateBar above) are scoped to the current date + search —
              BOTH tabs share that same scoping, never a per-tab copy. */}
          <div className="flex justify-center">
            <div className="flex overflow-hidden rounded-full border border-brand-300">
              <button
                type="button"
                onClick={() => setTab("pending")}
                aria-pressed={tab === "pending"}
                className={
                  "px-3 py-1.5 text-xs font-semibold transition " +
                  (tab === "pending" ? "bg-brand-500 text-white" : "bg-brand-50 text-brand-600 hover:bg-brand-100")
                }
              >
                รอแนบสลิป ({pending.length})
              </button>
              <button
                type="button"
                onClick={() => setTab("manage")}
                aria-pressed={tab === "manage"}
                className={
                  "px-3 py-1.5 text-xs font-semibold transition " +
                  (tab === "manage" ? "bg-brand-500 text-white" : "bg-brand-50 text-brand-600 hover:bg-brand-100")
                }
              >
                จัดการสลิป ({attached.length})
              </button>
            </div>
          </div>

          {tab === "pending" && (
            <section className="flex flex-col gap-2">
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
                      onFilesChosen={(files) => setModal({ row, initialFiles: files })}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "manage" && (
            <section className="flex flex-col gap-2">
              {attached.length === 0 ? (
                <p className="rounded-lg border border-line bg-panel px-4 py-6 text-center text-sm text-ink-muted">
                  {filtered.length === 0 && rows.length > 0 ? "ไม่พบรายการที่ค้นหา" : "ยังไม่มีรายการที่แนบสลิปแล้ว"}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {attached.map((row) => (
                    <AttachedCard
                      key={row.auditKey}
                      property={property}
                      row={row}
                      onAddMore={() => setModal({ row, initialFiles: [] })}
                      onShowHistory={() => setHistoryKey(row.auditKey)}
                      onRequestRemove={(version) => setRemoveTarget({ auditKey: row.auditKey, version })}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          <p className="text-center text-[11px] text-ink-muted">ข้อมูลอาจล่าช้ากว่าระบบจริงเล็กน้อย — ถ้าไม่เห็นรายการล่าสุด ลองรีเฟรชอีกครั้ง</p>
        </>
      )}

      {modal && (
        <AttachModal
          auditKey={modal.row.auditKey}
          guestName={modal.row.guestName}
          initialFiles={modal.initialFiles}
          onCancel={() => setModal(null)}
          onSave={(files) => handleSave(modal.row, files)}
        />
      )}

      {historyKey && (
        <HistoryDrawer property={property} auditKey={historyKey} onClose={() => setHistoryKey(null)} onRestored={() => void reloadQueue()} />
      )}

      {removeTarget && <RemoveConfirmDialog onCancel={() => setRemoveTarget(null)} onConfirm={handleConfirmRemove} />}

      {/* Attach-success toast (owner ask, 2026-08-04) — explicit "it went
          HERE" feedback the instant a slip saves, with a direct jump. Never
          blocks the UI (fixed, dismissible, auto-clears) and never appears
          for a "replace"/supersede-only outcome differently — every
          successful save (add or replace) lands the settlement in จัดการสลิป,
          so the same message covers both. */}
      {showAttachToast && (
        <div className="fixed inset-x-3 bottom-3 z-40 flex items-center justify-between gap-3 rounded-lg bg-brand-800 px-4 py-3 text-sm text-white shadow-xl">
          <span>
            แนบสลิปแล้ว — ดูได้ที่แท็บ{" "}
            <button
              type="button"
              onClick={() => {
                setTab("manage");
                setShowAttachToast(false);
              }}
              className="font-semibold underline underline-offset-2 hover:text-gold-200"
            >
              จัดการสลิป
            </button>
          </span>
          <button
            type="button"
            onClick={() => setShowAttachToast(false)}
            aria-label="ปิดข้อความแจ้งเตือน"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-white/70 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/** Refs line + the compact "· 14:32" payment-time chip — the newest-first
 * date+time sort (owner ask, 2026-08-04) is only legible if the time it's
 * sorting by is actually shown next to each card, same treatment
 * DayAuditQueue.tsx (the ledger's own ตรวจรายวัน queue) gives it. Omitted
 * entirely when `paidAtIso` is `null` (never a guessed/blank time). */
function RefsLine({ row }: { row: SlipQueueRow }) {
  const time = timeBangkok(row.paidAtIso);
  return (
    <span className="text-[11px] text-ink-muted">
      {row.refs.join(" · ")}
      {time !== null && <> · {time}</>}
    </span>
  );
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
  onShowHistory: () => void;
  onRequestRemove: (version: number) => void;
}

/**
 * จัดการสลิป gallery card (owner-approved "จัดการสลิป — Manage Slips" design,
 * retires the old single-thumbnail + เปลี่ยน layout): EVERY current picture
 * renders as its own thumbnail, each with its own × (นำออก — see
 * RemoveConfirmDialog for why this is a supersede, never a delete) and an
 * HH:MM attach-time caption, plus a trailing dashed "+ เพิ่มรูป" tile. Tapping
 * a thumbnail opens the full-size picture directly (a real link, new tab) —
 * same pattern this app already used for the old single thumbnail and
 * HistoryDrawer's own rows, so ประวัติ below stays the one SEPARATE,
 * explicit path to full version history/restore rather than overloading the
 * same tap gesture two different ways.
 */
function AttachedCard({ property, row, onAddMore, onShowHistory, onRequestRemove }: AttachedCardProps) {
  const { attachment, currentAttachments } = row;
  const showBadge = shouldShowCountBadge(attachment.count);
  const nHistory = historyCount(attachment);
  // "แนบล่าสุด HH:MM · who" — the highest-version CURRENT picture (ties
  // broken by version, same rule storage.ts's `latestCurrent` uses server-
  // side), never re-derived from `attachment.latestAt`/`latestVersion`
  // separately (this way the caption and the gallery's own thumbnails can
  // never disagree with each other).
  const latest =
    currentAttachments.length > 0 ? currentAttachments.reduce((a, b) => (b.version > a.version ? b : a)) : null;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium text-ink-muted">{KIND_LABEL_TH[row.kind]}</span>
            {showBadge && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-semibold text-white">
                {attachment.count}
              </span>
            )}
          </span>
          <span className="font-semibold text-ink">{row.guestName ?? "ไม่ทราบชื่อ"}</span>
          <RefsLine row={row} />
        </div>
        <span className="text-sm font-semibold tabular-nums text-ink">{formatSatang(row.amountSatang)}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {currentAttachments.map((a) => (
          <div key={a.version} className="flex flex-col items-center gap-0.5">
            <div className="relative">
              <a href={pictureUrl(property, row.auditKey, a.version)} target="_blank" rel="noreferrer" title="ดูรูปเต็ม">
                <img
                  src={thumbUrl(property, row.auditKey, a.version)}
                  alt={`สลิปของ ${row.auditKey} เวอร์ชัน ${a.version}`}
                  className="h-16 w-16 rounded-md object-cover"
                />
              </a>
              <button
                type="button"
                onClick={() => onRequestRemove(a.version)}
                aria-label="นำออก"
                title="นำออก"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs leading-none text-white hover:bg-bad"
              >
                ×
              </button>
            </div>
            <span className="text-[10px] text-ink-muted">{timeBangkok(a.createdAt) ?? ""}</span>
          </div>
        ))}

        <button
          type="button"
          onClick={onAddMore}
          className="flex h-16 w-16 flex-col items-center justify-center gap-0.5 rounded-md border-2 border-dashed border-line-strong text-[10px] text-ink-muted hover:border-brand-300 hover:bg-tint"
        >
          <span className="text-base leading-none text-brand-500">+</span>
          <span>เพิ่มรูป</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-1">
        <button type="button" onClick={onShowHistory} className="text-[11px] text-brand-500 hover:underline">
          ประวัติ ({nHistory} รายการ)
        </button>
        {latest && (
          <span className="text-[11px] text-ink-muted">
            แนบล่าสุด {timeBangkok(latest.createdAt) ?? "-"} · {latest.createdBy}
          </span>
        )}
      </div>
    </li>
  );
}
