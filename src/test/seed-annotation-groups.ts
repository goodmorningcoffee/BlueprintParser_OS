// [refactor jul10 P2.2⑤] seedAnnotationGroups — THE shared test seed helper for the
// ANNOTATION-GROUPS domain (groups + M:N membership indexes; ONE cache key at C3).
//
// This is the SPEC §6.1 single flip point (single-divergence rule; seed-summaries.ts /
// seed-takeoff.ts precedent — P2_DESIGN/ANNGROUPS_IMPL/SPEC.md is authoritative). It is shared
// by every suite that seeds annotation groups (GroupActionsBarFreeze / ViewAllPanelGroupsFreeze /
// useMultiSelectInteractionFreeze). The §2.2⑤ MIGRATION COMMIT (C3) flips exactly this ONE
// function body and ZERO call sites:
//
//   PRE-migration:        groups lived in viewerStore → setState({annotationGroups}) +
//                         hydrateGroupMemberships(pairs) (the store's own index rebuild)
//   POST-migration (NOW): groups live in the TanStack Query cache → the production
//                         seedAnnotationGroupsCache(qc, useViewerStore.getState().publicId,
//                         {groups, memberships: pairs}) — raw pairs in the cache, Sets only in
//                         the derived layer (SPEC §3.2).
//
// Call AFTER setting `publicId` in the store: the cache key derives from it (qto SPEC §6.1
// precedent) — every call site's beforeEach satisfies this.
// Both collection args are REQUIRED, no defaults — the one-key/two-half domain shape stays
// explicit at every call site and a future third half can't hide behind the signature.
// `qc` was threaded from birth precisely so this C3 flip touched only this body (zero
// call-site churn).

import type { QueryClient } from "@tanstack/react-query";
import { useViewerStore } from "@/stores/viewerStore";
import { seedAnnotationGroupsCache } from "@/queries/useAnnotationGroups";
import type { AnnotationGroup, AnnotationGroupMembership } from "@/types";

export function seedAnnotationGroups(
  qc: QueryClient,
  groups: AnnotationGroup[],
  pairs: AnnotationGroupMembership[],
): void {
  // [refactor jul10 P2.2⑤ C3] flipped zustand → cache; the production seed is the write path.
  seedAnnotationGroupsCache(qc, useViewerStore.getState().publicId, {
    groups,
    memberships: pairs,
  });
}
