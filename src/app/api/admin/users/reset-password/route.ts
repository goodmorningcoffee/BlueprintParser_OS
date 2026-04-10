import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";

/**
 * POST /api/admin/users/reset-password
 *
 * Root admin force-resets a user's password. Requires the root admin
 * to confirm their OWN password as a security measure.
 */
export async function POST(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  if (!session.user.isRootAdmin) {
    return NextResponse.json({ error: "Root admin required" }, { status: 403 });
  }

  const { userId, newPassword, adminPassword } = await req.json();

  if (!userId || !newPassword || newPassword.length < 8 || !adminPassword) {
    return NextResponse.json(
      { error: "userId, newPassword (min 8 chars), and adminPassword required" },
      { status: 400 },
    );
  }

  // Verify root admin's own password first
  const [admin] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.user.dbId))
    .limit(1);

  if (!admin?.passwordHash) {
    return NextResponse.json({ error: "Admin account has no password set" }, { status: 400 });
  }

  const adminValid = await bcrypt.compare(adminPassword, admin.passwordHash);
  if (!adminValid) {
    return NextResponse.json({ error: "Admin password incorrect" }, { status: 403 });
  }

  // Verify target user exists
  const [targetUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, Number(userId)))
    .limit(1);

  if (!targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Reset the target user's password
  const newHash = await bcrypt.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, targetUser.id));

  return NextResponse.json({ success: true });
}
