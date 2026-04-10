import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * GET /api/labeling/credentials
 *
 * Returns Label Studio login credentials for authenticated BP users.
 * Credentials come from server env vars — never hardcoded in frontend.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || (session.user.role !== "admin" && !session.user.isRootAdmin)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const email = process.env.LABEL_STUDIO_ADMIN_EMAIL;
  const password = process.env.LABEL_STUDIO_ADMIN_PASSWORD;

  if (!email || !password) {
    return NextResponse.json({ error: "Label Studio not configured" }, { status: 503 });
  }

  return NextResponse.json({ email, password });
}
