import { NextResponse } from "next/server";

/**
 * GET /api/demo/labeling/credentials
 *
 * Public endpoint — returns LS credentials for demo users.
 * Same shared admin account. Demo users can browse LS but
 * can't create new projects (create endpoint requires auth).
 */
export async function GET() {
  const email = process.env.LABEL_STUDIO_ADMIN_EMAIL;
  const password = process.env.LABEL_STUDIO_ADMIN_PASSWORD;

  if (!email || !password) {
    return NextResponse.json({ error: "Label Studio not configured" }, { status: 503 });
  }

  return NextResponse.json({ email, password });
}
