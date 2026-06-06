import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, pages, annotations, models } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { resolveProjectAccess } from "@/lib/api-utils";
import { getPresignedGetUrl } from "@/lib/s3";

/**
 * GET /api/projects/[id]/export
 *
 * "Download project machine-annotation data." A read-only dump of everything
 * the preprocessing engine has computed for a project, in one bundle:
 *
 *   - project graph + summaries (projects.projectIntelligence / projectSummary)
 *   - every model's class config (for enriching YOLO marks with CSI codes/keywords)
 *   - per-page parsing: OCR (textractData), CSI codes, keynotes, text annotations,
 *     and the full pageIntelligence JSONB (textRegions, classifiedTables,
 *     ensembleRegions, yoloHeatmap, csiSpatialMap, heuristicInferences, ...)
 *   - every annotation (YOLO detections, shape-parse, symbol-search, user markups)
 *     as [minX,minY,maxX,maxY] normalized bboxes
 *   - presigned S3 GET URLs for original.pdf + each page PNG/thumbnail
 *
 * This is the ingest contract for the headless / gaussian-fingerprint tooling:
 * the bundle is small (JSON), and the heavy images are fetched directly from S3
 * via the presigned URLs. Runs inside the VPC so it can reach RDS + S3.
 *
 * Query params:
 *   ?pages=1-50        limit to a page range (also "1,2,3" or "1-10,20")
 *   ?omit=textract     drop heavy fields to shrink the payload. Comma list of:
 *                        textract     -> page.textractData
 *                        intelligence -> page.pageIntelligence
 *                        images       -> skip presigning page/PDF URLs
 *
 * Access: company-scoped via resolveProjectAccess (root admin sees any project;
 * demo projects are exportable without auth). Tighten to admin-only by checking
 * `access.scope` if needed.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);

  const access = await resolveProjectAccess({ publicId: id }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  const omit = new Set(
    (url.searchParams.get("omit") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const pagesFilter = parsePagesParam(url.searchParams.get("pages"));

  // Heavy project-level fields (resolveProjectAccess intentionally excludes these)
  const [proj] = await db
    .select({
      projectIntelligence: projects.projectIntelligence,
      projectSummary: projects.projectSummary,
    })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);

  let pageRows = await db
    .select()
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(pages.pageNumber);
  if (pagesFilter) pageRows = pageRows.filter((p) => pagesFilter.has(p.pageNumber));

  const annRows = await db
    .select()
    .from(annotations)
    .where(eq(annotations.projectId, project.id));

  const modelRows = await db
    .select({ name: models.name, type: models.type, config: models.config })
    .from(models)
    .where(eq(models.companyId, project.companyId));

  // Presigned S3 URLs (24h). page_NNNN.png is the engine's 4-digit zero-padded key.
  const EXPIRES = 24 * 60 * 60;
  const pad = (n: number) => String(n).padStart(4, "0");
  const wantImages = !omit.has("images");

  const pdfKey = `${project.dataUrl}/original.pdf`;
  const pdfUrl = wantImages ? await safePresign(pdfKey, EXPIRES) : null;

  const imageByPage = new Map<number, ExportPageImage>();
  if (wantImages) {
    await Promise.all(
      pageRows.map(async (p) => {
        const pngKey = `${project.dataUrl}/pages/page_${pad(p.pageNumber)}.png`;
        const thumbKey = `${project.dataUrl}/thumbnails/page_${pad(p.pageNumber)}.png`;
        const [pngUrl, thumbUrl] = await Promise.all([
          safePresign(pngKey, EXPIRES),
          safePresign(thumbKey, EXPIRES),
        ]);
        imageByPage.set(p.pageNumber, { pngKey, pngUrl, thumbKey, thumbUrl });
      }),
    );
  }

  const bundle = {
    schemaVersion: "bp-export/1",
    exportedAt: new Date().toISOString(),
    project: {
      publicId: project.publicId,
      name: project.name,
      dataUrl: project.dataUrl,
      numPages: project.numPages,
      status: project.status,
      projectIntelligence: proj?.projectIntelligence ?? null,
      projectSummary: proj?.projectSummary ?? null,
    },
    models: modelRows,
    assets: { pdfKey, pdfUrl },
    pages: pageRows.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
      rawText: p.rawText,
      csiCodes: p.csiCodes,
      keynotes: p.keynotes,
      textAnnotations: p.textAnnotations,
      textractData: omit.has("textract") ? undefined : p.textractData,
      pageIntelligence: omit.has("intelligence") ? undefined : p.pageIntelligence,
      error: p.error,
      image: imageByPage.get(p.pageNumber) ?? null,
    })),
    annotations: annRows.map((a) => ({
      id: a.id,
      name: a.name,
      // MinMax normalized 0-1, matching ClientAnnotation/YoloDetection convention
      bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
      pageNumber: a.pageNumber,
      threshold: a.threshold,
      source: a.source,
      data: a.data,
      note: a.note,
    })),
  };

  return NextResponse.json(bundle);
}

interface ExportPageImage {
  pngKey: string;
  pngUrl: string | null;
  thumbKey: string;
  thumbUrl: string | null;
}

async function safePresign(key: string, expiresIn: number): Promise<string | null> {
  try {
    return await getPresignedGetUrl(key, expiresIn);
  } catch {
    return null;
  }
}

/** Parse "1-50", "1,2,3", "1-10,20" into a Set of page numbers. Null if absent. */
function parsePagesParam(raw: string | null): Set<number> | null {
  if (!raw) return null;
  const set = new Set<number>();
  for (const part of raw.split(",")) {
    const t = part.trim();
    const range = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = Math.min(+range[1], +range[2]);
      const hi = Math.max(+range[1], +range[2]);
      for (let i = lo; i <= hi; i++) set.add(i);
    } else if (/^\d+$/.test(t)) {
      set.add(+t);
    }
  }
  return set.size ? set : null;
}
