// [refactor jul10 P2.2③] seedSummaries — THE shared test seed helper for the SUMMARIES domain.
//
// This is the SPEC §6 single flip point (single-divergence rule, RECIPE 10 / SPEC §5-S7).
// It is shared by every suite that seeds summaries (AutoQtoTab.test.tsx preflight + Q-10,
// SummariesFreeze.test.tsx SI/NI/TPP/KP/VT/PS cases). The §2.2③ MIGRATION COMMIT flipped
// exactly this ONE function body and ZERO call sites:
//
//   PRE-migration:        summaries lived in viewerStore → useViewerStore.setState({ summaries })
//   POST-migration (NOW): summaries live in the TanStack Query cache → write the publicId-keyed
//                         cache entry, exactly like the production seed sites do.
//
// Call AFTER setting `publicId` in the session store: the cache key derives from it. Every existing
// call site (AutoQtoTab beforeEach, Q-11 openProject, SummariesFreeze beforeEach) satisfies this.
// The `?? null` is LOAD-BEARING (RQ v5 setQueryData(key, undefined) is a silent no-op — SPEC
// §2.1) and mirrors the production seedSummariesCache; the param type already forbids undefined
// but the coercion keeps the helper faithful to the production write shape.

import type { QueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/sessionStore";
import { queryKeys } from "@/queries/queryKeys";
import type { ProjectSummaries } from "@/types";

export function seedSummaries(qc: QueryClient, summaries: ProjectSummaries | null): void {
  qc.setQueryData(queryKeys.summaries.all(useSessionStore.getState().publicId), summaries ?? null);
}
