/**
 * GET /api/auth/2fa/status  (ROOT in the database — reachable while GATED)
 *
 * [2026-10-25] auth:"none" shell: a root login that still owes enrollment or its code has no
 * session user, so the service identifies the caller from the encrypted cookie and re-reads
 * users.isRootAdmin (requireRootTwoFactorCaller). Returns { enrolled, enrolledAt,
 * backupCodesRemaining, pendingEnrollment }.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getRootTwoFactorStatus } from "@/server/services/root-two-factor";

export const GET = defineRoute({
  auth: "none",
  handler: ({ req }) => getRootTwoFactorStatus(req),
});
