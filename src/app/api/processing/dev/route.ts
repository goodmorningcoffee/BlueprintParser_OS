import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { processProject } from "@/lib/processing";

/**
 * Dev-mode processing route.
 * Manually trigger processing for a project (for testing or re-processing).
 *
 * POST /api/processing/dev
 * Body: { projectId: string }
 */
export async function POST(req: Request) {
  // Guard: only allow in dev mode
  if (
    process.env.NODE_ENV === "production" &&
    process.env.DEV_PROCESSING_ENABLED !== "true"
  ) {
    return NextResponse.json(
      { error: "Dev processing not enabled" },
      { status: 403 }
    );
  }

  const { session, error } = await requireAuth();
  if (error) return error;

  const { projectId } = await req.json();
  if (!projectId) {
    return NextResponse.json(
      { error: "projectId required" },
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

  try {
    const result = await processProject(project.id);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Processing failed" },
      { status: 500 }
    );
  }
}
