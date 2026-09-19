// AP register ("ค้างจ่าย") wire types + pure domain functions — see
// docs/ap-tab-spec (design spec) for the full UX rationale. Money is integer
// satang, dates are Bangkok calendar ISO "YYYY-MM-DD" strings, same
// conventions as src/shared/types.ts. This file has no side effects and only
// imports other shared/ modules, so client and server share the EXACT same
// arithmetic/status/derivation logic — never re-derived differently in two
// places (spec §9: "grossSatang and outstandingSatang are computed
// server-side and sent ... the client recomputes only for the live preview
// inside the drawer").

import type { ExpenseCategoryCode } from "./categories.ts";
import { shiftDays } from "@shared/date.ts";
import type { ExpensePhoto, PaymentMethod } from "./types.ts";

export type ApPaymentKind = "deposit" | "installment" | "full";

/** One recorded payment against an ApRow. `transactionId` is the id of the
 * ordinary expense transaction this payment posted through the engine
 * (orchestrator ruling #3) — undo (DELETE .../payments/:pid) deletes exactly
 * that transaction, never a re-derived one. */
export interface ApPayment {
  id: string;
  date: string;
  amountSatang: number;
  paymentMethod: PaymentMethod;
  kind: ApPaymentKind;
  /** Set only when kind === "installment" (1-based, counted from the first
   * partial AFTER the deposit) — see derivePaymentKind. */
  installmentNumber: number | null;
  payerEmail: string;
  transactionId: string;
}

export interface ApRow {
  /** Read-only net payroll batch. Paid only after the bank verifies settlement. */
  payroll?: { runId: string; period: string; effectiveDate: string; employeeCount: number; status: string; error: boolean; paidDate: string | null };
  /** Read-only receipt sourced from reimbursement. Payment follows its request. */
  reimbursement?: { receiptId: string; bundleId: string; requestName: string; purchaseDate: string; note: string; status: string; error: boolean };
  id: string;
  creditor: string;
  item: string;
  amountSatang: number;
  vatSatang: number | null;
  whtSatang: number | null;
  discountSatang: number;
  dueDate: string | null;
  entity: string;
  /** RULING 1 (2026-07): optional — a row can be filed before its category
   * is known (an explicit "ไม่ระบุหมวด" state, never a hidden default; see
   * src/client/components/ApRowDrawer.tsx). A PAYMENT against the row still
   * always needs a real category (every engine transaction must have one) —
   * see paymentNeedsCategoryPicker below and src/server/server.ts's payment
   * route, which requires and persists one back onto the row the first time
   * it's paid. */
  categoryCode: ExpenseCategoryCode | null;
  note: string;
  /** ISO 8601 datetime (UTC, not just a date) — used ONLY as the final
   * insertion-order sort tiebreaker (ApPage.tsx's sortRows). M1 fix: the
   * month-filter fallback used to slice THIS field, which put a row created
   * 00:00-07:00 Bangkok on the 1st into the previous month (UTC's calendar
   * date at that moment is still the prior month's last day); that fallback
   * now runs server-side against apStore.ts's own `filed_date` (a Bangkok
   * calendar date), which this interface never needs to expose. */
  createdAt: string;
  createdBy: string;
  /** วันที่ลงบิล — the date the accountant assigns this bill to, and THE
   * date this cost is recognised on (owner decision, 2026-09-19; see
   * CONTEXT.md's glossary and docs/adr/0001-cost-recognised-in-its-period.md).
   * Bangkok calendar "YYYY-MM-DD"; its MONTH is the row's งวด, which is what
   * the analytics rollup (src/shared/rollup.ts) scopes `filed` /
   * `filedByEntity` / `filedBySource` by. Editable on a manual row (the
   * drawer's own field), defaulted to today at create time; a bill whose
   * span crosses a month boundary belongs to the month its span ENDS in
   * (PEA's own convention). Set by the syncs rather than the clerk on an
   * imported row: payroll → the last day of the batch's `period`,
   * reimbursement → the receipt's purchase date. NEVER conflate with
   * `filedDate` below, which is when the bill was ENTERED and is record
   * metadata only. */
  billDate: string;
  /** วันที่ยื่นบิล — Bangkok calendar "YYYY-MM-DD" this row was FILED into
   * the register (src/server/apStore.ts's `filed_date` column,
   * todayBangkok() at create time — never changes after that). Distinct
   * from `billDate` above (the cost's own date, editable), from `dueDate`
   * (กำหนดชำระ, clerk-entered, can be edited) and from `createdAt` (a full
   * UTC timestamp, wrong for month-grouping near a Bangkok midnight — see
   * apStore.ts's filed_date column comment). RECORD METADATA, never the
   * cost's date (ADR-0001): the rollup stopped scoping by this field on
   * 2026-09-19 and now scopes by `billDate`. */
  filedDate: string;
  /** The newest payment's date once outstanding <= 0, else null — the
   * "จ่ายแล้ว {date}" label (spec §3, §6). Computed at read time from
   * `payments`, never stored, so it can never drift from what it summarizes
   * — see deriveSettledAt. */
  settledAt: string | null;
  /** = amountSatang + (vatSatang ?? 0) - (whtSatang ?? 0), computed
   * server-side and sent — never re-derived differently in two places. */
  grossSatang: number;
  /** = grossSatang - Σ payments - discountSatang, computed server-side. */
  outstandingSatang: number;
  payments: ApPayment[];
  /** Bill/invoice photos attached to this row (src/server/apStore.ts's
   * ap_photo table) — independent of payment state, unlike `payments`. Same
   * `{id, url}` wire shape as an ExpenseTransaction's own `photos` (the
   * entry-page receipt photos), reused rather than duplicated since both
   * are just "an id plus a URL the browser can GET the bytes from". */
  photos: ExpensePhoto[];
}

export type ApFilterMode = "open" | "all" | "month";

export interface ApListFilter {
  mode: ApFilterMode;
  /** Present only when mode === "month" (validated "YYYY-MM"). */
  month?: string;
}

/** Server-supplied autocomplete hint: the most recent row filed under this
 * creditor, so picking a known creditor can prefill หมวดค่าใช้จ่าย/ในนาม
 * (spec §4 item 1). */
export interface ApCreditorHint {
  creditor: string;
  categoryCode: ExpenseCategoryCode | null;
  entity: string;
}

export interface ApSummary {
  totalOutstandingSatang: number;
  overdueCount: number;
}

/** GET /api/ap/rows response (spec §9). */
export interface ApRowsResponse {
  payrollSync?: { enabled: boolean; since?: string | null; lastSuccess?: string | null; error?: string | null; runs?: number; issues?: number };
  reimbursementSync?: { enabled: boolean; since?: string | null; lastSuccess?: string | null; error?: string | null; receipts?: number; issues?: number };
  rows: ApRow[];
  summary: ApSummary;
  creditors: ApCreditorHint[];
}

/** Body shared by POST /api/ap/rows and PATCH /api/ap/rows/:id. */
export interface ApRowInput {
  creditor: string;
  item: string;
  amountSatang: number;
  vatSatang: number | null;
  whtSatang: number | null;
  discountSatang: number;
  dueDate: string | null;
  entity: string;
  categoryCode: ExpenseCategoryCode | null;
  note: string;
  /** วันที่ลงบิล — REQUIRED on every write path, so the งวด a cost lands in
   * is always an explicit decision rather than a fallback nobody chose
   * (ADR-0001). The HTTP layer fills it with today's Bangkok date when a
   * body omits it (src/server/server.ts's validateApRowInput), the syncs
   * derive it from the source document (payroll period / purchase date),
   * and the drawer sends whatever the accountant picked. */
  billDate: string;
}

export interface ApPaymentInput {
  date: string;
  amountSatang: number;
  paymentMethod: PaymentMethod;
  /** RULING 1: required ONLY when the row being paid currently has a null
   * categoryCode — the server re-derives whether it's required from the
   * row's own state (never trusts a client-sent flag) and, when supplied,
   * persists it back onto the row inside the same write-lock critical
   * section as the payment insert. Omitted/ignored when the row already has
   * a category. */
  categoryCode?: ExpenseCategoryCode;
}

export interface CreateApRowResponse {
  id: string;
}

export interface CreateApPaymentResponse {
  paymentId: string;
  transactionId: string;
  /** L1 fix: the categoryCode the payment ACTUALLY posted under (the row's
   * pre-existing category, or the one this request just supplied and had
   * persisted) — the client uses this directly for its confirmation text
   * instead of re-deriving it, which used to risk showing a different value
   * than what the server actually recorded. */
  categoryCode: ExpenseCategoryCode;
}

// ── ในนาม ("บิลของที่ไหน") entity picker (CL-6) ─────────────────────────

/** The fixed 3-way picker src/client/components/ApRowDrawer.tsx renders for
 * `entity`, replacing the free-text input that let real rows drift across
 * ~8 spellings (HF, HF Ville, บจก.สายชล เฮอริเทจ, ...HF-VILLE, a bare
 * vendor name, empty, รวมทุกโรงแรม — confirmed against a fresh production
 * ap.db copy 2026-09-17). Payroll/reimbursement rows are read-only and
 * never go through this picker (src/server/payroll-sync.ts /
 * reimbursement-sync.ts set `entity` directly), but they already write one
 * of AP_ENTITY_CANONICAL's exact strings, so they normalize the same way. */
export type ApEntityChoice = "hf" | "hfville" | "all";

/** Canonical string this app WRITES into ap_row.entity for each picker
 * choice — chosen to match what payroll-sync.ts ('รวมทุกโรงแรม') and
 * reimbursement-sync.ts ('HF' / 'HF Ville') already write, so a manually
 * picked row and a synced row land on the exact same spelling instead of
 * this picker adding a 4th/6th one. Never store a different string for
 * these 3 choices — apPage's register list and the syncs both rely on this
 * exact spelling. */
export const AP_ENTITY_CANONICAL: Record<ApEntityChoice, string> = {
  hf: "HF",
  hfville: "HF Ville",
  all: "รวมทุกโรงแรม",
};

/** Button labels for the fixed picker — deliberately friendlier than the
 * canonical STORED string above (hf stores "HF" but reads "HF Hotel" on
 * the button, matching this component's pre-picker convention). */
export const AP_ENTITY_PICKER_LABELS: Record<ApEntityChoice, string> = {
  hf: "HF Hotel",
  hfville: "HF Ville",
  all: "รวมทุกโรงแรม",
};

// ── วันที่ลงบิล (bill date) helpers ──────────────────────────────────────

/** The last calendar day of a "YYYY-MM" month, as an ISO "YYYY-MM-DD"
 * string. This is the วันที่ลงบิล rule for a bill that names a PERIOD
 * rather than a day — a payroll batch's `period`, and by extension any bill
 * whose span ends in that month (owner, 2026-09-19: "a bill spanning months
 * belongs to the month its span ENDS in"). Built on Date.UTC's own
 * day-0-is-the-previous-month's-last-day rollover rather than a leap-year
 * table, so February is right without a special case. */
export function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const d = new Date(Date.UTC(year!, monthNumber!, 0));
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Picker button order (ApRowDrawer's 3-column grid). */
export const AP_ENTITY_CHOICES: readonly ApEntityChoice[] = ["hf", "hfville", "all"];

/**
 * Maps free-text `entity` onto one of the picker's 3 fixed choices, or null
 * when it cannot be classified (ไม่ระบุ — the clerk is asked to pick one
 * explicitly; see ApRowDrawer's validate()). SAME "ville" / "hf|สายชล|hop"
 * substring rule, same order, as src/shared/rollup.ts's normalizeApEntity —
 * never let these two drift on that shared part of the rule. That function
 * is NOT reused directly here: it is separately locked to hf-analytics'
 * own 3-key wire contract (hf/hfville/unknown) and has no "all" concept, so
 * duplicating its exact rule here (rather than importing across that
 * boundary) keeps each side free to evolve its own third case without the
 * other's contract silently moving. This adds ONE extra branch rollup.ts
 * intentionally does not have: รวมทุกโรงแรม ("all hotels combined") is
 * payroll's literal entity string and a legitimate manual choice for a
 * shared/corporate bill — checked before the hf/ville branches only
 * because it happens not to overlap with them (no known entity string
 * matches more than one branch).
 */
export function normalizeApEntityChoice(entity: string): ApEntityChoice | null {
  const lower = entity.toLowerCase();
  if (lower.includes("ville")) return "hfville";
  if (entity.includes("รวมทุก")) return "all";
  if (lower.includes("hf") || lower.includes("สายชล") || lower.includes("hop")) return "hf";
  return null;
}

/**
 * What apStore.ts's createApRow/updateApRow persist for a given raw
 * `entity` input: the canonical spelling when it classifies under one of
 * the 3 picker choices (fixing drift on save, e.g. "...HF-VILLE" ->
 * "HF Ville"), otherwise the trimmed raw string unchanged (never forced
 * into a wrong bucket — a genuine vendor name like "SCM" or an empty
 * string stays exactly as filed, per the ruling: never rewrite existing
 * rows behind the clerk's back beyond what THIS save touches). Pulled out
 * as a pure function so apStore.ts's persistence call sites and this
 * file's tests share the exact same rule.
 */
export function normalizeApEntityForSave(entity: string): string {
  const choice = normalizeApEntityChoice(entity);
  return choice ? AP_ENTITY_CANONICAL[choice] : entity;
}

// ── Arithmetic ──────────────────────────────────────────────────────────

export function computeGross(amountSatang: number, vatSatang: number | null, whtSatang: number | null): number {
  return amountSatang + (vatSatang ?? 0) - (whtSatang ?? 0);
}

export function computeOutstanding(
  grossSatang: number,
  payments: readonly { amountSatang: number }[],
  discountSatang: number,
): number {
  const paid = payments.reduce((sum, p) => sum + p.amountSatang, 0);
  return grossSatang - paid - discountSatang;
}

/** The newest payment's date once outstanding <= 0, else null (spec §3, §6
 * "A row settled by an edit flips to จ่ายครบ with settledAt = the newest
 * payment's date"). Computed, never stored.
 *
 * H3 fix: a row can be settled with ZERO payments — a discount or WHT alone
 * brings outstanding to <= 0 at creation time (the credit-note case; create
 * only rejects outstanding < 0, never === 0, and that's deliberate — spec
 * §4). Such a row has no payment date to report, so this falls back to
 * `filedDate` (the row's own Bangkok filing date, src/server/apStore.ts's
 * `filed_date` column) instead of returning null — the previous null return
 * here is exactly what made ApPage.tsx's `isoToBuddhist(row.settledAt!)`
 * throw a white screen for these rows. `filedDate` is optional so existing
 * 2-arg callers (and this file's own tests) keep returning null when no
 * fallback is available. */
export function deriveSettledAt(
  payments: readonly { date: string }[],
  outstandingSatang: number,
  filedDate?: string,
): string | null {
  if (outstandingSatang > 0) return null;
  if (payments.length === 0) return filedDate ?? null;
  return payments.reduce((latest, p) => (p.date > latest ? p.date : latest), payments[0]!.date);
}

// ── Status derivation (spec §3 "Status derivation") ────────────────────────

export type ApStatus = "settled" | "overdue" | "dueSoon" | "open";

const STATUS_RANK: Record<ApStatus, number> = { overdue: 0, dueSoon: 1, open: 2, settled: 3 };

/** เกินกำหนด 0, ใกล้ครบกำหนด 1, ค้างจ่าย 2, จ่ายครบ 3 — the register's fixed
 * sort key (spec §3 "Overdue emphasis + sort"). */
export function statusRank(status: ApStatus): number {
  return STATUS_RANK[status];
}

/**
 * `today` and `dueDate` are Bangkok calendar ISO dates (packages/shared/src/date.ts).
 * Order matters: settled beats every date rule (a row can be both overdue by
 * date AND fully paid — settled wins), then overdue, then the 7-day
 * ใกล้ครบกำหนด window (inclusive both ends), else ค้างจ่าย — including a
 * blank due date, per the spec's table exactly.
 */
export function deriveStatus(dueDate: string | null, outstandingSatang: number, today: string): ApStatus {
  if (outstandingSatang <= 0) return "settled";
  if (dueDate === null) return "open";
  if (dueDate < today) return "overdue";
  if (dueDate <= shiftDays(today, 7)) return "dueSoon";
  return "open";
}

// ── Payment kind derivation (spec §5 "Payment kind is derived, never chosen") ─

export interface DerivedPaymentKind {
  kind: ApPaymentKind;
  installmentNumber: number | null;
}

/**
 * `settles` = whether THIS payment would bring outstanding to <= 0 — the
 * caller (src/server/server.ts) decides that from the row's current
 * outstanding balance and the amount being posted, never a client-chosen
 * kind. First partial -> มัดจำ; later partials -> งวดที่ N, N counted from 1
 * starting after the deposit (a settling payment is always "full" regardless
 * of what came before).
 */
export function derivePaymentKind(existingPayments: readonly ApPayment[], settles: boolean): DerivedPaymentKind {
  if (settles) return { kind: "full", installmentNumber: null };
  const hasDeposit = existingPayments.some((p) => p.kind === "deposit" || p.kind === "installment");
  if (!hasDeposit) return { kind: "deposit", installmentNumber: null };
  const installmentCount = existingPayments.filter((p) => p.kind === "installment").length;
  return { kind: "installment", installmentNumber: installmentCount + 1 };
}

// ── RULING 1: payment category requirement (2026-07) ────────────────────

/** Whether recording a payment against a row with this categoryCode must
 * collect a category from the clerk first — true iff the row itself has no
 * category yet. Shared so the client's ApPaymentForm (which decides whether
 * to render the 21-leaf CategoryPicker at all) and src/server/server.ts's
 * payment route (which decides whether to require/persist one) apply the
 * EXACT same rule, never two independently-drifting copies. A row that
 * already carries a category keeps the pre-ruling behavior — no picker, no
 * server-side requirement.
 *
 * M2 fix: this is the ONE place the payment-category-REQUIREMENT rule lives
 * — src/client/pages/ApPage.tsx's `categoryChipLabel` also branches on
 * `row.categoryCode` being null, but that is a DIFFERENT concern (what label
 * the register's chip displays), not whether a payment must collect one; it
 * deliberately does not call this helper, and should not start to.
 *
 * A `rowCategoryCode is null` type predicate (rather than a plain boolean)
 * so src/server/server.ts's payment route — which used to inline
 * `row.categoryCode === null` partly FOR the resulting `else` branch's
 * narrowing to a non-null ExpenseCategoryCode — keeps that same narrowing
 * after switching to call this helper instead. */
export function paymentNeedsCategoryPicker(rowCategoryCode: ExpenseCategoryCode | null): rowCategoryCode is null {
  return rowCategoryCode === null;
}

/** M3 fix: ApRowDrawer's creditor-hint prefill (spec §4 item 1, ADD mode
 * only) must never overwrite a category the clerk has already chosen, and
 * must never blank an already-chosen category just because the matched
 * creditor's most recent row happened to have none — the hint only applies
 * when there is NO current selection AND the hint itself is non-null.
 * Pulled out as a pure function so this rule is unit-testable without a
 * DOM/React harness (this repo has none for client components yet). */
export function resolveCreditorHintCategoryCode(
  current: ExpenseCategoryCode | null,
  hint: ExpenseCategoryCode | null,
): ExpenseCategoryCode | null {
  return current === null && hint !== null ? hint : current;
}

/** `ap:<rowId>` — the ezBookkeeping tag every posted payment for this row
 * carries (orchestrator ruling #3), mirroring scripts/import-workbook.ts's
 * `import:<YYYY-MM>` idempotency-tag pattern. Shared so both the poster
 * (src/server/engine.ts) and its tests use the exact same literal format. */
export function apTagName(rowId: string): string {
  return `ap:${rowId}`;
}

/** `" (มัดจำ)"` / `" (งวดที่ N)"` for a partial payment, `""` for a full
 * settlement — split out from buildApPaymentComment (L3 fix) so
 * src/server/server.ts's truncation step can shrink the "<creditor> -
 * <รายการ>" prefix ALONE to fit the engine's comment-length budget while
 * always keeping this marker intact. A generic end-trim would cut this
 * suffix first, since buildApPaymentComment appends it as the FINAL
 * characters — silently losing which installment a payment was. */
export function paymentKindSuffix(kind: ApPaymentKind, installmentNumber: number | null): string {
  return kind === "deposit" ? " (มัดจำ)" : kind === "installment" ? ` (งวดที่ ${installmentNumber})` : "";
}

/**
 * `"<ชื่อเจ้าหนี้> - <รายการ>"` suffixed `" (มัดจำ)"` / `" (งวดที่ N)"` for a
 * partial payment, plain for a full settlement (spec §5 "Ledger posting").
 * Truncation for the engine's comment-length budget happens server-side
 * (src/server/server.ts) — this only composes the ideal, untruncated text.
 */
export function buildApPaymentComment(
  creditor: string,
  item: string,
  kind: ApPaymentKind,
  installmentNumber: number | null,
): string {
  return `${creditor} - ${item}${paymentKindSuffix(kind, installmentNumber)}`;
}

// ── AP row photos ("รูปบิล") ────────────────────────────────────────────

/** `/api/ap/photos/<id>` — the stable URL a photo's DB id resolves to via
 * GET /api/ap/photos/:photoId (src/server/server.ts serves the bytes; the
 * path is resolved ONLY through a DB lookup there, never from anything
 * client-supplied). Shared so src/server/apStore.ts (building the
 * ApRow.photos it returns) never drifts from the route that actually serves
 * it. */
export function apPhotoUrl(photoId: string): string {
  return `/api/ap/photos/${photoId}`;
}

/** Whether — and what number — a register row's photo-count indicator
 * should show: null means "render nothing" (spec: "small photo-count
 * indicator when > 0", never a bare "0"). Pulled out as a pure function,
 * matching this codebase's existing convention for UI decision logic (see
 * resolveCreditorHintCategoryCode above) since there is no DOM/React test
 * harness for the components themselves yet. */
export function apRowPhotoCount(photos: readonly { id: string }[]): number | null {
  return photos.length > 0 ? photos.length : null;
}

/**
 * Filename extension (case-insensitive) -> canonical stored ext, or null when
 * unsupported. The ONE allow-list both the client's staging-time pre-check
 * (src/client/components/ApRowDrawer.tsx, BLOCKER 2 fix) and the server's
 * upload gate (src/server/apStore.ts's extForApPhotoFilename) apply — kept
 * here, shared, so neither side can silently drift from the other about what
 * "an accepted photo" means.
 *
 * BLOCKER 1 fix (2026-07): this is keyed on the FILENAME, never a
 * Blob/File's `type` — Bun's req.formData() (oven/bun 1.3.x, pinned in this
 * repo's Dockerfile) discards a multipart part's DECLARED Content-Type
 * entirely and instead synthesizes `file.type` from the filename's own
 * extension, LOWERCASE ONLY (confirmed directly against this exact Bun
 * version — a part named "IMG_0002.JPG" comes back with `file.type === ""`
 * regardless of what Content-Type the client declared). DCF cameras and
 * Windows scanners routinely emit uppercase extensions (IMG_0002.JPG,
 * scan.JPEG, DSC_0001.PNG), so gating on `file.type` 415'd every one of those
 * while silently accepting the exact same bytes under a lowercase name.
 * Deriving acceptance from the filename here instead, explicitly and
 * case-insensitively, pins it to logic this repo owns rather than an
 * incidental Bun implementation detail a future version could flip either
 * direction.
 *
 * RULING 3 (2026-07, owner decision): HEIC is deliberately NOT accepted —
 * browsers cannot render a stored HEIC file back to the clerk, and a
 * silently-broken bill photo is worse than a loud rejection at upload time.
 */
export function apPhotoExtForFilename(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return null;
  const rawExt = filename.slice(dot + 1).toLowerCase();
  if (rawExt === "jpg" || rawExt === "jpeg") return "jpg";
  if (rawExt === "png") return "png";
  if (rawExt === "webp") return "webp";
  return null;
}
