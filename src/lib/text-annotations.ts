/**
 * text-annotations.ts
 *
 * Thin facade that delegates to the modular detector pipeline.
 * Maintains backward compatibility — processing.ts and reprocess/route.ts
 * import detectTextAnnotations() from this file unchanged.
 *
 * The actual detectors live in src/lib/detectors/*.ts
 * The orchestrator lives in src/lib/detectors/orchestrator.ts
 */

import type { TextractPageData, CsiCode, TextAnnotationResult } from "@/types";
import { runTextAnnotationPipeline } from "@/lib/detectors/orchestrator";

export function detectTextAnnotations(
  data: TextractPageData,
  csiCodes?: CsiCode[],
  enabledDetectorIds?: string[],
): TextAnnotationResult {
  return runTextAnnotationPipeline({ data, csiCodes, enabledDetectorIds });
}
