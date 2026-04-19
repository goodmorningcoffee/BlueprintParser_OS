import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, processingJobs, companies } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { processProject } from "@/lib/processing";
import { getS3Url, headS3Object } from "@/lib/s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { checkUploadQuota } from "@/lib/quotas";
import { logger } from "@/lib/logger";
import type { StagingFile } from "@/types";

const PROJECT_AGGREGATE_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
const PROJECT_MAX_FILES = 30;

export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const { name, dataUrl, stagingFiles } = await req.json();

  if (!name || !dataUrl) {
    return NextResponse.json(
      { error: "Name and dataUrl required" },
      { status: 400 }
    );
  }

  // Check upload quota
  const quota = await checkUploadQuota(session.user.companyId, session.user.role);
  if (!quota.allowed) {
    return NextResponse.json({ error: quota.message }, { status: 429 });
  }

  // Validate the multi-file staging manifest if provided. Legacy single-PDF
  // uploads (staging-less) pass stagingFiles=undefined and skip this block —
  // `processing.ts` then expects `original.pdf` to already exist at dataUrl.
  let stagingManifest: StagingFile[] | undefined;
  if (stagingFiles !== undefined) {
    if (!Array.isArray(stagingFiles) || stagingFiles.length === 0) {
      return NextResponse.json(
        { error: "stagingFiles must be a non-empty array" },
        { status: 400 },
      );
    }
    if (stagingFiles.length > PROJECT_MAX_FILES) {
      return NextResponse.json(
        { error: `Maximum ${PROJECT_MAX_FILES} files per project` },
        { status: 400 },
      );
    }
    const stagingPrefix = `${dataUrl}/staging/`;
    for (const sf of stagingFiles as Array<{ filename?: unknown; stagingKey?: unknown }>) {
      if (
        !sf ||
        typeof sf.filename !== "string" ||
        typeof sf.stagingKey !== "string" ||
        !sf.stagingKey.startsWith(stagingPrefix)
      ) {
        return NextResponse.json(
          { error: "Each stagingFile needs filename + stagingKey under dataUrl/staging/" },
          { status: 400 },
        );
      }
    }

    // Confirm every staged upload landed + collect sizes. Parallel HeadObject
    // keeps the common case fast (~one AWS RTT per file, overlapped).
    const heads = await Promise.all(
      (stagingFiles as Array<{ filename: string; stagingKey: string }>).map(async (sf) => {
        const head = await headS3Object(sf.stagingKey);
        return { ...sf, head };
      }),
    );
    for (const h of heads) {
      if (!h.head.exists) {
        return NextResponse.json(
          { error: `Staged file missing in S3: ${h.filename}` },
          { status: 400 },
        );
      }
    }

    const totalBytes = heads.reduce((sum, h) => sum + (h.head.size ?? 0), 0);
    if (totalBytes > PROJECT_AGGREGATE_MAX_BYTES) {
      return NextResponse.json(
        {
          error: `Project exceeds ${PROJECT_AGGREGATE_MAX_BYTES / (1024 * 1024)} MB cap (got ${Math.round(totalBytes / (1024 * 1024))} MB)`,
        },
        { status: 413 },
      );
    }

    stagingManifest = heads.map((h) => ({
      filename: h.filename,
      stagingKey: h.stagingKey,
      size: h.head.size ?? 0,
    }));
  }

  const [project] = await db
    .insert(projects)
    .values({
      name,
      dataUrl,
      status: "uploading",
      authorId: session.user.dbId,
      companyId: session.user.companyId,
      ...(stagingManifest && { stagingManifest }),
    })
    .returning();

  // Trigger processing pipeline
  if (process.env.STEP_FUNCTION_ARN) {
    // Production: start Step Functions execution (ECS task processes in background)
    try {
      const sfnClient = new SFNClient({
        region: process.env.AWS_REGION || "us-east-1",
      });
      const executionName = `proj-${project.id}-${Date.now()}`;

      const sfnResponse = await sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn: process.env.STEP_FUNCTION_ARN,
          name: executionName,
          input: JSON.stringify({
            projectId: project.id,
            dataUrl: project.dataUrl,
            s3Bucket: process.env.S3_BUCKET,
            webhookUrl: `${process.env.NEXTAUTH_URL}/api/processing/webhook`,
            webhookSecret: process.env.PROCESSING_WEBHOOK_SECRET,
          }),
        })
      );

      await db.insert(processingJobs).values({
        projectId: project.id,
        stepFunctionArn: process.env.STEP_FUNCTION_ARN,
        executionId: sfnResponse.executionArn || null,
        status: "running",
      });

      await db
        .update(projects)
        .set({ status: "processing", jobId: executionName })
        .where(eq(projects.id, project.id));
    } catch (err) {
      logger.error("Step Functions start failed:", err);
      await db
        .update(projects)
        .set({
          status: "error",
          processingError: err instanceof Error ? err.message : "Failed to start processing",
        })
        .where(eq(projects.id, project.id));
    }
  } else if (
    process.env.NODE_ENV !== "production" ||
    process.env.DEV_PROCESSING_ENABLED === "true"
  ) {
    // Dev mode: call processing logic directly (fire-and-forget)
    processProject(project.id).catch((err) =>
      logger.error("Processing failed:", err)
    );
  }

  return NextResponse.json({
    id: project.publicId,
    name: project.name,
    status: project.status,
  });
}

export async function GET() {
  const { session, error } = await requireAuth();
  if (error) return error;

  const allProjects = await db
    .select()
    .from(projects)
    .where(session.user.isRootAdmin ? undefined : eq(projects.companyId, session.user.companyId))
    .orderBy(projects.createdAt);

  // Get actual page counts in a single query
  const pageCounts: Record<number, number> = {};
  if (allProjects.length > 0) {
    const countResult = await db.execute(sql`
      SELECT project_id, COUNT(*)::int AS cnt FROM pages GROUP BY project_id
    `);
    for (const row of countResult.rows as any[]) pageCounts[row.project_id] = row.cnt;
  }

  // For root admin: fetch company names for grouping
  let companyNames: Record<number, string> = {};
  if (session.user.isRootAdmin) {
    const allCompanies = await db.select({ id: companies.id, name: companies.name }).from(companies);
    for (const c of allCompanies) companyNames[c.id] = c.name;
  }

  return NextResponse.json(
    allProjects.map((p) => ({
      id: p.publicId,
      name: p.name,
      numPages: pageCounts[p.id] || p.numPages || 0,
      status: p.status,
      pagesProcessed: pageCounts[p.id] || null,
      dataUrl: p.dataUrl,
      thumbnailUrl:
        p.status === "completed" ? getS3Url(p.dataUrl, "thumbnail.png") : null,
      isDemo: p.isDemo,
      createdAt: p.createdAt,
      companyId: session.user.isRootAdmin ? p.companyId : undefined,
      companyName: session.user.isRootAdmin ? companyNames[p.companyId] : undefined,
    }))
  );
}
