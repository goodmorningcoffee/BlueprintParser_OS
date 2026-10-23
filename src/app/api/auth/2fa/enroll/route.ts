/**
 * POST /api/auth/2fa/enroll  (ROOT ONLY, verified)
 *
 * [2026-10-23] Thin shell — services/root-two-factor.ts (beginRootTwoFactorEnrollment). Mints a
 * TOTP secret and parks it as a PENDING enrollment; nothing is enforced until /confirm proves a
 * code. Returns { secret (base32), otpauth, account, issuer } for the authenticator app.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { beginRootTwoFactorEnrollment } from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "root",
  handler: ({ session }) => beginRootTwoFactorEnrollment(session!),
});
