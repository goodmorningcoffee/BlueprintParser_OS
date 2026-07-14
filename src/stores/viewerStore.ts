import { create } from "zustand";

interface ViewerState {
  // [refactor jul14 P2.5] This <100-line fail-closed compatibility sentinel is intentionally
  // retained after Query assumed both project catalogs and uiStore assumed active QTO. No live
  // component selects it; legacy topology/tests pin the shell until its owning phase removes it.

  // [refactor jul10 P2.2⑤] annotation groups + the M:N membership indexes moved to the
  // TanStack Query cache — see src/queries/useAnnotationGroups.ts (ONE key holds the raw
  // {groups, memberships} payload; the forward/reverse Set indexes are derived in-hook).
  // The old fields (annotationGroups / annotationGroupMemberships / groupMembers) and their
  // 6 actions are DELETED, not bridged; 4 of the 9 selector members were dead surface (E7).

  // [refactor jul11 P2.3] Project identity, demo policy, page labels, and labeling-session state
  // live in sessionStore; the csiGraph bootstrap value is Query-owned by useCsiGraph. Do not add
  // project/session, server, UI, or drawing data back to this inert compatibility sentinel.

  // [refactor jul11 P2.2⑦/⑧ + jul14 P2.5] Active page-window maps, per-page Textract OCR,
  // and project catalogs are Query-owned. The two fields below are inert compatibility sentinels.
  allTrades: string[];
  setAllTrades: (trades: string[]) => void;

  // ─── CSI project metadata ─────────────────────────────────
  allCsiCodes: { code: string; description: string }[];
  setAllCsiCodes: (codes: { code: string; description: string }[]) => void;

  // ─── Reset ─────────────────────────────────────────────
  /** Inert-shell reset; production project opens call viewerCommands.resetProjectData. */
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

  resetViewerState: () =>
    set({
      // [refactor jul11 P2.2⑥] annotations reset deleted: openProject seeds the publicId-keyed
      // cache before activation; the coordinator's preceding session reset re-keys observers.
      // [refactor jul11 P2.3] session identity/page-label fields and csiGraph are reset by the
      // neutral viewerCommands.resetProjectData coordinator, not this leaf store.
      // [refactor jul10 P2.2③] `summaries: null` reset line deleted — summaries live in the query
      // cache now (publicId-keyed entries give free cross-project isolation; the old key's entry
      // persists but is unobservable: openProject resets session identity first, and route content
      // stays behind its loading gate until the fresh lifecycle seed and activation land).
      allTrades: [],
      allCsiCodes: [],
      // qtoWorkflows: Query-backed since P2.2②; openProject owns exact cancellation/empty seeding.
      // The active pointer is uiStore-owned and clears earlier in the coordinated project reset.
      // Parse lifetime is coordinated immediately before this inert-shell reset.
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

/** Inert compatibility selector; live catalog readers use queries/useProjectCatalogs. */
export const usePageData = () =>
  useViewerStore(useShallow((s) => ({
    allCsiCodes: s.allCsiCodes,
  })));

// [refactor jul11 P2.2⑦] useSummaries remains a cache-only compatibility name in
// src/queries/useSummaries.ts. Its temporary loaded-range/loading passthrough was removed with the
// legacy window fields; consumers needing range or status use the page-window facade/controller.
