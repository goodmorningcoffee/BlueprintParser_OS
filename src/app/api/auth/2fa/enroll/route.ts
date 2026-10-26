/**
 * POST /api/auth/2fa/enroll  { password }  (ROOT in the database — reachable while GATED)
 *
 * [2026-10-25] auth:"none" shell; the caller is the encrypted cookie's root user
 * (requireRootTwoFactorCaller) and must re-enter the ACCOUNT PASSWORD, so a stolen cookie cannot
 * enroll its own device. Mints a TOTP secret and parks it as a PENDING enrollment; nothing is
 * enforced until /confirm proves a code. Returns { secret (base32), otpauth, account, issuer }.
 * Rate-limited per user by the middleware rule for this path (root never exempt) and by the
 * persistent lockout ladder in the enrollment row.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { beginRootTwoFactorEnrollment, zTwoFactorPasswordBody } from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "none",
  body: zTwoFactorPasswordBody,
  handler: ({ body, req }) => beginRootTwoFactorEnrollment(req, body),
});
