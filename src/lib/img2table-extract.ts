/**
 * img2table-extract.ts — TypeScript wrapper for img2table Python extraction.
 *
 * Spawns scripts/img2table_extract.py, sends config via stdin, reads JSON from stdout.
 * img2table uses Hough Transform + morphological operations with built-in
 * skew correction and merged cell detection.
 *
 * Two extraction modes (Phase C):
 * - pdf:   Img2TablePDF on a PDF cropped to the region. Uses native PDF text
 *          via PdfOCR (perfect spelling, bypasses Tesseract OCR errors on
 *          vector blueprints). Falls back to TesseractOCR for non-native pages.
 * - image: Img2TableImage on a rasterized + cropped PNG (legacy behavior).
 *
 * Default mode is "auto": try PDF if pdfBuffer present, fall back to image.
 */

import { spawn } from "child_process";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "@/lib/logger";
import type { MethodResult } from "@/lib/grid-merger";

const EMPTY: MethodResult = { method: "img2table", headers: [], rows: [], confidence: 0 };

export interface Img2TableOptions {
  /** "auto" tries PDF mode first then falls back to image; "pdf" forces PDF; "image" forces image */
  mode?: "auto" | "pdf" | "image";
  /** Rasterization DPI for img2table internal table detection */
  dpi?: number;
  /** Min OCR confidence (only used for non-native pages) */
  minConfidence?: number;
  /** Whether to split implicit rows */
  implicitRows?: boolean;
}

/**
 * Extract a table from a page using img2table.
 *
 * @param pdfBuffer - Original PDF bytes (preferred — enables native PDF text mode)
 * @param pngBuffer - Rasterized page PNG bytes (used as image-mode input or fallback)
 * @param pageNumber - 1-indexed page number (only used for PDF mode)
 * @param regionBbox - [minX, minY, maxX, maxY] normalized 0-1 of the page
 * @param options - Mode + tuning knobs
 */
export async function extractWithImg2Table(
  pdfBuffer: Buffer | null,
  pngBuffer: Buffer | null,
  pageNumber: number,
  regionBbox: [number, number, number, number],
  options: Img2TableOptions = {},
): Promise<MethodResult> {
  if (!pdfBuffer && !pngBuffer) {
    return { ...EMPTY, error: "img2table: no PDF or PNG input provided" };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "bp2-img2table-"));

  try {
    const config: Record<string, unknown> = {
      mode: options.mode ?? "auto",
      page_number: pageNumber,
      region_bbox: regionBbox,
      dpi: options.dpi ?? 200,
      detect_rotation: false,
      implicit_rows: options.implicitRows ?? true,
      min_confidence: options.minConfidence ?? 30,
    };

    if (pdfBuffer) {
      const pdfPath = join(tempDir, "page.pdf");
      await writeFile(pdfPath, pdfBuffer);
      config.pdf_path = pdfPath;
    }

    if (pngBuffer) {
      const imgPath = join(tempDir, "page.png");
      await writeFile(imgPath, pngBuffer);
      config.image_path = imgPath;
    }

    const scriptPath = join(process.cwd(), "scripts/img2table_extract.py");
    const configJson = JSON.stringify(config);

    return await new Promise<MethodResult>((resolve) => {
      const proc = spawn("python3", [scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ ...EMPTY, error: "img2table timed out after 30s" });
      }, 30_000);

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (stderr.trim()) logger.info(`[img2table] ${stderr.trim()}`);
        try {
          const result = JSON.parse(stdout.trim() || "{}");
          // Phase A.3: trust result.error from Python — the script now guarantees
          // an error field on every empty path (see scripts/img2table_extract.py).
          // Stop inferring errors from stderr tail (it was catching debug output
          // like "Cropped region: 1234x567" instead of real errors).
          let error: string | undefined = result.error;
          if (!error && code !== 0) {
            error = `img2table process exited with code ${code}`;
          }
          resolve({
            method: result.method || "img2table",
            headers: result.headers || [],
            rows: result.rows || [],
            confidence: result.confidence || 0,
            colBoundaries: result.colBoundaries,
            rowBoundaries: result.rowBoundaries,
            ...(error ? { error } : {}),
          });
        } catch {
          // Script produced non-JSON output — likely a crash traceback. Log the
          // full stderr (not just the last line) so debugging is possible.
          logger.error(`[img2table] Failed to parse output (exit ${code}). stderr: ${stderr.trim() || "<empty>"}`);
          const errMsg = stderr.trim().split("\n").filter(Boolean).pop() || `img2table crashed (exit ${code}) with no stderr`;
          resolve({ ...EMPTY, error: errMsg });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ...EMPTY, error: `spawn failed: ${err.message}` });
      });

      proc.stdin.write(configJson);
      proc.stdin.end();
    });
  } catch (err) {
    logger.error("[img2table] Wrapper failed:", err);
    return EMPTY;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
