import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages, appSettings } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { mergeGrids, type MethodResult } from "@/lib/grid-merger";
import type { TextractPageData, TextractTable } from "@/types";
import { detectCsiFromGrid } from "@/lib/csi-detect";
import { extractWithImg2Table } from "@/lib/img2table-extract";
import { extractWithCamelotPdfplumber } from "@/lib/camelot-extract";
import { methodOcrPositions, methodTextractTables, methodOpenCvLines } from "@/lib/services/table-parse";
import { analyzePageImage } from "@/lib/textract";
import { logger } from "@/lib/logger";
import { addToHistory, type ParseHistoryEntry, type InfraStage } from "@/lib/parse-history";

/**
 * Crop a PNG buffer to a normalized region [x0, y0, x1, y1] using sharp.
 * Returns null if the crop dimensions are invalid.
 */
async function cropPngToRegion(
  pngBuffer: Buffer,
  regionBbox: [number, number, number, number],
): Promise<Buffer | null> {
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(pngBuffer).metadata();
  const imgW = metadata.width ?? 0;
  const imgH = metadata.height ?? 0;
  if (imgW === 0 || imgH === 0) return null;

  const [x0, y0, x1, y1] = regionBbox;
  let left = Math.round(x0 * imgW);
  let top = Math.round(y0 * imgH);
  let width = Math.round((x1 - x0) * imgW);
  let height = Math.round((y1 - y0) * imgH);

  // Clamp to image bounds
  left = Math.max(0, Math.min(left, imgW - 1));
  top = Math.max(0, Math.min(top, imgH - 1));
  width = Math.max(1, Math.min(width, imgW - left));
  height = Math.max(1, Math.min(height, imgH - top));

  return await sharp(pngBuffer)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
}

/**
 * Remap TextractTable bboxes from cropped-image coordinates [0,1] back to
 * full-page coordinates [0,1]. Mutates new copies; original unchanged.
 *
 * Math: cropped coord c maps to full-page coord = regionStart + c * regionSize
 */
function remapTablesToFullPage(
  tables: TextractTable[],
  regionBbox: [number, number, number, number],
): TextractTable[] {
  const [x0, y0, x1, y1] = regionBbox;
  const regionW = x1 - x0;
  const regionH = y1 - y0;
  return tables.map((t) => ({
    ...t,
    bbox: [
      x0 + t.bbox[0] * regionW,
      y0 + t.bbox[1] * regionH,
      t.bbox[2] * regionW,
      t.bbox[3] * regionH,
    ] as [number, number, number, number],
    cells: t.cells.map((c) => ({
      ...c,
      bbox: [
        x0 + c.bbox[0] * regionW,
        y0 + c.bbox[1] * regionH,
        c.bbox[2] * regionW,
        c.bbox[3] * regionH,
      ] as [number, number, number, number],
    })),
  }));
}

/**
 * Check if any table in the cached set has meaningful overlap (>=30%) with
 * the region. Matches the threshold used in methodTextractTables so a cache
 * hit means the cached tables are actually usable for this region.
 */
function hasOverlappingTable(
  tables: TextractTable[],
  regionBbox: [number, number, number, number],
): boolean {
  const [rMinX, rMinY, rMaxX, rMaxY] = regionBbox;
  const regionArea = (rMaxX - rMinX) * (rMaxY - rMinY);
  if (regionArea <= 0) return false;

  for (const table of tables) {
    const [tL, tT, tW, tH] = table.bbox;
    const intMinX = Math.max(rMinX, tL);
    const intMinY = Math.max(rMinY, tT);
    const intMaxX = Math.min(rMaxX, tL + tW);
    const intMaxY = Math.min(rMaxY, tT + tH);
    if (intMinX < intMaxX && intMinY < intMaxY) {
      const intArea = (intMaxX - intMinX) * (intMaxY - intMinY);
      if (intArea / regionArea >= 0.3) return true;
    }
  }
  return false;
}

/**
 * Textract tables with region-aware caching and cropping.
 *
 * Logic:
 * 1. If cache has a table that overlaps this region → use cache (fast path,
 *    happy case when initial processing's full-page Textract succeeded).
 * 2. Else → crop PNG to region, call Textract live, remap bboxes back to
 *    full-page coords, return result. We intentionally do NOT write the
 *    region-specific result to `pages.textractData.tables` because that cache
 *    slot represents page-wide data and storing region-specific tables there
 *    would poison subsequent parses of other regions on the same page.
 *    Each region is its own Textract call until we add a per-region cache.
 */
async function resolveTextractTables(
  textractData: TextractPageData,
  dataUrl: string,
  pageNumber: number,
  regionBbox: [number, number, number, number],
): Promise<MethodResult> {
  // Cache hit: only if at least one cached table actually overlaps the region
  if (
    textractData.tables &&
    textractData.tables.length > 0 &&
    hasOverlappingTable(textractData.tables, regionBbox)
  ) {
    return methodTextractTables(textractData.tables, regionBbox);
  }

  try {
    const s3Key = `${dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;
    const pngBuffer = await downloadFromS3(s3Key);

    // Crop PNG to just the user's region before sending to Textract.
    // Textract's TABLES feature gets confused by dense blueprint noise —
    // cropping gives it a clean, focused view of the table.
    const croppedBuffer = await cropPngToRegion(pngBuffer, regionBbox);
    if (!croppedBuffer) {
      logger.warn(`[table-parse] Could not crop PNG for page ${pageNumber}`);
      return methodTextractTables(undefined, regionBbox);
    }

    const freshData = await analyzePageImage(croppedBuffer);

    if (freshData.tables && freshData.tables.length > 0) {
      // Remap cropped-image coords back to full-page coords so the merger
      // pipeline sees consistent coordinates across all methods.
      const remappedTables = remapTablesToFullPage(freshData.tables, regionBbox);
      logger.info(`[table-parse] Live Textract (cropped) found ${remappedTables.length} table(s) for page ${pageNumber}`);
      return methodTextractTables(remappedTables, regionBbox);
    }

    return methodTextractTables(undefined, regionBbox);
  } catch (err) {
    logger.warn(`[table-parse] Live Textract (cropped) failed for page ${pageNumber}:`, err);
    return methodTextractTables(undefined, regionBbox);
  }
}

/**
 * POST /api/table-parse
 *
 * Runs multiple parsing methods on a user-selected table region,
 * merges results, and returns the best grid.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const {
    projectId, pageNumber, regionBbox,
    rowTolerance, minColGap, colHitRatio, headerMode,
    minHLineLengthRatio, minVLineLengthRatio, clusteringTolerance,
    mergerEditDistance,
    debugMode,
  } = body as {
    projectId: number;
    pageNumber: number;
    regionBbox: [number, number, number, number];
    rowTolerance?: number;
    minColGap?: number;
    colHitRatio?: number;
    headerMode?: "auto" | "first" | "none";
    minHLineLengthRatio?: number;
    minVLineLengthRatio?: number;
    clusteringTolerance?: number;
    mergerEditDistance?: number;
    // D-cleanup: debug mode gates per-method drill-down. Default OFF — production
    // users see merged result only. Developers/admins flip via env var or
    // localStorage on the client. See AutoParseTab.tsx isTableParseDebugMode().
    debugMode?: boolean;
  };

  if (!projectId || !pageNumber || !regionBbox || regionBbox.length !== 4) {
    return apiError("Missing projectId, pageNumber, or regionBbox", 400);
  }

  const [bx0, by0, bx1, by1] = regionBbox;
  if (![bx0, by0, bx1, by1].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1) || bx0 >= bx1 || by0 >= by1) {
    return apiError("Invalid regionBbox: values must be finite numbers in [0,1] with min < max", 400);
  }

  const access = await resolveProjectAccess({ dbId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  try {
    const [pageRow] = await db
      .select({ id: pages.id, textractData: pages.textractData })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
      .limit(1);

    if (!pageRow?.textractData) {
      return apiError("Page has no OCR data", 404);
    }

    const textractData = pageRow.textractData as TextractPageData;

    // Phase I.2.e: persistent debug toggle. Server-side appSettings.tableParse.debugMode
    // overrides the per-request flag — when ON, every parse returns full methodResults
    // regardless of what the client asked for. Used by admins to enable detailed logging
    // for everyone without requiring each user to flip localStorage.
    let effectiveDebugMode = !!debugMode;
    try {
      const [setting] = await db.select().from(appSettings).where(eq(appSettings.key, "tableParse.debugMode")).limit(1);
      const persistentEnabled = (setting?.value as { enabled?: boolean } | undefined)?.enabled;
      if (persistentEnabled) effectiveDebugMode = true;
    } catch {
      // appSettings query failure is non-fatal — fall back to request-level flag
    }

    // Fetch PDF + rasterize for image-based methods.
    // Phase A.1: capture infrastructure failures explicitly so the UI can
    // distinguish "method ran and found nothing" from "method never ran".
    const infraErrors: { stage: string; error: string }[] = [];
    // Phase I.1.b: capture infrastructure stage timings + sizes for the debug UI.
    const infraStages: InfraStage[] = [];
    const parseStartedAt = Date.now();
    let pdfBuffer: Buffer | null = null;
    let pagePngBuffer: Buffer | null = null;

    // Phase B.4: use AWS SDK directly (matches /api/table-structure/route.ts).
    // Previously used fetch(getS3Url(...)) which silently failed on private S3
    // buckets when CloudFront isn't configured — that was the most likely
    // production root cause for img2table appearing to "do nothing".
    {
      const t0 = Date.now();
      try {
        pdfBuffer = await downloadFromS3(`${project.dataUrl}/original.pdf`);
        infraStages.push({ stage: "pdf-download", durationMs: Date.now() - t0, sizeBytes: pdfBuffer.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        infraErrors.push({ stage: "pdf-download", error: msg });
        infraStages.push({ stage: "pdf-download", durationMs: Date.now() - t0, error: msg });
        logger.error(`[table-parse] PDF download failed: ${msg}`, { projectId, pageNumber, dataUrl: project.dataUrl });
      }
    }

    if (pdfBuffer) {
      const t0 = Date.now();
      try {
        pagePngBuffer = await rasterizePage(pdfBuffer, pageNumber, 200);
        // PNG dimensions live in bytes 16-19 (width) and 20-23 (height) per the PNG spec
        const width = pagePngBuffer.readUInt32BE(16);
        const height = pagePngBuffer.readUInt32BE(20);
        infraStages.push({ stage: "rasterize", durationMs: Date.now() - t0, sizeBytes: pagePngBuffer.length, dimensions: { width, height } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        infraErrors.push({ stage: "rasterize", error: msg });
        infraStages.push({ stage: "rasterize", durationMs: Date.now() - t0, error: msg });
        logger.error(`[table-parse] Rasterize failed: ${msg}`, { projectId, pageNumber, pdfBytes: pdfBuffer.length });
      }
    }

    // Run methods in parallel. Methods that need PDF/PNG that we don't have
    // get an explicit "skipped" error so the UI can show why they're missing
    // instead of silently displaying an empty result as success.
    const skippedReason = (need: string) =>
      infraErrors.length > 0
        ? `skipped: ${need} unavailable (see infraErrors)`
        : `skipped: ${need} unavailable`;

    // Phase I.1.b: time each method invocation independently and inject the
    // wall-clock duration into result.debug.durationMs. Methods run in parallel
    // (Promise.all below) so each stopwatch starts when the promise begins.
    const timed = async <T extends MethodResult | MethodResult[]>(promise: Promise<T>): Promise<T> => {
      const t0 = Date.now();
      const result = await promise;
      const durationMs = Date.now() - t0;
      if (Array.isArray(result)) {
        return result.map((r) => ({ ...r, debug: { ...r.debug, durationMs } })) as T;
      }
      return { ...result, debug: { ...result.debug, durationMs } } as T;
    };

    const methodPromises: Promise<MethodResult | MethodResult[]>[] = [
      timed(Promise.resolve(methodOcrPositions(textractData.words, regionBbox, { rowTolerance, minColGap, colHitRatio, headerMode }))),
      timed(resolveTextractTables(textractData, project.dataUrl || "", pageNumber, regionBbox)),
      pagePngBuffer && pdfBuffer
        ? timed(methodOpenCvLines(pdfBuffer, pageNumber, regionBbox, textractData.words, { minHLineLengthRatio, minVLineLengthRatio, clusteringTolerance }))
        : Promise.resolve({ method: "opencv-lines", headers: [], rows: [], confidence: 0, error: skippedReason("page image") } as MethodResult),
      // Phase C.3: img2table now accepts both pdfBuffer (for native PDF mode)
      // and pngBuffer (for image mode + auto-fallback). After Phase B.4 the
      // pdfBuffer is reliably populated via downloadFromS3, so PDF mode runs
      // by default. Image mode is the fallback if PDF mode finds nothing.
      (pdfBuffer || pagePngBuffer)
        ? timed(extractWithImg2Table(pdfBuffer, pagePngBuffer, pageNumber, regionBbox))
        : Promise.resolve({ method: "img2table", headers: [], rows: [], confidence: 0, error: skippedReason("PDF and page image") } as MethodResult),
      pdfBuffer
        ? timed(extractWithCamelotPdfplumber(pdfBuffer, pageNumber, regionBbox))
        : Promise.resolve([
            { method: "camelot-lattice", headers: [], rows: [], confidence: 0, error: skippedReason("PDF") } as MethodResult,
            { method: "camelot-stream", headers: [], rows: [], confidence: 0, error: skippedReason("PDF") } as MethodResult,
            { method: "pdfplumber", headers: [], rows: [], confidence: 0, error: skippedReason("PDF") } as MethodResult,
          ]),
    ];

    const rawResults = await Promise.all(methodPromises);
    const results: MethodResult[] = rawResults.flat() as MethodResult[];

    logger.info(
      `[table-parse] Page ${pageNumber}: ` +
      results.map((r) => `${r.method}=${r.confidence.toFixed(2)} (${r.rows.length}r×${r.headers.length}c)`).join(", ")
    );

    const merged = mergeGrids(results, { editDistanceThreshold: mergerEditDistance });

    // Auto-detect CSI codes from parsed content
    try {
      const csiCodes = detectCsiFromGrid(merged.headers || [], merged.rows || []);
      (merged as any).csiTags = csiCodes.map((c) => ({ code: c.code, description: c.description }));
    } catch { /* CSI detection is best-effort */ }

    // Phase I.1.b: total parse wall-clock duration
    const totalDurationMs = Date.now() - parseStartedAt;

    // Phase I.1.g: ALWAYS write to the ring buffer with FULL methodResults,
    // regardless of the request's debugMode flag. This way the admin debug page
    // can show complete history even for parses that didn't request debug data.
    // The public API response still respects debugMode (see below).
    const historyEntry: ParseHistoryEntry = {
      id: randomUUID(),
      timestamp: new Date(parseStartedAt).toISOString(),
      request: {
        projectId,
        pageNumber,
        regionBbox,
        debugMode: !!debugMode,
        options: { rowTolerance, minColGap, colHitRatio, headerMode, minHLineLengthRatio, minVLineLengthRatio, clusteringTolerance, mergerEditDistance },
      },
      response: {
        status: 200,
        durationMs: totalDurationMs,
        headers: merged.headers,
        rowCount: merged.rows.length,
        confidence: merged.confidence,
        tagColumn: merged.tagColumn,
        methods: merged.methods,
        methodResults: results,
        infraStages,
        infraErrors,
        mergerNotes: merged.mergerNotes,
      },
    };
    addToHistory(historyEntry);

    // Phase D.1 + D-cleanup: per-method results are included only when the
    // client opts in via debugMode. Default response is merged + infraErrors —
    // clean UX for end users. Debug mode is gated client-side via env var or
    // localStorage flag (see AutoParseTab.tsx isTableParseDebugMode()).
    // infraErrors is always returned: pipeline-level failures are user-relevant,
    // not just developer-relevant.
    // Phase I.1.g: also include infraStages in the public response when debug is on.
    const responseBody: Record<string, unknown> = { ...merged, infraErrors };
    if (effectiveDebugMode) {
      responseBody.methodResults = results.filter(
        (r) => (r.headers.length > 0 && r.rows.length > 0) || r.error
      );
      responseBody.infraStages = infraStages;
      responseBody.totalDurationMs = totalDurationMs;
    }

    return NextResponse.json(responseBody);
  } catch (err) {
    logger.error("[table-parse] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Table parsing failed", 500);
  }
}
