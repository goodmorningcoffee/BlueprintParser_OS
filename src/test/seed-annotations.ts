// [refactor jul10 P2.2⑤] seedAnnotations — THE shared test seed helper for the ANNOTATIONS
// domain (⑥). Created NOW, PRE-form only: this discharges the ③-DETECTOR debt (shared seed
// helpers owed BEFORE ⑥ — ANNGROUPS_IMPL/SPEC.md §6.1, verdict 10) and routes ⑤'s
// mass-delete + ViewAllPanel member-count seeds through the single future flip point.
//
//   PRE-migration (NOW):  annotations live in viewerStore → setState({ annotations: rows })
//   POST-migration:       ⑥ OWNS THE FLIP — this body becomes the ⑥ production cache seed
//                         (queryKeys.annotations.*, publicId-keyed; exact shape is ⑥'s SPEC
//                         call, incl. any per-page keying). Do NOT flip it in ⑤.
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
