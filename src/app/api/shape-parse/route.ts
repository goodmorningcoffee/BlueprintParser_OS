/**
 * POST /api/shape-parse
 *
 * Runs the OpenCV + Tesseract "Shape Parse" (theta-style) extractor.
 * Detects architectural symbols (circles, diamonds, hexagons etc.)
 * that contain keynote text like A1, B-2, 1A.
 *
 * Three modes:
 *   - BB mode:   { projectId, pageNumber, regionBbox } — crop to drawn region
 *   - Page mode: { projectId, pageNumber }             — full current page
 *   - All pages: { projectId, scanAll: true }           — fan out via Lambda
 *
 * Returns: { keynotes: KeynoteShapeData[], warnings?: string[] }
 * All-pages mode adds: { byPage: Record<number, KeynoteShapeData[]>, failedPages?: string[] }
 */

import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { extractKeynotes } from "@/lib/keynotes";
import { bindOcrToShapes } from "@/lib/ocr-shape-binding";
import { isLambdaCvEnabled, fanOutShapeParse } from "@/lib/lambda-cv";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";
import type { TextractPageData } from "@/types";

export async function POST(req: Request) {
  const body = await req.json();
  const { projectId, pageNumber, regionBbox, scanAll } = body as {
    projectId: number;
    pageNumber?: number;
    regionBbox?: [number, number, number, number];
    scanAll?: boolean;
  };

  if (!projectId) {
    return apiError("Missing projectId", 400);
  }
  if (!scanAll && !pageNumber) {
    return apiError("Missing pageNumber (or set scanAll: true)", 400);
  }

  const access = await resolveProjectAccess({ dbId: projectId }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  if (!project.dataUrl) {
    return apiError("Project not found", 404);
  }

  // ─── All-pages mode: fan out via Lambda ─────────────────────
  if (scanAll) {
    try {
      const allPages = await db
        .select({ pageNumber: pages.pageNumber })
        .from(pages)
        .where(eq(pages.projectId, project.id))
        .orderBy(pages.pageNumber);

      if (allPages.length === 0) {
        return NextResponse.json({ keynotes: [], byPage: {}, warnings: ["No pages found"] });
      }

      const pageS3Keys = allPages.map(
        (p) => `${project.dataUrl}/pages/page_${String(p.pageNumber).padStart(4, "0")}.png`
      );
      const pageKeyToNumber: Record<string, number> = {};
      for (const p of allPages) {
        pageKeyToNumber[`${project.dataUrl}/pages/page_${String(p.pageNumber).padStart(4, "0")}.png`] = p.pageNumber;
      }

      if (isLambdaCvEnabled()) {
        const { results, failedPages } = await fanOutShapeParse({ pageS3Keys });

        const byPage: Record<number, typeof results> = {};
        const allKeynotes = results.map((r) => {
          const pn = pageKeyToNumber[r.pageS3Key] ?? 0;
          const keynote = { shape: r.shape, text: r.text, bbox: r.bbox, contour: r.contour };
          if (!byPage[pn]) byPage[pn] = [];
          byPage[pn].push(r);
          return { ...keynote, pageNumber: pn };
        });

        return NextResponse.json({
          keynotes: allKeynotes,
          byPage,
          totalPages: allPages.length,
          ...(failedPages.length > 0 && { failedPages }),
        });
      }

      // Fallback: sequential local processing (slow but works without Lambda)
      const byPage: Record<number, any[]> = {};
      const allKeynotes: any[] = [];
      const warnings: string[] = [];

      for (const p of allPages) {
        try {
          const s3Key = `${project.dataUrl}/pages/page_${String(p.pageNumber).padStart(4, "0")}.png`;
          const pngBuffer = await downloadFromS3(s3Key);
          const result = await extractKeynotes(pngBuffer);
          byPage[p.pageNumber] = result.keynotes;
          for (const k of result.keynotes) {
            allKeynotes.push({ ...k, pageNumber: p.pageNumber });
          }
          if (result.warnings.length) warnings.push(...result.warnings);
        } catch (err) {
          logger.warn(`[SHAPE_PARSE] Page ${p.pageNumber} failed:`, err);
          warnings.push(`Page ${p.pageNumber} failed`);
        }
      }

      return NextResponse.json({
        keynotes: allKeynotes,
        byPage,
        totalPages: allPages.length,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (err) {
      logger.error("[SHAPE_PARSE] All-pages scan failed:", err);
      return apiError(`All-pages scan failed: ${err instanceof Error ? err.message : "unknown"}`, 500);
    }
  }

  // ─── Single-page mode (BB or full page) ─────────────────────
  try {
    const s3Key = `${project.dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;
    let pngBuffer: Buffer | null = null;

    try {
      pngBuffer = await downloadFromS3(s3Key);
    } catch {
      try {
        const pdfBuffer = await downloadFromS3(`${project.dataUrl}/original.pdf`);
        pngBuffer = await rasterizePage(pdfBuffer, pageNumber!, 300);
      } catch (err) {
        logger.error("[SHAPE_PARSE] Failed to load page image:", err);
        return apiError("Failed to load page image", 500);
      }
    }

    if (!pngBuffer) {
      return apiError("Page image unavailable", 500);
    }

    let inputBuffer = pngBuffer;
    let offsetX = 0;
    let offsetY = 0;
    let regionW = 1;
    let regionH = 1;

    if (regionBbox && regionBbox.length === 4) {
      const [minX, minY, maxX, maxY] = regionBbox;
      try {
        const sharp = (await import("sharp")).default;
        const meta = await sharp(pngBuffer).metadata();
        const imgW = meta.width || 1;
        const imgH = meta.height || 1;
        const cropX = Math.max(0, Math.round(minX * imgW));
        const cropY = Math.max(0, Math.round(minY * imgH));
        const cropW = Math.min(imgW - cropX, Math.round((maxX - minX) * imgW));
        const cropH = Math.min(imgH - cropY, Math.round((maxY - minY) * imgH));
        if (cropW > 10 && cropH > 10) {
          inputBuffer = await sharp(pngBuffer)
            .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
            .png()
            .toBuffer();
          offsetX = minX;
          offsetY = minY;
          regionW = maxX - minX;
          regionH = maxY - minY;
        }
      } catch (err) {
        logger.warn("[SHAPE_PARSE] Region crop failed, using full page:", err);
      }
    }

    const { keynotes, warnings } = await extractKeynotes(inputBuffer);

    const remapped = keynotes.map((k) => ({
      ...k,
      bbox: [
        offsetX + k.bbox[0] * regionW,
        offsetY + k.bbox[1] * regionH,
        offsetX + k.bbox[2] * regionW,
        offsetY + k.bbox[3] * regionH,
      ] as [number, number, number, number],
      contour: k.contour?.map(([cx, cy]: [number, number]) => [
        offsetX + cx * regionW,
        offsetY + cy * regionH,
      ] as [number, number]),
    }));

    // Bind OCR text to detected shapes
    let enriched = remapped;
    try {
      const [pageRow] = await db
        .select({ textractData: pages.textractData })
        .from(pages)
        .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber!)))
        .limit(1);
      if (pageRow?.textractData) {
        const textractMap: Record<number, TextractPageData> = {
          [pageNumber!]: pageRow.textractData as TextractPageData,
        };
        const bound = bindOcrToShapes(
          remapped.map((k) => ({
            pageNumber: pageNumber!,
            bbox: k.bbox,
            shapeType: k.shape,
            confidence: 0.9,
            method: "shape-parse",
          })),
          textractMap,
        );
        enriched = remapped.map((k, i) => ({ ...k, boundText: bound[i]?.boundText ?? null }));
      }
    } catch (err) {
      logger.warn("[SHAPE_PARSE] OCR binding failed, returning shapes without text:", err);
    }

    return NextResponse.json({ keynotes: enriched, warnings });
  } catch (err) {
    logger.error("[SHAPE_PARSE] Error:", err);
    const message = err instanceof Error ? err.message : "unknown";
    return apiError(`Shape parse failed: ${message}`, 500);
  }
}
