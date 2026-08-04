import { useEffect, useState } from "react";
import { isoToBuddhist, shiftDays, timeBangkok } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import { DEPOSIT_TENDER_LABELS_TH, type DepositTender, type Property } from "../../shared/types.ts";
import {
  ApiError,
  checkPaymentAudit,
  getDayAudit,
  uncheckPaymentAudit,
  type DayAuditCheckinRow,
  type DayAuditRow,
} from "../api.ts";
import { navigate } from "../App.tsx";
import { DateBar } from "../components/DateBar.tsx";

interface Props {
  property: Property;
  date: string;
  onDateChange: (date: string) => void;
}

/** ตรวจรายวัน — the office day-audit hub's queue (Wave 1, docs/plan-audit-
 * hub-slips.md). One row per PAYMENT SETTLEMENT for the selected day
 * (src/server/day-audit.ts's stay-merged reshaping), split into a รอตรวจ
 * queue (pending, on top) and a ตรวจแล้ว queue (done, calm, below) — the
 * owner's explicit ask: buttons, not checkboxes; the day is "done" when
 * รอตรวจ is empty. Money is never editable here, only the audit tick —
 * mirrors the register's own "read-only over the PMS" contract.
 *
 * Optimistic check/uncheck: a click moves the row to the other queue
 * immediately (rollback + an error line on failure) rather than waiting for
 * the round trip — the same UX the register's DepositNoteEditor established
 * for its own save button, just applied to a move-between-lists action
 * instead of an in-place field.
 */
export function DayAuditQueue({ property, date, onDateChange }: Props) {
  const [rows, setRows] = useState<DayAuditRow[] | null>(null);
  const [pullStatus, setPullStatus] = useState(false);
  const [pmsNotConfigured, setPmsNotConfigured] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setPullStatus(false);
    setPmsNotConfigured(false);
    setLoadError(null);
    setActionError(null);

    getDayAudit(property, date)
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        setPullStatus(res.pullStatus);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 503) {
          setPmsNotConfigured(true);
          return;
        }
        setLoadError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      });

    return () => {
      cancelled = true;
    };
  }, [property, date]);

  function setBusy(auditKey: string, busy: boolean) {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(auditKey);
      else next.delete(auditKey);
      return next;
    });
  }

  async function handleCheck(auditKey: string) {
    setActionError(null);
    setBusy(auditKey, true);
    // Optimistic move into ตรวจแล้ว — checkedAt/checkedBy are filled in once
    // the real response lands (shown as "-" in the interim, never guessed).
    setRows((prev) => prev?.map((r) => (r.auditKey === auditKey ? { ...r, checked: true, checkedAt: null, checkedBy: null } : r)) ?? prev);
    try {
      const saved = await checkPaymentAudit(property, auditKey, date);
      setRows(
        (prev) =>
          prev?.map((r) =>
            r.auditKey === auditKey ? { ...r, checked: true, checkedAt: saved.checkedAt, checkedBy: saved.checkedBy } : r,
          ) ?? prev,
      );
    } catch (err) {
      // Rollback — the row returns to รอตรวจ.
      setRows((prev) => prev?.map((r) => (r.auditKey === auditKey ? { ...r, checked: false, checkedAt: null, checkedBy: null } : r)) ?? prev);
      setActionError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(auditKey, false);
    }
  }

  async function handleUncheck(auditKey: string) {
    setActionError(null);
    setBusy(auditKey, true);
    const snapshot = rows?.find((r) => r.auditKey === auditKey) ?? null;
    setRows((prev) => prev?.map((r) => (r.auditKey === auditKey ? { ...r, checked: false, checkedAt: null, checkedBy: null } : r)) ?? prev);
    try {
      await uncheckPaymentAudit(property, auditKey);
    } catch (err) {
      // Rollback — restore the exact prior (checked/checkedAt/checkedBy) snapshot.
      if (snapshot) {
        setRows((prev) => prev?.map((r) => (r.auditKey === auditKey ? snapshot : r)) ?? prev);
      }
      setActionError(err instanceof Error ? err.message : "ยกเลิกการตรวจไม่สำเร็จ");
    } finally {
      setBusy(auditKey, false);
    }
  }

  if (pmsNotConfigured) {
    return (
      <div className="flex flex-col gap-3">
        <DateBar date={date} onPick={onDateChange} onShift={(d) => onDateChange(shiftDays(date, d))} />
        <div className="rounded-lg border border-line bg-panel px-4 py-6 text-center text-sm text-ink-muted">
          ยังไม่ได้เชื่อมต่อ PMS สำหรับโรงแรมนี้
        </div>
      </div>
    );
  }

  const pending = rows?.filter((r) => !r.checked) ?? [];
  const done = rows?.filter((r) => r.checked) ?? [];
  const checkedCount = done.length;
  const totalCount = rows?.length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <DateBar date={date} onPick={onDateChange} onShift={(d) => onDateChange(shiftDays(date, d))} />

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
        <span className="text-ink">
          ตรวจแล้ว <span className="font-semibold tabular-nums">{checkedCount}</span>/
          <span className="font-semibold tabular-nums">{totalCount}</span> · ค้าง{" "}
          <span className="font-semibold tabular-nums">{totalCount - checkedCount}</span>
        </span>
        {rows !== null && (
          <div className="flex items-center gap-2">
            {pullStatus ? (
              <span className="rounded-full bg-ok/15 px-2.5 py-1 text-xs font-medium text-ok">ดึงข้อมูลแล้ว</span>
            ) : (
              <button
                type="button"
                onClick={() => navigate(`/${property}/bookings/${date}`)}
                className="rounded-full bg-gold-100 px-2.5 py-1 text-xs font-medium text-warn hover:brightness-95"
                title="ไปหน้ารายละเอียดรายรับเพื่อดึงข้อมูลจาก PMS"
              >
                ยังไม่ได้ดึงข้อมูล
              </button>
            )}
          </div>
        )}
      </div>

      {loadError && (
        <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">โหลดข้อมูลไม่สำเร็จ: {loadError}</div>
      )}
      {actionError && <p className="text-xs text-bad">{actionError}</p>}

      {loadError ? null : rows === null ? (
        <div className="p-6 text-sm text-ink-muted">กำลังโหลด...</div>
      ) : (
        <>
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">รอตรวจ</h2>
            {pending.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-muted">
                {totalCount === 0 ? "ไม่มีรายการชำระเงินสำหรับวันนี้" : "ตรวจครบทุกรายการแล้ว"}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem] text-sm">
                  <thead>
                    <tr className="border-b border-line bg-tint text-xs font-semibold text-ink-muted">
                      <th className="px-4 py-2 text-left">ประเภท</th>
                      <th className="px-4 py-2 text-left">ลูกค้า / อ้างอิง</th>
                      <th className="px-4 py-2 text-right">ยอด</th>
                      <th className="px-4 py-2 text-left">การชำระ</th>
                      <th className="px-4 py-2 text-left">สลิป</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {pending.map((row) => (
                      <tr key={row.auditKey}>
                        <RowCells row={row} property={property} />
                        <td className="px-4 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void handleCheck(row.auditKey)}
                            disabled={busyKeys.has(row.auditKey)}
                            className="rounded-md bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                          >
                            ตรวจแล้ว
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {done.length > 0 && (
            <section className="overflow-hidden rounded-lg border border-line bg-panel opacity-90">
              <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">ตรวจแล้ว</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-sm">
                  <thead>
                    <tr className="border-b border-line bg-tint text-xs font-semibold text-ink-muted">
                      <th className="px-4 py-2 text-left">ประเภท</th>
                      <th className="px-4 py-2 text-left">ลูกค้า / อ้างอิง</th>
                      <th className="px-4 py-2 text-right">ยอด</th>
                      <th className="px-4 py-2 text-left">การชำระ</th>
                      <th className="px-4 py-2 text-left">สลิป</th>
                      <th className="px-4 py-2 text-left">ตรวจโดย</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line text-ink-muted">
                    {done.map((row) => (
                      <tr key={row.auditKey}>
                        <RowCells row={row} property={property} />
                        <td className="px-4 py-2 text-xs">
                          {row.checkedAt === null ? (
                            "กำลังบันทึก..."
                          ) : (
                            <span>
                              {row.checkedBy ?? "-"}
                              <br />
                              <span className="text-[11px]">{formatCheckedAt(row.checkedAt)}</span>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void handleUncheck(row.auditKey)}
                            disabled={busyKeys.has(row.auditKey)}
                            className="rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
                          >
                            ยกเลิกการตรวจ
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

const KIND_LABEL_TH: Record<DayAuditRow["kind"], string> = {
  checkin: "เช็คอิน",
  deposit: "รับมัดจำ",
  refund: "คืนเงิน",
};

/** ยอด — a เช็คอิน row shows its gross folio total; รับมัดจำ/คืนเงิน rows show
 * their own settlement amount (คืนเงิน negative). */
function rowAmountSatang(row: DayAuditRow): number {
  return row.kind === "checkin" ? row.grossSatang : row.amountSatang;
}

/** The two shared cells (ประเภท / ลูกค้า+อ้างอิง) plus ยอด/การชำระ/สลิป — one
 * function so the pending and done tables never drift on layout, only on
 * the trailing action/who-when cell each table appends itself. */
function RowCells({ row, property }: { row: DayAuditRow; property: Property }) {
  return (
    <>
      <td className="px-4 py-2 align-top">
        <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium text-ink-muted">
          {KIND_LABEL_TH[row.kind]}
          {row.kind === "refund" && row.refundOf === "excess" && " (ส่วนเกิน)"}
        </span>
      </td>
      <td className="px-4 py-2 align-top">
        <RefCell row={row} />
      </td>
      <td className={"px-4 py-2 text-right align-top tabular-nums " + (row.kind === "refund" ? "text-bad" : "text-ink")}>
        {formatSatang(rowAmountSatang(row))}
      </td>
      <td className="px-4 py-2 align-top">
        <CompositionCell row={row} />
      </td>
      <td className="px-4 py-2 align-top">
        <SlipProofCell row={row} property={property} />
      </td>
    </>
  );
}

/** True iff this settlement carries a nonzero TRANSFER component anywhere —
 * a เช็คอิน row's own transfer tender, or a รับมัดจำ/คืนเงิน row whose own
 * `tender` is `"transfer"`. This is the client's OWN copy of
 * src/server/day-audit.ts's `needsSlipProof` (Wave 2, docs/plan-audit-hub-
 * slips.md) — a small pure predicate, kept as a separate literal rather
 * than imported (the client never imports server-only modules; same "never
 * invert the natural dependency direction" reasoning this codebase already
 * documents for its other small duplicated predicates/constants, e.g.
 * deposit-register.ts's DEPOSIT_R_NUMBER_RE). */
function needsSlipProof(row: DayAuditRow): boolean {
  if (row.kind === "checkin") return row.composition.transferSatang !== 0;
  return row.tender === "transfer";
}

/** สลิป cell (Wave 2): a settlement that never needed a transfer slip shows
 * a plain dash. One that does shows either a thumbnail + count (a ledger-
 * proxied, auth'd route — GET /api/:property/audit/proof-thumb/:auditKey —
 * so the office browser never needs the slips origin directly) or a
 * รอสลิป chip when `proofsPending` — a missing slip is an audit signal on
 * both sides, per the plan. The thumbnail img has no onError fallback
 * beyond simply not rendering broken-image chrome poorly — a 404/502 from
 * the proxy (slips service down, or genuinely no thumbnail yet) is exactly
 * as informative as รอสลิป would be, so this stays a thin `<img>`, never a
 * second network call to check existence first. */
function SlipProofCell({ row, property }: { row: DayAuditRow; property: Property }) {
  if (!needsSlipProof(row)) return <span className="text-ink-muted">-</span>;

  if (row.proofsPending) {
    return <span className="rounded-full bg-bad/15 px-2 py-0.5 text-[11px] font-semibold text-bad">รอสลิป</span>;
  }

  return (
    <span className="flex items-center gap-1">
      <img
        src={`/api/${property}/audit/proof-thumb/${encodeURIComponent(row.auditKey)}`}
        alt={`สลิปของ ${row.auditKey}`}
        className="h-8 w-8 rounded-md object-cover"
        loading="lazy"
      />
      {row.proofCount > 1 && <span className="text-[11px] font-medium text-ink-muted">×{row.proofCount}</span>}
    </span>
  );
}

/** Compact "· 14:32" suffix for the refs line — muted, no seconds (the
 * date+time DESCENDING sort, owner ask 2026-08-04, is only legible if the
 * time it's sorting by is actually shown). Omitted entirely when
 * `paidAtIso` is `null` (never a guessed/blank time). */
function PaidAtChip({ paidAtIso }: { paidAtIso: string | null }) {
  const time = timeBangkok(paidAtIso);
  if (time === null) return null;
  return <span className="text-ink-muted"> · {time}</span>;
}

function RefCell({ row }: { row: DayAuditRow }) {
  if (row.kind === "checkin") {
    return (
      <span className="flex flex-col gap-0.5">
        {row.guestName && <span className="font-semibold text-ink">{row.guestName}</span>}
        <span className="text-[11px] text-ink-muted">
          {row.chRef}
          {row.receiptPayNos.length > 0 && <> · {row.receiptPayNos.join(" · ")}</>}
          <PaidAtChip paidAtIso={row.paidAtIso} />
        </span>
      </span>
    );
  }
  if (row.kind === "deposit") {
    return (
      <span className="flex flex-col gap-0.5">
        {row.guestName && <span className="font-semibold text-ink">{row.guestName}</span>}
        <span className="text-[11px] text-ink-muted">
          {row.rRef} · {row.payNo}
          <PaidAtChip paidAtIso={row.paidAtIso} />
        </span>
        {row.checkinDateBangkok && (
          <span className="text-[11px] text-ink-muted">เช็คอิน {isoToBuddhist(row.checkinDateBangkok)}</span>
        )}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5">
      {row.guestName && <span className="font-semibold text-ink">{row.guestName}</span>}
      <span className="text-[11px] text-ink-muted">
        {row.ref} · {row.payNo}
        <PaidAtChip paidAtIso={row.paidAtIso} />
      </span>
      {row.overRefundedWarning && (
        <span className="text-[11px] font-medium text-bad">ใบรับถูกยกเลิกแต่รายการคืนเงินยังไม่ถูกยกเลิก — ตรวจสอบใน iHOTEL</span>
      )}
    </span>
  );
}

function tenderLabel(tender: DepositTender): string {
  return DEPOSIT_TENDER_LABELS_TH[tender];
}

function CompositionCell({ row }: { row: DayAuditRow }) {
  if (row.kind === "checkin") {
    return <CheckinComposition row={row} />;
  }
  return (
    <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium text-ink-muted">
      {row.tender ? tenderLabel(row.tender) : "-"}
    </span>
  );
}

function CheckinComposition({ row }: { row: DayAuditCheckinRow }) {
  const { composition } = row;
  const parts: string[] = [];
  if (composition.cashSatang !== 0) parts.push(`เงินสด ${formatSatang(composition.cashSatang)}`);
  if (composition.transferSatang !== 0) parts.push(`โอน ${formatSatang(composition.transferSatang)}`);
  if (composition.creditSatang !== 0) parts.push(`เครดิต ${formatSatang(composition.creditSatang)}`);
  if (composition.webSatang !== 0) parts.push(`เว็บ ${formatSatang(composition.webSatang)}`);
  if (composition.penaltySatang !== 0) parts.push(`ค่าปรับ ${formatSatang(composition.penaltySatang)}`);

  return (
    <span className="flex flex-wrap items-center gap-1">
      {parts.length > 0 && (
        <span className="rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium text-ink-muted">
          {parts.join(" · ")}
        </span>
      )}
      {row.depositApplied && (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1">
            <span className="rounded-full bg-gold-100 px-2 py-0.5 text-[11px] font-semibold text-warn">
              มัดจำ {formatSatang(row.depositApplied.amountSatang)}
            </span>
            {row.depositApplied.mismatch && (
              <span className="rounded-full bg-bad/15 px-2 py-0.5 text-[11px] font-semibold text-bad">ยอดไม่ตรง</span>
            )}
          </span>
          <span className="text-[11px] text-ink-muted">
            {[
              row.depositApplied.receivedPayNo,
              row.depositApplied.receivedDateBangkok ? isoToBuddhist(row.depositApplied.receivedDateBangkok) : null,
              row.depositApplied.receivedTender ? tenderLabel(row.depositApplied.receivedTender) : null,
            ]
              .filter((p): p is string => !!p)
              .join(" · ") || "ไม่พบใบรับ"}
            {row.depositApplied.receivedPayNo && (row.depositApplied.receivedChecked ? " · ใบรับตรวจแล้ว" : " · ใบรับยังไม่ตรวจ")}
          </span>
        </span>
      )}
    </span>
  );
}

function formatCheckedAt(checkedAtUtc: string): string {
  const iso = checkedAtUtc.includes("T") ? checkedAtUtc : `${checkedAtUtc.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return checkedAtUtc;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
