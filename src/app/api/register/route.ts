import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import bcrypt from "bcrypt";
import { db } from "@/lib/db";
import { users, companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { audit } from "@/lib/audit";

export async function POST(req: Request) {
  const { username, email, password, accessKey } = await req.json();

  if (!username || !email || !password || !accessKey) {
    return NextResponse.json(
      { error: "All fields are required" },
      { status: 400 }
    );
  }

  if (password.length < 10) {
    return NextResponse.json(
      { error: "Password must be at least 10 characters" },
      { status: 400 }
    );
  }

  if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return NextResponse.json(
      { error: "Password must contain at least one uppercase letter and one number" },
      { status: 400 }
    );
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
    return NextResponse.json(
      { error: "Invalid access key or email already in use" },
      { status: 400 }
    );
  }

  // Check if email already exists
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    // Same generic message
    return NextResponse.json(
      { error: "Invalid access key or email already in use" },
      { status: 400 }
    );
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

  return NextResponse.json({ success: true });
}
