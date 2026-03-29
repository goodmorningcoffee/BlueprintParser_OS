import { db } from "@/lib/db";
import { projects, pages, companies } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getS3Url, uploadToS3 } from "@/lib/s3";
import { rasterizePage, getPdfPageCount } from "@/lib/pdf-rasterize";
import { analyzePageImageWithFallback, extractRawText } from "@/lib/textract";
import { extractDrawingNumber } from "@/lib/title-block";
import { detectCsiCodes } from "@/lib/csi-detect";
import { detectTextAnnotations } from "@/lib/text-annotations";
// NOTE: extractKeynotes is now user-initiated via the Keynotes panel, not run at upload
import { analyzePageIntelligence } from "@/lib/page-analysis";
import { classifyTextRegions } from "@/lib/text-region-classifier";
import { getEffectiveRules, runHeuristicEngine } from "@/lib/heuristic-engine";
import { classifyTables } from "@/lib/table-classifier";
import { computeCsiSpatialMap } from "@/lib/csi-spatial";
import { analyzeProject } from "@/lib/project-analysis";

const PAGE_CONCURRENCY = 20;

/** Run async tasks with a concurrency limit. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Process a PDF project: rasterize pages, run Textract, store results.
 * Called directly by the projects route (fire-and-forget) or via the dev API route.
 *
 * @param projectId - Internal database ID of the project
 */
export async function processProject(projectId: number): Promise<{
  pagesProcessed: number;
  pageErrors: number;
  processingTime: number;
}> {
  const startTime = Date.now();
  let pagesProcessed = 0;
  let pageErrors = 0;

  // Get project
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  // Set status to processing
  await db
    .update(projects)
    .set({ status: "processing" })
    .where(eq(projects.id, project.id));

  try {
    // Download PDF from S3
    const pdfUrl = getS3Url(project.dataUrl, "original.pdf");
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      throw new Error(`Failed to download PDF: ${pdfResponse.status}`);
    }
    const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());

    // Get page count
    const numPages = await getPdfPageCount(pdfBuffer);
    await db
      .update(projects)
      .set({ numPages })
      .where(eq(projects.id, project.id));

    // Generate thumbnail from page 1 before parallel processing
    try {
      const thumbBuffer = await rasterizePage(pdfBuffer, 1, 72);
      await uploadToS3(
        `${project.dataUrl}/thumbnail.png`,
        thumbBuffer,
        "image/png"
      );
    } catch (err) {
      console.warn("Thumbnail generation failed:", err);
    }

    // Fetch company heuristic config for this project
    let companyHeuristics: any[] | undefined;
    try {
      const [company] = await db
        .select({ pipelineConfig: companies.pipelineConfig })
        .from(companies)
        .where(eq(companies.id, project.companyId))
        .limit(1);
      companyHeuristics = (company?.pipelineConfig as any)?.heuristics;
    } catch { /* ignore — use built-in defaults */ }

    // Process pages in parallel with concurrency limit
    const pageNums = Array.from({ length: numPages }, (_, i) => i + 1);

    await mapConcurrent(pageNums, PAGE_CONCURRENCY, async (pageNum) => {
      try {
        // Check if page already has textract data (skip if re-processing)
        const [existingPage] = await db
          .select({ id: pages.id, textractData: pages.textractData })
          .from(pages)
          .where(
            and(
              eq(pages.projectId, project.id),
              eq(pages.pageNumber, pageNum)
            )
          )
          .limit(1);

        if (existingPage?.textractData) {
          pagesProcessed++;
          return;
        }

        // Rasterize page once at 300 DPI — used for both Textract and keynotes
        const pngBuffer = await rasterizePage(pdfBuffer, pageNum, 300);

        // Run Textract OCR
        const textractData = await analyzePageImageWithFallback(pngBuffer);
        const rawText = extractRawText(textractData);

        // Extract drawing number from title block
        const drawingNumber = extractDrawingNumber(textractData);

        // Detect CSI codes from OCR text
        const csiCodes = detectCsiCodes(rawText);

        // Detect text annotations (phone, address, equipment tags, abbreviations, etc.)
        const textAnnotationResult = detectTextAnnotations(textractData, csiCodes);
        if (textAnnotationResult.annotations.length > 0) {
          console.log(`[processing] Page ${pageNum}: found ${textAnnotationResult.annotations.length} text annotations`);
        }

        // NOTE: Keynote extraction (OpenCV + Tesseract) is now user-initiated via the Keynotes panel.
        // Classification (Systems 1-3) still identifies keynote table regions.
        const keynotes: any = null;

        // Analyze page intelligence (classification, cross-refs, note blocks)
        let pageIntelligence: Record<string, unknown> | null = null;
        try {
          const intel = analyzePageIntelligence(drawingNumber, textractData, csiCodes);
          if (intel.classification || intel.crossRefs || intel.noteBlocks) {
            pageIntelligence = { ...intel };
          }
        } catch (err) {
          console.error(`[processing] Page intelligence FAILED for page ${pageNum}:`, err);
        }

        // Classify text regions (OCR-based table/notes/spec detection)
        try {
          const textRegions = classifyTextRegions(textractData, csiCodes);
          if (textRegions.length > 0) {
            if (!pageIntelligence) pageIntelligence = {};
            pageIntelligence.textRegions = textRegions;
          }
        } catch (err) {
          console.error(`[processing] Text region classification FAILED for page ${pageNum}:`, err);
        }

        // Run heuristic engine (text-only mode — no YOLO data during initial processing)
        try {
          const rules = getEffectiveRules(companyHeuristics);
          const inferences = runHeuristicEngine(rules, {
            rawText: rawText || "",
            textRegions: (pageIntelligence as any)?.textRegions,
            csiCodes,
            pageNumber: pageNum,
          });
          if (inferences.length > 0) {
            if (!pageIntelligence) pageIntelligence = {};
            pageIntelligence.heuristicInferences = inferences;
          }
        } catch (err) {
          console.error(`[processing] Heuristic engine FAILED for page ${pageNum}:`, err);
        }

        // Classify tables/schedules/keynotes (combines text regions + heuristic inferences)
        try {
          const intel = pageIntelligence as any;
          if (intel?.textRegions?.length > 0) {
            const classified = classifyTables({
              textRegions: intel.textRegions,
              heuristicInferences: intel.heuristicInferences,
              csiCodes,
              pageNumber: pageNum,
            });
            if (classified.length > 0) {
              if (!pageIntelligence) pageIntelligence = {};
              (pageIntelligence as any).classifiedTables = classified;
            }
          }
        } catch (err) {
          console.error(`[processing] Table classification FAILED for page ${pageNum}:`, err);
        }

        // NOTE: Schedule parsing (System 4) is user-initiated only — not run at upload.
        // Users trigger it via the Auto Parse or Manual Parse tabs in the Schedules/Tables panel.
        // Classification (Systems 1-3 above) still runs to inform the UI about where tables are.

        // Compute CSI spatial heatmap (OCR-only — no YOLO data during initial processing)
        try {
          const spatialMap = computeCsiSpatialMap(
            pageNum,
            textAnnotationResult.annotations,
            undefined, // YOLO not available during initial processing
            (pageIntelligence as any)?.classifiedTables,
          );
          if (spatialMap) {
            if (!pageIntelligence) pageIntelligence = {};
            (pageIntelligence as any).csiSpatialMap = spatialMap;
          }
        } catch (err) {
          console.error(`[processing] CSI spatial map FAILED for page ${pageNum}:`, err);
        }

        // Build page data
        const pageData: Record<string, unknown> = {
          textractData,
          rawText,
          drawingNumber,
          csiCodes: csiCodes.length > 0 ? csiCodes : null,
          textAnnotations: textAnnotationResult.annotations.length > 0 ? textAnnotationResult : null,
          keynotes: keynotes && keynotes.length > 0 ? keynotes : null,
          pageIntelligence,
        };

        // Upsert page row
        if (existingPage) {
          await db
            .update(pages)
            .set(pageData)
            .where(eq(pages.id, existingPage.id));

          await db.execute(
            sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${existingPage.id}`
          );
        } else {
          const pageName = drawingNumber || `Page ${pageNum}`;
          const [newPage] = await db
            .insert(pages)
            .values({
              pageNumber: pageNum,
              name: pageName,
              projectId: project.id,
              ...pageData,
            })
            .returning();

          await db.execute(
            sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${newPage.id}`
          );
        }

        pagesProcessed++;
      } catch (err) {
        console.error(`Error processing page ${pageNum}:`, err);
        pageErrors++;

        // Insert page row with error if it doesn't exist
        const [errPage] = await db
          .select({ id: pages.id })
          .from(pages)
          .where(
            and(
              eq(pages.projectId, project.id),
              eq(pages.pageNumber, pageNum)
            )
          )
          .limit(1);

        if (!errPage) {
          await db.insert(pages).values({
            pageNumber: pageNum,
            name: `Page ${pageNum}`,
            projectId: project.id,
            error: err instanceof Error ? err.message : "Processing failed",
          });
        }
      }
    });

    // ─── Project-level analysis (after all pages processed) ───
    try {
      const allProcessedPages = await db
        .select({
          pageNumber: pages.pageNumber,
          drawingNumber: pages.drawingNumber,
          pageIntelligence: pages.pageIntelligence,
          csiCodes: pages.csiCodes,
        })
        .from(pages)
        .where(eq(pages.projectId, project.id))
        .orderBy(pages.pageNumber);

      const { intelligence, summary } = analyzeProject(
        allProcessedPages.map(p => ({
          pageNumber: p.pageNumber,
          drawingNumber: p.drawingNumber,
          pageIntelligence: p.pageIntelligence as any,
          csiCodes: p.csiCodes as any,
        }))
      );

      // Preserve user-set fields (classCsiOverrides) when regenerating intelligence
      const [currentProject] = await db.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, project.id));
      const existingUserConfig = (currentProject?.pi as any)?.classCsiOverrides;
      const mergedIntelligence = existingUserConfig
        ? { ...intelligence, classCsiOverrides: existingUserConfig }
        : intelligence;

      await db
        .update(projects)
        .set({
          projectIntelligence: mergedIntelligence,
          projectSummary: summary,
        })
        .where(eq(projects.id, project.id));

      console.log(`[processing] Project analysis complete: ${summary.split("\n")[0]}`);
    } catch (err) {
      console.error("[processing] Project analysis failed:", err);
    }

    // Update project status
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    await db
      .update(projects)
      .set({
        status: numPages > 0 && pageErrors === numPages ? "error" : "completed",
        processingTime,
        processingError:
          pageErrors > 0 ? `${pageErrors} of ${numPages} pages failed` : null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));

    return { pagesProcessed, pageErrors, processingTime };
  } catch (err) {
    console.error("Processing pipeline error:", err);

    await db
      .update(projects)
      .set({
        status: "error",
        processingError:
          err instanceof Error ? err.message : "Processing failed",
        processingTime: Math.round((Date.now() - startTime) / 1000),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));

    throw err;
  }
}
