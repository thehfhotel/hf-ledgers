# ดึงข้อมูล — prefilling the bookings sheet from the PMS

Status: PLANNED (evaluated 2026-07-30 against the live PMS schema and data). Verdict: **feasible
for both properties**, button-triggered only, with a well-defined subset of fields. This file is
the record of what was verified and the design to build.

NOTE: this repo is public. This plan deliberately names no hosts, ports, or credentials —
connection details live in GitHub secrets / the container env only, like the analytics pair.

## What was verified (2026-07-30)

- **Both properties have PMS payment data.** The PMS payment ledger (`ht_payment_ledger`, a
  canonical Postgres mirror of legacy iHOTEL's `HT_CheckIn_Pay`) covers HF since 2026-03-28
  (~1,900 payments) and **HF Ville since 2026-03-29 (~1,500 payments)**. The PMS keeps one
  logical database per property; a consumer connects to two databases, not one with a branch
  column.
- **Payment date exists** (`ledger_pay_date`, a true received-on instant), distinct from stay
  dates. Booking ref, guest name, room number, nights, room amount are all joinable in Postgres.
- **The read path has precedent.** Two sibling apps already consume the PMS the same way we
  would: a read-only Postgres role with table/column grants (names only on customers — no ID or
  passport columns). The PMS has NO server-to-server HTTP API and its Cloudflare Access
  integration rejects service tokens, so the read-only role IS the established machine-consumer
  pattern, not a workaround.
- **Direct iHOTEL MSSQL reads are ruled out.** The PMS architecture's standing rule is that only
  its own adapter workers touch MSSQL; the payment mirror exists precisely so consumers read
  canonical Postgres instead. Every other consumer was granted Postgres and explicitly refused
  MSSQL. We follow that — and this public repo must never carry MSSQL topology anyway.

## What can prefill, per field

One inserted row per PMS **payment** (receipt number = `pms_ref`), for payments dated the
sheet's day:

| Sheet column | Source | Prefilled? |
|---|---|---|
| เลขที่ (booking/receipt no) | folio / booking id on the payment | yes |
| ชื่อลูกค้า | customer join (name columns only) | yes |
| ห้อง | room label on the payment's room line | yes |
| จำนวนห้อง / คืน | room lines / nights qty | yes |
| ค่าห้อง (gross room) | sum of room-category lines | yes |
| อื่นๆ (gross other) | sum of non-room lines | yes |
| ส่วนลด | **not in the PMS** (no discount column on folio or booking) | no — manual |
| เงินสด | cash tender | yes |
| แอพฯ/เว็บไซต์ | web tender | yes |
| มัดจำ | dated deposit events exist only when taken in iHOTEL | partial |
| บัตรเครดิต กสิกร/ICBC | **PMS records "credit" but NOT the bank** | amount reported, column manual |
| เงินโอน กสิกร/ICBC | same — "transfer" with no bank | amount reported, column manual |
| หมายเหตุ | — | left empty (no amounts in text — the tripwire exists for a reason) |

The bank split is the one true gap: iHOTEL stores no acquiring bank, confirmed in both schemas.
The pull result dialog therefore lists any credit/transfer amounts it could not place
("บัตรเครดิต 1,500 ยังไม่ได้ระบุธนาคาร — กรอกในช่องธนาคารเอง") and the operator types them into
the right bank column. Everything else lands filled.

## Design

### Row identity and idempotence

- `pms_ref` = the PMS payment number (falling back to the ledger row id when blank), which this
  app's schema has been waiting for: `booking_lines.source='pms'` + the partial unique index on
  `(property, date, pms_ref)`.
- The button **inserts only payments whose `pms_ref` is not already on that day, and never
  updates an existing row** — hand edits are sacred; pressing ดึงข้อมูล twice is harmless; a
  payment taken after the last press appears on the next press as a new row.
- Rows keyed per payment (not per folio) so late second payments arrive as new rows instead of
  requiring updates to merged ones.

### The one query gotcha that matters

iHOTEL replicates the whole tender split onto **every line** of a multi-line receipt — summing
raw rows triples the money (a verified real-world case differed by 57%). The PMS's own round
report deduplicates to one row per payment number before summing tenders; our query copies that
convention exactly. Line amounts (`ledger_amount`) are genuinely itemized and are summed raw.
Cancelled payments are excluded; net-negative payments (refunds) are skipped and counted in the
result dialog rather than inserted as negative rows.

### Day boundary

The PMS cuts by calendar day; the office sheet is report-day keyed (the night round belongs to
the day it started). V1 pulls the sheet date's Bangkok calendar day and says so; a payment after
midnight lands on the next sheet. If this bites in practice, v2 can adopt the PMS's cashier-round
boundaries. Do not silently re-cut days.

### Server

- Bun's built-in Postgres client (`Bun.sql`) — no new dependency.
- Env: two read-only connection URLs (`PMS_DB_URL_HF`, `PMS_DB_URL_HFVILLE`), GitHub secrets →
  container env, exactly like the analytics pair. Both unset = feature dark (button hidden via a
  capability flag on an existing GET), matching the house pattern.
- `POST /:property/day/:date/pull-from-pms` — no body. Month-closed → the existing 409. Response
  `{ inserted, skipped, unplacedTenders: [...], skippedRefunds }`. Mapping and dedup logic are
  pure functions with unit tests (the repo's convention: pure parts tested, network shim thin);
  the PMS query itself is integration-tested against a seeded throwaway Postgres only if CI ever
  gains one — otherwise covered by the pure layer plus live verification.
- Grants: start on the existing read-only role's tables (the payment ledger and customer-name
  columns are already granted to it for the MCP server); a dedicated narrower role is a
  hardening follow-up provisioned on the PMS side, out of band.

### UI

ดึงข้อมูล button on the bookings page header, next to the move button. Never automatic — no
fetch on load, no polling. Hidden in demo mode and when the feature is unconfigured; disabled
while the month is closed or a pull is in flight. Result dialog reports inserted/skipped counts
and the unplaced credit/transfer amounts per row.

## Known limits (stated up front, not discovered later)

1. History floor: nothing before late March 2026 exists to pull.
2. The PMS mirror has a known, documented gap of 19 HF folios from its backfill era; HF Ville is
   fully converged. Pre-existing upstream issue, not fixable here.
3. OTA money: commission and net payouts are not modelled in the PMS at all (they live in OTA
   Desk's reservation records). OTA rows keep being entered the way they are today; a future
   OTA-Desk-sourced prefill is a separate project.
4. New-app booking deposits produce no dated payment event in the PMS (legacy-authored ones do),
   so มัดจำ prefill is partial by upstream design.
5. Legacy sync latency is ~1s with a 15-minute reconcile backstop — irrelevant at button speed,
   but a payment typed into iHOTEL seconds before pressing ดึงข้อมูล can miss one press.

## Build order

1. Pure layer: payment→row mapping, per-payment dedup, day-window computation + tests.
2. Server: Bun.sql clients, the route, capability flag, api.md contract.
3. UI: button + result dialog.
4. Provision the read grants on the PMS side (out of band, documented in the PMS repo's runbook
   style), set the two secrets, deploy dark, enable, verify live against a real recent day on
   BOTH properties by comparing against the paper sheet.
