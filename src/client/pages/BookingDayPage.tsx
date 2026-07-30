import { useEffect, useMemo, useState } from "react";
import { shiftDays } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import { deriveCashBlock } from "../../shared/bookings.ts";
import {
  DESCRIPTION_MAX_LEN,
  type BookingLine,
  type CashBlockAmounts,
  type DaySheet,
  type OtherIncomeItem,
  type Property,
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
import { BookingGrid } from "../components/BookingGrid.tsx";
import { DateBar } from "../components/DateBar.tsx";
import { FIXTURE_DATE, fixtureBookingLines, fixtureDaySheet } from "../fixtures.ts";
import { CASH_BLOCK_FIELDS } from "../labels.ts";

interface Props {
  property: Property | "demo";
  date: string;
}

const DEMO_PROPERTY: Property = "hf";

type VarianceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: FillFromBookingsDiffRow[] };

/**
 * รายงานรายรับโรงแรมรายวัน — the per-booking half of the paper, rebuilt as
 * the office's spreadsheet (see components/BookingGrid.tsx for the grid
 * itself). Route /:property/bookings/:date. Mutations are optimistic with
 * rollback, matching DaySheetPage's pattern; server-returned rows win on
 * success.
 *
 * property === "demo" renders src/client/fixtures.ts with zero network —
 * the same headless-verification affordance ReportPage already has, so the
 * grid and the report can both be checked without real data. Every write
 * path stops at its optimistic local update in that mode.
 */
export function BookingDayPage({ property, date }: Props) {
  const isDemo = property === "demo";
  const effectiveProperty: Property = isDemo ? DEMO_PROPERTY : property;
  const effectiveDate = isDemo ? FIXTURE_DATE : date;

  const [lines, setLines] = useState<BookingLine[] | null>(null);
  const [daySheet, setDaySheet] = useState<DaySheet | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isManager, setIsManager] = useState(false);
  const [variance, setVariance] = useState<VarianceState>({ status: "loading" });

  useEffect(() => {
    if (isDemo) return;
    getMe()
      .then((me) => setIsManager(me.isManager))
      .catch(() => {
        /* /api/me failing just means cash-block overrides stay read-only */
      });
  }, [isDemo]);

  function refreshVariance() {
    if (isDemo) return;
    setVariance({ status: "loading" });
    fillFromBookings(effectiveProperty, effectiveDate, false)
      .then((res) => setVariance({ status: "ready", rows: res.diff }))
      .catch((err) =>
        setVariance({ status: "error", message: err instanceof Error ? err.message : "โหลดข้อมูลเปรียบเทียบไม่สำเร็จ" }),
      );
  }

  useEffect(() => {
    if (isDemo) {
      setLines(fixtureBookingLines);
      setDaySheet(fixtureDaySheet);
      setVariance({ status: "ready", rows: [] });
      return;
    }
    let cancelled = false;
    setLines(null);
    setDaySheet(null);
    setLoadError(null);
    setVariance({ status: "loading" });

    Promise.all([listBookingLines(effectiveProperty, effectiveDate), getDay(effectiveProperty, effectiveDate)])
      .then(([bookingsRes, sheet]) => {
        if (cancelled) return;
        setLines(bookingsRes.lines);
        setDaySheet(sheet);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      });

    fillFromBookings(effectiveProperty, effectiveDate, false)
      .then((res) => {
        if (!cancelled) setVariance({ status: "ready", rows: res.diff });
      })
      .catch((err) => {
        if (!cancelled) {
          setVariance({
            status: "error",
            message: err instanceof Error ? err.message : "โหลดข้อมูลเปรียบเทียบไม่สำเร็จ",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDemo, effectiveProperty, effectiveDate]);

  const sortedLines = useMemo(() => [...(lines ?? [])].sort((a, b) => a.seq - b.seq), [lines]);
  const monthClosed = daySheet?.monthClosed ?? false;

  // ── Booking lines ────────────────────────────────────────────────────

  async function addBookingLine(input: BookingLineInput) {
    const nextSeq = sortedLines.reduce((max, line) => Math.max(max, line.seq), 0) + 1;
    if (isDemo) {
      const localId = -Date.now();
      setLines((prev) => [
        ...(prev ?? []),
        {
          id: localId,
          property: effectiveProperty,
          date: effectiveDate,
          seq: nextSeq,
          bookingNo: null,
          guestName: null,
          roomNo: null,
          roomCount: null,
          nights: null,
          grossRoomSatang: 0,
          grossOtherSatang: 0,
          discountSatang: 0,
          tenders: { deposit: 0, cash: 0, credit_kbank: 0, credit_icbc: 0, transfer_kbank: 0, transfer_icbc: 0, web: 0, other: 0 },
          remark: null,
          source: "manual",
          draft: false,
          sourceSheet: null,
          createdAt: "",
          createdBy: "",
          updatedAt: "",
          updatedBy: "",
          ...input,
        },
      ]);
      return;
    }
    try {
      const created = await createBookingLine(effectiveProperty, effectiveDate, input);
      setLines((prev) => [...(prev ?? []), created]);
      refreshVariance();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "เพิ่มรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  async function commitLinePatch(line: BookingLine, patch: BookingLineInput) {
    const prevLines = lines;
    setLines((prev) => (prev ?? []).map((l) => (l.id === line.id ? { ...l, ...patch } : l)));
    if (isDemo) return;
    try {
      const updated = await updateBookingLine(effectiveProperty, line.id, patch);
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
    if (isDemo) return;
    try {
      await deleteBookingLine(effectiveProperty, line.id);
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
    const description =
      newOtherDescription.trim() === "" ? null : newOtherDescription.trim().slice(0, DESCRIPTION_MAX_LEN);
    if (isDemo) {
      applyOtherIncome([
        ...daySheet.otherIncome,
        {
          id: -Date.now(),
          property: effectiveProperty,
          date: effectiveDate,
          description,
          amountSatang,
          isCash: newOtherIsCash,
          createdAt: "",
          createdBy: "",
          updatedAt: "",
          updatedBy: "",
        },
      ]);
      setNewOtherDescription("");
      setNewOtherAmountText("");
      return;
    }
    setAddingOther(true);
    try {
      const created = await createOtherIncomeItem(effectiveProperty, effectiveDate, {
        description,
        amountSatang,
        isCash: newOtherIsCash,
      });
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
    if (isDemo) return;
    try {
      const updated = await updateOtherIncomeItem(effectiveProperty, item.id, patch);
      setDaySheet((prev) => {
        if (!prev) return prev;
        const otherIncome = prev.otherIncome.map((o) => (o.id === updated.id ? updated : o));
        return {
          ...prev,
          otherIncome,
          cashBlock: { ...prev.cashBlock, derived: deriveCashBlock(prev.categories, prev.income, otherIncome) },
        };
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
    if (isDemo) return;
    try {
      await deleteOtherIncomeItem(effectiveProperty, item.id);
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
    if (isDemo) return;
    try {
      const res = await putCashBlock(effectiveProperty, effectiveDate, nextEntered);
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
    if (isDemo) return;
    try {
      const res = await putCashBlock(effectiveProperty, effectiveDate, null);
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: res } : prev));
    } catch (err) {
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: prevCashBlock } : prev));
      window.alert(err instanceof Error ? err.message : "ล้างการปรับยอดไม่สำเร็จ");
    }
  }

  // ── Navigation ───────────────────────────────────────────────────────

  function goToDate(newDate: string) {
    navigate(`/${effectiveProperty}/bookings/${newDate}`);
  }
  function shift(delta: number) {
    navigate(`/${effectiveProperty}/bookings/${shiftDays(effectiveDate, delta)}`);
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
          onClick={() => navigate(`/${effectiveProperty}/day/${effectiveDate}`)}
          className="rounded-md text-sm font-medium text-ink hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        >
          กลับไปสรุปวัน
        </button>
        <h1 className="text-sm font-semibold text-ink">รายงานรายรับโรงแรมรายวัน</h1>
        <span aria-hidden className="w-8" />
      </div>

      <DateBar date={effectiveDate} onPick={goToDate} onShift={shift} />

      {monthClosed && (
        <div className="rounded-lg border border-warn/40 bg-gold-50 px-4 py-2.5 text-sm font-medium text-warn">
          เดือนนี้ปิดบัญชีแล้ว — ไม่สามารถแก้ไขรายการได้
        </div>
      )}

      {/* Panel รายการจอง — the spreadsheet grid */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">รายการจอง</h2>
          <p className="text-xs text-ink-muted">
            พิมพ์ในแถวว่างท้ายตารางเพื่อเพิ่มรายการใหม่ — Tab เลื่อนช่องถัดไป, Enter เลื่อนลงในคอลัมน์เดิม
          </p>
        </div>
        <BookingGrid
          lines={sortedLines}
          disabled={monthClosed}
          onPatch={commitLinePatch}
          onCreate={addBookingLine}
          onDelete={removeLine}
        />
      </section>

      {/* Three desktop panels: itemized รายการอื่นๆ, the cash block, the
          booking-vs-summary variance strip. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        {/* Panel รายการอื่นๆ (non-booking revenue) */}
        <section className="overflow-hidden rounded-lg border border-line bg-panel">
          <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">รายการอื่นๆ</h2>
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
                className={
                  "px-2 py-1.5 disabled:opacity-50 " +
                  (newOtherIsCash ? "bg-brand-500 text-white" : "bg-panel text-ink-muted hover:bg-tint")
                }
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
              <button
                type="button"
                onClick={clearCashOverride}
                className="rounded-md text-xs font-medium text-brand-500 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              >
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
                      <span className="ml-1.5 text-xs font-normal text-ink-muted">
                        (ปรับจาก {formatSatang(derivedValue)})
                      </span>
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
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-muted">รวมจากรายการจอง</span>
                <span className="font-semibold tabular-nums text-ink">{formatSatang(varianceAfter)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-muted">กรอกไว้</span>
                <span className="font-semibold tabular-nums text-ink">{formatSatang(varianceBefore)}</span>
              </div>
              <div
                className={
                  "flex items-center justify-between gap-3 border-t border-line pt-1 " +
                  (varianceAfter === varianceBefore ? "text-ink-muted" : "font-semibold text-warn")
                }
              >
                <span>ต่าง</span>
                <span className="tabular-nums">{formatSatang(varianceAfter - varianceBefore)}</span>
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-ink-muted">
            ยอดจากรายการจองไม่รวมช่องอื่นๆ สด/โอน/เครดิต (ไปคำนวณเป็นรายการอื่นๆแยกต่างหาก) — ปรับให้ตรงกับสรุปวันได้ที่ปุ่ม
            &quot;อัพเดทจากระบบจอง&quot; ในหน้าสรุปวัน
          </p>
        </section>
      </div>
    </div>
  );
}
