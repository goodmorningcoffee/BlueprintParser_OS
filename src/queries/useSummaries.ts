"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"; // v5.101 installed
import { useShallow } from "zustand/react/shallow";
import { useViewerStore } from "@/stores/viewerStore";
import { queryKeys } from "@/queries/queryKeys";
import type { ProjectSummaries } from "@/types";

// [refactor jul10 P2.2③] summaries: zustand viewerStore -> TanStack Query cache (variant a,
// bootstrap-seeded — P2_DESIGN/SUMMARIES_IMPL/SPEC.md is authoritative). There is NO GET endpoint
// for summaries: the server flattens projectIntelligence.summaries to a TOP-LEVEL `summaries` key
// on both project responses (services/projects.ts:140→:152 authed, :245→:267 demo) and the two
// loaders seed the cache from it. NOTE: RECIPE.md step 4's "③ seeds from
// data.projectIntelligence.summaries" is WRONG for ③ — erratum filed in SPEC §8 + RECIPE.
//
// Three exports:
//   • seedSummariesCache — the ONE write helper for all 8 production seed sites (2 loaders
//     unconditional, 6 promote-refreshers guarded — see the two-semantics note below).
//   • useSummariesData   — narrow cache-only read { summaries, setSummaries }. For SpecIndex /
//     NotesIndex, which previously subscribed to ONLY s.summaries via a raw selector: giving them
//     the full facade would ADD chunkLoading-flip re-renders they never had (chunkLoading toggles
//     on every chunk fetch; PDF-viewer perf is sacred).
//   • useSummaries       — full 6-field facade, byte-compatible with the deleted viewerStore
//     selector (summaries/setSummaries from the cache + loadedPageRange/setLoadedPageRange/
//     chunkLoading/setChunkLoading passthrough from zustand). Chunk-loader state is domain ⑦'s
//     migration surface and STAYS zustand until then.

// [refactor jul10 P2.2③] Loader/refresher seed of the summaries cache.
//
// TWO write semantics share this helper — the single most implementation-trapping detail (SPEC §2):
//   • LOADERS call it UNCONDITIONALLY with `data.summaries` (may be null/undefined). The `?? null`
//     is LOAD-BEARING: RQ v5 setQueryData(key, undefined) is a silent NO-OP (query-core:
//     `if (data === void 0) return`), so without the coercion an omitted-summaries load response
//     would silently RETAIN the previous visit's cache entry — the exact stale bug the old
//     reset-then-conditional-set flow prevented. Same rationale as seedChatCache.
//   • REFRESHERS (the 6 promote sites) call it inside their KEPT `if (result.summaries)` guards:
//     the promote API returns `summaries: null` on real paths (compute-reject swallow, pinned by
//     regions-promote.route.test.ts) and an unconditional write there would CLEAR live panel data
//     on a server recompute hiccup. Do NOT "simplify" the guards away.
//
// `publicId` is an explicit param (never read from the store here): refreshers must seed under the
// SAME publicId the promote request used — a mid-await project switch would otherwise leak project
// A's recomputed summaries into project B's cache entry (SPEC §5-S3, qto-S6 precedent). Loaders
// pass `data.id` (the fresh project's publicId).
export function seedSummariesCache(
  qc: QueryClient,
  publicId: string,
  summaries: ProjectSummaries | null | undefined,
): void {
  qc.setQueryData(queryKeys.summaries.all(publicId), summaries ?? null);
}

// [refactor jul10 P2.2③] Narrow cache-backed read: the exact { summaries, setSummaries } pair the
// store held. Render-captured publicId is correct for READS: on project switch resetProjectData
// sets publicId:"" — subscribers re-key to a fresh null-initialData entry, and all consumers are
// unmounted behind the loaders' `loading` gates anyway (seed-before-reveal, SPEC §5-S5).
export function useSummariesData(): {
  summaries: ProjectSummaries | null;
  setSummaries: (s: ProjectSummaries | null) => void;
} {
  const publicId = useViewerStore((s) => s.publicId);
  const qc = useQueryClient();
  const key = queryKeys.summaries.all(publicId); // ["project", publicId, "summaries"]

  const { data } = useQuery({
    queryKey: key,
    // THROWING queryFn (chat-verbatim): on a no-GET domain any refetch that reaches the queryFn is
    // a BUG — fail LOUD rather than silently rewriting the cache. Never fires in practice:
    // enabled:false + non-undefined initialData.
    queryFn: (): ProjectSummaries | null => {
      throw new Error(
        "summaries is bootstrap-seeded (no GET endpoint); queryFn must never run",
      );
    },
    enabled: false, // sole sources are the 8 seed sites; no refetch path can clobber a seed
    // The cast is REQUIRED: bare `initialData: null` with a throwing queryFn infers
    // TQueryFnData = null, typing `data` as `null` and compile-breaking every `summaries?.x`
    // consumer (analog of chat's `[] as ChatMsg[]`). v5: any non-undefined initialData ->
    // status:'success', data === null, no refetch pressure; initialData applies only at query
    // construction, so a pre-mount loader seed is never clobbered by a later observer.
    initialData: null as ProjectSummaries | null,
    staleTime: Infinity, // no queryFn to go stale against; defensive pin (root QueryClient has no defaultOptions)
    // gcTime:Infinity — FAITHFULNESS + CHEAPNESS, *not* chat's "unrecoverable" rationale: zustand
    // held summaries all session; the payload is KB-scale; refresher-written summaries are
    // server-persisted and the loader unconditionally re-seeds on re-entry, so a GC'd entry WOULD
    // be recoverable. Kept Infinity purely to match the old always-resident field. ④–⑨: do not
    // cargo-cult "unrecoverable" here onto domains where it's false; heavy per-page domains
    // (⑥⑦⑧) use finite gcTime + LRU per the recipe.
    gcTime: Infinity,
  });

  // Facade parity with the deleted store action `setSummaries(s: ProjectSummaries | null)`
  // (loaders/tests pass null-shaped values; the type must keep accepting null). Plain
  // value-replace == the old `set({ summaries })`; zero read-modify-write callers exist.
  const setSummaries = useCallback(
    (next: ProjectSummaries | null) => qc.setQueryData(key, next),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );

  // data can never be undefined given initialData; `?? null` keeps the type honest.
  return { summaries: data ?? null, setSummaries };
}

// [refactor jul10 P2.2③] Full 6-field facade — returns the exact shape of the deleted viewerStore
// useSummaries selector so the 5 hook consumers (TableParsePanel, KeynotePanel, ViewerToolbar,
// AutoQtoTab, PageSidebar) change only their import line. The chunk-loader quartet stays a zustand
// useShallow passthrough (domain ⑦; reset lines + loader chunk-continuation writes untouched).
// Re-render parity: these 5 callers already subscribed to all 6 fields via useShallow, so keeping
// the chunk fields here preserves their existing re-render cadence exactly.
export function useSummaries() {
  const chunk = useViewerStore(
    useShallow((s) => ({
      loadedPageRange: s.loadedPageRange,
      setLoadedPageRange: s.setLoadedPageRange,
      chunkLoading: s.chunkLoading,
      setChunkLoading: s.setChunkLoading,
    })),
  );
  return { ...useSummariesData(), ...chunk };
}
