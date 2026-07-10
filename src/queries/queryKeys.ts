// [refactor jul8 P2.1] Query-key factory for the P2 state split (plan 03 §2.1-2.2).
//
// ONE hierarchical, typed home for every TanStack Query key, so invalidation scopes are
// grep-able and no component hand-rolls a key string. Introduced EMPTY of consumers —
// P2.1 is zero-behavior; each P2.2 domain migration (①→⑨, blast-radius order below)
// starts using its factory as the viewerStore field becomes a facade over the cache.
//
// Conventions (locked here so ①-⑨ stay uniform):
//   • Everything project-scoped nests under ["project", publicId] — one invalidation
//     boundary per project, matching openProject/reset semantics (plan 03 §2.5).
//   • publicId (uuid string) is THE id at this boundary, never the numeric DB id
//     (mirrors the API-boundary invariant).
//   • Factories return `as const` tuples — structural typing keeps keys comparable and
//     exhaustive-checkable; no string concatenation anywhere.
//   • Per-page keys take the pageNumber LAST so partial matching invalidates whole
//     domains: invalidateQueries({queryKey: keys.textract.all(publicId)}).

export const queryKeys = {
  project: (publicId: string) => ["project", publicId] as const,

  // ① chatMessages — first migration (1 consumer panel, smallest blast radius)
  chatMessages: {
    all: (publicId: string) => ["project", publicId, "chatMessages"] as const,
  },
  // ② qtoWorkflows
  qtoWorkflows: {
    all: (publicId: string) => ["project", publicId, "qtoWorkflows"] as const,
    detail: (publicId: string, workflowId: number) =>
      ["project", publicId, "qtoWorkflows", workflowId] as const,
  },
  // ③ summaries (project summaries / chunking indexes)
  summaries: {
    all: (publicId: string) => ["project", publicId, "summaries"] as const,
  },
  // ④ takeoff items + groups — SPLIT write ordering preserved (server-first creates/item-mutations,
  // optimistic group-ops), NO rollback; see TAKEOFF_IMPL/SPEC.md §3 + takeoff freeze suite before touching.
  takeoff: {
    items: (publicId: string) => ["project", publicId, "takeoff", "items"] as const,
    groups: (publicId: string) => ["project", publicId, "takeoff", "groups"] as const,
  },
  // ⑤ annotationGroups + memberships — ONE key, raw {groups, memberships} payload; the Set
  // indexes are derived in-hook via useMemo on the memberships sub-reference, NOT `select`
  // (Sets are opaque to structural sharing — ANNGROUPS_IMPL/SPEC.md verdict 4).
  // ⚠️ INVALIDATION TRIPWIRE (DETECTOR jul10): a project-wide invalidateQueries prefix-matches
  // this key and WILL refetch it through the always-mounted GroupActionsBar observer
  // (PDFViewer.tsx:538; hooks run before the count<2 null-return), reopening the E8
  // optimistic-toggle race — exclude this key or extend the freeze first.
  annotationGroups: {
    all: (publicId: string) => ["project", publicId, "annotationGroups"] as const,
  },
  // ⑥ annotations — THE big one (optimistic tempId reconciliation; canvas selector hooks)
  annotations: {
    all: (publicId: string) => ["project", publicId, "annotations"] as const,
    page: (publicId: string, pageNumber: number) =>
      ["project", publicId, "annotations", pageNumber] as const,
  },
  // ⑦ pagesWindow (replaces useChunkLoader internals — SAME ±7/buffer/debounce)
  pagesWindow: {
    window: (publicId: string, center: number) =>
      ["project", publicId, "pagesWindow", center] as const,
    all: (publicId: string) => ["project", publicId, "pagesWindow"] as const,
  },
  // ⑧ textract per-page (LRU cap kills the unbounded growth)
  textract: {
    all: (publicId: string) => ["project", publicId, "textract"] as const,
    page: (publicId: string, pageNumber: number) =>
      ["project", publicId, "textract", pageNumber] as const,
  },
  // ⑨ yoloTags (PUT debounce → debounced mutation; _debounceSaveYoloTags dies)
  yoloTags: {
    all: (publicId: string) => ["project", publicId, "yoloTags"] as const,
  },
} as const;

export type QueryKeys = typeof queryKeys;
