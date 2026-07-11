// [refactor jul10 P2.2⑤] seedAnnotations — THE shared test seed helper for the ANNOTATIONS
// domain (⑥). Created PRE-form: this discharged the ③-DETECTOR debt (shared seed
// helpers owed BEFORE ⑥ — ANNGROUPS_IMPL/SPEC.md §6.1, verdict 10) and routes ⑤'s
// mass-delete + ViewAllPanel member-count seeds through the single future flip point.
//
//   PRE-migration: annotations lived in viewerStore → setState({ annotations: rows })
//   POST-migration (C3): this body seeds the ONE windowed cache entry under live publicId.
//
// Call AFTER setting `publicId` in the session store (the future cache key derives from it — same
// discipline as seed-summaries/seed-takeoff/seed-annotation-groups).
// `qc` was threaded from birth, so C3 changes only these two bodies and ZERO call sites.

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import { readAnnotations } from "@/queries/useAnnotations";
import { useSessionStore } from "@/stores/sessionStore";
import type { ClientAnnotation } from "@/types";

export function seedAnnotations(qc: QueryClient, rows: ClientAnnotation[]): void {
  const publicId = useSessionStore.getState().publicId;
  qc.setQueryData(queryKeys.annotations.all(publicId), rows);
}

/**
 * Test-only companion read seam for assertions that must survive the C3 backing-store flip.
 *
 * [refactor jul11 P2.2⑥] Keeping this beside `seedAnnotations` lets the C1 behavior freezes
 * remain unchanged while C2 introduces the production `readAnnotations(qc, publicId)` bridge.
 * C3 flipped this tiny body beside the seed body; production code must use the facade bridge
 * instead of importing a test helper.
 */
export function readSeededAnnotations(qc: QueryClient): readonly ClientAnnotation[] {
  return readAnnotations(qc, useSessionStore.getState().publicId);
}
