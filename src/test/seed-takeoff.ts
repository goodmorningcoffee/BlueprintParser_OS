// [refactor jul10 P2.2④] seedTakeoff — THE shared test seed helper for the TAKEOFF domain
// (takeoffItems + takeoffGroups, TWO cache keys / one domain).
//
// This is the SPEC §6.1 single flip point (single-divergence rule; seed-summaries.ts precedent).
// It is shared by every suite that seeds takeoff (TakeoffCountFreeze / TakeoffTabsFreeze /
// TakeoffPanelFreeze). The §2.2④ MIGRATION COMMIT (C3) will flip exactly this ONE function body
// and ZERO call sites:
//
//   PRE-migration (NOW):  takeoff lives in viewerStore → useViewerStore.setState({ ... })
//   POST-migration:       takeoff lives in the TanStack Query cache → two setQueryData writes
//                         under queryKeys.takeoff.items/groups(publicId), mirroring the
//                         production seedTakeoffCache (TAKEOFF_IMPL/SPEC.md §2.6).
//
// `qc` is UNUSED pre-migration but pinned in the signature NOW so the C3 flip touches only the
// body (the post-form needs the QueryClient; seedSummaries precedent takes it first).
// Call AFTER setting `publicId` in the store: the post-form cache keys derive from it — every
// call site's beforeEach satisfies this (qto SPEC §6.1 precedent).
// Both collection args are REQUIRED, no defaults (SPEC §6.1) — a future third key can't hide
// behind the signature, and call sites stay explicit about the two-key domain shape.

import type { QueryClient } from "@tanstack/react-query";
import { useViewerStore } from "@/stores/viewerStore";
import type { ClientTakeoffItem, TakeoffGroup } from "@/types";

export function seedTakeoff(
  qc: QueryClient,
  items: ClientTakeoffItem[],
  groups: TakeoffGroup[],
): void {
  void qc; // pre-form only: reserved for the C3 cache flip (see header)
  useViewerStore.setState({ takeoffItems: items, takeoffGroups: groups });
}
