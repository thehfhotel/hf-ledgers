import { useEffect, useMemo, useRef, useState } from "react";
import { isAccrualDay, visibleTendersForDate } from "../../shared/accrual.ts";
import { isoToThaiLong, shiftDays } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import {
  RECONCILE_TOLERANCE_SATANG,
  depositCashTotals,
  deriveCashBlock,
  deriveIncomeFromBookings,
} from "../../shared/bookings.ts";
import { AMOUNT_IN_TEXT_WARNING_TH, looksLikeAmountInText } from "@shared/textAmount.ts";
import {
  BOOKING_NO_MAX_LEN,
  DEPOSIT_TENDERS,
  DEPOSIT_TENDER_LABELS_TH,
  DESCRIPTION_MAX_LEN,
  GUEST_NAME_MAX_LEN,
  NOTE_MAX_LEN,
  PROPERTY_LABELS,
  TENDER_TO_CATEGORY_KEY,
  type BookingLine,
  type CashAdjustmentAmounts,
  type CashBlockAmounts,
  type CategoryKey,
  type DaySheet,
  type DepositEvent,
  type DepositEventKind,
  type DepositTender,
  type OtherIncomeItem,
  type Property,
} from "../../shared/types.ts";
import {
  createBookingLine,
  createDepositEvent,
  createOtherIncomeItem,
  deleteBookingLine,
  deleteDepositEvent,
  deleteOtherIncomeItem,
  getDay,
  listBookingLines,
  moveBookingDay,
  pullFromPms,
  putCashBlock,
  updateBookingLine,
  updateDepositEvent,
  updateOtherIncomeItem,
  type BookingLineInput,
} from "../api.ts";
import { navigate } from "../App.tsx";
import { AmountInput } from "../components/AmountInput.tsx";
import { BookingGrid } from "../components/BookingGrid.tsx";
import { DateBar } from "../components/DateBar.tsx";
import { activeCashAdjustmentPatch, activeCashOverridePatch } from "../cashBlockPatches.ts";
import { FIXTURE_DATE, fixtureBookingLines, fixtureDaySheet } from "../fixtures.ts";
import { CASH_ADJUSTMENT_FIELDS, CASH_BLOCK_FIELDS } from "../labels.ts";
import { PmsPullResultDialog } from "../components/PmsPullResultDialog.tsx";
import { PrintPortal } from "../components/PrintPortal.tsx";
import { ReportSheet } from "../components/ReportSheet.tsx";
import { usePrintExport } from "../components/usePrintExport.ts";
import { PropertyBadge } from "./PropertyBadge.tsx";

interface Props {
  property: Property | "demo";
  date: string;
}

const DEMO_PROPERTY: Property = "hf";

/** The seven income categories a booking row can derive (see
 * TENDER_TO_CATEGORY_KEY). Tender "other" has no CategoryKey, and bar /
 * รายการอื่นๆ income has no booking column at all, so both sides of the
 * variance are summed over THIS set only. Same set, same reason, as
 * DaySheetPage's strip and HistoryPage's month-close preflight. */
const DERIVABLE_CATEGORY_KEYS: CategoryKey[] = [...new Set(Object.values(TENDER_TO_CATEGORY_KEY) as CategoryKey[])];

/**
 * The amount-in-text tripwire's inline hint — the same one DaySheetPage shows
 * on the day note and expense notes. Advisory only: nothing is blocked and
 * the text saves as typed. The wording lives in packages/shared/src/textAmount.ts so
 * every field reads identically.
 */
function AmountInTextHint({ text, className = "" }: { text: string; className?: string }) {
  if (!looksLikeAmountInText(text)) return null;
  return <p className={"text-xs text-warn " + className}>{AMOUNT_IN_TEXT_WARNING_TH}</p>;
}

/** The ดึงข้อมูล button's result — Wave D, D5: no longer a `window.alert`,
 * rendered by `PmsPullResultDialog` instead (see the handler below). */
type PmsPullResultState = Awaited<ReturnType<typeof pullFromPms>> | null;

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
  // Capability flag from GET .../bookings (pmsConfigured for this property)
  // — gates the ดึงข้อมูล button below. Demo mode never has it.
  const [pmsPull, setPmsPull] = useState(false);
  // Rows created optimistically: temp id -> the in-flight POST, so an edit
  // landing before the server answers can wait for the real row (see
  // addBookingLine / commitLinePatch). Counter keeps same-millisecond temp
  // ids distinct.
  const pendingCreates = useRef(new Map<number, Promise<BookingLine>>());
  const tempIdCounter = useRef(0);

  useEffect(() => {
    if (isDemo) {
      setLines(fixtureBookingLines);
      setDaySheet(fixtureDaySheet);
      return;
    }
    let cancelled = false;
    setLines(null);
    setDaySheet(null);
    setLoadError(null);

    Promise.all([listBookingLines(effectiveProperty, effectiveDate), getDay(effectiveProperty, effectiveDate)])
      .then(([bookingsRes, sheet]) => {
        if (cancelled) return;
        setLines(bookingsRes.lines);
        setDaySheet(sheet);
        setPmsPull(bookingsRes.pmsPull);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      });

    return () => {
      cancelled = true;
    };
  }, [isDemo, effectiveProperty, effectiveDate]);

  // ── Move this day to the other property ──────────────────────────────
  // Scope is locked (see api.ts moveBookingDay + the confirm text below):
  // ONLY booking_lines + other_income_items for this date move, merging into
  // whatever the destination already has. The day sheet (income/expenses/
  // note) and the cash-block override are single-valued per property and
  // stay put on both sides — the confirm dialog says so explicitly, since
  // this is the exact mistake (wrong-hotel entry) the feature exists to fix.
  const otherProperty: Property = effectiveProperty === "hf" ? "hfville" : "hf";
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Re-fetch both the booking lines and the day sheet from the server and
  // replace local state 1:1 — the same GET pair the initial load uses.
  // Reused by the move-failure resync below and by the PMS pull's
  // post-success refetch: new rows always come back through this path,
  // never hand-built from a mutation's response.
  async function refetchLinesAndSheet() {
    const [bookingsRes, sheet] = await Promise.all([
      listBookingLines(effectiveProperty, effectiveDate),
      getDay(effectiveProperty, effectiveDate),
    ]);
    setLines(bookingsRes.lines);
    setDaySheet(sheet);
    setPmsPull(bookingsRes.pmsPull);
  }

  async function reloadAfterMoveFailure() {
    // Best-effort resync only: a failed move should never leave this page
    // showing stale rows if the server actually committed before the error
    // reached the client (timeout, 502, ...). The failure message itself is
    // already shown separately, so a second failure here just leaves it be.
    try {
      await refetchLinesAndSheet();
    } catch {
      /* keep whatever is on screen — the move error is already shown */
    }
  }

  async function handleMoveDay() {
    if (isDemo || monthClosed || moving) return;
    const confirmed = window.confirm(
      `ย้ายข้อมูลวันที่ ${isoToThaiLong(effectiveDate)} จาก${PROPERTY_LABELS[effectiveProperty].th} ไปยัง${PROPERTY_LABELS[otherProperty].th}\n\n` +
        "จะย้ายเฉพาะรายการจอง รายการอื่นๆ และรายการมัดจำล่วงหน้าของวันนี้ทั้งหมด — ถ้าฝั่งปลายทางมีรายการอยู่แล้ว จะรวมเข้าด้วยกัน ไม่ทับข้อมูลเดิม\n\n" +
        "สรุปวัน (รายรับ/รายจ่าย/หมายเหตุ) และการปรับยอดเงินสด (**หมายเหตุ) ของทั้งสองฝั่งจะไม่ถูกย้าย ต้องไปแก้ไขเองภายหลังถ้าจำเป็น\n\n" +
        "ดำเนินการย้ายหรือไม่",
    );
    if (!confirmed) return;
    setMoveError(null);
    setMoving(true);
    try {
      await moveBookingDay(effectiveProperty, effectiveDate, otherProperty);
      navigate(`/${otherProperty}/bookings/${effectiveDate}`);
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : "ย้ายวันไม่สำเร็จ ลองใหม่อีกครั้ง");
      setMoving(false);
      await reloadAfterMoveFailure();
    }
  }

  // ── ดึงข้อมูล — prefill booking rows from the PMS payment ledger ────────
  // Button-triggered only, never automatic (no fetch on load, no polling —
  // docs/pms-prefill-plan.md). Insert-only and idempotent server-side, so
  // there is nothing to confirm before the call. Hidden unless `pmsPull`
  // (capability flag from GET .../bookings) and never in demo mode;
  // disabled while the month is closed or a pull is already in flight.
  const [pmsPulling, setPmsPulling] = useState(false);
  // Wave D, D5: the result is no longer a window.alert — PmsPullResultDialog
  // renders it (and, when `changed` is non-empty, the per-row accept flow).
  const [pmsPullResult, setPmsPullResult] = useState<PmsPullResultState>(null);
  const [pmsPullError, setPmsPullError] = useState<string | null>(null);

  async function handlePullFromPms() {
    if (isDemo || !pmsPull || monthClosed || pmsPulling) return;
    setPmsPulling(true);
    setPmsPullError(null);
    try {
      const result = await pullFromPms(effectiveProperty, effectiveDate);
      // New rows (booking lines AND deposit events — Wave C) land through
      // the same GET pair the page already loads with — never hand-built
      // from inserted/skipped counts. getDay() also returns `deposits`, so
      // this refresh covers both kinds.
      if (result.inserted > 0 || result.depositsInserted > 0) await refetchLinesAndSheet();
      setPmsPullResult(result);
    } catch (err) {
      setPmsPullError(err instanceof Error ? err.message : "ดึงข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setPmsPulling(false);
    }
  }

  const sortedLines = useMemo(() => [...(lines ?? [])].sort((a, b) => a.seq - b.seq), [lines]);
  const monthClosed = daySheet?.monthClosed ?? false;
  // Wave C (docs/adr/0001): the 8 tender columns actually visible for this
  // date — deposit pre-cutover, deposit_applied on/after (same printed
  // slot, see shared/accrual.ts).
  const visibleTenders = useMemo(
    () => visibleTendersForDate(effectiveProperty, effectiveDate),
    [effectiveProperty, effectiveDate],
  );
  const accrualDay = isAccrualDay(effectiveProperty, effectiveDate);

  // ── พิมพ์ / PDF — the booking sheet only (grid + totals), landscape ────
  // Read-only actions: unlike every mutation above, NEVER gated on
  // monthClosed or demo mode — see usePrintExport.ts / ReportSheet.tsx's
  // "bookingsOnly" variant. The print/PDF target is the SAME data already
  // on screen (daySheet + sortedLines), rendered into a hidden print-stage
  // (see PrintPortal.tsx) rather than the live editing grid.
  const printExport = usePrintExport({ orientation: "landscape", property: effectiveProperty, date: effectiveDate });

  // ── เปรียบเทียบกับสรุปวัน ──────────────────────────────────────────────
  // Both sides computed here from the rows already on screen, through the
  // shared deriveIncomeFromBookings() — deliberately NOT from the
  // POST fill-from-bookings preview this strip used to call: that preview
  // reports afterSatang === beforeSatang for any cell flagged `manual`, and
  // the Excel importer stamped every backfilled cell manual, so the strip
  // read "ต่าง 0.00" on precisely the hand-adjusted days it exists to show.
  // Computing locally also keeps it live while rows are edited, with no
  // refetch after every keystroke-commit.
  const variance = useMemo(() => {
    if (!daySheet) return null;
    const derived = deriveIncomeFromBookings(sortedLines);
    const categoryKeyById = new Map(daySheet.categories.map((c) => [c.id, c.categoryKey]));

    let derivedSatang = 0;
    for (const key of DERIVABLE_CATEGORY_KEYS) derivedSatang += derived[key] ?? 0;

    let typedSatang = 0;
    for (const cell of Object.values(daySheet.income)) {
      const key = categoryKeyById.get(cell.categoryId);
      if (key && DERIVABLE_CATEGORY_KEYS.includes(key)) typedSatang += cell.amountSatang;
    }

    // Sign matches DaySheetPage's strip and HistoryPage's preflight:
    // booking-derived minus typed.
    const deltaSatang = derivedSatang - typedSatang;
    return {
      derivedSatang,
      typedSatang,
      deltaSatang,
      beyondTolerance: Math.abs(deltaSatang) > RECONCILE_TOLERANCE_SATANG,
    };
  }, [daySheet, sortedLines]);

  // ── Booking lines ────────────────────────────────────────────────────

  async function addBookingLine(input: BookingLineInput): Promise<boolean> {
    const nextSeq = sortedLines.reduce((max, line) => Math.max(max, line.seq), 0) + 1;
    // The row appears NOW, carrying what was typed, and the POST settles it
    // underneath. Without this the blank row is cleared synchronously while
    // the real row only arrives a round trip later, so the booking visibly
    // vanishes and comes back — the one mutation on this page that was not
    // already optimistic. Temp ids are negative so they cannot collide with
    // a server id, and a counter keeps two creates in the same millisecond
    // apart.
    const localId = -(Date.now() * 1000 + (tempIdCounter.current++ % 1000));
    const optimistic: BookingLine = {
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
      tenders: {
        deposit: 0,
        deposit_applied: 0,
        cash: 0,
        credit_kbank: 0,
        credit_icbc: 0,
        transfer_kbank: 0,
        transfer_icbc: 0,
        web: 0,
        other: 0,
      },
      remark: null,
      source: "manual",
      draft: false,
      sourceSheet: null,
      createdAt: "",
      createdBy: "",
      updatedAt: "",
      updatedBy: "",
      ...input,
    };
    setLines((prev) => [...(prev ?? []), optimistic]);
    if (isDemo) return true;
    // Editing a row whose POST is still in flight would otherwise PATCH a
    // temp id and 404. Park the promise so commitLinePatch can wait for the
    // real row instead.
    const creating = createBookingLine(effectiveProperty, effectiveDate, input);
    pendingCreates.current.set(localId, creating);
    try {
      const created = await creating;
      setLines((prev) => (prev ?? []).map((l) => (l.id === localId ? created : l)));
      return true;
    } catch (err) {
      setLines((prev) => (prev ?? []).filter((l) => l.id !== localId));
      window.alert(err instanceof Error ? err.message : "เพิ่มรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
      return false;
    } finally {
      pendingCreates.current.delete(localId);
    }
  }

  async function commitLinePatch(line: BookingLine, patch: BookingLineInput) {
    const prevLines = lines;
    setLines((prev) => (prev ?? []).map((l) => (l.id === line.id ? { ...l, ...patch } : l)));
    if (isDemo) return;
    // A negative id is a row still being created — wait for the server's real
    // row and patch that instead of 404ing on the temp id.
    let target = line;
    if (line.id < 0) {
      const creating = pendingCreates.current.get(line.id);
      if (!creating) return;
      try {
        target = await creating;
      } catch {
        return; // the create already reported its own failure
      }
    }
    try {
      const updated = await updateBookingLine(effectiveProperty, target.id, patch);
      setLines((prev) => (prev ?? []).map((l) => (l.id === updated.id ? updated : l)));
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
  // Live description text per saved row, so the amount-in-text tripwire can
  // read it before the blur that saves it. A row with no entry here falls
  // back to its saved description — an imported
  // "ค่าจัดงานวันเกิดลค.ห้อง506(โอนเงิน350)" is flagged on arrival, not only
  // once someone edits it. Cleared on commit so the saved value takes over.
  const [otherDescriptionDrafts, setOtherDescriptionDrafts] = useState<Record<number, string>>({});

  function setOtherDescriptionDraft(id: number, text: string) {
    setOtherDescriptionDrafts((prev) => ({ ...prev, [id]: text }));
  }
  function clearOtherDescriptionDraft(id: number) {
    setOtherDescriptionDrafts((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function applyOtherIncome(otherIncome: OtherIncomeItem[]) {
    setDaySheet((prev) =>
      prev
        ? {
            ...prev,
            otherIncome,
            cashBlock: {
              ...prev.cashBlock,
              derived: deriveCashBlock(
                prev.categories,
                prev.income,
                otherIncome,
                prev.cashBlock.heldBackSatang,
                prev.cashBlock.broughtForwardSatang,
                prev.deposits,
              ),
            },
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
          cashBlock: {
            ...prev.cashBlock,
            derived: deriveCashBlock(
              prev.categories,
              prev.income,
              otherIncome,
              prev.cashBlock.heldBackSatang,
              prev.cashBlock.broughtForwardSatang,
              prev.deposits,
            ),
          },
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

  // ── มัดจำล่วงหน้า (deposit_events hand entry, Wave C, docs/adr/0001) ────
  // Received/refunded มัดจำล่วงหน้า moments — a day-scoped itemized list,
  // same shape/pattern as รายการอื่นๆ above. Disabled (never hidden — same
  // convention as every other closed-month field) when the month is closed
  // OR this date is before the property's accrual cutover
  // (shared/accrual.ts) — a pre-cutover day can never legitimately hold one.
  const depositEntryDisabled = monthClosed || !accrualDay;

  /** Recomputes cashBlock.derived AND the always-derived depositCashIn/Out
   * display figures from a fresh `deposits` list — the client-side mirror
   * of server.ts's buildCashBlock(), so the optimistic UI never shows a
   * stale ยอดฝากจริง after a deposit is added/edited/removed. `update`
   * receives the CURRENT `prev.deposits` (never a possibly-stale closure
   * value), so this is safe to call from both the optimistic write and the
   * post-await success write. */
  function applyDepositsUpdater(update: (deposits: DepositEvent[]) => DepositEvent[]) {
    setDaySheet((prev) => {
      if (!prev) return prev;
      const deposits = update(prev.deposits);
      const derived = deriveCashBlock(
        prev.categories,
        prev.income,
        prev.otherIncome,
        prev.cashBlock.heldBackSatang,
        prev.cashBlock.broughtForwardSatang,
        deposits,
      );
      const { depositCashInSatang, depositCashOutSatang } = depositCashTotals(deposits);
      return { ...prev, deposits, cashBlock: { ...prev.cashBlock, derived, depositCashInSatang, depositCashOutSatang } };
    });
  }

  const [newDepositKind, setNewDepositKind] = useState<DepositEventKind>("received");
  const [newDepositBookingNo, setNewDepositBookingNo] = useState("");
  const [newDepositGuestName, setNewDepositGuestName] = useState("");
  const [newDepositTender, setNewDepositTender] = useState<DepositTender>("cash");
  const [newDepositAmountText, setNewDepositAmountText] = useState("");
  const [newDepositNote, setNewDepositNote] = useState("");
  const [addingDeposit, setAddingDeposit] = useState(false);
  const [newDepositError, setNewDepositError] = useState<string | null>(null);

  async function submitNewDeposit() {
    if (!daySheet || depositEntryDisabled) return;
    setNewDepositError(null);
    const amountSatang = parseAmountToSatang(newDepositAmountText);
    if (amountSatang === null || amountSatang <= 0) {
      setNewDepositError("กรอกจำนวนเงินให้ถูกต้อง (มากกว่า 0)");
      return;
    }
    const bookingNo = newDepositBookingNo.trim() === "" ? null : newDepositBookingNo.trim().slice(0, BOOKING_NO_MAX_LEN);
    const guestName =
      newDepositGuestName.trim() === "" ? null : newDepositGuestName.trim().slice(0, GUEST_NAME_MAX_LEN);
    const note = newDepositNote.trim() === "" ? null : newDepositNote.trim().slice(0, NOTE_MAX_LEN);
    const resetForm = () => {
      setNewDepositBookingNo("");
      setNewDepositGuestName("");
      setNewDepositAmountText("");
      setNewDepositNote("");
    };
    if (isDemo) {
      applyDepositsUpdater((deposits) => [
        ...deposits,
        {
          id: -Date.now(),
          property: effectiveProperty,
          date: effectiveDate,
          kind: newDepositKind,
          bookingNo,
          guestName,
          tender: newDepositTender,
          amountSatang,
          note,
          source: "manual",
          pmsRef: null,
          createdAt: "",
          createdBy: "",
          updatedAt: "",
          updatedBy: "",
        },
      ]);
      resetForm();
      return;
    }
    setAddingDeposit(true);
    try {
      const created = await createDepositEvent(effectiveProperty, effectiveDate, {
        kind: newDepositKind,
        bookingNo,
        guestName,
        tender: newDepositTender,
        amountSatang,
        note,
      });
      applyDepositsUpdater((deposits) => [...deposits, created]);
      resetForm();
    } catch (err) {
      setNewDepositError(err instanceof Error ? err.message : "เพิ่มรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setAddingDeposit(false);
    }
  }

  async function commitDepositField(
    event: DepositEvent,
    patch: Partial<{
      kind: DepositEventKind;
      bookingNo: string | null;
      guestName: string | null;
      tender: DepositTender;
      amountSatang: number;
      note: string | null;
    }>,
  ) {
    if (!daySheet) return;
    const prevDeposits = daySheet.deposits;
    const prevCashBlock = daySheet.cashBlock;
    applyDepositsUpdater((deposits) => deposits.map((d) => (d.id === event.id ? { ...d, ...patch } : d)));
    if (isDemo) return;
    try {
      const updated = await updateDepositEvent(effectiveProperty, event.id, patch);
      applyDepositsUpdater((deposits) => deposits.map((d) => (d.id === updated.id ? updated : d)));
    } catch (err) {
      setDaySheet((prev) => (prev ? { ...prev, deposits: prevDeposits, cashBlock: prevCashBlock } : prev));
      window.alert(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  async function removeDeposit(event: DepositEvent) {
    if (!daySheet) return;
    if (!window.confirm("ลบรายการมัดจำนี้ใช่หรือไม่")) return;
    const prevDeposits = daySheet.deposits;
    const prevCashBlock = daySheet.cashBlock;
    applyDepositsUpdater((deposits) => deposits.filter((d) => d.id !== event.id));
    if (isDemo) return;
    try {
      await deleteDepositEvent(effectiveProperty, event.id);
    } catch (err) {
      setDaySheet((prev) => (prev ? { ...prev, deposits: prevDeposits, cashBlock: prevCashBlock } : prev));
      window.alert(err instanceof Error ? err.message : "ลบรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  // ── Cash-banking block override (mgr) ────────────────────────────────
  // Every commit re-sends ONLY the GENUINELY active fields on the other
  // half — activeCashOverridePatch/activeCashAdjustmentPatch, shared with
  // DaySheetPage.tsx via src/client/cashBlockPatches.ts — NEVER a blind
  // `...cashBlock.entered` spread. `entered` is a fully-merged
  // CashBlockAmounts the moment ANY field is overridden (every untouched
  // field falls back to `derived` AT MERGE TIME), so re-sending it
  // wholesale would store that PRE-adjustment `bankedSatang` snapshot as a
  // real, permanent override — freezing the bank line against every later
  // heldBack/broughtForward change (Opus money-review P0, 2026-07-31; see
  // cashBlockPatches.ts's module doc for the three proven-broken sequences
  // this fixes).

  async function commitCashOverrideField(field: keyof CashBlockAmounts, satang: number | null) {
    if (!daySheet) return;
    const prevCashBlock = daySheet.cashBlock;
    const baseline = daySheet.cashBlock.entered ?? daySheet.cashBlock.derived;
    const nextEntered: CashBlockAmounts = { ...baseline, [field]: satang ?? 0 };
    setDaySheet((prev) => (prev ? { ...prev, cashBlock: { ...prev.cashBlock, entered: nextEntered } } : prev));
    if (isDemo) return;
    try {
      const res = await putCashBlock(effectiveProperty, effectiveDate, {
        ...activeCashOverridePatch(daySheet.cashBlock),
        [field]: satang ?? 0,
        ...activeCashAdjustmentPatch(daySheet.cashBlock),
      });
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
      // Scoped to the four till-count fields only — see
      // commitCashAdjustmentField/clearCashAdjustment below for the mirror
      // case (clearing the adjustment must not touch this override either).
      const adjustment = activeCashAdjustmentPatch(daySheet.cashBlock);
      const res = await putCashBlock(
        effectiveProperty,
        effectiveDate,
        Object.keys(adjustment).length > 0 ? adjustment : null,
      );
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: res } : prev));
    } catch (err) {
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: prevCashBlock } : prev));
      window.alert(err instanceof Error ? err.message : "ล้างการปรับยอดไม่สำเร็จ");
    }
  }

  // ── Cash adjustment (heldBackSatang/broughtForwardSatang) ─────────────
  // Deposit-machine reconciliation rows (docs/plan-unify-exports-tender-
  // split.md item 6, Wave C, owner request 2026-07-31). Same
  // endpoint/persistence as the override above, but deliberately does NOT
  // pin the four till-count fields into existence — see
  // CashAdjustmentAmounts (shared/types.ts): unlike those four, these two
  // have no "derived" fallback worth freezing, so an adjustment-only edit
  // must never create a phantom override (activeCashOverridePatch, never a
  // blind `entered` spread — see the override section's comment above).

  async function commitCashAdjustmentField(field: keyof CashAdjustmentAmounts, satang: number | null) {
    if (!daySheet) return;
    const prevCashBlock = daySheet.cashBlock;
    const value = satang ?? 0;
    setDaySheet((prev) => (prev ? { ...prev, cashBlock: { ...prev.cashBlock, [field]: value } } : prev));
    if (isDemo) return;
    try {
      const res = await putCashBlock(effectiveProperty, effectiveDate, {
        ...activeCashOverridePatch(daySheet.cashBlock),
        ...activeCashAdjustmentPatch(daySheet.cashBlock),
        [field]: value,
      });
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: res } : prev));
    } catch (err) {
      setDaySheet((prev) => (prev ? { ...prev, cashBlock: prevCashBlock } : prev));
      window.alert(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  async function clearCashAdjustment() {
    if (!daySheet) return;
    const prevCashBlock = daySheet.cashBlock;
    setDaySheet((prev) =>
      prev ? { ...prev, cashBlock: { ...prev.cashBlock, heldBackSatang: null, broughtForwardSatang: null } } : prev,
    );
    if (isDemo) return;
    try {
      const res = await putCashBlock(effectiveProperty, effectiveDate, activeCashOverridePatch(daySheet.cashBlock));
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

  // Split rather than iterated as one CASH_BLOCK_FIELDS.map() so the
  // deposit-machine adjustment subsection (rendered between them below) is
  // never keyed to a specific field's presence — see the P5 comment at its
  // render site.
  const cashOverrideComponentFields = CASH_BLOCK_FIELDS.filter((field) => field.key !== "bankedSatang");
  const bankedField = CASH_BLOCK_FIELDS.find((field) => field.key === "bankedSatang");

  // Bound to a new const so the nested renderCashOverrideRow below closes
  // over an already-narrowed (non-null) DaySheet — TS does not carry the
  // `if (!daySheet) return` guard's narrowing into a function declaration
  // defined later in the same scope.
  const sheet = daySheet;

  function renderCashOverrideRow(key: keyof CashBlockAmounts, label: string) {
    const derivedValue = sheet.cashBlock.derived[key];
    const enteredValue = sheet.cashBlock.entered?.[key];
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
          disabled={monthClosed}
          zeroIsMeaningful
        />
      </div>
    );
  }

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
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-ink">รายงานรายรับโรงแรมรายวัน</h1>
          <PropertyBadge property={effectiveProperty} demo={isDemo} />
        </div>
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">รายการจอง</h2>
          <p className="min-w-0 flex-1 text-xs text-ink-muted">
            พิมพ์ในแถวว่างท้ายตารางเพื่อเพิ่มรายการใหม่ — Tab เลื่อนช่องถัดไป, Enter เลื่อนลงในคอลัมน์เดิม, ปุ่มลูกศรเลื่อนขึ้น/ลง/ซ้าย/ขวา
          </p>
          {/* พิมพ์ / PDF — read-only exports of the booking sheet, always
              enabled (never gated on monthClosed/loading beyond "data is
              here at all", matching the move button's !isDemo guard for
              consistency though these two work in demo mode too). */}
          <button
            type="button"
            onClick={printExport.handlePrint}
            disabled={printExport.busy !== ""}
            className="shrink-0 rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
          >
            พิมพ์
          </button>
          <button
            type="button"
            onClick={printExport.handlePdf}
            disabled={printExport.busy !== ""}
            className="shrink-0 rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
          >
            {printExport.busy === "pdf" ? "กำลังสร้าง PDF..." : "PDF"}
          </button>
          {!isDemo && pmsPull && (
            <button
              type="button"
              onClick={handlePullFromPms}
              disabled={monthClosed || pmsPulling}
              className="shrink-0 rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
            >
              {pmsPulling ? "กำลังดึงข้อมูล..." : "ดึงข้อมูล"}
            </button>
          )}
          {!isDemo && (
            <button
              type="button"
              onClick={handleMoveDay}
              disabled={monthClosed || moving}
              className="shrink-0 rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-tint disabled:opacity-50"
            >
              {moving ? "กำลังย้าย..." : `ย้ายวันนี้ไปยัง${PROPERTY_LABELS[otherProperty].th}`}
            </button>
          )}
        </div>
        {moveError && (
          <p className="border-b border-line bg-bad/5 px-4 py-2 text-xs text-bad">{moveError}</p>
        )}
        {printExport.error && (
          <p className="border-b border-line bg-bad/5 px-4 py-2 text-xs text-bad">{printExport.error}</p>
        )}
        {pmsPullError && (
          <p className="border-b border-line bg-bad/5 px-4 py-2 text-xs text-bad">{pmsPullError}</p>
        )}
        <BookingGrid
          lines={sortedLines}
          disabled={monthClosed}
          visibleTenders={visibleTenders}
          onPatch={commitLinePatch}
          onCreate={addBookingLine}
          onDelete={removeLine}
        />
      </section>

      {/* Panel มัดจำล่วงหน้า (deposit_events hand entry, Wave C,
          docs/adr/0001) — received/refunded มัดจำล่วงหน้า moments, a
          day-scoped itemized list mirroring รายการอื่นๆ below. Disabled
          (never hidden) on a closed month OR before this property's
          accrual cutover — see depositEntryDisabled above. */}
      <section className="overflow-hidden rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">
          มัดจำล่วงหน้า (ไม่ใช่รายรับ)
        </h2>
        {!accrualDay && (
          <p className="border-b border-line bg-gold-50 px-4 py-2 text-xs text-warn">
            วันนี้อยู่ก่อนวันเริ่มใช้เกณฑ์บัญชีคงค้าง — ยังบันทึกมัดจำล่วงหน้าสำหรับวันนี้ไม่ได้
          </p>
        )}
        {daySheet.deposits.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">ยังไม่มีรายการมัดจำล่วงหน้าวันนี้</p>
        ) : (
          <div className="divide-y divide-line">
            {daySheet.deposits.map((event) => (
              <div key={event.id} className="flex flex-col gap-1 px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex shrink-0 overflow-hidden rounded-md border border-line-strong text-xs font-medium">
                    <button
                      type="button"
                      disabled={depositEntryDisabled}
                      onClick={() => commitDepositField(event, { kind: "received" })}
                      className={
                        "px-2 py-1.5 transition disabled:opacity-50 " +
                        (event.kind === "received" ? "bg-brand-500 text-white" : "bg-panel text-ink-muted hover:bg-tint")
                      }
                    >
                      รับ
                    </button>
                    <button
                      type="button"
                      disabled={depositEntryDisabled}
                      onClick={() => commitDepositField(event, { kind: "refunded" })}
                      className={
                        "border-l border-line-strong px-2 py-1.5 transition disabled:opacity-50 " +
                        (event.kind === "refunded" ? "bg-brand-500 text-white" : "bg-panel text-ink-muted hover:bg-tint")
                      }
                    >
                      คืน
                    </button>
                  </div>
                  <input
                    type="text"
                    defaultValue={event.bookingNo ?? ""}
                    key={`bn-${event.id}-${event.bookingNo ?? ""}`}
                    placeholder="เลขที่ (R...)"
                    aria-label="เลขที่การจอง"
                    disabled={depositEntryDisabled}
                    maxLength={BOOKING_NO_MAX_LEN}
                    onBlur={(e) => {
                      const trimmed = e.target.value.trim();
                      const bookingNo = trimmed === "" ? null : trimmed.slice(0, BOOKING_NO_MAX_LEN);
                      if (bookingNo !== event.bookingNo) commitDepositField(event, { bookingNo });
                    }}
                    className="w-28 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
                  />
                  <input
                    type="text"
                    defaultValue={event.guestName ?? ""}
                    key={`gn-${event.id}-${event.guestName ?? ""}`}
                    placeholder="ชื่อลูกค้า"
                    aria-label="ชื่อลูกค้า"
                    disabled={depositEntryDisabled}
                    maxLength={GUEST_NAME_MAX_LEN}
                    onBlur={(e) => {
                      const trimmed = e.target.value.trim();
                      const guestName = trimmed === "" ? null : trimmed.slice(0, GUEST_NAME_MAX_LEN);
                      if (guestName !== event.guestName) commitDepositField(event, { guestName });
                    }}
                    className="min-w-[8rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
                  />
                  <select
                    value={event.tender}
                    disabled={depositEntryDisabled}
                    aria-label="ช่องทางมัดจำ"
                    onChange={(e) => commitDepositField(event, { tender: e.target.value as DepositTender })}
                    className="rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
                  >
                    {DEPOSIT_TENDERS.map((tender) => (
                      <option key={tender} value={tender}>
                        {DEPOSIT_TENDER_LABELS_TH[tender]}
                      </option>
                    ))}
                  </select>
                  <AmountInput
                    value={event.amountSatang}
                    disabled={depositEntryDisabled}
                    onCommit={(satang) => {
                      if (satang === null || satang <= 0) throw new Error("จำนวนเงินต้องมากกว่า 0");
                      return commitDepositField(event, { amountSatang: satang });
                    }}
                    ariaLabel={`จำนวนเงินมัดจำ ${event.guestName ?? ""}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeDeposit(event)}
                    disabled={depositEntryDisabled}
                    className="rounded-md border border-bad/40 px-2.5 py-1.5 text-xs font-medium text-bad hover:bg-bad/10 disabled:opacity-50"
                  >
                    ลบ
                  </button>
                </div>
                <input
                  type="text"
                  defaultValue={event.note ?? ""}
                  key={`note-${event.id}-${event.note ?? ""}`}
                  placeholder="หมายเหตุ"
                  aria-label="หมายเหตุมัดจำ"
                  disabled={depositEntryDisabled}
                  maxLength={NOTE_MAX_LEN}
                  onBlur={(e) => {
                    const trimmed = e.target.value.trim();
                    const note = trimmed === "" ? null : trimmed.slice(0, NOTE_MAX_LEN);
                    if (note !== event.note) commitDepositField(event, { note });
                  }}
                  className="w-full rounded-md border border-line-strong bg-panel px-2 py-1 text-xs text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
                />
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-tint px-4 py-3">
          <div className="flex shrink-0 overflow-hidden rounded-md border border-line-strong text-xs font-medium">
            <button
              type="button"
              disabled={depositEntryDisabled}
              onClick={() => setNewDepositKind("received")}
              className={
                "px-2 py-1.5 disabled:opacity-50 " +
                (newDepositKind === "received" ? "bg-brand-500 text-white" : "bg-panel text-ink-muted hover:bg-tint")
              }
            >
              รับ
            </button>
            <button
              type="button"
              disabled={depositEntryDisabled}
              onClick={() => setNewDepositKind("refunded")}
              className={
                "border-l border-line-strong px-2 py-1.5 disabled:opacity-50 " +
                (newDepositKind === "refunded" ? "bg-brand-500 text-white" : "bg-panel text-ink-muted hover:bg-tint")
              }
            >
              คืน
            </button>
          </div>
          <input
            type="text"
            value={newDepositBookingNo}
            onChange={(e) => setNewDepositBookingNo(e.target.value)}
            placeholder="เลขที่ (R...)"
            aria-label="เลขที่การจองมัดจำใหม่"
            disabled={depositEntryDisabled}
            maxLength={BOOKING_NO_MAX_LEN}
            className="w-28 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
          <input
            type="text"
            value={newDepositGuestName}
            onChange={(e) => setNewDepositGuestName(e.target.value)}
            placeholder="ชื่อลูกค้า"
            aria-label="ชื่อลูกค้ามัดจำใหม่"
            disabled={depositEntryDisabled}
            maxLength={GUEST_NAME_MAX_LEN}
            className="min-w-[8rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
          <select
            value={newDepositTender}
            onChange={(e) => setNewDepositTender(e.target.value as DepositTender)}
            disabled={depositEntryDisabled}
            aria-label="ช่องทางมัดจำใหม่"
            className="rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          >
            {DEPOSIT_TENDERS.map((tender) => (
              <option key={tender} value={tender}>
                {DEPOSIT_TENDER_LABELS_TH[tender]}
              </option>
            ))}
          </select>
          <input
            type="text"
            inputMode="decimal"
            value={newDepositAmountText}
            onChange={(e) => setNewDepositAmountText(e.target.value)}
            placeholder="0.00"
            aria-label="จำนวนเงินมัดจำใหม่"
            disabled={depositEntryDisabled}
            className="w-28 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-right tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
          <input
            type="text"
            value={newDepositNote}
            onChange={(e) => setNewDepositNote(e.target.value)}
            placeholder="หมายเหตุ"
            aria-label="หมายเหตุมัดจำใหม่"
            disabled={depositEntryDisabled}
            className="min-w-[8rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
          />
          <button
            type="button"
            onClick={submitNewDeposit}
            disabled={addingDeposit || depositEntryDisabled}
            className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            เพิ่มรายการ
          </button>
          {newDepositError && <p className="w-full text-xs text-bad">{newDepositError}</p>}
        </div>
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
                <div key={item.id} className="flex flex-col gap-1 px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    defaultValue={item.description ?? ""}
                    key={`${item.id}-${item.description ?? ""}`}
                    placeholder="รายละเอียด"
                    aria-label="รายละเอียดรายการอื่นๆ"
                    disabled={monthClosed}
                    maxLength={DESCRIPTION_MAX_LEN}
                    onChange={(e) => setOtherDescriptionDraft(item.id, e.target.value)}
                    onBlur={(e) => {
                      const trimmed = e.target.value.trim();
                      const description = trimmed === "" ? null : trimmed.slice(0, DESCRIPTION_MAX_LEN);
                      // Hand the row back to its saved description:
                      // commitOtherIncomeField updates it optimistically and
                      // rolls back on failure, so the tripwire always reads
                      // what is really in the row.
                      clearOtherDescriptionDraft(item.id);
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
                      {/* Wording matches where this money actually lands
                          (Opus money-review F4): every non-cash item is
                          computed into the "other_transfer" cell, now
                          labelled โอน-only — never "เครดิต", so the toggle
                          must not say เครดิต either. */}
                      โอน
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
                  <AmountInTextHint text={otherDescriptionDrafts[item.id] ?? item.description ?? ""} />
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
                โอน
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
            <AmountInTextHint text={newOtherDescription} className="w-full" />
            {newOtherError && <p className="w-full text-xs text-bad">{newOtherError}</p>}
          </div>
        </section>

        {/* Panel **หมายเหตุ — สรุปเงินสด */}
        <section className="rounded-lg border border-line bg-tint p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">**หมายเหตุ (สรุปเงินสด)</h2>
            {daySheet.cashBlock.entered && (
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
            {cashOverrideComponentFields.map(({ key, label }) => renderCashOverrideRow(key, label))}

            {/* Deposit cash in/out (Wave C, docs/adr/0001, judgment-call (b)
                fix — Opus money-review, 2026-07-31): display-only, no new
                arithmetic — CashBlock.depositCashInSatang/depositCashOutSatang
                already fold into bankedSatang below (deriveCashBlock(),
                shared/bookings.ts); this just makes that folding VISIBLE on
                screen, mirroring reportSheetBlocks.tsx's printed
                depositCashRows exactly (same labels, same sign). Rendered
                only when nonzero — silent on an ordinary no-deposit day. */}
            {(daySheet.cashBlock.depositCashInSatang > 0 || daySheet.cashBlock.depositCashOutSatang > 0) && (
              <div className="flex flex-col gap-1 border-t border-line-strong pt-2">
                {daySheet.cashBlock.depositCashInSatang > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink">มัดจำรับเป็นเงินสด</span>
                    <span className="text-sm tabular-nums whitespace-nowrap text-ink">
                      + {formatSatang(daySheet.cashBlock.depositCashInSatang)}
                    </span>
                  </div>
                )}
                {daySheet.cashBlock.depositCashOutSatang > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink">คืนมัดจำเป็นเงินสด</span>
                    <span className="text-sm tabular-nums whitespace-nowrap text-ink">
                      − {formatSatang(daySheet.cashBlock.depositCashOutSatang)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Deposit-machine reconciliation ("adjusting") rows —
                docs/plan-unify-exports-tender-split.md item 6, Wave C,
                owner request 2026-07-31 — rendered AFTER the three
                components and BEFORE the bank total below (same order as
                the printed **หมายเหตุ box, reportSheetBlocks.tsx), but
                unconditionally, never keyed to a specific CASH_BLOCK_FIELDS
                entry — a future reorder of that list must not be able to
                silently drop this subsection (P5, Opus money-review
                2026-07-31). Own clear affordance scoped to just these two
                fields (see clearCashAdjustment/clearCashOverride above). */}
            <div className="mt-1 flex flex-col gap-2 border-t border-line-strong pt-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold text-ink-muted">ปรับยอดฝากจริง (เงินสดเข้าตู้ไม่ได้)</h3>
                {(daySheet.cashBlock.heldBackSatang != null || daySheet.cashBlock.broughtForwardSatang != null) && (
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
                  <span className="text-sm text-ink">{label}</span>
                  <AmountInput
                    value={daySheet.cashBlock[key]}
                    onCommit={(satang) => commitCashAdjustmentField(key, satang)}
                    ariaLabel={label}
                    // P4 (Opus money-review, 2026-07-31): NOT disabled on a
                    // closed month, unlike the till-count override fields
                    // above — the server deliberately never gates this
                    // endpoint (api.md endpoint 21): a reconciliation is
                    // exactly the thing still worth recording after a close.
                    zeroIsMeaningful
                  />
                </div>
              ))}
            </div>

            {bankedField && renderCashOverrideRow(bankedField.key, bankedField.label)}
          </div>
        </section>

        {/* แถบเปรียบเทียบยอดจากรายการจอง — ถาวร ไม่ใช่การอัพเดทอัตโนมัติ */}
        <section className="rounded-lg border border-line bg-panel p-4 text-sm">
          <h2 className="mb-2 text-sm font-semibold text-ink">เปรียบเทียบกับสรุปวัน</h2>
          {variance && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-muted">รวมจากรายการจอง</span>
                <span className="font-semibold tabular-nums text-ink">{formatSatang(variance.derivedSatang)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-ink-muted">กรอกไว้ในสรุปวัน</span>
                <span className="font-semibold tabular-nums text-ink">{formatSatang(variance.typedSatang)}</span>
              </div>
              <div
                className={
                  "flex items-center justify-between gap-3 border-t border-line pt-1 " +
                  (variance.beyondTolerance ? "font-semibold text-warn" : "text-ink-muted")
                }
              >
                <span>ต่าง</span>
                <span className="tabular-nums">{formatSatang(variance.deltaSatang)}</span>
              </div>
              {!variance.beyondTolerance && <p className="text-xs text-ink-muted">ยอดที่กรอกตรงกับรายการจอง</p>}
            </div>
          )}
          <p className="mt-2 text-xs text-ink-muted">
            ยอดจากรายการจองไม่รวมช่องอื่นๆ สด/โอน/เครดิต (ไปคำนวณเป็นรายการอื่นๆแยกต่างหาก) — นับว่าต่างเมื่อเกิน{" "}
            {formatSatang(RECONCILE_TOLERANCE_SATANG)} บาท การปรับยอดให้ต่างจากรายการจองไม่ใช่ข้อผิดพลาด บันทึกเหตุผลได้ที่ช่องหมายเหตุในหน้าสรุปวัน
          </p>
        </section>
      </div>

      {/* พิมพ์/PDF target — the booking sheet only (ReportSheet's
          "bookingsOnly" variant), rendered read-only and hidden on screen;
          see PrintPortal.tsx / style.css's .print-stage. */}
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
              <ReportSheet
                property={effectiveProperty}
                date={effectiveDate}
                sheet={daySheet}
                lines={sortedLines}
                variant="bookingsOnly"
                demo={isDemo}
                inlineTitle
              />
            </div>
          </div>
        </div>
      </PrintPortal>

      {pmsPullResult && (
        <PmsPullResultDialog
          property={effectiveProperty}
          result={pmsPullResult}
          onClose={() => setPmsPullResult(null)}
          onAccepted={refetchLinesAndSheet}
        />
      )}
    </div>
  );
}
