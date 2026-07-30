import { useEffect, useMemo, useState, type ReactNode } from "react";
import { shiftDays } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import { computeBookingTotals, deriveCashBlock, lineArithmeticMismatch } from "../../shared/bookings.ts";
import {
  BOOKING_NO_MAX_LEN,
  COUNT_MAX,
  DESCRIPTION_MAX_LEN,
  GUEST_NAME_MAX_LEN,
  ROOM_NO_MAX_LEN,
  TENDERS,
  TENDER_LABELS_TH,
  type BookingLine,
  type CashBlockAmounts,
  type DaySheet,
  type OtherIncomeItem,
  type Property,
  type Tender,
} from "../../shared/types.ts";
import {
  createBookingLine,
  createOtherIncomeItem,
  deleteBookingLine,
  deleteOtherIncomeItem,
  fillFromBookings,
  getDay,
  getMe,
  listBookingLines,
  putCashBlock,
  updateBookingLine,
  updateOtherIncomeItem,
  type BookingLineInput,
  type FillFromBookingsDiffRow,
} from "../api.ts";
import { navigate } from "../App.tsx";
import { AmountInput } from "../components/AmountInput.tsx";
import { DateBar } from "../components/DateBar.tsx";

interface Props {
  property: Property;
  date: string;
}

// The paper's own labels for the **หมายเหตุ cash-banking block, in its
// printed order — see src/shared/types.ts CashBlockAmounts.
const CASH_BLOCK_FIELDS: { key: keyof CashBlockAmounts; label: string }[] = [
  { key: "roomCashSatang", label: "รายได้โรงแรมเงินสด" },
  { key: "otherCashSatang", label: "รายการอื่นๆเงินสด" },
  { key: "barCashSatang", label: "บาร์น้ำเงินสด" },
  { key: "bankedSatang", label: "สรุปเงินสดฝากเข้าบัญชี" },
];

function blankTenders(): Record<Tender, number> {
  return Object.fromEntries(TENDERS.map((tender) => [tender, 0])) as Record<Tender, number>;
}

/** Plain non-negative integer count (roomCount/nights), never money — a
 * lighter parse than shared money.ts's baht parser, clamped to COUNT_MAX. */
function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  return Math.min(Number(trimmed), COUNT_MAX);
}

type VarianceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: FillFromBookingsDiffRow[] };

/**
 * The per-booking daily income report (รายงานรายรับโรงแรมรายวัน) —
 * paper's other half beside the day-sheet summary. Route
 * /:property/bookings/:date. Mutations optimistic with rollback, matching
 * DaySheetPage's pattern; server-returned rows/totals win on success.
 */
export function BookingDayPage({ property, date }: Props) {
  const [lines, setLines] = useState<BookingLine[] | null>(null);
  const [daySheet, setDaySheet] = useState<DaySheet | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isManager, setIsManager] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [addingLine, setAddingLine] = useState(false);
  const [variance, setVariance] = useState<VarianceState>({ status: "loading" });

  useEffect(() => {
    getMe()
      .then((me) => setIsManager(me.isManager))
      .catch(() => {
        /* /api/me failing just means cash-block overrides stay read-only */
      });
  }, []);

  function refreshVariance() {
    setVariance({ status: "loading" });
    fillFromBookings(property, date, false)
      .then((res) => setVariance({ status: "ready", rows: res.diff }))
      .catch((err) =>
        setVariance({ status: "error", message: err instanceof Error ? err.message : "โหลดข้อมูลเปรียบเทียบไม่สำเร็จ" }),
      );
  }

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    setDaySheet(null);
    setLoadError(null);
    setExpandedId(null);
    setVariance({ status: "loading" });

    Promise.all([listBookingLines(property, date), getDay(property, date)])
      .then(([bookingsRes, sheet]) => {
        if (cancelled) return;
        setLines(bookingsRes.lines);
        setDaySheet(sheet);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      });

    fillFromBookings(property, date, false)
      .then((res) => {
        if (!cancelled) setVariance({ status: "ready", rows: res.diff });
      })
      .catch((err) => {
        if (!cancelled) {
          setVariance({ status: "error", message: err instanceof Error ? err.message : "โหลดข้อมูลเปรียบเทียบไม่สำเร็จ" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [property, date]);

  const sortedLines = useMemo(() => [...(lines ?? [])].sort((a, b) => a.seq - b.seq), [lines]);
  const bookingTotals = useMemo(() => computeBookingTotals(lines ?? []), [lines]);
  const monthClosed = daySheet?.monthClosed ?? false;

  // ── Booking lines ────────────────────────────────────────────────────

  async function addBookingLine() {
    setAddingLine(true);
    try {
      const created = await createBookingLine(property, date, {
        bookingNo: null,
        guestName: null,
        roomNo: null,
        roomCount: 1,
        nights: 1,
        grossRoomSatang: 0,
        grossOtherSatang: 0,
        discountSatang: 0,
        tenders: blankTenders(),
        remark: null,
        source: "manual",
        draft: false,
        sourceSheet: null,
      });
      setLines((prev) => [...(prev ?? []), created]);
      setExpandedId(created.id);
      refreshVariance();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "เพิ่มรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setAddingLine(false);
    }
  }

  async function commitLinePatch(line: BookingLine, patch: BookingLineInput) {
    const prevLines = lines;
    setLines((prev) => (prev ?? []).map((l) => (l.id === line.id ? { ...l, ...patch } : l)));
    try {
      const updated = await updateBookingLine(property, line.id, patch);
      setLines((prev) => (prev ?? []).map((l) => (l.id === updated.id ? updated : l)));
      refreshVariance();
    } catch (err) {
      setLines(prevLines);
      window.alert(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  async function removeLine(line: BookingLine) {
    if (!window.confirm("ลบรายการจองนี้ใช่หรือไม่")) return;
    const prevLines = lines;
    setLines((prev) => (prev ?? []).filter((l) => l.id !== line.id));
    if (expandedId === line.id) setExpandedId(null);
    try {
      await deleteBookingLine(property, line.id);
      refreshVariance();
    } catch (err) {
      setLines(prevLines);
      window.alert(err instanceof Error ? err.message : "ลบรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  // ── Itemized รายการอื่นๆ (other-income items) ────────────────────────

  const [newOtherDescription, setNewOtherDescription] = useState("");
  const [newOtherAmountText, setNewOtherAmountText] = useState("");
  const [newOtherIsCash, setNewOtherIsCash] = useState(true);
  const [addingOther, setAddingOther] = useState(false);
  const [newOtherError, setNewOtherError] = useState<string | null>(null);

  function applyOtherIncome(otherIncome: OtherIncomeItem[]) {
    setDaySheet((prev) =>
      prev
        ? {
            ...prev,
            otherIncome,
            cashBlock: { ...prev.cashBlock, derived: deriveCashBlock(prev.categories, prev.income, otherIncome) },
          }
        : prev,
    );
  }

  async function submitNewOtherIncome() {
    if (!daySheet) return;
    setNewOtherError(null);
    const amountSatang = parseAmountToSatang(newOtherAmountText);
    if (amountSatang === null || amountSatang <= 0) {
      setNewOtherError("กรอกจำนวนเงินให้ถูกต้อง (มากกว่า 0)");
      return;
    }
    setAddingOther(true);
    try {
      const description = newOtherDescription.trim() === "" ? null : newOtherDescription.trim().slice(0, DESCRIPTION_MAX_LEN);
      const created = await createOtherIncomeItem(property, date, { description, amountSatang, isCash: newOtherIsCash });
      applyOtherIncome([...daySheet.otherIncome, created]);
      setNewOtherDescription("");
      setNewOtherAmountText("");
      setNewOtherIsCash(true);
    } catch (err) {
      setNewOtherError(err instanceof Error ? err.message : "เพิ่มรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setAddingOther(false);
    }
  }

  async function commitOtherIncomeField(
    item: OtherIncomeItem,
    patch: Partial<{ description: string | null; amountSatang: number; isCash: boolean }>,
  ) {
    if (!daySheet) return;
    const prevOtherIncome = daySheet.otherIncome;
    const prevCashBlock = daySheet.cashBlock;
    applyOtherIncome(daySheet.otherIncome.map((o) => (o.id === item.id ? { ...o, ...patch } : o)));
    try {
      const updated = await updateOtherIncomeItem(property, item.id, patch);
      setDaySheet((prev) => {
        if (!prev) return prev;
        const otherIncome = prev.otherIncome.map((o) => (o.id === updated.id ? updated : o));
        return { ...prev, otherIncome, cashBlock: { ...prev.cashBlock, derived: deriveCashBlock(prev.categories, prev.income, otherIncome) } };
      });
    } catch (err) {
      setDaySheet((prev) => (prev ? { ...prev, otherIncome: prevOtherIncome, cashBlock: prevCashBlock } : prev));
      window.alert(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  async function removeOtherIncomeItem(item: OtherIncomeItem) {
    if (!daySheet) return;
    if (!window.confirm("ลบรายการนี้ใช่หรือไม่")) return;
    const prevOtherIncome = daySheet.otherIncome;
    const prevCashBlock = daySheet.cashBlock;
    applyOtherIncome(daySheet.otherIncome.filter((o) => o.id !== item.id));
    try {
      await deleteOtherIncomeItem(property, item.id);
    } catch (err) {
      setDaySheet((prev) => (prev ? { ...prev, otherIncome: prevOtherIncome, cashBlock: prevCashBlock } : prev));
      window.alert(err instanceof Error ? err.message : "ลบรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  // ── Cash-banking block override (mgr) ────────────────────────────────
  // Every commit sends the FULL four-field object (current override, or
  // current derived where nothing is overridden yet, with the edited field
  // replaced) rather than just the one changed field. api.md's "omitted
  // fields fall back to derived" wording left it ambiguous whether PUT
  // merges or replaces the override document; sending the full set is safe
  // under either reading and never silently drops an earlier override on a
  // sibling field.

  async function commitCashOverrideField(field: keyof CashBlockAmounts, satang: number | null) {
    if (!daySheet) return;
    const prevCashBlock = daySheet.cashBlock;
    const baseline = daySheet.cashBlock.entered ?? daySheet.cashBlock.derived;
    const nextEntered: CashBlockAmounts = { ...baseline, [field]: satang ?? 0 };
    setDaySheet((prev) => (prev ? { ...prev, cashBlock: { ...prev.cashBlock, entered: nextEntered } } : prev));
    try {
      const res = await putCashBlock(property, date, nextEntered);
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: res } : prev));
    } catch (err) {
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: prevCashBlock } : prev));
      window.alert(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  async function clearCashOverride() {
    if (!daySheet) return;
    const prevCashBlock = daySheet.cashBlock;
    setDaySheet((prev) => (prev ? { ...prev, cashBlock: { ...prev.cashBlock, entered: null } } : prev));
    try {
      const res = await putCashBlock(property, date, null);
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: res } : prev));
    } catch (err) {
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: prevCashBlock } : prev));
      window.alert(err instanceof Error ? err.message : "ล้างการปรับยอดไม่สำเร็จ");
    }
  }

  // ── Navigation ───────────────────────────────────────────────────────

  function goToDate(newDate: string) {
    navigate(`/${property}/bookings/${newDate}`);
  }
  function shift(delta: number) {
    navigate(`/${property}/bookings/${shiftDays(date, delta)}`);
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">
        โหลดข้อมูลไม่สำเร็จ: {loadError}
      </div>
    );
  }
  if (!lines || !daySheet) {
    return <div className="p-6 text-sm text-ink-muted">กำลังโหลด...</div>;
  }

  const varianceAfter = variance.status === "ready" ? variance.rows.reduce((s, r) => s + r.afterSatang, 0) : null;
  const varianceBefore = variance.status === "ready" ? variance.rows.reduce((s, r) => s + r.beforeSatang, 0) : null;

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate(`/${property}/day/${date}`)}
          className="text-sm font-medium text-ink hover:underline"
        >
          กลับไปสรุปวัน
        </button>
        <h1 className="text-sm font-semibold text-ink">รายงานรายรับโรงแรมรายวัน</h1>
        <span aria-hidden className="w-8" />
      </div>

      <DateBar date={date} onPick={goToDate} onShift={shift} />

      {monthClosed && (
        <div className="rounded-lg border border-warn/40 bg-gold-50 px-4 py-2.5 text-sm font-medium text-warn">
          เดือนนี้ปิดบัญชีแล้ว — ไม่สามารถแก้ไขรายการได้
        </div>
      )}

      {/* Panel รายการจอง */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">รายการจอง</h2>
          <button
            type="button"
            onClick={addBookingLine}
            disabled={addingLine || monthClosed}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            เพิ่มรายการจอง
          </button>
        </div>

        {sortedLines.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">ยังไม่มีรายการจองวันนี้</p>
        ) : (
          <div className="divide-y divide-line">
            {sortedLines.map((line) => (
              <BookingLineRow
                key={line.id}
                line={line}
                expanded={expandedId === line.id}
                disabled={monthClosed}
                onToggle={() => setExpandedId((cur) => (cur === line.id ? null : line.id))}
                onPatch={(patch) => commitLinePatch(line, patch)}
                onDelete={() => removeLine(line)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Panel รายการอื่นๆ (non-booking revenue) */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">รายการอื่นๆ</h2>
        {daySheet.otherIncome.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">ยังไม่มีรายการอื่นๆวันนี้</p>
        ) : (
          <div className="divide-y divide-line">
            {daySheet.otherIncome.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <input
                  type="text"
                  defaultValue={item.description ?? ""}
                  key={`${item.id}-${item.description ?? ""}`}
                  placeholder="รายละเอียด"
                  aria-label="รายละเอียดรายการอื่นๆ"
                  disabled={monthClosed}
                  maxLength={DESCRIPTION_MAX_LEN}
                  onBlur={(e) => {
                    const trimmed = e.target.value.trim();
                    const description = trimmed === "" ? null : trimmed.slice(0, DESCRIPTION_MAX_LEN);
                    if (description !== item.description) commitOtherIncomeField(item, { description });
                  }}
                  className="min-w-[9rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
                />
                <div className="flex shrink-0 overflow-hidden rounded-md border border-line-strong text-xs font-medium">
                  <button
                    type="button"
                    disabled={monthClosed}
                    onClick={() => commitOtherIncomeField(item, { isCash: true })}
                    className={
                      "px-2 py-1.5 transition disabled:opacity-50 " +
                      (item.isCash ? "bg-brand-500 text-white" : "bg-panel text-ink-muted hover:bg-tint")
                    }
                  >
                    เงินสด
                  </button>
                  <button
                    type="button"
                    disabled={monthClosed}
                    onClick={() => commitOtherIncomeField(item, { isCash: false })}
                    className={
                      "border-l border-line-strong px-2 py-1.5 transition disabled:opacity-50 " +
                      (!item.isCash ? "bg-brand-500 text-white" : "bg-panel text-ink-muted hover:bg-tint")
                    }
                  >
                    โอน/เครดิต
                  </button>
                </div>
                <AmountInput
                  value={item.amountSatang}
                  onCommit={(satang) => {
                    if (satang === null || satang <= 0) throw new Error("จำนวนเงินต้องมากกว่า 0");
                    return commitOtherIncomeField(item, { amountSatang: satang });
                  }}
                  ariaLabel={`จำนวนเงิน ${item.description ?? "รายการอื่นๆ"}`}
                  disabled={monthClosed}
                />
                <button
                  type="button"
                  onClick={() => removeOtherIncomeItem(item)}
                  disabled={monthClosed}
                  className="rounded-md border border-bad/40 px-2.5 py-1.5 text-xs font-medium text-bad hover:bg-bad/10 disabled:opacity-50"
                >
                  ลบ
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-tint px-4 py-3">
          <input
            type="text"
            value={newOtherDescription}
            onChange={(e) => setNewOtherDescription(e.target.value)}
            placeholder="รายละเอียด"
            aria-label="รายละเอียดรายการอื่นๆใหม่"
            disabled={monthClosed}
            maxLength={DESCRIPTION_MAX_LEN}
            className="min-w-[9rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
          <div className="flex shrink-0 overflow-hidden rounded-md border border-line-strong text-xs font-medium">
            <button
              type="button"
              disabled={monthClosed}
              onClick={() => setNewOtherIsCash(true)}
              className={"px-2 py-1.5 disabled:opacity-50 " + (newOtherIsCash ? "bg-brand-500 text-white" : "bg-panel text-ink-muted hover:bg-tint")}
            >
              เงินสด
            </button>
            <button
              type="button"
              disabled={monthClosed}
              onClick={() => setNewOtherIsCash(false)}
              className={
                "border-l border-line-strong px-2 py-1.5 disabled:opacity-50 " +
                (!newOtherIsCash ? "bg-brand-500 text-white" : "bg-panel text-ink-muted hover:bg-tint")
              }
            >
              โอน/เครดิต
            </button>
          </div>
          <input
            type="text"
            inputMode="decimal"
            value={newOtherAmountText}
            onChange={(e) => setNewOtherAmountText(e.target.value)}
            placeholder="0.00"
            aria-label="จำนวนเงินรายการอื่นๆใหม่"
            disabled={monthClosed}
            className="w-28 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-right tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
          <button
            type="button"
            onClick={submitNewOtherIncome}
            disabled={addingOther || monthClosed}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            เพิ่มรายการ
          </button>
          {newOtherError && <p className="w-full text-xs text-bad">{newOtherError}</p>}
        </div>
      </section>

      {/* Panel **หมายเหตุ — สรุปเงินสด */}
      <section className="rounded-lg border border-line bg-tint p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">**หมายเหตุ (สรุปเงินสด)</h2>
          {daySheet.cashBlock.entered && isManager && (
            <button type="button" onClick={clearCashOverride} className="text-xs font-medium text-brand-500 hover:underline">
              ล้างการปรับยอด
            </button>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {CASH_BLOCK_FIELDS.map(({ key, label }) => {
            const derivedValue = daySheet.cashBlock.derived[key];
            const enteredValue = daySheet.cashBlock.entered?.[key];
            const shown = enteredValue ?? derivedValue;
            return (
              <div key={key} className="flex items-center justify-between gap-3">
                <span className={key === "bankedSatang" ? "text-sm font-bold text-brand-500" : "text-sm text-ink"}>
                  {label}
                  {enteredValue != null && enteredValue !== derivedValue && (
                    <span className="ml-1.5 text-xs font-normal text-ink-muted">(ปรับจาก {formatSatang(derivedValue)})</span>
                  )}
                </span>
                <AmountInput
                  value={shown}
                  onCommit={(satang) => commitCashOverrideField(key, satang)}
                  ariaLabel={label}
                  disabled={!isManager || monthClosed}
                />
              </div>
            );
          })}
        </div>
        {!isManager && <p className="mt-2 text-xs text-ink-muted">ปรับยอดได้เฉพาะผู้จัดการ</p>}
      </section>

      {/* แถบเปรียบเทียบยอดจากรายการจอง — ถาวร ไม่ใช่การอัพเดทอัตโนมัติ */}
      <section className="rounded-lg border border-line bg-panel p-4 text-sm">
        <h2 className="mb-2 text-sm font-semibold text-ink">เปรียบเทียบกับสรุปวัน</h2>
        {variance.status === "loading" && <p className="text-ink-muted">กำลังคำนวณ...</p>}
        {variance.status === "error" && <p className="text-bad">{variance.message}</p>}
        {variance.status === "ready" && varianceAfter != null && varianceBefore != null && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-ink-muted">
              รวมจากรายการจอง <span className="font-semibold tabular-nums text-ink">{formatSatang(varianceAfter)}</span>
            </span>
            <span className="text-ink-muted">
              กรอกไว้ <span className="font-semibold tabular-nums text-ink">{formatSatang(varianceBefore)}</span>
            </span>
            <span className={varianceAfter === varianceBefore ? "text-ink-muted" : "font-semibold text-warn"}>
              ต่าง <span className="tabular-nums">{formatSatang(varianceAfter - varianceBefore)}</span>
            </span>
          </div>
        )}
        <p className="mt-1 text-xs text-ink-muted">
          ยอดจากรายการจองไม่รวมช่องอื่นๆ สด/โอน/เครดิต (ไปคำนวณเป็นรายการอื่นๆแยกต่างหาก) — ปรับให้ตรงกับสรุปวันได้ที่ปุ่ม
          &quot;อัพเดทจากระบบจอง&quot; ในหน้าสรุปวัน
        </p>
      </section>

      {/* Footer: totals ในลำดับเดียวกับกระดาษ */}
      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="mb-2 text-sm font-semibold text-ink">ยอดรวม</h2>
        <div className="flex flex-col gap-1 text-sm">
          <Row label="จำนวนรายการ" value={String(bookingTotals.lineCount)} />
          <Row label="จำนวนห้อง" value={String(bookingTotals.roomCount)} />
          <Row label="จำนวนคืน" value={String(bookingTotals.nights)} />
          <Row label="ยอดห้องรวม" value={formatSatang(bookingTotals.grossRoomSatang)} />
          <Row label="ยอดอื่นๆรวม" value={formatSatang(bookingTotals.grossOtherSatang)} />
          <Row label="ส่วนลดรวม" value={`-${formatSatang(bookingTotals.discountSatang)}`} />
          {TENDERS.filter((tender) => bookingTotals.byTender[tender] !== 0).map((tender) => (
            <Row key={tender} label={TENDER_LABELS_TH[tender]} value={formatSatang(bookingTotals.byTender[tender])} />
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-line-strong pt-2 text-base font-bold text-brand-500">
          <span>ยอดรับรวม</span>
          <span className="tabular-nums">{formatSatang(bookingTotals.receivedSatang)}</span>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-muted">{label}</span>
      <span className="tabular-nums text-ink">{value}</span>
    </div>
  );
}

// ── One booking line: two-line summary card + tap-to-expand editor ───────

interface BookingLineRowProps {
  line: BookingLine;
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPatch: (patch: BookingLineInput) => void;
  onDelete: () => void;
}

function BookingLineRow({ line, expanded, disabled, onToggle, onPatch, onDelete }: BookingLineRowProps) {
  const mismatch = !line.draft && lineArithmeticMismatch(line);
  const nonZeroTenders = TENDERS.filter((tender) => line.tenders[tender] !== 0);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-2.5 text-left hover:bg-tint focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500/40"
      >
        {/* line 1: seq, booking no, guest, room, room count/nights */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="tabular-nums text-ink-muted">#{line.seq}</span>
          <span className="text-ink">{line.bookingNo ?? "-"}</span>
          <span className="text-ink">{line.guestName ?? "-"}</span>
          <span className="text-ink-muted">ห้อง {line.roomNo ?? "-"}</span>
          <span className="text-ink-muted">
            {line.roomCount ?? 0} ห้อง {line.nights ?? 0} คืน
          </span>
          {line.draft && (
            <span className="rounded-full bg-tint px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
              ร่างจากระบบจองอัตโนมัติ
            </span>
          )}
          {mismatch && (
            <span
              title="ยอดที่ได้รับไม่ตรงกับยอดห้อง+อื่นๆ-ส่วนลด (รายการจากช่องทางออนไลน์มักต่างกันได้ ไม่ใช่ข้อผิดพลาดเสมอไป)"
              className="rounded-full bg-warn/15 px-1.5 py-0.5 text-[11px] font-semibold text-warn"
            >
              ยอดไม่ตรง
            </span>
          )}
        </div>
        {/* line 2: gross room/other, discount, non-zero tenders, remark */}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted">
          <span>ห้อง {formatSatang(line.grossRoomSatang)}</span>
          <span>อื่นๆ {formatSatang(line.grossOtherSatang)}</span>
          {line.discountSatang !== 0 && <span>ส่วนลด -{formatSatang(line.discountSatang)}</span>}
          {nonZeroTenders.map((tender) => (
            <span key={tender}>
              {TENDER_LABELS_TH[tender]} {formatSatang(line.tenders[tender])}
            </span>
          ))}
          {line.remark && <span className="italic">{line.remark}</span>}
        </div>
      </button>

      {expanded && <BookingLineEditor line={line} disabled={disabled} onPatch={onPatch} onDelete={onDelete} />}
    </div>
  );
}

interface BookingLineEditorProps {
  line: BookingLine;
  disabled: boolean;
  onPatch: (patch: BookingLineInput) => void;
  onDelete: () => void;
}

function BookingLineEditor({ line, disabled, onPatch, onDelete }: BookingLineEditorProps) {
  function commitText(field: "bookingNo" | "guestName" | "roomNo" | "remark", maxLen: number, value: string) {
    const trimmed = value.trim();
    const next = trimmed === "" ? null : trimmed.slice(0, maxLen);
    if (next !== line[field]) onPatch({ [field]: next });
  }

  function commitCount(field: "roomCount" | "nights", value: string) {
    const next = parseCount(value);
    if (next !== line[field]) onPatch({ [field]: next });
  }

  function commitTender(tender: Tender, satang: number | null) {
    onPatch({ tenders: { ...line.tenders, [tender]: satang ?? 0 } });
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line bg-tint px-4 py-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="เลขที่จอง">
          <input
            type="text"
            defaultValue={line.bookingNo ?? ""}
            key={`bookingNo-${line.id}-${line.bookingNo ?? ""}`}
            maxLength={BOOKING_NO_MAX_LEN}
            disabled={disabled}
            onBlur={(e) => commitText("bookingNo", BOOKING_NO_MAX_LEN, e.target.value)}
            className="w-full rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
        </Field>
        <Field label="ชื่อผู้เข้าพัก">
          <input
            type="text"
            defaultValue={line.guestName ?? ""}
            key={`guestName-${line.id}-${line.guestName ?? ""}`}
            maxLength={GUEST_NAME_MAX_LEN}
            disabled={disabled}
            onBlur={(e) => commitText("guestName", GUEST_NAME_MAX_LEN, e.target.value)}
            className="w-full rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
        </Field>
        <Field label="หมายเลขห้อง">
          <input
            type="text"
            defaultValue={line.roomNo ?? ""}
            key={`roomNo-${line.id}-${line.roomNo ?? ""}`}
            maxLength={ROOM_NO_MAX_LEN}
            disabled={disabled}
            onBlur={(e) => commitText("roomNo", ROOM_NO_MAX_LEN, e.target.value)}
            className="w-full rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
        </Field>
        <Field label="จำนวนห้อง / คืน">
          <div className="flex items-center gap-1">
            <input
              type="text"
              inputMode="numeric"
              defaultValue={line.roomCount ?? ""}
              key={`roomCount-${line.id}-${line.roomCount ?? ""}`}
              disabled={disabled}
              onBlur={(e) => commitCount("roomCount", e.target.value)}
              aria-label="จำนวนห้อง"
              className="w-full rounded-md border border-line-strong bg-panel px-2 py-1.5 text-right text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
            />
            <span className="text-ink-muted">/</span>
            <input
              type="text"
              inputMode="numeric"
              defaultValue={line.nights ?? ""}
              key={`nights-${line.id}-${line.nights ?? ""}`}
              disabled={disabled}
              onBlur={(e) => commitCount("nights", e.target.value)}
              aria-label="จำนวนคืน"
              className="w-full rounded-md border border-line-strong bg-panel px-2 py-1.5 text-right text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
            />
          </div>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Field label="ยอดห้องรวม">
          <AmountInput value={line.grossRoomSatang} onCommit={(s) => onPatch({ grossRoomSatang: s ?? 0 })} ariaLabel="ยอดห้องรวม" disabled={disabled} />
        </Field>
        <Field label="ยอดอื่นๆรวม">
          <AmountInput value={line.grossOtherSatang} onCommit={(s) => onPatch({ grossOtherSatang: s ?? 0 })} ariaLabel="ยอดอื่นๆรวม" disabled={disabled} />
        </Field>
        <Field label="ส่วนลด">
          <AmountInput value={line.discountSatang} onCommit={(s) => onPatch({ discountSatang: s ?? 0 })} ariaLabel="ส่วนลด" disabled={disabled} />
        </Field>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold text-ink-muted">ยอดรับตามช่องทาง (ครบทั้งแปดช่อง)</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TENDERS.map((tender) => (
            <Field key={tender} label={TENDER_LABELS_TH[tender]}>
              <AmountInput
                value={line.tenders[tender]}
                onCommit={(s) => commitTender(tender, s)}
                ariaLabel={TENDER_LABELS_TH[tender]}
                disabled={disabled}
              />
            </Field>
          ))}
        </div>
      </div>

      <Field label="หมายเหตุ">
        <input
          type="text"
          defaultValue={line.remark ?? ""}
          key={`remark-${line.id}-${line.remark ?? ""}`}
          disabled={disabled}
          onBlur={(e) => commitText("remark", 500, e.target.value)}
          placeholder="หมายเหตุ"
          className="w-full rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
        />
      </Field>

      <div className="flex items-center justify-between">
        {line.draft ? (
          <button
            type="button"
            onClick={() => onPatch({ draft: false })}
            disabled={disabled}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            ยืนยันรายการจากระบบจอง
          </button>
        ) : (
          <span className="text-xs text-ink-muted">{line.sourceSheet ? `นำเข้าจาก: ${line.sourceSheet}` : ""}</span>
        )}
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="rounded-md border border-bad/40 px-2.5 py-1.5 text-xs font-medium text-bad hover:bg-bad/10 disabled:opacity-50"
        >
          ลบรายการ
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-muted">
      {label}
      {children}
    </label>
  );
}
