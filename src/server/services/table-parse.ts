// [refactor jul5 S027] /api/table-parse route contract, folded from the legacy fat route
// (git show 9806287^:src/app/api/table-parse/route.ts).
//
// ⚠️ NAME COLLISION, DELIBERATE PATHS: THIS file (@/server/services/table-parse) is the
// ROUTE CONTRACT (cascade, gates, infra orchestration, response shaping). The merge-pipeline
// ENGINE lives at @/lib/services/table-parse (methodOcrPositions / methodTextractTables /
// methodOpenCvLines) and is BYTE-UNTOUCHED by this fold, as are grid-merger, csi-detect,
// img2table-extract, textract, pdf-rasterize, parse-history.
//
// Char file: __tests__/table-parse.route.test.ts (TQ-1..TQ-7). Frozen highlights:
//   • TQ-1 validate-before-auth: field/bbox 400s → resolveProjectOrThrow({dbId},{allowDemo:
//     true}) → project.isDemo gate assertDemoFeatureEnabled(companyId,"tableParse") returned
//     VERBATIM (flat 403 — demo-features owns the shape; symbol-search/labeling precedent).
//     NOTE: isDemo convention here is project.isDemo (like symbol-search), NOT ai-chat's
//     access-scope — do not harmonize either way.
//   • TQ-3 effectiveDebugMode = request debugMode || appSettings["tableParse.debugMode"]
//     .value.enabled — the appSettings read keeps its own swallow catch (non-fatal).
//   • TQ-4 default response {...merged, csiTags?, infraErrors}; debug adds methodResults
//     (headers>0&&rows>0 || error), infraStages, totalDurationMs. csiTags via best-effort
//     empty catch → key ABSENT on detect throw. History ring buffer ALWAYS gets full
//     methodResults (randomUUID id + fresh ISO — server-side only, never the response).
//   • TQ-5 textract cache-hit (≥30% region overlap) vs live crop→analyze→REMAP path (the
//     region-specific result is deliberately NOT written back to pages.textractData.tables
//     — that slot is page-wide; caching region results there would poison other regions);
//     every live-path failure soft-fails to methodTextractTables(undefined, bbox).
//   • TQ-6 infra failures land in infraErrors (always returned) + skippedReason strings;
//     TQ-7 timed() injects debug.durationMs into every method result pre-merge (its
//     array branch is defensive/unused — kept, engine-shape contract).
//   • Sanctioned diff B: the legacy catch-all leaked err.message ?? "Table parsing failed"
//     at a flat 500 — RETIRED; unexpected throws now propagate to the shell's generic
//     INTERNAL 500. Diff E: body-parse moved to the shell (legacy req.json was pre-try →
//     raw rejections). DECLINED: integer guard on dbId (negative → 404 pinned).

import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { pages, appSettings } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { mergeGrids, type MethodResult } from "@/lib/grid-merger";
import type { TextractPageData, TextractTable } from "@/types";
import { detectCsiFromGrid } from "@/lib/csi-detect";
// [refactor jul9 P2-A C1] company CSI context resolver (config + custom DB), threaded into
// the best-effort table-parse detect below (D-1/D-2).
import { getCompanyCsiContext } from "@/lib/csi-company-db";
import { extractWithImg2Table } from "@/lib/img2table-extract";
import { methodOcrPositions, methodTextractTables, methodOpenCvLines } from "@/lib/services/table-parse";
import { analyzePageImage } from "@/lib/textract";
import { logger } from "@/lib/logger";
import { addToHistory, type ParseHistoryEntry, type InfraStage } from "@/lib/parse-history";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { ApiError } from "@/server/api/envelope";
import { assertPageNumber } from "@/server/api/parser-input";
import { resolveProjectOrThrow } from "@/server/api/access";
import { audit } from "@/lib/audit";
import { checkTextractCap, recordComputeUsage } from "@/lib/compute-usage";

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
  allowLiveTextract: () => Promise<boolean>,
): Promise<MethodResult> {
  // Cache hit: only if at least one cached table actually overlaps the region
  if (
    textractData.tables &&
    textractData.tables.length > 0 &&
    hasOverlappingTable(textractData.tables, regionBbox)
  ) {
    return methodTextractTables(textractData.tables, regionBbox);
  }

  // Demo projects are anonymous. The caller picks the region, so the caller picks the cache
  // miss, and every miss below is a paid AnalyzeDocument call. Demo is cache-only; the other
  // three methods still run. [2026-10-25] For everyone else the callback charges ONE Textract
  // page against the company cap (lib/compute-usage.ts) and refuses past it — cache-only then.
  if (!(await allowLiveTextract())) return methodTextractTables(undefined, regionBbox);

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
 * POST /api/table-parse — runs multiple parsing methods on a user-selected table
 * region, merges results, and returns the best grid. Returns the response body as a
 * plain object (the shell wraps it) OR the demo-gate NextResponse verbatim (passthrough).
 */
export async function tableParse(rawBody: Record<string, unknown>): Promise<unknown> {
  const {
    projectId, pageNumber, regionBbox,
    rowTolerance, minColGap, colHitRatio, headerMode,
    minHLineLengthRatio, minVLineLengthRatio, clusteringTolerance,
    mergerEditDistance,
    debugMode,
  } = rawBody as {
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
    throw new ApiError("VALIDATION", "Missing projectId, pageNumber, or regionBbox");
  }
  assertPageNumber(pageNumber);

  const [bx0, by0, bx1, by1] = regionBbox;
  if (![bx0, by0, bx1, by1].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1) || bx0 >= bx1 || by0 >= by1) {
    throw new ApiError("VALIDATION", "Invalid regionBbox: values must be finite numbers in [0,1] with min < max");
  }

  const { project, session } = await resolveProjectOrThrow({ dbId: projectId }, { allowDemo: true });

  if (project.isDemo) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "tableParse");
    if (gate) return gate; // flat 403 passthrough — does NOT flip here (TQ-1)
  }
  // [2026-10-25] Owner-billed live Textract on a cache miss: never for demo; capped per company
  // for members (root is exempt from the cap but its usage is still recorded).
  const allowLiveTextract = async (): Promise<boolean> => {
    if (project.isDemo) return false;
    const isRoot = session?.user?.isRootAdmin === true;
    const cap = isRoot ? { allowed: true } : await checkTextractCap(project.companyId, 1);
    if (!cap.allowed) {
      audit("textract_cap_hit", { userId: session?.user?.dbId, companyId: project.companyId, details: { projectId: project.id, pageNumber, surface: "table-parse" } });
      return false;
    }
    await recordComputeUsage({ companyId: project.companyId, userId: session?.user?.dbId ?? null, projectId: project.id, resource: "textract", pages: 1 }).catch(() => {});
    return true;
  };

  // [refactor jul9 P2-A C1 · DETECTOR closer jul9] Resolve the company CSI context AFTER the
  // demo 403 gate (was before it): a disabled-tableParse demo project no longer does the PK
  // SELECT + possible custom-DB S3 GET just to then 403 (C6 review, CONFIRMED efficiency nit).
  // Response is byte-identical either way; no tx around the detect, engine stays sync.
  const csiCtx = await getCompanyCsiContext(project.companyId);

  const [pageRow] = await db
    .select({ id: pages.id, textractData: pages.textractData })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
    .limit(1);

  if (!pageRow?.textractData) {
    throw new ApiError("NOT_FOUND", "Page has no OCR data");
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
    timed(resolveTextractTables(textractData, project.dataUrl || "", pageNumber, regionBbox, allowLiveTextract)),
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
    // [refactor jul9 P2-A C1] 4-arg: thread company config + DB (D-1/D-2).
    const csiCodes = detectCsiFromGrid(merged.headers || [], merged.rows || [], csiCtx.config, csiCtx.db);
    (merged as any).csiTags = csiCodes.map((c) => ({ code: c.code, description: c.description }));
  } catch { /* CSI detection is best-effort */ }

  // Phase I.1.b: total parse wall-clock duration
  const totalDurationMs = Date.now() - parseStartedAt;

  // Phase I.1.g: ALWAYS record the parse with FULL methodResults, regardless of
  // the request's debugMode flag. This way the admin debug page can show complete
  // history even for parses that didn't request debug data. (Storage is the shared
  // op_log table via parse-history — see the awaited addToHistory below.)
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
  // [refactor jul23 P5.4-C] addToHistory now writes op_log (async). Awaited so a
  // write failure surfaces rather than becoming an unhandled rejection; the
  // response shape is unchanged.
  await addToHistory(historyEntry);

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

  return responseBody;
}
