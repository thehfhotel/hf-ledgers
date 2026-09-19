# Context Map

## Contexts

- [Income Ledger](./CONTEXT.md) — what money came in each day, by which tender, and how much reached the bank; the correction layer over iHOTEL
- [Expense Ledger](./expense-ledger/CONTEXT.md) — every bill the business owes, filed once in the งวด it belongs to; the source of truth for ต้นทุน

## Relationships

- **Income Ledger ↔ Expense Ledger**: share `Property` (hf / hfville) and the satang money convention; each keeps its own recognition rule (income: ADR-0001 accrual on the stay; expense: expense-ledger/docs/adr/0001 by งวด) so that a month's income and ต้นทุน describe the same month
- **Expense Ledger → hf-analytics**: pushes one rollup per งวด (`POST /api/ingest/expense-ledger`); the owner report and Claude's `cost_summary` read the rollup, never the book directly
