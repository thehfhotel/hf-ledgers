# Plan — office payment audit hub + reception slip inbox (2026-08-03)

Product of a design interview with the owner; the visual design lives at the Claude artifact
"ตรวจสอบ — Office Payment Audit — Design" and every decision below is owner-confirmed.

## Decisions (binding)

- **Scope**: the audit covers ALL payments of a day, not just deposits.
- **Placement**: the มัดจำ page becomes a 3-tab hub, nav renamed **ตรวจสอบ**: ตรวจรายวัน (new,
  default, opens on YESTERDAY) | รายการมัดจำ (unchanged) | สรุปรายเดือน (unchanged).
- **Row model**: one row per STAY SETTLEMENT — a check-in's ค่าห้อง payment and its ตัดยอดมัดจำ
  merge into one row, auto-mapped via the CH ref + the R ref iHOTEL writes into the ตัดยอด line;
  the มัดจำ portion renders as a chip with the original receipt (date · pay_no · tender · its own
  audit status) underneath. Other row kinds: รับมัดจำ (with forward check-in date), คืนเงิน.
  Exceptions surface inline in red AND stay in the register's exception list.
- **Queue UX**: pending/done split (รอตรวจ on top, ตรวจแล้ว below, calm); BUTTONS not checkboxes
  (solid ตรวจแล้ว on pending; done rows show who/when + quiet ยกเลิกการตรวจ). The day is done
  when รอตรวจ is empty.
- **Ticks are independent of ยืนยันข้อมูล** (owner-decided): their own audit trail
  (checked_by/checked_at, un-tickable); the day sheet shows "ตรวจแล้ว n/m" linking to the tab;
  ยืนยัน and month-close never require completion.
- **Reception**: a SEPARATE tiny slip-inbox surface (split by audience — income ledger stays
  prohibited to reception, no roles anywhere). Auto-populated from the PMS mirror — reception
  never types a ref; only TRANSFER payments queue for slips; multiple pictures per payment,
  replaceable. Slips on a private volume behind Access; the ledger fetches server-to-server
  (notification-hub pattern) and shows thumbnails inline or a รอสลิป chip — a missing slip is an
  audit signal on both sides. Slip pictures originate on the reception kiosk PC.

  **Correction (2026-08-10):** owner-decided reversal of the line above — some queued
  settlements are genuinely settled in CASH and no bank slip will ever exist for them, so
  without an escape hatch they sit in ส่งสลิป's pending queue forever. ส่งสลิป gained a
  reversible ยืนยันชำระเงินสด mark (reception asserts cash was received; un-markable, only
  reversible; full audit trail — who/when, append-only event log). A cash-marked settlement
  is the ONE case where a missing slip is deliberately NOT an audit signal: the office's
  ตรวจสอบ hub renders it as a calm เงินสด chip instead of the red รอสลิป chip. Every other
  missing-slip case is unchanged — the audit signal still stands. Wire contract:
  `src/shared/api.md`'s "Wave 2: ยืนยันชำระเงินสด — cash-mark reversal" section.

## Waves

**Wave 1 — ledger-side audit hub (no new infra, ships alone).** payment_audits table
(audit key = the row's settlement ref: CH no for check-in rows, receipt pay_no for
รับมัดจำ/คืนเงิน rows; checked_at/checked_by; absence = pending), day-audit endpoint (day-scoped
mirror query, stay-merged rows, receipt pairing incl. paired receipt's audit status, guest
names, pull-status), the 3-tab restructure + queue UI, day-sheet progress chip. Proof fields
(proofCount etc.) designed into the row model now, returning empty until Wave 2.

**Wave 2 — slip inbox + integration (same repo, second service).** OWNER-DECIDED 2026-08-03:
no new repo — ส่งสลิป lives in THIS repo as a second entry point (src/slips/), sharing the PMS
client / guest-name / UI kit code directly, built into the SAME Docker image, deployed as a
SECOND container (service hf-slips, port 4060, own slips-data volume) behind
slips.thehfhotel.org. Separate process/origin is non-negotiable (security): the reception
origin must physically contain no ledger routes — never serve both hostnames from one process.
Estate wiring: hostnames.json managed entry (192.168.100.228:4060), Access app (reception
kiosks + HF Managers), portal card, compose service, deploy workflow extension. Ledger audit
integration (thumbnails, รอสลิป) via bearer-token server-to-server fetch. Retire printed
copies. **Opus review of the
security surface before ship** (cross-app token, volume privacy, public-repo discipline —
slips carry bank account numbers).

Port corrected 2026-08-03 (Opus security review, B1): originally spec'd as 4050, but 4050 is
ALREADY the Expense Ledger's port on the estate map
(`~/HF/HF-erp/infra/cloudflare/hostnames.json` → `expense.thehfhotel.org` → `192.168.100.228:4050`,
its own engine on 4051) — publishing hf-slips on 4050 would collide with/take down Expense
Ledger. hf-slips uses **4060** (internal container port and published host port both), verified
free across the estate map.

Storage rules (owner-decided 2026-08-03, binding):
- **Append-only versioning.** No code path deletes or overwrites a picture file; the app has no
  file-delete API. เปลี่ยน/ลบ writes a supersede record only (audit quartet); full version
  history stays viewable by the office. Protects against both accidental and malicious removal.
- **Per-property layout**: /data/slips/hf/… and /data/slips/hfville/…, keyed month + payment
  ref + version.
- **Compression on ingest**: server-side re-encode, EXIF stripped, long edge capped (~2200px),
  quality tuned for crisp slip-text legibility (amounts and account numbers readable) — freeze
  the quality setting only after verifying against a real slip picture.

## Not doing

Roles inside any app; reception access to the income ledger; LINE-bot capture (kiosk PC is the
source; revisit only if phone friction appears); gating ยืนยันข้อมูล on audit completion.
