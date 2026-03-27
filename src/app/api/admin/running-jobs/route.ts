import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { processingJobs, projects } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";

/**
 * GET /api/admin/running-jobs
 * Returns YOLO jobs with status='running' for the admin's company.
 * Used to resume polling after navigating away from admin panel.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  try {
    const rows = await db.execute(sql`
      SELECT
        pj.id,
        pj.execution_id AS "executionId",
        pj.model_config AS "modelConfig",
        pj.started_at AS "startedAt",
        p.public_id AS "projectPublicId"
      FROM processing_jobs pj
      JOIN projects p ON pj.project_id = p.id
      WHERE p.company_id = ${session.user.companyId}
        AND pj.status = 'running'
        AND pj.model_config IS NOT NULL
      ORDER BY pj.started_at DESC
    `);

    const jobs = (rows.rows as any[]).map((r) => ({
      projectPublicId: r.projectPublicId,
      executionId: r.executionId,
      modelId: r.modelConfig?.modelId,
      modelName: r.modelConfig?.modelName,
      startedAt: r.startedAt,
    }));

    return NextResponse.json(jobs);
  } catch {
    return NextResponse.json([]);
  }
}

/**
 * PUT /api/admin/running-jobs
 * Update a job's status when polling detects completion.
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { executionId, status } = await req.json();
  if (!executionId || !status) {
    return NextResponse.json({ error: "executionId and status required" }, { status: 400 });
  }

  const dbStatus = status === "Completed" ? "completed" : status === "Failed" || status === "Stopped" ? "failed" : null;
  if (!dbStatus) {
    return NextResponse.json({ error: "Invalid terminal status" }, { status: 400 });
  }

  await db
    .update(processingJobs)
    .set({ status: dbStatus, completedAt: new Date() })
    .where(eq(processingJobs.executionId, executionId));

  return NextResponse.json({ success: true });
}
