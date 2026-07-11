// [refactor jul10 P2.2⑤] seedAnnotations — THE shared test seed helper for the ANNOTATIONS
// domain (⑥). Created NOW, PRE-form only: this discharges the ③-DETECTOR debt (shared seed
// helpers owed BEFORE ⑥ — ANNGROUPS_IMPL/SPEC.md §6.1, verdict 10) and routes ⑤'s
// mass-delete + ViewAllPanel member-count seeds through the single future flip point.
//
//   PRE-migration (NOW):  annotations live in viewerStore → setState({ annotations: rows })
//   POST-migration:       ⑥ OWNS THE FLIP — this body seeds the ONE windowed cache entry at
//                         queryKeys.annotations.all(publicId). Do NOT flip it in ⑤.
//
// Call AFTER setting `publicId` in the store (the future cache key derives from it — same
// discipline as seed-summaries/seed-takeoff/seed-annotation-groups).
// `qc` is UNUSED in the pre-form on purpose: threaded from birth so ⑥'s flip touches only this
// body and ZERO call sites (single-divergence rule).

import type { QueryClient } from "@tanstack/react-query";
import { useViewerStore } from "@/stores/viewerStore";
import type { ClientAnnotation } from "@/types";

export function seedAnnotations(qc: QueryClient, rows: ClientAnnotation[]): void {
  void qc; // pre-form: zustand-backed; qc becomes load-bearing at the ⑥ flip
  useViewerStore.setState({ annotations: rows });
}

/**
 * Test-only companion read seam for assertions that must survive the C3 backing-store flip.
 *
 * [refactor jul11 P2.2⑥] Keeping this beside `seedAnnotations` lets the C1 behavior freezes
 * remain unchanged while C2 introduces the production `readAnnotations(qc, publicId)` bridge.
 * C3 flips this tiny body to the query key at the same time as the seed body; production code
 * must use the facade bridge instead of importing a test helper.
 */
export function readSeededAnnotations(qc: QueryClient): readonly ClientAnnotation[] {
  void qc; // pre-form: zustand-backed; becomes the query-cache reader at the ⑥ flip
  return useViewerStore.getState().annotations;
}
