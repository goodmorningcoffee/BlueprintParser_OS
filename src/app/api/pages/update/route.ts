import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const { projectId, pageNumber, name } = await req.json();

  if (!projectId || !pageNumber || !name) {
    return NextResponse.json(
      { error: "projectId, pageNumber, and name are required" },
      { status: 400 }
    );
  }

  // Verify project ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db
    .update(pages)
    .set({ name })
    .where(
      and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber))
    );

  return NextResponse.json({ success: true });
}
