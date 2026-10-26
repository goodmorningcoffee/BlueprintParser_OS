/**
 * POST /api/auth/2fa/backup-codes  { code, password }  (ROOT ONLY, verified)
 *
 * [2026-10-25] Thin shell — services/root-two-factor.ts (regenerateRootTwoFactorBackupCodes).
 * Requires a current code AND the account password; replaces all backup codes and returns the
 * new set once.
 */

import { defineRoute } from "@/server/api/defineRoute";
import {
  regenerateRootTwoFactorBackupCodes,
  zTwoFactorCodeAndPasswordBody,
} from "@/server/services/root-two-factor";

export const POST = defineRoute({
  auth: "root",
  body: zTwoFactorCodeAndPasswordBody,
  handler: ({ body, session }) => regenerateRootTwoFactorBackupCodes(session!, body),
});
