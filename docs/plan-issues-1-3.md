# Plan — issues #1–#4 (2026-07-31)

Product of a design interview with the owner. Decisions are recorded in `docs/adr/0001` and the
glossary in `CONTEXT.md`; this file is the build plan. Nothing here is started until the owner
confirms shared understanding.

Ship order is deliberate: A and B are small, independent, and carry no accounting risk. C changes
what a number on every printed sheet MEANS, so it ships alone, after its own review.

---

## Wave A — issue #3, print pagination (small, no risk)

Chromium paginates on an element's PRE-transform height, so a tall day still spills to a second
page however far `transform: scale()` shrinks it. Settled by direct experiment (headless Chromium
151, print-to-PDF, page counts by `pdfinfo`):

- transform alone: 2 pages at every scale tried, including 0.5 — confirms the premise unconditionally.
- transform + an outer container sized `naturalSize × scale` with `overflow: hidden`: **1 page**, in
  both the height-bound day-summary geometry and the width-bound bookings geometry, no clipping.
- CSS `zoom` (the obvious alternative): still 2 pages at the same scale. Rejected on evidence.

Build: the clamp container goes in the shared `usePrintExport` hook so both callers get it; one
wrapper div each in `DaySheetPage` and `BookingDayPage`. No scale floor — `computeFitScale` stays
the pagination authority, a heavier day simply prints smaller.

Verification: real พิมพ์ path to print-to-PDF on the seeded stress day must be exactly 1 page
(owner directive: the actual print function is the primary evidence, not node screenshots).

## Wave B — issue #2, derived cash (tiny, close a latent gap)

Production evidence: **the defect has never occurred.** Zero income cells anywhere carry a typed
`other_cash` value, zero custom cash categories exist, and 86% of days carry an explicit banked
override that wins over any derivation regardless. So this is a latent trap, not a live bug, and
no historical figure moves when it is fixed.

Build: `deriveCashBlock`'s other-cash term falls back to the typed cell when the day has no
itemized rows (mirroring `getEffectiveIncomeForDay`'s own items-else-cell rule), and the room/other/bar
selection generalises from three hardcoded keys to `category.isCash` — which the seed already makes
the source of truth for exactly those three.

Explicitly NOT built: the freeze/snapshot mechanism discussed during the interview. It was scoped
against a premise the data disproved (that history would shift). Revisit only if a custom cash
category is ever created and backdated into a closed month.

## Wave C — issues #1 and #4, deposits on an accrual basis (large; ships alone)

See `docs/adr/0001`. Reception never touches this app; iHOTEL captures both moments and we read them.

### What iHOTEL gives us (verified live, owner test 2026-07-31)

| Event | Row shape | Meaning under accrual |
|---|---|---|
| Received | `ds_name = 'จ่ายล่วงหน้า'`, tender in the normal column, `ledger_cin_no` = `book_no` | Money in. **Not income.** |
| Applied | `ds_name LIKE 'ตัดยอดล่วงหน้า Booking No:%'`, amount in **`ledger_free`**, `ledger_cin_no` = the CH26 check-in | **Income.** No money in. |

Voided rows carry `ledger_status = 'ยกเลิก'`; `book_deposit_amount` on the booking header is left
stale after a void, so the payment ledger is the only trustworthy source. `book_deposit_date` is
not populated — use `ledger_pay_date`.

### Build

1. **Importer** (issue #4): fix `DEPOSIT_MARKER` (`เงินจอง` matches 0 of 5,714 rows; the real labels
   are the two above); select `ledger_free`, `ledger_status`, `ledger_note`; filter voided rows;
   emit the two event types as distinct things. Rebuild fixtures from the real six-value vocabulary
   — the current ones invent a label that does not exist, which is why nothing caught this.
2. **Categories**: add `มัดจำล่วงหน้า เงินสด`. The Wave-B split shipped only โอน and เครดิต, but a
   deposit arrives by any tender and a cash one enters the till.
3. **Recognition**: received deposits leave `incomeSatang`; applied deposits enter it. The cash block
   must still count a cash deposit received, so it can no longer be derived purely from income cells
   — this is the structural heart of the change.
4. **Print**: received deposits need a place on the sheet that is visibly not part of
   `รวมรายรับทั้งวัน`; applied deposits appear as revenue. Wording to be designed, not guessed.
5. **Analytics**: `totalSatang` changes meaning at the cutover, and the ingest rejects payloads whose
   parts do not foot to the total. Coordinate the receiving side FIRST, as with the โอน/เครดิต split.
6. **Cleanup**: the booking-grid `deposit` tender and the day-sheet double-entry warning both become
   obsolete once reception's deposits arrive via the PMS. Retire deliberately, not silently.

### Risks

- This redefines the headline number on every sheet. Historical days are explicitly not restated
  (owner decision), so the series has a discontinuity at the cutover date that must be documented
  where the accountant will see it.
- `รวมรายรับทั้งวัน` and the banked figure stop reconciling by construction. That is intended, but it
  removes a cross-check the office may currently rely on.
- Opus money-review before ship, same bar as the โอน/เครดิต split.

## Wave D — office control (issue #5, and the deposit reconciliation)

Raised by the owner: "how can office make sure that the deposit usage is correct?" Two layers, and
the second is not deposit-specific.

**Deposit reconciliation.** Opening held + received − applied − refunded = closing held, with an
aging list of unapplied deposits and two exception lists: applications whose amount does not match
their receipt, and applications with no receipt at all. Feasible — the applied row's label is
system-templated (`ตัดยอดล่วงหน้า Booking No:R` + 6 digits, identical across every example on both
properties), so the join is exact, not a free-text parse. Deposits never migrate between bookings
(owner: the booking is moved, not replaced), so an R-number pairs for life. Must query the PMS
directly for all history — the ledger's day-scoped, opt-in imports are incomplete by construction.

Justified by evidence, not theory: iHOTEL does not enforce that an applied amount matches what was
received. In the owner's own test batch, R015834 received 395.00 and applied 790.00. Owner
explanation (2026-07-31): that gap comes from a **reception manual override in iHOTEL, which cannot
be blocked upstream**. So the requirement is not prevention — it is detection plus explanation: the
office must be able to see the unexplained 395 increase and the 790 applied against a 395 receipt,
and **record a reason or note against it**. That makes this a small stateful workflow, not a
read-only report — annotations must persist somewhere.

**Upstream corrections (issue #5) — rescoped by the owner, not a detection problem.** The mirror is
rewritten destructively per folio on any touch, and this app imports once and never re-reads. But
operationally that is already covered: reception has a duty to report changes to the office, the
office manually updates the ledger, and the office closes out *yesterday* while observable drift
happens on the *current* shift. So the requirement is not automatic detection — it is that the
office can identify and correct a payment when reception reports it.

The real gap is that a re-pull is silent: an existing `pms_ref` is skipped whether its amount
changed or not. Fix is small — on ดึงข้อมูล, surface a differing row as a diff the office can
accept ("PMS now says 1,200, you have 1,000"), never auto-overwriting, so hand edits stay sacred.
Plus confirm a closed month can be reopened as a safety valve. Enabling the upstream probe is
optional observability, not a prerequisite.

**Where it lives — DECIDED:** an office page in this app. The office must record reasons against
exceptions (owner: the 395/790 gap comes from a reception manual override that cannot be blocked
upstream), and notes have to persist somewhere — which rules out a stateless hf-mcp tool on its own.

## Not doing

A deposit register in this app, a separate reception deposit app, first-class deposit capture in
new-hotel, a booking-line deposit column split, and any expiry/forfeiture rule — each ruled out
during the interview for reasons recorded in `docs/adr/0001`.
