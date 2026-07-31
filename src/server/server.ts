import { Elysia, t } from "elysia";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { identify } from "./auth.ts";
import {
  applyPmsCandidateToBookingLine,
  categoriesForDay,
  countBookingLinesForDay,
  createBookingLine,
  createCategory,
  createDepositEvent,
  createExpenseItem,
  createOtherIncomeItem,
  deleteBookingLine,
  deleteDepositEvent,
  deleteDepositNote,
  deleteExpenseItem,
  deleteOtherIncomeItem,
  getBookingLineById,
  getBookingLinePmsRef,
  getBookingLinesForDay,
  getCategoryById,
  getDepositEventById,
  getDepositEventsForDay,
  getEffectiveIncomeForDay,
  getExpenseById,
  getExpensesForDay,
  getIncomeForDay,
  getOtherIncomeForDay,
  getOtherIncomeItemById,
  getSheetDay,
  insertPmsBookingLines,
  insertPmsDepositEvents,
  isComputedOtherIncomeCategory,
  isMonthClosed,
  listCategories,
  listDaysWithData,
  listDepositNotes,
  mergeCashBlockOverride,
  monthIsClosed,
  moveBookingDay,
  reorderCategories,
  saveIncomeCell,
  setCashBlockOverride,
  setDayVerified,
  setMonthClosed,
  setSheetDayNote,
  touchSheetDay,
  updateBookingLine,
  updateCategory,
  updateDepositEvent,
  updateExpenseItem,
  updateOtherIncomeItem,
  upsertDepositNote,
} from "./db.ts";
import type { BookingLineInput, DepositEventInput, SheetDay } from "./db.ts";
import { enqueueAnalyticsPush, startAnalyticsPushWorker } from "./analytics-push.ts";
import { fetchDayPayments, pmsConfigured } from "./pms-prefill.ts";
import type { DepositCandidate, PrefillAnomaly, PrefillCandidate } from "./pms-prefill.ts";
import { buildDepositExceptions, fetchDepositRegister, DEPOSIT_R_NUMBER_RE } from "./deposit-register.ts";
import { computeDayTotals } from "../shared/totals.ts";
import { computeBookingTotals, deriveCashBlock, deriveIncomeFromBookings, depositCashTotals } from "../shared/bookings.ts";
import { isAccrualDay } from "../shared/accrual.ts";
import { isValidIso, isValidMonth } from "../shared/date.ts";
import {
  AMOUNT_SATANG_MAX,
  AMOUNT_SATANG_MIN,
  BOOKING_NO_MAX_LEN,
  COUNT_MAX,
  DEPOSIT_NOTE_MAX_LEN,
  DEPOSIT_TENDERS,
  DESCRIPTION_MAX_LEN,
  GUEST_NAME_MAX_LEN,
  NAME_TH_MAX_LEN,
  NAME_TH_MIN_LEN,
  NOTE_MAX_LEN,
  REMARK_MAX_LEN,
  ROOM_NO_MAX_LEN,
  TENDERS,
  TENDER_TO_CATEGORY_KEY,
  isProperty,
} from "../shared/types.ts";
import type {
  BookingLine,
  CashBlock,
  Category,
  CategoryKey,
  DaySheet,
  DaySummary,
  DepositEvent,
  IncomeCell,
  Me,
  OtherIncomeItem,
  Property,
  Tender,
} from "../shared/types.ts";

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3000);

// hf-analytics outbox: dormant unless ANALYTICS_URL/ANALYTICS_TOKEN are set
// (see src/server/analytics-push.ts). Started unconditionally at module
// init, same as the estate precedent (room-daily-reporter/src/server/push.ts).
startAnalyticsPushWorker();

// Paths that look like a static asset (have a recognized file extension)
// must 404 when missing — never SPA-fallback them to index.html. Otherwise
// a stale client requesting a chunk purged by a newer deploy gets an HTML
// document served as JS/CSS, which fails silently instead of erroring
// cleanly.
const ASSET_PATH_RE = /\.(js|css|map|png|svg|woff2?)$/i;

// ── validation helpers (bounds per src/shared/api.md) ────────────────────

function isValidAmount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= AMOUNT_SATANG_MIN && n <= AMOUNT_SATANG_MAX;
}

function isValidNote(n: unknown): n is string {
  return typeof n === "string" && n.length <= NOTE_MAX_LEN;
}

function isValidNameTh(n: unknown): n is string {
  return typeof n === "string" && n.length >= NAME_TH_MIN_LEN && n.length <= NAME_TH_MAX_LEN;
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** Composes the pieces every day-scoped handler needs — categories,
 * other-income items, the EFFECTIVE income view (the two รายการอื่นๆ cells
 * computed from other-income items whenever the day has any — see
 * getEffectiveIncomeForDay), expenses, deposit events (Wave C), and
 * totals — so endpoints 6/7/8 can never disagree on what a day's numbers
 * are. */
function loadDayData(property: Property, date: string) {
  const categories = categoriesForDay(property, date);
  const otherIncomeItems = getOtherIncomeForDay(property, date);
  const income = getEffectiveIncomeForDay(property, date, categories, otherIncomeItems);
  const expenses = getExpensesForDay(property, date);
  const deposits = getDepositEventsForDay(property, date);
  const totals = computeDayTotals(categories, income, expenses);
  return { categories, otherIncomeItems, income, expenses, deposits, totals };
}

/**
 * Composes a day's full CashBlock: reads the heldBack/broughtForward
 * adjustment off `sheetDay` (see CashAdjustmentAmounts, shared/types.ts)
 * and feeds it, along with this day's `deposits` (Wave C), into
 * deriveCashBlock() so both always participate in `derived.bankedSatang`,
 * then layers the stored `CashBlockAmounts` override on top and adds the
 * always-derived `depositCashInSatang`/`depositCashOutSatang` display
 * figures (same `depositCashTotals()` helper, never a second computation).
 * The ONE path GET day (endpoint 7) and PUT income/cash-block (endpoints
 * 8/21) all use — never recompute this arithmetic separately.
 */
function buildCashBlock(
  categories: Category[],
  income: Record<number, IncomeCell>,
  otherIncomeItems: OtherIncomeItem[],
  sheetDay: SheetDay | null,
  deposits: DepositEvent[],
): CashBlock {
  const derived = deriveCashBlock(
    categories,
    income,
    otherIncomeItems,
    sheetDay?.cashOverride.heldBackSatang ?? null,
    sheetDay?.cashOverride.broughtForwardSatang ?? null,
    deposits,
  );
  const merged = mergeCashBlockOverride(derived, sheetDay);
  const { depositCashInSatang, depositCashOutSatang } = depositCashTotals(deposits);
  return { ...merged, depositCashInSatang, depositCashOutSatang };
}

function isValidCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= COUNT_MAX;
}

function isValidBoundedString(n: unknown, maxLen: number): n is string {
  return typeof n === "string" && n.length <= maxLen;
}

function isValidTenders(v: unknown): v is Record<Tender, number> {
  if (typeof v !== "object" || v === null) return false;
  const record = v as Record<string, unknown>;
  return TENDERS.every((tender) => isValidAmount(record[tender]));
}

/** 409s a write when `date`'s month is closed (see src/shared/api.md
 * "closed_months" — blocks income cells, booking lines, other-income
 * items, and expenses). Callers apply this before mutating. */
function closedMonthResponse(
  property: Property,
  date: string,
  status: (code: number, body: unknown) => unknown,
): unknown {
  if (isMonthClosed(property, date)) return status(409, { error: "month is closed" });
  return null;
}

// Every BookingLine field is editable except id/property/date and the
// audit quartet (see src/shared/api.md endpoints 14/15) — all optional,
// since seq and every other field falls back to a sensible default
// (createBookingLine in db.ts) when omitted from a create body.
const bookingLineInputSchema = t.Object({
  seq: t.Optional(t.Number()),
  bookingNo: t.Optional(t.Union([t.String(), t.Null()])),
  guestName: t.Optional(t.Union([t.String(), t.Null()])),
  roomNo: t.Optional(t.Union([t.String(), t.Null()])),
  roomCount: t.Optional(t.Union([t.Number(), t.Null()])),
  nights: t.Optional(t.Union([t.Number(), t.Null()])),
  grossRoomSatang: t.Optional(t.Number()),
  grossOtherSatang: t.Optional(t.Number()),
  discountSatang: t.Optional(t.Number()),
  tenders: t.Optional(
    t.Object({
      deposit: t.Number(),
      deposit_applied: t.Number(),
      cash: t.Number(),
      credit_kbank: t.Number(),
      credit_icbc: t.Number(),
      transfer_kbank: t.Number(),
      transfer_icbc: t.Number(),
      web: t.Number(),
      other: t.Number(),
    }),
  ),
  remark: t.Optional(t.Union([t.String(), t.Null()])),
  source: t.Optional(t.String()),
  draft: t.Optional(t.Boolean()),
  pmsRef: t.Optional(t.Union([t.String(), t.Null()])),
  sourceSheet: t.Optional(t.Union([t.String(), t.Null()])),
});

/** Bounds per src/shared/api.md "Bounds" — returns an error message, or
 * null when the (possibly partial) booking-line body is valid. Takes the
 * loosely-typed Typebox-validated body (source: string, not yet narrowed
 * to BookingLine["source"]) — the `source` check below is what narrows it;
 * callers cast to BookingLineInput once this returns null. */
function validateBookingLineInput(body: Omit<BookingLineInput, "source"> & { source?: string }): string | null {
  if (body.bookingNo != null && !isValidBoundedString(body.bookingNo, BOOKING_NO_MAX_LEN)) {
    return "invalid bookingNo";
  }
  if (body.guestName != null && !isValidBoundedString(body.guestName, GUEST_NAME_MAX_LEN)) {
    return "invalid guestName";
  }
  if (body.roomNo != null && !isValidBoundedString(body.roomNo, ROOM_NO_MAX_LEN)) {
    return "invalid roomNo";
  }
  if (body.roomCount != null && !isValidCount(body.roomCount)) return "invalid roomCount";
  if (body.nights != null && !isValidCount(body.nights)) return "invalid nights";
  if (body.grossRoomSatang !== undefined && !isValidAmount(body.grossRoomSatang)) return "invalid grossRoomSatang";
  if (body.grossOtherSatang !== undefined && !isValidAmount(body.grossOtherSatang)) {
    return "invalid grossOtherSatang";
  }
  if (body.discountSatang !== undefined && !isValidAmount(body.discountSatang)) return "invalid discountSatang";
  if (body.tenders !== undefined && !isValidTenders(body.tenders)) return "invalid tenders";
  if (body.source !== undefined && body.source !== "manual" && body.source !== "import" && body.source !== "pms") {
    return "invalid source";
  }
  // Remark has its own bound (REMARK_MAX_LEN) rather than borrowing
  // NOTE_MAX_LEN — same number today, but the client reads the same named
  // constant, so the two can never drift apart again silently.
  if (body.remark != null && !isValidBoundedString(body.remark, REMARK_MAX_LEN)) return "invalid remark";
  return null;
}

/** Bounds for a (possibly partial) DepositEvent body — see
 * validateBookingLineInput's own doc comment for the pattern. Reused for
 * both create (every declared field required by the Elysia schema, so the
 * presence checks below are effectively no-ops there) and update (every
 * field optional). Takes the loosely-typed Typebox-validated body (kind/
 * tender: string, not yet narrowed) — this function's own enum checks are
 * what narrow them; callers cast to DepositEventInput once this returns
 * null, same pattern as validateBookingLineInput. */
function validateDepositEventInput(
  body: Omit<DepositEventInput, "kind" | "tender"> & { kind?: string; tender?: string },
): string | null {
  if (body.kind !== undefined && body.kind !== "received" && body.kind !== "refunded") {
    return "invalid kind";
  }
  if (body.bookingNo != null && !isValidBoundedString(body.bookingNo, BOOKING_NO_MAX_LEN)) {
    return "invalid bookingNo";
  }
  if (body.guestName != null && !isValidBoundedString(body.guestName, GUEST_NAME_MAX_LEN)) {
    return "invalid guestName";
  }
  if (body.tender !== undefined && !(DEPOSIT_TENDERS as readonly string[]).includes(body.tender)) {
    return "invalid tender";
  }
  if (body.amountSatang !== undefined && (!isValidAmount(body.amountSatang) || body.amountSatang <= 0)) {
    return "invalid amountSatang";
  }
  if (body.note != null && !isValidNote(body.note)) return "invalid note";
  return null;
}

/** 400s a write against a date before `property`'s accrual cutover (see
 * shared/accrual.ts) — a pre-cutover day can never legitimately hold a
 * deposit_events row under the new model (C7: gate ONLY at write
 * boundaries; read paths stay ungated because no pre-cutover day can ever
 * hold one in the first place). Callers apply this before mutating,
 * alongside closedMonthResponse. */
function preCutoverResponse(
  property: Property,
  date: string,
  status: (code: number, body: unknown) => unknown,
): unknown {
  if (!isAccrualDay(property, date)) {
    return status(400, { error: "pre-cutover date: deposits are not tracked before the accrual cutover" });
  }
  return null;
}

/** F1 (Opus money-review, 2026-07-31): the same pre-cutover gate as
 * preCutoverResponse above, but for a direct booking-line write carrying a
 * nonzero `deposit_applied` tender — a hand-typed or hand-edited row could
 * otherwise plant the accrual-era tender on a pre-cutover date exactly the
 * way an un-gated PMS pull used to. `validateBookingLineInput` has no date
 * context (it's a pure body-shape check), so this lives in the route
 * handlers instead, where `date` is known. */
function preCutoverDepositAppliedResponse(
  property: Property,
  date: string,
  tenders: Record<Tender, number> | undefined,
  status: (code: number, body: unknown) => unknown,
): unknown {
  if (tenders !== undefined && tenders.deposit_applied !== 0 && !isAccrualDay(property, date)) {
    return status(400, {
      error: "pre-cutover date: deposit_applied is not tracked before the accrual cutover",
    });
  }
  return null;
}

// ── /api routes ────────────────────────────────────────────────────────
// Every handler implements one endpoint from src/shared/api.md — the
// contract of record. Auth: a scoped derive resolves identity and a
// top-level onBeforeHandle 401s when absent — that is authentication
// (Cloudflare Access decides who reaches this host), never a role. Static
// assets and GET /healthz (outside this group) are unguarded — Cloudflare
// Access fronts the whole host.

export const api = new Elysia({ prefix: "/api" })
  .derive(async ({ request }) => ({ identity: await identify(request) }))
  .onBeforeHandle(({ identity, status }) => {
    if (!identity) return status(401, { error: "unauthenticated" });
  })

  // 1. GET /api/me
  .get("/me", ({ identity }): Me => ({ email: identity!.email }))

  // 2. GET /api/:property/categories?includeArchived=1
  .get("/:property/categories", ({ params, query, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const includeArchived = query.includeArchived === "1";
    return { categories: listCategories(property, includeArchived) };
  })

  // 3. POST /api/:property/categories
  .post(
    "/:property/categories",
    ({ params, body, status }) => {
      const { property } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (body.kind !== "income" && body.kind !== "expense") {
        return status(400, { error: "invalid kind" });
      }
      if (!isValidNameTh(body.nameTh)) return status(400, { error: "invalid nameTh" });
      if (typeof body.isCash !== "boolean") return status(400, { error: "invalid isCash" });

      try {
        const category = createCategory(property, body.kind, body.nameTh, body.isCash);
        return status(201, category);
      } catch (err) {
        if (isUniqueConstraintError(err)) return status(409, { error: "duplicate category name" });
        throw err;
      }
    },
    { body: t.Object({ kind: t.String(), nameTh: t.String(), isCash: t.Boolean() }) },
  )

  // 4. PATCH /api/:property/categories/:id
  .patch(
    "/:property/categories/:id",
    ({ params, body, status }) => {
      const { property } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      const id = Number(params.id);
      if (!Number.isInteger(id)) return status(404, { error: "category not found" });
      if (body.nameTh !== undefined && !isValidNameTh(body.nameTh)) {
        return status(400, { error: "invalid nameTh" });
      }
      if (body.isCash !== undefined && typeof body.isCash !== "boolean") {
        return status(400, { error: "invalid isCash" });
      }
      if (body.archived !== undefined && typeof body.archived !== "boolean") {
        return status(400, { error: "invalid archived" });
      }
      if (body.archived === true) {
        const existing = getCategoryById(property, id);
        if (!existing) return status(404, { error: "category not found" });
        // A keyed category derives income (fill-from-bookings, the two
        // รายการอื่นๆ cells) — archiving it would silently strip that
        // derivation for every future day.
        if (existing.categoryKey !== null) {
          return status(400, { error: "cannot archive a category with a category_key" });
        }
      }

      try {
        const updated = updateCategory(property, id, body);
        if (!updated) return status(404, { error: "category not found" });
        return updated;
      } catch (err) {
        if (isUniqueConstraintError(err)) return status(409, { error: "duplicate category name" });
        throw err;
      }
    },
    {
      body: t.Object({
        nameTh: t.Optional(t.String()),
        isCash: t.Optional(t.Boolean()),
        archived: t.Optional(t.Boolean()),
      }),
    },
  )

  // 5. POST /api/:property/categories/reorder
  .post(
    "/:property/categories/reorder",
    ({ params, body, status }) => {
      const { property } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (body.kind !== "income" && body.kind !== "expense") {
        return status(400, { error: "invalid kind" });
      }
      if (!body.orderedIds.every((n) => Number.isInteger(n))) {
        return status(400, { error: "invalid orderedIds" });
      }
      const categories = reorderCategories(property, body.kind, body.orderedIds);
      if (categories === null) {
        return status(400, { error: "orderedIds must be exactly the active category ids" });
      }
      return { categories };
    },
    { body: t.Object({ kind: t.String(), orderedIds: t.Array(t.Number()) }) },
  )

  // 6. GET /api/:property/days?month=YYYY-MM
  .get("/:property/days", ({ params, query, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const month = query.month;
    if (typeof month !== "string" || !isValidMonth(month)) return status(400, { error: "invalid month" });

    const dates = listDaysWithData(property, month);
    const days: DaySummary[] = dates.map((date) => {
      const { totals } = loadDayData(property, date);
      const sheetDay = getSheetDay(property, date);
      return {
        date,
        incomeSatang: totals.incomeSatang,
        expenseSatang: totals.expenseSatang,
        cashToDepositSatang: totals.cashToDepositSatang,
        verified: sheetDay?.verifiedAt != null,
        provenance: sheetDay?.provenance ?? "app",
      };
    });
    return { month, days };
  })

  // 7. GET /api/:property/day/:date
  .get("/:property/day/:date", ({ params, status }) => {
    const { property, date } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidIso(date)) return status(400, { error: "invalid date" });

    const { categories, otherIncomeItems, income, expenses, deposits, totals } = loadDayData(property, date);
    const sheetDay = getSheetDay(property, date);

    const sheet: DaySheet = {
      categories,
      income,
      expenses,
      note: sheetDay?.note ?? null,
      totals,
      bookingLineCount: countBookingLinesForDay(property, date),
      otherIncome: otherIncomeItems,
      cashBlock: buildCashBlock(categories, income, otherIncomeItems, sheetDay, deposits),
      deposits,
      provenance: sheetDay?.provenance ?? "app",
      verifiedAt: sheetDay?.verifiedAt ?? null,
      verifiedBy: sheetDay?.verifiedBy ?? null,
      monthClosed: isMonthClosed(property, date),
      updatedAt: sheetDay?.updatedAt ?? "",
      updatedBy: sheetDay?.updatedBy ?? "",
    };
    return sheet;
  })

  // 8. PUT /api/:property/day/:date/income/:categoryId
  .put(
    "/:property/day/:date/income/:categoryId",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      const categoryId = Number(params.categoryId);
      if (!Number.isInteger(categoryId)) return status(404, { error: "category not found" });
      const category = getCategoryById(property, categoryId);
      if (!category || category.kind !== "income") return status(404, { error: "category not found" });

      const blocked = closedMonthResponse(property, date, status);
      if (blocked) return blocked;

      const otherIncomeItems = getOtherIncomeForDay(property, date);
      if (isComputedOtherIncomeCategory(category, otherIncomeItems.length)) {
        return status(400, { error: "computed from other-income items" });
      }

      const { amountSatang, note } = body;
      if (amountSatang !== null && !isValidAmount(amountSatang)) {
        return status(400, { error: "invalid amountSatang" });
      }
      if (note !== undefined && note !== null && !isValidNote(note)) {
        return status(400, { error: "invalid note" });
      }

      const by = identity!.email;
      saveIncomeCell(property, date, categoryId, amountSatang, note ?? null, by);
      touchSheetDay(property, date, by);
      enqueueAnalyticsPush(property, date);

      // P3 (Opus money-review, 2026-07-31): also returns the freshly
      // recomputed cashBlock — room/bar cash and the two computed
      // รายการอื่นๆ cells all feed straight into it, so without this the
      // day page's "ยอดฝากจริง" bold line (and its print/PDF export) would
      // go stale after every income edit until the next full day reload.
      const dayData = loadDayData(property, date);
      const sheetDay = getSheetDay(property, date);
      const cashBlock = buildCashBlock(
        dayData.categories,
        dayData.income,
        dayData.otherIncomeItems,
        sheetDay,
        dayData.deposits,
      );
      return { income: dayData.income, totals: dayData.totals, cashBlock };
    },
    {
      body: t.Object({
        amountSatang: t.Union([t.Number(), t.Null()]),
        note: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  // 9. PUT /api/:property/day/:date/note
  .put(
    "/:property/day/:date/note",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      if (body.note !== null && !isValidNote(body.note)) return status(400, { error: "invalid note" });

      setSheetDayNote(property, date, body.note, identity!.email);
      enqueueAnalyticsPush(property, date);
      return { note: body.note };
    },
    { body: t.Object({ note: t.Union([t.String(), t.Null()]) }) },
  )

  // 10. POST /api/:property/day/:date/expenses
  .post(
    "/:property/day/:date/expenses",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      const category = getCategoryById(property, body.categoryId);
      if (!category || category.kind !== "expense") return status(404, { error: "category not found" });
      if (
        !Number.isInteger(body.amountSatang) ||
        body.amountSatang <= 0 ||
        body.amountSatang > AMOUNT_SATANG_MAX
      ) {
        return status(400, { error: "invalid amountSatang" });
      }
      if (body.note !== undefined && body.note !== null && !isValidNote(body.note)) {
        return status(400, { error: "invalid note" });
      }
      const blocked = closedMonthResponse(property, date, status);
      if (blocked) return blocked;

      const by = identity!.email;
      const item = createExpenseItem(property, date, body.categoryId, body.amountSatang, body.note ?? null, by);
      touchSheetDay(property, date, by);
      enqueueAnalyticsPush(property, date);
      return status(201, item);
    },
    {
      body: t.Object({
        categoryId: t.Number(),
        amountSatang: t.Number(),
        note: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  // 11. PATCH /api/:property/expenses/:id
  .patch(
    "/:property/expenses/:id",
    ({ params, body, identity, status }) => {
      const { property } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      const id = Number(params.id);
      if (!Number.isInteger(id)) return status(404, { error: "expense not found" });
      const existing = getExpenseById(property, id);
      if (!existing) return status(404, { error: "expense not found" });

      if (body.categoryId !== undefined) {
        const category = getCategoryById(property, body.categoryId);
        if (!category || category.kind !== "expense") return status(404, { error: "category not found" });
      }
      if (body.amountSatang !== undefined) {
        if (
          !Number.isInteger(body.amountSatang) ||
          body.amountSatang <= 0 ||
          body.amountSatang > AMOUNT_SATANG_MAX
        ) {
          return status(400, { error: "invalid amountSatang" });
        }
      }
      if (body.note !== undefined && body.note !== null && !isValidNote(body.note)) {
        return status(400, { error: "invalid note" });
      }
      const blocked = closedMonthResponse(property, existing.date, status);
      if (blocked) return blocked;

      const by = identity!.email;
      const updated = updateExpenseItem(property, id, body, by);
      if (!updated) return status(404, { error: "expense not found" });
      touchSheetDay(property, updated.date, by);
      enqueueAnalyticsPush(property, updated.date);
      return updated;
    },
    {
      body: t.Object({
        categoryId: t.Optional(t.Number()),
        amountSatang: t.Optional(t.Number()),
        note: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  // 12. DELETE /api/:property/expenses/:id
  .delete("/:property/expenses/:id", ({ params, identity, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const id = Number(params.id);
    if (!Number.isInteger(id)) return status(404, { error: "expense not found" });
    const existing = getExpenseById(property, id);
    if (!existing) return status(404, { error: "expense not found" });
    const blocked = closedMonthResponse(property, existing.date, status);
    if (blocked) return blocked;

    deleteExpenseItem(property, id);
    touchSheetDay(property, existing.date, identity!.email);
    enqueueAnalyticsPush(property, existing.date);
    return status(204);
  })

  // 13. GET /api/:property/day/:date/bookings
  // `pmsPull` is additive (Wave 3 / pms-prefill) — the client's capability
  // flag for the ดึงข้อมูล button, true iff this property's PMS env URL is
  // set (pmsConfigured() in pms-prefill.ts). Everything else unchanged.
  .get("/:property/day/:date/bookings", ({ params, status }) => {
    const { property, date } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidIso(date)) return status(400, { error: "invalid date" });

    const lines = getBookingLinesForDay(property, date);
    return { lines, totals: computeBookingTotals(lines), pmsPull: pmsConfigured(property) };
  })

  // 14. POST /api/:property/day/:date/bookings
  .post(
    "/:property/day/:date/bookings",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      const invalid = validateBookingLineInput(body);
      if (invalid) return status(400, { error: invalid });
      const gated = preCutoverDepositAppliedResponse(property, date, body.tenders, status);
      if (gated) return gated;
      const blocked = closedMonthResponse(property, date, status);
      if (blocked) return blocked;

      const by = identity!.email;
      const line = createBookingLine(property, date, body as BookingLineInput, by);
      touchSheetDay(property, date, by);
      enqueueAnalyticsPush(property, date);
      return status(201, line);
    },
    { body: bookingLineInputSchema },
  )

  // 15. PATCH /api/:property/bookings/:id
  .patch(
    "/:property/bookings/:id",
    ({ params, body, identity, status }) => {
      const { property } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      const id = Number(params.id);
      if (!Number.isInteger(id)) return status(404, { error: "booking line not found" });
      const existing = getBookingLineById(property, id);
      if (!existing) return status(404, { error: "booking line not found" });
      const invalid = validateBookingLineInput(body);
      if (invalid) return status(400, { error: invalid });
      const gated = preCutoverDepositAppliedResponse(property, existing.date, body.tenders, status);
      if (gated) return gated;
      const blocked = closedMonthResponse(property, existing.date, status);
      if (blocked) return blocked;

      const by = identity!.email;
      const updated = updateBookingLine(property, id, body as BookingLineInput, by);
      if (!updated) return status(404, { error: "booking line not found" });
      touchSheetDay(property, updated.date, by);
      enqueueAnalyticsPush(property, updated.date);
      return updated;
    },
    { body: bookingLineInputSchema },
  )

  // 16. DELETE /api/:property/bookings/:id
  .delete("/:property/bookings/:id", ({ params, identity, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const id = Number(params.id);
    if (!Number.isInteger(id)) return status(404, { error: "booking line not found" });
    const existing = getBookingLineById(property, id);
    if (!existing) return status(404, { error: "booking line not found" });
    const blocked = closedMonthResponse(property, existing.date, status);
    if (blocked) return blocked;

    deleteBookingLine(property, id);
    touchSheetDay(property, existing.date, identity!.email);
    enqueueAnalyticsPush(property, existing.date);
    return status(204);
  })

  // 17. POST /api/:property/day/:date/other-income
  .post(
    "/:property/day/:date/other-income",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      if (body.description !== null && !isValidBoundedString(body.description, DESCRIPTION_MAX_LEN)) {
        return status(400, { error: "invalid description" });
      }
      if (!Number.isInteger(body.amountSatang) || body.amountSatang <= 0 || body.amountSatang > AMOUNT_SATANG_MAX) {
        return status(400, { error: "invalid amountSatang" });
      }
      const blocked = closedMonthResponse(property, date, status);
      if (blocked) return blocked;

      const by = identity!.email;
      const item = createOtherIncomeItem(property, date, body.description, body.amountSatang, body.isCash, by);
      touchSheetDay(property, date, by);
      enqueueAnalyticsPush(property, date);
      return status(201, item);
    },
    {
      body: t.Object({
        description: t.Union([t.String(), t.Null()]),
        amountSatang: t.Number(),
        isCash: t.Boolean(),
      }),
    },
  )

  // 18. PATCH /api/:property/other-income/:id
  .patch(
    "/:property/other-income/:id",
    ({ params, body, identity, status }) => {
      const { property } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      const id = Number(params.id);
      if (!Number.isInteger(id)) return status(404, { error: "other-income item not found" });
      const existing = getOtherIncomeItemById(property, id);
      if (!existing) return status(404, { error: "other-income item not found" });

      if (body.description !== undefined && body.description !== null) {
        if (!isValidBoundedString(body.description, DESCRIPTION_MAX_LEN)) {
          return status(400, { error: "invalid description" });
        }
      }
      if (body.amountSatang !== undefined) {
        if (
          !Number.isInteger(body.amountSatang) ||
          body.amountSatang <= 0 ||
          body.amountSatang > AMOUNT_SATANG_MAX
        ) {
          return status(400, { error: "invalid amountSatang" });
        }
      }
      const blocked = closedMonthResponse(property, existing.date, status);
      if (blocked) return blocked;

      const by = identity!.email;
      const updated = updateOtherIncomeItem(property, id, body, by);
      if (!updated) return status(404, { error: "other-income item not found" });
      touchSheetDay(property, updated.date, by);
      enqueueAnalyticsPush(property, updated.date);
      return updated;
    },
    {
      body: t.Object({
        description: t.Optional(t.Union([t.String(), t.Null()])),
        amountSatang: t.Optional(t.Number()),
        isCash: t.Optional(t.Boolean()),
      }),
    },
  )

  // 19. DELETE /api/:property/other-income/:id
  .delete("/:property/other-income/:id", ({ params, identity, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const id = Number(params.id);
    if (!Number.isInteger(id)) return status(404, { error: "other-income item not found" });
    const existing = getOtherIncomeItemById(property, id);
    if (!existing) return status(404, { error: "other-income item not found" });
    const blocked = closedMonthResponse(property, existing.date, status);
    if (blocked) return blocked;

    deleteOtherIncomeItem(property, id);
    touchSheetDay(property, existing.date, identity!.email);
    enqueueAnalyticsPush(property, existing.date);
    return status(204);
  })

  // 20. POST /api/:property/day/:date/fill-from-bookings?apply=true
  .post("/:property/day/:date/fill-from-bookings", ({ params, query, identity, status }) => {
    const { property, date } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidIso(date)) return status(400, { error: "invalid date" });
    const apply = query.apply === "true";
    if (apply) {
      const blocked = closedMonthResponse(property, date, status);
      if (blocked) return blocked;
    }

    const lines = getBookingLinesForDay(property, date);
    const derived = deriveIncomeFromBookings(lines);
    const categories = categoriesForDay(property, date);
    const categoryIdByKey = new Map<CategoryKey, number>();
    for (const category of categories) {
      if (category.categoryKey) categoryIdByKey.set(category.categoryKey, category.id);
    }
    const currentIncome = getIncomeForDay(property, date);
    const derivableKeys = [...new Set(Object.values(TENDER_TO_CATEGORY_KEY))] as CategoryKey[];
    const by = identity!.email;

    const diff = derivableKeys
      .filter((key) => derived[key] !== undefined)
      .map((key) => {
        const categoryId = categoryIdByKey.get(key) ?? null;
        const existingCell = categoryId !== null ? currentIncome[categoryId] : undefined;
        const beforeSatang = existingCell?.amountSatang ?? 0;
        const skippedManual = existingCell?.manual === true;
        const afterSatang = skippedManual ? beforeSatang : derived[key]!;

        if (apply && categoryId !== null && !skippedManual && afterSatang !== beforeSatang) {
          saveIncomeCell(
            property,
            date,
            categoryId,
            afterSatang,
            existingCell?.note ?? null,
            by,
            "booking",
            false,
          );
          touchSheetDay(property, date, by);
        }

        return { categoryKey: key, categoryId, beforeSatang, afterSatang, skippedManual };
      });

    // Preview never writes anything, so it never needs a push; apply may
    // have written new income cells for this day even when every diff line
    // is unchanged in aggregate, so enqueue unconditionally on apply.
    if (apply) enqueueAnalyticsPush(property, date);

    return { diff };
  })

  // 21. PUT /api/:property/day/:date/cash-block
  .put(
    "/:property/day/:date/cash-block",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });

      if (body !== null) {
        for (const value of Object.values(body)) {
          if (!isValidAmount(value)) return status(400, { error: "invalid cash-block amount" });
        }
      }

      setCashBlockOverride(property, date, body, identity!.email);
      enqueueAnalyticsPush(property, date);
      const { categories, otherIncomeItems, income, deposits } = loadDayData(property, date);
      const sheetDay = getSheetDay(property, date);
      return buildCashBlock(categories, income, otherIncomeItems, sheetDay, deposits);
    },
    {
      body: t.Union([
        t.Null(),
        t.Object({
          roomCashSatang: t.Optional(t.Number()),
          otherCashSatang: t.Optional(t.Number()),
          barCashSatang: t.Optional(t.Number()),
          bankedSatang: t.Optional(t.Number()),
          // Deposit-machine reconciliation rows (docs/plan-unify-exports-
          // tender-split.md item 6, Wave C) — see CashAdjustmentAmounts.
          // Same absolute-replace body as the four fields above: present
          // -> stored override, absent -> reset to "not recorded" (null).
          heldBackSatang: t.Optional(t.Number()),
          broughtForwardSatang: t.Optional(t.Number()),
        }),
      ]),
    },
  )

  // 22. PUT /api/:property/day/:date/verify
  .put(
    "/:property/day/:date/verify",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      // A closed month is frozen, sign-off included.
      const closed = closedMonthResponse(property, date, status);
      if (closed) return closed;

      setDayVerified(property, date, body.verified, identity!.email);
      enqueueAnalyticsPush(property, date);
      const sheetDay = getSheetDay(property, date);
      return { verifiedAt: sheetDay?.verifiedAt ?? null, verifiedBy: sheetDay?.verifiedBy ?? null };
    },
    { body: t.Object({ verified: t.Boolean() }) },
  )

  // 23. GET /api/:property/months/:month/close
  .get("/:property/months/:month/close", ({ params, status }) => {
    const { property, month } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidMonth(month)) return status(400, { error: "invalid month" });
    return { month, closed: monthIsClosed(property, month) };
  })

  // 24. PUT /api/:property/months/:month/close
  .put(
    "/:property/months/:month/close",
    ({ params, body, identity, status }) => {
      const { property, month } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidMonth(month)) return status(400, { error: "invalid month" });

      setMonthClosed(property, month, body.closed, identity!.email);
      // The wire payload itself carries no monthClosed field, but a close
      // freezes every write path for the whole month (verify included) and
      // a reopen unfreezes them again — re-enqueue every day in the month
      // that has any data so a day whose push failed mid-month, or whose
      // last write happened before analytics was wired up, still gets a
      // fresh push rather than silently drifting.
      for (const date of listDaysWithData(property, month)) enqueueAnalyticsPush(property, date);
      return { month, closed: body.closed };
    },
    { body: t.Object({ closed: t.Boolean() }) },
  )

  // 25. POST /api/:property/day/:date/move — moves ONLY booking_lines,
  // other_income_items, AND deposit_events (Wave C, Opus money-review F2,
  // 2026-07-31) for :date from :property to body.to; see src/shared/api.md
  // and moveBookingDay() in db.ts for the full scope and seq-renumbering
  // rule. `to` is intentionally t.Optional in the schema so
  // a missing field reaches this handler as `undefined` and gets the same
  // app-shaped 400 as any other invalid value, rather than Elysia's own
  // schema-validation error.
  .post(
    "/:property/day/:date/move",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });

      const { to } = body;
      if (typeof to !== "string" || !isProperty(to)) return status(400, { error: "invalid to" });
      if (to === property) return status(400, { error: "invalid to" });

      // Both sides must be open before anything is written — a month can be
      // closed on only one of the two properties.
      const blockedSource = closedMonthResponse(property, date, status);
      if (blockedSource) return blockedSource;
      const blockedDest = closedMonthResponse(to, date, status);
      if (blockedDest) return blockedDest;

      const by = identity!.email;
      let result: { bookingLines: number; otherIncome: number; depositEvents: number };
      try {
        result = moveBookingDay(property, to, date, by);
      } catch (err) {
        // Only real-world trigger: the destination day already has a
        // booking line or deposit event sharing a (property, date,
        // pms_ref, ...) with a moved row (the partial unique indexes) —
        // nothing writes pms_ref from the UI today, so this is
        // theoretical, but fails cleanly rather than crashing. The
        // transaction inside moveBookingDay() already rolled back, so
        // nothing was moved.
        if (isUniqueConstraintError(err)) {
          return status(500, { error: "cannot move: conflicting pms_ref on destination day" });
        }
        throw err;
      }

      // One call changes two property-days' rollups.
      enqueueAnalyticsPush(property, date);
      enqueueAnalyticsPush(to, date);

      return {
        movedBookingLines: result.bookingLines,
        movedOtherIncome: result.otherIncome,
        movedDepositEvents: result.depositEvents,
      };
    },
    { body: t.Object({ to: t.Optional(t.String()) }) },
  )

  // 26. POST /api/:property/day/:date/pull-from-pms — inserts booking lines
  // AND deposit events from the PMS payment ledger for :date
  // (src/server/pms-prefill.ts, src/shared/api.md, Wave C docs/adr/0001).
  // Button-triggered only, insert-only and idempotent (never updates an
  // existing row — hand edits are sacred). 503 when this property's PMS
  // env URL is unset; 409 when the month is closed; a PMS query failure
  // 502s with nothing inserted (fetchDayPayments throws BEFORE anything is
  // written). Refunds are split out and counted in `skippedRefunds`, never
  // inserted.
  //
  // Mirrors insertPmsBookingLines' AUTO-PLACEMENT POLICY (db.ts) exactly —
  // do not let these two drift apart: transfer is auto-placed into
  // transfer_kbank for BOTH properties (evidence: t_transfer_icbc is 0
  // across all history, both properties); credit is auto-placed into
  // credit_kbank ONLY for hfville (single bank there — "hf" genuinely uses
  // two credit banks and cannot be inferred). `autoPlaced` reports every
  // inserted-or-skipped non-refund candidate that had a nonzero
  // credit/transfer amount actually written to a bank column, for the
  // caller's verification note. `unplaced` now only ever holds the one
  // genuinely-unresolvable case: hf credit.
  //
  // Wave C: deposit candidates (จ่ายล่วงหน้า/คืนเงินจองห้อง) found on a
  // PRE-cutover date are never written — C7 gates importer deposit-event
  // emission at the cutover the same way the hand-entry endpoints below do
  // — instead they are folded into `anomalies` (reason
  // `pre_cutover_deposit`) so the money is reported, never silently
  // dropped. On/after cutover they insert via `insertPmsDepositEvents`
  // (db.ts), additive alongside the booking-line insert above.
  .post("/:property/day/:date/pull-from-pms", async ({ params, identity, status }) => {
    const { property, date } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!isValidIso(date)) return status(400, { error: "invalid date" });
    if (!pmsConfigured(property)) return status(503, { error: "pms prefill not configured" });
    const blocked = closedMonthResponse(property, date, status);
    if (blocked) return blocked;

    let bookingCandidates: PrefillCandidate[];
    let depositCandidates: DepositCandidate[];
    let anomalies: PrefillAnomaly[];
    try {
      ({ bookingCandidates, depositCandidates, anomalies } = await fetchDayPayments(property, date));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return status(502, { error: message });
    }

    const accrual = isAccrualDay(property, date);
    const allAnomalies = [...anomalies];

    const refunds = bookingCandidates.filter((c) => c.isRefund);
    let nonRefunds = bookingCandidates.filter((c) => !c.isRefund);

    // F1 (Opus money-review, 2026-07-31): a ตัดยอดล่วงหน้า line found on a
    // PRE-cutover date must NEVER write its applied amount — that deposit
    // was already booked as income under the OLD rule (docs/adr/0001), so
    // also writing t_deposit_applied would double-count it across the
    // cutover (proven live: a pre-cutover pull wrote appliedDepositSatang
    // even though depositsInserted stayed 0). Strip it BEFORE
    // insertPmsBookingLines ever sees the candidate — never after — and
    // report the stripped amount as an anomaly, mirroring the
    // deposit-event branch below exactly. The room/other charge on the
    // SAME candidate is still legitimate income either way, so the
    // candidate itself is still inserted, just without the applied tender.
    if (!accrual) {
      nonRefunds = nonRefunds.map((c) => {
        if (c.appliedDepositSatang === 0) return c;
        allAnomalies.push({
          pmsRef: c.pmsRef,
          reason: "pre_cutover_deposit",
          detail: `applied ${c.appliedDepositSatang}`,
        });
        return { ...c, appliedDepositSatang: 0, appliedDepositBookingNos: [] };
      });
    }

    const by = identity!.email;
    const { inserted, skipped, changed } = insertPmsBookingLines(property, date, nonRefunds, by);

    let depositsInserted = 0;
    let depositsSkipped = 0;
    if (!accrual) {
      // Pre-cutover: report every deposit candidate as an anomaly rather
      // than writing a deposit_events row a pre-cutover day can never
      // legitimately hold (see preCutoverResponse's doc comment for the
      // hand-entry side of this same gate).
      for (const candidate of depositCandidates) {
        allAnomalies.push({
          pmsRef: candidate.pmsRef,
          reason: "pre_cutover_deposit",
          detail: `${candidate.kind} ${candidate.tender} ${candidate.amountSatang}`,
        });
      }
    } else {
      ({ inserted: depositsInserted, skipped: depositsSkipped } = insertPmsDepositEvents(
        property,
        date,
        depositCandidates,
        by,
      ));
    }

    if (inserted > 0 || depositsInserted > 0) {
      touchSheetDay(property, date, by);
      enqueueAnalyticsPush(property, date);
    }

    const autoPlaced = nonRefunds
      .filter((c) => c.unplacedTranSatang > 0 || (property === "hfville" && c.unplacedCreditSatang > 0))
      .map((c) => ({
        pmsRef: c.pmsRef,
        bookingNo: c.bookingNo,
        transferSatang: c.unplacedTranSatang,
        creditSatang: property === "hfville" ? c.unplacedCreditSatang : 0,
      }));

    const unplaced = nonRefunds
      .filter((c) => property === "hf" && c.unplacedCreditSatang > 0)
      .map((c) => ({
        pmsRef: c.pmsRef,
        bookingNo: c.bookingNo,
        creditSatang: c.unplacedCreditSatang,
        tranSatang: 0,
      }));

    return {
      inserted,
      skipped,
      skippedRefunds: refunds.length,
      unplaced,
      autoPlaced,
      depositsInserted,
      depositsSkipped,
      anomalies: allAnomalies,
      // Wave D, D5: existing PMS-sourced rows a fresh pull found differing
      // from what is currently stored — additive, like autoPlaced.
      changed,
    };
  })

  // 27. POST /api/:property/day/:date/deposits — hand-entry create for a
  // received/refunded มัดจำล่วงหน้า moment (Wave C, docs/adr/0001). Mirrors
  // the other-income CRUD shape (endpoint 17): closedMonthResponse gate,
  // touchSheetDay + enqueueAnalyticsPush on write. Additionally refuses a
  // pre-cutover date (preCutoverResponse) — a pre-cutover day can never
  // legitimately hold a deposit event under the new model.
  .post(
    "/:property/day/:date/deposits",
    ({ params, body, identity, status }) => {
      const { property, date } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!isValidIso(date)) return status(400, { error: "invalid date" });
      const invalid = validateDepositEventInput(body);
      if (invalid) return status(400, { error: invalid });
      const gated = preCutoverResponse(property, date, status);
      if (gated) return gated;
      const blocked = closedMonthResponse(property, date, status);
      if (blocked) return blocked;

      const by = identity!.email;
      const event = createDepositEvent(property, date, body as DepositEventInput, by);
      touchSheetDay(property, date, by);
      enqueueAnalyticsPush(property, date);
      return status(201, event);
    },
    {
      body: t.Object({
        kind: t.String(),
        bookingNo: t.Optional(t.Union([t.String(), t.Null()])),
        guestName: t.Optional(t.Union([t.String(), t.Null()])),
        tender: t.String(),
        amountSatang: t.Number(),
        note: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  // 28. PATCH /api/:property/deposits/:id
  .patch(
    "/:property/deposits/:id",
    ({ params, body, identity, status }) => {
      const { property } = params;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      const id = Number(params.id);
      if (!Number.isInteger(id)) return status(404, { error: "deposit event not found" });
      const existing = getDepositEventById(property, id);
      if (!existing) return status(404, { error: "deposit event not found" });
      const invalid = validateDepositEventInput(body);
      if (invalid) return status(400, { error: invalid });
      const gated = preCutoverResponse(property, existing.date, status);
      if (gated) return gated;
      const blocked = closedMonthResponse(property, existing.date, status);
      if (blocked) return blocked;

      const by = identity!.email;
      const updated = updateDepositEvent(property, id, body as DepositEventInput, by);
      if (!updated) return status(404, { error: "deposit event not found" });
      touchSheetDay(property, updated.date, by);
      enqueueAnalyticsPush(property, updated.date);
      return updated;
    },
    {
      body: t.Object({
        kind: t.Optional(t.String()),
        bookingNo: t.Optional(t.Union([t.String(), t.Null()])),
        guestName: t.Optional(t.Union([t.String(), t.Null()])),
        tender: t.Optional(t.String()),
        amountSatang: t.Optional(t.Number()),
        note: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  // 29. DELETE /api/:property/deposits/:id
  .delete("/:property/deposits/:id", ({ params, identity, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    const id = Number(params.id);
    if (!Number.isInteger(id)) return status(404, { error: "deposit event not found" });
    const existing = getDepositEventById(property, id);
    if (!existing) return status(404, { error: "deposit event not found" });
    const gated = preCutoverResponse(property, existing.date, status);
    if (gated) return gated;
    const blocked = closedMonthResponse(property, existing.date, status);
    if (blocked) return blocked;

    deleteDepositEvent(property, id);
    touchSheetDay(property, existing.date, identity!.email);
    enqueueAnalyticsPush(property, existing.date);
    return status(204);
  })

  // 30. GET /api/:property/deposits/register — the office deposit register
  // (Wave D, issue #5 / the R015834-style reconciliation requirement). A
  // SEPARATE, direct-to-PMS code path — queries the property's FULL
  // deposit-lifecycle history (src/server/deposit-register.ts), independent
  // of Wave C's importer or the accrual cutover (a pre-cutover deposit can
  // still show up here; there is nothing to gate — this endpoint never
  // writes). Same dark-by-default gate as endpoint 26: 503 when this
  // property's PMS env URL is unset, 502 on a live query failure, nothing
  // returned on either. Notes (deposit_notes) are merged onto BOTH the
  // aging rows and the exceptions rows — a thread can be aging (still
  // outstanding) and flagged mismatched at once, and the office's note is
  // the same conversation either way.
  .get("/:property/deposits/register", async ({ params, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!pmsConfigured(property)) return status(503, { error: "pms prefill not configured" });

    let register: Awaited<ReturnType<typeof fetchDepositRegister>>;
    try {
      register = await fetchDepositRegister(property);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return status(502, { error: message });
    }

    const notes = listDepositNotes(property);
    const noteByR = new Map(notes.map((n) => [n.rNumber, n]));
    const noteFields = (rNumber: string) => {
      const note = noteByR.get(rNumber);
      return { note: note?.note ?? null, resolvedAt: note?.resolvedAt ?? null, resolvedBy: note?.resolvedBy ?? null };
    };

    const aging = register.threads
      .filter((t) => t.outstandingSatang > 0)
      .sort((a, b) => (a.firstEventDate ?? "").localeCompare(b.firstEventDate ?? ""))
      .map((t) => ({
        rNumber: t.rNumber,
        receivedSatang: t.receivedSatang,
        appliedSatang: t.appliedSatang,
        refundedSatang: t.refundedSatang,
        outstandingSatang: t.outstandingSatang,
        firstEventDate: t.firstEventDate,
        ...noteFields(t.rNumber),
      }));

    const { mismatched, orphanApplied } = buildDepositExceptions(register.threads);
    const exceptions = {
      mismatched: mismatched.map((m) => ({ ...m, ...noteFields(m.rNumber) })),
      orphanApplied: orphanApplied.map((o) => ({ ...o, ...noteFields(o.rNumber) })),
    };

    return {
      property,
      generatedAt: new Date().toISOString(),
      monthly: register.monthly,
      aging,
      exceptions,
      unparsedAppliedRows: register.unparsedAppliedRows,
      // Review fix: three more tripwire counters alongside
      // unparsedAppliedRows, none of which invent or drop money — see
      // DepositRegisterData's doc comment (deposit-register.ts) for what
      // each one means. `voided` is now computed inside
      // buildDepositRegisterData itself (walking the flat event list, not
      // threads — see collectVoidedEvents' doc comment for why that fixes a
      // real gap), so this route just passes it through.
      zeroTenderRows: register.zeroTenderRows,
      blankBookingNoRows: register.blankBookingNoRows,
      undatedRows: register.undatedRows,
      voided: register.voided,
    };
  })

  // 31. PUT /api/:property/deposits/:rNumber/note — Wave D, D3. NOT
  // month-close gated (commentary rule, same as day notes/endpoint 9 and
  // the cash-block adjustment/endpoint 21) — a note against an R-number is
  // not a booking-day write, and the deposit itself may span several
  // months. The path param must match iHOTEL's fixed R-number shape; the
  // office reads it straight off this same page's rows, so a mismatch here
  // means a typo, not a legitimate different format.
  //
  // Elysia's route param is named `:id` here, NOT `:rNumber` — memoirist
  // (the underlying router) rejects two different parameter NAMES at the
  // same tree position (`/:property/deposits/:X`), and endpoints 28/29
  // already registered `:id` there for deposit_events. The URL text itself
  // is unaffected (the R-number still goes in that exact position); this
  // is purely an internal capture-group label.
  .put(
    "/:property/deposits/:id/note",
    ({ params, body, identity, status }) => {
      const { property } = params;
      const rNumber = params.id;
      if (!isProperty(property)) return status(400, { error: "invalid property" });
      if (!DEPOSIT_R_NUMBER_RE.test(rNumber)) return status(400, { error: "invalid rNumber" });
      if (body.note != null && !isValidBoundedString(body.note, DEPOSIT_NOTE_MAX_LEN)) {
        return status(400, { error: "invalid note" });
      }

      const saved = upsertDepositNote(property, rNumber, body.note ?? null, body.resolved, identity!.email);
      return saved;
    },
    { body: t.Object({ note: t.Union([t.String(), t.Null()]), resolved: t.Boolean() }) },
  )

  // 32. DELETE /api/:property/deposits/:rNumber/note (see the routing note above)
  .delete("/:property/deposits/:id/note", ({ params, status }) => {
    const { property } = params;
    const rNumber = params.id;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!DEPOSIT_R_NUMBER_RE.test(rNumber)) return status(400, { error: "invalid rNumber" });

    deleteDepositNote(property, rNumber);
    return status(204);
  })

  // 33. POST /api/:property/bookings/:id/accept-pms-update — Wave D, D5's
  // re-pull "accept" flow. No body. Re-fetches the day FRESH via
  // fetchDayPayments (never trusts a client-cached diff — the client only
  // ever showed a snapshot from the last pull-from-pms response). 404 for
  // a non-pms row (nothing to reconcile against); 409 if the month is
  // closed (reopen via the existing endpoint 24 first); 502 on a live PMS
  // query failure; 409 if the candidate has vanished from the ledger
  // entirely or has become a refund (the diff this row was accepting no
  // longer exists in the shape it was shown in). Applies via
  // applyPmsCandidateToBookingLine (db.ts) — merges only the PMS-written
  // tender fields into the row's CURRENT tenders, so hand-keyed
  // credit_icbc/transfer_icbc/other survive. Idempotent: calling this again
  // once nothing differs re-applies the same values and still succeeds.
  .post("/:property/bookings/:id/accept-pms-update", async ({ params, identity, status }) => {
    const { property } = params;
    if (!isProperty(property)) return status(400, { error: "invalid property" });
    if (!pmsConfigured(property)) return status(503, { error: "pms prefill not configured" });
    const id = Number(params.id);
    if (!Number.isInteger(id)) return status(404, { error: "booking line not found" });
    const existing = getBookingLineById(property, id);
    if (!existing || existing.source !== "pms") return status(404, { error: "booking line not found" });
    const pmsRef = getBookingLinePmsRef(property, id);
    if (pmsRef === null) return status(404, { error: "booking line not found" });

    const blocked = closedMonthResponse(property, existing.date, status);
    if (blocked) return blocked;

    let bookingCandidates: PrefillCandidate[];
    try {
      ({ bookingCandidates } = await fetchDayPayments(property, existing.date));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return status(502, { error: message });
    }

    const candidate = bookingCandidates.find((c) => c.pmsRef === pmsRef);
    if (!candidate || candidate.isRefund) {
      return status(409, { error: "pms candidate no longer available (vanished or became a refund)" });
    }

    // Same F1 pre-cutover guard as endpoint 26 — a ตัดยอดล่วงหน้า applied
    // amount must never be (re-)written for a date before this property's
    // accrual cutover, or it would double-count against the OLD rule's
    // already-booked income (docs/adr/0001).
    const accrual = isAccrualDay(property, existing.date);
    const effectiveCandidate: PrefillCandidate = accrual
      ? candidate
      : { ...candidate, appliedDepositSatang: 0, appliedDepositBookingNos: [] };

    const updated = applyPmsCandidateToBookingLine(property, id, effectiveCandidate, identity!.email);
    if (!updated) return status(404, { error: "booking line not found" });

    touchSheetDay(property, existing.date, identity!.email);
    enqueueAnalyticsPush(property, existing.date);
    return updated;
  });

const apiFetch = (req: Request) => api.handle(req);

// GET /healthz lives OUTSIDE /api, needs no auth, and never touches the DB
// (the deploy shim only allows 15 attempts x 2s) — see src/shared/api.md.
const healthz = () => Response.json({ ok: true });

if (isProd) {
  // ────────────────────────────────────────────────────────────────────
  // Production: serve precompiled client from ./dist/client/
  // ────────────────────────────────────────────────────────────────────
  const distDir = join(process.cwd(), "dist", "client");
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) {
    console.error(`[fatal] missing ${indexPath}. Run \`bun run build\` first.`);
    process.exit(1);
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") return healthz();
      if (url.pathname.startsWith("/api/")) return apiFetch(req);

      // Try a real file in dist/client
      const filePath = url.pathname === "/" ? indexPath : join(distDir, url.pathname);
      // Prevent path traversal: ensure resolved file is inside distDir
      if (!filePath.startsWith(distDir)) return new Response("nope", { status: 400 });

      const f = Bun.file(filePath);
      if (await f.exists()) {
        // Chunk names are content-hashed, so a chunk's bytes can never change
        // under its URL — cache forever. index.html (and anything unhashed)
        // must revalidate so a deploy is picked up on the next load. This is
        // most of the kiosk's reload weight: without it every open re-fetched
        // the whole bundle.
        const immutable = /-[a-z0-9]{6,}\.[a-z.]+$/i.test(url.pathname);
        const headers: Record<string, string> = {
          "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          vary: "Accept-Encoding",
        };
        // The build precompresses text assets; hand the .gz over when the
        // client accepts it (~1.6MB JS -> ~400KB on the wire), keeping the
        // original file's content-type.
        const gz = Bun.file(filePath + ".gz");
        if (/gzip/i.test(req.headers.get("accept-encoding") ?? "") && (await gz.exists())) {
          headers["content-encoding"] = "gzip";
          headers["content-type"] = f.type;
          return new Response(gz, { headers });
        }
        return new Response(f, { headers });
      }

      // A missing path that looks like an asset (has a file extension) is a
      // real 404 — e.g. a stale client asking for a chunk a newer deploy
      // purged. Only HTML-ish navigations (no extension) get the SPA shell.
      if (ASSET_PATH_RE.test(url.pathname)) {
        return new Response("not found", { status: 404 });
      }

      // SPA fallback for /:property/day/:date, /:property/history, etc.
      return new Response(Bun.file(indexPath), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    },
  });
  console.log(`▶︎ http://localhost:${server.port} (prod)`);
} else {
  // ────────────────────────────────────────────────────────────────────
  // Dev: HTML import lets Bun bundle the React client on the fly with HMR.
  // The Tailwind plugin is registered through bunfig.toml's
  // [serve.static.plugins] (it cannot be globally preloaded).
  // ────────────────────────────────────────────────────────────────────
  const indexHtml = (await import("../client/index.html")).default;
  const server = Bun.serve({
    port,
    development: true,
    routes: {
      "/": indexHtml,
      "/:property/day/:date": indexHtml,
      "/:property/bookings/:date": indexHtml,
      "/:property/history": indexHtml,
      "/:property/categories": indexHtml,
      "/:property/deposits": indexHtml,
      "/:property/report/:date": indexHtml,
      "/healthz": healthz,
      "/api/*": (req) => apiFetch(req),
    },
  });
  console.log(`▶︎ http://localhost:${server.port} (dev)`);
}
