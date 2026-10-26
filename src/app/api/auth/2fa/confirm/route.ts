/**
 * POST /api/auth/2fa/confirm  { code }  (ROOT in the database — reachable while GATED)
 *
 * [2026-10-25] auth:"none" shell; caller = the encrypted cookie's root user
 * (requireRootTwoFactorCaller). A valid code against the pending secret activates the
 * enrollment, marks THIS login verified (its nonce is read from the same cookie) and returns the
 * 10 backup codes once.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { confirmRootTwoFactorEnrollment, zTwoFactorCodeBody } from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "none",
  body: zTwoFactorCodeBody,
  handler: ({ body, req }) => confirmRootTwoFactorEnrollment(req, body),
});
