import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, labelingSessions } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getPresignedGetUrl } from "@/lib/s3";
import { generateLabelConfig } from "@/lib/labeling-config";
import { createProject, importTasks } from "@/lib/label-studio";
import type { LabelingTaskType } from "@/lib/labeling-config";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId, taskType, labels, pagesPerProject, pageSelection, pageRange, projectName } =
    await req.json();

  if (!projectId || !taskType || (taskType !== "text" && !labels?.length)) {
    return NextResponse.json(
      { error: "projectId, taskType, and labels required" },
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
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Rate limit: max 10 labeling sessions per company per day
  const todayCount = await db.execute(
    sql`SELECT COUNT(*)::int AS cnt FROM labeling_sessions
        WHERE company_id = ${session.user.companyId}
          AND created_at > NOW() - INTERVAL '1 day'`
  );
  if ((todayCount.rows[0] as any)?.cnt >= 10) {
    return NextResponse.json(
      { error: "Daily labeling limit reached (10 projects/day)" },
      { status: 429 }
    );
  }

  // Check Label Studio env vars are configured
  if (!process.env.LABEL_STUDIO_URL || !process.env.LABEL_STUDIO_API_KEY) {
    return NextResponse.json(
      { error: "Label Studio not configured. Set LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY." },
      { status: 503 }
    );
  }

  // Generate labeling config XML
  const labelConfig = generateLabelConfig(taskType as LabelingTaskType, labels);

  // Determine which pages to include
  const numPages = project.numPages || 1;
  let pageNumbers: number[] = [];

  if (pageSelection === "current" && pageRange) {
    pageNumbers = [parseInt(pageRange)];
  } else if (pageSelection === "range" && pageRange) {
    const [start, end] = pageRange.split("-").map(Number);
    for (let i = start; i <= Math.min(end, numPages); i++) pageNumbers.push(i);
  } else {
    for (let i = 1; i <= numPages; i++) pageNumbers.push(i);
  }

  // Generate presigned URLs for each page image (24h TTL)
  const presignedTasks = await Promise.all(
    pageNumbers.map(async (pageNum) => {
      const key = `${project.dataUrl}/images/page_${pageNum}.png`;
      const url = await getPresignedGetUrl(key);
      return { data: { image: url }, meta: { pageNumber: pageNum } };
    })
  );

  // Split into chunks based on pagesPerProject
  const chunkSize = pagesPerProject || pageNumbers.length;
  const chunks: typeof presignedTasks[] = [];
  for (let i = 0; i < presignedTasks.length; i += chunkSize) {
    chunks.push(presignedTasks.slice(i, i + chunkSize));
  }

  const lsUrl = process.env.LABEL_STUDIO_URL.replace(/\/$/, "");
  const sessions: Array<{
    id: number;
    labelStudioProjectId: number;
    labelStudioUrl: string;
    pageRange: string;
    taskCount: number;
  }> = [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const firstPage = pageNumbers[i * chunkSize];
      const lastPage = pageNumbers[Math.min((i + 1) * chunkSize - 1, pageNumbers.length - 1)];
      const range = `${firstPage}-${lastPage}`;

      const title =
        chunks.length === 1
          ? (projectName || project.name)
          : `${projectName || project.name} (pages ${range})`;

      // Create LS project
      const lsProject = await createProject(title, labelConfig);

      // Import tasks with presigned URLs
      await importTasks(lsProject.id, chunk);

      const projectUrl = `${lsUrl}/projects/${lsProject.id}`;

      // Store session record
      const [record] = await db
        .insert(labelingSessions)
        .values({
          projectId: project.id,
          companyId: session.user.companyId,
          labelStudioProjectId: lsProject.id,
          labelStudioUrl: projectUrl,
          taskType,
          labels,
          pageRange: range,
          status: "active",
        })
        .returning();

      sessions.push({
        id: record.id,
        labelStudioProjectId: lsProject.id,
        labelStudioUrl: projectUrl,
        pageRange: range,
        taskCount: chunk.length,
      });
    }

    return NextResponse.json({ success: true, sessions });
  } catch (err: any) {
    console.error("[LABELING] Failed to create:", err);
    return NextResponse.json(
      { error: `Failed to create Label Studio project: ${err.message}` },
      { status: 500 }
    );
  }
}
