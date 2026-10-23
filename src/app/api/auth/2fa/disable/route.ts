/**
 * POST /api/auth/2fa/disable  { code }  (ROOT ONLY, verified)
 *
 * [2026-10-23] Thin shell — services/root-two-factor.ts (disableRootTwoFactor). Requires a current
 * TOTP or backup code; deletes the enrollment row (secret, hashes and markers alike).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { disableRootTwoFactor, zTwoFactorCodeBody } from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "root",
  body: zTwoFactorCodeBody,
  handler: ({ body, session }) => disableRootTwoFactor(session!, body),
});
