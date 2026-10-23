/**
 * POST /api/auth/2fa/backup-codes  { code }  (ROOT ONLY, verified)
 *
 * [2026-10-23] Thin shell — services/root-two-factor.ts (regenerateRootTwoFactorBackupCodes).
 * Requires a current code; replaces all backup codes and returns the new set once.
 */

import { defineRoute } from "@/server/api/defineRoute";
import {
  regenerateRootTwoFactorBackupCodes,
  zTwoFactorCodeBody,
} from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "root",
  body: zTwoFactorCodeBody,
  handler: ({ body, session }) => regenerateRootTwoFactorBackupCodes(session!, body),
});
