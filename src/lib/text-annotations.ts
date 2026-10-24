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
import type { PageZones } from "@/lib/page-zones";
import { runTextAnnotationPipeline } from "@/lib/detectors/orchestrator";

export function detectTextAnnotations(
  data: TextractPageData,
  csiCodes?: CsiCode[],
  enabledDetectorIds?: string[],
  pageZones?: PageZones, // [zones T2] persisted detector zones, when the caller has them
): TextAnnotationResult {
  return runTextAnnotationPipeline({ data, csiCodes, enabledDetectorIds, pageZones });
}
