/**
 * yolo-tag-engine.ts — Back-compat shim (trimmed, Phase 4 2026-04-16).
 *
 * The implementation lives in `src/lib/tag-mapping/`. New code must import
 * from `@/lib/tag-mapping` directly — this file only re-exports names that
 * still have in-tree callers:
 *   - `mapYoloToOcrText`, `getOcrTextInAnnotation` — AnnotationOverlay.tsx
 *     (double-click-on-annotation → search class's text). Migration of
 *     that flow to the server route is deferred to a later phase.
 *   - `isFuzzyCandidate` — keynote-tag-mapper.ts.
 *   - `findItemOccurrences` — find-occurrences.test.ts (legacy shim parity
 *     test; will live as long as the legacy adapter does).
 *
 * See:
 *   - featureRoadMap/tag_mapping_refactor_plan.md
 *   - featureRoadMap/session_2026_04_16_phase_4_and_bugs.md
 *   - src/lib/tag-mapping/index.ts (public surface)
 */

export {
  findItemOccurrences,
  mapYoloToOcrText,
  getOcrTextInAnnotation,
  isFuzzyCandidate,
} from "@/lib/tag-mapping";
