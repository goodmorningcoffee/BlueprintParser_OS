/**
 * text-region-classifier-debug.ts
 *
 * Server-only helper: uploads a ClassifierDebugBundle to S3 so operators can
 * trace Stage A–F decisions for a specific page during tuning.
 *
 * Uses `fs` via the existing `uploadToS3` helper (AWS SDK S3 client). Never
 * import from a client component — this module has server-only deps.
 *
 * Lifecycle: admin triggers `POST /api/admin/reprocess?scope=intelligence&debug=1`,
 * the classifier is invoked with `{ debug: true, onDebug: cb }`, and this helper
 * stores the emitted bundle under:
 *     {projectDataUrl}/debug/classifier/page_{NNNN}.json
 *
 * JSON is pretty-printed for human review. No PNG generation server-side —
 * bbox coordinates in the bundle can be rendered client-side onto the page PNG.
 */

import { uploadToS3 } from "@/lib/s3";
import { logger } from "@/lib/logger";
import type { ClassifierDebugBundle } from "@/lib/text-region-classifier";

/**
 * Upload a debug bundle for one page to S3.
 * Silently logs errors — debug writes must NEVER fail the parent pipeline.
 */
export async function writeClassifierDebugBundle(
  projectDataUrl: string,
  pageNumber: number,
  bundle: ClassifierDebugBundle,
): Promise<void> {
  const pageKey = String(pageNumber).padStart(4, "0");
  const key = `${projectDataUrl}/debug/classifier/page_${pageKey}.json`;
  try {
    const body = Buffer.from(JSON.stringify(bundle, null, 2), "utf-8");
    await uploadToS3(key, body, "application/json");
  } catch (err) {
    logger.error(`[classifier-debug] failed to write bundle for page ${pageNumber}:`, err);
  }
}
