---
status: accepted
---

# Recognise a cost in the month it was incurred, not the month its bill was filed or paid

The book had been summing bills by filing month, and the two big lines diverge on exactly that:
PEA's August bill arrives and is filed in September, and the payroll batch filed in August pays
July — the report had to look one month back to match them. The owner chose (2026-09-19)
period-based recognition: every bill carries a งวด, ต้นทุน is summed by งวด, and "filed" and
"paid" are states of the record rather than dates of the cost. This lines ต้นทุน up with revenue
month for month, and with the income ledger's own ADR-0001 (recognise income when the stay
happens, not when money moves).

Considered and rejected: cash basis (when paid) — hides everything ค้างจ่าย and makes a month
look cheap while bills wait; filing month (the status quo) — puts a cost in whichever month the
accountant got to it, which is nobody's month.

Consequences: every bill needs a งวด at filing (defaulted where the document prints one); the
monthly rollup is re-keyed by งวด; a bill filed after its month's report was sent restates that
month.
