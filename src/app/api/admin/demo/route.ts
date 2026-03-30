import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const body = await req.json();

  // Refresh all demo projects (bust caches, confirm sync)
  if (body.action === "refresh") {
    const result = await db
      .update(projects)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(projects.isDemo, true),
          eq(projects.companyId, session.user.companyId)
        )
      )
      .returning({ id: projects.id });

    return NextResponse.json({ success: true, refreshed: result.length });
  }

  const { projectId, isDemo } = body;

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
