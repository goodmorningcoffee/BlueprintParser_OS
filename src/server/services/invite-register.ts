// [refactor jul6 S034] invite + register route contracts (both PUBLIC), folded from the
// legacy routes (git show d7c190a^:src/app/api/{invite,register}/route.ts). Char:
// __tests__/invite-register.route.test.ts (IQ-1/IQ-2).
//   • IQ-1 invite (public request form; docs mislabel it admin — P1 ledger): the email
//     regex runs on the RAW string (space-padded REJECTED — the insert's .trim() is dead
//     in practice; kept verbatim anyway). FIXED "Failed to submit" catch RETIRED (diff B
//     — S015 fixed-literal class; db failures → shell generic INTERNAL 500).
//   • IQ-2 register: cascade byte-exact (fields → ≥10 → charset). SECURITY-SENSITIVE and
//     BYTE-PRESERVED: the full-table access-key scan supporting bcrypt "$2" hashes AND
//     plaintext timingSafeEqual (migration-era dual support); the no-reveal generic 400
//     ("Invalid access key or email already in use") for bad-key AND email-exists —
//     never differentiate. bcrypt.hash(12); role:"member"; audit("user_registered").
//   • Diff E: body-parse to the shell (invite's malformed-body-into-fixed-500 → clean
//     400; register's raw rejection → clean 400).

import { timingSafeEqual } from "crypto";
import bcrypt from "bcrypt";
import { db } from "@/lib/db";
import { users, companies, inviteRequests } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { isReservedRootBootstrapEmail } from "@/lib/root-bootstrap-email";
import { ApiError } from "@/server/api/envelope";

export async function inviteRequest(rawBody: Record<string, unknown>): Promise<unknown> {
  const { email, name, company } = rawBody as { email?: unknown; name?: string; company?: string };

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || typeof email !== "string" || !emailRegex.test(email) || email.length > 254) {
    throw new ApiError("VALIDATION", "Valid email required");
  }

  await db.insert(inviteRequests).values({
    email: email.trim().toLowerCase().slice(0, 254),
    name: name?.trim()?.slice(0, 100) || null,
    company: company?.trim()?.slice(0, 100) || null,
  });

  return { success: true };
}

export async function registerUser(rawBody: Record<string, unknown>): Promise<unknown> {
  const { username, email: rawEmail, password, accessKey } = rawBody as {
    username?: string; email?: unknown; password?: string; accessKey?: string;
  };
  const email = typeof rawEmail === "string" ? rawEmail.toLowerCase().trim() : "";

  if (!username || !email || !password || !accessKey) {
    throw new ApiError("VALIDATION", "All fields are required");
  }

  if (password.length < 10) {
    throw new ApiError("VALIDATION", "Password must be at least 10 characters");
  }

  if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new ApiError("VALIDATION", "Password must contain at least one uppercase letter and one number");
  }

  // Find company by access key — compare all keys with bcrypt
  const allCompanies = await db.select().from(companies);
  let company = null;
  for (const c of allCompanies) {
    // Support both hashed and plaintext keys during migration
    const isHashed = c.accessKey.startsWith("$2");
    let match: boolean;
    if (isHashed) {
      match = await bcrypt.compare(accessKey, c.accessKey);
    } else {
      // Timing-safe comparison for plaintext keys
      match = c.accessKey.length === accessKey.length &&
        timingSafeEqual(Buffer.from(c.accessKey), Buffer.from(accessKey));
    }
    if (match) {
      company = c;
      break;
    }
  }

  if (!company) {
    // Generic message — don't reveal whether key or email was wrong
    throw new ApiError("VALIDATION", "Invalid access key or email already in use");
  }

  // [2026-10-25] The ROOT_ADMIN_EMAIL bootstrap address can never be self-registered (same
  // generic message: no enumeration of the owner's address).
  if (isReservedRootBootstrapEmail(email)) {
    throw new ApiError("VALIDATION", "Invalid access key or email already in use");
  }

  // Check if email already exists
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    // Same generic message
    throw new ApiError("VALIDATION", "Invalid access key or email already in use");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await db.insert(users).values({
    username,
    email,
    passwordHash,
    companyId: company.id,
    role: "member",
  });

  audit("user_registered", { companyId: company.id, details: { email, username } });

  return { success: true };
}
