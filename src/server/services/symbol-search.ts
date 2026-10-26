// [refactor jul4 S024] Symbol-Search service — the symbol-search route's behavior.
//
// `/api/symbol-search` (POST, streaming NDJSON) is now a thin `defineRoute` shell; ALL behavior
// lives here. The matching ENGINES stay in @/lib/template-match (local python3 spawn) and
// @/lib/lambda-cv (Lambda fan-out) — this service is the ROUTE contract: validation cascade,
// access + demo gate, PDF fetch + template crop, branch dispatch, and the two NDJSON streams.
// The inline python3/OpenCV crop moved VERBATIM to @/lib/template-crop (its own mockable seam).
// The FIRST stream-kind fold: the NDJSON Response rides the shell's `result instanceof Response`
// passthrough (it fires before the kind check) — once this fn returns, EVERYTHING in-stream
// (progress / done / {type:"error"} at HTTP 200) is emitted here byte-identically to legacy and
// is invisible to the shell. Errors that must carry an HTTP status are thrown BEFORE the
// Response is constructed.
//
// Shape: VALIDATE-BEFORE-AUTH (legacy ran the field+bbox cascade BEFORE resolveProjectAccess
// and the demo-only feature gate) → the shell is auth:"none" + body:zLooseBody and THIS fn
// validates fields FIRST, resolves access AFTER (an invalid body 400s even signed-out on an
// unknown project — frozen). Access = resolveProjectOrThrow({dbId}, {allowDemo:true}) — dbId
// from the BODY (not a publicId path param — differs from the projects leaves): demo projects
// are a PUBLIC read, unknown/cross-tenant/negative → 404 BEFORE auth, root bypass. Then the
// DEMO-ONLY kill-switch gate (fires for ANY scope on a demo project, never for non-demo, and
// BEFORE the dataUrl check) → !dataUrl 404 → 0-pages 400 → PDF fetch 500.
//
// Sanctioned diffs ONLY (stream bodies byte-identical):
//   A envelope flips {error:string} → {error:{code,message}} on the pre-stream errors; messages
//     byte-verbatim. EXCEPTION: the demo-gate 403 NextResponse is returned VERBATIM via the
//     passthrough (demo-features.ts owns that 403's shape everywhere; labeling's FQ-8 was the
//     precedent and has since been retired — this flips only when demo-features itself migrates).
//     ⚠️ "Failed to fetch PDF" / "No page images available" are ApiError("INTERNAL", msg) 500s
//     whose CONTROLLED messages surface verbatim — defineRoute's catch forwards ANY ApiError's
//     message. That is the DOCUMENTED contract, not a contradiction: envelope.ts's ApiError
//     JSDoc states it explicitly (DR003 FIX-2; also noted at S015). The char test pins both
//     strings, and the surfacing is load-bearing — do NOT "fix" it to be generic.
//   B leak-drop: legacy's catch-all `apiError(err.message, 500)` (old route.ts:430) leaked
//     arbitrary internals (pg/S3/fs/python messages) — an unexpected throw now hits the shell's
//     generic INTERNAL 500; real cause logged server-side with requestId. The legacy
//     "[SYMBOL_SEARCH] Failed:" log line is retired with it (the shell logs instead).
//   E malformed JSON → the shell's BAD_REQUEST 400; empty / JSON-null bodies → zLooseBody
//     VALIDATION 400 (both were legacy raw rejections at the unguarded req.json()/destructure);
//     number/array bodies → VALIDATION 400 (legacy destructured-to-undefined → the field 400;
//     STATUS preserved, message drifts — the S013 cosmetic class).
//   (no diff C/D: a non-castable string projectId was a legacy raw pg-cast rejection → now the
//   shell's generic INTERNAL 500 [that's B]; a NEGATIVE int stays a 404 query-miss — adding a
//   Number.isInteger guard would flip it 404→400, DECLINED as unsanctioned.)
//
// Frozen quirks (do NOT "fix"):
//   FQ-1  match id `sm-${Date.now()}-${i}` — nondeterministic, uniqueness only from `i`.
//   FQ-2  searchedAt = fresh ISO at stream END (after OCR bind), per branch.
//   FQ-3  done.templateBbox echoes the REQUEST bbox denormalized as [x,y,w,h] (array, not
//         BboxMinMax, not the pixel crop rect).
//   FQ-4  the engine's per-match `scale` field is DROPPED in both branches.
//   FQ-5  boundText: explicit null when OCR-bind ran and found nothing; key ENTIRELY ABSENT
//         when bindOcrToShapes threw (soft-fail swallow happens before the assignment loop).
//   FQ-6  TWO done shapes: Lambda spreads failedPages ONLY when non-empty; local NEVER emits it.
//   FQ-7  THREE progress variants: Lambda dispatch {page:0,pageIndex:0,matches:0,message:
//         "Dispatching to Lambda workers..."}; Lambda per-batch {page:0,pageIndex:pagesDone,
//         matches:cumulative,message:"Batch X/N complete"} (out-of-order batch labels expected);
//         local {page:realPage,pageIndex:targetIndex+1,NO message key, matches per-callback}.
//   FQ-8  Lambda `matches` is cumulative; local `matches` is the engine's per-callback count.
//   FQ-9  in-stream {type:"error"} at HTTP 200 leaks err.message verbatim, per-branch fallback
//         literals "Lambda symbol search failed" / "Symbol search failed" — ZERO diff (rides at
//         200; the shell never sees it).
//   FQ-10 scale list: for(s=scaleMin; s<=scaleMax+0.001; s+=0.1) round(s*100)/100, fallback
//         [1.0]; the +0.001 fencepost epsilon; DUPLICATED in both branches (legacy layout).
//   FQ-11 the Lambda try/catch falls back to LOCAL only for PRE-stream failures (realistically
//         the readFile of the cropped template); once the Response is returned, a Lambda failure
//         is an in-stream {type:"error"}, NOT a fallback.
//   FQ-12 source raster 300 DPI; per-page fallback raster 200 DPI; PNG dims read at bytes 16/20.
//   FQ-13 the missing-field check is TRUTHY — projectId:0 / sourcePageNumber:0 trip "Missing…".
//   FQ-14 local download pool CONCURRENCY=4; results re-sorted by pageNum (deterministic order).
//   FQ-15 per-page download/raster failures are logged + silently DROPPED; only ALL-fail →
//         "No page images available".
//   FQ-16 tempDir cleanup: each stream's own finally rm's it after draining; pre-stream throws
//         rm it in the catch-rethrow below. (Legacy LEAKED tempDir on its three early-return
//         paths — collapsing them into cleaned throws is server-side hygiene, HTTP-invisible.)
//
// PERF/ops pins: Content-Type application/x-ndjson + Transfer-Encoding chunked + Cache-Control
// no-cache ride on the returned Response untouched. middleware.ts rate-limits the path via its
// ABUSIVE_ROUTE_PREFIXES list — the route file must stay at /api/symbol-search. The sole consumer
// (SymbolSearchPanel) holds a 10-min AbortController.

import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ApiError } from "@/server/api/envelope";
import { assertPageNumber } from "@/server/api/parser-input";
import { resolveProjectOrThrow } from "@/server/api/access";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { readFile, writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { templateMatch } from "@/lib/template-match";
import { cropTemplateRegion } from "@/lib/template-crop";
import { isLambdaCvEnabled, fanOutTemplateMatch, TEMPLATE_MATCH_BATCH_SIZE } from "@/lib/lambda-cv";
import { checkLambdaQuota } from "@/lib/quotas";
import { recordComputeUsage } from "@/lib/compute-usage";
import { bindOcrToShapes } from "@/lib/ocr-shape-binding";
import type { TemplateMatchProgress, SymbolSearchMatch, TextractPageData, BboxMinMax } from "@/types";
import { logger } from "@/lib/logger";
import { withHeavyProcessSlot } from "@/lib/heavy-process-gate";

const MAX_SEARCH_PAGES = 5_000;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export async function symbolSearch(rawBody: Record<string, unknown>): Promise<Response> {
  const {
    projectId,
    sourcePageNumber,
    templateBbox,
    searchPages,
    multiScale = true,
    useSiftFallback = true,
    ...knobs
  } = rawBody as {
    projectId: number;
    sourcePageNumber: number;
    templateBbox: { x: number; y: number; w: number; h: number };
    confidenceThreshold?: number;
    searchPages?: number[];
    multiScale?: boolean;
    useSiftFallback?: boolean;
    scaleMin?: number;
    scaleMax?: number;
    nmsThreshold?: number;
    maxMatchesPerPage?: number;
  };
  // Reachable anonymously on a demo project, and these feed a loop bound and the Lambda config
  // verbatim: `scaleMax: 1e12` builds a multi-gigabyte array, `confidenceThreshold: -1` makes
  // every pixel a match. Clamp to the ranges the UI sliders can produce.
  const confidenceThreshold = clampNumber(knobs.confidenceThreshold, 0.75, 0.1, 1);
  const scaleMin = clampNumber(knobs.scaleMin, 0.8, 0.25, 3);
  const scaleMax = Math.max(scaleMin, clampNumber(knobs.scaleMax, 1.5, 0.25, 3));
  const nmsThreshold = clampNumber(knobs.nmsThreshold, 0.3, 0, 1);
  const maxMatchesPerPage = Math.round(clampNumber(knobs.maxMatchesPerPage, 50, 1, 200));

  if (!projectId || !sourcePageNumber || !templateBbox) {
    throw new ApiError("VALIDATION", "Missing projectId, sourcePageNumber, or templateBbox"); // FQ-13
  }
  assertPageNumber(sourcePageNumber, "sourcePageNumber");
  if (
    searchPages !== undefined &&
    searchPages !== null &&
    (!Array.isArray(searchPages) ||
      searchPages.length > MAX_SEARCH_PAGES ||
      !searchPages.every((n) => Number.isInteger(n) && n >= 1))
  ) {
    throw new ApiError("VALIDATION", "Invalid searchPages");
  }

  // Bbox validation
  const { x, y, w, h } = templateBbox;
  if (![x, y, w, h].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1) || w <= 0 || h <= 0) {
    throw new ApiError("VALIDATION", "Invalid templateBbox");
  }

  const { project, session } = await resolveProjectOrThrow({ dbId: projectId }, { allowDemo: true });
  // This route answers with a stream, so the route-level anonymous slot is released the moment the
  // Response exists — before the LOCAL branch below starts its python child inside the stream.
  // Hold a slot of our own around that child for a caller with no session. (The Lambda branch
  // starts no local child; production runs it.)
  const localHeavy = session
    ? <T,>(task: () => Promise<T>) => task()
    : <T,>(task: () => Promise<T>) => withHeavyProcessSlot(task);

  if (project.isDemo) {
    // Returned VERBATIM (old {error:string} envelope) via the shell passthrough — see header.
    const gate = await assertDemoFeatureEnabled(project.companyId, "symbolSearch");
    if (gate) return gate;
  }

  if (!project.dataUrl) {
    throw new ApiError("NOT_FOUND", "Project not found");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "bp2-symbol-search-"));

  try {

    // ─── Get all pages to search ─────────────────────────────
    const allPages = await db
      .select({ pageNumber: pages.pageNumber })
      .from(pages)
      .where(eq(pages.projectId, project.id))
      .orderBy(pages.pageNumber);

    const pageNumbers = searchPages
      ? allPages.filter((p) => searchPages.includes(p.pageNumber)).map((p) => p.pageNumber)
      : allPages.map((p) => p.pageNumber);

    if (pageNumbers.length === 0) {
      throw new ApiError("VALIDATION", "No pages to search");
    }

    // ─── Download PDF and rasterize source page for template ──
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await downloadFromS3(`${project.dataUrl}/original.pdf`);
    } catch {
      throw new ApiError("INTERNAL", "Failed to fetch PDF"); // controlled message, surfaces verbatim — see header
    }

    // Rasterize source page at 300 DPI for template extraction (FQ-12)
    const sourcePng = await rasterizePage(pdfBuffer, sourcePageNumber, 300);

    // Get image dimensions from PNG header (bytes 16-23: width, height as uint32 BE)
    const imgW = sourcePng.readUInt32BE(16);
    const imgH = sourcePng.readUInt32BE(20);

    const sourcePagePath = join(tempDir, "source.png");
    await writeFile(sourcePagePath, sourcePng);

    // Crop using pixel coordinates derived from normalized bbox
    const cropX = Math.round(templateBbox.x * imgW);
    const cropY = Math.round(templateBbox.y * imgH);
    const cropW = Math.max(1, Math.round(templateBbox.w * imgW));
    const cropH = Math.max(1, Math.round(templateBbox.h * imgH));

    const templatePath = join(tempDir, "template.png");
    await cropTemplateRegion({
      sourcePagePath,
      templatePath,
      x: cropX,
      y: cropY,
      w: cropW,
      h: cropH,
    });

    // ─── Lambda path: fan out across Lambda workers ─────────
    if (isLambdaCvEnabled()) {
      // [2026-10-25] Owner-billed fan-out: one Lambda page per searched page, inside the root-set
      // daily quota (root exempt, usage still recorded below).
      const lambdaQuota = await checkLambdaQuota(project.companyId, session?.user?.isRootAdmin === true, session?.user?.dbId, pageNumbers.length);
      if (!lambdaQuota.allowed) throw new ApiError("RATE_LIMITED", lambdaQuota.message ?? "Daily Lambda page limit reached");
      try {
        const templateBuffer = await readFile(templatePath);
        const pageS3Keys = pageNumbers.map(
          (n) => `${project.dataUrl}/pages/page_${String(n).padStart(4, "0")}.png`
        );

        const scales: number[] = []; // FQ-10
        for (let s = scaleMin; s <= scaleMax + 0.001; s += 0.1) {
          scales.push(Math.round(s * 100) / 100);
        }
        if (scales.length === 0) scales.push(1.0);

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              controller.enqueue(encoder.encode(JSON.stringify({
                type: "progress", page: 0, pageIndex: 0,
                totalPages: pageNumbers.length, matches: 0,
                message: `Dispatching to Lambda workers...`,
              }) + "\n"));

              const totalBatches = Math.ceil(pageNumbers.length / TEMPLATE_MATCH_BATCH_SIZE);
              // NOTE: after lambda-cv's per-batch fanOut refactor, onBatchComplete
              // fires as each Lambda settles — which may be OUT OF ORDER (batch 3
              // before batch 1 if batch 3 returns faster). `batchesDone` is a count,
              // not an index, so `pagesDone` grows monotonically and the progress
              // bar is stable. The `Batch X/N complete` MESSAGE string can appear
              // to jump around (e.g. "Batch 4/10", "Batch 1/10") — that's expected,
              // not a bug worth "fixing". The client UI shows pageIndex/totalPages.
              let cumulativeMatches = 0;
              let batchesDone = 0;
              await recordComputeUsage({ companyId: project.companyId, userId: session?.user?.dbId ?? null, projectId: project.id, resource: "lambda_cv", pages: pageNumbers.length }).catch(() => {});
              const { results, failedPages } = await fanOutTemplateMatch({
                templateBuffer,
                pageS3Keys,
                config: {
                  confidence_threshold: confidenceThreshold,
                  multi_scale: multiScale,
                  use_sift_fallback: useSiftFallback,
                  scales,
                  nms_iou_threshold: nmsThreshold,
                  max_matches_per_page: maxMatchesPerPage,
                },
                onBatchComplete: (batchIdx, matchCount) => {
                  cumulativeMatches += matchCount;
                  batchesDone += 1;
                  const pagesDone = Math.min(batchesDone * TEMPLATE_MATCH_BATCH_SIZE, pageNumbers.length);
                  controller.enqueue(encoder.encode(JSON.stringify({
                    type: "progress", page: 0,
                    pageIndex: pagesDone,
                    totalPages: pageNumbers.length,
                    matches: cumulativeMatches,
                    message: `Batch ${batchIdx + 1}/${totalBatches} complete`,
                  }) + "\n"));
                },
              });

              const pageKeyToNumber: Record<string, number> = {};
              for (const n of pageNumbers) {
                pageKeyToNumber[`${project.dataUrl}/pages/page_${String(n).padStart(4, "0")}.png`] = n;
              }

              const matches: (SymbolSearchMatch & { boundText?: string | null })[] = results.map((r, i) => ({
                id: `sm-${Date.now()}-${i}`, // FQ-1
                pageNumber: pageKeyToNumber[r.pageS3Key] ?? 0,
                bbox: r.bbox,
                confidence: r.confidence,
                method: r.method,
              }));

              // Bind OCR text to matches
              const pagesWithMatches = [...new Set(matches.map((m) => m.pageNumber))].sort((a, b) => a - b);
              try {
                const textractRows = await db
                  .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
                  .from(pages)
                  .where(eq(pages.projectId, project.id));
                const textractMap: Record<number, TextractPageData> = {};
                for (const row of textractRows) {
                  if (row.textractData) textractMap[row.pageNumber] = row.textractData as TextractPageData;
                }
                const bound = bindOcrToShapes(
                  matches.map((m) => ({
                    pageNumber: m.pageNumber,
                    bbox: [m.bbox[0], m.bbox[1], m.bbox[0] + m.bbox[2], m.bbox[1] + m.bbox[3]] as BboxMinMax,
                    shapeType: "symbol-match",
                    confidence: m.confidence,
                    method: m.method,
                  })),
                  textractMap,
                );
                for (let i = 0; i < matches.length; i++) {
                  matches[i].boundText = bound[i]?.boundText ?? null;
                }
              } catch (err) {
                logger.warn("[SYMBOL_SEARCH] OCR binding failed:", err); // FQ-5 soft-fail
              }

              const done = JSON.stringify({
                type: "done",
                templateBbox: [templateBbox.x, templateBbox.y, templateBbox.w, templateBbox.h], // FQ-3
                sourcePageNumber,
                totalMatches: matches.length,
                pagesWithMatches,
                matches,
                searchedAt: new Date().toISOString(), // FQ-2
                ...(failedPages.length > 0 && { failedPages }), // FQ-6
              });
              controller.enqueue(encoder.encode(done + "\n"));
            } catch (err) {
              controller.enqueue(encoder.encode(JSON.stringify({
                type: "error", // FQ-9 — in-stream at HTTP 200, NOT a local fallback (FQ-11)
                message: err instanceof Error ? err.message : "Lambda symbol search failed",
              }) + "\n"));
            } finally {
              controller.close();
              await rm(tempDir, { recursive: true, force: true }).catch(() => {}); // FQ-16
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache",
          },
        });
      } catch (err) {
        // FQ-11: PRE-stream failures only (the Response above was never constructed/returned)
        logger.warn("[SYMBOL_SEARCH] Lambda path failed, falling back to local:", err);
      }
    }

    // ─── Local path: download pages and run Python subprocess ──
    const targetPaths: string[] = [];
    const pageMap: number[] = []; // index -> pageNumber

    const CONCURRENCY = 4; // FQ-14
    const pageResults = await (async () => {
      const results: { pageNum: number; path: string }[] = [];
      let idx = 0;
      async function worker() {
        while (idx < pageNumbers.length) {
          const i = idx++;
          const pageNum = pageNumbers[i];
          const s3Key = `${project.dataUrl}/pages/page_${String(pageNum).padStart(4, "0")}.png`;
          let pngBuffer: Buffer | null = null;

          try {
            pngBuffer = await downloadFromS3(s3Key);
          } catch {
            try {
              pngBuffer = await rasterizePage(pdfBuffer, pageNum, 200); // FQ-12
            } catch (err) {
              logger.error(`[SYMBOL_SEARCH] Failed to load page ${pageNum}:`, err); // FQ-15
              continue;
            }
          }

          if (pngBuffer) {
            const targetPath = join(tempDir, `target_${String(pageNum).padStart(4, "0")}.png`);
            await writeFile(targetPath, pngBuffer);
            results.push({ pageNum, path: targetPath });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pageNumbers.length) }, () => worker()));
      return results.sort((a, b) => a.pageNum - b.pageNum);
    })();

    for (const r of pageResults) {
      targetPaths.push(r.path);
      pageMap.push(r.pageNum);
    }

    if (targetPaths.length === 0) {
      throw new ApiError("INTERNAL", "No page images available"); // FQ-15; controlled message, surfaces verbatim
    }

    // Stream results as NDJSON
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const scales: number[] = []; // FQ-10 (deliberate duplicate of the Lambda branch's)
          for (let s = scaleMin; s <= scaleMax + 0.001; s += 0.1) {
            scales.push(Math.round(s * 100) / 100);
          }
          if (scales.length === 0) scales.push(1.0);

          const result = await localHeavy(() => templateMatch(
            {
              mode: "search",
              templatePath: templatePath,
              targetPaths: targetPaths,
              confidenceThreshold,
              multiScale,
              useSiftFallback,
              scales,
              nmsIouThreshold: nmsThreshold,
              maxMatchesPerPage,
            },
            {
              onProgress: (progress: TemplateMatchProgress) => {
                const pageNum = pageMap[progress.targetIndex] ?? 0;
                const msg = JSON.stringify({
                  type: "progress", // FQ-7 local variant: NO message key
                  page: pageNum,
                  pageIndex: progress.targetIndex + 1,
                  totalPages: targetPaths.length,
                  matches: progress.matches, // FQ-8 per-callback, not cumulative
                });
                controller.enqueue(encoder.encode(msg + "\n"));
              },
            }
          ));

          const matches: (SymbolSearchMatch & { boundText?: string | null })[] = result.results.map((r, i) => ({
            id: `sm-${Date.now()}-${i}`, // FQ-1
            pageNumber: pageMap[r.targetIndex] ?? 0,
            bbox: r.bbox, // FQ-4: engine `scale` dropped
            confidence: r.confidence,
            method: r.method,
          }));

          // Bind OCR text to matches
          const pagesWithMatches = [...new Set(matches.map((m) => m.pageNumber))].sort(
            (a, b) => a - b
          );
          try {
            const textractRows = await db
              .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
              .from(pages)
              .where(eq(pages.projectId, project.id));
            const textractMap: Record<number, TextractPageData> = {};
            for (const row of textractRows) {
              if (row.textractData) textractMap[row.pageNumber] = row.textractData as TextractPageData;
            }
            const bound = bindOcrToShapes(
              matches.map((m) => ({
                pageNumber: m.pageNumber,
                bbox: [m.bbox[0], m.bbox[1], m.bbox[0] + m.bbox[2], m.bbox[1] + m.bbox[3]] as BboxMinMax,
                shapeType: "symbol-match",
                confidence: m.confidence,
                method: m.method,
              })),
              textractMap,
            );
            for (let i = 0; i < matches.length; i++) {
              matches[i].boundText = bound[i]?.boundText ?? null;
            }
          } catch (err) {
            logger.warn("[SYMBOL_SEARCH] OCR binding failed:", err); // FQ-5 soft-fail
          }

          const done = JSON.stringify({
            type: "done",
            templateBbox: [templateBbox.x, templateBbox.y, templateBbox.w, templateBbox.h], // FQ-3
            sourcePageNumber,
            totalMatches: matches.length,
            pagesWithMatches,
            matches,
            searchedAt: new Date().toISOString(), // FQ-2 — local NEVER emits failedPages (FQ-6)
          });
          controller.enqueue(encoder.encode(done + "\n"));
        } catch (err) {
          const errMsg = JSON.stringify({
            type: "error", // FQ-9
            message: err instanceof Error ? err.message : "Symbol search failed",
          });
          controller.enqueue(encoder.encode(errMsg + "\n"));
        } finally {
          controller.close();
          await rm(tempDir, { recursive: true, force: true }).catch(() => {}); // FQ-16
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    // FQ-16: pre-stream cleanup preserved from legacy (old route.ts:428). try/CATCH-rethrow, NOT
    // try/finally — the success paths return the Response from inside the try and the stream
    // finallys own cleanup after draining; a finally here would rm the temp files BEFORE the
    // engines read them. Logging moved to the shell (diff B — the legacy leaky log+500 retired).
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
