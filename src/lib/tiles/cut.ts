// [tiles T9 2026-10-24] The one impure step of tiling: cut a page PNG on disk into tile PNGs on
// disk with scripts/tile_page.py (Pillow — already in the processing image for
// build_project_pdf.py; nothing new is installed). Spawn shape mirrors processing.ts
// runPythonConcat: stdin JSON in, one JSON line out, timeout with SIGTERM→SIGKILL escalation.
// The tiler injects this through TileCutter, so its tests never spawn python.

import { spawn } from "child_process";
import { join } from "path";
import { logger } from "@/lib/logger";

export interface CutTile {
  /** Path relative to outDir, e.g. "L3600/r0_c1.png" (the script creates the directories). */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TileCutter = (pngPath: string, outDir: string, tiles: readonly CutTile[]) => Promise<void>;

interface CutResult {
  status: "ok" | "error";
  written?: number;
  width?: number;
  height?: number;
  error?: string;
  message?: string;
}

/** ~90 tiles off a 113 MP sheet take seconds; the ceiling only catches a wedged interpreter. */
export const TILE_CUT_TIMEOUT_MS = 300_000;

export const cutTilesWithPython: TileCutter = async (pngPath, outDir, tiles) => {
  const scriptPath = join(process.cwd(), "scripts", "tile_page.py");
  const result = await new Promise<CutResult>((resolve, reject) => {
    const proc = spawn("python3", [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    const killTimer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 3000);
      reject(new Error(`tile_page.py timed out (${TILE_CUT_TIMEOUT_MS / 1000}s)`));
    }, TILE_CUT_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (stderr.trim()) logger.info(`[tiles] ${stderr.trim().slice(0, 500)}`);
      try {
        resolve(JSON.parse(stdout.trim()) as CutResult);
      } catch {
        reject(new Error(`tile_page.py exited with code ${code}, no parseable JSON. stderr: ${stderr.slice(0, 500)}`));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    proc.stdin.write(JSON.stringify({ input: pngPath, outputDir: outDir, tiles }));
    proc.stdin.end();
  });

  if (result.status !== "ok") {
    throw new Error(`tile_page.py: ${result.error ?? "error"}${result.message ? ` — ${result.message}` : ""}`);
  }
  if (result.written !== tiles.length) {
    throw new Error(`tile_page.py wrote ${result.written ?? 0} of ${tiles.length} tiles`);
  }
};
