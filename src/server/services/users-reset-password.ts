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
import { ApiError } from "@/server/api/envelope";

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
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, Number(userId)))
    .limit(1);

  if (!targetUser) {
    throw new ApiError("NOT_FOUND", "User not found");
  }

  // Reset the target user's password
  const newHash = await bcrypt.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, targetUser.id));

  return { success: true };
}
