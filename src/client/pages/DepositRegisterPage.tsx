import { useEffect, useMemo, useState } from "react";
import { daysBetween, isoToBuddhist, monthToThaiLong, todayBangkok } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import {
  DEPOSIT_TENDER_LABELS_TH,
  DEPOSIT_THREAD_STATUS_LABELS_TH,
  type DepositThreadStatus,
  type Property,
} from "../../shared/types.ts";
import {
  ApiError,
  getDepositRegister,
  type DepositAgingRow,
  type DepositMismatchedException,
  type DepositMonthlyReconciliation,
  type DepositOrphanAppliedException,
  type DepositRegisterEvent,
  type DepositRegisterResponse,
} from "../api.ts";
import { DepositNoteEditor } from "../components/DepositNoteEditor.tsx";
import { PropertyBadge } from "./PropertyBadge.tsx";

interface Props {
  property: Property;
}

type NoteFields = { note: string | null; resolvedAt: string | null; resolvedBy: string | null };

/** รับ / ตัดยอด / คืนเงิน — the section's own wording for a deposit event's
 * kind. Shared by the voided footnote and the สรุปรายเดือน expandable event
 * list so the two never drift apart. */
function depositKindLabelTh(kind: "received" | "applied" | "refunded"): string {
  return kind === "received" ? "รับ" : kind === "applied" ? "ตัดยอด" : "คืนเงิน";
}

/** "R001153 · R2603-0140[ · CH26-005269]" — R-number, pay_no, and (applied
 * events only) the CH ref, so the office can trace an event back to the
 * actual PMS transaction (owner ask, 2026-08-01: "need some ref too so it's
 * map-able"). */
function depositEventRefLabel(event: DepositRegisterEvent): string {
  const parts = [event.rNumber, event.pmsRef, event.kind === "applied" ? event.chRef : null].filter(
    (p): p is string => !!p,
  );
  return parts.join(" · ");
}

/** Chip tone per `DepositThreadStatus` — reuses the app's own ok/warn/stone
 * semantic colors rather than inventing a new hue. Gold/warn for anything
 * still holding a balance (รอเช็คอิน, บางส่วน — "money the office is
 * holding"). ตัดยอดแล้ว and คืนเงินแล้ว are deliberately DIFFERENT tones even
 * though both are "closed out": applied means the money became revenue
 * (ok/green, matches the existing "แก้ไขแล้ว" resolved badge), refunded
 * means it left the estate (a neutral stone chip — closed, but not the
 * same "good outcome" signal as applied). */
const DEPOSIT_STATUS_CHIP_CLASS: Record<DepositThreadStatus, string> = {
  waitingCheckin: "bg-gold-100 text-warn",
  partial: "bg-gold-100 text-warn",
  applied: "bg-ok/15 text-ok",
  refunded: "bg-line text-ink-muted",
};

/** Owner ask (2026-08-01, explicit deposit state): every thread-shaped row
 * shows its status via this chip — see `DepositThreadStatus`'s doc comment
 * (shared/types.ts) for the four values' exact definitions. When the
 * status is `"applied"`/`"partial"` and a mapping exists, shows "where it
 * went" (the CH ref + applied date) right next to the chip so a used
 * deposit is traceable without opening the PMS. */
function StatusChip({
  status,
  appliedChRef,
  appliedDateBangkok,
}: {
  status: DepositThreadStatus;
  appliedChRef?: string | null;
  appliedDateBangkok?: string | null;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span
        className={"rounded-full px-2 py-0.5 text-[11px] font-medium leading-none " + DEPOSIT_STATUS_CHIP_CLASS[status]}
      >
        {DEPOSIT_THREAD_STATUS_LABELS_TH[status]}
      </span>
      {(status === "applied" || status === "partial") && appliedChRef && (
        <span className="text-[11px] text-ink-muted">
          → {appliedChRef}
          {appliedDateBangkok && <> ({isoToBuddhist(appliedDateBangkok)})</>}
        </span>
      )}
    </span>
  );
}

/** Small pill badge for an aging row's note state — gold whenever
 * unresolved (whether or not a note has been typed yet, so an untouched
 * exception still gets an office's attention), green once resolved. Click
 * toggles the row's inline editor. */
function NoteBadge({ note, resolvedAt, onClick }: NoteFields & { onClick: () => void }) {
  const label = resolvedAt !== null ? "แก้ไขแล้ว" : note !== null ? "มีบันทึก" : "ยังไม่มีบันทึก";
  const className =
    resolvedAt !== null
      ? "bg-ok/15 text-ok"
      : "bg-gold-100 text-warn"; // gold-when-unresolved, per the plan
  return (
    <button
      type="button"
      onClick={onClick}
      className={"rounded-full px-2 py-0.5 text-[11px] font-medium leading-none " + className}
    >
      {label}
    </button>
  );
}

/**
 * ทะเบียนมัดจำล่วงหน้า — the office deposit register (Wave D, issue #5). A
 * read-only view over the PMS's full deposit-lifecycle history (money is
 * never editable here — only office notes are), route `/:property/deposits`,
 * nav label "มัดจำ". No gating beyond the property's own PMS configuration:
 * this app carries no roles.
 *
 * Sections, top to bottom (D4, extended 2026-08-01 for explicit deposit
 * state): สรุปรายเดือน (newest first, each month expandable into its
 * chronological event list) -> เงินมัดจำคงค้าง (รอเช็คอิน) aging (oldest
 * first, every row carrying an explicit `DepositThreadStatus` chip) ->
 * ตัดยอดแล้วล่าสุด (a fully-applied deposit never appears in aging by
 * definition — this is where it's found without hunting through months)
 * -> ข้อยกเว้น (mismatched, orphanApplied) -> a collapsed, greyed voided
 * footnote. Desktop-wide layout, same shell width convention as
 * HistoryPage.tsx (this office runs on one desktop PC, not a
 * thumb-optimised second layout).
 */
export function DepositRegisterPage({ property }: Props) {
  const [register, setRegister] = useState<DepositRegisterResponse | null>(null);
  const [pmsNotConfigured, setPmsNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgingR, setExpandedAgingR] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setRegister(null);
    setPmsNotConfigured(false);
    setError(null);
    setExpandedAgingR(new Set());
    setExpandedMonths(new Set());

    getDepositRegister(property)
      .then((res) => {
        if (!cancelled) setRegister(res);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 503) {
          setPmsNotConfigured(true);
          return;
        }
        setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      });

    return () => {
      cancelled = true;
    };
  }, [property]);

  /** Applies a saved note onto EVERY row (aging AND both exception lists)
   * sharing this `rNumber` — a thread can be aging (still outstanding) and
   * separately flagged mismatched at once, and the note is the same
   * conversation either way (see DepositNoteEditor's own doc comment). */
  function applyNoteChange(rNumber: string, fields: NoteFields) {
    setRegister((prev) => {
      if (!prev) return prev;
      const patchRow = <T extends { rNumber: string }>(rows: T[]): T[] =>
        rows.map((row) => (row.rNumber === rNumber ? { ...row, ...fields } : row));
      return {
        ...prev,
        aging: patchRow(prev.aging),
        exceptions: {
          mismatched: patchRow(prev.exceptions.mismatched),
          orphanApplied: patchRow(prev.exceptions.orphanApplied),
        },
      };
    });
  }

  const monthlyNewestFirst = useMemo(() => (register ? [...register.monthly].reverse() : []), [register]);
  const today = todayBangkok();

  // Owner ask (2026-08-01): a fully-applied deposit never appears in
  // `aging` (outstanding <= 0 by definition) and only a `mismatched`
  // exception if it's ALSO over/under by more than the tolerance — so most
  // of them appear in NEITHER list. Rather than make the office hunt
  // through every month's expandable row, the most recently applied
  // EVENTS (not threads — an R-number can in principle apply across more
  // than one stay) surface directly here, newest first, capped so the
  // section stays a quick-scan list rather than a second full register.
  const RECENTLY_APPLIED_LIMIT = 20;
  const recentlyApplied = useMemo(() => {
    if (!register) return [];
    return register.events
      .filter((e) => e.kind === "applied" && !e.voided)
      .slice()
      .sort((a, b) => (b.dateBangkok ?? "").localeCompare(a.dateBangkok ?? ""))
      .slice(0, RECENTLY_APPLIED_LIMIT);
  }, [register]);

  function toggleAgingExpanded(rNumber: string) {
    setExpandedAgingR((prev) => {
      const next = new Set(prev);
      if (next.has(rNumber)) next.delete(rNumber);
      else next.add(rNumber);
      return next;
    });
  }

  function toggleMonthExpanded(month: string) {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month);
      else next.add(month);
      return next;
    });
  }

  if (pmsNotConfigured) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader property={property} />
        <div className="rounded-lg border border-line bg-panel px-4 py-6 text-center text-sm text-ink-muted">
          ยังไม่ได้เชื่อมต่อ PMS สำหรับโรงแรมนี้
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader property={property} />
        <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">
          โหลดข้อมูลไม่สำเร็จ: {error}
        </div>
      </div>
    );
  }

  if (!register) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader property={property} />
        <div className="p-6 text-sm text-ink-muted">กำลังโหลด...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-10">
      <PageHeader property={property} />
      <div className="flex flex-col gap-1 text-xs text-ink-muted">
        <p>ข้อมูล ณ {new Date(register.generatedAt).toLocaleString("th-TH")}</p>
        {/* Tripwire lines — none of these ever invent or drop money; each
            names a way a row can otherwise leave the register with zero
            signal (review fix — see deposit-register.ts's
            DepositRegisterData doc comment for what each one means). */}
        {register.unparsedAppliedRows > 0 && (
          <p className="font-medium text-warn">
            พบรายการตัดยอด {register.unparsedAppliedRows} รายการที่อ่านเลขที่การจองไม่ได้ — ตรวจสอบใน PMS
          </p>
        )}
        {register.zeroTenderRows > 0 && (
          <p className="font-medium text-warn">
            พบรายการรับ/คืนเงิน {register.zeroTenderRows} รายการที่ไม่มีจำนวนเงินในช่องเงินสด/โอน/เครดิต/เว็บ แต่มียอดอื่นในรายการ — ตรวจสอบใน PMS
          </p>
        )}
        {register.blankBookingNoRows > 0 && (
          <p className="font-medium text-warn">
            พบรายการรับ/คืนเงิน {register.blankBookingNoRows} รายการที่ไม่มีเลขที่การจอง — ไม่แสดงในทะเบียนคงค้างหรือข้อยกเว้น
          </p>
        )}
        {register.undatedRows > 0 && (
          <p className="font-medium text-warn">
            พบรายการ {register.undatedRows} รายการที่อ่านวันที่ไม่ได้ — ไม่รวมในสรุปรายเดือน
          </p>
        )}
      </div>

      {/* สรุปรายเดือน */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">สรุปรายเดือน</h2>
        {monthlyNewestFirst.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">ยังไม่มีข้อมูลมัดจำล่วงหน้า</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-line bg-tint text-xs font-semibold text-ink-muted">
                  <th className="px-4 py-2 text-left">เดือน</th>
                  <th className="px-4 py-2 text-right">ยอดยกมา</th>
                  <th className="px-4 py-2 text-right">รับ</th>
                  <th className="px-4 py-2 text-right">ตัดยอด</th>
                  <th className="px-4 py-2 text-right">คืนเงิน</th>
                  <th className="px-4 py-2 text-right">ยอดยกไป</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {monthlyNewestFirst.map((row) => (
                  <MonthlyRow
                    key={row.month}
                    row={row}
                    events={register.events}
                    expanded={expandedMonths.has(row.month)}
                    onToggle={() => toggleMonthExpanded(row.month)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* เงินมัดจำคงค้าง — explicitly the รอเช็คอิน/บางส่วน buckets (owner ask,
          2026-08-01: the heading must say what state these rows are in). */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">เงินมัดจำคงค้าง (รอเช็คอิน)</h2>
        {register.aging.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">ไม่มีมัดจำล่วงหน้าคงค้าง</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-line bg-tint text-xs font-semibold text-ink-muted">
                  <th className="px-4 py-2 text-left">เลขที่</th>
                  <th className="px-4 py-2 text-right">รับ</th>
                  <th className="px-4 py-2 text-right">ตัดยอด</th>
                  <th className="px-4 py-2 text-right">คืนเงิน</th>
                  <th className="px-4 py-2 text-right">คงค้าง</th>
                  <th className="px-4 py-2 text-right">ค้างมา (วัน)</th>
                  <th className="px-4 py-2 text-left">บันทึก</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {register.aging.map((row) => (
                  <AgingRow
                    key={row.rNumber}
                    property={property}
                    row={row}
                    today={today}
                    expanded={expandedAgingR.has(row.rNumber)}
                    onToggle={() => toggleAgingExpanded(row.rNumber)}
                    onNoteSaved={(fields) => applyNoteChange(row.rNumber, fields)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ตัดยอดแล้วล่าสุด — owner ask (2026-08-01): a fully-applied deposit
          maps only here (or inside a month's expandable row) — it never
          appears in the aging list above, and only lands in ข้อยกเว้น when
          the applied amount also fails the mismatch tolerance. */}
      {recentlyApplied.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-line bg-panel">
          <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">ตัดยอดแล้วล่าสุด</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-line bg-tint text-xs font-semibold text-ink-muted">
                  <th className="px-4 py-2 text-left">วันที่</th>
                  <th className="px-4 py-2 text-left">เลขที่ / อ้างอิง</th>
                  <th className="px-4 py-2 text-right">จำนวนเงิน</th>
                  <th className="px-4 py-2 text-left">สถานะ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {recentlyApplied.map((event, i) => (
                  <tr key={`${event.pmsRef}-${i}`}>
                    <td className="px-4 py-2 tabular-nums text-ink-muted">
                      {event.dateBangkok ? isoToBuddhist(event.dateBangkok) : "-"}
                    </td>
                    <td className="px-4 py-2 text-ink">{depositEventRefLabel(event)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(event.amountSatang)}</td>
                    <td className="px-4 py-2">
                      <StatusChip status="applied" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ข้อยกเว้น */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">ข้อยกเว้น</h2>

        <div className="flex flex-col gap-1 px-4 py-3">
          <h3 className="text-xs font-semibold text-ink-muted">ยอดตัดยอดไม่ตรงกับยอดรับ</h3>
          {register.exceptions.mismatched.length === 0 ? (
            <p className="text-sm text-ink-muted">ไม่มีรายการ</p>
          ) : (
            <div className="flex flex-col gap-3">
              {register.exceptions.mismatched.map((row) => (
                <MismatchedRow
                  key={row.rNumber}
                  property={property}
                  row={row}
                  onNoteSaved={(fields) => applyNoteChange(row.rNumber, fields)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1 border-t border-line px-4 py-3">
          <h3 className="text-xs font-semibold text-ink-muted">ตัดยอดโดยไม่มีเงินรับ</h3>
          {register.exceptions.orphanApplied.length === 0 ? (
            <p className="text-sm text-ink-muted">ไม่มีรายการ</p>
          ) : (
            <div className="flex flex-col gap-3">
              {register.exceptions.orphanApplied.map((row) => (
                <OrphanAppliedRow
                  key={row.rNumber}
                  property={property}
                  row={row}
                  onNoteSaved={(fields) => applyNoteChange(row.rNumber, fields)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Voided — collapsed, greyed, excluded from every total above */}
      {register.voided.length > 0 && (
        <details className="rounded-lg border border-line bg-panel px-4 py-2.5 text-sm text-ink-muted">
          <summary className="cursor-pointer select-none text-xs font-semibold">
            รายการที่ถูกยกเลิก ({register.voided.length} รายการ)
          </summary>
          <div className="mt-2 flex flex-col gap-1">
            {register.voided.map((v, i) => (
              <div key={`${v.rNumber ?? "unknown"}-${i}`} className="flex items-center justify-between gap-3 text-xs">
                <span>
                  {v.rNumber ?? "(ไม่ทราบเลขที่)"} — {depositKindLabelTh(v.kind)}
                  {v.dateBangkok && <> ({isoToBuddhist(v.dateBangkok)})</>}
                </span>
                <span className="tabular-nums">{formatSatang(v.amountSatang)}</span>
              </div>
            ))}
            <p className="mt-1 text-[11px] italic">ไม่รวมในยอดข้างต้น</p>
          </div>
        </details>
      )}
    </div>
  );
}

/** R-number + its received event's pay_no as secondary muted text, plus its
 * explicit `StatusChip` — owner ask (2026-08-01): "need some ref too so
 * it's map-able" (the pay_no) and an unambiguous state per thread (the
 * chip). `receivedPmsRef` is `null` for `OrphanAppliedRow` (no received
 * event exists by definition) — renders the R-number alone in that case. */
function RNumberRef({
  rNumber,
  receivedPmsRef,
  status,
  appliedChRef,
  appliedDateBangkok,
}: {
  rNumber: string;
  receivedPmsRef: string | null;
  status: DepositThreadStatus;
  appliedChRef: string | null;
  appliedDateBangkok: string | null;
}) {
  return (
    <span className="flex flex-col gap-1">
      <span className="font-semibold text-ink">{rNumber}</span>
      {receivedPmsRef && <span className="text-[11px] font-normal text-ink-muted">{receivedPmsRef}</span>}
      <StatusChip status={status} appliedChRef={appliedChRef} appliedDateBangkok={appliedDateBangkok} />
    </span>
  );
}

function PageHeader({ property }: { property: Property }) {
  return (
    <div className="flex items-center justify-between">
      <h1 className="flex items-center gap-2 text-sm font-semibold text-ink">
        ทะเบียนมัดจำล่วงหน้า
        <PropertyBadge property={property} />
      </h1>
    </div>
  );
}

/**
 * One สรุปรายเดือน row, expandable (owner ask, 2026-08-01: "need some ref
 * too so it's map-able" — a month's totals alone can't be traced back to
 * any actual transaction). Same interaction feel as `AgingRow`'s inline
 * expand: click toggles, a following `<tr>` (not a nested `<details>`, so
 * it can hold its own `<table>` cleanly inside the outer table's grid)
 * lists that month's events chronologically. `events` is the FULL register
 * feed — filtered here to this row's month by `dateBangkok`'s `"YYYY-MM"`
 * prefix, the same grouping key `buildMonthlyReconciliation` (server)
 * itself uses, so a month's event list can never disagree with its totals
 * row. Voided events are included (greyed, "(ยกเลิก)") but never advance
 * the running balance — mirrors `buildMonthlyReconciliation`'s own
 * voided-excluded sums.
 */
function MonthlyRow({
  row,
  events,
  expanded,
  onToggle,
}: {
  row: DepositMonthlyReconciliation;
  events: DepositRegisterEvent[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const monthEvents = useMemo(
    () =>
      events
        .filter((e) => e.dateBangkok !== null && e.dateBangkok.slice(0, 7) === row.month)
        .slice()
        .sort((a, b) => (a.dateBangkok ?? "").localeCompare(b.dateBangkok ?? "")),
    [events, row.month],
  );

  // Running balance within the month, seeded from ยอดยกมา — voided events
  // never advance it (they carry no `runningBalance`, rendered "-"), same
  // sign convention buildMonthlyReconciliation's closingSatang uses:
  // received adds, applied/refunded subtract.
  let runningBalance = row.openingSatang;
  const eventRows = monthEvents.map((event) => {
    if (event.voided) return { event, runningBalance: null as number | null };
    runningBalance += event.kind === "received" ? event.amountSatang : -event.amountSatang;
    return { event, runningBalance };
  });

  return (
    <>
      <tr>
        <td className="px-4 py-2 text-ink">
          <button
            type="button"
            onClick={onToggle}
            disabled={monthEvents.length === 0}
            className="flex items-center gap-1.5 text-left disabled:cursor-default"
          >
            <span className="w-3 text-[10px] text-ink-muted">
              {monthEvents.length === 0 ? "" : expanded ? "▾" : "▸"}
            </span>
            {monthToThaiLong(row.month)}
          </button>
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.openingSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.receivedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.appliedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.refundedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums font-semibold text-brand-500">
          {formatSatang(row.closingSatang)}
        </td>
      </tr>
      {expanded && eventRows.length > 0 && (
        <tr>
          <td colSpan={6} className="bg-tint px-4 py-2.5">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-xs">
                <thead>
                  <tr className="text-left text-[11px] font-semibold text-ink-muted">
                    <th className="py-1 pr-3">วันที่</th>
                    <th className="py-1 pr-3">รายการ</th>
                    <th className="py-1 pr-3">เลขที่ / อ้างอิง</th>
                    <th className="py-1 pr-3">ช่องทาง</th>
                    <th className="py-1 pr-3 text-right">จำนวนเงิน</th>
                    <th className="py-1 text-right">ยอดคงเหลือ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/60">
                  {eventRows.map(({ event, runningBalance: bal }, i) => (
                    <tr
                      key={`${event.pmsRef}-${event.kind}-${i}`}
                      className={event.voided ? "text-ink-muted opacity-60" : "text-ink"}
                    >
                      <td className="py-1 pr-3 tabular-nums">
                        {event.dateBangkok ? isoToBuddhist(event.dateBangkok) : "-"}
                      </td>
                      <td className="py-1 pr-3">
                        {depositKindLabelTh(event.kind)}
                        {event.voided && <span className="ml-1 text-[10px] font-semibold text-bad">(ยกเลิก)</span>}
                      </td>
                      <td className="py-1 pr-3">{depositEventRefLabel(event)}</td>
                      <td className="py-1 pr-3">{event.tender ? DEPOSIT_TENDER_LABELS_TH[event.tender] : "-"}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {event.kind === "received" ? "+" : "-"}
                        {formatSatang(event.amountSatang)}
                      </td>
                      <td className="py-1 text-right tabular-nums">{bal !== null ? formatSatang(bal) : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AgingRow({
  property,
  row,
  today,
  expanded,
  onToggle,
  onNoteSaved,
}: {
  property: Property;
  row: DepositAgingRow;
  today: string;
  expanded: boolean;
  onToggle: () => void;
  onNoteSaved: (fields: NoteFields) => void;
}) {
  const daysOutstanding = row.firstEventDate ? daysBetween(row.firstEventDate, today) : null;
  return (
    <>
      <tr>
        <td className="px-4 py-2">
          <RNumberRef
            rNumber={row.rNumber}
            receivedPmsRef={row.receivedPmsRef}
            status={row.status}
            appliedChRef={row.appliedChRef}
            appliedDateBangkok={row.appliedDateBangkok}
          />
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.receivedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.appliedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.refundedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums font-semibold text-brand-500">
          {formatSatang(row.outstandingSatang)}
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{daysOutstanding ?? "-"}</td>
        <td className="px-4 py-2">
          <NoteBadge note={row.note} resolvedAt={row.resolvedAt} resolvedBy={row.resolvedBy} onClick={onToggle} />
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="bg-tint px-4 py-2.5">
            <DepositNoteEditor
              property={property}
              rNumber={row.rNumber}
              note={row.note}
              resolvedAt={row.resolvedAt}
              onSaved={onNoteSaved}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function MismatchedRow({
  property,
  row,
  onNoteSaved,
}: {
  property: Property;
  row: DepositMismatchedException;
  onNoteSaved: (fields: NoteFields) => void;
}) {
  return (
    <div className="rounded-md border border-warn/40 bg-gold-50 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <RNumberRef
          rNumber={row.rNumber}
          receivedPmsRef={row.receivedPmsRef}
          status={row.status}
          appliedChRef={row.appliedChRef}
          appliedDateBangkok={row.appliedDateBangkok}
        />
        <div className="flex items-center gap-3 tabular-nums">
          <span className="text-ink-muted">รับ {formatSatang(row.receivedSatang)}</span>
          <span className="text-ink-muted">ตัด {formatSatang(row.appliedSatang)}</span>
          <span className="font-semibold text-warn">
            ส่วนต่าง {row.diffSatang > 0 ? "+" : "-"}
            {formatSatang(Math.abs(row.diffSatang))}
          </span>
        </div>
      </div>
      <DepositNoteEditor
        property={property}
        rNumber={row.rNumber}
        note={row.note}
        resolvedAt={row.resolvedAt}
        onSaved={onNoteSaved}
      />
    </div>
  );
}

function OrphanAppliedRow({
  property,
  row,
  onNoteSaved,
}: {
  property: Property;
  row: DepositOrphanAppliedException;
  onNoteSaved: (fields: NoteFields) => void;
}) {
  return (
    <div className="rounded-md border border-warn/40 bg-gold-50 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <RNumberRef
          rNumber={row.rNumber}
          receivedPmsRef={row.receivedPmsRef}
          status={row.status}
          appliedChRef={row.appliedChRef}
          appliedDateBangkok={row.appliedDateBangkok}
        />
        <span className="font-semibold text-warn tabular-nums">ตัดยอด {formatSatang(row.appliedSatang)}</span>
      </div>
      <DepositNoteEditor
        property={property}
        rNumber={row.rNumber}
        note={row.note}
        resolvedAt={row.resolvedAt}
        onSaved={onNoteSaved}
      />
    </div>
  );
}
