// [refactor jul6 S035] processing family route contracts (webhook + dev), folded from the
// legacy routes (git show HEAD^:src/app/api/processing/*/route.ts at the freeze). Named
// processing-routes.ts — @/lib/processing (the ingest ENGINE, byte-untouched) keeps its
// name. Char: __tests__/processing.route.test.ts (PQ5-1..PQ5-3).
//   • webhook: the shell's FIRST auth:"webhookSecret" consumer — checkWebhookSecret
//     (in server/api/defineRoute.ts) was authored as a replica of this route's inline check;
//     the freeze verified branch parity behaviorally (statuses+messages identical;
//     envelope flip = diff A). The service owns everything AFTER auth: dbId lookup 404 →
//     page upsert loop (parseTextractResponse/extractRawText engines; search_vector raw
//     SQL) → ★ P0.5-G1 job-close semantics (processingError written ONLY when
//     payload.error !== undefined — survivor-pinned) → processingJobs close. The leaky
//     catch-all ("Webhook failed" fallback) RETIRED (diff B).
//   • dev: ★ ENV-GUARD-BEFORE-AUTH preserved (prod && !DEV_PROCESSING_ENABLED → 403 even
//     signed-out) → hence auth:"none" + the service calls auth() itself. Shell body
//     handling (parse + zLooseBody) PRECEDES the guard (S033 trait; char-pinned) → projectId 400 →
//     company-scoped publicId 404 → processProject → {success:true, ...result} spread.
//     Leaky catch RETIRED (diff B).

import { auth } from "@/lib/auth";
import type { AuthSession } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, processingJobs } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { parseTextractResponse, extractRawText } from "@/lib/textract";
import type { Block } from "@aws-sdk/client-textract";
import { logger } from "@/lib/logger";
import { processProject } from "@/lib/processing";
import { ApiError } from "@/server/api/envelope";
import { assertProjectWritable } from "@/server/api/access";
import { withProjectWrite } from "@/server/api/project-write-capability";
import { zPublicId } from "@/server/api/schemas";

interface WebhookPageData {
  pageNumber: number;
  textractBlocks: Block[];
  drawingNumber?: string;
}

interface WebhookPayload {
  projectId: number;
  pages: WebhookPageData[];
  status: "completed" | "error";
  error?: string;
  processingTime?: number;
  // [refactor jun13 P0.5-G1] observability counts from the worker — pages
  // themselves were already written to the DB by processProject(); these are
  // logged, never persisted.
  pagesProcessed?: number;
  pageErrors?: number;
}

export async function processingWebhook(rawBody: Record<string, unknown>): Promise<unknown> {
  const payload = rawBody as unknown as WebhookPayload;
  // The raw value is written into the job_status/project_status enums below: reject anything else.
  if (payload.status !== "completed" && payload.status !== "error") {
    throw new ApiError("VALIDATION", "status must be completed or error");
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, payload.projectId))
    .limit(1);

  if (!project) {
    throw new ApiError("NOT_FOUND", "Project not found");
  }
  const writeCapability = assertProjectWritable(project);

  return withProjectWrite(writeCapability, project.id, async (tx) => {

  // Process each page's Textract results
  for (const pageData of payload.pages) {
    const textractData = parseTextractResponse(pageData.textractBlocks);
    const rawText = extractRawText(textractData);

    // Upsert page
    const [existingPage] = await tx
      .select({ id: pages.id, drawingNumber: pages.drawingNumber })
      .from(pages)
      .where(
        and(
          eq(pages.projectId, project.id),
          eq(pages.pageNumber, pageData.pageNumber)
        )
      )
      .limit(1);

    if (existingPage) {
      await tx
        .update(pages)
        .set({
          textractData,
          rawText,
          drawingNumber: pageData.drawingNumber || existingPage.drawingNumber,
        })
        .where(eq(pages.id, existingPage.id));

      await tx.execute(
        sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${existingPage.id}`
      );
    } else {
      const [newPage] = await tx
        .insert(pages)
        .values({
          pageNumber: pageData.pageNumber,
          name: pageData.drawingNumber || `Page ${pageData.pageNumber}`,
          drawingNumber: pageData.drawingNumber,
          projectId: project.id,
          textractData,
          rawText,
        })
        .returning();

      await tx.execute(
        sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${newPage.id}`
      );
    }
  }

  // [refactor jun13 P0.5-G1] JOB-CLOSE ONLY. processing.ts already wrote
  // numPages (real PDF page count) and processingError (real partial-failure
  // info) during ingest; this block used to clobber both on every success
  // ping (numPages → payload.pages.length = 0, processingError → null).
  // processingError is written only when the caller explicitly reports one.
  await tx
    .update(projects)
    .set({
      status: payload.status,
      processingTime: payload.processingTime,
      updatedAt: new Date(),
      ...(payload.error !== undefined ? { processingError: payload.error } : {}),
    })
    .where(eq(projects.id, project.id));

  if (payload.pagesProcessed !== undefined || payload.pageErrors !== undefined) {
    logger.info(
      `[webhook] project ${project.id} closed: ${payload.pagesProcessed ?? "?"} processed, ${payload.pageErrors ?? "?"} errors`
    );
  }

  // Close only the ingestion job. YOLO SageMaker intents share processing_jobs but carry
  // model_config; a late/retried ingestion webhook must never retire their publication block.
  await tx
    .update(processingJobs)
    .set({
      status: payload.status === "completed" ? "completed" : "failed",
      completedAt: new Date(),
      error: payload.error || null,
    })
    .where(and(
      eq(processingJobs.projectId, project.id),
      isNull(processingJobs.modelConfig),
      eq(processingJobs.status, "running"), // never relabel an already-closed older run
    ));

  return { success: true };
  });
}

export async function processingDev(rawBody: Record<string, unknown>): Promise<unknown> {
  // ★ Guard BEFORE auth (frozen: prod+disabled → 403 even signed-out)
  if (
    process.env.NODE_ENV === "production" &&
    process.env.DEV_PROCESSING_ENABLED !== "true"
  ) {
    throw new ApiError("FORBIDDEN", "Dev processing not enabled");
  }

  const { projectId } = rawBody as { projectId?: string };
  const parsedProjectId = zPublicId.safeParse(projectId);
  if (parsedProjectId.success) {
    const [target] = await db
      .select({
        id: projects.id,
        publicId: projects.publicId,
        companyId: projects.companyId,
        isDemo: projects.isDemo,
        lifecycleEpoch: projects.lifecycleEpoch,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(eq(projects.publicId, parsedProjectId.data))
      .limit(1);
    if (target?.isDemo) assertProjectWritable(target);
  }

  const session = (await auth()) as unknown as AuthSession | null;
  if (!session?.user) {
    throw new ApiError("UNAUTHORIZED", "Unauthorized");
  }

  if (!projectId) {
    throw new ApiError("VALIDATION", "projectId required");
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
    throw new ApiError("NOT_FOUND", "Not found");
  }

  const writeCapability = assertProjectWritable(project);
  const result = await processProject(project.id, writeCapability);
  return { success: true, ...result };
}
