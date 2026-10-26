/**
 * POST /api/auth/2fa/disable  { code, password }  (ROOT ONLY, verified)
 *
 * [2026-10-25] Thin shell — services/root-two-factor.ts (disableRootTwoFactor). Requires a current
 * TOTP or backup code AND the account password; deletes the enrollment row (secret, hashes and
 * markers alike), which gates every other session of this root on its next request.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { disableRootTwoFactor, zTwoFactorCodeAndPasswordBody } from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "root",
  body: zTwoFactorCodeAndPasswordBody,
  handler: ({ body, session }) => disableRootTwoFactor(session!, body),
});
