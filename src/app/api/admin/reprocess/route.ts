import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { detectTextAnnotations } from "@/lib/text-annotations";
import { detectCsiCodes } from "@/lib/csi-detect";
import { extractRawText } from "@/lib/textract";
import { analyzePageIntelligence } from "@/lib/page-analysis";
import { classifyTextRegions } from "@/lib/text-region-classifier";
import { getEffectiveRules, runHeuristicEngine } from "@/lib/heuristic-engine";
import { classifyTables } from "@/lib/table-classifier";
import { computeCsiSpatialMap } from "@/lib/csi-spatial";
import { analyzeProject } from "@/lib/project-analysis";
import type { TextractPageData, TextAnnotation, TextAnnotationResult, CsiCode } from "@/types";

/**
 * POST /api/admin/reprocess
 *
 * Re-runs detectors on all existing pages that already have OCR data.
 * Query param ?scope=intelligence → only re-runs page intelligence + project analysis (fast).
 * Default (no scope) → re-runs CSI detection + text annotations + intelligence (full).
 *
 * Streams progress as newline-delimited JSON.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope"); // "intelligence" or null (full)
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  // Load pipeline config for this company
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);
  const enabledDetectorIds = (company?.pipelineConfig as any)?.textAnnotation?.enabledDetectors as string[] | undefined;

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

      const companyHeuristics = (company?.pipelineConfig as any)?.heuristics;

      send({ type: "start", projects: allProjects.length });

      if (scope === "intelligence") {
        // Intelligence-only reprocess: re-run page analysis + project analysis on existing data
        for (const project of allProjects) {
          const projectPages = await db
            .select({
              id: pages.id,
              pageNumber: pages.pageNumber,
              drawingNumber: pages.drawingNumber,
              textractData: pages.textractData,
              rawText: pages.rawText,
              csiCodes: pages.csiCodes,
              textAnnotations: pages.textAnnotations,
            })
            .from(pages)
            .where(eq(pages.projectId, project.id))
            .orderBy(pages.pageNumber);

          send({ type: "project", name: project.name, pages: projectPages.length });

          const rules = getEffectiveRules(companyHeuristics);

          for (const page of projectPages) {
            totalPages++;
            if (!page.textractData) { skippedPages++; continue; }
            const textractData = page.textractData as TextractPageData;
            const csiCodes = (page.csiCodes || []) as CsiCode[];
            const textAnns = ((page.textAnnotations as any)?.annotations || []) as any[];

            try {
              // Page intelligence: classification, cross-refs, note blocks
              let pageIntelligence: Record<string, unknown> = {};
              const intel = analyzePageIntelligence(page.drawingNumber, textractData, csiCodes);
              if (intel.classification || intel.crossRefs || intel.noteBlocks) {
                pageIntelligence = { ...intel };
              }

              // Text region classification
              const textRegions = classifyTextRegions(textractData, csiCodes);
              if (textRegions.length > 0) pageIntelligence.textRegions = textRegions;

              // Heuristic engine (text-only, no YOLO in this pass)
              const inferences = runHeuristicEngine(rules, {
                rawText: page.rawText || "",
                textRegions: textRegions.length > 0 ? textRegions : undefined,
                csiCodes,
                pageNumber: page.pageNumber,
              });
              if (inferences.length > 0) pageIntelligence.heuristicInferences = inferences;

              // Table classification
              if (textRegions.length > 0) {
                const classified = classifyTables({ textRegions, heuristicInferences: inferences, csiCodes, pageNumber: page.pageNumber });
                if (classified.length > 0) pageIntelligence.classifiedTables = classified;
              }

              // CSI spatial map
              const spatialMap = computeCsiSpatialMap(page.pageNumber, textAnns, undefined, (pageIntelligence as any).classifiedTables);
              if (spatialMap) pageIntelligence.csiSpatialMap = spatialMap;

              await db.update(pages).set({ pageIntelligence }).where(eq(pages.id, page.id));
              updatedPages++;
            } catch (err) {
              console.error(`[reprocess-intel] Page ${page.pageNumber} failed:`, err);
            }

            if (updatedPages % 5 === 0) send({ type: "progress", updated: updatedPages, total: totalPages, project: project.name });
          }

          // Project-level analysis
          try {
            const allProcessedPages = await db
              .select({ pageNumber: pages.pageNumber, drawingNumber: pages.drawingNumber, pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes })
              .from(pages).where(eq(pages.projectId, project.id)).orderBy(pages.pageNumber);

            const { intelligence, summary } = analyzeProject(allProcessedPages.map(p => ({
              pageNumber: p.pageNumber, drawingNumber: p.drawingNumber,
              pageIntelligence: p.pageIntelligence as any, csiCodes: p.csiCodes as any,
            })));

            // Preserve user config (classCsiOverrides) when regenerating
            const [currentProject] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, project.id));
            const existingUserConfig = (currentProject?.pi as any)?.classCsiOverrides;
            const mergedIntel = existingUserConfig ? { ...intelligence, classCsiOverrides: existingUserConfig } : intelligence;

            await db.update(projects).set({ projectIntelligence: mergedIntel, projectSummary: summary }).where(eq(projects.id, project.id));
            send({ type: "project-analysis", project: project.name });
          } catch (err) {
            console.error(`[reprocess-intel] Project analysis failed for ${project.name}:`, err);
          }
        }

        send({ type: "done", updated: updatedPages, skipped: skippedPages, total: totalPages });
        controller.close();
        return;
      }

      // Full reprocess (existing behavior)
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

          // Re-run text annotation detectors (with CSI codes + pipeline config)
          const textAnnotationResult = detectTextAnnotations(textractData, csiCodes, enabledDetectorIds);

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
