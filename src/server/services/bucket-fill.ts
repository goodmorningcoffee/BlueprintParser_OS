// [refactor jul6 S030] /api/bucket-fill route contract, folded from the legacy fat route
// (git show 6214663^:src/app/api/bucket-fill/route.ts) — THE LAST PARSE-FAMILY FOLD.
// Flood-fill SERVER FALLBACK (the client worker does the real work; this fires only on
// worker failure). ENGINE BYTE-UNTOUCHED: @/lib/bucket-fill (+ s3, pdf-rasterize).
// Char file: __tests__/bucket-fill.route.test.ts (BQ-1..BQ-6). Frozen:
//   • BQ-1 cascade: truthy field-400 → "Invalid seedPoint (must be normalized 0-1)"
//     (0/1 boundaries VALID) → resolveProjectOrThrow({dbId},{allowDemo:true}) →
//     project.isDemo "bucketFill" gate flat-403 passthrough → !dataUrl 404 (S024 waiver).
//   • BQ-2 boundary clamps kept verbatim (incl. their original comments below):
//     leakThreshold → [0.05,0.95], tolerance → max(0,·).
//   • BQ-4 the engine result — including its in-band {type:"error"} AT HTTP 200 —
//     returns VERBATIM (success-path body; AnnotationOverlay parses it in-band; never
//     envelope it). Unknown body fields (client sends textBboxes) stay ignored.
//   • BQ-3 padded page_NNNN.png → original.pdf + rasterizePage(pdf, n, 200) fallback;
//     both-fail → ApiError("INTERNAL","Failed to load page image") — message SURFACES
//     (S024 pin class; the exact string shape-parse also pins).
//   • BQ-5 sanctioned diff B: the legacy catch-all's FIXED "Bucket fill failed" 500
//     literal RETIRES → unexpected throws propagate to the shell's generic INTERNAL 500
//     (S015 "Promote failed" precedent; no leak existed either way).
//   • BQ-6 tempDir: mkdtemp pre-try; try/FINALLY kept with the rm(...).catch(()=>{})
//     SWALLOW verbatim (unlike table-structure's awaited rm — do not harmonize).
//   • Diff E: body-parse moved to the shell (legacy req.json was pre-try → raw
//     rejections). DECLINED: integer guard on dbId (negative → 404 pinned).

import { downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { bucketFill } from "@/lib/bucket-fill";
import { logger } from "@/lib/logger";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { ApiError } from "@/server/api/envelope";
import { assertPageNumber, isPageCoordinate } from "@/server/api/parser-input";
import { resolveProjectOrThrow } from "@/server/api/access";

const MAX_DILATE_PX = 25;
const MAX_BARRIERS = 500;
const MAX_POLYGON_VERTICES = 2_000;

export async function bucketFillRoute(rawBody: Record<string, unknown>): Promise<unknown> {
  const {
    projectId,
    pageNumber,
    seedPoint,
    tolerance = 30,
    dilate = 3,
    simplifyEpsilon = 0.005,
    leakThreshold = 0.25,
    barriers = [],
    polygonBarriers = [],
  } = rawBody as {
    projectId: number;
    pageNumber: number;
    seedPoint: { x: number; y: number };
    tolerance?: number;
    dilate?: number;
    simplifyEpsilon?: number;
    leakThreshold?: number;
    barriers?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    polygonBarriers?: Array<{ vertices: Array<{ x: number; y: number }> }>;
  };

  if (!projectId || !pageNumber || !seedPoint) {
    throw new ApiError("VALIDATION", "Missing projectId, pageNumber, or seedPoint");
  }
  assertPageNumber(pageNumber);

  const { x, y } = seedPoint;
  if (typeof x !== "number" || typeof y !== "number" || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new ApiError("VALIDATION", "Invalid seedPoint (must be normalized 0-1)");
  }

  // Belt-and-suspenders clamp. The client worker and Python script also clamp,
  // but a direct API caller that passes a nonsense value (e.g., leakThreshold=100
  // meaning "100%" interpreted as a raw fraction) would otherwise pass an
  // impossible threshold into the picker logic. Clamp to sane bounds at the
  // boundary so no downstream code has to assume input validity.
  const clampedLeakThreshold = Math.max(0.05, Math.min(0.95, leakThreshold));
  // Client worker accepts negative tolerance (expanded 2026-04-22 for user
  // thin-line sensitivity). The server fallback's Python script predates
  // that expansion and may not handle negative values gracefully. Clamp to
  // 0 at the server boundary so the Python path gets the tightest-positive
  // equivalent. Server fallback is rare (only fires on worker failure).
  const clampedTolerance = Math.max(0, tolerance);
  // `dilate` becomes an n-by-n kernel allocation in the Python script (40000 → 1.6 GB), and the
  // barrier lists are rasterized one by one. Reachable anonymously on a demo project.
  const clampedDilate =
    typeof dilate === "number" && Number.isFinite(dilate)
      ? Math.min(MAX_DILATE_PX, Math.max(0, Math.round(dilate)))
      : 3;
  if (
    !Array.isArray(barriers) ||
    !Array.isArray(polygonBarriers) ||
    barriers.length > MAX_BARRIERS ||
    polygonBarriers.length > MAX_BARRIERS
  ) {
    throw new ApiError("VALIDATION", `Too many barriers (max ${MAX_BARRIERS})`);
  }
  // The script computes `int(v["x"] * w)`: a STRING there is repeated w times, not multiplied
  // (measured: a 1 MiB string vertex ≈ 3.8 GB). Coordinates must be numbers, and few.
  const barriersValid = barriers.every(
    (b) => b && [b.x1, b.y1, b.x2, b.y2].every(isPageCoordinate),
  );
  const polygonsValid = polygonBarriers.every(
    (p) =>
      p &&
      Array.isArray(p.vertices) &&
      p.vertices.length <= MAX_POLYGON_VERTICES &&
      p.vertices.every((v) => v && isPageCoordinate(v.x) && isPageCoordinate(v.y)),
  );
  if (!barriersValid || !polygonsValid) {
    throw new ApiError("VALIDATION", "Invalid barriers (coordinates must be numbers)");
  }

  const { project } = await resolveProjectOrThrow({ dbId: projectId }, { allowDemo: true });

  if (project.isDemo) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "bucketFill");
    if (gate) return gate; // flat 403 passthrough — does NOT flip here (BQ-1)
  }

  if (!project.dataUrl) {
    throw new ApiError("NOT_FOUND", "Project not found"); // S024 waiver branch
  }

  const tempDir = await mkdtemp(join(tmpdir(), "bp2-bucket-fill-"));

  try {
    // Happy path: download pre-rendered PNG from S3 (no PDF fetch needed)
    const s3Key = `${project.dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;
    let pngBuffer: Buffer | null = null;
    try {
      pngBuffer = await downloadFromS3(s3Key);
    } catch {
      // Fallback: PNG missing from S3 — fetch PDF and rasterize
      logger.warn(`[BUCKET_FILL] PNG missing at ${s3Key}, falling back to PDF rasterize`);
      try {
        const pdfBuffer = await downloadFromS3(`${project.dataUrl}/original.pdf`);
        pngBuffer = await rasterizePage(pdfBuffer, pageNumber, 200);
      } catch (err) {
        logger.error("[BUCKET_FILL] Failed to rasterize page:", err);
        // controlled 500 — message SURFACES (S024 pin class; shared with shape-parse)
        throw new ApiError("INTERNAL", "Failed to load page image");
      }
    }

    const imagePath = join(tempDir, `page_${String(pageNumber).padStart(4, "0")}.png`);
    await writeFile(imagePath, pngBuffer);

    // Raster-only flood fill (vector mode removed)
    const result = await bucketFill({
      imagePath,
      pageNumber,
      seedX: x,
      seedY: y,
      tolerance: clampedTolerance,
      dilatePx: clampedDilate,
      simplifyEpsilon,
      leakThreshold: clampedLeakThreshold,
      barriers,
      polygonBarriers,
    });

    return result; // verbatim passthrough incl. in-band {type:"error"} at 200 (BQ-4)
  } finally {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
