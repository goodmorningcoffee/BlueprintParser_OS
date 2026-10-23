/**
 * POST /api/auth/2fa/verify  { code }  (any SESSION — this is how a PENDING root becomes root)
 *
 * [2026-10-23] Thin shell — services/root-two-factor.ts (verifyRootTwoFactor). Accepts a TOTP code
 * (±1 step, replay refused) or one single-use backup code, then stores a short-lived server-side
 * marker keyed by the login's nonce; the client calls session.update() and the JWT callback
 * re-checks that marker (lib/auth.ts). Rate-limited per user by the middleware rule for this exact
 * path (lib/middleware-rate-limit.ts RATE_RULES; root is never exempt from it).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { verifyRootTwoFactor, zTwoFactorCodeBody } from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "session",
  body: zTwoFactorCodeBody,
  handler: ({ body, session, req }) => verifyRootTwoFactor(session!, body, req),
});
