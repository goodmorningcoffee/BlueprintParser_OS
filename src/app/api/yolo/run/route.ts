import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, models, processingJobs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { startYoloJob } from "@/lib/yolo";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { uploadToS3, getS3Url } from "@/lib/s3";
import { checkYoloQuota } from "@/lib/quotas";
import { audit } from "@/lib/audit";
import { getToggles } from "@/lib/toggles";

export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;
  if (!session.user.canRunModels) {
    return NextResponse.json({ error: "You don't have permission to run models. Ask your admin to enable it." }, { status: 403 });
  }

  // Check SageMaker toggle (persisted in S3) — always read fresh for safety
  const toggles = await getToggles(true);
  if (!toggles.sagemakerEnabled) {
    return NextResponse.json({ error: "SageMaker is disabled by admin. Enable it in Admin > Toggles." }, { status: 403 });
  }

  // Check YOLO job quota
  if (toggles.quotaEnabled) {
    const quota = await checkYoloQuota(session.user.companyId);
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }
  }

  const { projectId, modelId } = await req.json();

  if (!projectId || !modelId) {
    return NextResponse.json(
      { error: "projectId and modelId required" },
      { status: 400 }
    );
  }

  // Verify project
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

  // Get model
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, modelId))
    .limit(1);

  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  try {
    // Download PDF
    const pdfUrl = getS3Url(project.dataUrl, "original.pdf");
    let pdfBuffer: Buffer;
    try {
      const pdfResponse = await fetch(pdfUrl);
      if (!pdfResponse.ok) throw new Error(`HTTP ${pdfResponse.status}`);
      pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      return NextResponse.json(
        { error: `Failed to download PDF: ${msg}` },
        { status: 500 }
      );
    }

    // Rasterize pages and upload to S3
    const projectPages = await db
      .select({ pageNumber: pages.pageNumber })
      .from(pages)
      .where(eq(pages.projectId, project.id))
      .orderBy(pages.pageNumber);

    // Rasterize pages in parallel (batches of 10 to avoid OOM)
    try {
      const BATCH = 10;
      for (let i = 0; i < projectPages.length; i += BATCH) {
        const batch = projectPages.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (page) => {
            const pngBuffer = await rasterizePage(pdfBuffer, page.pageNumber, 200);
            await uploadToS3(
              `${project.dataUrl}/images/page_${String(page.pageNumber).padStart(4, "0")}.png`,
              pngBuffer,
              "image/png"
            );
          })
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      return NextResponse.json(
        { error: `Failed to rasterize pages: ${msg}` },
        { status: 500 }
      );
    }

    // Start SageMaker job
    let jobName: string;
    try {
      jobName = await startYoloJob(
        project.dataUrl,
        model.s3Path,
        model.name
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      return NextResponse.json(
        { error: `Failed to start SageMaker job: ${msg}` },
        { status: 500 }
      );
    }

    // Track job
    await db.insert(processingJobs).values({
      projectId: project.id,
      executionId: jobName,
      status: "running",
      modelConfig: { modelId: model.id, modelName: model.name },
    });

    audit("yolo_job_started", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { projectId, modelId, jobName },
    });

    return NextResponse.json({ jobName, status: "running" });
  } catch (err) {
    console.error("YOLO job start failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start YOLO" },
      { status: 500 }
    );
  }
}
