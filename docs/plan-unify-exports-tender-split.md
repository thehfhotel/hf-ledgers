# Plan — unified export layout, tender-split inputs, name completeness (2026-07-31)

Living plan, updated by the overseeing session as agents report. Owner decisions in ALL CAPS
are binding.

## 1. ONE LAYOUT FOR ALL THREE EXPORTS (print / PDF / JPEG) — Wave A

The JPEG export (ReportPage) still renders the classic layout with the expense box. OWNER:
THE EXPENSE SECTION IS GONE EVERYWHERE; all three exports use the new tender-grouped layout.

- ReportSheet's full variant replaces IncomeExpenseSummaryCard + CashSummaryCard with the same
  grouped summary the print uses (groups, shaded tender totals, bold day total, override rows,
  bank line, mixed-tender footnote, weekly chart), keeping the bookings grid above it.
- One-line title everywhere for consistency.
- ReportPage gains the same weekDays fetch DaySheetPage has.
- Blocks that lose their last consumer are deleted, not left dead.
- Status: DONE (agent report + oversight review) — shipped pending Wave B review.

## 2. SPLIT THE MIXED โอน/เครดิต INPUTS — Wave B (after Wave A lands; touches shared types)

The paper's mixed categories (มัดจำล่วงหน้า, รายการอื่นๆ โอน/เครดิต, บาร์น้ำ โอน/เครดิต)
combine two tenders at ENTRY time. OWNER: SEPARATE THEM AT INPUT.

Rails for the implementing agent:
- Existing keys (deposit, other_transfer, bar_transfer) become โอน-only going forward: rename
  their name_th to โอน wording. Historical data stays under them untouched (it was mixed; no
  retro-split is possible — the print's footnote covers history).
- Add three new CategoryKeys + seeded categories per property: deposit_credit, other_credit,
  bar_credit (เครดิต wording). Additive boot migration in db.ts (backfillCategoryKeys pattern —
  seedIfEmpty won't run on non-empty DBs).
- Ripples that MUST be updated together: CategoryKey union (shared/types.ts), the print
  grouping KEY_TO_GROUP (new keys → card group; compile-guard forces this), rollup.ts,
  TENDER_TO_CATEGORY_KEY / fill-from-bookings mapping, importer expectations, day-sheet input
  rendering order.
- RESEARCH FIRST: whether hf-analytics' ingest tolerates new keys in the rollup payload or
  needs a coordinated change (income_daily_tenders is an eleven-way split today). If the
  receiving side needs work, ship the ledger side dark-compatible and flag.
- RESEARCH DONE (2026-07-31): NOT dark-compatible — worse, it's a stall bug. hf-analytics'
  ingest schema silently STRIPS unknown amount keys (Elysia Value.Clean, no 4xx), then its
  strict footing check (sum(amounts)+uncategorized === totalSatang) throws → 500; the ledger's
  outbox marks-and-breaks on the failing row every 30s tick, head-of-line-blocking ALL
  analytics pushes for every property/day. income_daily_tenders is a wide table (one column
  per key); no downstream dashboard consumer exists yet.
- SEQUENCING (binding): hf-analytics ships FIRST — additive migration 014 (three
  *_satang NOT NULL DEFAULT 0 columns) + categoryKeys/amountsSchema/INSERT/ON CONFLICT lists
  in src/server/sources/income-ledger.ts (footing check self-corrects; it iterates
  categoryKeys). Verify live, THEN implement the ledger-side split. Never the reverse.
- Opus money-review before ship (same bar as the print rework).
- Status: implemented (14 keys, additive rename-only migration, both seed paths proven
  byte-identical) + reviewed. VERDICT: SHIP-WITH-FIXES — F1 prod collision query ran CLEAN;
  F2 migration collision guard (skip-and-log, never throw — a colliding manager-created name
  must not crash-loop the container); F3 deposit double-entry warning (fill-from-bookings
  writes the whole merged t_deposit into the โอน cell; per-category manual-skip does not
  protect it); F4 other-income double-entry guard (itemized non-cash items land in the
  computed โอน cell while other_credit is free-typed — same receipt bookable twice);
  F5 api.md contract update to 14 keys; F6 migration-test gaps (amounts survive, legacy
  pre-assert, collision test). t_deposit split filed as income-ledger issue #1. Reviewer
  also asked: eyeball one day print/JPEG post-deploy (14 income lines shrink the fit scale).

## 3. DEPOSIT > INCOME MISMATCH — NO WORK (owner accepted)

Cash leftover accumulates across days and can legitimately bump the deposit above the day's
income. Not a bug. The print's ตรวจสอบ warning only covers grouped-sum-vs-total, which is
unaffected.

## 4. INVESTIGATE: hfville missing เงินโอน 1,250 for ประภัสสร — Wave A (Opus)

ค่าห้อง 2,500; เงินสด 1,250 recorded; the iHOTEL-app report shows another 1,250 as เงินโอน.
Question: is that transfer in our PMS mirror / in iHOTEL at all — our sync bug, our prefill
mapping bug, or a reception entry difference?

Leads for the investigator: (a) search hotelville's ht_payment_ledger by guest/amount/date
window; (b) the tender-replication dedup could hide a second payment sharing a Pay_no;
(c) iHOTEL has a SEPARATE petty-cash ledger (TB_Pay_History → ht_cash_ledger mirror) whose
entries appear in iHOTEL reports but are NOT folio payments — a payment recorded there would
explain "in the iHOTEL report but not in folio prefill"; (d) HF Ville's folio mirror was
exactly converged on 2026-07-28, so mirror ≈ iHOTEL for folio lines.
- Status: reported — see findings appended below when complete.

### STATUS (fix shipped, 2026-07-31)

**Verdict: our bug, not iHOTEL's.** `mapLedgerRows()` in `pms-prefill.ts` computed the transfer
amount correctly all along (`PrefillCandidate.unplacedTranSatang`); `insertPmsBookingLines()` in
`db.ts` simply never wrote it anywhere — only cash/web/deposit were mapped to columns. The
ประภัสสร payment (ค่าห้อง 2,500 / เงินสด 1,250 / เงินโอน 1,250) is exactly this shape, and 12 of
the 17 PMS-inserted rows ever written are short by precisely their `ledger_tran`. Fixed by
writing `unplacedTranSatang → transfer_kbank` on every property (evidence: `t_transfer_icbc` is 0
across all 6,024 historical booking lines on both properties — every transfer ever recorded is
โอน/กสิกร) and `unplacedCreditSatang → credit_kbank` on hfville only (its credit history is
single-bank; hf genuinely uses two credit banks and still reports that amount as `unplaced` for
hand-placement). See `insertPmsBookingLines`'s AUTO-PLACEMENT POLICY docblock in `db.ts` and the
updated `pull-from-pms` section of `src/shared/api.md`.

**Outstanding: backfill.** The 15,777 THB missing across those 12 rows (hfville 2026-07-24 and
2026-07-30) is NOT auto-corrected by this fix — it only changes behavior for future pulls.
Existing short rows stay short until someone reconciles them. Owner still deciding between
delete-and-repull (re-running ดึงข้อมูล on the affected days after deleting the short PMS-sourced
rows — safe because the pull is insert-only/idempotent per `pms_ref`) vs. hand-keying the missing
transfer amounts directly into the affected rows' bank columns.

**Oversight addendum (pre-ship review).** Making transfer/credit *written* columns exposed a
mixed-sign gap: `mapLedgerRows`'s `anyWrittenTenderNegative` guard only covered cash/web/deposit,
so a net-positive payment with a negative `ledger_tran` would have crashed the insert against
`t_transfer_kbank`'s CHECK(>= 0). Guard extended to all five written fields (property-agnostic —
a negative hf credit is safer counted as refund-like than inserted short), with two regression
tests. Owner confirmed the policy in-session: default to กสิกร, reception audits via the
"ตรวจสอบธนาคารด้วย" listing and corrects in the sheet.

**Side finding, flagged, not investigated further here.** hfville's `ht_cash_ledger` mirror table
(the petty-cash ledger separate from folio payments, per lead (c) above) is empty on our side —
an upstream mirror gap. Not the cause of this particular bug (this payment was a folio payment,
confirmed present in `ht_payment_ledger`), but worth a separate look since any real petty-cash
activity recorded only in iHOTEL's own `TB_Pay_History` would currently be invisible to us.

## 5. ดึงข้อมูล NAMES: prefix + first + last — Wave A (Sonnet)

Only the first name imports today. Include นาย/น.ส./Mr etc. and the last name.
- First establish from the real schema which ht_customers columns hold prefix/title and how
  names are actually distributed (lastname may be empty with full name in firstname).
- Update LEDGER_QUERY + mapping + tests.
- New columns need ledger_ro column-level GRANTs in both DBs — applied at ship via a
  delegated agent with verbatim SQL (names only; never ID/passport columns).
- Status: DONE. Data reality established live (HF surnames live in `cust_name2` ~55%,
  `cust_lastname` dead at HF; hfville uses `cust_lastname` properly; `cust_title` is a clean
  separate token glued WITHOUT a space, e.g. นายสมชาย). `buildGuestName(prefix, first,
  last ?? name2)` shipped; GRANTs applied AND fence-verified in both DBs (name columns readable
  as ledger_ro, `cust_idcard` still permission-denied).

## Shipping discipline

Multiple agent sessions share this repo. Every ship stages ONLY the files this plan owns,
never `git add -A`. CI on the pushed commit is the authoritative gate.
