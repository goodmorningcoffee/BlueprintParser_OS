import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { db } from "@/lib/db";
import { projects, labelingSessions } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getS3Url, downloadFromS3, uploadToS3 } from "@/lib/s3";
import { createProject, importTasks } from "@/lib/label-studio";
import { logger } from "@/lib/logger";

const DEFAULT_LABEL_CONFIG = `<View>
  <Image name="image" value="$image" zoomControl="true" rotateControl="true"/>
</View>`;

export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const { projectId, pagesPerProject, pageSelection, pageRange, tiling } =
    await req.json();

  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const safePagesPerProject = Math.max(2, Math.min(pagesPerProject || 10, 50));

  // Verify project ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(
      session.user.isRootAdmin
        ? eq(projects.publicId, projectId)
        : and(eq(projects.publicId, projectId), eq(projects.companyId, session.user.companyId))
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Runtime kill-switch — admin can disable labeling on demo projects via
  // the Demo Features panel. Full admin ownership bypasses intentionally.
  if (project.isDemo && !session.user.isRootAdmin) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "labeling");
    if (gate) return gate;
  }

  // Rate limit: max 10 labeling sessions per company per day (admin bypasses)
  if (session.user.role !== "admin") {
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
  }

  // Check Label Studio env vars are configured
  if (!process.env.LABEL_STUDIO_URL || !process.env.LABEL_STUDIO_API_KEY) {
    return NextResponse.json(
      { error: "Label Studio not configured. Set LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY." },
      { status: 503 }
    );
  }

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

  // Build tasks — either direct CloudFront URLs or tiled images
  let tasks: Array<{ data: { image: string }; meta: Record<string, number> }>;

  if (tiling) {
    const sharp = (await import("sharp")).default;
    tasks = [];
    // Process in batches of 5 for performance
    const batchSize = 5;
    for (let b = 0; b < pageNumbers.length; b += batchSize) {
      const batch = pageNumbers.slice(b, b + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (pageNum) => {
          const key = `${project.dataUrl}/pages/page_${pageNum}.png`;
          const buffer = await downloadFromS3(key);
          const metadata = await sharp(buffer).metadata();
          const tileW = Math.floor((metadata.width || 3000) / 3);
          const tileH = Math.floor((metadata.height || 2000) / 3);
          const tileTasks: typeof tasks = [];

          for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
              const tileBuffer = await sharp(buffer)
                .extract({ left: col * tileW, top: row * tileH, width: tileW, height: tileH })
                .png()
                .toBuffer();
              const tileKey = `${project.dataUrl}/tiles/page_${pageNum}_r${row}_c${col}.png`;
              await uploadToS3(tileKey, tileBuffer, "image/png");
              const url = getS3Url(project.dataUrl, `tiles/page_${pageNum}_r${row}_c${col}.png`);
              tileTasks.push({ data: { image: url }, meta: { pageNumber: pageNum, row, col } });
            }
          }
          return tileTasks;
        })
      );
      tasks.push(...batchResults.flat());
    }
  } else {
    tasks = pageNumbers.map((pageNum) => ({
      data: { image: getS3Url(project.dataUrl, `pages/page_${pageNum}.png`) },
      meta: { pageNumber: pageNum },
    }));
  }

  // Split into chunks based on pagesPerProject
  const chunks: typeof tasks[] = [];
  for (let i = 0; i < tasks.length; i += safePagesPerProject) {
    chunks.push(tasks.slice(i, i + safePagesPerProject));
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
      // Determine page range for this chunk
      const chunkPages = [...new Set(chunk.map((t) => t.meta.pageNumber))].sort((a, b) => a - b);
      const range = chunkPages.length === 1
        ? String(chunkPages[0])
        : `${chunkPages[0]}-${chunkPages[chunkPages.length - 1]}`;

      const title =
        chunks.length === 1
          ? project.name
          : `${project.name} (pages ${range})`;

      // Create LS project with default image-only config
      const lsProject = await createProject(title, DEFAULT_LABEL_CONFIG);

      // Import tasks with CloudFront URLs
      await importTasks(lsProject.id, chunk);

      const projectUrl = `${lsUrl}/projects/${lsProject.id}`;

      // Store session record
      const [record] = await db
        .insert(labelingSessions)
        .values({
          projectId: project.id,
          companyId: project.companyId,
          labelStudioProjectId: lsProject.id,
          labelStudioUrl: projectUrl,
          taskType: "generic",
          labels: null,
          pageRange: range,
          tilingEnabled: !!tiling,
          tileGrid: tiling ? 3 : null,
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
    logger.error("[LABELING] Failed to create:", err);
    return NextResponse.json(
      { error: `Failed to create Label Studio project: ${err.message}` },
      { status: 500 }
    );
  }
}
