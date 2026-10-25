/**
 * POST /api/auth/2fa/verify  { code }  (ROOT in the database — this is how a GATED root becomes root)
 *
 * [2026-10-25] auth:"none" shell; caller = the encrypted cookie's root user
 * (requireRootTwoFactorCaller). Accepts a TOTP code (±1 step, replay refused) or one single-use
 * backup code, then stores the server-side marker keyed by the login's nonce; the client calls
 * session.update() and the JWT callback re-checks that marker on every refresh (lib/auth.ts).
 * Rate-limited per user by the middleware rule for this exact path (root never exempt) and by the
 * persistent lockout ladder in the enrollment row.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { verifyRootTwoFactor, zTwoFactorCodeBody } from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "none",
  body: zTwoFactorCodeBody,
  handler: ({ body, req }) => verifyRootTwoFactor(req, body),
});
