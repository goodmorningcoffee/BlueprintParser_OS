// [refactor jul10 P2.2④] seedTakeoff — THE shared test seed helper for the TAKEOFF domain
// (takeoffItems + takeoffGroups, TWO cache keys / one domain).
//
// This is the SPEC §6.1 single flip point (single-divergence rule; seed-summaries.ts precedent).
// It is shared by every suite that seeds takeoff (TakeoffCountFreeze / TakeoffTabsFreeze /
// TakeoffPanelFreeze). The §2.2④ MIGRATION COMMIT (C3) flipped exactly this ONE function body
// and ZERO call sites:
//
//   PRE-migration:        takeoff lived in viewerStore → useViewerStore.setState({ ... })
//   POST-migration (NOW): takeoff lives in the TanStack Query cache → the production
//                         seedTakeoffCache writes both publicId-keyed entries
//                         (queryKeys.takeoff.items/groups — TAKEOFF_IMPL/SPEC.md §2.6).
//
// Call AFTER setting `publicId` in the store: the cache keys derive from it — every call site's
// beforeEach satisfies this (qto SPEC §6.1 precedent).
// Both collection args are REQUIRED, no defaults (SPEC §6.1) — a future third key can't hide
// behind the signature, and call sites stay explicit about the two-key domain shape.

import type { QueryClient } from "@tanstack/react-query";
import { useViewerStore } from "@/stores/viewerStore";
import { seedTakeoffCache } from "@/queries/useTakeoff";
import type { ClientTakeoffItem, TakeoffGroup } from "@/types";

export function seedTakeoff(
  qc: QueryClient,
  items: ClientTakeoffItem[],
  groups: TakeoffGroup[],
): void {
  seedTakeoffCache(qc, useViewerStore.getState().publicId, items, groups);
}
