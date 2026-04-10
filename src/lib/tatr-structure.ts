/**
 * tatr-structure.ts — TypeScript wrapper for TATR (Table Transformer) inference.
 *
 * Spawns scripts/tatr_structure.py, sends config via stdin, reads JSON from stdout.
 * Returns detected table structure: cells, rows, columns with bounding boxes.
 */

import { spawn } from "child_process";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "@/lib/logger";

export interface TatrCell {
  bbox: [number, number, number, number];
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  type: "cell" | "column-header" | "row-header" | "spanning";
  confidence: number;
  text?: string;
}

export interface TatrResult {
  cells: TatrCell[];
  rows: { bbox: [number, number, number, number]; index: number }[];
  columns: { bbox: [number, number, number, number]; index: number }[];
  confidence: number;
  error?: string;
}

const EMPTY: TatrResult = { cells: [], rows: [], columns: [], confidence: 0 };

/**
 * Run TATR table structure recognition on a cropped table image.
 *
 * @param croppedPngBuffer - PNG image of the cropped table region
 * @param confidenceThreshold - Min detection confidence (0-1)
 */
export async function detectTableStructure(
  croppedPngBuffer: Buffer,
  confidenceThreshold: number = 0.5,
): Promise<TatrResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-tatr-"));

  try {
    const imgPath = join(tempDir, "table_crop.png");
    await writeFile(imgPath, croppedPngBuffer);

    const scriptPath = join(process.cwd(), "scripts/tatr_structure.py");
    // Model path: relative to project root (models/ is sibling of blueprintparser_2/)
    // In Docker: cwd=/app, models bundled at /app/models/tatr (Phase B.2 of plan).
    // Local dev: models at /app/../models/tatr.
    const candidates = [
      join(process.cwd(), "models", "tatr"),
      join(process.cwd(), "..", "models", "tatr"),
    ];
    const { existsSync } = await import("fs");
    const modelPath = candidates.find((p) => existsSync(p));
    if (!modelPath) {
      // Phase B.3: fail fast with a clear error instead of passing a bogus path
      // through to Python and getting back a less helpful "Model not found at <fake path>".
      logger.error(`[TATR] Model not found. Searched: ${candidates.join(", ")}`);
      return { ...EMPTY, error: `TATR model not found in any candidate path: ${candidates.join(", ")}` };
    }

    const config = JSON.stringify({
      image_path: imgPath,
      model_path: modelPath,
      confidence_threshold: confidenceThreshold,
    });

    return await new Promise<TatrResult>((resolve) => {
      const proc = spawn("python3", [scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ ...EMPTY, error: "TATR inference timed out (60s)" });
      }, 60_000);

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.on("close", () => {
        clearTimeout(timer);
        if (stderr.trim()) logger.info(`[TATR] ${stderr.trim()}`);
        try {
          const result = JSON.parse(stdout.trim() || "{}");
          resolve({
            cells: (result.cells || []).map((c: any) => ({
              bbox: c.bbox,
              row: c.row,
              col: c.col,
              rowSpan: c.rowSpan || 1,
              colSpan: c.colSpan || 1,
              type: c.type || "cell",
              confidence: c.confidence || 0,
            })),
            rows: result.rows || [],
            columns: result.columns || [],
            confidence: result.confidence || 0,
            ...(result.error ? { error: result.error } : {}),
          });
        } catch {
          logger.error("[TATR] Failed to parse output");
          resolve({ ...EMPTY, error: "Failed to parse TATR output" });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ...EMPTY, error: `TATR process error: ${err.message}` });
      });

      proc.stdin.write(config);
      proc.stdin.end();
    });
  } catch (err) {
    logger.error("[TATR] Wrapper failed:", err);
    return { ...EMPTY, error: err instanceof Error ? err.message : "TATR failed" };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
