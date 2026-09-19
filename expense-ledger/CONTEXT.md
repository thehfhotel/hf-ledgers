# Expense Ledger

The company's book of what it cost to run the two hotels: every bill, filed once, in the month
the cost belongs to. It is the source of truth for ต้นทุน (owner decision, 2026-09-15); every
other system that knows about a cost only checks whether this book is complete.

## Language

**ต้นทุน** (cost):
Money the business owes for running the hotels, recognised in the งวด it was incurred — not when
the bill arrived and not when it was paid.
_Avoid_: ค่าใช้จ่ายจ่ายจริง, cash out, spend

**งวด** (cost period):
The month a cost belongs to: the month the electricity was used, the staff worked, the room was
cleaned. Every bill has exactly one — the month of its วันที่ลงบิล. It is the axis ต้นทุน is summed on.
_Avoid_: filing month, บันทึกเดือน, the month the bill arrived

**วันที่ลงบิล** (bill date):
The date the accountant assigns a bill to — the day its cost belongs to. Its month is the
บิล's งวด. Defaults to the document date; set by hand when the document says otherwise, and to
the last day of the span for a bill covering more than one month (owner, 2026-09-19).
_Avoid_: วันที่ยื่น, entry date, วันที่ลงรายการ (that is the filing date)

**วันยื่นบิล** (filing date):
The day a bill was entered into the book. A property of the record, never of the cost — a bill
filed in September for August's electricity is August ต้นทุน.
_Avoid_: using it as the cost's date

**ค้างจ่าย** (unpaid):
A filed bill not yet settled. A payment state, never a second cost — the ต้นทุน was recognised
when the bill was filed into its งวด.
_Avoid_: outstanding cost, ค่าใช้จ่ายรอจ่าย

**บิล** (bill):
One document the business owes money against — a supplier invoice, a utility bill, a payroll
batch, a staff receipt. Counted once, in its งวด.
_Avoid_: expense (the general word), transaction (the engine's word)
