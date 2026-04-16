/**
 * template-match.ts — Generic TypeScript wrapper around the Python template matching engine.
 *
 * Reusable engine layer: symbol search, schedule tag mapping, and auto-QTO
 * all call into this. Uses child_process.spawn for streaming NDJSON output.
 */

import { spawn } from "child_process";
import { writeFile, rm, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type {
  TemplateMatchOptions,
  TemplateMatchResult,
  TemplateMatchProgress,
  TemplateMatchHit,
  BboxLTWH,
} from "@/types";
import { logger } from "@/lib/logger";

// ─── Core engine function ─────────────────────────────────────

export interface TemplateMatchCallbacks {
  onProgress?: (progress: TemplateMatchProgress) => void;
}

/**
 * Run the Python template matching engine.
 *
 * @param options - Engine configuration (mode, paths, thresholds)
 * @param callbacks - Optional progress callback for streaming updates
 * @returns Matched results with bboxes and confidence scores
 */
export async function templateMatch(
  options: TemplateMatchOptions,
  callbacks?: TemplateMatchCallbacks
): Promise<TemplateMatchResult> {
  const scriptPath = join(process.cwd(), "scripts/template_match.py");

  // Build config JSON for the Python script
  const config = {
    mode: options.mode,
    template_path: options.templatePath,
    target_paths: options.targetPaths,
    confidence_threshold: options.confidenceThreshold ?? 0.75,
    multi_scale: options.multiScale ?? true,
    scales: options.scales ?? [0.9, 0.95, 1.0, 1.05, 1.1],
    use_sift_fallback: options.useSiftFallback ?? true,
    sift_fallback_threshold: options.siftFallbackThreshold ?? 3,
    nms_iou_threshold: options.nmsIouThreshold ?? 0.3,
    max_matches_per_page: options.maxMatchesPerPage ?? 100,
  };

  return new Promise<TemplateMatchResult>((resolve, reject) => {
    const proc = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Enforce timeout with explicit kill (spawn timeout option unreliable)
    const timeoutMs = 300_000; // 5 minutes
    const killTimer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
      reject(new Error("Template matching timed out (5 min)"));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    let finalResult: TemplateMatchResult | null = null;
    let engineError: string | null = null;

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();

      // Parse NDJSON lines as they arrive
      const lines = stdout.split("\n");
      // Keep incomplete last line in buffer
      stdout = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "progress" && callbacks?.onProgress) {
            callbacks.onProgress({
              type: "progress",
              targetIndex: msg.target_index,
              targetPath: msg.target_path,
              matches: msg.matches,
            });
          } else if (msg.type === "done") {
            finalResult = {
              totalMatches: msg.total_matches,
              results: (msg.results || []).map((r: any) => ({
                targetIndex: r.target_index,
                bbox: r.bbox as BboxLTWH,
                confidence: r.confidence,
                method: r.method,
                scale: r.scale,
              })),
            };
          } else if (msg.type === "error") {
            engineError = msg.message as string;
            logger.error(`[TEMPLATE_MATCH] Engine error: ${engineError}`);
          }
        } catch {
          // Ignore malformed lines
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code, signal) => {
      clearTimeout(killTimer);
      if (stderr?.trim()) {
        logger.info(`[TEMPLATE_MATCH] ${stderr.trim()}`);
      }

      // Process any remaining stdout
      if (stdout.trim()) {
        try {
          const msg = JSON.parse(stdout.trim());
          if (msg.type === "done") {
            finalResult = {
              totalMatches: msg.total_matches,
              results: (msg.results || []).map((r: any) => ({
                targetIndex: r.target_index,
                bbox: r.bbox as BboxLTWH,
                confidence: r.confidence,
                method: r.method,
                scale: r.scale,
              })),
            };
          }
        } catch {
          // ignore
        }
      }

      if ((code !== 0 || signal) && !finalResult) {
        if (engineError) {
          reject(new Error(engineError));
        } else {
          const reason = signal ? `killed by ${signal}` : `exit code ${code}`;
          reject(new Error(`template_match.py ${reason}: ${stderr}`));
        }
        return;
      }

      resolve(finalResult || { totalMatches: 0, results: [] });
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn template_match.py: ${err.message}`));
    });

    // Write config to stdin and close
    proc.stdin.write(JSON.stringify(config));
    proc.stdin.end();
  });
}

// ─── Convenience wrappers ─────────────────────────────────────

export interface SymbolSearchOptions {
  /** PNG buffer of the template (cropped from source page) */
  templateBuffer: Buffer;
  /** PNG buffers of target pages, keyed by page number */
  targetPages: { pageNumber: number; buffer: Buffer }[];
  confidenceThreshold?: number;
  multiScale?: boolean;
  useSiftFallback?: boolean;
  onProgress?: (pageNumber: number, matchCount: number) => void;
}

/**
 * Search for all instances of a template symbol across multiple page images.
 * Handles temp file creation/cleanup. Returns results mapped back to page numbers.
 */
export async function searchSymbol(
  opts: SymbolSearchOptions
): Promise<{ totalMatches: number; results: (TemplateMatchHit & { pageNumber: number })[] }> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-symbol-search-"));

  try {
    // Write template to temp file
    const templatePath = join(tempDir, "template.png");
    await writeFile(templatePath, opts.templateBuffer);

    // Write target pages to temp files
    const targetPaths: string[] = [];
    const pageMap: number[] = []; // targetIndex -> pageNumber
    for (let i = 0; i < opts.targetPages.length; i++) {
      const { pageNumber, buffer } = opts.targetPages[i];
      const path = join(tempDir, `target_${String(i).padStart(4, "0")}.png`);
      await writeFile(path, buffer);
      targetPaths.push(path);
      pageMap.push(pageNumber);
    }

    const result = await templateMatch(
      {
        mode: "search",
        templatePath: templatePath,
        targetPaths: targetPaths,
        confidenceThreshold: opts.confidenceThreshold ?? 0.75,
        multiScale: opts.multiScale ?? true,
        useSiftFallback: opts.useSiftFallback ?? true,
      },
      {
        onProgress: (progress) => {
          if (opts.onProgress && progress.targetIndex < pageMap.length) {
            opts.onProgress(pageMap[progress.targetIndex], progress.matches);
          }
        },
      }
    );

    return {
      totalMatches: result.totalMatches,
      results: result.results.map((r) => ({
        ...r,
        pageNumber: pageMap[r.targetIndex] ?? 0,
      })),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Check if a template exists in a single target image.
 * Returns the best match or null.
 */
export async function matchOne(
  templateBuffer: Buffer,
  targetBuffer: Buffer,
  opts?: { confidenceThreshold?: number }
): Promise<(TemplateMatchHit & { found: boolean }) | null> {
  const tempDir = await mkdtemp(join(tmpdir(), "bp2-match-one-"));

  try {
    const templatePath = join(tempDir, "template.png");
    const targetPath = join(tempDir, "target.png");
    await writeFile(templatePath, templateBuffer);
    await writeFile(targetPath, targetBuffer);

    const result = await templateMatch({
      mode: "match_one",
      templatePath,
      targetPaths: [targetPath],
      confidenceThreshold: opts?.confidenceThreshold ?? 0.75,
    });

    if (result.totalMatches > 0 && result.results[0]) {
      return { ...result.results[0], found: true };
    }
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
