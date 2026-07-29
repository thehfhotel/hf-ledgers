// Auth interface — complete; JWT verification is WP-A's implementation.
//
// identify(req) resolves the caller to an Identity or null:
//   - development ONLY (NODE_ENV === "development"): DEV_USER env bypass.
//     Any other NODE_ENV value ignores DEV_USER — fails closed.
//   - else: verify the `cf-access-jwt-assertion` header via the
//     verifyAccessJwt pattern (RS256, JWKS cached 1h, iss/aud/exp/nbf)
//     copied from /Users/nut/hf-mcp/src/auth.ts. isManager = the verified
//     email is a member of MANAGER_EMAILS.
//
// Cloudflare Access fronts the whole host, so this is defense in depth for
// the API — never the only gate.

export interface Identity {
  email: string;
  isManager: boolean;
}

export function managerEmails(): Set<string> {
  return new Set(
    (process.env.MANAGER_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function identify(req: Request): Promise<Identity | null> {
  if (process.env.NODE_ENV === "development" && process.env.DEV_USER) {
    const email = process.env.DEV_USER.toLowerCase();
    return { email, isManager: managerEmails().has(email) };
  }

  // TODO(WP-A): verify req.headers.get("cf-access-jwt-assertion") via the
  // hf-mcp verifyAccessJwt pattern and resolve isManager via MANAGER_EMAILS.
  void req;
  return null;
}
