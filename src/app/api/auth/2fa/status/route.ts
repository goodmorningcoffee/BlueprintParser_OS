/**
 * GET /api/auth/2fa/status  (ROOT ONLY — and, since a pending root is projected as non-root, verified)
 *
 * [2026-10-23] Thin shell — behavior lives in services/root-two-factor.ts (getRootTwoFactorStatus).
 * Returns { enrolled, enrolledAt, backupCodesRemaining, pendingEnrollment } for the signed-in root.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getRootTwoFactorStatus } from "@/server/services/root-two-factor";

export const GET = defineRoute({
  auth: "root",
  handler: ({ session }) => getRootTwoFactorStatus(session!),
});
