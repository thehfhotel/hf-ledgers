// Auth for Income Ledger.
//
// identify(req) resolves the caller to an Identity or null:
//   - development ONLY (NODE_ENV === "development"): DEV_USER env bypass.
//     Any other NODE_ENV value ignores DEV_USER — fails closed.
//   - else: verify the `cf-access-jwt-assertion` header (RS256, JWKS cached
//     1h, iss/aud/exp/nbf) — pattern copied from /Users/nut/hf-mcp/src/auth.ts.
//     isManager = the verified email is a member of the live "HF Managers"
//     tier, read from the HF Portal directory (see directory-client.ts) —
//     replaces the old hand-maintained MANAGER_EMAILS copy.
//
// Cloudflare Access fronts the whole host, so this is defense in depth for
// the API — never the only gate.

import { db } from "./db.ts";
import { ensureDirectoryCache, resolveManagerEmails } from "./directory-client.ts";

export interface Identity {
  email: string;
  isManager: boolean;
}

type Json = Record<string, any>;

const TEAM_DOMAIN = () => process.env.ACCESS_TEAM_DOMAIN || "laikaexpress.cloudflareaccess.com";

// Created once at module load — idempotent (CREATE TABLE IF NOT EXISTS), so
// safe alongside db.ts's own migrate() (already run at db.ts import time).
ensureDirectoryCache(db);

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

/** Verify a CF Access JWT; returns its payload or null. */
export async function verifyAccessJwt(token: string): Promise<Json | null> {
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
  const wantAud = (process.env.ACCESS_AUD || "")
    .split(",")
    .map((s2) => s2.trim())
    .filter(Boolean);
  if (wantAud.length) {
    const got = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!got.some((a: string) => wantAud.includes(a))) return null;
  }
  return payload;
}

export async function identify(req: Request): Promise<Identity | null> {
  if (process.env.NODE_ENV === "development" && process.env.DEV_USER) {
    const email = process.env.DEV_USER.toLowerCase();
    const managers = await resolveManagerEmails(db);
    return { email, isManager: managers.has(email) };
  }

  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (!jwt) return null;
  const payload = await verifyAccessJwt(jwt);
  if (!payload?.email) return null;
  const email = String(payload.email).toLowerCase();
  const managers = await resolveManagerEmails(db);
  return { email, isManager: managers.has(email) };
}
