import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createUploadPresignedPost, generateProjectPath } from "@/lib/s3";

export async function GET() {
  const { session, error } = await requireAuth();
  if (error) return error;

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  const projectPath = generateProjectPath(company.dataKey);
  const presigned = await createUploadPresignedPost(projectPath);

  return NextResponse.json(presigned);
}
