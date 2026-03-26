import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { detectTextAnnotations } from "@/lib/text-annotations";
import { detectCsiCodes } from "@/lib/csi-detect";
import { extractRawText } from "@/lib/textract";
import type { TextractPageData, TextAnnotation, TextAnnotationResult } from "@/types";

/**
 * POST /api/admin/reprocess
 *
 * Re-runs text annotation detectors (and CSI detection) on all existing pages
 * that already have OCR data. No re-uploading or re-OCR needed.
 *
 * Streams progress as newline-delimited JSON.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  // Get all completed projects for this company
  const allProjects = await db
    .select({ id: projects.id, name: projects.name, publicId: projects.publicId })
    .from(projects)
    .where(eq(projects.companyId, session.user.companyId));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      }

      let totalPages = 0;
      let updatedPages = 0;
      let skippedPages = 0;

      send({ type: "start", projects: allProjects.length });

      for (const project of allProjects) {
        // Fetch pages with existing textractData (core columns only)
        const projectPages = await db
          .select({
            id: pages.id,
            pageNumber: pages.pageNumber,
            textractData: pages.textractData,
            rawText: pages.rawText,
          })
          .from(pages)
          .where(eq(pages.projectId, project.id))
          .orderBy(pages.pageNumber);

        send({ type: "project", name: project.name, pages: projectPages.length });

        for (const page of projectPages) {
          totalPages++;

          if (!page.textractData) {
            skippedPages++;
            continue;
          }

          const textractData = page.textractData as TextractPageData;

          // Preserve user notes from existing text annotations
          let existingNotes: Record<string, string> = {};
          try {
            const [existing] = await db
              .select({ textAnnotations: pages.textAnnotations })
              .from(pages)
              .where(eq(pages.id, page.id))
              .limit(1);
            if (existing?.textAnnotations) {
              const prev = existing.textAnnotations as TextAnnotationResult;
              for (const ann of prev.annotations || []) {
                if (ann.note) existingNotes[`${ann.type}:${ann.text}`] = ann.note;
              }
            }
          } catch { /* textAnnotations column may not exist */ }

          // Re-run CSI detection (before text annotations, since CSI feeds into them)
          const rawText = page.rawText || extractRawText(textractData);
          const csiCodes = detectCsiCodes(rawText);

          // Re-run text annotation detectors (with CSI codes)
          const textAnnotationResult = detectTextAnnotations(textractData, csiCodes);

          // Merge back user notes from previous run
          for (const ann of textAnnotationResult.annotations) {
            const key = `${ann.type}:${ann.text}`;
            if (existingNotes[key]) ann.note = existingNotes[key];
          }

          // Update page — use try-catch for textAnnotations column
          try {
            await db
              .update(pages)
              .set({
                textAnnotations: textAnnotationResult.annotations.length > 0 ? textAnnotationResult : null,
                csiCodes: csiCodes.length > 0 ? csiCodes : null,
              })
              .where(eq(pages.id, page.id));
          } catch {
            // textAnnotations column may not exist — just update csiCodes
            await db
              .update(pages)
              .set({ csiCodes: csiCodes.length > 0 ? csiCodes : null })
              .where(eq(pages.id, page.id));
          }

          updatedPages++;

          if (updatedPages % 5 === 0) {
            send({ type: "progress", updated: updatedPages, total: totalPages, project: project.name });
          }
        }
      }

      send({ type: "done", updated: updatedPages, skipped: skippedPages, total: totalPages });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
  });
}
