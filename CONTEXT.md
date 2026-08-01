# Income Ledger

The hotel's daily income book: what money came in on a given day, by which payment method, and
how much of it reached the bank. It is also the correction layer over iHOTEL — where the office
records what actually happened when the PMS's own record is wrong or absent.

## Language

**มัดจำล่วงหน้า** (advance deposit):
Money a guest pays before their stay. One concept with two moments — received (money arrives, not
yet earned) and applied (set against the stay's charges, no money movement). Arrives by any
tender: เงินสด, โอน, or บัตรเครดิต. A cash one enters the till and so reaches ยอดฝากจริง.
_Avoid_: มัดจำค่าห้อง, room deposit, prepayment

**Deposit received**:
The moment a มัดจำล่วงหน้า arrives. Money enters the till or bank, but no revenue is earned —
it is not part of that day's รวมรายรับทั้งวัน.

**Deposit applied**:
The moment a มัดจำล่วงหน้า is set against the stay it was taken for. Revenue is earned, but no
money moves that day.

**Deposit thread state** (the office deposit register's explicit-state vocabulary, added
2026-08-01 so a มัดจำล่วงหน้า's status is never ambiguous — one R-number's whole history, from
received through however it closed out). Exactly four states, canonical Thai labels:

- **รอเช็คอิน** (waiting check-in): received, nothing applied or refunded yet — money the office
  is still holding, untouched.
- **บางส่วน** (partial): still holding a balance, but SOME of it has already moved (partially
  applied or partially refunded).
- **ตัดยอดแล้ว** (applied/used): fully absorbed into a stay — no balance left, and what's left is
  accounted for by application, not refund. Always shown with WHERE it went — the CH (check-in)
  ref and the applied date.
- **คืนเงินแล้ว** (refunded): closed out purely by a refund, no application involved.

_Avoid_: ใช้แล้ว ("used" — ambiguous between applied-to-a-stay and merely touched), จ่ายแล้ว
("paid" — ambiguous about which direction money moved, and doesn't distinguish received from
applied), "closed", "resolved" (those describe a note thread's own state, a separate axis from
the deposit's own lifecycle — see the deposit register's note feature, keyed by resolvedAt).

**Payment** (การชำระเงิน):
Money settling charges for a stay that has happened or is happening — distinct from a
มัดจำล่วงหน้า, which arrives before it.
_Avoid_: using "deposit" loosely for any incoming money

**ยอดฝากจริง** (banked):
The cash actually deposited into the bank for a day. Differs from the day's cash income by
deliberate, recorded reasons — see เงินสดยังไม่ฝาก and เงินสดจากรอบก่อน.
_Avoid_: cash total, deposit (that word belongs to มัดจำล่วงหน้า)

**เงินสดยังไม่ฝาก (เข้าตู้ไม่ได้)** (held back):
Cash from this day that could not go into the deposit machine — typically coins and small notes.
Subtracts from ยอดฝากจริง.

**เงินสดจากรอบก่อนที่เข้าตู้ไม่ได้** (brought forward):
Previously held-back cash that is being deposited today. Adds to ยอดฝากจริง.

**Property**:
One of the two hotels the book covers — `hf` (โรงแรม HF) or `hfville` (HF Ville). Every day,
category, and booking row belongs to exactly one.
_Avoid_: branch, site, hotel (ambiguous between the business and the building)

**Tender**:
The payment method money arrived by (เงินสด, โอน, บัตรเครดิต, เว็บไซต์/OTA), recorded per
booking row.
_Avoid_: payment type, channel

**Category**:
A named line on the day sheet that money is recorded against, keyed by a stable `categoryKey`.
Manager-renameable; the key, never the Thai name, is what code matches on.
