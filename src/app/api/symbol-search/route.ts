/**
 * POST /api/symbol-search
 *
 * Symbol Search tool endpoint. Uses the generic template matching engine
 * to find all instances of a user-selected symbol across all project pages.
 *
 * Flow: crop template from source page → rasterize target pages → run engine → stream results
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getS3Url, downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { templateMatch } from "@/lib/template-match";
import type { TemplateMatchProgress, SymbolSearchMatch } from "@/types";

export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const body = await req.json();
  const {
    projectId,
    sourcePageNumber,
    templateBbox,
    confidenceThreshold = 0.75,
    searchPages,
    multiScale = true,
    useSiftFallback = true,
  } = body as {
    projectId: number;
    sourcePageNumber: number;
    templateBbox: { x: number; y: number; w: number; h: number };
    confidenceThreshold?: number;
    searchPages?: number[];
    multiScale?: boolean;
    useSiftFallback?: boolean;
  };

  if (!projectId || !sourcePageNumber || !templateBbox) {
    return NextResponse.json(
      { error: "Missing projectId, sourcePageNumber, or templateBbox" },
      { status: 400 }
    );
  }

  // Bbox validation
  const { x, y, w, h } = templateBbox;
  if (![x, y, w, h].every((v) => typeof v === "number" && isFinite(v) && v >= 0 && v <= 1) || w <= 0 || h <= 0) {
    return NextResponse.json({ error: "Invalid templateBbox" }, { status: 400 });
  }

  const tempDir = await mkdtemp(join(tmpdir(), "bp2-symbol-search-"));

  try {
    // ─── Fetch project (with company authorization) ─────────
    const [project] = await db
      .select({ id: projects.id, dataUrl: projects.dataUrl, isDemo: projects.isDemo, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    // Company authorization: non-demo projects must belong to user's company
    if (project && !project.isDemo && session.user.companyId !== project.companyId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (!project?.dataUrl) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

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
      return NextResponse.json({ error: "No pages to search" }, { status: 400 });
    }

    // ─── Download PDF and rasterize source page for template ──
    const pdfUrl = getS3Url(project.dataUrl, "original.pdf");
    const pdfResp = await fetch(pdfUrl);
    if (!pdfResp.ok) {
      return NextResponse.json({ error: "Failed to fetch PDF" }, { status: 500 });
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

    // ─── Load all target pages (parallel, 4 at a time) ───────
    // Try S3 pre-rendered PNGs first, fall back to rasterization from PDF
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
              console.error(`[SYMBOL_SEARCH] Failed to load page ${pageNum}:`, err);
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
      return NextResponse.json({ error: "No page images available" }, { status: 500 });
    }

    // ─── Run template matching engine ────────────────────────
    // Stream results as NDJSON
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const result = await templateMatch(
            {
              mode: "search",
              templatePath: templatePath,
              targetPaths: targetPaths,
              confidenceThreshold,
              multiScale,
              useSiftFallback,
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

          // Map results to page numbers and build SymbolSearchMatches
          const matches: SymbolSearchMatch[] = result.results.map((r, i) => ({
            id: `sm-${Date.now()}-${i}`,
            pageNumber: pageMap[r.targetIndex] ?? 0,
            bbox: r.bbox,
            confidence: r.confidence,
            method: r.method,
          }));

          const pagesWithMatches = [...new Set(matches.map((m) => m.pageNumber))].sort(
            (a, b) => a - b
          );

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
          // Cleanup temp dir
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
    console.error("[SYMBOL_SEARCH] Failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Symbol search failed" },
      { status: 500 }
    );
  }
}
