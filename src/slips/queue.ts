// รอแนบสลิป — the reception queue: which of a day's payment settlements
// (src/server/day-audit.ts's stay-merged reshaping, reused directly — see
// docs/plan-audit-hub-slips.md Wave 2, item 2) still need a bank-transfer
// slip photographed. FILTERED to a nonzero TRANSFER component only: "cash
// needs no slip; include transfer-tendered รับมัดจำ and refunds" (the
// plan's own wording). `needsSlipProof` is exported so the ledger's own
// day-audit route (src/server/server.ts) can decide which auditKeys are
// even worth asking this service's status endpoint about, without
// re-deriving the same predicate a second time.

import { fetchDayAudit, needsSlipProof, type DayAuditRow } from "../server/day-audit.ts";
import { pmsConfigured } from "../server/pms-prefill.ts";
import type { Property } from "../shared/types.ts";
import { summarize, type AttachmentSummary } from "./storage.ts";

export { needsSlipProof };

/** The settlement's own reference strings, for the queue card's "refs"
 * line — mirrors what DayAuditQueue.tsx already shows per row kind. PURE. */
function rowRefs(row: DayAuditRow): string[] {
  if (row.kind === "checkin") return [row.chRef, ...row.receiptPayNos.filter((p) => p !== row.chRef)];
  if (row.kind === "deposit") return [row.rRef, row.payNo].filter((v, i, arr) => arr.indexOf(v) === i);
  return [row.ref, row.payNo].filter((v, i, arr) => arr.indexOf(v) === i);
}

function rowAmountSatang(row: DayAuditRow): number {
  return row.kind === "checkin" ? row.grossSatang : row.amountSatang;
}

function rowTransferSatang(row: DayAuditRow): number {
  if (row.kind === "checkin") return row.composition.transferSatang;
  return row.tender === "transfer" ? row.amountSatang : 0;
}

export type SlipQueueAttachmentState = AttachmentSummary;

export interface SlipQueueRow {
  auditKey: string;
  kind: DayAuditRow["kind"];
  /** The settlement's own `DayAuditRow.paidAtIso`, carried through verbatim
   * — the ตรวจรายวัน/ส่งสลิป queues share ONE ordering (owner ask, 2026-08-04:
   * date+time DESC in BOTH). This module invents no second copy of the
   * timestamp or the sort: `buildSlipQueue` below simply filters
   * `fetchDayAudit`'s already-`sortDayAuditRows`-ordered rows, so this
   * queue's own row order is that SAME order for free — `paidAtIso` is
   * exposed here purely so the client can render the compact time chip, not
   * because this module re-sorts by it. */
  paidAtIso: string | null;
  guestName: string | null;
  refs: string[];
  amountSatang: number;
  transferSatang: number;
  attachment: SlipQueueAttachmentState;
}

/**
 * Fetches + filters + attaches attachment state for one day, one property.
 * Reuses `fetchDayAudit` unchanged (the SAME stay-merge/receipt-pairing
 * machinery the ledger's own day-audit hub uses) — this module invents no
 * PMS logic of its own. 503/502 gates mirror the ledger's own day-audit
 * route exactly (dark-by-default, real query failure surfaces as an error
 * the caller turns into a 502).
 */
export async function buildSlipQueue(property: Property, date: string): Promise<SlipQueueRow[]> {
  const rows = await fetchDayAudit(property, date);
  const needing = rows.filter(needsSlipProof);
  const summaries = summarize(
    property,
    needing.map((r) => r.auditKey),
  );

  return needing.map((row) => ({
    auditKey: row.auditKey,
    kind: row.kind,
    paidAtIso: row.paidAtIso,
    guestName: row.guestName,
    refs: rowRefs(row),
    amountSatang: rowAmountSatang(row),
    transferSatang: rowTransferSatang(row),
    attachment: summaries.get(row.auditKey) ?? { count: 0, latestAt: null, latestVersion: null, superseded: 0 },
  }));
}

export { pmsConfigured };
