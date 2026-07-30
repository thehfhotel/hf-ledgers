import { useEffect, useMemo, useState, type FormEvent } from "react";
import { shiftDays } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import { computeDayTotals } from "../../shared/totals.ts";
import {
  NOTE_MAX_LEN,
  type Category,
  type CategoryKey,
  type DaySheet,
  type ExpenseItem,
  type Property,
} from "../../shared/types.ts";
import { PROVENANCE_LABELS_TH } from "../labels.ts";
import {
  createExpense,
  deleteExpense,
  fillFromBookings,
  getDay,
  getMe,
  putDayNote,
  putIncomeCell,
  putVerify,
  updateExpense,
  type FillFromBookingsDiffRow,
} from "../api.ts";
import { navigate } from "../App.tsx";
import { AmountInput } from "../components/AmountInput.tsx";
import { DateBar } from "../components/DateBar.tsx";

interface Props {
  property: Property;
  date: string;
}

// The two income categories computed from itemized other-income entries
// once any exist (see api.md's RESOLVED รายการอื่นๆ note) — identified by
// categoryKey, never nameTh, because managers can rename categories freely.
const OTHER_INCOME_CATEGORY_KEYS = new Set(["other_cash", "other_transfer"]);

// Fallback labels for the fill-from-bookings diff, verbatim from api.md's
// seed list — needed because a diff row's categoryId is null when the
// property has no active category seeded with that key yet.
const CATEGORY_KEY_LABELS_TH: Record<CategoryKey, string> = {
  deposit: "มัดจำล่วงหน้า",
  room_cash: "ค่าห้องเงินสด",
  credit_kbank: "บัตรเครดิต/กสิกร",
  credit_icbc: "บัตรเครดิต ICBC",
  transfer_kbank: "โอน/กสิกร",
  transfer_icbc: "โอน ICBC",
  web: "เว็ปไซด์",
  other_cash: "รายการอื่นๆ เงินสด",
  other_transfer: "รายการอื่นๆ โอน/เครดิต",
  bar_cash: "บาร์น้ำ เงินสด",
  bar_transfer: "บาร์น้ำ โอน/เครดิต",
};

type SimpleSaveState = "idle" | "saving" | "saved" | "error";

function nowSqlUtc(): string {
  // Matches the shape of the server's `datetime('now')` audit strings
  // closely enough for the footer's own immediate optimistic update — the
  // next full day load always replaces it with the authoritative value.
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function formatUpdatedAt(updatedAtUtc: string): string {
  const iso = updatedAtUtc.includes("T") ? updatedAtUtc : `${updatedAtUtc.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return updatedAtUtc;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function DaySheetPage({ property, date }: Props) {
  const [day, setDay] = useState<DaySheet | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meEmail, setMeEmail] = useState<string | null>(null);
  const [isManager, setIsManager] = useState(false);
  const [dayNoteDraft, setDayNoteDraft] = useState("");
  const [dayNoteState, setDayNoteState] = useState<SimpleSaveState>("idle");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((me) => {
        setMeEmail(me.email);
        setIsManager(me.isManager);
      })
      .catch(() => {
        /* /api/me failing just means the footer falls back to server-attributed emails */
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDay(null);
    setLoadError(null);
    setDayNoteState("idle");
    setVerifyError(null);
    getDay(property, date)
      .then((sheet) => {
        if (cancelled) return;
        setDay(sheet);
        setDayNoteDraft(sheet.note ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      });
    return () => {
      cancelled = true;
    };
  }, [property, date]);

  const incomeCategories = useMemo(
    () => (day ? day.categories.filter((c) => c.kind === "income") : []),
    [day],
  );
  const expenseCategories = useMemo(
    () => (day ? day.categories.filter((c) => c.kind === "expense") : []),
    [day],
  );
  const activeExpenseCategories = useMemo(
    () => expenseCategories.filter((c) => !c.archivedAt),
    [expenseCategories],
  );

  function applyLocal(mutate: (prev: DaySheet) => DaySheet) {
    setDay((prev) => (prev ? mutate(prev) : prev));
  }

  function touchAudit(prev: DaySheet) {
    return { updatedAt: nowSqlUtc(), updatedBy: meEmail ?? prev.updatedBy };
  }

  // ── Income cells ──────────────────────────────────────────────────────

  async function commitIncomeAmount(category: Category, satang: number | null) {
    if (!day) return;
    const prevIncome = day.income;
    const prevTotals = day.totals;

    const optimisticIncome = { ...day.income };
    if (satang === null || satang === 0) {
      delete optimisticIncome[category.id];
    } else {
      optimisticIncome[category.id] = {
        categoryId: category.id,
        amountSatang: satang,
        note: day.income[category.id]?.note ?? null,
        source: "manual",
        manual: true,
        updatedAt: day.updatedAt,
        updatedBy: meEmail ?? day.updatedBy,
      };
    }
    applyLocal((prev) => ({
      ...prev,
      income: optimisticIncome,
      totals: computeDayTotals(prev.categories, optimisticIncome, prev.expenses),
    }));

    try {
      const res = await putIncomeCell(property, date, category.id, { amountSatang: satang });
      applyLocal((prev) => ({ ...prev, income: res.income, totals: res.totals, ...touchAudit(prev) }));
    } catch (err) {
      applyLocal((prev) => ({ ...prev, income: prevIncome, totals: prevTotals }));
      throw err;
    }
  }

  // ── Expense items ────────────────────────────────────────────────────

  async function commitExpenseAmount(item: ExpenseItem, satang: number | null) {
    if (satang === null || satang <= 0) {
      throw new Error("จำนวนเงินต้องมากกว่า 0");
    }
    if (!day) return;
    const prevExpenses = day.expenses;
    const prevTotals = day.totals;
    const optimisticExpenses = day.expenses.map((e) => (e.id === item.id ? { ...e, amountSatang: satang } : e));
    applyLocal((prev) => ({
      ...prev,
      expenses: optimisticExpenses,
      totals: computeDayTotals(prev.categories, prev.income, optimisticExpenses),
    }));
    try {
      const updated = await updateExpense(property, item.id, { amountSatang: satang });
      applyLocal((prev) => {
        const expenses = prev.expenses.map((e) => (e.id === updated.id ? updated : e));
        return {
          ...prev,
          expenses,
          totals: computeDayTotals(prev.categories, prev.income, expenses),
          ...touchAudit(prev),
        };
      });
    } catch (err) {
      applyLocal((prev) => ({ ...prev, expenses: prevExpenses, totals: prevTotals }));
      throw err;
    }
  }

  async function commitExpenseNote(item: ExpenseItem, noteText: string) {
    if (!day) return;
    const trimmed = noteText.trim();
    const note = trimmed === "" ? null : trimmed.slice(0, NOTE_MAX_LEN);
    if (note === item.note) return;
    const prevExpenses = day.expenses;
    applyLocal((prev) => ({
      ...prev,
      expenses: prev.expenses.map((e) => (e.id === item.id ? { ...e, note } : e)),
    }));
    try {
      const updated = await updateExpense(property, item.id, { note });
      applyLocal((prev) => ({
        ...prev,
        expenses: prev.expenses.map((e) => (e.id === updated.id ? updated : e)),
        ...touchAudit(prev),
      }));
    } catch {
      applyLocal((prev) => ({ ...prev, expenses: prevExpenses }));
    }
  }

  async function commitExpenseCategory(item: ExpenseItem, categoryId: number) {
    if (!day) return;
    const prevExpenses = day.expenses;
    const prevTotals = day.totals;
    const optimisticExpenses = day.expenses.map((e) => (e.id === item.id ? { ...e, categoryId } : e));
    applyLocal((prev) => ({
      ...prev,
      expenses: optimisticExpenses,
      totals: computeDayTotals(prev.categories, prev.income, optimisticExpenses),
    }));
    try {
      const updated = await updateExpense(property, item.id, { categoryId });
      applyLocal((prev) => {
        const expenses = prev.expenses.map((e) => (e.id === updated.id ? updated : e));
        return {
          ...prev,
          expenses,
          totals: computeDayTotals(prev.categories, prev.income, expenses),
          ...touchAudit(prev),
        };
      });
    } catch {
      applyLocal((prev) => ({ ...prev, expenses: prevExpenses, totals: prevTotals }));
    }
  }

  async function removeExpense(item: ExpenseItem) {
    if (!day) return;
    if (!window.confirm("ลบรายการนี้ใช่หรือไม่")) return;
    const prevExpenses = day.expenses;
    const prevTotals = day.totals;
    const optimisticExpenses = day.expenses.filter((e) => e.id !== item.id);
    applyLocal((prev) => ({
      ...prev,
      expenses: optimisticExpenses,
      totals: computeDayTotals(prev.categories, prev.income, optimisticExpenses),
    }));
    try {
      await deleteExpense(property, item.id);
      applyLocal((prev) => ({ ...prev, ...touchAudit(prev) }));
    } catch (err) {
      applyLocal((prev) => ({ ...prev, expenses: prevExpenses, totals: prevTotals }));
      window.alert(err instanceof Error ? err.message : "ลบรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  const [newCategoryId, setNewCategoryId] = useState<number | "">("");
  const [newNote, setNewNote] = useState("");
  const [newAmountText, setNewAmountText] = useState("");
  const [newExpenseError, setNewExpenseError] = useState<string | null>(null);
  const [addingExpense, setAddingExpense] = useState(false);

  useEffect(() => {
    if (activeExpenseCategories.length > 0 && newCategoryId === "") {
      setNewCategoryId(activeExpenseCategories[0]!.id);
    }
  }, [activeExpenseCategories, newCategoryId]);

  async function submitNewExpense(e: FormEvent) {
    e.preventDefault();
    if (!day) return;
    setNewExpenseError(null);
    if (newCategoryId === "") {
      setNewExpenseError("เลือกหมวดหมู่ก่อนเพิ่มรายการ");
      return;
    }
    const amountSatang = parseAmountToSatang(newAmountText);
    if (amountSatang === null || amountSatang <= 0) {
      setNewExpenseError("กรอกจำนวนเงินให้ถูกต้อง (มากกว่า 0)");
      return;
    }
    setAddingExpense(true);
    try {
      const note = newNote.trim() === "" ? null : newNote.trim().slice(0, NOTE_MAX_LEN);
      const created = await createExpense(property, date, { categoryId: newCategoryId, amountSatang, note });
      applyLocal((prev) => {
        const expenses = [...prev.expenses, created];
        return {
          ...prev,
          expenses,
          totals: computeDayTotals(prev.categories, prev.income, expenses),
          ...touchAudit(prev),
        };
      });
      setNewNote("");
      setNewAmountText("");
    } catch (err) {
      setNewExpenseError(err instanceof Error ? err.message : "เพิ่มรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setAddingExpense(false);
    }
  }

  // ── Day note ─────────────────────────────────────────────────────────

  async function commitDayNote() {
    if (!day) return;
    const trimmed = dayNoteDraft.trim();
    const note = trimmed === "" ? null : trimmed;
    if (note === day.note) return;
    setDayNoteState("saving");
    try {
      const res = await putDayNote(property, date, note);
      applyLocal((prev) => ({ ...prev, note: res.note, ...touchAudit(prev) }));
      setDayNoteState("saved");
      setTimeout(() => setDayNoteState("idle"), 1500);
    } catch {
      setDayNoteState("error");
    }
  }

  // ── Verify / unverify (mgr) ──────────────────────────────────────────

  async function toggleVerify() {
    if (!day) return;
    setVerifyBusy(true);
    setVerifyError(null);
    const nextVerified = !day.verifiedAt;
    try {
      const res = await putVerify(property, date, nextVerified);
      applyLocal((prev) => ({ ...prev, verifiedAt: res.verifiedAt, verifiedBy: res.verifiedBy }));
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "บันทึกสถานะยืนยันไม่สำเร็จ");
    } finally {
      setVerifyBusy(false);
    }
  }

  // ── อัพเดทจากระบบจอง (fill-from-bookings, explicit + confirm-gated) ───
  // Deliberately never a standing auto-fill (see api.md endpoint 20 and the
  // BookingDayPage variance strip): the office's typed figure and the
  // booking rows disagree on roughly a third of historical days, so this
  // always previews a diff and requires an explicit confirm before writing.

  const [diffState, setDiffState] = useState<
    | { status: "closed" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; rows: FillFromBookingsDiffRow[] }
    | { status: "applying"; rows: FillFromBookingsDiffRow[] }
  >({ status: "closed" });

  async function openFillFromBookingsDiff() {
    setDiffState({ status: "loading" });
    try {
      const res = await fillFromBookings(property, date, false);
      setDiffState({ status: "ready", rows: res.diff });
    } catch (err) {
      setDiffState({ status: "error", message: err instanceof Error ? err.message : "โหลดข้อมูลเปรียบเทียบไม่สำเร็จ" });
    }
  }

  function closeFillFromBookingsDiff() {
    setDiffState({ status: "closed" });
  }

  async function confirmFillFromBookings() {
    if (diffState.status !== "ready") return;
    setDiffState({ status: "applying", rows: diffState.rows });
    try {
      await fillFromBookings(property, date, true);
      // The apply response only carries the diff shape (categoryKey/before/
      // after), not full IncomeCell audit fields — refetch the day so
      // income + totals stay server-authoritative rather than reconstructed
      // client-side (same "never recompute independently" rule as totals).
      const fresh = await getDay(property, date);
      setDay(fresh);
      setDiffState({ status: "closed" });
    } catch (err) {
      setDiffState({ status: "error", message: err instanceof Error ? err.message : "อัพเดทจากระบบจองไม่สำเร็จ" });
    }
  }

  // ── Navigation ───────────────────────────────────────────────────────

  function goToDate(newDate: string) {
    navigate(`/${property}/day/${newDate}`);
  }
  function shift(delta: number) {
    navigate(`/${property}/day/${shiftDays(date, delta)}`);
  }
  function goToReport() {
    navigate(`/${property}/report/${date}`);
  }
  function goToBookings() {
    navigate(`/${property}/bookings/${date}`);
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">
        โหลดข้อมูลไม่สำเร็จ: {loadError}
      </div>
    );
  }
  if (!day) {
    return <div className="p-6 text-sm text-ink-muted">กำลังโหลด...</div>;
  }

  const cashIncomeRows = incomeCategories
    .filter((c) => c.isCash)
    .map((c) => ({ category: c, cell: day.income[c.id] }))
    .filter((row): row is { category: Category; cell: NonNullable<typeof row.cell> } => Boolean(row.cell) && row.cell!.amountSatang > 0);

  const hasOtherIncomeItems = day.otherIncome.length > 0;

  return (
    <div className="flex flex-col gap-4 pb-10">
      <DateBar date={date} onPick={goToDate} onShift={shift} />

      {day.monthClosed && (
        <div className="rounded-lg border border-warn/40 bg-gold-50 px-4 py-2.5 text-sm font-medium text-warn">
          เดือนนี้ปิดบัญชีแล้ว — ไม่สามารถแก้ไขรายรับ รายจ่าย หรือหมายเหตุได้
        </div>
      )}

      {/* สถานะข้อมูล: ที่มา + การยืนยัน */}
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
        <span className="text-ink-muted">ที่มาของข้อมูล: {PROVENANCE_LABELS_TH[day.provenance]}</span>
        <div className="flex items-center gap-2">
          {day.verifiedAt ? (
            <span
              title={`ยืนยันโดย ${day.verifiedBy ?? "-"} เมื่อ ${formatUpdatedAt(day.verifiedAt)}`}
              className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-2.5 py-1 text-xs font-medium text-ok"
            >
              ยืนยันแล้ว
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-tint px-2.5 py-1 text-xs font-medium text-ink-muted">
              ยังไม่ยืนยัน
            </span>
          )}
          {/* Any signed-in user may verify: front desk signs off its own day.
              A closed month is frozen, so sign-off is locked with it. */}
          <button
            type="button"
            onClick={toggleVerify}
            disabled={verifyBusy || day.monthClosed}
            title={day.monthClosed ? "เดือนนี้ปิดแล้ว" : undefined}
            className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
          >
            {day.verifiedAt ? "ยกเลิกการยืนยัน" : "ยืนยันข้อมูล"}
          </button>
        </div>
      </section>
      {verifyError && <p className="text-xs text-bad">{verifyError}</p>}

      {/* สถานะรายการจอง */}
      {day.bookingLineCount > 0 && (
        <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
          <span className="text-ink">
            มีรายการจอง <span className="font-semibold tabular-nums">{day.bookingLineCount}</span> รายการ
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goToBookings}
              className="rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-tint"
            >
              ดูรายละเอียดรายรับ
            </button>
            <button
              type="button"
              onClick={openFillFromBookingsDiff}
              disabled={day.monthClosed}
              className="rounded-md bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              อัพเดทจากระบบจอง
            </button>
          </div>
        </section>
      )}

      {diffState.status !== "closed" && (
        <FillFromBookingsDialog
          state={diffState}
          categories={day.categories}
          onConfirm={confirmFillFromBookings}
          onClose={closeFillFromBookingsDiff}
        />
      )}

      {/* Three panels side by side, the way the summary, its **หมายเหตุ
          block and the expense list sit together on the paper: รายรับ |
          เงินสด + ยอดรวม | รายจ่าย. One column on a narrow screen. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
      {/* Panel รายรับ */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">รายรับ</h2>
        {incomeCategories.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">ยังไม่มีหมวดหมู่รายรับ</p>
        ) : (
          <div className="divide-y divide-line">
            {incomeCategories.map((category) => {
              const cell = day.income[category.id];
              // The two รายการอื่นๆ cells become read-only (computed from
              // itemized other-income entries) once any exist for this day —
              // see api.md's RESOLVED note. Identified by categoryKey, never
              // nameTh, so a manager rename keeps this working.
              const isComputedFromOtherIncome =
                category.categoryKey != null && OTHER_INCOME_CATEGORY_KEYS.has(category.categoryKey) && hasOtherIncomeItems;
              return (
                <div key={category.id} className="flex flex-col gap-2 px-4 py-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink">
                      {category.nameTh}
                      {category.archivedAt && <span className="ml-1.5 text-xs text-ink-muted">(เก็บถาวร)</span>}
                    </span>
                    <AmountInput
                      value={cell?.amountSatang ?? null}
                      onCommit={(satang) => commitIncomeAmount(category, satang)}
                      ariaLabel={category.nameTh}
                      disabled={day.monthClosed || isComputedFromOtherIncome}
                    />
                  </div>
                  {isComputedFromOtherIncome && (
                    <p className="text-xs text-ink-muted">
                      คำนวณจากรายการย่อยในหน้ารายละเอียดรายรับ —{" "}
                      <button type="button" onClick={goToBookings} className="font-medium text-brand-500 hover:underline">
                        ไปแก้ไขรายการย่อย
                      </button>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between border-t border-line-strong bg-tint px-4 py-3 text-sm font-semibold text-ink">
          <span>รวมรายรับ</span>
          <span className="tabular-nums">{formatSatang(day.totals.incomeSatang)}</span>
        </div>
      </section>

      {/* Middle column: the paper's **หมายเหตุ cash block, then the day's
          totals. */}
      <div className="flex flex-col gap-4">
        {/* Panel สรุปเงินสดฝากเข้าบัญชี (tint background) — three distinct,
            separately labeled lines per api.md "Report labeling": the
            paper's own line is the GROSS cash income actually banked; it must
            never collapse into the netted figure beneath it. */}
        <section className="rounded-lg border border-line bg-tint p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink">สรุปเงินสดฝากเข้าบัญชี</h2>
          {cashIncomeRows.length === 0 && day.totals.cashExpenseSatang === 0 ? (
            <p className="text-sm text-ink-muted">ยังไม่มีรายการเงินสดวันนี้</p>
          ) : (
            <div className="flex flex-col gap-1 text-sm">
              {cashIncomeRows.map(({ category, cell }) => (
                <div key={category.id} className="flex items-center justify-between gap-3">
                  <span className="text-ink-muted">{category.nameTh}</span>
                  <span className="tabular-nums text-ink">{formatSatang(cell.amountSatang)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-line-strong pt-2 text-base font-bold text-brand-500">
            <span>สรุปเงินสดฝากเข้าบัญชี (ยอดฝากจริง)</span>
            <span className="tabular-nums">{formatSatang(day.totals.cashIncomeSatang)}</span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-dotted border-line-strong pt-2 text-xs text-ink-muted">
            <span>หัก รายจ่ายเงินสดวันนี้ (ไม่ได้หักออกจากยอดฝากข้างต้น)</span>
            <span className="tabular-nums">-{formatSatang(day.totals.cashExpenseSatang)}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-3 text-xs font-medium text-ink-muted">
            <span>คงเหลือสุทธิหลังหักรายจ่ายเงินสด (ข้อมูลอ้างอิง)</span>
            <span className="tabular-nums">{formatSatang(day.totals.cashToDepositSatang)}</span>
          </div>
        </section>

        {/* Panel ยอดรวมประจำวัน */}
        <section className="rounded-lg border border-line bg-panel p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink">ยอดรวมประจำวัน</h2>
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-muted">รวมรายรับ</span>
              <span className="tabular-nums text-ink">{formatSatang(day.totals.incomeSatang)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-muted">รวมรายจ่าย</span>
              <span className="tabular-nums text-ink">
                {day.totals.expenseSatang === 0 ? "" : "-"}
                {formatSatang(day.totals.expenseSatang)}
              </span>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-line-strong pt-2 text-sm font-bold text-ink">
            <span>คงเหลือ</span>
            <span className="tabular-nums">{formatSatang(day.totals.netSatang)}</span>
          </div>
        </section>
      </div>

      {/* Panel รายจ่าย */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">รายจ่าย</h2>
        {day.expenses.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">ยังไม่มีรายจ่ายวันนี้</p>
        ) : (
          <div className="divide-y divide-line">
            {day.expenses.map((item) => {
              const category = day.categories.find((c) => c.id === item.categoryId);
              const options =
                category && category.archivedAt ? [category, ...activeExpenseCategories] : activeExpenseCategories;
              return (
                <div key={item.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <select
                    value={item.categoryId}
                    onChange={(e) => commitExpenseCategory(item, Number(e.target.value))}
                    disabled={day.monthClosed}
                    aria-label="หมวดหมู่รายจ่าย"
                    className="min-w-[9rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
                  >
                    {options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nameTh}
                        {c.archivedAt ? " (เก็บถาวร)" : ""}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    defaultValue={item.note ?? ""}
                    key={`${item.id}-${item.note ?? ""}`}
                    placeholder="หมายเหตุ"
                    aria-label="หมายเหตุรายจ่าย"
                    disabled={day.monthClosed}
                    onBlur={(e) => commitExpenseNote(item, e.target.value)}
                    className="min-w-[8rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
                  />
                  <AmountInput
                    value={item.amountSatang}
                    onCommit={(satang) => commitExpenseAmount(item, satang)}
                    ariaLabel={`จำนวนเงิน ${category?.nameTh ?? ""}`}
                    disabled={day.monthClosed}
                  />
                  <button
                    type="button"
                    onClick={() => removeExpense(item)}
                    disabled={day.monthClosed}
                    className="rounded-md border border-bad/40 px-2.5 py-1.5 text-xs font-medium text-bad hover:bg-bad/10 disabled:opacity-50"
                  >
                    ลบ
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <form
          onSubmit={submitNewExpense}
          className="flex flex-wrap items-center gap-2 border-t border-line bg-tint px-4 py-3"
        >
          <select
            value={newCategoryId}
            onChange={(e) => setNewCategoryId(e.target.value === "" ? "" : Number(e.target.value))}
            disabled={activeExpenseCategories.length === 0 || day.monthClosed}
            aria-label="หมวดหมู่รายจ่ายใหม่"
            className="min-w-[9rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          >
            {activeExpenseCategories.length === 0 && <option value="">ยังไม่มีหมวดหมู่รายจ่าย</option>}
            {activeExpenseCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nameTh}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="หมายเหตุ"
            aria-label="หมายเหตุรายจ่ายใหม่"
            disabled={day.monthClosed}
            className="min-w-[8rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
          <input
            type="text"
            inputMode="decimal"
            value={newAmountText}
            onChange={(e) => setNewAmountText(e.target.value)}
            placeholder="0.00"
            aria-label="จำนวนเงินรายจ่ายใหม่"
            disabled={day.monthClosed}
            className="w-28 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-right tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
          <button
            type="submit"
            disabled={addingExpense || activeExpenseCategories.length === 0 || day.monthClosed}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            เพิ่มรายการ
          </button>
          {newExpenseError && <p className="w-full text-xs text-bad">{newExpenseError}</p>}
        </form>

        <div className="flex items-center justify-between border-t border-line-strong px-4 py-3 text-sm font-semibold text-ink">
          <span>รวมรายจ่าย</span>
          <span className="tabular-nums">{formatSatang(day.totals.expenseSatang)}</span>
        </div>
      </section>
      </div>
      {/* end of the รายรับ | เงินสด+ยอดรวม | รายจ่าย row */}

      {/* Day note beside the audit footer + export, so nothing but these two
          ever sits below the three panels. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
      <section className="rounded-lg border border-line bg-panel p-4 lg:col-span-2">
        <label className="mb-1.5 block text-sm font-semibold text-ink" htmlFor="day-note">
          หมายเหตุ
        </label>
        <textarea
          id="day-note"
          rows={2}
          value={dayNoteDraft}
          onChange={(e) => setDayNoteDraft(e.target.value)}
          onBlur={commitDayNote}
          maxLength={NOTE_MAX_LEN}
          disabled={day.monthClosed}
          placeholder="บันทึกเพิ่มเติมสำหรับวันนี้ (ถ้ามี)"
          className="w-full resize-none rounded-md border border-line-strong bg-panel px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
        />
        {dayNoteState === "saved" && <p className="mt-1 text-xs text-ok">บันทึกแล้ว</p>}
        {dayNoteState === "error" && <p className="mt-1 text-xs text-bad">บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง</p>}
      </section>

      {/* Footer */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
        <p className="text-xs text-ink-muted">
          บันทึกล่าสุด: {day.updatedBy} {formatUpdatedAt(day.updatedAt)}
        </p>
        <button
          type="button"
          onClick={goToReport}
          className="rounded-md bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        >
          ส่งออกรูปภาพ
        </button>
      </div>
      </div>
      {/* end of the หมายเหตุ | footer row */}
    </div>
  );
}

// ── อัพเดทจากระบบจอง — diff dialog ────────────────────────────────────
// Always preview-then-confirm (api.md endpoint 20): shows a per-category
// before/after so the office can see exactly what would change, and clearly
// marks cells the human already owns (manual: true) as skipped rather than
// silently leaving them out of the list.

interface FillFromBookingsDialogProps {
  state:
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; rows: FillFromBookingsDiffRow[] }
    | { status: "applying"; rows: FillFromBookingsDiffRow[] };
  categories: Category[];
  onConfirm: () => void;
  onClose: () => void;
}

function categoryLabel(categories: Category[], row: FillFromBookingsDiffRow): string {
  if (row.categoryId != null) {
    const category = categories.find((c) => c.id === row.categoryId);
    if (category) return category.nameTh;
  }
  return CATEGORY_KEY_LABELS_TH[row.categoryKey];
}

function FillFromBookingsDialog({ state, categories, onConfirm, onClose }: FillFromBookingsDialogProps) {
  const rows = state.status === "ready" || state.status === "applying" ? state.rows : [];
  const changingRows = rows.filter((r) => !r.skippedManual && r.beforeSatang !== r.afterSatang);
  const skippedRows = rows.filter((r) => r.skippedManual);
  const unchangedRows = rows.filter((r) => !r.skippedManual && r.beforeSatang === r.afterSatang);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-panel shadow-lg">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">อัพเดทจากระบบจอง</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            เปรียบเทียบยอดที่กรอกไว้กับยอดที่คำนวณจากรายการจอง ก่อนบันทึกจริง
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {state.status === "loading" && <p className="text-sm text-ink-muted">กำลังโหลดข้อมูลเปรียบเทียบ...</p>}
          {state.status === "error" && <p className="text-sm text-bad">{state.message}</p>}

          {(state.status === "ready" || state.status === "applying") && rows.length === 0 && (
            <p className="text-sm text-ink-muted">ไม่มีรายการจองที่นำมาคำนวณได้สำหรับวันนี้</p>
          )}

          {(state.status === "ready" || state.status === "applying") && rows.length > 0 && (
            <div className="flex flex-col gap-3">
              {changingRows.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold text-ink-muted">รายการที่จะเปลี่ยนแปลง</p>
                  {changingRows.map((row) => (
                    <div
                      key={row.categoryKey}
                      className="flex items-center justify-between rounded-md border border-line-strong px-2.5 py-1.5 text-sm"
                    >
                      <span className="text-ink">{categoryLabel(categories, row)}</span>
                      <span className="tabular-nums text-ink-muted">
                        {formatSatang(row.beforeSatang)} <span className="text-ink-muted">{"->"}</span>{" "}
                        <span className="font-semibold text-brand-500">{formatSatang(row.afterSatang)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {skippedRows.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold text-ink-muted">ข้ามไว้ (กรอกเองแล้ว)</p>
                  {skippedRows.map((row) => (
                    <div
                      key={row.categoryKey}
                      className="flex items-center justify-between rounded-md border border-line px-2.5 py-1.5 text-sm text-ink-muted"
                    >
                      <span>{categoryLabel(categories, row)}</span>
                      <span className="tabular-nums">
                        {formatSatang(row.beforeSatang)}{" "}
                        <span className="rounded-full bg-tint px-1.5 py-0.5 text-[11px]">ข้าม</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {unchangedRows.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold text-ink-muted">ตรงกันอยู่แล้ว</p>
                  {unchangedRows.map((row) => (
                    <div
                      key={row.categoryKey}
                      className="flex items-center justify-between rounded-md px-2.5 py-1 text-sm text-ink-muted"
                    >
                      <span>{categoryLabel(categories, row)}</span>
                      <span className="tabular-nums">{formatSatang(row.afterSatang)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={state.status === "applying"}
            className="rounded-md border border-line-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
          >
            ยกเลิก
          </button>
          {state.status === "ready" && changingRows.length > 0 && (
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600"
            >
              ยืนยันอัพเดท
            </button>
          )}
          {state.status === "applying" && (
            <button
              type="button"
              disabled
              className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white opacity-50"
            >
              กำลังบันทึก...
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
