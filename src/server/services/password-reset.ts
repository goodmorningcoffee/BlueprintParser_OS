// [refactor jul6 S036] password pair route contracts (forgot + reset), folded from the
// legacy routes (git show HEAD^:src/app/api/auth/{forgot,reset}-password/route.ts at the
// freeze). Char: __tests__/password-reset.route.test.ts (WQ-1/WQ-2). SECURITY-PRESERVED:
//   • forgot NO-LEAK: unknown email → {success:true}, no token written; raw token goes to
//     email ONLY, the SHA-256 hash is what's stored; 1h expiry; the email-send failure is
//     SWALLOWED (success anyway — token saved; admin can retrieve the link).
//   • reset: SPLIT password-rule messages (deliberately different from register's combined
//     message — do not harmonize); hashed-token + UNEXPIRED lookup; bad ≡ expired = the
//     same "Invalid or expired reset link" (no state leak); bcrypt(12); token+expiry
//     CLEARED (single-use); audit("password_reset").
//   • Both FIXED "Failed" catch-alls RETIRED (S015 class; diff B — genuine failures →
//     shell generic INTERNAL 500); malformed bodies → shell 400 (diff E).

import crypto from "crypto";
import bcrypt from "bcrypt";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { sendPasswordResetEmail } from "@/lib/email";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/api/envelope";

export async function forgotPassword(rawBody: Record<string, unknown>): Promise<unknown> {
  const { email } = rawBody as { email?: unknown };
  if (!email || typeof email !== "string") {
    throw new ApiError("VALIDATION", "Email required");
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Always return success (don't leak whether email exists)
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
  if (!user) {
    return { success: true };
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

  return { success: true };
}

export async function resetPassword(rawBody: Record<string, unknown>): Promise<unknown> {
  const { token, password } = rawBody as { token?: string; password?: string };
  if (!token || !password) {
    throw new ApiError("VALIDATION", "Token and password required");
  }

  // Validate password strength (same rules as registration)
  if (password.length < 10) {
    throw new ApiError("VALIDATION", "Password must be at least 10 characters");
  }
  if (!/[A-Z]/.test(password)) {
    throw new ApiError("VALIDATION", "Password must contain at least one uppercase letter");
  }
  if (!/\d/.test(password)) {
    throw new ApiError("VALIDATION", "Password must contain at least one digit");
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
    throw new ApiError("VALIDATION", "Invalid or expired reset link");
  }

  // Update password and clear reset token
  const passwordHash = await bcrypt.hash(password, 12);
  await db.update(users).set({
    passwordHash,
    passwordResetToken: null,
    passwordResetExpires: null,
  }).where(eq(users.id, user.id));

  audit("password_reset", { userId: user.id, companyId: user.companyId, details: { email: user.email } });

  return { success: true };
}
