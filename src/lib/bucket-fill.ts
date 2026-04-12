/**
 * bucket-fill.ts — TypeScript wrapper for the Python bucket fill engine.
 *
 * Spawns scripts/bucket_fill.py with JSON config on stdin,
 * reads a single JSON result from stdout.
 */

import { spawn } from "child_process";
import { join } from "path";
import { logger } from "@/lib/logger";

export interface BucketFillOptions {
  imagePath: string;
  pdfPath?: string;
  pageNumber: number;
  seedX: number; // normalized 0-1
  seedY: number; // normalized 0-1
  tolerance?: number;
  dilatePx?: number;
  simplifyEpsilon?: number;
  barriers?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  polygonBarriers?: Array<{ vertices: Array<{ x: number; y: number }> }>;
  maxDimension?: number;
}

export interface BucketFillResult {
  type: "result" | "error";
  method?: "raster" | "vector";
  vertices?: Array<{ x: number; y: number }>;
  vertexCount?: number;
  areaFraction?: number;
  edgesOnPage?: number;
  error?: string;
}

export async function bucketFill(
  options: BucketFillOptions
): Promise<BucketFillResult> {
  const scriptPath = join(process.cwd(), "scripts/bucket_fill.py");

  const config = {
    image_path: options.imagePath,
    pdf_path: options.pdfPath,
    page_number: options.pageNumber,
    seed_x: options.seedX,
    seed_y: options.seedY,
    tolerance: options.tolerance ?? 30,
    dilate_px: options.dilatePx ?? 3,
    simplify_epsilon: options.simplifyEpsilon ?? 0.005,
    barriers: options.barriers ?? [],
    polygon_barriers: options.polygonBarriers ?? [],
    max_dimension: options.maxDimension ?? 2000,
  };

  return new Promise<BucketFillResult>((resolve, reject) => {
    const proc = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeoutMs = 30_000;
    const killTimer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 3000);
      reject(new Error("Bucket fill timed out (30s)"));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (stderr?.trim()) {
        logger.info(`[BUCKET_FILL] ${stderr.trim()}`);
      }

      try {
        const result = JSON.parse(stdout.trim()) as BucketFillResult;
        resolve(result);
      } catch {
        if (code !== 0) {
          reject(
            new Error(`bucket_fill.py exited with code ${code}: ${stderr}`)
          );
        } else {
          resolve({ type: "error", error: "No output from bucket fill script" });
        }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });

    // Send config on stdin
    proc.stdin.write(JSON.stringify(config));
    proc.stdin.end();
  });
}
