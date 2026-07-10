// [refactor jul10 P2.2③] seedSummaries — THE shared test seed helper for the SUMMARIES domain.
//
// This is the SPEC §6 single flip point (single-divergence rule, RECIPE 10 / SPEC §5-S7).
// It is shared by every suite that seeds summaries (AutoQtoTab.test.tsx preflight + Q-10,
// SummariesFreeze.test.tsx SI/NI/TPP/KP/VT/PS cases) so that the §2.2③ migration commit
// flips exactly ONE function body and ZERO call sites:
//
//   PRE-migration (NOW):  summaries lives in viewerStore → write the store field.
//   POST-migration:       the body becomes
//     qc.setQueryData(queryKeys.summaries.all(useViewerStore.getState().publicId), summaries ?? null)
//
// `qc` is deliberately accepted (and unused) TODAY so the flip needs no call-site churn —
// the QueryClient is per-test-file state and cannot be imported from here.
// Call AFTER setting `publicId` in the store: post-migration the cache key derives from it.
// The `?? null` in the future body is LOAD-BEARING (RQ v5 setQueryData(key, undefined) is a
// silent no-op — SPEC §2.1); the store write needs no coercion because callers pass
// `ProjectSummaries | null` already.

import type { QueryClient } from "@tanstack/react-query";
import { useViewerStore } from "@/stores/viewerStore";
import type { ProjectSummaries } from "@/types";

export function seedSummaries(qc: QueryClient, summaries: ProjectSummaries | null): void {
  void qc; // unused pre-migration; the post-migration body writes the query cache through it
  useViewerStore.setState({ summaries });
}
