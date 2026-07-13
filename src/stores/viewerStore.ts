import { create } from "zustand";
import type { QtoWorkflow } from "@/types";

interface ViewerState {
  // [refactor jul10 P2.2⑤] annotation groups + the M:N membership indexes moved to the
  // TanStack Query cache — see src/queries/useAnnotationGroups.ts (ONE key holds the raw
  // {groups, memberships} payload; the forward/reverse Set indexes are derived in-hook).
  // The old fields (annotationGroups / annotationGroupMemberships / groupMembers) and their
  // 6 actions are DELETED, not bridged; 4 of the 9 selector members were dead surface (E7).

  // [refactor jul11 P2.3] Project identity, demo policy, page labels, and labeling-session state
  // live in sessionStore. The residual csiGraph bootstrap value lives in useCsiGraph. Do not add
  // project/session or drawing data back to this residual metadata/draft store.

  // [refactor jul11 P2.2⑦/⑧] Active page-window maps and per-page Textract OCR are query-owned.
  // Only project-wide bootstrap metadata from those former server-data slices remains here.
  allTrades: string[];
  setAllTrades: (trades: string[]) => void;

  // ─── CSI project metadata ─────────────────────────────────
  allCsiCodes: { code: string; description: string }[];
  setAllCsiCodes: (codes: { code: string; description: string }[]) => void;

  // ─── Auto-QTO ────────────────────────────────────────────
  // [refactor jul10 P2.2②] qtoWorkflows COLLECTION moved to the TanStack cache
  // (src/queries/useQtoWorkflows.ts). The active pointer stays here: it is a UI-selection /
  // in-progress draft, not a server collection (P2_DESIGN/QTO_IMPL/SPEC.md §3).
  activeQtoWorkflow: QtoWorkflow | null;
  setActiveQtoWorkflow: (w: QtoWorkflow | null) => void;

  // ─── Reset ─────────────────────────────────────────────
  /** Remaining metadata reset. Call resetProjectData from viewerCommands. */
  resetViewerState: () => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  // [refactor jul10 P2.2⑤] annotationGroups init + 6 actions (setAnnotationGroups,
  // upsertAnnotationGroup, removeAnnotationGroupLocal, hydrateGroupMemberships,
  // addAnnotationToGroup, removeAnnotationFromGroup) and the two index inits moved/deleted →
  // src/queries/useAnnotationGroups.ts. upsertAnnotationGroup + the hydrate index-rebuild loop
  // were ported VERBATIM (facade upsert / deriveGroupIndexes); the other four were dead surface
  // (grep-verified zero external callers — the loader's setAnnotationGroups call became the
  // cache seed). NOTE the former monolithic reset never cleared these fields — that omission was
  // the old cross-project stale-retention bug; publicId-keyed cache entries eliminate the class
  // (SPEC §5-E3), so do NOT add group lines to resetViewerState.

  allTrades: [],
  setAllTrades: (allTrades) => set({ allTrades }),

  allCsiCodes: [],
  setAllCsiCodes: (allCsiCodes) => set({ allCsiCodes }),

  // ─── Auto-QTO ──────────────────────────────────────────── (collection → query cache, P2.2②)
  activeQtoWorkflow: null,
  setActiveQtoWorkflow: (activeQtoWorkflow) => set({ activeQtoWorkflow }),

  resetViewerState: () =>
    set({
      // [refactor jul11 P2.2⑥] annotations reset deleted: loader seeds the publicId-keyed cache
      // unconditionally before reveal; the coordinator's preceding session reset re-keys observers.
      // [refactor jul11 P2.3] session identity/page-label fields and csiGraph are reset by the
      // neutral viewerCommands.resetProjectData coordinator, not this leaf store.
      // [refactor jul10 P2.2③] `summaries: null` reset line deleted — summaries live in the query
      // cache now (publicId-keyed entries give free cross-project isolation; the old key's entry
      // persists but is unobservable: resetProjectData resets session identity first, and consumers
      // are unmounted behind the loaders' `loading` gates until the fresh seed lands).
      allTrades: [],
      allCsiCodes: [],
      activeQtoWorkflow: null,
      // qtoWorkflows: cache-backed since P2.2② — reset deliberately does NOT touch the query
      // cache (RECIPE step 7; publicId-keyed isolation makes it unnecessary, SPEC §7).
      // Parse lifetime is coordinated immediately before this residual reset.
    }),
}));

// ═══════════════════════════════════════════════════════════════════
// Typed Slice Selectors
// ═══════════════════════════════════════════════════════════════════
//
// Tool state lives in toolStore, parse state in parseFlowStore, page/zoom/dimensions in
// viewerCoreStore, and presentation in uiStore.
//
// Per REFACTORING_RESEARCH.md Part 1: "Store Slices + Bridge"

import { useShallow } from "zustand/react/shallow";

// [refactor jul10 P2.2⑤] useAnnotationGroups selector DELETED — the facade now lives in
// src/queries/useAnnotationGroups.ts (same name, 5-member live shape; the 4 dead members
// dropped per SPEC §5-E7). Consumers changed only their import line.

// [refactor jul11 P2.4 S2] useTableParse/useKeynoteParse now live only in parseFlowStore.

/** Project-wide CSI catalog. Its active display filter lives in uiStore. */
export const usePageData = () =>
  useViewerStore(useShallow((s) => ({
    allCsiCodes: s.allCsiCodes,
  })));

// [refactor jul10 P2.2②] useQtoWorkflow selector DELETED — its sole consumer (AutoQtoTab) now
// uses the cache facade src/queries/useQtoWorkflows.ts, which also surfaces the zustand-resident
// activeQtoWorkflow pair. (Unlike chat's useChat, no second caller kept a slice alive.)

// [refactor jul11 P2.2⑦] useSummaries remains a cache-only compatibility name in
// src/queries/useSummaries.ts. Its temporary loaded-range/loading passthrough was removed with the
// legacy window fields; consumers needing range or status use the page-window facade/controller.
