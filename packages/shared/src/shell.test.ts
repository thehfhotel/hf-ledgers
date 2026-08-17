// The executable spec for the estate band's per-identity property hint.
//
// One suite for both ledgers on purpose: `shell.ts` is ONE module serving two
// apps, so the identity matrix below is run against each app's REAL
// `src/client/index.html` rather than a fixture. That is what makes this a
// test of "the income ledger scopes the band" and "the expense ledger scopes
// the band", not merely of a regex.
//
// The identities are signed with a real RS256 key and verified through the
// same `identify()` the APIs use — the whole point of the module is that the
// address it keys on was proven by signature, not read off a header a LAN
// caller could set for themselves (see access.ts's header for why the LAN
// path makes that more than theoretical here).
//
// Env teardown RESTORES the ambient values rather than deleting them, for the
// reason access.test.ts writes down: `bun test` shares one process across
// every file in the monorepo, and both apps' suites run alongside this one.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { _internal } from "./access.ts";
import {
  HFVILLE_RECEPTION_EMAIL,
  SHELL_HEADERS,
  propertyHintForEmail,
  shellHtmlResponse,
  withPropertyHint,
} from "./shell.ts";

const TEAM = "laikaexpress.cloudflareaccess.com";
const AUD = "test-aud-ledgers";
const OTHER_AUD = "test-aud-some-other-app";
const KID = "test-key-1";

// ── a real RS256 signer ────────────────────────────────────────────────────

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: KID, alg: "RS256" };

const b64url = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64url");

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${b64url(new Uint8Array(signature))}`;
}

/** A page load by a signed-in caller, exactly as Cloudflare Access delivers it. */
async function pageLoadBy(email: string, aud: string = AUD): Promise<Request> {
  const token = await signJwt({
    email,
    iss: `https://${TEAM}`,
    aud: [aud],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return new Request("https://income.thehfhotel.org/", { headers: { "cf-access-jwt-assertion": token } });
}

const anonymousPageLoad = (): Request => new Request("https://income.thehfhotel.org/");

// ── env, saved and restored (see the header) ───────────────────────────────

const ENV_KEYS = ["NODE_ENV", "DEV_USER", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"] as const;
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/cdn-cgi/access/certs")) return Response.json({ keys: [publicJwk] });
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  _internal.resetJwksCacheForTests();
  _internal.resetLoggedMissingAudForTests();
  process.env.ACCESS_TEAM_DOMAIN = TEAM;
  process.env.ACCESS_AUD = AUD;
  // The JWT path, not the dev bypass — these tests are about a verified identity.
  process.env.NODE_ENV = "test";
  delete process.env.DEV_USER;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  for (const key of ENV_KEYS) {
    const saved = SAVED_ENV[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

// ── reading the band ───────────────────────────────────────────────────────

/** The estate band's script tag on its own. Deliberately not a substring
 *  search over the whole page: both apps' HTML carries a comment naming the
 *  attribute in prose, and only the tag decides anything. */
const bandTagOf = (html: string): string => html.match(/<script\b[^>]*hf-bar\.js[^>]*>/)?.[0] ?? "";

/** What the estate band is actually told — the only input the switcher reads. */
const bandHint = (html: string): string | null => bandTagOf(html).match(/\bdata-property="([^"]*)"/)?.[1] ?? null;

// ── the location hint, on its own ──────────────────────────────────────────

describe("propertyHintForEmail", () => {
  it("should name HF Ville for the HF Ville reception kiosk", () => {
    expect(propertyHintForEmail(HFVILLE_RECEPTION_EMAIL)).toBe("hfville");
    expect(HFVILLE_RECEPTION_EMAIL).toBe("hfville.hotel@gmail.com");
  });

  it("should name no place for HF's reception identity, which also runs on the HF Ville PC", () => {
    // Deliberately NOT "hf". theharbourfront.hotel@gmail.com is also Chrome
    // "Profile 1" on the HF VILLE reception PC, so hinting "hf" from it would
    // hide HF Ville's own Room Daily Report at the HF Ville desk.
    expect(propertyHintForEmail("theharbourfront.hotel@gmail.com")).toBeNull();
  });

  it("should name no place for the office PC, which works both properties", () => {
    expect(propertyHintForEmail("sdyoffice66@gmail.com")).toBeNull();
  });

  it("should name no place for a manager or an unknown caller", () => {
    expect(propertyHintForEmail("winut.hf@gmail.com")).toBeNull();
    expect(propertyHintForEmail("stranger@example.com")).toBeNull();
  });

  it("should name no place for a missing or empty address", () => {
    expect(propertyHintForEmail(null)).toBeNull();
    expect(propertyHintForEmail(undefined)).toBeNull();
    expect(propertyHintForEmail("")).toBeNull();
  });

  it("should match the kiosk address whatever its case or padding", () => {
    expect(propertyHintForEmail("  HFVille.Hotel@Gmail.com  ")).toBe("hfville");
  });

  it("should stay independent of the slips server's KIOSK_DEFAULT_PROPERTY map", () => {
    // src/slips/server.ts maps BOTH reception mailboxes, correctly, because it
    // answers "which property's data loads first?". This module answers "which
    // building is this person standing in?" and only one mailbox can. Unifying
    // the two would reintroduce the wrong-hotel bug from the other side.
    for (const mappedByTheOtherQuestion of ["theharbourfront.hotel@gmail.com", HFVILLE_RECEPTION_EMAIL]) {
      const hint = propertyHintForEmail(mappedByTheOtherQuestion);
      expect(hint).toBe(mappedByTheOtherQuestion === HFVILLE_RECEPTION_EMAIL ? "hfville" : null);
    }
  });
});

// ── the attribute injection ────────────────────────────────────────────────

const SAMPLE_BAND = `<!doctype html>
<html lang="th">
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
    <script defer src="https://erp.thehfhotel.org/shell/hf-bar.js" data-app="Income Ledger" data-module="finance"></script>
  </body>
</html>`;

describe("withPropertyHint", () => {
  it("should add data-property to the estate band when a place is known", () => {
    expect(bandTagOf(withPropertyHint(SAMPLE_BAND, "hfville"))).toContain('data-property="hfville"');
  });

  it("should return the page untouched when no place is known", () => {
    expect(withPropertyHint(SAMPLE_BAND, null)).toBe(SAMPLE_BAND);
  });

  it("should keep the band's existing attributes", () => {
    const tag = bandTagOf(withPropertyHint(SAMPLE_BAND, "hfville"));
    expect(tag).toContain('data-app="Income Ledger"');
    expect(tag).toContain('data-module="finance"');
    expect(tag).toContain("defer");
  });

  it("should change nothing on the page but the band", () => {
    const injected = withPropertyHint(SAMPLE_BAND, "hfville");
    expect(injected.replace(bandTagOf(injected), bandTagOf(SAMPLE_BAND))).toBe(SAMPLE_BAND);
  });

  it("should add the attribute exactly once", () => {
    const once = withPropertyHint(SAMPLE_BAND, "hfville");
    expect(withPropertyHint(once, "hfville")).toBe(once);
    expect(bandTagOf(once).match(/data-property/g)).toHaveLength(1);
  });

  it("should leave a page that carries no estate band alone", () => {
    const bare = '<!doctype html><html><body><div id="root"></div></body></html>';
    expect(withPropertyHint(bare, "hfville")).toBe(bare);
  });
});

// ── the served shell, per app, against each app's real HTML ────────────────

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const APPS = [
  { name: "income ledger", indexPath: join(REPO_ROOT, "src", "client", "index.html"), dataApp: "Income Ledger" },
  {
    name: "expense ledger",
    indexPath: join(REPO_ROOT, "expense-ledger", "src", "client", "index.html"),
    dataApp: "Expense Ledger",
  },
] as const;

for (const app of APPS) {
  describe(`the ${app.name} shell`, () => {
    const source = async (): Promise<string> => Bun.file(app.indexPath).text();
    const servedTo = async (req: Request): Promise<string> => (await shellHtmlResponse(req, await source())).text();

    it("should scope the band for the HF Ville reception kiosk", async () => {
      expect(bandHint(await servedTo(await pageLoadBy(HFVILLE_RECEPTION_EMAIL)))).toBe("hfville");
    });

    it("should omit the attribute for HF's reception kiosk", async () => {
      expect(bandHint(await servedTo(await pageLoadBy("theharbourfront.hotel@gmail.com")))).toBeNull();
    });

    it("should omit the attribute for the office kiosk", async () => {
      expect(bandHint(await servedTo(await pageLoadBy("sdyoffice66@gmail.com")))).toBeNull();
    });

    it("should omit the attribute for a manager", async () => {
      expect(bandHint(await servedTo(await pageLoadBy("winut.hf@gmail.com")))).toBeNull();
    });

    it("should omit the attribute for an anonymous caller", async () => {
      expect(bandHint(await servedTo(anonymousPageLoad()))).toBeNull();
    });

    it("should omit the attribute for a token minted for another app's audience", async () => {
      expect(bandHint(await servedTo(await pageLoadBy(HFVILLE_RECEPTION_EMAIL, OTHER_AUD)))).toBeNull();
    });

    it("should omit the attribute when the identity cannot be checked at all", async () => {
      globalThis.fetch = (async () => {
        throw new Error("JWKS unreachable");
      }) as unknown as typeof fetch;
      expect(bandHint(await servedTo(await pageLoadBy(HFVILLE_RECEPTION_EMAIL)))).toBeNull();
    });

    it("should omit the attribute when ACCESS_AUD is unset in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.ACCESS_AUD = "";
      expect(bandHint(await servedTo(await pageLoadBy(HFVILLE_RECEPTION_EMAIL)))).toBeNull();
    });

    it("should still serve the whole page on every one of those failures", async () => {
      const res = await shellHtmlResponse(anonymousPageLoad(), await source());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('<div id="root">');
      expect(bandTagOf(html)).toContain(`data-app="${app.dataApp}"`);
    });

    it("should forbid every cache from reusing the shell across identities", async () => {
      const res = await shellHtmlResponse(await pageLoadBy(HFVILLE_RECEPTION_EMAIL), await source());
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("vary")?.toLowerCase()).toContain("cf-access-jwt-assertion");
      expect(res.headers.get("vary")?.toLowerCase()).toContain("cookie");
    });

    // ── drift guards ───────────────────────────────────────────────────────

    it("should carry an estate band this module can find and scope", async () => {
      // If the band is ever rewritten in a shape the injector cannot match, the
      // hint would silently stop being applied — and it fails open, so nothing
      // would break and nobody would notice. This test is the noticing.
      const html = await source();
      expect(bandTagOf(html)).not.toBe("");
      expect(bandHint(withPropertyHint(html, "hfville"))).toBe("hfville");
    });

    it("should not carry the attribute at rest — it is added per request only", async () => {
      // Hard-coded in the file, it would scope every desk to the same hotel.
      expect(bandTagOf(await source())).not.toContain("data-property");
    });
  });
}

describe("SHELL_HEADERS", () => {
  it("should publish the no-store rule for the servers to reuse", () => {
    expect(SHELL_HEADERS["cache-control"]).toBe("private, no-store");
    expect(SHELL_HEADERS["content-type"]).toContain("text/html");
  });
});
