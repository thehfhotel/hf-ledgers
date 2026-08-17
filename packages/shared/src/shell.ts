// The estate band's property hint, shared by both ledgers.
//
// The estate top bar (erp.thehfhotel.org/shell/hf-bar.js) takes an OPTIONAL
// `data-property="hf"|"hfville"` on its script tag and then leaves the OTHER
// property's branch-specific tools out of the switcher — today the two
// identical-looking "Room Daily Report" entries. The HF Ville reception desk
// kept opening HF's report and filing a day's rooms against the wrong hotel.
// The bar is served from a Cloudflare-bypassed, edge-cached path and must stay
// one identity-blind body for every viewer, and it cannot ask the portal at
// runtime either (cross-origin to an Access-gated path is refused at the edge),
// so the host page is the only place identity exists. See hf-erp
// `design/HF-ONE.md`, the "data-property" section.
//
// ── WHY THIS IS NOT src/slips/server.ts's KIOSK_DEFAULT_PROPERTY ───────────
// Do not "unify" the two. They answer different questions:
//
//   KIOSK_DEFAULT_PROPERTY answers "whose day sheet should this screen open
//   on?" and deliberately maps BOTH reception mailboxes, because each reception
//   PC has a home branch for its own work. That mapping is correct and stays.
//
//   This module answers "which building is this person standing in?", and only
//   ONE address can answer it:
//     hfville.hotel@gmail.com          the HF Ville reception kiosk
//                                      (hfville-reception-1) — it sits at HF
//                                      Ville, so it names a place.
//     theharbourfront.hotel@gmail.com  HF's reception identity — but it ALSO
//                                      runs as Chrome "Profile 1" on the HF
//                                      VILLE reception PC, so it names NO
//                                      place. Hinting "hf" from it would hide
//                                      HF Ville's own Room Daily Report at the
//                                      HF Ville desk — the same bug from the
//                                      other side.
//     sdyoffice66@gmail.com            office-1 — the office works both
//                                      properties.
//   Managers, employees, phones and unknown callers name no place either.
//
// ── FAIL OPEN, unlike the API around it ───────────────────────────────────
// Anything unresolved, unverified or thrown means NO attribute, which lists
// every tool. A missing tool must never be the failure mode; a wrongly scoped
// switcher is worse than an undecluttered one. This is cosmetic decluttering
// only — every URL stays reachable and Cloudflare Access is untouched, so
// there is no authorization decision here to fail closed on.
//
// Server-only, like the `access.ts` it builds on: never import it from client
// code.

import { identify } from "./access.ts";

/** The only address that names a place. Deliberately not a `Property` from
 *  either app's types: this is a location hint for the estate band, not one of
 *  the ledgers' own property values, and the two must be free to diverge. */
export const HFVILLE_RECEPTION_EMAIL = "hfville.hotel@gmail.com";

/** What we are willing to tell the bar. `"hf"` is deliberately never emitted —
 *  no identity these apps see can prove someone is standing at HF (see above). */
export type PropertyHint = "hfville";

/**
 * The place an already-verified address names, or null for "cannot tell".
 * Keyed on the address alone, independently of every other kiosk map in either
 * app — see the KIOSK_DEFAULT_PROPERTY note in the header.
 */
export function propertyHintForEmail(email: string | null | undefined): PropertyHint | null {
  if (typeof email !== "string") return null;
  return email.trim().toLowerCase() === HFVILLE_RECEPTION_EMAIL ? "hfville" : null;
}

/**
 * The place this request's caller is standing at, from the SAME verified
 * identity the APIs use — `identify()`, which RS256-checks the Access JWT
 * against the team JWKS and its audience. A raw header is never enough: every
 * ledger container binds 0.0.0.0, so a LAN-path request reaches the process
 * without passing through Cloudflare at all.
 *
 * Returns null for every failure: no token, wrong audience, expired, JWKS
 * unreachable, ACCESS_AUD unconfigured, or anything thrown.
 */
export async function propertyHintForRequest(req: Request): Promise<PropertyHint | null> {
  try {
    const identity = await identify(req);
    return propertyHintForEmail(identity?.email);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`shell: property hint unavailable, serving the full switcher: ${reason}`);
    return null;
  }
}

/** The estate band's script tag, however its attributes are ordered or wrapped. */
const HF_BAR_SCRIPT_TAG = /<script\b[^>]*\bsrc=["'][^"']*\/shell\/hf-bar\.js["'][^>]*>/i;

/**
 * Adds `data-property` to the estate band, and touches nothing else on the
 * page. A null hint, a page carrying no band, or a band that already has the
 * attribute all return the HTML unchanged.
 */
export function withPropertyHint(html: string, hint: PropertyHint | null): string {
  if (!hint) return html;
  const tag = html.match(HF_BAR_SCRIPT_TAG)?.[0];
  if (!tag || /\bdata-property\s*=/i.test(tag)) return html;
  // A replacer FUNCTION, so nothing inside the tag is read as a `$` substitution.
  return html.replace(HF_BAR_SCRIPT_TAG, () => `${tag.replace(/\s*\/?>$/, "")} data-property="${hint}">`);
}

/**
 * THE CACHING RULE. One instance of each ledger serves BOTH properties, so
 * this page's bytes now differ per identity. A shell reused across identities
 * would scope the wrong desk — worse than never scoping at all — so it must
 * sit in no shared cache and no browser cache: `private, no-store`, not the
 * `no-cache` the identity-blind bundles use.
 *
 * `vary` names the identity on both sides of Cloudflare: the origin varies on
 * the assertion header the edge injects, while anything upstream of the edge
 * only ever sees the CF_Authorization cookie that produced it. Belt and braces
 * behind `no-store`, for any cache that ignores it.
 */
export const SHELL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  vary: "Cf-Access-Jwt-Assertion, Cookie",
});

/**
 * A ledger's SPA shell as served: the built HTML, scoped to the caller's place
 * if it can be proven, with the headers that keep it out of every cache.
 *
 * Rendered per request, so callers must serve it uncompressed rather than
 * handing over a precompressed `index.html.gz` sitting beside the HTML — those
 * bytes are the un-hinted ones. It is ~1 KB and one request per page load.
 */
export async function shellHtmlResponse(req: Request, html: string): Promise<Response> {
  const hint = await propertyHintForRequest(req);
  return new Response(withPropertyHint(html, hint), { headers: { ...SHELL_HEADERS } });
}
