import type { DepositTender, Property } from "../../shared/types.ts";

// Typed fetch wrappers for ส่งสลิป's own /slips-api/* routes
// (src/slips/server.ts) — a SEPARATE origin from the income ledger's own
// api.ts, deliberately not shared (this app never imports src/client/api.ts,
// and never will — see src/slips/server.ts's own module doc comment on why
// the two origins stay code-separate, not just route-separate).

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/slips-api${path}`, init);
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* body wasn't JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Me {
  email: string;
  defaultProperty: Property;
}

export function getMe(): Promise<Me> {
  return request<Me>("/me");
}

export interface SlipQueueRow {
  auditKey: string;
  kind: "checkin" | "deposit" | "refund";
  guestName: string | null;
  refs: string[];
  amountSatang: number;
  transferSatang: number;
  attachment: { count: number; latestAt: string | null; latestVersion: number | null; superseded: number };
}

export function getSlipQueue(property: Property, date: string): Promise<{ rows: SlipQueueRow[] }> {
  return request(`/${property}/day/${date}`);
}

export interface AttachmentWire {
  auditKey: string;
  version: number;
  bytes: number;
  width: number;
  height: number;
  format: string;
  createdAt: string;
  createdBy: string;
  superseded: boolean;
  supersededAt: string | null;
  supersededBy: string | null;
}

export function attachSlip(property: Property, auditKey: string, date: string, file: File): Promise<AttachmentWire> {
  const form = new FormData();
  form.append("file", file);
  form.append("date", date);
  return request(`/${property}/attach/${encodeURIComponent(auditKey)}`, { method: "POST", body: form });
}

export function supersedeSlip(property: Property, auditKey: string, version: number): Promise<AttachmentWire> {
  return request(`/${property}/supersede/${encodeURIComponent(auditKey)}/${version}`, { method: "POST" });
}

export function pictureUrl(property: Property, auditKey: string, version: number): string {
  return `/slips-api/${property}/picture/${encodeURIComponent(auditKey)}/${version}`;
}

export function thumbUrl(property: Property, auditKey: string, version: number): string {
  return `/slips-api/${property}/picture/${encodeURIComponent(auditKey)}/${version}/thumb`;
}

export function getHistory(property: Property, auditKey: string): Promise<{ versions: AttachmentWire[] }> {
  return request(`/${property}/history/${encodeURIComponent(auditKey)}`);
}

// Re-exported so the client never needs a second copy of these tiny shared
// types just to type a queue row's `refs`/tender-adjacent display.
export type { DepositTender, Property };
