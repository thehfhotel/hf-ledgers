// Bearer-token internal endpoints — the ledger's server-to-server proof
// enrichment (docs/plan-audit-hub-slips.md's "notification-hub pattern",
// same shape as hf-erp-portal's NOTIFY_INGRESS_TOKEN). Never behind
// Cloudflare Access: this is a private Docker-network call between the two
// containers, gated purely by SLIPS_INGRESS_TOKEN.

import { timingSafeEqual } from "node:crypto";
import type { Property } from "../shared/types.ts";
import { latestCurrent, summarize } from "./storage.ts";

/**
 * Constant-time bearer-token compare — a plain `===` leaks a timing signal
 * proportional to the shared prefix length. `node:crypto`'s
 * `timingSafeEqual` itself throws on a length mismatch rather than
 * comparing, so the length check here runs first — this is safe (not a
 * timing leak) because only the LENGTH is compared unsafely, never the
 * token's actual content.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validates an `Authorization: Bearer <token>` header against
 * `SLIPS_INGRESS_TOKEN` (read lazily — never captured at import time, same
 * rule pms-prefill.ts documents). `false` whenever the env var itself is
 * unset — an empty expected token can never be "matched" by any header,
 * so a misconfigured (token-less) deployment fails closed rather than
 * accepting every request.
 */
export function isValidIngressToken(authHeader: string | null): boolean {
  const expected = process.env.SLIPS_INGRESS_TOKEN ?? "";
  if (expected === "") return false;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const given = authHeader.slice("Bearer ".length);
  return constantTimeEqual(given, expected);
}

// This module's own bounds — a separate literal from BOOKING_NO_MAX_LEN
// (shared/types.ts), same "never invert the natural dependency direction"
// reasoning deposit-register.ts/day-audit.ts already document for their own
// private copies of shared constants.
const MAX_STATUS_KEYS = 200;
const MAX_KEY_LEN = 40;

/** Parses the `?keys=k1,k2,...` query param into a bounded, cleaned list —
 * blank entries dropped, each entry length-capped, the whole list capped at
 * `MAX_STATUS_KEYS` (a caller asking for more just gets the first N — never
 * a 500 from an unbounded IN-clause). PURE. */
export function parseStatusKeys(raw: string | null): string[] {
  if (!raw) return [];
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k.length <= MAX_KEY_LEN);
  return keys.slice(0, MAX_STATUS_KEYS);
}

export interface StatusResponseEntry {
  count: number;
  latestAt: string | null;
  latestVersion: number | null;
  superseded: number;
}

/** GET /slips-internal/:property/status?keys=... response body — every
 * requested key present (storage.ts's `summarize` already guarantees
 * this), so the ledger never needs an existence check before reading. */
export function buildStatusResponse(property: Property, keys: readonly string[]): Record<string, StatusResponseEntry> {
  const summaries = summarize(property, keys);
  const out: Record<string, StatusResponseEntry> = {};
  for (const key of keys) {
    out[key] = summaries.get(key) ?? { count: 0, latestAt: null, latestVersion: null, superseded: 0 };
  }
  return out;
}

/** The file path for the latest CURRENT thumbnail — `null` when the
 * settlement has no current attachment (caller 404s). */
export function latestThumbPath(property: Property, auditKey: string): string | null {
  return latestCurrent(property, auditKey)?.thumbPath ?? null;
}
