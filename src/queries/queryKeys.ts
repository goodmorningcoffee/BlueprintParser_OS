// [refactor jul14 P2] Query-key factory for the live Query-owned domains and project catalogs.
//
// ONE hierarchical, typed home for every TanStack Query key, so invalidation scopes are
// grep-able and no component hand-rolls a key string. All nine P2.2 domains use these factories;
// the project lifecycle also owns the project-catalog key and project-wide cache teardown.
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
  // P2.5 bootstrap-owned project-wide trade and CSI filter catalogs.
  projectCatalogs: {
    all: (publicId: string) => ["project", publicId, "projectCatalogs"] as const,
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
  // ⑥ annotations — ONE flat chunk-windowed key (not per-page); optimistic temp reconciliation.
  annotations: {
    all: (publicId: string) => ["project", publicId, "annotations"] as const,
  },
  // ⑦ pagesWindow (replaces useChunkLoader internals — SAME ±7/buffer/debounce)
  pagesWindow: {
    all: (publicId: string) => ["project", publicId, "pagesWindow"] as const,
    active: (publicId: string) =>
      ["project", publicId, "pagesWindow", "active"] as const,
  },
  // ⑧ Textract — one heavy payload per project/page. A QueryClient coordinator enforces both a
  // 12-page LRU and an 8 MiB serialized-size rail; PageSidebar is the sole passive map exception.
  textract: {
    all: (publicId: string) => ["project", publicId, "textract"] as const,
    page: (publicId: string, pageNumber: number) =>
      ["project", publicId, "textract", pageNumber] as const,
  },
  // ⑨ yoloTags (PUT debounce → debounced mutation; _debounceSaveYoloTags dies)
  yoloTags: {
    all: (publicId: string) => ["project", publicId, "yoloTags"] as const,
  },
  // P2.3 session carve: the only live consumer of the residual projectIntelligence blob needs
  // csiGraph alone. Keep it separate so summaries/yoloTags are not silently duplicated here.
  csiGraph: {
    all: (publicId: string) => ["project", publicId, "csiGraph"] as const,
  },
  // [graph T8 2026-10-24] knowledge-graph reference index, GET /api/projects/[id]/graph once per open.
  projectGraph: {
    index: (publicId: string) => ["project", publicId, "knowledgeGraph", "index"] as const,
    // [cross-set F3 2026-10-24] GET /api/projects/[id]/cross-set (every page, names resolved server-side).
    crossSet: (publicId: string) => ["project", publicId, "knowledgeGraph", "crossSet"] as const,
  },
  // [bucketfill P2] pageGeometry — extracted PDF vector linework, one entry per project/page.
  // Derived locally from the open pdf.js document (see lib/pdf-document-registry.ts), never
  // fetched, so it has no transport policy at all; a QueryClient coordinator enforces a 4-page
  // LRU and a 24 MiB rail. Same page-number-LAST convention as ⑧ so project teardown can remove
  // the whole domain by prefix.
  pageGeometry: {
    all: (publicId: string) => ["project", publicId, "pageGeometry"] as const,
    page: (publicId: string, pageNumber: number) =>
      ["project", publicId, "pageGeometry", pageNumber] as const,
  },
} as const;

export type QueryKeys = typeof queryKeys;
