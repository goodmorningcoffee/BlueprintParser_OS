"use client";

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/sessionStore";
import { queryKeys } from "@/queries/queryKeys";
import type { AnnotationGroup, AnnotationGroupMembership } from "@/types";

// [refactor jul10 P2.2⑤] ANNOTATION-GROUPS domain: zustand viewerStore → TanStack Query cache
// (variant b, EAGER-LOADER-SEEDED — P2_DESIGN/ANNGROUPS_IMPL/SPEC.md is authoritative).
//
// ONE cache key (queryKeys.annotationGroups.all(publicId)) holds the RAW server payload
// {groups, memberships}; the M:N Set indexes (annotationGroupMemberships / groupMembers) are
// derived DOWNSTREAM in the hook via useMemo on the memberships sub-reference — Sets never
// enter the cache (SPEC §3.2). Facade parity: the 5-member return shape matches what the three
// consumers (GroupActionsBar / ViewAllPanel / useMultiSelectInteraction) destructured from the
// old zustand selector, so migration was import-swap-only. The old selector's other 4 members
// (setAnnotationGroups / removeAnnotationGroupLocal / addAnnotationToGroup /
// removeAnnotationFromGroup) were DEAD — grep-verified zero external callers — and are dropped
// (SPEC §5-E7), not ported.
//
// CANVAS-SACRED adjacency (SPEC §7.3): useMultiSelectInteraction's sole importer is
// AnnotationOverlay, whose draw effect re-runs on EVERY render (its `multiSelect` dep is a fresh
// literal per render — frozen as-is, §8.2). The sacred invariant is therefore ZERO ADDED RENDERS
// = notification parity. Enforced here by construction:
//   • destructure ONLY `data` from useQuery (v5 tracked props — no isFetching/status/
//     dataUpdatedAt subscriptions, so fetch-status transitions can never notify);
//   • per-key observers — unrelated-key writes never notify group readers;
//   • sub-reference-memoized index derivation (below) keeps identity churn ≤ the old
//     three-independent-zustand-fields world;
//   • the config quartet below guarantees ZERO background fetches, ever (E5/E8).
//
// staleTime: Infinity — NOT the qto precedent's 0 (SPEC verdict 1). qto's staleTime:0 encoded
// qto's OLD fetch-on-every-mount effect; groups' old behavior is fetch-ONCE-per-open (the loader
// Promise.all GET). Under staleTime 0 the eager seed stamps dataUpdatedAt and every observer
// mount (reveal, each ViewAllPanel toggle) plus focus/reconnect would fire uncharacterized GETs,
// one racing the optimistic-toggle window. Infinity = exactly-one-GET-per-open for any session
// length. Any finite T reintroduces panel-toggle refetches after T.
//
// ⚠️ initialData × option-(a) COUPLING (SPEC §2.2): initialData counts as FRESH
// (dataUpdatedAt=now); combined with staleTime ∞ this query would NEVER fetch on its own — safe
// ONLY because the loader's unconditional seedAnnotationGroupsCache is the source of truth
// (eager fetch stays in the loader's Promise.all, keeping network errors FATAL like today).
// Do not flip to observer-fetch (option b) without flipping these fields.
//
// FUNCTIONAL-UPDATER MANDATE (SPEC verdict 5): both writes merge into the live entry via
// `(old) => ({...(old ?? EMPTY_PAYLOAD), …})`. The create flow calls upsertAnnotationGroup then
// hydrateGroupMemberships on the SAME entry in one sync block (GroupActionsBar create handler);
// a value-replace hydrate would overwrite with a pre-POST snapshot and silently DELETE the
// just-upserted group — no picker entry, no color ring, no canvas outline.
//
// Do NOT set structuralSharing:false (a reflexive move for Set-bearing caches): default sharing
// is load-bearing twice — byte-identical reseed dedup at the raw level (E4: a poll returning
// unchanged data notifies NOBODY) and untouched-half sub-reference preservation (§3.2). Sets
// never enter the CACHE, so the dev not-JSON-serializable warning path is moot.
//
// ⚠️ GROUPS-W1 TRIPWIRE (deferred, ④-style; SPEC §5 tail): tier-2 useMutation unification
// (rollback+reconcile, bulk response adoption, unified error channels) is a FUTURE owner-signed
// pass. Until then both actions are plain synchronous setQueryData closures at the old store-
// action granularity and every call site keeps its verbatim ordering — the freeze suites
// (GroupActionsBarFreeze / ViewAllPanelGroupsFreeze) fail loudly on conversion. Do NOT convert
// call sites opportunistically.
//
// ⚠️ DEMO TRIPWIRE (SPEC §7.1): demo write-inertness is TWO-mechanism — canPersist guards on 3
// sites (GAB create/add/mass-delete) + EMERGENT-empty on 4 unguarded PUT sites (GAB-edit,
// VAP-edit/toggle/bulk). If a future demo group seed ever appears, those four sites fire real
// PUTs (server rejects them — resolveProjectOrThrow without allowDemo — but client noise +
// error dialogs would be new demo behavior). Keep demo groups empty: enabled gate below +
// zero-diff demo loader + empty initialData.

/** Raw cache-entry shape — the annotation-groups GET response, verbatim (no client mapper). */
export type AnnotationGroupsPayload = {
  groups: AnnotationGroup[];
  memberships: AnnotationGroupMembership[];
};

// MODULE-SCOPE frozen constant (SPEC §2.2): a fresh `?? {…}` per render would reintroduce
// identity churn in demo/empty mode (every render would hand consumers new array references).
// Frozen so an accidental in-place mutation of the shared default throws in strict mode; all
// legitimate writes SPREAD it, never mutate.
const EMPTY_PAYLOAD: AnnotationGroupsPayload = Object.freeze({
  groups: Object.freeze([]) as unknown as AnnotationGroup[],
  memberships: Object.freeze([]) as unknown as AnnotationGroupMembership[],
});

// [refactor jul10 P2.2⑤] The old store's hydrateGroupMemberships index rebuild, VERBATIM
// (deleted viewerStore.ts:792-803): pairs → forward index (annotationId → Set<groupId>, powers
// membership lookups) + reverse index (groupId → Set<annotationId>, powers O(1) click-highlight
// sibling union without scanning memberships). Set insertion order follows pairs order —
// first-group-wins outline color depends on it (within-session only; the memberships GET has no
// server orderBy, SPEC §8.5 — pre-existing, do not "fix" here).
// EXPORTED for unit pins (SPEC §6.4): the round-trip flatten→derive order-preservation proof
// lives in the hook suite.
export function deriveGroupIndexes(pairs: AnnotationGroupMembership[]): {
  annotationGroupMemberships: Record<number, Set<number>>;
  groupMembers: Record<number, Set<number>>;
} {
  const memberships: Record<number, Set<number>> = {};
  const reverse: Record<number, Set<number>> = {};
  for (const { annotationId, groupId } of pairs) {
    if (!memberships[annotationId]) memberships[annotationId] = new Set();
    memberships[annotationId].add(groupId);
    if (!reverse[groupId]) reverse[groupId] = new Set();
    reverse[groupId].add(annotationId);
  }
  return { annotationGroupMemberships: memberships, groupMembers: reverse };
}

// [refactor jul10 P2.2⑤] Loader-side seed — the ONE production write helper for full-payload
// hydration (dashboard loader; the demo loader deliberately never calls it — demo stays empty).
//
// UNCONDITIONAL + ATOMIC both-fields (SPEC §2.3): the loader calls this even when the groups GET
// returned non-ok/unparseable (payload null). A conditional skip would leave a stale-or-ABSENT
// entry — absent + a real queryFn = a post-reveal recovery GET the old app never did (designed
// out, ③/④ D3 doctrine). The atomic both-fields replace also removes the old per-field
// conditional's theoretical partial-stale tear (sanctioned micro-tightening, SPEC §5-E3d).
// Behavior deltas vs the old retain-on-fail store writes are the pinned E3 ledger rows:
// cross-project and real→demo stale-retention leaks ELIMINATED (resetProjectData never cleared
// the 3 group fields — that omission was the old bug); SAME-project failed-reload now CLEARS
// previously-visible groups (E3c — deliberate, regression-shaped, owner-sanctioned).
//
// `publicId` is an explicit param — loaders pass `data.id` (server-canonical, like the sibling
// chat/summaries/takeoff seeds), NEVER the user-controlled route param. Call after
// setState({publicId}); seed-before-reveal (before setLoading(false)) is the invariant that
// keeps groups painted at first reveal with no pop-in (SPEC §2.1 — NOT "same synchronous block":
// this seed legitimately sits after an await on the sibling groups response).
export function seedAnnotationGroupsCache(
  qc: QueryClient,
  publicId: string,
  payload: {
    groups?: AnnotationGroup[] | null;
    memberships?: AnnotationGroupMembership[] | null;
  } | null | undefined,
): void {
  // Always a defined object — setQueryData(key, undefined) would be a silent no-op (v5 trap).
  qc.setQueryData<AnnotationGroupsPayload>(queryKeys.annotationGroups.all(publicId), {
    groups: payload?.groups ?? [],
    memberships: payload?.memberships ?? [],
  });
}

// [DETECTOR jul10 closer M8/M11] The dashboard loader's groups-seed tail, extracted VERBATIM
// from page.tsx (④'s seedTakeoffFromBootstrap precedent, d2229a3): ok-gate → parse-or-null →
// UNCONDITIONAL seed. A pure adapter over seedAnnotationGroupsCache so the response mapping and
// the publicId keying are unit-pinnable (the migrate-commit mutation pass showed the old inline
// pair was deletable/mis-keyable with a fully green suite). Contract = exactly what the loader
// line did: !ok short-circuits (json() is never called) → null; unparseable json → null; the
// seed helper's `?? []` turns null/omitted fields into empty halves — the entry is ALWAYS
// written, never skipped (E3 clear-on-fail semantics). The loader passes `data.id`
// (server-canonical), never the route param — the wrong-key pin guards that regression.
// `groupsRes` is typed structurally (ok + json) so tests need no real Response.
export async function seedAnnotationGroupsFromBootstrap(
  qc: QueryClient,
  publicId: string,
  groupsRes: { ok: boolean; json: () => Promise<unknown> },
): Promise<void> {
  const groupsData = groupsRes.ok
    ? ((await groupsRes.json().catch(() => null)) as {
        groups?: AnnotationGroup[] | null;
        memberships?: AnnotationGroupMembership[] | null;
      } | null)
    : null;
  seedAnnotationGroupsCache(qc, publicId, groupsData);
}

// [refactor jul10 P2.2⑤] The facade — 5-member live shape (deliberate narrowing of the old
// 9-member zustand selector; SPEC §3.1). Return object is a fresh literal per render, like the
// old useShallow result on change — all three consumers destructure immediately; nothing
// depends on wrapper identity.
export function useAnnotationGroups() {
  const publicId = useSessionStore((s) => s.publicId);
  const isDemo = useSessionStore((s) => s.isDemo);
  const qc = useQueryClient();
  const key = queryKeys.annotationGroups.all(publicId); // ["project", publicId, "annotationGroups"]

  // Destructure `data` ONLY — v5 tracked props make this the notification contract: adding any
  // fetch-status field here (isFetching/status/dataUpdatedAt/…) would subscribe the canvas-
  // adjacent readers to fetch-lifecycle notifications and break render parity (SPEC §1.3).
  const { data } = useQuery({
    // ⚠️ INVALIDATION TRIPWIRE (DETECTOR jul10): a project-wide invalidateQueries (any prefix of
    // ["project", publicId]) prefix-matches this key and WILL refetch it through the
    // always-mounted GroupActionsBar observer (PDFViewer.tsx:538; its hooks run before the
    // count<2 null-return), reopening the E8 optimistic-toggle race. That vector is closed
    // today ONLY by call-site absence (zero production invalidateQueries reach this key,
    // grep-pinned) plus the demo-side enabled gate — if you add a project-wide invalidation,
    // exclude this key or extend the freeze first. Same warning on the queryKeys.ts ⑤ row.
    queryKey: key,
    // Variant-b contract: the key stays honest (a real queryFn exists) but is DORMANT by
    // construction under option (a) — initialData marks the entry fresh, staleTime ∞ keeps it
    // fresh, and the loader seed overwrites it every load(). Hook suite pins fetchCount 0.
    // If it ever DID run: non-ok / unparseable → EMPTY_PAYLOAD, mirroring the old loader's
    // net "no groups this open" (the old code skipped the seed on !ok).
    queryFn: async ({ signal }): Promise<AnnotationGroupsPayload> => {
      const r = await fetch(`/api/annotation-groups?projectId=${publicId}`, { signal });
      if (!r.ok) return EMPTY_PAYLOAD;
      return ((await r.json().catch(() => null)) ?? EMPTY_PAYLOAD) as AnnotationGroupsPayload;
    },
    // DEFENSE-IN-DEPTH, not the active dormancy mechanism (DETECTOR jul10 reword — the old
    // "LOAD-BEARING TWICE" phrasing overclaimed; SPEC §7.1 erratum): under initialData +
    // staleTime ∞ this query never fetches AUTOMATICALLY even ungated, so the gate's real work
    // is (1) blocking INVALIDATION-driven refetches — invalidateQueries pierces staleTime but
    // flows through `enabled` (M10 pin in the hook suite) — and (2) config drift: any future
    // staleTime/initialData change would expose demo to the allowDemo-readable GET (DB rows old
    // demo never showed), and demo write-inertness for the four unguarded PUT sites depends on
    // demo groups staying EMPTY (SPEC §7.1). Gate-order safe: the demo loader sets isDemo:true
    // before publicId, so this never flickers true.
    enabled: !!publicId && !isDemo,
    // Matches the old zustand inits ([], {}, {} → derived-empty). See the header COUPLING note.
    initialData: EMPTY_PAYLOAD,
    // THE fix vs the qto precedent — see header. Exactly-one-GET-per-open.
    staleTime: Infinity,
    // v5 default, pinned EXPLICITLY (qto comment discipline): inert under staleTime ∞; defends
    // against a future global defaultOptions flipping mount behavior.
    refetchOnMount: true,
    // Behavior-invisible either way (GroupActionsBar keeps ≥1 observer alive all session —
    // unconditionally mounted in PDFViewer — and every open re-seeds); Infinity per takeoff/qto
    // precedent + KB scale. Retention remains domain-specific; ⑧ is the heavy per-page domain.
    gcTime: Infinity,
    // Old Promise.all fetch was single-attempt.
    retry: false,
    // The loader's loadedIdRef exists precisely to block focus re-loads; also closes the
    // focus-GET-races-optimistic-toggle window (SPEC §5-E8).
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Fire-and-fail parity if the queryFn ever runs (qto precedent); default 'online' would
    // PAUSE instead.
    networkMode: "always",
  });

  // initialData makes undefined unreachable; belt anyway (redundant-twin rule, qto §5).
  const raw = data ?? EMPTY_PAYLOAD;
  const annotationGroups = raw.groups;

  // useMemo on the raw MEMBERSHIPS SUB-REFERENCE — NOT `select` (SPEC verdict 4, the crux).
  // select-output memoization needs a stable select-fn reference AND replaceEqualDeep cannot
  // restore Set identities (Sets are opaque to structural sharing — it returns `b` for non-plain
  // objects), so under select every groups-only write (eye toggle/rename/edit) would hand
  // consumers fresh index identities the old three-independent-zustand-fields world never
  // produced. This shape reproduces the old independence EXACTLY (E6 identity profile, §3.2):
  //   • groups-only upsert → functional updater spreads {...old, groups} → memberships
  //     sub-reference PRESERVED → memo skips → Set indexes keep identity;
  //   • memberships-only hydrate → groups sub-reference preserved → annotationGroups identity
  //     unchanged; indexes re-derive once per mounted consumer (2-3×, never per-render);
  //   • unrelated-key writes / host rerenders → data reference unchanged → nothing recomputes.
  // Do NOT widen the dep to `raw`/`data` (groups writes would churn the indexes) and do NOT
  // inline the loop here (per-render fresh Sets) — both are E6-pinned failures.
  const indexes = useMemo(() => deriveGroupIndexes(raw.memberships), [raw.memberships]);

  // Both actions close over [qc, publicId] — captured-key semantics (E2): a write racing a
  // project switch lands under the OLD key, isolated by keying (the old store wrote the global
  // singleton — that leak class is eliminated). `key` derives from publicId; do NOT list it
  // (fresh array each render).

  // The old store upsert VERBATIM (deleted viewerStore.ts:761-768): findIndex append-or-replace.
  // Functional updater is MANDATORY — see header (create-flow upsert→hydrate same-entry pair).
  const upsertAnnotationGroup = useCallback(
    (group: AnnotationGroup) =>
      qc.setQueryData<AnnotationGroupsPayload>(key, (old) => {
        const base = old ?? EMPTY_PAYLOAD;
        const idx = base.groups.findIndex((g) => g.id === group.id);
        if (idx === -1) return { ...base, groups: [...base.groups, group] };
        const next = [...base.groups];
        next[idx] = group;
        return { ...base, groups: next };
      }),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );

  // Raw-pairs REPLACE (facade parity with the old hydrateGroupMemberships signature — call-site
  // bodies stayed byte-identical; SPEC §3.3 H3 adjudication: the callers' flatten-rebuild
  // round-trips through deriveGroupIndexes order-preserving, so port verbatim, no append API).
  // Stores RAW pairs; Sets exist only in the derived layer above.
  const hydrateGroupMemberships = useCallback(
    (pairs: AnnotationGroupMembership[]) =>
      qc.setQueryData<AnnotationGroupsPayload>(key, (old) => ({
        ...(old ?? EMPTY_PAYLOAD),
        memberships: pairs,
      })),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );

  return {
    annotationGroups,
    annotationGroupMemberships: indexes.annotationGroupMemberships,
    groupMembers: indexes.groupMembers,
    upsertAnnotationGroup,
    hydrateGroupMemberships,
  };
}
