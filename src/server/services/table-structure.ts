// [refactor jul6 S029] /api/table-structure route contract, folded from the legacy fat
// route (git show ed06fb4^:src/app/api/table-structure/route.ts). TATR cell-structure
// detection. ENGINES BYTE-UNTOUCHED: tatr-structure, s3, pdf-rasterize. Char file:
// __tests__/table-structure.route.test.ts (UQ-1..UQ-6). Frozen:
//   • UQ-1 truthy cascade w/ falsy-zero; bbox LENGTH-only check (no value validation —
//     out-of-range values proceed; do NOT add); project.isDemo "tableParse" gate flat-403
//     passthrough (same feature key as table-parse).
//   • UQ-2 SANCTIONED message truncation (pre-flagged S026 recon; symbol-search
//     precedent): the inner PDF-download catch's leaky "Failed to fetch PDF: ${msg}"
//     500 → ApiError("INTERNAL","Failed to fetch PDF") — the surviving string is
//     byte-identical to the S024-pinned message; it SURFACES via defineRoute's catch, which
//     forwards any ApiError's message (documented in envelope.ts's JSDoc; S024 pin class).
//   • UQ-3 the 200-WITH-ERROR-KEY soft path: tatrResult.error → HTTP 200
//     {error, cells:[], rows:[], columns:[], confidence:0} — a SUCCESS-path body
//     (in-band engine error). Must NEVER be converted to the envelope.
//   • UQ-4 python3/OpenCV crop via execFile (10s timeout) — near-twin of
//     lib/template-crop.ts (P1-review dedup candidate; NOT consolidated in-fold);
//     cropped image read via DYNAMIC import("fs/promises") (the mock seam);
//     detectTableStructure(cropped, confidenceThreshold ?? 0.5).
//   • UQ-5 MinMax remap + word-center-in-cell Textract text-fill (x-sorted, join " ");
//     no page row → TATR's own cell text untouched.
//   • UQ-6 tempDir: mkdtemp pre-try; try/FINALLY-rm KEPT (rm runs on happy, soft-error,
//     UQ-2 throw, and pipeline-throw paths alike — nothing escapes the try, so finally
//     is safe here, UNLIKE symbol-search's stream topology). Only the legacy CATCH is
//     retired (diff B — err.message leak + "Table structure detection failed" fallback
//     die; unexpected throws propagate to the shell's generic INTERNAL 500).
//   • Diff E: body-parse moved to the shell (legacy req.json was pre-try → raw
//     rejections). DECLINED: integer guard on dbId (negative → 404 pinned).

import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { downloadFromS3 } from "@/lib/s3";
import { rasterizePage } from "@/lib/pdf-rasterize";
import { detectTableStructure } from "@/lib/tatr-structure";
import type { TextractPageData, TextractWord } from "@/types";
import { logger } from "@/lib/logger";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { ApiError } from "@/server/api/envelope";
import { assertPageNumber } from "@/server/api/parser-input";
import { resolveProjectOrThrow } from "@/server/api/access";

const execFileAsync = promisify(execFile);

export async function tableStructure(rawBody: Record<string, unknown>): Promise<unknown> {
  const {
    projectId,
    pageNumber,
    regionBbox,
    confidenceThreshold = 0.5,
  } = rawBody as {
    projectId: number;
    pageNumber: number;
    regionBbox: [number, number, number, number];
    confidenceThreshold?: number;
  };

  if (!projectId || !pageNumber || !regionBbox || regionBbox.length !== 4) {
    throw new ApiError("VALIDATION", "Missing projectId, pageNumber, or regionBbox");
  }
  assertPageNumber(pageNumber);

  const { project } = await resolveProjectOrThrow({ dbId: projectId }, { allowDemo: true });

  if (project.isDemo) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "tableParse");
    if (gate) return gate; // flat 403 passthrough — does NOT flip here (UQ-1)
  }

  const tempDir = await mkdtemp(join(tmpdir(), "bp2-tatr-route-"));

  try {
    // Download PDF via AWS SDK (uses credentials, works with private buckets)
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await downloadFromS3(`${project.dataUrl}/original.pdf`);
    } catch (err) {
      logger.error("[TABLE_STRUCTURE] PDF download failed", { dataUrl: project.dataUrl, err });
      // [S029 UQ-2 sanction] legacy leaked `Failed to fetch PDF: ${err.message}` — suffix
      // dropped; the surviving message SURFACES at 500 (S024 INTERNAL-with-message class).
      throw new ApiError("INTERNAL", "Failed to fetch PDF");
    }
    const pagePng = await rasterizePage(pdfBuffer, pageNumber, 200);

    // Get image dimensions
    const imgW = pagePng.readUInt32BE(16);
    const imgH = pagePng.readUInt32BE(20);

    // Crop to region using Python/OpenCV
    const [rx0, ry0, rx1, ry1] = regionBbox;
    const cropX = Math.round(rx0 * imgW);
    const cropY = Math.round(ry0 * imgH);
    const cropW = Math.max(1, Math.round((rx1 - rx0) * imgW));
    const cropH = Math.max(1, Math.round((ry1 - ry0) * imgH));

    const fullPagePath = join(tempDir, "page.png");
    const croppedPath = join(tempDir, "cropped.png");
    await writeFile(fullPagePath, pagePng);

    const cropScript = `
import cv2, json, sys
cfg = json.loads(sys.argv[1])
img = cv2.imread(cfg["src"])
crop = img[cfg["y"]:cfg["y"]+cfg["h"], cfg["x"]:cfg["x"]+cfg["w"]]
cv2.imwrite(cfg["dst"], crop)
`.trim();

    await execFileAsync("python3", [
      "-c", cropScript,
      JSON.stringify({ src: fullPagePath, dst: croppedPath, x: cropX, y: cropY, w: cropW, h: cropH }),
    ], { timeout: 10000 });

    // Read cropped image
    const { readFile } = await import("fs/promises");
    const croppedBuffer = await readFile(croppedPath);

    // Run TATR structure detection
    const tatrResult = await detectTableStructure(croppedBuffer, confidenceThreshold);

    if (tatrResult.error) {
      // UQ-3: in-band engine error at HTTP 200 — success-path body, never enveloped
      return { error: tatrResult.error, cells: [], rows: [], columns: [], confidence: 0 };
    }

    // Map cell bboxes from crop-relative (0-1) to page-relative (0-1)
    const regionW = rx1 - rx0;
    const regionH = ry1 - ry0;

    const pageCells = tatrResult.cells.map((cell) => ({
      ...cell,
      bbox: [
        rx0 + cell.bbox[0] * regionW,
        ry0 + cell.bbox[1] * regionH,
        rx0 + cell.bbox[2] * regionW,
        ry0 + cell.bbox[3] * regionH,
      ] as [number, number, number, number],
    }));

    // Fill cell text from Textract OCR words
    const [pageRow] = await db
      .select({ textractData: pages.textractData })
      .from(pages)
      .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
      .limit(1);

    if (pageRow?.textractData) {
      const textractData = pageRow.textractData as TextractPageData;
      for (const cell of pageCells) {
        const [cx0, cy0, cx1, cy1] = cell.bbox;
        const wordsInCell = textractData.words.filter((w: TextractWord) => {
          const wcx = w.bbox[0] + w.bbox[2] / 2;
          const wcy = w.bbox[1] + w.bbox[3] / 2;
          return wcx >= cx0 && wcx <= cx1 && wcy >= cy0 && wcy <= cy1;
        });
        cell.text = wordsInCell
          .sort((a: TextractWord, b: TextractWord) => a.bbox[0] - b.bbox[0])
          .map((w: TextractWord) => w.text)
          .join(" ");
      }
    }

    return {
      cells: pageCells,
      rows: tatrResult.rows,
      columns: tatrResult.columns,
      confidence: tatrResult.confidence,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
