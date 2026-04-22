import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages, companies, annotations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { detectTextAnnotations } from "@/lib/text-annotations";
import { detectCsiCodes } from "@/lib/csi-detect";
import { extractRawText } from "@/lib/textract";
import { extractDrawingNumber } from "@/lib/title-block";
import { analyzePageIntelligence } from "@/lib/page-analysis";
import { rasterizePage, getPdfPageCount } from "@/lib/pdf-rasterize";
import { downloadFromS3, uploadToS3 } from "@/lib/s3";
import { classifyTextRegions } from "@/lib/text-region-classifier";
import { writeClassifierDebugBundle } from "@/lib/text-region-classifier-debug";
import { getEffectiveRules, runHeuristicEngine } from "@/lib/heuristic-engine";
import { classifyTables } from "@/lib/table-classifier";
import { computeCsiSpatialMap } from "@/lib/csi-spatial";
import { analyzeProject, computeProjectSummaries } from "@/lib/project-analysis";
import type { TextractPageData, TextAnnotation, TextAnnotationResult, CsiCode } from "@/types";
import { logger } from "@/lib/logger";

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
  const debugClassifier = url.searchParams.get("debug") === "1"; // emit Stage 1 classifier trace
  const { session, error } = await requireAdmin();
  if (error) return error;

  // Read optional projectIds filter from request body
  let selectedProjectIds: string[] | undefined;
  try {
    const body = await req.json();
    if (body.projectIds && Array.isArray(body.projectIds)) {
      selectedProjectIds = body.projectIds;
    }
  } catch { /* no body = process all projects */ }

  // Load pipeline config for this company
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);
  const enabledDetectorIds = company?.pipelineConfig?.textAnnotation?.enabledDetectors;

  // Get all completed projects for this company
  const allCompanyProjects = await db
    .select({ id: projects.id, name: projects.name, publicId: projects.publicId, dataUrl: projects.dataUrl, numPages: projects.numPages })
    .from(projects)
    .where(eq(projects.companyId, session.user.companyId));

  // Filter to selected projects if specified
  const allProjects = selectedProjectIds
    ? allCompanyProjects.filter((p) => selectedProjectIds!.includes(p.publicId))
    : allCompanyProjects;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      }

      let totalPages = 0;
      let updatedPages = 0;
      let skippedPages = 0;

      const companyHeuristics = company?.pipelineConfig?.heuristics;

      send({ type: "start", projects: allProjects.length });

      if (scope === "page-names") {
        // Page-names reprocess: re-extract drawing numbers using improved strategies + YOLO title_block
        // Read pageNaming config to determine which YOLO model(s) + class(es) to use
        const pageNamingConfig = company?.pipelineConfig?.pageNaming;

        const yoloEnabled = pageNamingConfig?.enabled && (pageNamingConfig.yoloSources || []).length > 0;
        const yoloSources = yoloEnabled ? pageNamingConfig!.yoloSources! : [];

        // Build the set of class names to look for (across all configured sources)
        const targetClasses = new Set<string>();
        if (yoloSources.length > 0) {
          for (const src of yoloSources) {
            for (const cls of src.classes) targetClasses.add(cls);
          }
        } else {
          // Fallback: look for title_block if no config
          targetClasses.add("title_block");
        }

        send({ type: "config", yoloEnabled, targetClasses: [...targetClasses], sources: yoloSources.length });

        for (const project of allProjects) {
          const projectPages = await db
            .select({
              id: pages.id,
              pageNumber: pages.pageNumber,
              name: pages.name,
              drawingNumber: pages.drawingNumber,
              textractData: pages.textractData,
            })
            .from(pages)
            .where(eq(pages.projectId, project.id))
            .orderBy(pages.pageNumber);

          // Fetch YOLO annotations matching configured classes for this project
          // Query all YOLO annotations and filter by configured model+class pairs
          let titleBlockAnns: { pageNumber: number; minX: number; minY: number; maxX: number; maxY: number }[] = [];
          if (yoloEnabled && targetClasses.size > 0) {
            const allYoloAnns = await db
              .select({
                pageNumber: annotations.pageNumber,
                name: annotations.name,
                minX: annotations.minX,
                minY: annotations.minY,
                maxX: annotations.maxX,
                maxY: annotations.maxY,
                data: annotations.data,
              })
              .from(annotations)
              .where(
                and(
                  eq(annotations.projectId, project.id),
                  eq(annotations.source, "yolo"),
                )
              );

            // Filter by configured model+class pairs
            titleBlockAnns = allYoloAnns.filter(ann => {
              if (!targetClasses.has(ann.name)) return false;
              // If specific models are configured, check modelId matches
              if (yoloSources.length > 0) {
                const annModelId = (ann.data as any)?.modelId;
                return yoloSources.some(src =>
                  src.classes.includes(ann.name) &&
                  (annModelId === undefined || src.modelId === annModelId)
                );
              }
              return true;
            });
          } else if (targetClasses.size > 0) {
            // Fallback mode: just look for title_block class across all YOLO annotations
            const allYoloAnns = await db
              .select({
                pageNumber: annotations.pageNumber,
                name: annotations.name,
                minX: annotations.minX,
                minY: annotations.minY,
                maxX: annotations.maxX,
                maxY: annotations.maxY,
              })
              .from(annotations)
              .where(
                and(
                  eq(annotations.projectId, project.id),
                  eq(annotations.source, "yolo"),
                )
              );
            titleBlockAnns = allYoloAnns.filter(ann => targetClasses.has(ann.name));
          }

          // Build lookup: pageNumber → best title_block bbox (bottom-right if multiple)
          const titleBlockByPage = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
          for (const ann of titleBlockAnns) {
            const existing = titleBlockByPage.get(ann.pageNumber);
            if (!existing || (ann.minX + ann.minY > existing.minX + existing.minY)) {
              titleBlockByPage.set(ann.pageNumber, {
                minX: ann.minX, minY: ann.minY,
                maxX: ann.maxX, maxY: ann.maxY,
              });
            }
          }

          send({
            type: "project",
            name: project.name,
            pages: projectPages.length,
            yoloTitleBlocks: titleBlockByPage.size,
          });

          for (const page of projectPages) {
            totalPages++;
            if (!page.textractData) { skippedPages++; continue; }
            const textractData = page.textractData as TextractPageData;

            try {
              const yoloTitleBlock = titleBlockByPage.get(page.pageNumber) || null;
              const newDrawingNumber = extractDrawingNumber(textractData, yoloTitleBlock);
              const newName = newDrawingNumber || `Page ${page.pageNumber}`;

              // Only update if the name actually changed
              if (newDrawingNumber !== page.drawingNumber || newName !== page.name) {
                await db.update(pages).set({
                  drawingNumber: newDrawingNumber,
                  name: newName,
                }).where(eq(pages.id, page.id));
                updatedPages++;
              } else {
                skippedPages++;
              }
            } catch (err) {
              logger.error(`[reprocess-page-names] Page ${page.pageNumber} failed:`, err);
            }

            if ((updatedPages + skippedPages) % 10 === 0) {
              send({ type: "progress", updated: updatedPages, skipped: skippedPages, total: totalPages, project: project.name });
            }
          }
        }

        send({ type: "done", updated: updatedPages, skipped: skippedPages, total: totalPages });
        controller.close();
        return;
      }

      if (scope === "thumbnails") {
        // Thumbnail + page PNG regeneration: download PDF, rasterize, upload to S3
        for (const project of allProjects) {
          try {
            const pdfKey = `${project.dataUrl}/original.pdf`;
            let pdfBuffer: Buffer;
            try {
              pdfBuffer = await downloadFromS3(pdfKey);
            } catch {
              send({ type: "error", project: project.name, error: "PDF not found in S3" });
              continue;
            }
            const pageCount = project.numPages || await getPdfPageCount(pdfBuffer);
            send({ type: "project", name: project.name, pages: pageCount });

            for (let pg = 1; pg <= pageCount; pg++) {
              const pageKey = String(pg).padStart(4, "0");
              try {
                // Thumbnail at 72 DPI
                const thumbBuffer = await rasterizePage(pdfBuffer, pg, 72);
                await uploadToS3(
                  `${project.dataUrl}/thumbnails/page_${pageKey}.png`,
                  thumbBuffer,
                  "image/png",
                  "public, max-age=31536000, immutable",
                );
                // Full page at 300 DPI (also regenerate if missing)
                const pageBuffer = await rasterizePage(pdfBuffer, pg, 300);
                await uploadToS3(
                  `${project.dataUrl}/pages/page_${pageKey}.png`,
                  pageBuffer,
                  "image/png",
                  "public, max-age=31536000, immutable",
                );
                updatedPages++;
              } catch (err) {
                logger.error(`[reprocess-thumbnails] Page ${pg} failed for ${project.name}:`, err);
                skippedPages++;
              }
              totalPages++;
              if (totalPages % 3 === 0) {
                send({ type: "progress", updated: updatedPages, skipped: skippedPages, total: totalPages, project: project.name });
              }
            }
            // Release PDF buffer between projects
            // @ts-ignore
            pdfBuffer = null;
          } catch (err) {
            logger.error(`[reprocess-thumbnails] Project ${project.name} failed:`, err);
            send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
          }
        }

        send({ type: "done", updated: updatedPages, skipped: skippedPages, total: totalPages });
        controller.close();
        return;
      }

      if (scope === "shape-parse") {
        const { isLambdaCvEnabled, fanOutShapeParse } = await import("@/lib/lambda-cv");
        const { extractKeynotes } = await import("@/lib/keynotes");
        const useLambda = isLambdaCvEnabled();
        send({ type: "config", useLambda });

        for (const project of allProjects) {
          const projectPages = await db
            .select({ id: pages.id, pageNumber: pages.pageNumber })
            .from(pages)
            .where(eq(pages.projectId, project.id))
            .orderBy(pages.pageNumber);

          if (projectPages.length === 0) continue;
          send({ type: "project", name: project.name, pages: projectPages.length });
          totalPages += projectPages.length;

          // Delete existing shape-parse annotations for this project
          await db.delete(annotations).where(
            and(eq(annotations.projectId, project.id), eq(annotations.source, "shape-parse"))
          );

          let lambdaSucceeded = false;
          if (useLambda) {
            try {
              const pageS3Keys = projectPages.map(
                (p) => `${project.dataUrl}/pages/page_${String(p.pageNumber).padStart(4, "0")}.png`
              );
              const pageKeyToNum: Record<string, number> = {};
              for (const p of projectPages) {
                pageKeyToNum[`${project.dataUrl}/pages/page_${String(p.pageNumber).padStart(4, "0")}.png`] = p.pageNumber;
              }

              const { results } = await fanOutShapeParse({ pageS3Keys });

              const byPage: Record<number, typeof results> = {};
              for (const r of results) {
                const pn = pageKeyToNum[r.pageS3Key] ?? 0;
                if (!byPage[pn]) byPage[pn] = [];
                byPage[pn].push(r);
              }

              for (const [pnStr, shapes] of Object.entries(byPage)) {
                const pn = Number(pnStr);
                await db.update(pages).set({ keynotes: shapes }).where(
                  and(eq(pages.projectId, project.id), eq(pages.pageNumber, pn))
                );
                if (shapes.length > 0) {
                  await db.insert(annotations).values(
                    shapes.map((k) => ({
                      name: k.shape,
                      minX: k.bbox[0], minY: k.bbox[1], maxX: k.bbox[2], maxY: k.bbox[3],
                      pageNumber: pn,
                      threshold: 0.9,
                      source: "shape-parse" as const,
                      data: { modelName: "shape-parse", shapeType: k.shape, text: k.text, contour: k.contour, confidence: 0.9 },
                      projectId: project.id,
                    }))
                  );
                }
                updatedPages++;
              }
              lambdaSucceeded = true;
              send({ type: "progress", updated: updatedPages, skipped: skippedPages, total: totalPages, project: project.name });
            } catch (err) {
              logger.error(`[reprocess-shape-parse] Lambda failed for ${project.name}, falling back to sequential:`, err);
              send({ type: "warning", project: project.name, message: "Lambda failed, using sequential fallback" });
            }
          }
          if (!lambdaSucceeded) {
            // Sequential fallback
            for (const page of projectPages) {
              try {
                const s3Key = `${project.dataUrl}/pages/page_${String(page.pageNumber).padStart(4, "0")}.png`;
                const pngBuffer = await downloadFromS3(s3Key);
                const result = await extractKeynotes(pngBuffer);

                await db.update(pages).set({
                  keynotes: result.keynotes.length > 0 ? result.keynotes : null,
                }).where(eq(pages.id, page.id));

                if (result.keynotes.length > 0) {
                  await db.insert(annotations).values(
                    result.keynotes.map((k) => ({
                      name: k.shape,
                      minX: k.bbox[0], minY: k.bbox[1], maxX: k.bbox[2], maxY: k.bbox[3],
                      pageNumber: page.pageNumber,
                      threshold: 0.9,
                      source: "shape-parse" as const,
                      data: { modelName: "shape-parse", shapeType: k.shape, text: k.text, contour: k.contour, confidence: 0.9 },
                      projectId: project.id,
                    }))
                  );
                  updatedPages++;
                } else {
                  skippedPages++;
                }
              } catch (err) {
                logger.error(`[reprocess-shape-parse] Page ${page.pageNumber} failed for ${project.name}:`, err);
                skippedPages++;
              }
              if ((updatedPages + skippedPages) % 5 === 0) {
                send({ type: "progress", updated: updatedPages, skipped: skippedPages, total: totalPages, project: project.name });
              }
            }
          }
        }

        send({ type: "done", updated: updatedPages, skipped: skippedPages, total: totalPages });
        controller.close();
        return;
      }

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
            const csiCodes: CsiCode[] = page.csiCodes || [];
            const textAnns = page.textAnnotations?.annotations || [];

            try {
              // Page intelligence: classification, cross-refs, note blocks
              let pageIntelligence: Record<string, unknown> = {};
              const intel = analyzePageIntelligence(page.drawingNumber, textractData, csiCodes);
              if (intel.classification || intel.crossRefs || intel.noteBlocks) {
                pageIntelligence = { ...intel };
              }

              // Text region classification (with optional debug bundle to S3)
              const debugWrites: Promise<void>[] = [];
              const textRegions = classifyTextRegions(textractData, csiCodes, {
                debug: debugClassifier,
                pageNumber: page.pageNumber,
                onDebug: (bundle) => {
                  debugWrites.push(
                    writeClassifierDebugBundle(project.dataUrl, page.pageNumber, bundle),
                  );
                },
              });
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
              const spatialMap = computeCsiSpatialMap(page.pageNumber, textAnns, undefined, pageIntelligence.classifiedTables as any);
              if (spatialMap) pageIntelligence.csiSpatialMap = spatialMap;

              await db.update(pages).set({ pageIntelligence }).where(eq(pages.id, page.id));
              // Flush classifier debug writes (if any). Errors inside the writer
              // are already logged; allSettled keeps a single write failure from
              // aborting the loop.
              if (debugWrites.length > 0) await Promise.allSettled(debugWrites);
              updatedPages++;
            } catch (err) {
              logger.error(`[reprocess-intel] Page ${page.pageNumber} failed:`, err);
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
              pageIntelligence: p.pageIntelligence ?? null, csiCodes: p.csiCodes,
            })));

            // Preserve user config (classCsiOverrides) when regenerating
            const [currentProject] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, project.id));
            const existingUserConfig = (currentProject?.pi as any)?.classCsiOverrides;
            const mergedIntel = existingUserConfig ? { ...intelligence, classCsiOverrides: existingUserConfig } : intelligence;

            await db.update(projects).set({ projectIntelligence: mergedIntel, projectSummary: summary }).where(eq(projects.id, project.id));
            send({ type: "project-analysis", project: project.name });
          } catch (err) {
            logger.error(`[reprocess-intel] Project analysis failed for ${project.name}:`, err);
          }

          // Recompute project summaries (chunking indexes)
          try {
            await computeProjectSummaries(project.id);
            send({ type: "project-summaries", project: project.name });
          } catch (err) {
            logger.error(`[reprocess-intel] Summary computation failed for ${project.name}:`, err);
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

          try {
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

            // Re-run CSI detection (before text annotations, since CSI feeds into them).
            // Pass Textract words so trigger bboxes are recorded on each detected code.
            const rawText = page.rawText || extractRawText(textractData);
            const csiCodes = detectCsiCodes(rawText, textractData.words);

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
          } catch (err) {
            logger.error(`[reprocess] Page ${page.pageNumber} failed:`, err);
            skippedPages++;
          }

          if (updatedPages % 5 === 0) {
            send({ type: "progress", updated: updatedPages, total: totalPages, project: project.name });
          }
        }

        // Recompute project summaries after full reprocess
        try {
          await computeProjectSummaries(project.id);
          send({ type: "project-summaries", project: project.name });
        } catch (err) {
          logger.error(`[reprocess] Summary computation failed for ${project.name}:`, err);
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
