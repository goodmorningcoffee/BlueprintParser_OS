/**
 * camelot-extract.ts — TypeScript wrapper for Camelot + pdfplumber Python extraction.
 *
 * Spawns scripts/camelot_pdfplumber_extract.py, sends config via stdin,
 * reads JSON array from stdout. Returns up to 3 MethodResults:
 * camelot-lattice, camelot-stream, pdfplumber.
 *
 * These methods work on native PDFs (not scanned) by reading actual
 * vector line objects from the PDF structure.
 */

import { spawn } from "child_process";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "@/lib/logger";
import type { MethodResult } from "@/lib/grid-merger";

const EMPTY: MethodResult[] = [];

/**
 * Extract tables from a PDF page using Camelot + pdfplumber.
 *
 * @param pdfBuffer - Full PDF file buffer
 * @param pageNumber - 1-indexed page number
 * @param regionBbox - [minX, minY, maxX, maxY] normalized 0-1
 * @returns Array of MethodResults (up to 3: camelot-lattice, camelot-stream, pdfplumber)
 */
export async function extractWithCamelotPdfplumber(
  pdfBuffer: Buffer,
  pageNumber: number,
  regionBbox: [number, number, number, number],
): Promise<MethodResult[]> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-camelot-"));

  try {
    const pdfPath = join(tempDir, "source.pdf");
    await writeFile(pdfPath, pdfBuffer);

    const scriptPath = join(process.cwd(), "scripts/camelot_pdfplumber_extract.py");
    const config = JSON.stringify({
      pdf_path: pdfPath,
      page_number: pageNumber,
      region_bbox: regionBbox,
    });

    return await new Promise<MethodResult[]>((resolve) => {
      const proc = spawn("python3", [scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // CAMELOT-FIX-2: bumped from 30s → 120s.
      // First bump (30→60s) wasn't enough — local end-to-end test on a real
      // 24×36" door hardware schedule showed:
      //   camelot-lattice  31874ms  (success, 11r × 3c — real data)
      //   camelot-stream   31612ms  (188r × 22c — likely noise but ran)
      //   pdfplumber       13034ms  (empty — needs more grid lines)
      //   total            87516ms  (sequential in Python script)
      // Production Python 3.11 should be ~2× faster than local Python 3.14
      // (estimated ~45s total) but we want headroom. 120s is the right budget
      // for "let it complete or genuinely hang."
      // The route runs all 5 methods in Promise.all so camelot's 90-120s
      // doesn't block the others — only the slowest method dictates user-
      // visible wait time, and the merger picks whatever finishes first with
      // good confidence.
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        // Phase I.1.c: include any stderr captured before the timeout
        const cappedStderr = stderr.length > 10_000 ? stderr.slice(-10_000) : stderr;
        const debug = { stderr: cappedStderr || undefined, exitCode: -1 };
        resolve([{ method: "camelot-pdfplumber", headers: [], rows: [], confidence: 0, error: "Script timed out (120s)", debug }]);
      }, 120_000);

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (stderr.trim()) logger.info(`[camelot-pdfplumber] ${stderr.trim()}`);
        // Phase I.1.c: capture full stderr (capped at 10KB) and exit code for
        // the debug UI. Same debug info propagates to ALL three sub-method
        // results so the user can see one consolidated view per call.
        const cappedStderr = stderr.length > 10_000 ? stderr.slice(-10_000) : stderr;
        const sharedDebug = {
          stderr: cappedStderr || undefined,
          exitCode: code ?? undefined,
        };
        if (!stdout.trim()) {
          const errMsg = stderr.trim().split("\n").pop() || `Process exited with code ${code} (no output)`;
          logger.error(`[camelot-pdfplumber] No output: ${errMsg}`);
          resolve([{ method: "camelot-pdfplumber", headers: [], rows: [], confidence: 0, error: errMsg, debug: sharedDebug }]);
          return;
        }
        try {
          const results: MethodResult[] = JSON.parse(stdout.trim() || "[]");
          resolve(
            results.map((r) => ({
              method: r.method,
              headers: r.headers || [],
              rows: r.rows || [],
              confidence: r.confidence || 0,
              colBoundaries: r.colBoundaries,
              rowBoundaries: r.rowBoundaries,
              ...(r.error ? { error: r.error } : {}),
              debug: sharedDebug,
            }))
          );
        } catch {
          const errMsg = stderr.trim().split("\n").pop() || `Process exited with code ${code}`;
          logger.error(`[camelot-pdfplumber] Failed to parse output: ${errMsg}`);
          resolve([{ method: "camelot-lattice", headers: [], rows: [], confidence: 0, error: errMsg, debug: sharedDebug }]);
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve([{ method: "camelot-pdfplumber", headers: [], rows: [], confidence: 0, error: `spawn failed: ${err.message}`, debug: { exitCode: -1 } }]);
      });

      proc.stdin.write(config);
      proc.stdin.end();
    });
  } catch (err) {
    logger.error("[camelot-pdfplumber] Wrapper failed:", err);
    return [{ method: "camelot-pdfplumber", headers: [], rows: [], confidence: 0, error: err instanceof Error ? err.message : "Wrapper failed" }];
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
