import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { projectId, isDemo } = await req.json();

  if (!projectId || typeof isDemo !== "boolean") {
    return NextResponse.json({ error: "projectId and isDemo required" }, { status: 400 });
  }

  await db
    .update(projects)
    .set({ isDemo, updatedAt: new Date() })
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.companyId, session.user.companyId)
      )
    );

  return NextResponse.json({ success: true });
}
