/**
 * yolo-tag-engine.ts — Back-compat shim.
 *
 * This file is a thin re-export surface. The implementation lives in
 * `src/lib/tag-mapping/` after the 2026-04-16 refactor.
 *
 * New code should import from `@/lib/tag-mapping` directly; these exports
 * are preserved so existing call sites (AutoQtoTab, KeynotePanel,
 * TableParsePanel, map-tags routes, llm/tools) continue to compile
 * unchanged.
 *
 * See:
 *   - featureRoadMap/tag_mapping_refactor_plan.md  (architecture)
 *   - src/lib/tag-mapping/index.ts                 (public surface)
 */

// Types
export type {
  CountableItem,
  MapYoloToOcrOptions,
  ClassScanResult,
} from "@/lib/tag-mapping";

// Functions — names preserved from pre-refactor yolo-tag-engine.ts
export {
  findItemOccurrences,
  mapYoloToOcrText,
  getOcrTextInAnnotation,
  scanClassForTexts,
  isFuzzyCandidate,
} from "@/lib/tag-mapping";
