import { db } from "@/lib/db";
import { projects, pages, companies } from "@/lib/db/schema";
// [bugfix jul5 H6/DR002] project-level user-key preservation on analysis re-runs
// [bugfix jul9 F4] + page-level carry for the UPDATE branch (same policy module)
import {
  carryNonComputedIntelligence,
  mergeProjectIntelligence,
} from "@/lib/intelligence-merge";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { visiblePage } from "@/lib/page-dedup";
import {
  uploadToS3,
  downloadFromS3,
  deleteFromS3,
  headS3Object,
  sanitizeFilename,
} from "@/lib/s3";
import { logger } from "@/lib/logger";
import { rasterizePage, getPdfPageCount } from "@/lib/pdf-rasterize";
import { analyzePageImageWithFallback, extractRawText } from "@/lib/textract";
import { extractDrawingNumber } from "@/lib/title-block";
import { storedPageZones } from "@/lib/page-zones";
import { buildEvidenceSummary } from "@/lib/evidence";
import { detectCsiCodes } from "@/lib/csi-detect";
// [refactor jul9 P2-A C1] company CSI context (config + custom DB) resolver — threaded
// into the detect call below so a company's stored pipelineConfig.csi + uploaded DB take
// effect on the ingest hot path (levers go live, ledger D-1/D-2).
import { getCompanyCsiContext } from "@/lib/csi-company-db";
import { detectTextAnnotations } from "@/lib/text-annotations";
import { extractKeynotes } from "@/lib/keynotes";
import { analyzePageIntelligence } from "@/lib/page-analysis";
import { classifyTextRegions } from "@/lib/text-region-classifier";
import { getEffectiveRules, runHeuristicEngine } from "@/lib/heuristic-engine";
import { resolvePipelineToggles } from "@/lib/pipeline-toggles";
import { classifyTables } from "@/lib/table-classifier";
import { computeCsiSpatialMap } from "@/lib/csi-spatial";
import {
  analyzeProject,
  computeProjectSummaries,
} from "@/lib/project-analysis";
import { refreshProjectGraph } from "@/server/services/project-graph";
import type { CsiCode, TextAnnotationResult, StagingFile } from "@/types";
import { spawn } from "child_process";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  withProjectMutationLease,
  withProjectWrite,
  type ProjectWriteCapability,
} from "@/server/api/project-write-capability";
// [refactor jul23 P4.1 U7 → fix 2026-10-22] shape-parse rows: per-page replace (observe sink inside).
import { replaceShapeParseAnnotations } from "@/server/services/shape-parse-persist";

// [2026-10-23] company pageConcurrency → else PAGE_CONCURRENCY env (upload compute preset, 1..32) → else 8.
import { resolvePageConcurrency } from "@/lib/upload-compute";
import { tilePageSafely } from "@/lib/tiles/tiler";
import type { TilesRecord } from "@/lib/tiles/keys";
import { readTilesSetting } from "@/server/services/tiles-setting";

/** Run async tasks with a concurrency limit. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Spawn build_project_pdf.py with stdin JSON, collect stdout JSON.
 * Mirrors the bucket-fill.ts:60-115 pattern (timeout + SIGTERM escalation).
 */
async function runPythonConcat(
  scriptPath: string,
  config: {
    files: Array<{ filename: string; tmpPath: string }>;
    outputPath: string;
  },
): Promise<{
  status: "ok" | "error";
  totalPages?: number;
  fileOffsets?: Array<{ filename: string; startPage: number; endPage: number }>;
  error?: string;
  filename?: string;
  message?: string;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Concat for 30 files × 250 MB can push several minutes; 5 min ceiling.
    const timeoutMs = 300_000;
    const killTimer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 3000);
      reject(new Error("build_project_pdf.py timed out (300s)"));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (stderr.trim()) {
        logger.info(`[BUILD_PDF] ${stderr.trim()}`);
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(
          new Error(
            `build_project_pdf.py exited with code ${code}, no parseable JSON. stderr: ${stderr.slice(0, 500)}`,
          ),
        );
      }
    });

    proc.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    proc.stdin.write(JSON.stringify(config));
    proc.stdin.end();
  });
}

/**
 * Pre-stage for multi-file uploads: download staged files to a tempdir,
 * concatenate them into a single PDF via scripts/build_project_pdf.py,
 * and upload the result as `${projectPath}/original.pdf`.
 *
 * Idempotent via the headS3Object check in processProject — on SFN retry,
 * the second pass sees original.pdf already present and skips this function.
 * Transient staging files are retired after the server-owned final object exists; the bucket
 * lifecycle remains the backstop for a replay that completes after this cleanup attempt.
 */
async function buildProjectPdf(
  projectPath: string,
  manifest: StagingFile[],
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-concat-"));
  try {
    const fileRecords: Array<{ filename: string; tmpPath: string }> = [];
    for (const [i, sf] of manifest.entries()) {
      if (!sf.versionId) {
        throw new Error(
          `Staged file is missing its immutable S3 version: ${sf.filename}`,
        );
      }
      const buf = await downloadFromS3(sf.stagingKey, sf.versionId);
      if (buf.byteLength !== sf.size) {
        throw new Error(
          `Staged file size changed after validation: ${sf.filename}`,
        );
      }
      const localName = `${i.toString().padStart(3, "0")}_${sanitizeFilename(sf.filename)}`;
      const localPath = join(tempDir, localName);
      await writeFile(localPath, buf);
      fileRecords.push({ filename: sf.filename, tmpPath: localPath });
    }

    const outputPath = join(tempDir, "output.pdf");
    const scriptPath = join(process.cwd(), "scripts", "build_project_pdf.py");
    const result = await runPythonConcat(scriptPath, {
      files: fileRecords,
      outputPath,
    });

    if (result.status !== "ok") {
      const msg = [
        result.error,
        result.filename && `(${result.filename})`,
        result.message,
      ]
        .filter(Boolean)
        .join(" ");
      throw new Error(`build_project_pdf: ${msg || "unknown error"}`);
    }

    const pdfBuffer = await readFile(outputPath);
    await uploadToS3(
      `${projectPath}/original.pdf`,
      pdfBuffer,
      "application/pdf",
    );
    logger.info(
      `[processing] Built original.pdf from ${manifest.length} files → ${result.totalPages} pages`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function retireProjectStagingFiles(
  manifest: StagingFile[],
): Promise<void> {
  const results = await Promise.allSettled(
    manifest.map((staged) => deleteFromS3(staged.stagingKey)),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    logger.warn(
      `[processing] Could not retire ${failures.length}/${manifest.length} transient staging objects; lifecycle cleanup remains active`,
    );
  }
}

/**
 * Process a PDF project: rasterize pages, run Textract, store results.
 * Called directly by the projects route (fire-and-forget) or via the dev API route.
 *
 * @param projectId - Internal database ID of the project
 */
export async function processProject(
  projectId: number,
  writeCapability: ProjectWriteCapability,
): Promise<{
  pagesProcessed: number;
  pageErrors: number;
  processingTime: number;
}> {
  return withProjectMutationLease(
    writeCapability,
    { kind: "project-processing", idempotencyKey: String(projectId) },
    async () => processProjectWithLease(projectId, writeCapability),
  );
}

async function processProjectWithLease(
  projectId: number,
  writeCapability: ProjectWriteCapability,
): Promise<{
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
  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx
      .update(projects)
      .set({ status: "processing" })
      .where(eq(projects.id, project.id));
  });

  try {
    // Pre-stage: if original.pdf doesn't exist yet, build it from the staging
    // manifest. Idempotent — SFN retry after mid-concat failure sees the uploaded
    // original.pdf and skips. HeadObject goes direct to S3 (not CloudFront) to
    // avoid 404-cache poisoning.
    const originalKey = `${project.dataUrl}/original.pdf`;
    const originalHead = await headS3Object(originalKey);
    const manifest = project.stagingManifest as StagingFile[] | null;
    if (!originalHead.exists) {
      if (!manifest?.length) {
        throw new Error(
          `Project ${project.id} has no original.pdf and no stagingManifest — cannot start processing.`,
        );
      }
      logger.info(
        `[processing] Building original.pdf from ${manifest.length} staged files`,
      );
      await buildProjectPdf(project.dataUrl, manifest);
    }
    if (manifest?.length) {
      await retireProjectStagingFiles(manifest);
    }

    // Canonical project roots are never viewer-public. Internal work reads S3
    // with the task role rather than round-tripping through CloudFront.
    const pdfBuffer = await downloadFromS3(originalKey);

    // Get page count
    const numPages = await getPdfPageCount(pdfBuffer);
    await withProjectWrite(writeCapability, project.id, async (tx) => {
      await tx
        .update(projects)
        .set({ numPages })
        .where(eq(projects.id, project.id));
    });

    // Generate thumbnail from page 1 before parallel processing
    try {
      const thumbBuffer = await rasterizePage(pdfBuffer, 1, 72);
      await uploadToS3(
        `${project.dataUrl}/thumbnail.png`,
        thumbBuffer,
        "image/png",
        "public, max-age=31536000, immutable",
      );
    } catch (err) {
      logger.warn("Thumbnail generation failed:", err);
    }

    // Fetch company config for this project (heuristics + pipeline settings)
    let companyHeuristics: any[] | undefined;
    let pageConcurrency = resolvePageConcurrency(undefined);
    let csiSpatialGrid: { rows: number; cols: number } | undefined;
    let disabledSteps = new Set<string>();
    try {
      const [company] = await db
        .select({ pipelineConfig: companies.pipelineConfig })
        .from(companies)
        .where(eq(companies.id, project.companyId))
        .limit(1);
      companyHeuristics = company?.pipelineConfig?.heuristics;
      pageConcurrency = resolvePageConcurrency((company?.pipelineConfig?.pipeline as any)?.pageConcurrency);
      csiSpatialGrid = (company?.pipelineConfig?.pipeline as any)
        ?.csiSpatialGrid;
      // [fix 2026-10-24 T1a] top level, else the legacy nested copy the Pipeline tab used to save.
      disabledSteps = resolvePipelineToggles(company?.pipelineConfig).disabledSteps;
    } catch {
      /* ignore — use built-in defaults */
    }

    // [refactor jul9 P2-A C1] Resolve the company's CSI context ONCE, before the
    // per-page loop (I-1: async DB/S3 work happens here, outside any transaction;
    // the engine stays synchronous and receives the resolved bundle per page). One
    // resolver call per project run — no per-page I/O added. Its own PK select (the
    // :246 config select above is try-scoped/narrowed, so we do not contort it).
    const csiCtx = await getCompanyCsiContext(project.companyId);
    const tiles = await readTilesSetting(); // [tiles T9] root switch + level list, once per run; never throws

    logger.info(
      `[processing] Processing ${numPages} pages with concurrency ${pageConcurrency}`,
    );

    // Process pages in parallel with concurrency limit
    const pageNums = Array.from({ length: numPages }, (_, i) => i + 1);

    await mapConcurrent(pageNums, pageConcurrency, async (pageNum) => {
      try {
        // Check if page already has textract data (skip if re-processing)
        // [bugfix jul9 F4] pageIntelligence selected so the UPDATE branch below can
        // merge instead of wholesale-overwrite (user keys must survive re-runs).
        const [existingPage] = await db
          .select({
            id: pages.id,
            textractData: pages.textractData,
            pageIntelligence: pages.pageIntelligence,
          })
          .from(pages)
          .where(
            and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNum)),
          )
          .limit(1);

        if (existingPage?.textractData) {
          pagesProcessed++;
          return;
        }

        // Rasterize page at 300 DPI for display quality
        const pngBuffer = await rasterizePage(pdfBuffer, pageNum, 300);

        // Store page image + thumbnail to S3 for instant client-side rendering
        const pageKey = String(pageNum).padStart(4, "0");
        let tilesRecord: TilesRecord | null = null;
        try {
          await uploadToS3(
            `${project.dataUrl}/pages/page_${pageKey}.png`,
            pngBuffer,
            "image/png",
            "public, max-age=31536000, immutable",
          );
          // Generate 72 DPI thumbnail
          const thumbBuffer = await rasterizePage(pdfBuffer, pageNum, 72);
          await uploadToS3(
            `${project.dataUrl}/thumbnails/page_${pageKey}.png`,
            thumbBuffer,
            "image/png",
            "public, max-age=31536000, immutable",
          );
          // [tiles T9] tile pyramid beside the raster (root switch); a failure is one warning, never a failed page.
          if (tiles.enabled) tilesRecord = await tilePageSafely({ dataUrl: project.dataUrl, pageNumber: pageNum, png: pngBuffer, levels: tiles.levels });
        } catch (err) {
          logger.warn(`[processing] Page ${pageNum} image upload failed:`, err);
        }

        // For OCR: check if 300 DPI image exceeds Textract's 10000px dimension limit.
        // Large construction sheets (24x36", 30x42") at 300 DPI produce 10800+ px images.
        // Re-rasterize at the max safe DPI for Textract when needed (263 DPI for 24x36", 226 for 30x42").
        const TEXTRACT_MAX_PX = 9500;
        const imgWidth = pngBuffer.readUInt32BE(16);
        const imgHeight = pngBuffer.readUInt32BE(20);
        let ocrBuffer = pngBuffer;
        if (imgWidth > TEXTRACT_MAX_PX || imgHeight > TEXTRACT_MAX_PX) {
          const maxDim = Math.max(imgWidth, imgHeight);
          const safeDpi = Math.floor(300 * (TEXTRACT_MAX_PX / maxDim));
          logger.info(
            `[processing] Page ${pageNum}: ${imgWidth}x${imgHeight}px exceeds Textract limit, re-rasterizing at ${safeDpi} DPI`,
          );
          ocrBuffer = await rasterizePage(pdfBuffer, pageNum, safeDpi);
        }

        // Run Textract OCR
        const textractData = await analyzePageImageWithFallback(ocrBuffer);
        const rawText = extractRawText(textractData);

        // [zones T2] A re-run keeps the zones the YOLO step persisted (page-zones.ts) and feeds
        // them to the title-block consumers below, so text regions / drawing number / room numbers
        // never flip between the detected title block and the fixed corner by which job ran last.
        const pageZones = storedPageZones(existingPage?.pageIntelligence);

        // Extract drawing number from title block
        let drawingNumber: string | null = null;
        try {
          drawingNumber = extractDrawingNumber(textractData, null, pageZones);
        } catch (err) {
          logger.error(
            `[processing] Drawing number extraction FAILED for page ${pageNum}:`,
            err,
          );
        }

        // Detect CSI codes from the Textract LINES (+ drawing number → discipline context) so
        // each code records its trigger spans with word bboxes. [csi-v2 S6] line-neutral edit.
        let csiCodes: CsiCode[] = [];
        try {
          // [refactor jul9 P2-A C1] 4-arg: thread company config + DB (D-1/D-2).
          csiCodes = detectCsiCodes(
            rawText,
            { lines: textractData.lines, context: { drawingNumber } },
            csiCtx.config,
            csiCtx.db,
          );
        } catch (err) {
          logger.error(
            `[processing] CSI detection FAILED for page ${pageNum}:`,
            err,
          );
        }

        // Detect text annotations (phone, address, equipment tags, abbreviations, etc.)
        let textAnnotationResult: TextAnnotationResult = {
          annotations: [],
          groups: [],
          summary: {},
        };
        try {
          textAnnotationResult = detectTextAnnotations(textractData, csiCodes, undefined, pageZones);
          if (textAnnotationResult.annotations.length > 0) {
            logger.info(
              `[processing] Page ${pageNum}: found ${textAnnotationResult.annotations.length} text annotations`,
            );
          }
        } catch (err) {
          logger.error(
            `[processing] Text annotation detection FAILED for page ${pageNum}:`,
            err,
          );
        }

        // Shape parse: detect circles, diamonds, hexagons with text (OpenCV + Tesseract)
        let keynotes: any = null;
        if (!disabledSteps.has("shape-parse")) {
          try {
            const result = await extractKeynotes(pngBuffer);
            if (result.keynotes.length > 0) {
              keynotes = result.keynotes;
              logger.info(
                `[processing] Page ${pageNum}: ${result.keynotes.length} shapes detected`,
              );
            }
            // [fix 2026-10-22] REPLACE, not append: a retry/rerun of this page swaps its
            // shape-parse rows in one tx (helper owns the observe sink, gate:false). A FAILED
            // scan keeps the previous rows; a confirmed-empty scan clears them.
            if (!result.failed) {
              await replaceShapeParseAnnotations(writeCapability, project.id, pageNum, result.keynotes, "processing.shapeParse");
            }
          } catch (err) {
            logger.error(
              `[processing] Shape parse FAILED for page ${pageNum}:`,
              err,
            );
          }
        }

        // Analyze page intelligence (classification, cross-refs, note blocks)
        let pageIntelligence: Record<string, unknown> | null = null;
        try {
          const intel = analyzePageIntelligence(
            drawingNumber,
            textractData,
            csiCodes,
          );
          if (intel.classification || intel.crossRefs || intel.noteBlocks) {
            pageIntelligence = { ...intel };
          }
        } catch (err) {
          logger.error(
            `[processing] Page intelligence FAILED for page ${pageNum}:`,
            err,
          );
        }

        // Classify text regions (OCR-based table/notes/spec detection)
        try {
          const textRegions = classifyTextRegions(textractData, csiCodes, { zones: pageZones });
          if (textRegions.length > 0) {
            if (!pageIntelligence) pageIntelligence = {};
            pageIntelligence.textRegions = textRegions;
          }
          if (pageZones) (pageIntelligence ??= {}).pageZones = pageZones; // computed key: re-add or the merge drops it
        } catch (err) {
          logger.error(
            `[processing] Text region classification FAILED for page ${pageNum}:`,
            err,
          );
        }

        if (tilesRecord) (pageIntelligence ??= {}).tiles = tilesRecord; // [tiles T9] manifest pointer; NOT a computed key

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
          logger.error(
            `[processing] Heuristic engine FAILED for page ${pageNum}:`,
            err,
          );
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
          logger.error(
            `[processing] Table classification FAILED for page ${pageNum}:`,
            err,
          );
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
            undefined, // parsedRegions
            undefined, // yoloTags
            undefined, // dbAnnotations
            csiSpatialGrid,
          );
          if (spatialMap) {
            if (!pageIntelligence) pageIntelligence = {};
            (pageIntelligence as any).csiSpatialMap = spatialMap;
          }
        } catch (err) {
          logger.error(
            `[processing] CSI spatial map FAILED for page ${pageNum}:`,
            err,
          );
        }

        // [evidence T4] OCR-only evidence summary (word counts, Textract tables); YOLO load adds the rest.
        try {
          const evidence = textractData.words.length > 0 ? buildEvidenceSummary({ textract: textractData, zones: pageZones }) : null;
          if (evidence) pageIntelligence = { ...(pageIntelligence ?? {}), evidence };
        } catch (err) {
          logger.error(`[processing] Evidence summary FAILED for page ${pageNum}:`, err);
        }
        // Build page data
        const pageData: Record<string, unknown> = {
          textractData,
          rawText,
          drawingNumber,
          csiCodes: csiCodes.length > 0 ? csiCodes : null,
          textAnnotations:
            textAnnotationResult.annotations.length > 0
              ? textAnnotationResult
              : null,
          keynotes: keynotes && keynotes.length > 0 ? keynotes : null,
          pageIntelligence,
        };

        // Upsert page row
        if (existingPage) {
          // [bugfix jul9 F4 P2-phaseB, owner-sanctioned] page-level twin of G3/H6 —
          // carry user/unknown PI keys through re-processing; see
          // services/reprocess.ts intelligence branch for the canonical semantics.
          // This UPDATE used to write the freshly-built pageIntelligence WHOLESALE
          // (even null when nothing was detected), wiping parsedRegions and any
          // unknown/future key whenever processProject re-ran over an existing row
          // (processingDev has no status guard; SFN worker retries too). Base =
          // existing PI with computed keys cleared, overlay = this run's fresh keys
          // (all fresh keys are REPROCESS_COMPUTED_KEYS members). Merged-empty →
          // OMIT the column: an update must never null-out user data.
          const carried = carryNonComputedIntelligence(
            existingPage.pageIntelligence,
          );
          const mergedIntelligence = {
            ...carried,
            ...(pageIntelligence ?? {}),
          };
          const updateData: Record<string, unknown> = { ...pageData };
          if (Object.keys(mergedIntelligence).length > 0) {
            updateData.pageIntelligence = mergedIntelligence;
          } else {
            delete updateData.pageIntelligence;
          }
          await withProjectWrite(writeCapability, project.id, async (tx) => {
            await tx
              .update(pages)
              .set(updateData)
              .where(eq(pages.id, existingPage.id));
            await tx.execute(
              sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${existingPage.id}`,
            );
          });
        } else {
          const pageName = drawingNumber || `Page ${pageNum}`;
          await withProjectWrite(writeCapability, project.id, async (tx) => {
            const [newPage] = await tx
              .insert(pages)
              .values({
                pageNumber: pageNum,
                name: pageName,
                projectId: project.id,
                ...pageData,
              })
              .returning();
            await tx.execute(
              sql`UPDATE pages SET search_vector = to_tsvector('english', ${rawText}) WHERE id = ${newPage.id}`,
            );
          });
        }

        pagesProcessed++;
      } catch (err) {
        logger.error(`Error processing page ${pageNum}:`, err);
        pageErrors++;

        // Insert page row with error if it doesn't exist
        const [errPage] = await db
          .select({ id: pages.id })
          .from(pages)
          .where(
            and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNum)),
          )
          .limit(1);

        if (!errPage) {
          await withProjectWrite(writeCapability, project.id, async (tx) => {
            await tx.insert(pages).values({
              pageNumber: pageNum,
              name: `Page ${pageNum}`,
              projectId: project.id,
              error: err instanceof Error ? err.message : "Processing failed",
            });
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
        .where(and(eq(pages.projectId, project.id), visiblePage(pages.pageIntelligence)))
        .orderBy(pages.pageNumber);

      const { intelligence, summary } = analyzeProject(
        allProcessedPages.map((p) => ({
          pageNumber: p.pageNumber,
          drawingNumber: p.drawingNumber,
          pageIntelligence: p.pageIntelligence ?? null,
          csiCodes: p.csiCodes,
        })),
      );

      // [bugfix jul5 H6/DR002] preserve ALL user/unknown PI keys (classCsiOverrides,
      // yoloTags, future keys) — the old classCsiOverrides-only merge silently wiped
      // yoloTags on upload re-runs. See mergeProjectIntelligence.
      await withProjectWrite(writeCapability, project.id, async (tx) => {
        const [currentProject] = await tx
          .select({ pi: projects.projectIntelligence })
          .from(projects)
          .where(eq(projects.id, project.id));
        const mergedIntelligence = mergeProjectIntelligence(
          currentProject?.pi,
          intelligence as Record<string, unknown>,
        );
        await tx
          .update(projects)
          .set({
            projectIntelligence: mergedIntelligence,
            projectSummary: summary,
          })
          .where(eq(projects.id, project.id));
      });

      logger.info(
        `[processing] Project analysis complete: ${summary.split("\n")[0]}`,
      );
    } catch (err) {
      logger.error("[processing] Project analysis failed:", err);
    }

    // Compute project summaries (chunking indexes for sidebar/panels)
    try {
      await computeProjectSummaries(project.id, writeCapability);
      logger.info(
        `[processing] Project summaries computed for ${numPages} pages`,
      );
    } catch (err) {
      logger.error("[processing] Project summary computation failed:", err);
    }
    await refreshProjectGraph(project.id, writeCapability); // [graph T8] never throws

    // Update project status
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    await withProjectWrite(writeCapability, project.id, async (tx) => {
      await tx
        .update(projects)
        .set({
          status:
            numPages > 0 && pageErrors === numPages ? "error" : "completed",
          processingTime,
          processingError:
            pageErrors > 0 ? `${pageErrors} of ${numPages} pages failed` : null,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, project.id));
    });

    return { pagesProcessed, pageErrors, processingTime };
  } catch (err) {
    logger.error("Processing pipeline error:", err);

    await withProjectWrite(writeCapability, project.id, async (tx) => {
      await tx
        .update(projects)
        .set({
          status: "error",
          processingError:
            err instanceof Error ? err.message : "Processing failed",
          processingTime: Math.round((Date.now() - startTime) / 1000),
          updatedAt: new Date(),
        })
        .where(eq(projects.id, project.id));
    });

    throw err;
  }
}
