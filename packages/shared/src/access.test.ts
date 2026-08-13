// The executable spec for the fail-closed ACCESS_AUD gate — and, until the
// merge, the only place either repo's threat model was written down as code.
//
// Both repos ended up with this suite, three days and one security review
// apart: income-ledger's src/server/auth.test.ts landed with the B4 fix
// (Opus security review, 2026-08-03), expense-ledger's src/server/
// access.test.ts landed when the same gap was closed there (2026-08-13,
// e7247a95). Same five cases either side. The union is those five with
// expense-ledger's teardown, which RESTORES the ambient NODE_ENV/ACCESS_AUD
// rather than deleting them: bun test shares one process across every file in
// the repo, and this suite now sits in packages/shared where both apps' suites
// run alongside it, so a delete-based teardown would quietly reconfigure
// whatever ran next.
//
// What is being proven: an unset ACCESS_AUD in production must fail CLOSED
// (reject every request) rather than silently skipping the audience check.
// Without an audience, a token is narrowed only by issuer, signature and
// expiry — which every app under the team domain satisfies identically, so
// any employee-facing app's JWT would have verified here. The tests also
// prove the short-circuit fires BEFORE any network/JWKS work, by spying on
// global.fetch rather than needing a real signed JWT and a live Cloudflare
// Access JWKS endpoint.
//
// This matters for BOTH apps, not just the public hostname: every container
// binds 0.0.0.0 (income 4040, slips 4060, expense 4050), so a LAN-path
// request reaches the process without ever passing through Cloudflare and
// this check is the only gate. See access.ts's header.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _internal, verifyAccessJwt } from "./access.ts";

function fakeJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64(header)}.${b64(payload)}.not-a-real-signature`;
}

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ACCESS_AUD = process.env.ACCESS_AUD;

function restore(key: "NODE_ENV" | "ACCESS_AUD", value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("verifyAccessJwt — fail-closed on unset ACCESS_AUD in production", () => {
  let fetchCalls: string[];

  beforeEach(() => {
    _internal.resetJwksCacheForTests();
    _internal.resetLoggedMissingAudForTests();
    fetchCalls = [];
    global.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    restore("NODE_ENV", ORIGINAL_NODE_ENV);
    restore("ACCESS_AUD", ORIGINAL_ACCESS_AUD);
  });

  test("production + unset ACCESS_AUD: returns null WITHOUT ever fetching JWKS", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ACCESS_AUD;

    const token = fakeJwt({ alg: "RS256", kid: "whatever" }, { email: "someone@thehfhotel.org" });
    const result = await verifyAccessJwt(token);

    expect(result).toBeNull();
    expect(fetchCalls).toEqual([]); // the gate fires before any network work at all
  });

  test("production + ACCESS_AUD set to an empty/blank-only value: still fails closed", async () => {
    process.env.NODE_ENV = "production";
    process.env.ACCESS_AUD = "  , ,  "; // whitespace/commas only — filters down to an empty list

    const token = fakeJwt({ alg: "RS256", kid: "whatever" }, { email: "someone@thehfhotel.org" });
    const result = await verifyAccessJwt(token);

    expect(result).toBeNull();
    expect(fetchCalls).toEqual([]);
  });

  test("production + ACCESS_AUD set: proceeds past the gate (attempts JWKS)", async () => {
    process.env.NODE_ENV = "production";
    process.env.ACCESS_AUD = "some-audience-id";

    const token = fakeJwt({ alg: "RS256", kid: "whatever" }, { email: "someone@thehfhotel.org" });
    const result = await verifyAccessJwt(token);

    // Still null overall (no matching JWKS key for a fake token), but the
    // point of THIS test is that it got far enough to actually try —
    // proving the gate only fires for the unset-ACCESS_AUD case.
    expect(result).toBeNull();
    expect(fetchCalls.length).toBeGreaterThan(0);
  });

  test("non-production (dev/test) + unset ACCESS_AUD: does NOT fail closed — proceeds to verify normally", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.ACCESS_AUD;

    const token = fakeJwt({ alg: "RS256", kid: "whatever" }, { email: "someone@thehfhotel.org" });
    const result = await verifyAccessJwt(token);

    expect(result).toBeNull(); // no matching key, still rejected — but via the NORMAL path
    expect(fetchCalls.length).toBeGreaterThan(0); // proves it reached the JWKS fetch, unlike the production+unset case above
  });

  test("malformed token (wrong shape) is rejected before any of this — sanity check", async () => {
    process.env.NODE_ENV = "production";
    process.env.ACCESS_AUD = "some-audience-id";
    expect(await verifyAccessJwt("not.a.valid.jwt.shape")).toBeNull();
    expect(await verifyAccessJwt("only-one-part")).toBeNull();
  });
});
