---
status: accepted
supersedes: the cash-book accounting rule recorded in src/shared/api.md (owner decision, 2026-07-30)
---

# Recognise income when the stay happens, not when a มัดจำล่วงหน้า is taken

On 2026-07-30 we recorded the opposite rule — an advance deposit counts as income on the day it
is taken, because it is half the booking's payment rather than money held on someone else's
behalf. On 2026-07-31 the owner reversed it deliberately: the daily book is the estate's
correction layer for accounting, so a มัดจำล่วงหน้า is money received but **not yet earned**, and
the stay's full charge is recognised on the stay's day. Reception's workflow will change to match;
historical days are explicitly out of scope and are not being restated.

## Consequences

- `รวมรายรับทั้งวัน` stops meaning "money received today" and starts meaning "revenue earned
  today". It therefore no longer reconciles with the bank by construction — the cash figure
  (ยอดฝากจริง) and the income figure become genuinely independent quantities, where today one is
  derived from the components of the other.
- A deposit still enters the till, so cash deposits must keep reaching ยอดฝากจริง while being
  excluded from income. The cash block can no longer be a view over "income cells that are cash".
- hf-analytics receives `totalSatang` per day and stores a fixed tender split; under accrual its
  historical series changes meaning at the cutover. Coordinating that is part of the work, not an
  afterthought (the ingest already rejects payloads whose parts do not foot to the total).
- Applying a deposit to its stay needs a reliable stay identifier. Our own `booking_no` is **not**
  one: of the 16 booking numbers appearing on more than one date since the import, all 16 are
  different guests colliding on the same string. This is moot for the chosen source, because
  iHOTEL supplies its own key (see below), but it still rules out any design that links deposits
  using the ledger's own booking numbers.

## Lifecycle

A มัดจำล่วงหน้า has exactly two possible endings, and forfeiture is not one of them: it is applied
to a stay (revenue is recognised on that day), or — rarely — refunded (money leaves, revenue is
never recognised). A guest who reschedules keeps the deposit, and — owner correction, 2026-07-31 —
**the booking itself is moved rather than replaced**, so the deposit never migrates to a different
booking number and stays attached to its original R-number for its whole life. An unapplied deposit
simply stays held for as long as it takes. There is therefore no expiry rule and no
"recognise it at the would-be checkout" fallback.

**Correction (same day):** an earlier revision of this ADR said the app needs no register because
"the outstanding balance lives in iHOTEL". That premise is false. iHOTEL's native deposit reports
(the `ReportDep` family behind FrmReportMudjumRec/Back) read `HT_Deposit`, which has **zero rows
ever** on both properties; the real จ่ายล่วงหน้า/ตัดยอดล่วงหน้า events live in `HT_CheckIn_Pay`
(mirrored as `ht_payment_ledger`) and never touch that table. So iHOTEL has a deposit-report menu
item that would show nothing, and today **nobody in the estate can answer whether a given deposit
was correctly applied, refunded, or is still open.** Capture belongs to iHOTEL; control does not
follow from it. Whether this app grows an office-only reconciliation view is an OPEN question, not
a decided one — see the note below.

**Why control is not optional here:** iHOTEL does not enforce that an applied amount matches what
was received. Proven in the owner's own 2026-07-31 test batch: booking R015834 received 395.00 and
its application row moved 790.00 into `ledger_free` — double, with no second receipt to explain it.
Under accrual that silently overstates revenue on the stay day, and nothing upstream errs.

## Where deposit data comes from

Reception never touches this app. Both accrual moments are captured in iHOTEL, whose existing
จ่ายล่วงหน้า feature was verified working by the owner on 2026-07-31: a `จ่ายล่วงหน้า` payment row
records the deposit as received (dated, with its tender, keyed to `book_no`), and at check-in a
`ตัดยอดล่วงหน้า Booking No:…` row applies it, moving the amount into the `ledger_free` column so the
guest is not charged twice. The income ledger reads both. No new capture UI, no separate reception
app, and no deposit entry surface in this app — see issue #4 for the import specifics, including
that voided rows carry `ledger_status = 'ยกเลิก'` while `book_deposit_amount` on the booking header
is left stale, so the payment ledger is the only trustworthy source.
