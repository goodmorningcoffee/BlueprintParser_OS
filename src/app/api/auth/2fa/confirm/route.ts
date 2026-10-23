/**
 * POST /api/auth/2fa/confirm  { code }  (ROOT ONLY, verified)
 *
 * [2026-10-23] Thin shell — services/root-two-factor.ts (confirmRootTwoFactorEnrollment). A valid
 * code against the pending secret activates the enrollment, marks THIS login verified (its nonce
 * is read from the request's encrypted session cookie) and returns the 10 backup codes once.
 */

import { defineRoute } from "@/server/api/defineRoute";
import {
  confirmRootTwoFactorEnrollment,
  zTwoFactorCodeBody,
} from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "root",
  body: zTwoFactorCodeBody,
  handler: ({ body, session, req }) => confirmRootTwoFactorEnrollment(session!, body, req),
});
