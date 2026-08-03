import { useEffect, useMemo, useRef, useState } from "react";
import { isAccrualDay } from "../../shared/accrual.ts";
import { RECONCILE_TOLERANCE_SATANG, deriveIncomeFromBookings } from "../../shared/bookings.ts";
import { shiftDays } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import { AMOUNT_IN_TEXT_WARNING_TH, looksLikeAmountInText } from "../../shared/textAmount.ts";
import { computeDayTotals } from "../../shared/totals.ts";
import {
  DEPOSIT_TENDER_LABELS_TH,
  NOTE_MAX_LEN,
  TENDER_TO_CATEGORY_KEY,
  type BookingLine,
  type CashAdjustmentAmounts,
  type CashBlockAmounts,
  type Category,
  type CategoryKey,
  type DaySheet,
  type ExpenseItem,
  type Property,
} from "../../shared/types.ts";
import { activeCashAdjustmentPatch, activeCashOverridePatch } from "../cashBlockPatches.ts";
import { CASH_ADJUSTMENT_FIELDS, CASH_BLOCK_FIELDS, PROVENANCE_LABELS_TH } from "../labels.ts";
import {
  deleteExpense,
  fillFromBookings,
  getDay,
  getDayAudit,
  getMe,
  listBookingLines,
  listDays,
  putCashBlock,
  putDayNote,
  putIncomeCell,
  putVerify,
  updateExpense,
  type FillFromBookingsDiffRow,
} from "../api.ts";
import { navigate } from "../App.tsx";
import { AmountInput } from "../components/AmountInput.tsx";
import { DateBar } from "../components/DateBar.tsx";
import { PrintableDaySummary } from "../components/PrintableDaySummary.tsx";
import { PrintPortal } from "../components/PrintPortal.tsx";
import { computeWeekWindow, weekWindowMonths, zeroFillWeek, type WeekDayIncome } from "../components/printWeekChart.ts";
import { usePrintExport } from "../components/usePrintExport.ts";
import { PropertyBadge } from "./PropertyBadge.tsx";

interface Props {
  property: Property;
  date: string;
}

// The two income categories computed from itemized other-income entries
// once any exist (see api.md's RESOLVED รายการอื่นๆ note) — identified by
// categoryKey, never nameTh, because managers can rename categories freely.
const OTHER_INCOME_CATEGORY_KEYS = new Set(["other_cash", "other_transfer"]);

// Wave C (docs/adr/0001): `deposit`/`deposit_credit` KEEP their key and
// meaning after the accrual cutover (history is not restated — hf-mcp
// still labels them, and archiving is refused server-side for a keyed
// category), but are retired at the UI layer going forward — post-cutover
// they render read-only, and only when they actually carry money (a stray
// pre-cutover balance), never as an always-visible empty row inviting new
// entries under a rule that no longer applies.
const RETIRED_POST_CUTOVER_CATEGORY_KEYS = new Set(["deposit", "deposit_credit"]);

// Fallback labels for the fill-from-bookings diff, verbatim from api.md's
// seed list — needed because a diff row's categoryId is null when the
// property has no active category seeded with that key yet.
const CATEGORY_KEY_LABELS_TH: Record<CategoryKey, string> = {
  deposit: "มัดจำล่วงหน้า โอน",
  deposit_credit: "มัดจำล่วงหน้า เครดิต",
  deposit_applied: "มัดจำล่วงหน้า (ตัดยอด)",
  room_cash: "ค่าห้องเงินสด",
  credit_kbank: "บัตรเครดิต/กสิกร",
  credit_icbc: "บัตรเครดิต ICBC",
  transfer_kbank: "โอน/กสิกร",
  transfer_icbc: "โอน ICBC",
  web: "เว็ปไซด์",
  other_cash: "รายการอื่นๆ เงินสด",
  other_transfer: "รายการอื่นๆ โอน",
  other_credit: "รายการอื่นๆ เครดิต",
  bar_cash: "บาร์น้ำ เงินสด",
  bar_transfer: "บาร์น้ำ โอน",
  bar_credit: "บาร์น้ำ เครดิต",
};

/** The seven income categories a booking row can derive (see
 * TENDER_TO_CATEGORY_KEY). Tender "other" has no CategoryKey, and bar /
 * รายการอื่นๆ income has no booking column at all, so both sides of the
 * variance strip are summed over THIS set only — otherwise every day with
 * bar sales would read as a mismatch. Same set, same reason, as
 * HistoryPage's month-close preflight. */
const DERIVABLE_CATEGORY_KEYS: CategoryKey[] = [...new Set(Object.values(TENDER_TO_CATEGORY_KEY) as CategoryKey[])];

type SimpleSaveState = "idle" | "saving" | "saved" | "error";

/**
 * The amount-in-text tripwire's inline hint. Advisory only — nothing is
 * blocked and the text saves as typed. The wording itself lives in
 * src/shared/textAmount.ts so every field that shows it (day note, expense
 * notes here, รายการอื่นๆ descriptions and booking หมายเหตุ elsewhere) reads
 * identically.
 */
function AmountInTextHint({ text, className = "" }: { text: string; className?: string }) {
  if (!looksLikeAmountInText(text)) return null;
  return <p className={"text-xs text-warn " + className}>{AMOUNT_IN_TEXT_WARNING_TH}</p>;
}

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
  const [bookingLines, setBookingLines] = useState<BookingLine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meEmail, setMeEmail] = useState<string | null>(null);
  const [dayNoteDraft, setDayNoteDraft] = useState("");
  const [dayNoteState, setDayNoteState] = useState<SimpleSaveState>("idle");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  // Wave 1 (docs/plan-audit-hub-slips.md): the ตรวจสอบ tab's day-audit
  // progress, fetched fail-silent (null on ANY failure — PMS not
  // configured, a query error, network — this is secondary info on the day
  // sheet, never worth its own error banner). `null` also means "not yet
  // loaded", so the chip simply doesn't render until a real value lands.
  const [auditProgress, setAuditProgress] = useState<{ checked: number; total: number } | null>(null);

  // ── Weekly income chart (print-only, PrintableDaySummary.tsx) ─────────
  // null until loaded, and left null on any fetch failure — the chart
  // section is purely decorative context, so a listDays() hiccup must never
  // break this page or the rest of the print. See printWeekChart.ts for the
  // pure week-window/zero-fill math.
  const [weekDays, setWeekDays] = useState<WeekDayIncome[] | null>(null);

  // ── พิมพ์ / PDF — the day summary only (no booking grid), landscape ────
  // Landscape (owner decision, 2026-07-31, switched from portrait): pairs
  // with DayTenderSummary's own two-column layout (reportSheetBlocks.tsx)
  // to keep the day summary on one A4 page at a readable scale — see
  // PrintableDaySummary.tsx's module comment for the full reasoning. Same
  // orientation ReportSheet.tsx/BookingDayPage's bookingsOnly print already
  // uses. Read-only actions: never gated on monthClosed — see
  // usePrintExport.ts / PrintableDaySummary.tsx.
  const printExport = usePrintExport({ orientation: "landscape", property, date });

  useEffect(() => {
    getMe()
      .then((me) => {
        setMeEmail(me.email);
      })
      .catch(() => {
        /* /api/me failing just means the footer falls back to server-attributed emails */
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAuditProgress(null);
    getDayAudit(property, date)
      .then((res) => {
        if (!cancelled) setAuditProgress({ checked: res.checkedCount, total: res.totalCount });
      })
      .catch(() => {
        /* fail-silent — see auditProgress's own doc comment above */
      });
    return () => {
      cancelled = true;
    };
  }, [property, date]);

  useEffect(() => {
    let cancelled = false;
    setDay(null);
    setBookingLines(null);
    setLoadError(null);
    setDayNoteState("idle");
    setVerifyError(null);
    getDay(property, date)
      .then((sheet) => {
        if (cancelled) return;
        setDay(sheet);
        setDayNoteDraft(sheet.note ?? "");
        // The variance strip's booking side. Fetched only when the day has
        // booking rows at all, and a failure just leaves the strip out —
        // the summary itself must never depend on it.
        if (sheet.bookingLineCount === 0) {
          setBookingLines([]);
          return;
        }
        listBookingLines(property, date)
          .then((res) => {
            if (!cancelled) setBookingLines(res.lines);
          })
          .catch(() => {
            if (!cancelled) setBookingLines([]);
          });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      });
    return () => {
      cancelled = true;
    };
  }, [property, date]);

  // Independent of the main day load above: covers the Monday-start week
  // containing `date`, fetching one listDays() call per calendar month the
  // week touches (one, almost always — two only when the week straddles a
  // month boundary). Never surfaces an error — see the field doc above.
  useEffect(() => {
    let cancelled = false;
    setWeekDays(null);
    const weekWindow = computeWeekWindow(date);
    const months = weekWindowMonths(weekWindow);
    Promise.all(months.map((month) => listDays(property, month)))
      .then((results) => {
        if (cancelled) return;
        const incomeByDate = new Map<string, number>();
        for (const res of results) {
          for (const d of res.days) incomeByDate.set(d.date, d.incomeSatang);
        }
        setWeekDays(zeroFillWeek(weekWindow, incomeByDate));
      })
      .catch(() => {
        if (!cancelled) setWeekDays(null);
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

  // ── Standing booking-vs-summary variance ──────────────────────────────
  // Measured across the four imported workbooks, the office hand-adjusts its
  // summary away from its own booking rows on 83% of HF days and 51% of
  // Ville days. That is a habit, not an error: this strip only makes it
  // visible and lets the reason be recorded. It never blocks, never nags,
  // and never writes a figure — อัพเดทจากรายละเอียดรายรับ remains the only path
  // that changes a number.
  //
  // Computed from the booking lines through the shared
  // deriveIncomeFromBookings(), deliberately NOT from the
  // POST fill-from-bookings preview: that preview reports
  // afterSatang === beforeSatang for any cell flagged `manual`, and the
  // Excel importer stamped every backfilled cell manual — so it reads zero
  // variance on precisely the days this strip exists for.
  const variance = useMemo(() => {
    if (!day || !bookingLines || bookingLines.length === 0) return null;
    const derived = deriveIncomeFromBookings(bookingLines);
    const categoryKeyById = new Map(day.categories.map((c) => [c.id, c.categoryKey]));

    const typedByKey = new Map<CategoryKey, number>();
    for (const cell of Object.values(day.income)) {
      const key = categoryKeyById.get(cell.categoryId);
      if (key && DERIVABLE_CATEGORY_KEYS.includes(key)) {
        typedByKey.set(key, (typedByKey.get(key) ?? 0) + cell.amountSatang);
      }
    }

    let derivedSatang = 0;
    let typedSatang = 0;
    const rows: { categoryKey: CategoryKey; typedSatang: number; derivedSatang: number }[] = [];
    for (const key of DERIVABLE_CATEGORY_KEYS) {
      const keyDerived = derived[key] ?? 0;
      const keyTyped = typedByKey.get(key) ?? 0;
      derivedSatang += keyDerived;
      typedSatang += keyTyped;
      if (keyDerived !== keyTyped) rows.push({ categoryKey: key, typedSatang: keyTyped, derivedSatang: keyDerived });
    }

    // Sign matches HistoryPage's preflight: booking-derived minus typed, so a
    // positive delta means the summary was typed LOWER than the booking rows.
    const deltaSatang = derivedSatang - typedSatang;
    return {
      derivedSatang,
      typedSatang,
      deltaSatang,
      beyondTolerance: Math.abs(deltaSatang) > RECONCILE_TOLERANCE_SATANG,
      rows,
    };
  }, [day, bookingLines]);

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
    const prevCashBlock = day.cashBlock;

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
      // P3 (Opus money-review, 2026-07-31): PUT income also returns the
      // freshly recomputed cashBlock (room/bar cash feed straight into it)
      // — without merging it here, the bold "ยอดฝากจริง" line below (and
      // this page's print/PDF export of it) would go stale on every income
      // edit until the next full day reload.
      const res = await putIncomeCell(property, date, category.id, { amountSatang: satang });
      applyLocal((prev) => ({
        ...prev,
        income: res.income,
        totals: res.totals,
        cashBlock: res.cashBlock,
        ...touchAudit(prev),
      }));
    } catch (err) {
      applyLocal((prev) => ({ ...prev, income: prevIncome, totals: prevTotals, cashBlock: prevCashBlock }));
      throw err;
    }
  }

  // ── Cash-block override (roomCashSatang/otherCashSatang/barCashSatang) ─
  // Same PUT .../cash-block endpoint and merge semantics BookingDayPage.tsx
  // already uses for its "**หมายเหตุ (สรุปเงินสด)" panel — surfaced here too
  // so a manager reviewing the day summary can see AND correct a till
  // count without detouring to the bookings page. bankedSatang itself is
  // deliberately left out of THIS editor (it stays BookingDayPage's own
  // field to type into directly) — but the panel's bold "ยอดฝากจริง" line
  // below DOES read cashBlock.derived/entered.bankedSatang (see the JSX),
  // so a room/other/bar override here still shows up there once bankedSatang
  // itself is also overridden on BookingDayPage. day.totals (gross/
  // deduction/net, per api.md "Report labeling") stay computed independently
  // and are never re-derived from cashBlock.
  //
  // Every commit below re-sends ONLY the GENUINELY active fields on the
  // other half — activeCashOverridePatch/activeCashAdjustmentPatch, shared
  // with BookingDayPage.tsx via src/client/cashBlockPatches.ts — NEVER a
  // blind `...cashBlock.entered` spread. `entered` is a fully-merged
  // CashBlockAmounts the moment ANY field is overridden (every untouched
  // field falls back to `derived` AT MERGE TIME), so re-sending it
  // wholesale would store that PRE-adjustment `bankedSatang` snapshot as a
  // real, permanent override — freezing the bank line against every later
  // heldBack/broughtForward change (Opus money-review P0, 2026-07-31; see
  // cashBlockPatches.ts's module doc for the three proven-broken sequences
  // this fixes).
  async function commitCashOverrideField(field: keyof CashBlockAmounts, satang: number | null) {
    if (!day) return;
    const prevCashBlock = day.cashBlock;
    const baseline = day.cashBlock.entered ?? day.cashBlock.derived;
    const nextEntered: CashBlockAmounts = { ...baseline, [field]: satang ?? 0 };
    applyLocal((prev) => ({ ...prev, cashBlock: { ...prev.cashBlock, entered: nextEntered } }));
    try {
      const res = await putCashBlock(property, date, {
        ...activeCashOverridePatch(day.cashBlock),
        [field]: satang ?? 0,
        ...activeCashAdjustmentPatch(day.cashBlock),
      });
      applyLocal((prev) => ({ ...prev, cashBlock: res, ...touchAudit(prev) }));
    } catch (err) {
      applyLocal((prev) => ({ ...prev, cashBlock: prevCashBlock }));
      throw err;
    }
  }

  async function clearCashOverride() {
    if (!day) return;
    const prevCashBlock = day.cashBlock;
    applyLocal((prev) => ({ ...prev, cashBlock: { ...prev.cashBlock, entered: null } }));
    try {
      // Scoped to the four till-count fields only: when an adjustment is
      // also recorded, re-send it explicitly so this button — which only
      // promises to clear the till-count override — doesn't silently wipe
      // the held-back/brought-forward adjustment too.
      const adjustment = activeCashAdjustmentPatch(day.cashBlock);
      const res = await putCashBlock(property, date, Object.keys(adjustment).length > 0 ? adjustment : null);
      applyLocal((prev) => ({ ...prev, cashBlock: res, ...touchAudit(prev) }));
    } catch (err) {
      applyLocal((prev) => ({ ...prev, cashBlock: prevCashBlock }));
      window.alert(err instanceof Error ? err.message : "ล้างการปรับยอดไม่สำเร็จ");
    }
  }

  // ── Cash adjustment (heldBackSatang/broughtForwardSatang) ─────────────
  // Deposit-machine reconciliation rows (docs/plan-unify-exports-tender-
  // split.md item 6, Wave C, owner request 2026-07-31): small change/coins
  // that couldn't go into the deposit machine. Same endpoint/persistence as
  // the override above, but deliberately does NOT pin the four till-count
  // fields into existence — see CashAdjustmentAmounts (shared/types.ts):
  // unlike those four, these two have no "derived" fallback worth freezing,
  // so an adjustment-only edit must never create a phantom override
  // (activeCashOverridePatch, never a blind `entered` spread — see the
  // override section's comment above for why).
  async function commitCashAdjustmentField(field: keyof CashAdjustmentAmounts, satang: number | null) {
    if (!day) return;
    const prevCashBlock = day.cashBlock;
    const value = satang ?? 0;
    applyLocal((prev) => ({ ...prev, cashBlock: { ...prev.cashBlock, [field]: value } }));
    try {
      const res = await putCashBlock(property, date, {
        ...activeCashOverridePatch(day.cashBlock),
        ...activeCashAdjustmentPatch(day.cashBlock),
        [field]: value,
      });
      applyLocal((prev) => ({ ...prev, cashBlock: res, ...touchAudit(prev) }));
    } catch (err) {
      applyLocal((prev) => ({ ...prev, cashBlock: prevCashBlock }));
      throw err;
    }
  }

  async function clearCashAdjustment() {
    if (!day) return;
    const prevCashBlock = day.cashBlock;
    applyLocal((prev) => ({ ...prev, cashBlock: { ...prev.cashBlock, heldBackSatang: null, broughtForwardSatang: null } }));
    try {
      const res = await putCashBlock(property, date, activeCashOverridePatch(day.cashBlock));
      applyLocal((prev) => ({ ...prev, cashBlock: res, ...touchAudit(prev) }));
    } catch (err) {
      applyLocal((prev) => ({ ...prev, cashBlock: prevCashBlock }));
      window.alert(err instanceof Error ? err.message : "ล้างการปรับยอดไม่สำเร็จ");
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

  // Live text of each expense note while it is being typed, so the
  // amount-in-text tripwire can read it before the blur that saves it. A row
  // with no entry here falls back to its saved note — an already-saved
  // "ค่าซ่อม (โอนเงิน300)" is flagged on arrival, not only once edited.
  const [expenseNoteDrafts, setExpenseNoteDrafts] = useState<Record<number, string>>({});

  function setExpenseNoteDraft(id: number, text: string) {
    setExpenseNoteDrafts((prev) => ({ ...prev, [id]: text }));
  }
  function clearExpenseNoteDraft(id: number) {
    setExpenseNoteDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // ── Day note ─────────────────────────────────────────────────────────
  // Editable even on a closed month, per api.md's Wave 2 note on endpoint 9:
  // the note is commentary, not a figure, and after a close it is exactly
  // the thing still worth recording. Every amount on this page stays locked.

  const dayNoteRef = useRef<HTMLTextAreaElement | null>(null);

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

  /**
   * The variance strip's one action: seed the day note with the reason line
   * and hand the caret over. It only prefills — the person types the reason
   * and the normal save-on-blur writes it, so nothing is recorded that a
   * human did not write.
   */
  function startVarianceReason(deltaSatang: number) {
    const direction = deltaSatang > 0 ? "น้อยกว่า" : "มากกว่า";
    // The amount is parenthesised and carries no "บาท": written as
    // "... 3,870.00 บาท" the line would trip the app's own amount-in-text
    // tripwire on the note it just wrote, which reads as a bug.
    const line = `กรอกยอด${direction}รายการจอง (ต่าง ${formatSatang(Math.abs(deltaSatang))}) เพราะ `;
    setDayNoteDraft((prev) => {
      const base = prev.trim();
      return (base === "" ? line : `${base}\n${line}`).slice(0, NOTE_MAX_LEN);
    });
    // Focus after the prefill has rendered, then park the caret at the end so
    // typing continues the sentence.
    requestAnimationFrame(() => {
      const el = dayNoteRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
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

  // ── อัพเดทจากรายละเอียดรายรับ (fill-from-bookings, explicit + confirm-gated) ─
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
      setDiffState({ status: "error", message: err instanceof Error ? err.message : "อัพเดทจากรายละเอียดรายรับไม่สำเร็จ" });
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
  // Wave C (docs/adr/0001): gates the deposit/deposit_credit retirement
  // below and the deposit_credit double-entry warning's own visibility.
  const accrualDay = isAccrualDay(property, date);

  // The รายจ่าย panel is LEGACY VISIBILITY ONLY (owner request 2026-07-31,
  // docs/plan-unify-exports-tender-split.md item 1: expenses now live in the
  // separate Expense Ledger app; this page's entry surface is retired). A
  // day with rows already recorded still shows them — editable/deletable so
  // a mistake can be corrected — but there is no add-new-row affordance,
  // and the panel disappears entirely once the last row is gone. The grid
  // below drops to two columns in that (now-normal) case rather than
  // leaving a dangling empty third slot.
  const hasExpenseRows = day.expenses.length > 0;

  // bankedSatang itself is BookingDayPage.tsx's own field to type an
  // override INTO (see the commitCashOverrideField comment above) — this
  // page edits only the three components that roll up into it, plus the
  // heldBack/broughtForward adjustment below. The bold "ยอดฝากจริง" line
  // further down still READS bankedSatang (entered wins over derived), the
  // same figure BookingDayPage's cash panel and every print/export show —
  // see reportSheetBlocks.tsx's DayTenderSummary for the identical reading.
  const cashOverrideFields = CASH_BLOCK_FIELDS.filter((field) => field.key !== "bankedSatang");
  const bankedDerived = day.cashBlock.derived.bankedSatang;
  const bankedEntered = day.cashBlock.entered?.bankedSatang;
  const bankedShown = bankedEntered ?? bankedDerived;
  const bankedOverridden = bankedEntered != null && bankedEntered !== bankedDerived;
  // P1 (Opus money-review, 2026-07-31): the two lines under the bold
  // ยอดฝากจริง must close the printed arithmetic — หัก รายจ่ายเงินสดวันนี้ /
  // คงเหลือสุทธิ read off bankedShown (the actual figure just displayed,
  // override AND adjustment included), never day.totals.cashExpenseSatang/
  // cashToDepositSatang, which are gross-cash-derived and would silently
  // stop matching once either exists — these two never disagree with the
  // panel's own bold line above them.
  const bankedNetOfCashExpenseSatang = bankedShown - day.totals.cashExpenseSatang;

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold text-ink">สรุปวัน</h1>
        <PropertyBadge property={property} />
      </div>
      <DateBar date={date} onPick={goToDate} onShift={shift} />

      {day.monthClosed && (
        <div className="rounded-lg border border-warn/40 bg-gold-50 px-4 py-2.5 text-sm font-medium text-warn">
          เดือนนี้ปิดบัญชีแล้ว — แก้ไขรายรับ รายจ่าย และการยืนยันไม่ได้ (ยังบันทึกหมายเหตุได้)
        </div>
      )}

      {/* สถานะข้อมูล: ที่มา + การยืนยัน + ตรวจสอบ (Wave 1) */}
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
        <span className="text-ink-muted">ที่มาของข้อมูล: {PROVENANCE_LABELS_TH[day.provenance]}</span>
        <div className="flex items-center gap-2">
          {/* Wave 1 (docs/plan-audit-hub-slips.md): "ตรวจแล้ว n/m" links to
              the ตรวจสอบ page's ตรวจรายวัน tab, preselected on THIS day —
              independent of ยืนยันข้อมูล (a separate audit trail entirely, by
              owner decision — see CONTEXT.md's ตรวจสอบ entry). Fail-silent:
              simply absent (auditProgress stays null) when the fetch fails
              for any reason, including PMS-not-configured. */}
          {auditProgress && (
            <button
              type="button"
              onClick={() => navigate(`/${property}/deposits?tab=audit&date=${date}`)}
              title="ไปหน้าตรวจสอบรายวัน"
              className="inline-flex items-center gap-1 rounded-full bg-tint px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-line"
            >
              ตรวจแล้ว {auditProgress.checked}/{auditProgress.total}
            </button>
          )}
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
              อัพเดทจากรายละเอียดรายรับ
            </button>
          </div>
        </section>
      )}

      {/* มัดจำล่วงหน้า — READ-ONLY mirror (Wave C, docs/adr/0001). Hand
          entry/edit stays the bookings page's job (BookingDayPage.tsx);
          this summary just makes today's deposit activity visible without
          leaving the day-sheet view. */}
      {day.deposits.length > 0 && (
        <section className="rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">มัดจำล่วงหน้า (ไม่ใช่รายรับ)</h2>
            <button
              type="button"
              onClick={goToBookings}
              className="rounded-md text-xs font-medium text-brand-500 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            >
              ไปแก้ไขที่หน้ารายละเอียดรายรับ
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {day.deposits.map((event) => (
              <div key={event.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-ink-muted">
                  {event.kind === "received" ? "รับ" : "คืน"} ·{" "}
                  {[event.bookingNo, event.guestName].filter(Boolean).join(" · ") || "-"} ·{" "}
                  {DEPOSIT_TENDER_LABELS_TH[event.tender]}
                </span>
                <span className="tabular-nums text-ink">{formatSatang(event.amountSatang)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* แถบเทียบยอดกับรายการจอง — ถาวร ไม่ใช่การเตือนให้แก้ */}
      {variance && (
        <section
          className={
            "rounded-lg border px-4 py-3 text-sm " +
            (variance.beyondTolerance ? "border-warn/40 bg-gold-50" : "border-line bg-panel")
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className={"text-sm font-semibold " + (variance.beyondTolerance ? "text-warn" : "text-ink")}>
              เทียบยอดกับรายการจอง
            </h2>
            {variance.beyondTolerance && (
              <button
                type="button"
                onClick={() => startVarianceReason(variance.deltaSatang)}
                className="rounded-md border border-warn/50 px-2.5 py-1 text-xs font-medium text-warn hover:bg-gold-100 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              >
                บันทึกเหตุผลในหมายเหตุ
              </button>
            )}
          </div>

          {!variance.beyondTolerance ? (
            <p className="mt-1 text-ink-muted">ยอดที่กรอกตรงกับรายการจอง</p>
          ) : (
            <>
              <div className="mt-2 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-ink-muted">รวมจากรายการจอง</span>
                  <span className="font-semibold tabular-nums text-ink">{formatSatang(variance.derivedSatang)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-ink-muted">กรอกไว้ในสรุปวัน</span>
                  <span className="font-semibold tabular-nums text-ink">{formatSatang(variance.typedSatang)}</span>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-warn/30 pt-1 font-semibold text-warn">
                  <span>ต่าง</span>
                  <span className="tabular-nums">{formatSatang(variance.deltaSatang)}</span>
                </div>
              </div>

              {variance.rows.length > 0 && (
                <div className="mt-2 flex flex-col gap-0.5 text-xs text-ink-muted">
                  {variance.rows.map((row) => (
                    <div key={row.categoryKey} className="flex items-center justify-between gap-3">
                      <span>{categoryKeyLabel(day.categories, row.categoryKey)}</span>
                      <span className="tabular-nums">
                        กรอก {formatSatang(row.typedSatang)} / จอง {formatSatang(row.derivedSatang)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-2 text-xs text-ink-muted">
                การปรับยอดสรุปให้ต่างจากรายการจองเป็นเรื่องปกติของสำนักงาน ไม่ใช่ข้อผิดพลาด — นับว่าต่างเมื่อเกิน{" "}
                {formatSatang(RECONCILE_TOLERANCE_SATANG)} บาท บันทึกเหตุผลไว้เพื่อให้ตรวจย้อนหลังได้
              </p>
            </>
          )}
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

      {/* Panels side by side, the way the summary and its **หมายเหตุ block
          sit together on the paper: รายรับ | เงินสด + ยอดรวม, plus a third
          legacy-only รายจ่าย panel when this day still has expense rows
          (see hasExpenseRows above). One column on a narrow screen. */}
      <div className={"grid grid-cols-1 items-start gap-4 " + (hasExpenseRows ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
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
              // Wave C: deposit/deposit_credit retirement — see
              // RETIRED_POST_CUTOVER_CATEGORY_KEYS' doc comment above.
              const isRetiredPostCutover =
                accrualDay && category.categoryKey != null && RETIRED_POST_CUTOVER_CATEGORY_KEYS.has(category.categoryKey);
              const hasMoney = cell != null && cell.amountSatang !== 0;
              if (isRetiredPostCutover && !hasMoney) return null; // no stray balance to show — hide the row entirely
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
                      disabled={day.monthClosed || isComputedFromOtherIncome || isRetiredPostCutover}
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
                  {isRetiredPostCutover && (
                    <p className="text-xs text-ink-muted">
                      เลิกใช้หลังเริ่มเกณฑ์บัญชีคงค้าง — แสดงไว้เพราะมียอดค้างจากก่อนหน้านี้ (อ่านอย่างเดียว)
                    </p>
                  )}
                  {/* Double-entry guards (Opus money-review F3/F4): the whole
                      merged มัดจำ tender lands in "deposit" via
                      อัพเดทจากรายละเอียดรายรับ, and every itemized (non-cash)
                      รายการอื่นๆ entry lands in "other_transfer" — both
                      unconditional, so a reception typist who ALSO keys the
                      credit-card portion here double-books it. Retired
                      post-cutover (Wave C) alongside the category itself —
                      the merged มัดจำ tender no longer writes into "deposit"
                      going forward (see shared/bookings.ts), so the warning
                      no longer applies once this row is read-only anyway. */}
                  {category.categoryKey === "deposit_credit" && !accrualDay && (
                    <p className="text-xs text-warn">
                      มัดจำจากรายการจองจะลงในช่อง &quot;{categoryKeyLabel(day.categories, "deposit")}&quot; ทั้งก้อน —
                      อย่ากรอกซ้ำในช่องนี้
                    </p>
                  )}
                  {category.categoryKey === "other_credit" && (
                    <p className="text-xs text-warn">
                      รายการอื่นๆ ที่ลงเป็นรายการย่อยจะลงในช่อง &quot;{categoryKeyLabel(day.categories, "other_transfer")}
                      &quot; ทั้งก้อน — กรอกช่องนี้เฉพาะยอดบัตรเครดิตที่ไม่ได้ลงเป็นรายการย่อย
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
            never collapse into the netted figure beneath it. The bold
            "ยอดฝากจริง" line below is a DIFFERENT figure again — the actual
            deposit after the till-count override and the deposit-machine
            adjustment below (cashBlock.bankedSatang), not the gross rows'
            simple sum. */}
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

          {/* **หมายเหตุ (สรุปเงินสด) — a manager's till-count correction to
              any of the three cash components above (see
              commitCashOverrideField). Always rendered, never gated behind
              cashIncomeRows/hasOtherIncomeItems: the override can exist
              (and needs to stay visible/editable, including a deliberate
              0.00) even on a day with no other cash rows showing. Same
              fields/wording as BookingDayPage.tsx's identical panel and
              the printed sheet's overriddenCashComponents, so the figure
              never reads two different ways across screens. */}
          <div className="mt-2 flex flex-col gap-2 border-t border-line-strong pt-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold text-ink-muted">**หมายเหตุ (สรุปเงินสด)</h3>
              {day.cashBlock.entered && (
                <button
                  type="button"
                  onClick={clearCashOverride}
                  className="rounded-md text-xs font-medium text-brand-500 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                >
                  ล้างการปรับยอด
                </button>
              )}
            </div>
            {cashOverrideFields.map(({ key, label }) => {
              const derivedValue = day.cashBlock.derived[key];
              const enteredValue = day.cashBlock.entered?.[key];
              const shown = enteredValue ?? derivedValue;
              return (
                <div key={key} className="flex items-center justify-between gap-3">
                  <span className="text-ink">
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
                    disabled={day.monthClosed}
                    zeroIsMeaningful
                  />
                </div>
              );
            })}

            {/* Deposit cash in/out (Wave C, docs/adr/0001, judgment-call (b)
                fix — Opus money-review, 2026-07-31): display-only, no new
                arithmetic — CashBlock.depositCashInSatang/depositCashOutSatang
                already fold into bankedSatang below (deriveCashBlock(),
                shared/bookings.ts); this just makes that folding VISIBLE on
                screen, mirroring reportSheetBlocks.tsx's printed
                depositCashRows and BookingDayPage.tsx's identical panel.
                Rendered only when nonzero. */}
            {(day.cashBlock.depositCashInSatang > 0 || day.cashBlock.depositCashOutSatang > 0) && (
              <div className="flex flex-col gap-1 border-t border-line-strong pt-2">
                {day.cashBlock.depositCashInSatang > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink">มัดจำรับเป็นเงินสด</span>
                    <span className="tabular-nums whitespace-nowrap text-ink">
                      + {formatSatang(day.cashBlock.depositCashInSatang)}
                    </span>
                  </div>
                )}
                {day.cashBlock.depositCashOutSatang > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ink">คืนมัดจำเป็นเงินสด</span>
                    <span className="tabular-nums whitespace-nowrap text-ink">
                      − {formatSatang(day.cashBlock.depositCashOutSatang)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Deposit-machine reconciliation ("adjusting") subsection —
              docs/plan-unify-exports-tender-split.md item 6, Wave C, owner
              request 2026-07-31: small change/coins that can't always go
              into the deposit machine. Same always-rendered rule as the
              override subsection above (a recorded adjustment, including a
              deliberate 0.00, must stay visible/editable), with its OWN
              clear affordance scoped to just these two fields — clearing
              the till-count override above must never silently wipe this
              one, and vice versa (see clearCashAdjustment/
              clearCashOverride). */}
          <div className="mt-2 flex flex-col gap-2 border-t border-line-strong pt-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold text-ink-muted">ปรับยอดฝากจริง (เงินสดเข้าตู้ไม่ได้)</h3>
              {(day.cashBlock.heldBackSatang != null || day.cashBlock.broughtForwardSatang != null) && (
                <button
                  type="button"
                  onClick={clearCashAdjustment}
                  className="rounded-md text-xs font-medium text-brand-500 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                >
                  ล้างการปรับยอด
                </button>
              )}
            </div>
            {CASH_ADJUSTMENT_FIELDS.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <span className="text-ink">{label}</span>
                <AmountInput
                  value={day.cashBlock[key]}
                  onCommit={(satang) => commitCashAdjustmentField(key, satang)}
                  ariaLabel={label}
                  // P4 (Opus money-review, 2026-07-31): NOT disabled on a
                  // closed month, unlike the four pre-existing override
                  // fields above — the server deliberately never gates this
                  // endpoint (api.md endpoint 21) because a reconciliation
                  // is exactly the thing still worth recording after a
                  // close, same reasoning as the day note.
                  zeroIsMeaningful
                />
              </div>
            ))}
          </div>

          <div className="mt-2 flex items-center justify-between gap-3 border-t border-line-strong pt-2 text-base font-bold text-brand-500">
            <span>
              สรุปเงินสดฝากเข้าบัญชี (ยอดฝากจริง)
              {bankedOverridden && (
                <span className="ml-1.5 text-xs font-normal text-ink-muted">(ปรับจาก {formatSatang(bankedDerived)})</span>
              )}
            </span>
            <span className="tabular-nums">{formatSatang(bankedShown)}</span>
          </div>
          {/* Both reference lines below are noise on the new normal
              (day.totals.cashExpenseSatang === 0 — expenses are entered in
              the separate Expense Ledger app now): a "-0.00" deduction and
              a "net" figure identical to the bold line above it say
              nothing. They only earn their keep on a day that still has
              legacy cash expense rows (see hasExpenseRows/the รายจ่าย panel
              below), where the math is worth spelling out. */}
          {day.totals.cashExpenseSatang !== 0 && (
            <>
              <div className="mt-2 flex items-center justify-between gap-3 border-t border-dotted border-line-strong pt-2 text-xs text-ink-muted">
                <span>หัก รายจ่ายเงินสดวันนี้ (ไม่ได้หักออกจากยอดฝากข้างต้น)</span>
                <span className="tabular-nums">-{formatSatang(day.totals.cashExpenseSatang)}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-3 text-xs font-medium text-ink-muted">
                <span>คงเหลือสุทธิหลังหักรายจ่ายเงินสด (ข้อมูลอ้างอิง)</span>
                <span className="tabular-nums">{formatSatang(bankedNetOfCashExpenseSatang)}</span>
              </div>
            </>
          )}
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

      {/* Panel รายจ่าย — LEGACY VISIBILITY ONLY (see hasExpenseRows above):
          rendered only when this day already has expense rows from before
          the entry surface was retired. Rows stay editable/deletable so a
          mistake can still be corrected, but there is deliberately no
          add-new-row form and no "ยังไม่มีรายจ่ายวันนี้" placeholder — a
          clean day shows nothing here at all, not even the header. */}
      {hasExpenseRows && (
        <section className="overflow-hidden rounded-lg border border-line bg-panel">
          <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">รายจ่าย</h2>
          <div className="divide-y divide-line">
            {day.expenses.map((item) => {
              const category = day.categories.find((c) => c.id === item.categoryId);
              const options =
                category && category.archivedAt ? [category, ...activeExpenseCategories] : activeExpenseCategories;
              return (
                <div key={item.id} className="flex flex-col gap-1 px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
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
                    maxLength={NOTE_MAX_LEN}
                    onChange={(e) => setExpenseNoteDraft(item.id, e.target.value)}
                    onBlur={(e) => {
                      // Hand the row back to its saved note: commitExpenseNote
                      // updates it optimistically and rolls back on failure,
                      // so the tripwire always reads what is really in the row.
                      clearExpenseNoteDraft(item.id);
                      commitExpenseNote(item, e.target.value);
                    }}
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
                  <AmountInTextHint text={expenseNoteDrafts[item.id] ?? item.note ?? ""} />
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-line-strong px-4 py-3 text-sm font-semibold text-ink">
            <span>รวมรายจ่าย</span>
            <span className="tabular-nums">{formatSatang(day.totals.expenseSatang)}</span>
          </div>
        </section>
      )}
      </div>
      {/* end of the รายรับ | เงินสด+ยอดรวม | รายจ่าย (legacy) row */}

      {/* Day note beside the audit footer + export, so nothing but these two
          ever sits below the three panels. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
      <section className="rounded-lg border border-line bg-panel p-4 lg:col-span-2">
        <label className="mb-1.5 block text-sm font-semibold text-ink" htmlFor="day-note">
          หมายเหตุ
        </label>
        <textarea
          id="day-note"
          ref={dayNoteRef}
          rows={2}
          value={dayNoteDraft}
          onChange={(e) => setDayNoteDraft(e.target.value)}
          onBlur={commitDayNote}
          maxLength={NOTE_MAX_LEN}
          placeholder="บันทึกเพิ่มเติมสำหรับวันนี้ (ถ้ามี)"
          className="w-full resize-none rounded-md border border-line-strong bg-panel px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        />
        <AmountInTextHint text={dayNoteDraft} className="mt-1" />
        {day.monthClosed && <p className="mt-1 text-xs text-ink-muted">เดือนนี้ปิดบัญชีแล้ว แต่ยังบันทึกหมายเหตุได้</p>}
        {dayNoteState === "saved" && <p className="mt-1 text-xs text-ok">บันทึกแล้ว</p>}
        {dayNoteState === "error" && <p className="mt-1 text-xs text-bad">บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง</p>}
      </section>

      {/* Footer */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
        <p className="text-xs text-ink-muted">
          บันทึกล่าสุด: {day.updatedBy} {formatUpdatedAt(day.updatedAt)}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={goToReport}
            className="rounded-md bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          >
            ส่งออกรูปภาพ
          </button>
          {/* พิมพ์ / PDF — read-only exports of this day's summary, never
              disabled by monthClosed (see usePrintExport.ts). */}
          <button
            type="button"
            onClick={printExport.handlePrint}
            disabled={printExport.busy !== ""}
            className="rounded-md border border-line-strong bg-panel px-4 py-2 text-sm font-medium text-ink hover:bg-tint disabled:opacity-50"
          >
            พิมพ์
          </button>
          <button
            type="button"
            onClick={printExport.handlePdf}
            disabled={printExport.busy !== ""}
            className="rounded-md border border-line-strong bg-panel px-4 py-2 text-sm font-medium text-ink hover:bg-tint disabled:opacity-50"
          >
            {printExport.busy === "pdf" ? "กำลังสร้าง PDF..." : "PDF"}
          </button>
        </div>
        {printExport.error && <p className="text-xs text-bad">{printExport.error}</p>}
      </div>
      </div>
      {/* end of the หมายเหตุ | footer row */}

      {/* พิมพ์/PDF target — the day summary only (PrintableDaySummary),
          rendered read-only and hidden on screen; see PrintPortal.tsx /
          style.css's .print-stage. */}
      <PrintPortal>
        <div className="print-stage">
          {/* Print-pagination clamp (issue #3) — see usePrintExport.ts's
              clampStyle docstring: a no-op wrapper outside an in-flight
              print, sized to the scaled sheet's exact painted footprint
              while one is happening so Chromium's page fragmenter (which
              ignores sheetStyle's transform) never spills this onto a
              second page. */}
          <div style={printExport.clampStyle}>
            <div ref={printExport.nodeRef} style={printExport.sheetStyle}>
              <PrintableDaySummary property={property} date={date} sheet={day} weekDays={weekDays ?? undefined} />
            </div>
          </div>
        </div>
      </PrintPortal>
    </div>
  );
}

// ── อัพเดทจากรายละเอียดรายรับ — diff dialog ───────────────────────────
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

/** The manager-renameable name of a keyed category, falling back to the seed
 * label when the property has no active category with that key. */
function categoryKeyLabel(categories: Category[], categoryKey: CategoryKey): string {
  const category = categories.find((c) => c.categoryKey === categoryKey);
  return category ? category.nameTh : CATEGORY_KEY_LABELS_TH[categoryKey];
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
          <h2 className="text-sm font-semibold text-ink">อัพเดทจากรายละเอียดรายรับ</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            เปรียบเทียบยอดที่กรอกไว้กับยอดที่คำนวณจากรายการจอง ก่อนบันทึกจริง
          </p>
          {/* Double-entry guard (Opus money-review F3): the whole merged
              มัดจำ tender writes into "deposit" here — never split by tender
              — so a credit-card portion already keyed into deposit_credit
              would double-count if also left in a booking line's มัดจำ. */}
          <p className="mt-1 text-xs text-warn">
            มัดจำจากรายการจองจะลงในช่อง &quot;{categoryKeyLabel(categories, "deposit")}&quot; ทั้งก้อน — อย่ากรอกซ้ำในช่อง
            &quot;{categoryKeyLabel(categories, "deposit_credit")}&quot;
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
