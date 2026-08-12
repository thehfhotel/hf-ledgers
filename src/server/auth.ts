// Auth for Income Ledger.
//
// identify(req) resolves the caller to an Identity or null:
//   - development ONLY (NODE_ENV === "development"): DEV_USER env bypass.
//     Any other NODE_ENV value ignores DEV_USER — fails closed.
//   - else: verify the `cf-access-jwt-assertion` header (RS256, JWKS cached
//     1h, iss/aud/exp/nbf) — pattern copied from /Users/nut/HF/hf-mcp/src/auth.ts.
//
// There are no roles in this app — Cloudflare Access alone decides who may
// reach income.thehfhotel.org, so identify() only resolves WHO the caller is
// (for provenance: created_by/updated_by/verified_by/closed_by), never what
// they may do. This is defense in depth for the API — never the only gate.

export interface Identity {
  email: string;
}

type Json = Record<string, any>;

const TEAM_DOMAIN = () => process.env.ACCESS_TEAM_DOMAIN || "laikaexpress.cloudflareaccess.com";

// ── base64url helpers ──────────────────────────────────────────────────
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(s, "base64url"));
const b64urlJson = (s: string): Json => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// ── Cloudflare Access JWT (RS256) ────────────────────────────────────────
let jwksCache: { at: number; keys: Json[] } | undefined;
async function jwksKeys(): Promise<Json[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(`https://${TEAM_DOMAIN()}/cdn-cgi/access/certs`);
  const data = (await res.json()) as Json;
  jwksCache = { at: Date.now(), keys: (data.keys ?? []) as Json[] };
  return jwksCache.keys;
}

let loggedMissingAudInProd = false;

/** Verify a CF Access JWT; returns its payload or null.
 *
 * B4 (Opus security review, 2026-08-03): an unset `ACCESS_AUD` used to
 * silently SKIP the audience check below (`if (wantAud.length)` was simply
 * false) — meaning any signature-valid JWT from ANYWHERE in the same
 * Cloudflare Access team (including employee-facing apps) would verify
 * successfully. This is checked FIRST, before any parsing or network work,
 * so a misconfigured production deployment (e.g. a fresh container whose
 * `ACCESS_AUD_SLIPS` secret hasn't been set yet) fails CLOSED — rejecting
 * every request — rather than silently accepting a wider audience than
 * intended. Never fires outside `NODE_ENV=production` (dev/test rely on the
 * DEV_USER bypass in `identify()` below, which never reaches this
 * function). Logged once per process, not once per request, so a
 * misconfigured deploy doesn't spam its own logs into uselessness. */
export async function verifyAccessJwt(token: string): Promise<Json | null> {
  const wantAud = (process.env.ACCESS_AUD || "")
    .split(",")
    .map((s2) => s2.trim())
    .filter(Boolean);
  if (process.env.NODE_ENV === "production" && wantAud.length === 0) {
    if (!loggedMissingAudInProd) {
      loggedMissingAudInProd = true;
      console.error("auth: ACCESS_AUD is unset in production — refusing every request until it is configured (fail-closed, not fail-open)");
    }
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header: Json, payload: Json;
  try {
    header = b64urlJson(h!);
    payload = b64urlJson(p!);
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const key = (await jwksKeys()).find((k) => k.kid === header.kid);
  if (!key) return null;
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    fromB64url(s!),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (payload.iss !== `https://${TEAM_DOMAIN()}`) return null;
  if (wantAud.length) {
    const got = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!got.some((a: string) => wantAud.includes(a))) return null;
  }
  return payload;
}

export async function identify(req: Request): Promise<Identity | null> {
  if (process.env.NODE_ENV === "development" && process.env.DEV_USER) {
    return { email: process.env.DEV_USER.toLowerCase() };
  }

  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt) return null;
  const payload = await verifyAccessJwt(jwt);
  if (!payload?.email) return null;
  return { email: String(payload.email).toLowerCase() };
}

// Test-only handle — same shape as every sibling module's `_internal`.
export const _internal = {
  resetJwksCacheForTests(): void {
    jwksCache = undefined;
  },
  resetLoggedMissingAudForTests(): void {
    loggedMissingAudInProd = false;
  },
};
