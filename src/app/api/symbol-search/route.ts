/**
 * POST /api/symbol-search
 *
 * Symbol Search tool endpoint. Uses the generic template matching engine
 * to find all instances of a user-selected symbol across all project pages.
 *
 * Flow: crop template from source page → rasterize target pages → run engine → stream results
 */

import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getS3Url, downloadFromS3, uploadToS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { readFile, writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { templateMatch } from "@/lib/template-match";
import { isLambdaCvEnabled, fanOutTemplateMatch } from "@/lib/lambda-cv";
import { bindOcrToShapes } from "@/lib/ocr-shape-binding";
import type { TemplateMatchProgress, SymbolSearchMatch, TextractPageData, BboxMinMax } from "@/types";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  const body = await req.json();
  const {
    projectId,
    sourcePageNumber,
    templateBbox,
    confidenceThreshold = 0.75,
    searchPages,
    multiScale = true,
    useSiftFallback = true,
    scaleMin = 0.8,
    scaleMax = 1.5,
    nmsThreshold = 0.3,
    maxMatchesPerPage = 50,
  } = body as {
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

  if (!projectId || !sourcePageNumber || !templateBbox) {
    return apiError("Missing projectId, sourcePageNumber, or templateBbox", 400);
  }

  // Bbox validation
  const { x, y, w, h } = templateBbox;
  if (![x, y, w, h].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1) || w <= 0 || h <= 0) {
    return apiError("Invalid templateBbox", 400);
  }

  const access = await resolveProjectAccess({ dbId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  if (!project.dataUrl) {
    return apiError("Project not found", 404);
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
      return apiError("No pages to search", 400);
    }

    // ─── Download PDF and rasterize source page for template ──
    const pdfUrl = getS3Url(project.dataUrl, "original.pdf");
    const pdfResp = await fetch(pdfUrl);
    if (!pdfResp.ok) {
      return apiError("Failed to fetch PDF", 500);
    }
    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());

    // Rasterize source page at 300 DPI for template extraction
    const sourcePng = await rasterizePage(pdfBuffer, sourcePageNumber, 300);

    // Get image dimensions from PNG header (bytes 16-23: width, height as uint32 BE)
    const imgW = sourcePng.readUInt32BE(16);
    const imgH = sourcePng.readUInt32BE(20);

    // Crop template region from source page using Python/OpenCV
    // Write full source page, then use a small crop script
    const sourcePagePath = join(tempDir, "source.png");
    await writeFile(sourcePagePath, sourcePng);

    // Crop using pixel coordinates derived from normalized bbox
    const cropX = Math.round(templateBbox.x * imgW);
    const cropY = Math.round(templateBbox.y * imgH);
    const cropW = Math.max(1, Math.round(templateBbox.w * imgW));
    const cropH = Math.max(1, Math.round(templateBbox.h * imgH));

    // Use Python/OpenCV to crop (safe: no string interpolation of user input)
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const templatePath = join(tempDir, "template.png");
    const cropScript = `
import cv2, json, sys
cfg = json.loads(sys.argv[1])
img = cv2.imread(cfg["src"])
crop = img[cfg["y"]:cfg["y"]+cfg["h"], cfg["x"]:cfg["x"]+cfg["w"]]
cv2.imwrite(cfg["dst"], crop)
`.trim();
    await execFileAsync("python3", [
      "-c", cropScript,
      JSON.stringify({ src: sourcePagePath, dst: templatePath, x: cropX, y: cropY, w: cropW, h: cropH }),
    ], { timeout: 10000 });

    // ─── Lambda path: fan out across Lambda workers ─────────
    if (isLambdaCvEnabled()) {
      try {
        const templateBuffer = await readFile(templatePath);
        const pageS3Keys = pageNumbers.map(
          (n) => `${project.dataUrl}/pages/page_${String(n).padStart(4, "0")}.png`
        );

        const scales: number[] = [];
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
                  const totalBatches = Math.ceil(pageNumbers.length / 5);
                  controller.enqueue(encoder.encode(JSON.stringify({
                    type: "progress", page: 0,
                    pageIndex: Math.min((batchIdx + 1) * 5, pageNumbers.length),
                    totalPages: pageNumbers.length,
                    matches: matchCount,
                    message: `Batch ${batchIdx + 1}/${totalBatches} complete`,
                  }) + "\n"));
                },
              });

              const pageKeyToNumber: Record<string, number> = {};
              for (const n of pageNumbers) {
                pageKeyToNumber[`${project.dataUrl}/pages/page_${String(n).padStart(4, "0")}.png`] = n;
              }

              const matches: (SymbolSearchMatch & { boundText?: string | null })[] = results.map((r, i) => ({
                id: `sm-${Date.now()}-${i}`,
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
                logger.warn("[SYMBOL_SEARCH] OCR binding failed:", err);
              }

              const done = JSON.stringify({
                type: "done",
                templateBbox: [templateBbox.x, templateBbox.y, templateBbox.w, templateBbox.h],
                sourcePageNumber,
                totalMatches: matches.length,
                pagesWithMatches,
                matches,
                searchedAt: new Date().toISOString(),
                ...(failedPages.length > 0 && { failedPages }),
              });
              controller.enqueue(encoder.encode(done + "\n"));
            } catch (err) {
              controller.enqueue(encoder.encode(JSON.stringify({
                type: "error",
                message: err instanceof Error ? err.message : "Lambda symbol search failed",
              }) + "\n"));
            } finally {
              controller.close();
              await rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
        logger.warn("[SYMBOL_SEARCH] Lambda path failed, falling back to local:", err);
      }
    }

    // ─── Local path: download pages and run Python subprocess ──
    const targetPaths: string[] = [];
    const pageMap: number[] = []; // index -> pageNumber

    const CONCURRENCY = 4;
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
              pngBuffer = await rasterizePage(pdfBuffer, pageNum, 200);
            } catch (err) {
              logger.error(`[SYMBOL_SEARCH] Failed to load page ${pageNum}:`, err);
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
      return apiError("No page images available", 500);
    }

    // Stream results as NDJSON
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const scales: number[] = [];
          for (let s = scaleMin; s <= scaleMax + 0.001; s += 0.1) {
            scales.push(Math.round(s * 100) / 100);
          }
          if (scales.length === 0) scales.push(1.0);

          const result = await templateMatch(
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
                  type: "progress",
                  page: pageNum,
                  pageIndex: progress.targetIndex + 1,
                  totalPages: targetPaths.length,
                  matches: progress.matches,
                });
                controller.enqueue(encoder.encode(msg + "\n"));
              },
            }
          );

          const matches: (SymbolSearchMatch & { boundText?: string | null })[] = result.results.map((r, i) => ({
            id: `sm-${Date.now()}-${i}`,
            pageNumber: pageMap[r.targetIndex] ?? 0,
            bbox: r.bbox,
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
            logger.warn("[SYMBOL_SEARCH] OCR binding failed:", err);
          }

          const done = JSON.stringify({
            type: "done",
            templateBbox: [templateBbox.x, templateBbox.y, templateBbox.w, templateBbox.h],
            sourcePageNumber,
            totalMatches: matches.length,
            pagesWithMatches,
            matches,
            searchedAt: new Date().toISOString(),
          });
          controller.enqueue(encoder.encode(done + "\n"));
        } catch (err) {
          const errMsg = JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : "Symbol search failed",
          });
          controller.enqueue(encoder.encode(errMsg + "\n"));
        } finally {
          controller.close();
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    logger.error("[SYMBOL_SEARCH] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Symbol search failed", 500);
  }
}
