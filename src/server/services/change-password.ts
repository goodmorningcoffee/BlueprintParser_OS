// [refactor jul8 S060] admin/password SOLO — POST self-service password change, folded from
// the legacy route (git show e67a863:src/app/api/admin/password/route.ts). Char:
// __tests__/admin-password.route.test.ts (PW-*).
// ⚠️ requireAuth NOT requireAdmin — ANY signed-in user changes THEIR OWN password (scoped to
// session.user.dbId). The shell is auth:"session"; mounting it auth:"admin" would lock members
// out of self-service (PW-1 pins a member reaching this handler). Sanctioned diffs:
//   • A — the flat {error} literals → envelope, byte-verbatim + status preserved:
//     "Current and new password required (min 8 chars)"@400 (ONE combined literal) ·
//     "User not found"@404 · "No password set for this account"@400 ·
//     "Current password is incorrect"@400 (+ auth 401 "Unauthorized").
//   • E — legacy `await req.json()` (no catch) subsumed by the shell raw-parse.
//   • NO B — no catch-500 existed; the shell generic INTERNAL 500 is new uniform wrapping.
// PRESERVED verbatim: the combined-validation short-circuit; self-lookup by dbId (the
// deleted-user-live-session 404); bcrypt.compare gate before any write; bcrypt.hash(,12) +
// updatedAt on success.

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { ApiError } from "@/server/api/envelope";
import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { revokeRootTwoFactorSessions } from "@/server/services/root-two-factor";

export async function changePassword(session: AuthSession, body: Record<string, unknown>): Promise<unknown> {
  const { currentPassword, newPassword } = body as { currentPassword?: string; newPassword?: string };

  if (!currentPassword || !newPassword || newPassword.length < 8) {
    throw new ApiError("VALIDATION", "Current and new password required (min 8 chars)");
  }

  // Verify current password
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.user.dbId))
    .limit(1);

  if (!user) {
    throw new ApiError("NOT_FOUND", "User not found");
  }

  if (!user.passwordHash) {
    throw new ApiError("VALIDATION", "No password set for this account");
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    throw new ApiError("VALIDATION", "Current password is incorrect");
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // [2026-10-25] A root's other verified sessions must re-prove a code after a password change.
  if (session.user.isRootAdmin) await revokeRootTwoFactorSessions(user.id, "password_changed");
  audit("password_changed", { userId: user.id, companyId: session.user.companyId });

  return { success: true };
}
