import { useEffect, useMemo, useState } from "react";
import { daysBetween, isoToBuddhist, monthToThaiLong, todayBangkok } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import type { Property } from "../../shared/types.ts";
import {
  ApiError,
  getDepositRegister,
  type DepositAgingRow,
  type DepositMismatchedException,
  type DepositOrphanAppliedException,
  type DepositRegisterResponse,
} from "../api.ts";
import { DepositNoteEditor } from "../components/DepositNoteEditor.tsx";
import { PropertyBadge } from "./PropertyBadge.tsx";

interface Props {
  property: Property;
}

type NoteFields = { note: string | null; resolvedAt: string | null; resolvedBy: string | null };

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
 * Sections, top to bottom (D4): สรุปรายเดือน (newest first) -> เงินมัดจำคงค้าง
 * aging (oldest first) -> ข้อยกเว้น (mismatched, orphanApplied) -> a
 * collapsed, greyed voided footnote. Desktop-wide layout, same shell width
 * convention as HistoryPage.tsx (this office runs on one desktop PC, not a
 * thumb-optimised second layout).
 */
export function DepositRegisterPage({ property }: Props) {
  const [register, setRegister] = useState<DepositRegisterResponse | null>(null);
  const [pmsNotConfigured, setPmsNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgingR, setExpandedAgingR] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setRegister(null);
    setPmsNotConfigured(false);
    setError(null);
    setExpandedAgingR(new Set());

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

  function toggleAgingExpanded(rNumber: string) {
    setExpandedAgingR((prev) => {
      const next = new Set(prev);
      if (next.has(rNumber)) next.delete(rNumber);
      else next.add(rNumber);
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
                  <tr key={row.month}>
                    <td className="px-4 py-2 text-ink">{monthToThaiLong(row.month)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.openingSatang)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.receivedSatang)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.appliedSatang)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.refundedSatang)}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold text-brand-500">
                      {formatSatang(row.closingSatang)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* เงินมัดจำคงค้าง */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">เงินมัดจำคงค้าง</h2>
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
                  {v.rNumber ?? "(ไม่ทราบเลขที่)"} — {v.kind === "received" ? "รับ" : v.kind === "applied" ? "ตัดยอด" : "คืนเงิน"}
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
        <td className="px-4 py-2 font-medium text-ink">{row.rNumber}</td>
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
        <span className="font-semibold text-ink">{row.rNumber}</span>
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
        <span className="font-semibold text-ink">{row.rNumber}</span>
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
