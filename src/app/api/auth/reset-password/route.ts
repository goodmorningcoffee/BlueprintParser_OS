import { NextResponse } from "next/server";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  try {
    const { token, password } = await req.json();
    if (!token || !password) {
      return NextResponse.json({ error: "Token and password required" }, { status: 400 });
    }

    // Validate password strength (same rules as registration)
    if (password.length < 10) {
      return NextResponse.json({ error: "Password must be at least 10 characters" }, { status: 400 });
    }
    if (!/[A-Z]/.test(password)) {
      return NextResponse.json({ error: "Password must contain at least one uppercase letter" }, { status: 400 });
    }
    if (!/\d/.test(password)) {
      return NextResponse.json({ error: "Password must contain at least one digit" }, { status: 400 });
    }

    // Hash the incoming token and find matching user
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const [user] = await db.select({ id: users.id, email: users.email, companyId: users.companyId })
      .from(users)
      .where(and(
        eq(users.passwordResetToken, hashedToken),
        gt(users.passwordResetExpires, new Date()),
      ))
      .limit(1);

    if (!user) {
      return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 });
    }

    // Update password and clear reset token
    const passwordHash = await bcrypt.hash(password, 12);
    await db.update(users).set({
      passwordHash,
      passwordResetToken: null,
      passwordResetExpires: null,
    }).where(eq(users.id, user.id));

    audit("password_reset", { userId: user.id, companyId: user.companyId, details: { email: user.email } });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("Reset password error", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
