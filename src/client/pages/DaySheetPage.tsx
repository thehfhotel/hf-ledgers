import { useEffect, useMemo, useState, type FormEvent } from "react";
import { shiftDays } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import { computeDayTotals } from "../../shared/totals.ts";
import { NOTE_MAX_LEN, type Category, type DaySheet, type ExpenseItem, type Property } from "../../shared/types.ts";
import {
  createExpense,
  deleteExpense,
  getDay,
  getMe,
  putDayNote,
  putIncomeCell,
  updateExpense,
} from "../api.ts";
import { navigate } from "../App.tsx";
import { AmountInput } from "../components/AmountInput.tsx";
import { DateBar } from "../components/DateBar.tsx";

interface Props {
  property: Property;
  date: string;
}

// The one income category whose entry row also carries a free-text note
// (see api.md: IncomeCell.note "carries รายการอื่นๆ's free-text"). Matched
// by name because the schema has no dedicated flag for it — a manager
// spelling-fix rename keeps working (in-place relabel per the contract's
// rename model); a genuine meaning-change is archive+new anyway, so it
// naturally loses this special-casing along with everything else.
const OTHER_INCOME_LABEL = "รายการอื่นๆ";

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
  const [otherNoteDraft, setOtherNoteDraft] = useState("");
  const [dayNoteDraft, setDayNoteDraft] = useState("");
  const [dayNoteState, setDayNoteState] = useState<SimpleSaveState>("idle");

  useEffect(() => {
    getMe()
      .then((me) => setMeEmail(me.email))
      .catch(() => {
        /* /api/me failing just means the footer falls back to server-attributed emails */
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDay(null);
    setLoadError(null);
    setDayNoteState("idle");
    getDay(property, date)
      .then((sheet) => {
        if (cancelled) return;
        setDay(sheet);
        setDayNoteDraft(sheet.note ?? "");
        const otherCategory = sheet.categories.find(
          (c) => c.kind === "income" && c.nameTh === OTHER_INCOME_LABEL,
        );
        setOtherNoteDraft(otherCategory ? (sheet.income[otherCategory.id]?.note ?? "") : "");
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
    const isOther = category.nameTh === OTHER_INCOME_LABEL;
    const prevIncome = day.income;
    const prevTotals = day.totals;
    const noteForOther = isOther
      ? otherNoteDraft.trim() === ""
        ? null
        : otherNoteDraft.trim().slice(0, NOTE_MAX_LEN)
      : undefined;

    const optimisticIncome = { ...day.income };
    if (satang === null || satang === 0) {
      delete optimisticIncome[category.id];
    } else {
      optimisticIncome[category.id] = {
        categoryId: category.id,
        amountSatang: satang,
        note: isOther ? (noteForOther ?? null) : (day.income[category.id]?.note ?? null),
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
      // Non-รายการอื่นๆ rows never surface a note field, so their commits
      // omit the `note` key entirely rather than risk clobbering a value
      // this UI never showed the user in the first place.
      const body = isOther ? { amountSatang: satang, note: noteForOther } : { amountSatang: satang };
      const res = await putIncomeCell(property, date, category.id, body);
      applyLocal((prev) => ({ ...prev, income: res.income, totals: res.totals, ...touchAudit(prev) }));
      if (isOther) setOtherNoteDraft(res.income[category.id]?.note ?? "");
    } catch (err) {
      applyLocal((prev) => ({ ...prev, income: prevIncome, totals: prevTotals }));
      throw err;
    }
  }

  async function commitOtherNote() {
    if (!day) return;
    const category = incomeCategories.find((c) => c.nameTh === OTHER_INCOME_LABEL);
    if (!category) return;
    const existing = day.income[category.id];
    // A note lives inside an income_amounts row (api.md), which only exists
    // once an amount is saved (null/0 amount deletes the row). Without an
    // amount yet, keep the draft local-only — the hint under the field
    // explains this — rather than send a request that has nothing to attach to.
    if (!existing || existing.amountSatang === 0) return;

    const trimmed = otherNoteDraft.trim();
    const note = trimmed === "" ? null : trimmed.slice(0, NOTE_MAX_LEN);
    if (note === existing.note) return;

    const prevIncome = day.income;
    const optimisticIncome = { ...day.income, [category.id]: { ...existing, note } };
    applyLocal((prev) => ({ ...prev, income: optimisticIncome }));
    try {
      const res = await putIncomeCell(property, date, category.id, {
        amountSatang: existing.amountSatang,
        note,
      });
      applyLocal((prev) => ({ ...prev, income: res.income, totals: res.totals, ...touchAudit(prev) }));
      setOtherNoteDraft(res.income[category.id]?.note ?? "");
    } catch {
      applyLocal((prev) => ({ ...prev, income: prevIncome }));
      // Keep the user's typed draft on screen even though the save failed —
      // otherNoteDraft is untouched, so nothing they typed is lost.
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

  return (
    <div className="flex flex-col gap-4 pb-10">
      <DateBar date={date} onPick={goToDate} onShift={shift} />

      {/* Panel รายรับ */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">รายรับ</h2>
        {incomeCategories.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">ยังไม่มีหมวดหมู่รายรับ</p>
        ) : (
          <div className="divide-y divide-line">
            {incomeCategories.map((category) => {
              const cell = day.income[category.id];
              const isOther = category.nameTh === OTHER_INCOME_LABEL;
              return (
                <div key={category.id} className="flex flex-col gap-2 px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink">
                      {category.nameTh}
                      {category.archivedAt && <span className="ml-1.5 text-xs text-ink-muted">(เก็บถาวร)</span>}
                    </span>
                    <AmountInput
                      value={cell?.amountSatang ?? null}
                      onCommit={(satang) => commitIncomeAmount(category, satang)}
                      ariaLabel={category.nameTh}
                    />
                  </div>
                  {isOther && (
                    <div>
                      <input
                        type="text"
                        value={otherNoteDraft}
                        onChange={(e) => setOtherNoteDraft(e.target.value)}
                        onBlur={commitOtherNote}
                        maxLength={NOTE_MAX_LEN}
                        placeholder="หมายเหตุ"
                        aria-label="หมายเหตุรายการอื่นๆ"
                        className="w-full rounded-md border border-line-strong bg-panel px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                      />
                      {(!cell || cell.amountSatang === 0) && otherNoteDraft.trim() !== "" && (
                        <p className="mt-1 text-xs text-ink-muted">จะบันทึกหมายเหตุเมื่อกรอกจำนวนเงินด้านบน</p>
                      )}
                    </div>
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

      {/* Panel รายจ่าย */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">รายจ่าย</h2>
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
                    aria-label="หมวดหมู่รายจ่าย"
                    className="min-w-[9rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
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
                    onBlur={(e) => commitExpenseNote(item, e.target.value)}
                    className="min-w-[8rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  />
                  <AmountInput
                    value={item.amountSatang}
                    onCommit={(satang) => commitExpenseAmount(item, satang)}
                    ariaLabel={`จำนวนเงิน ${category?.nameTh ?? ""}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeExpense(item)}
                    className="rounded-md border border-bad/40 px-2.5 py-1.5 text-xs font-medium text-bad hover:bg-bad/10"
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
            disabled={activeExpenseCategories.length === 0}
            aria-label="หมวดหมู่รายจ่ายใหม่"
            className="min-w-[9rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
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
            className="min-w-[8rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
          <input
            type="text"
            inputMode="decimal"
            value={newAmountText}
            onChange={(e) => setNewAmountText(e.target.value)}
            placeholder="0.00"
            aria-label="จำนวนเงินรายจ่ายใหม่"
            className="w-28 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-right tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
          <button
            type="submit"
            disabled={addingExpense || activeExpenseCategories.length === 0}
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

      {/* Panel สรุปเงินสดฝากเข้าบัญชี (tint background) */}
      <section className="rounded-lg border border-line bg-tint p-4">
        <h2 className="mb-2 text-sm font-semibold text-ink">สรุปเงินสดฝากเข้าบัญชี</h2>
        {cashIncomeRows.length === 0 && day.totals.cashExpenseSatang === 0 ? (
          <p className="text-sm text-ink-muted">ยังไม่มีรายการเงินสดวันนี้</p>
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            {cashIncomeRows.map(({ category, cell }) => (
              <div key={category.id} className="flex items-center justify-between">
                <span className="text-ink-muted">{category.nameTh}</span>
                <span className="tabular-nums text-ink">{formatSatang(cell.amountSatang)}</span>
              </div>
            ))}
            {day.totals.cashExpenseSatang > 0 && (
              <div className="flex items-center justify-between text-bad">
                <span>หัก รายจ่ายเงินสด</span>
                <span className="tabular-nums">-{formatSatang(day.totals.cashExpenseSatang)}</span>
              </div>
            )}
          </div>
        )}
        <div className="mt-2 flex items-center justify-between border-t border-line-strong pt-2 text-base font-bold text-brand-500">
          <span>ยอดฝากเข้าบัญชี</span>
          <span className="tabular-nums">{formatSatang(day.totals.cashToDepositSatang)}</span>
        </div>
      </section>

      {/* Day note */}
      <section className="rounded-lg border border-line bg-panel p-4">
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
          placeholder="บันทึกเพิ่มเติมสำหรับวันนี้ (ถ้ามี)"
          className="w-full resize-none rounded-md border border-line-strong bg-panel px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        />
        {dayNoteState === "saved" && <p className="mt-1 text-xs text-ok">บันทึกแล้ว</p>}
        {dayNoteState === "error" && <p className="mt-1 text-xs text-bad">บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง</p>}
      </section>

      {/* Footer */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-center sm:justify-between">
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
  );
}
