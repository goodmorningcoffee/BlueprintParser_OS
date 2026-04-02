import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { projects, pages, processingJobs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { parseTextractResponse, extractRawText } from "@/lib/textract";
import type { Block } from "@aws-sdk/client-textract";
import { logger } from "@/lib/logger";

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
}

/**
 * Production webhook called by Step Functions when processing completes.
 * Validates authorization, stores Textract results, updates project status.
 */
export async function POST(req: Request) {
  // Validate webhook secret
  const authHeader = req.headers.get("authorization");
  const secret = process.env.PROCESSING_WEBHOOK_SECRET;

  const expected = `Bearer ${secret}`;
  if (!secret || !authHeader || authHeader.length !== expected.length ||
      !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Reject stale webhooks (> 5 min old)
  const timestamp = req.headers.get("x-webhook-timestamp");
  if (timestamp) {
    const age = Date.now() - parseInt(timestamp);
    if (age > 5 * 60 * 1000 || age < -60 * 1000) {
      return NextResponse.json({ error: "Webhook expired" }, { status: 401 });
    }
  }

  const payload: WebhookPayload = await req.json();

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, payload.projectId))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    // Process each page's Textract results
    for (const pageData of payload.pages) {
      const textractData = parseTextractResponse(pageData.textractBlocks);
      const rawText = extractRawText(textractData);

      // Upsert page
      const [existingPage] = await db
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
        await db
          .update(pages)
          .set({
            textractData,
            rawText,
            drawingNumber: pageData.drawingNumber || existingPage.drawingNumber,
          })
          .where(eq(pages.id, existingPage.id));

        await db.execute(
          sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${existingPage.id}`
        );
      } else {
        const [newPage] = await db
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

        await db.execute(
          sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${newPage.id}`
        );
      }
    }

    // Update project status
    await db
      .update(projects)
      .set({
        status: payload.status,
        processingError: payload.error || null,
        processingTime: payload.processingTime,
        numPages: payload.pages.length,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));

    // Update processing job if exists
    await db
      .update(processingJobs)
      .set({
        status: payload.status === "completed" ? "completed" : "failed",
        completedAt: new Date(),
        error: payload.error || null,
      })
      .where(eq(processingJobs.projectId, project.id));

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("Webhook processing error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Webhook failed" },
      { status: 500 }
    );
  }
}
