"use client";

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"; // v5.101 installed
import { useSessionStore } from "@/stores/sessionStore";
import { queryKeys } from "@/queries/queryKeys";
import type { ProjectSummaries } from "@/types";

// [refactor jul10 P2.2③] summaries: zustand viewerStore -> TanStack Query cache (variant a,
// bootstrap-seeded — P2_DESIGN/SUMMARIES_IMPL/SPEC.md is authoritative). There is NO GET endpoint
// for summaries: the server flattens projectIntelligence.summaries to a TOP-LEVEL `summaries` key
// on both project responses (services/projects.ts:140→:152 authed, :245→:267 demo), and shared
// openProject seeds the cache from it. NOTE: RECIPE.md step 4's "③ seeds from
// data.projectIntelligence.summaries" is WRONG for ③ — erratum filed in SPEC §8 + RECIPE.
//
// Three exports:
//   • seedSummariesCache — the ONE write helper for all 3 production seed sites (openProject
//     unconditional, two ParsedRegion refresh paths guarded — see the two-semantics note below).
//   • useSummariesData   — narrow cache-only read { summaries, setSummaries }. SpecIndex and
//     NotesIndex use the explicit narrow name to document that they observe summaries only;
//     active page-window transport/range data does not compose into this cache hook.
//   • useSummaries       — compatibility name for cache-only summary readers. Its temporary
//     chunk-loader passthrough disappeared in P2.2⑦ when the active range moved to pagesWindow.

// [refactor jul10 P2.2③ + jul14 P2.5] Project-open/refresher seed of the summaries cache.
//
// TWO write semantics share this helper — the single most implementation-trapping detail (SPEC §2):
//   • OPENPROJECT calls it UNCONDITIONALLY with `data.summaries` (may be null/undefined). `?? null`
//     is LOAD-BEARING: RQ v5 setQueryData(key, undefined) is a silent NO-OP (query-core:
//     `if (data === void 0) return`), so without the coercion an omitted-summaries load response
//     would silently RETAIN the previous visit's cache entry — the exact stale bug the old
//     reset-then-conditional-set flow prevented. Same rationale as seedChatCache.
//   • REFRESHER (`queries/parsedRegions`) calls it inside the converged truthy-summaries guard:
//     the promote API returns `summaries: null` on real paths (compute-reject swallow, pinned by
//     regions-promote.route.test.ts) and an unconditional write there would CLEAR live panel data
//     on a server recompute hiccup. Do NOT "simplify" the command guard away.
//
// `publicId` is an explicit param (never read from the store here): the refresher must seed under the
// SAME captured publicId the promote request used — a mid-await project switch would otherwise
// leak project A's recomputed summaries into project B's cache entry (SPEC §5-S3, qto-S6
// precedent). openProject passes server-canonical `data.id`.
export function seedSummariesCache(
  qc: QueryClient,
  publicId: string,
  summaries: ProjectSummaries | null | undefined,
): void {
  qc.setQueryData(queryKeys.summaries.all(publicId), summaries ?? null);
}

// [refactor jul10 P2.2③] Narrow cache-backed read: the exact { summaries, setSummaries } pair the
// store held. Render-captured publicId is correct for READS: openProject resets publicId to "",
// re-keying subscribers to a null entry, while route content stays behind its loading gate until
// the lifecycle has seeded and activated the destination (SPEC §5-S5).
export function useSummariesData(): {
  summaries: ProjectSummaries | null;
  setSummaries: (s: ProjectSummaries | null) => void;
} {
  const publicId = useSessionStore((s) => s.publicId);
  const qc = useQueryClient();
  const key = useMemo(
    () => queryKeys.summaries.all(publicId),
    [publicId],
  ); // ["project", publicId, "summaries"]

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
    enabled: false, // sole sources are openProject + 2 refresh paths; no refetch can clobber a seed
    // The cast is REQUIRED: bare `initialData: null` with a throwing queryFn infers
    // TQueryFnData = null, typing `data` as `null` and compile-breaking every `summaries?.x`
    // consumer (analog of chat's `[] as ChatMsg[]`). v5: any non-undefined initialData ->
    // status:'success', data === null, no refetch pressure; initialData applies only at query
    // construction, so a pre-activation lifecycle seed is never clobbered by a later observer.
    initialData: null as ProjectSummaries | null,
    staleTime: Infinity, // no queryFn to go stale against; defensive pin (root QueryClient has no defaultOptions)
    // gcTime:Infinity — FAITHFULNESS + CHEAPNESS, *not* chat's "unrecoverable" rationale: zustand
    // held summaries all session; the payload is KB-scale; refresher-written summaries are
    // server-persisted and openProject unconditionally re-seeds on re-entry, so a GC'd entry WOULD
    // be recoverable. Kept Infinity purely to match the old always-resident field. ④–⑨: do not
    // cargo-cult "unrecoverable" here onto domains where it's false. ⑥ annotations and ⑦
    // pagesWindow each have one project key and deliberately use Infinity; ⑧ textract is the
    // genuinely per-page/heavy domain that needs a bounded retention policy.
    gcTime: Infinity,
  });

  // Facade parity with the deleted store action `setSummaries(s: ProjectSummaries | null)`
  // (the lifecycle/tests pass null-shaped values; the type must keep accepting null). Plain
  // value-replace == the old `set({ summaries })`; zero read-modify-write callers exist.
  const setSummaries = useCallback(
    (next: ProjectSummaries | null) => qc.setQueryData(key, next),
    [qc, key],
  );

  // data can never be undefined given initialData; `?? null` keeps the type honest.
  return { summaries: data ?? null, setSummaries };
}

// [refactor jul11 P2.2⑦] The compatibility facade is now deliberately cache-only. None of its
// consumers used the former range/loading quartet; keeping it would preserve a second ownership
// path after PageWindowLoaderController became authoritative.
export function useSummaries() {
  return useSummariesData();
}
