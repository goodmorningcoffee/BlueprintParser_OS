// [refactor jul5 S028] /api/shape-parse route contract, folded from the legacy fat route
// (git show 65d604e^:src/app/api/shape-parse/route.ts). Direct symbol-search (S024) sibling
// — same lambda-cv fan-out / bindOcrToShapes / dynamic-sharp surface — but kind:json.
// ENGINES BYTE-UNTOUCHED: keynotes.extractKeynotes, ocr-shape-binding, lambda-cv, s3,
// pdf-rasterize. Char file: __tests__/shape-parse.route.test.ts (SQ-1..SQ-6). Frozen:
//   • SQ-1 cascade: "Missing projectId" (truthy) → "Missing pageNumber (or set scanAll:
//     true)" → resolveProjectOrThrow({dbId},{allowDemo:true}) → project.isDemo gate
//     "keynoteParse" flat-403 passthrough → !dataUrl 404 "Project not found" (⚠️ SQ-2:
//     branch UNTESTABLE — S024 waiver class, structural guarantee only).
//   • SQ-3 scanAll: Lambda branch keynotes TRIMMED {shape,text,bbox,contour,pageNumber}
//     but byPage[pn] = RAW fan-out results (asymmetry frozen); unknown pageS3Key → pn 0;
//     failedPages/warnings spread only-when-non-empty. Local branch: byPage = engine
//     keynotes AS-IS (no pageNumber), per-page soft-fail "Page N failed", warnings
//     length>0?…:undefined. No-pages → {keynotes:[],byPage:{},warnings:["No pages found"]}.
//   • SQ-4 padded page_NNNN.png → original.pdf + rasterizePage(pdf, pageNumber, 300)
//     fallback; both-fail → ApiError("INTERNAL","Failed to load page image") — the message
//     SURFACES at 500 through defineRoute.ts:254 (KNOWN envelope.ts:42 contradiction,
//     S024 pin class — char-pinned; resolve doc-vs-code at P1 review). "Page image
//     unavailable" defensive INTERNAL likewise kept.
//   • SQ-5 crop only when cropW>10 && cropH>10 else SILENT full page; crop throw → warn +
//     full page; remap offset+coord*regionSize on bbox AND contour.
//   • SQ-6 boundText only when the page row has textractData (?? null), key ENTIRELY
//     ABSENT otherwise (FQ-5 analog); bind throw → soft-fail.
//   • Sanctioned diff B: BOTH legacy leaky catch-alls RETIRED ("All-pages scan failed:
//     ${msg}" / "Shape parse failed: ${msg}" flat 500s — incl. fanOutShapeParse's env-var
//     leak) → unexpected throws propagate to the shell's generic INTERNAL 500. Diff E:
//     body-parse moved to the shell (legacy req.json was pre-try → raw rejections).
//     DECLINED: integer guard on dbId (negative → 404 pinned).

import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { extractKeynotes } from "@/lib/keynotes";
import { bindOcrToShapes } from "@/lib/ocr-shape-binding";
import { isLambdaCvEnabled, fanOutShapeParse } from "@/lib/lambda-cv";
import { logger } from "@/lib/logger";
import type { TextractPageData } from "@/types";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { ApiError } from "@/server/api/envelope";
import { resolveProjectOrThrow } from "@/server/api/access";

export async function shapeParse(rawBody: Record<string, unknown>): Promise<unknown> {
  const { projectId, pageNumber, regionBbox, scanAll } = rawBody as {
    projectId: number;
    pageNumber?: number;
    regionBbox?: [number, number, number, number];
    scanAll?: boolean;
  };

  if (!projectId) {
    throw new ApiError("VALIDATION", "Missing projectId");
  }
  if (!scanAll && !pageNumber) {
    throw new ApiError("VALIDATION", "Missing pageNumber (or set scanAll: true)");
  }

  const { project } = await resolveProjectOrThrow({ dbId: projectId }, { allowDemo: true });

  if (project.isDemo) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "keynoteParse");
    if (gate) return gate; // flat 403 passthrough — does NOT flip here (SQ-1)
  }

  if (!project.dataUrl) {
    throw new ApiError("NOT_FOUND", "Project not found"); // SQ-2 waiver branch
  }

  // ─── All-pages mode: fan out via Lambda ─────────────────────
  if (scanAll) {
    const allPages = await db
      .select({ pageNumber: pages.pageNumber })
      .from(pages)
      .where(eq(pages.projectId, project.id))
      .orderBy(pages.pageNumber);

    if (allPages.length === 0) {
      return { keynotes: [], byPage: {}, warnings: ["No pages found"] };
    }

    const pageS3Keys = allPages.map(
      (p) => `${project.dataUrl}/pages/page_${String(p.pageNumber).padStart(4, "0")}.png`
    );
    const pageKeyToNumber: Record<string, number> = {};
    for (const p of allPages) {
      pageKeyToNumber[`${project.dataUrl}/pages/page_${String(p.pageNumber).padStart(4, "0")}.png`] = p.pageNumber;
    }

    if (isLambdaCvEnabled()) {
      const { results, failedPages, warnings } = await fanOutShapeParse({ pageS3Keys });

      const byPage: Record<number, typeof results> = {};
      const allKeynotes = results.map((r) => {
        const pn = pageKeyToNumber[r.pageS3Key] ?? 0;
        const keynote = { shape: r.shape, text: r.text, bbox: r.bbox, contour: r.contour };
        if (!byPage[pn]) byPage[pn] = [];
        byPage[pn].push(r);
        return { ...keynote, pageNumber: pn };
      });

      return {
        keynotes: allKeynotes,
        byPage,
        totalPages: allPages.length,
        ...(failedPages.length > 0 && { failedPages }),
        ...(warnings.length > 0 && { warnings }),
      };
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

    return {
      keynotes: allKeynotes,
      byPage,
      totalPages: allPages.length,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ─── Single-page mode (BB or full page) ─────────────────────
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
      // controlled 500 — message SURFACES (S024 INTERNAL-with-message pin class)
      throw new ApiError("INTERNAL", "Failed to load page image");
    }
  }

  if (!pngBuffer) {
    throw new ApiError("INTERNAL", "Page image unavailable"); // defensive, likely unreachable
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

  return { keynotes: enriched, warnings };
}
