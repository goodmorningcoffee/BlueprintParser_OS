import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { sendPasswordResetEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  try {
    const { email } = await req.json();
    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Always return success (don't leak whether email exists)
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
    if (!user) {
      return NextResponse.json({ success: true });
    }

    // Generate token: raw token sent via email, SHA-256 hash stored in DB
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.update(users).set({
      passwordResetToken: hashedToken,
      passwordResetExpires: expires,
    }).where(eq(users.id, user.id));

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const resetUrl = `${baseUrl}/reset-password?token=${rawToken}`;

    try {
      await sendPasswordResetEmail(normalizedEmail, resetUrl);
    } catch (emailErr) {
      logger.error("Failed to send reset email", emailErr);
      // Still return success — token is saved, admin can retrieve the link
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("Forgot password error", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
