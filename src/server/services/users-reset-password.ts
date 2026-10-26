// [refactor jul7 S051] admin/users/reset-password SOLO — root force-resets a user's password
// after confirming their OWN password, folded from the legacy route (git show 79a3d67:src/app/
// api/admin/users/reset-password/route.ts). Char: __tests__/admin-users-reset-password.route.test.ts
// (RP-*). requireAdmin (the shell provides auth:"admin"); PUT keeps a SECONDARY in-service
// isRootAdmin gate ("Root admin required"/403) — do NOT bump the shell to auth:"root".
// Sanctioned diffs A (flat auth + all validation/verify literals → envelope byte-verbatim) +
// E (legacy `await req.json()` → shell "Invalid JSON body"); no catch-500 → NO B.
// SECURITY-CORE, preserved byte-exact: the min-8 password rule, the self-password bcrypt.compare
// verification, the target-exists check, bcrypt.hash(newPassword, 12).

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { ApiError } from "@/server/api/envelope";
import { revokeRootTwoFactorSessions } from "@/server/services/root-two-factor";

export async function resetUserPassword(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  if (!session.user.isRootAdmin) {
    throw new ApiError("FORBIDDEN", "Root admin required");
  }

  const { userId, newPassword, adminPassword } = rawBody as { userId?: unknown; newPassword?: string; adminPassword?: string };

  if (!userId || !newPassword || newPassword.length < 8 || !adminPassword) {
    throw new ApiError("VALIDATION", "userId, newPassword (min 8 chars), and adminPassword required");
  }

  // Verify root admin's own password first
  const [admin] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.user.dbId))
    .limit(1);

  if (!admin?.passwordHash) {
    throw new ApiError("VALIDATION", "Admin account has no password set");
  }

  const adminValid = await bcrypt.compare(adminPassword, admin.passwordHash);
  if (!adminValid) {
    throw new ApiError("FORBIDDEN", "Admin password incorrect");
  }

  // Verify target user exists
  const [targetUser] = await db
    .select({ id: users.id, companyId: users.companyId, isRootAdmin: users.isRootAdmin })
    .from(users)
    .where(eq(users.id, Number(userId)))
    .limit(1);

  if (!targetUser) {
    throw new ApiError("NOT_FOUND", "User not found");
  }
  // [2026-10-25] Another root's password is never force-reset from the app: that is the one move
  // that would let one compromised root take over every other root. Self-service /api/admin/password
  // and the owner's break-glass remain.
  if (targetUser.isRootAdmin && targetUser.id !== session.user.dbId) {
    throw new ApiError("FORBIDDEN", "A root admin's password cannot be force-reset; use self-service or break-glass");
  }

  // Reset the target user's password
  const newHash = await bcrypt.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, targetUser.id));

  if (targetUser.isRootAdmin) await revokeRootTwoFactorSessions(targetUser.id, "password_force_reset");
  audit("user_password_force_reset", {
    userId: session.user.dbId,
    companyId: session.user.companyId,
    details: { targetUserId: targetUser.id, targetCompanyId: targetUser.companyId },
  });

  return { success: true };
}
