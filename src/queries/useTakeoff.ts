"use client";

import { useCallback } from "react";
import {
  useQuery,
  useQueryClient,
  notifyManager,
  type QueryClient,
} from "@tanstack/react-query"; // v5.101 installed
import { useSessionStore } from "@/stores/sessionStore";
import { queryKeys } from "@/queries/queryKeys";
import type { ClientTakeoffItem, TakeoffGroup } from "@/types";

// [refactor jul10 P2.2④] takeoff (items + groups): zustand viewerStore -> TanStack Query cache
// (variant a, bootstrap-seeded — P2_DESIGN/TAKEOFF_IMPL/SPEC.md is authoritative). There is NO
// client GET for takeoff: both collections arrive top-level in the project bootstrap payload
// (data.takeoffItems / data.takeoffGroups) and openProject seeds them via seedTakeoffCache.
// TWO cache keys, ONE domain: queryKeys.takeoff.items(publicId) + .groups(publicId).
//
// TWO HOOKS BY DESIGN; do NOT add a combined useTakeoff() export (SPEC §2.2). Items-only readers
// include AnnotationOverlay and DrawingPreviewLayer — both canvas-adjacent on the viewer-SACRED
// hot path — and there are ZERO groups-only readers, so a combined hook could only ever ADD
// group-write re-renders to the 4 items-only readers. RQ observers are per-queryKey with tracked
// props: a useTakeoffItems reader re-renders iff the items `data` reference changes, and
// setQueryData runs replaceEqualDeep structural sharing, so group-key writes never notify items
// observers. The split costs ~4 destructure lines in the dual-reader tabs and removes the
// foot-gun entirely. (Supersedes useSummaries.ts's narrow-vs-full rationale for this domain.)
//
// > **TAKEOFF-W1 (deferred, ②-style tripwire):** unifying takeoff writes onto tier-2
// > `useMutation` (rollback + reconcile, incl. adopting groups-PUT auto-CSI full-row responses)
// > is a FUTURE sanctioned pass requiring owner sign-off on visible semantics changes
// > (server-then-store creates would become optimistic; optimistic ops would gain rollback;
// > alert-and-keep error UX would change; auto-CSI would newly surface in the UI). Until then
// > facade actions are plain synchronous setQueryData closures at today's store-action
// > granularity and every call site keeps its verbatim ordering — do NOT convert call sites
// > opportunistically. Ordering-pin coverage is PER-CONSUMER, not global (mutation-tested,
// > DETECTOR wf_5d3c6afd-bf0 — an earlier version of this comment falsely claimed the TC pins
// > catch ANY call-site conversion): CountTab is pinned deep by TC-1..TC-11 and BucketFill's
// > server-first create by BF-3; AreaTab/LinearTab conversions were TEST-INVISIBLE to those
// > (mutations M6/M9 stayed green — the TC cases never mount those tabs) and are now pinned by
// > TA-2/TL-1 (server-first creates), TA-4/TL-3 (demo-guards) and TA-5/TL-4 (optimistic
// > rename-group canaries) in TakeoffTabsFreeze; TakeoffPanel's W9 debounce by TP-1/TP-2.
// > Converting a call site fails loudly only in ITS OWN consumer's cases — do not assume TC
// > coverage extends beyond CountTab. (SPEC §3.4 + §9 errata appendix)

// [refactor jul10 P2.2④ + jul14 P2.5] Project-open seed of BOTH takeoff cache entries — the ONE
// production write helper for full-collection hydration in the shared auth/demo lifecycle. The old
// store setters setTakeoffItems/setTakeoffGroups were DELETED, not ported: their former loader
// calls converged here, and porting them would create an untested whole-collection write path
// bypassing this helper's `?? []` guard.
//
// `?? []` is LOAD-BEARING: RQ v5 setQueryData(key, undefined) is a silent NO-OP (query-core:
// `if (data === void 0) return`), so without the coercion an omitted field (demo responses omit
// takeoff entirely) would silently RETAIN the previous visit's rows under the same publicId on
// re-open. Coercion reproduces the old reset-then-conditional-set net behavior (resetProjectData
// cleared both arrays before the loader's conditional sets — SPEC §5-D3).
//
// `publicId` is explicit: openProject passes server-canonical `data.id`, and its generation guard
// pairs both entries with the later single session activation. Both collection args are REQUIRED
// (no defaults) so a future third takeoff key cannot hide behind the signature.
export function seedTakeoffCache(
  qc: QueryClient,
  publicId: string,
  items: ClientTakeoffItem[] | undefined | null,
  groups: TakeoffGroup[] | undefined | null,
  canPublish: () => boolean = () => true,
): boolean {
  if (!canPublish()) return false;
  qc.setQueryData(queryKeys.takeoff.items(publicId), items ?? []);
  // A Query subscriber may synchronously start a newer project generation. Never let the second
  // half of this paired seed publish after that generation has begun.
  if (!canPublish()) return false;
  qc.setQueryData(queryKeys.takeoff.groups(publicId), groups ?? []);
  return canPublish();
}

// [DETECTOR jul10 P2.2④ closer] Historical bootstrap-payload adapter — a PURE no-op extract of
// the field mapping the dashboard loader previously inlined
// (`seedTakeoffCache(qc, data.id, data.takeoffItems, data.takeoffGroups)`). Exists so the
// takeoffItems→items-key / takeoffGroups→groups-key MAPPING is unit-pinned (useTakeoff.test.tsx):
// mutation testing showed the old loader call was test-invisible. Shared openProject now calls
// seedTakeoffCache directly; this adapter remains as the migration mapping characterization.
// Payload is structural (`{ takeoffItems?, takeoffGroups? }`).
export function seedTakeoffFromBootstrap(
  qc: QueryClient,
  publicId: string,
  data: {
    takeoffItems?: ClientTakeoffItem[] | null;
    takeoffGroups?: TakeoffGroup[] | null;
  },
): void {
  seedTakeoffCache(qc, publicId, data.takeoffItems, data.takeoffGroups);
}

// [refactor jul10 P2.2④] The getState() bridge for AnnotationOverlay's 7 handler/effect-time
// sync reads (SPEC §3.3). getQueryData reads the LIVE cache synchronously — observer results
// even update synchronously at dispatch; only React notification defers by a setTimeout(0)
// task — so a bridge read immediately after a facade write sees the write (same-tick
// read-after-write, pinned in the hook suite). `?? []` mirrors the old always-an-array store
// field. NO readTakeoffGroups exists: zero getState reads of takeoffGroups exist in the app
// (SPEC §2.5) — do not add one speculatively.
export function readTakeoffItems(qc: QueryClient, publicId: string): ClientTakeoffItem[] {
  return qc.getQueryData<ClientTakeoffItem[]>(queryKeys.takeoff.items(publicId)) ?? [];
}

// [refactor jul10 P2.2④] Items hook — data + the three item actions, byte-compatible with the
// deleted store bindings (addTakeoffItem/removeTakeoffItem/updateTakeoffItem mirror
// viewerStore.ts:1024-1033 verbatim). Config is chat-verbatim (useChatMessages.ts precedent):
//   • throwing queryFn — no client GET exists; any refetch reaching it is a BUG, fail loud
//     rather than silently clobbering the lifecycle seed. Never fires: enabled:false + initialData.
//   • enabled:false — openProject's seed is the sole source of truth; no fetch path, ever.
//   • initialData [] — matches the old store default (viewerStore init); consumers array-safe.
//   • staleTime Infinity — bootstrap-seeded; nothing may mark it stale.
//   • gcTime Infinity — CORRECTNESS, not a nicety (SPEC §2.1): enabled:false + throwing queryFn
//     means there is NO refetch path, so a GC'd entry is unrecoverable until full reload.
//     AnnotationOverlay usually pins an items observer but is NOT guaranteed mounted in every
//     viewer state; demo temp rows (id:-Date.now()) live only in this cache. Retention is
//     domain-specific: ⑥/⑦ each own one project key and use Infinity; ⑧ textract is bounded.
//
// Action-identity note (do not "fix"): the old store handed every consumer ONE singleton
// function per action; post-migration each component gets its own useCallback instance, stable
// per component under [qc, publicId]. Verified: no cross-component identity dependence; the
// tabs' [isDemo, updateTakeoffItem] dep arrays stay stable. Do not hoist these to module scope.
export function useTakeoffItems() {
  const publicId = useSessionStore((s) => s.publicId);
  const qc = useQueryClient();
  const key = queryKeys.takeoff.items(publicId); // ["project", publicId, "takeoff", "items"]

  const { data } = useQuery({
    queryKey: key,
    queryFn: (): ClientTakeoffItem[] => {
      throw new Error(
        "takeoff is bootstrap-seeded (no client GET); queryFn must never run",
      );
    },
    enabled: false,
    initialData: [] as ClientTakeoffItem[],
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Functional updaters `(old = []) => …` are MANDATORY — they mirror the store's original
  // set((s)=>({takeoffItems:[…]})) and are stale-closure-safe across the handlers' awaits
  // (server-first creates call addTakeoffItem after a fetch round-trip). Deps are [qc, publicId]
  // — `key` is a fresh array each render (do NOT list it); it derives from publicId, so the
  // closure always targets the key it was rendered with (captured-key D2 semantics: a write
  // racing a project switch lands under the OLD publicId's entry — isolated by keying).
  const addTakeoffItem = useCallback(
    (item: ClientTakeoffItem) =>
      qc.setQueryData<ClientTakeoffItem[]>(key, (old = []) => [...old, item]),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );
  const removeTakeoffItem = useCallback(
    (id: number) =>
      qc.setQueryData<ClientTakeoffItem[]>(key, (old = []) => old.filter((t) => t.id !== id)),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );
  const updateTakeoffItem = useCallback(
    (id: number, updates: Partial<ClientTakeoffItem>) =>
      qc.setQueryData<ClientTakeoffItem[]>(key, (old = []) =>
        old.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      ),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );

  // data is always ClientTakeoffItem[] (initialData guarantees non-undefined); belt-and-suspenders.
  return { takeoffItems: data ?? [], addTakeoffItem, removeTakeoffItem, updateTakeoffItem };
}

// [refactor jul10 P2.2④] Groups hook — data + the three group actions (mirror
// viewerStore.ts:1039-1048 verbatim). Config identical to useTakeoffItems — see the field
// rationale there; the gcTime:Infinity argument is even STRONGER here: the groups key's only
// observers (CountTab/AreaTab/LinearTab/ViewAllPanel) are all conditionally mounted, so a
// finite gcTime would reset groups to initialData [] for REAL projects on panel reopen.
export function useTakeoffGroups() {
  const publicId = useSessionStore((s) => s.publicId);
  const qc = useQueryClient();
  const key = queryKeys.takeoff.groups(publicId); // ["project", publicId, "takeoff", "groups"]

  const { data } = useQuery({
    queryKey: key,
    queryFn: (): TakeoffGroup[] => {
      throw new Error(
        "takeoff is bootstrap-seeded (no client GET); queryFn must never run",
      );
    },
    enabled: false,
    initialData: [] as TakeoffGroup[],
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const addTakeoffGroup = useCallback(
    (g: TakeoffGroup) => qc.setQueryData<TakeoffGroup[]>(key, (old = []) => [...old, g]),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );
  // The TWO-KEY ungroup (FK-SET-NULL client mirror of viewerStore.ts:1040-1045: the server
  // deletes the group and SET NULLs member items' groupId; the old store action did both fields
  // in one atomic set). D6 CONSTRAINT (SPEC §5-D6, mandatory): both setQueryData calls in ONE
  // synchronous block — no await between, EVER — wrapped in notifyManager.batch. No renderable
  // frame can mix old items with new groups because both writes complete before RQ's
  // setTimeout(0) notify fires and any triggered render reads the live cache; the batch
  // collapses the two notify flushes into one render and hardens against future RQ scheduler
  // changes. The hook suite's raw-subscriber pin detects an inserted await.
  const removeTakeoffGroup = useCallback(
    (id: number) => {
      notifyManager.batch(() => {
        qc.setQueryData<TakeoffGroup[]>(key, (old = []) => old.filter((g) => g.id !== id));
        qc.setQueryData<ClientTakeoffItem[]>(
          queryKeys.takeoff.items(publicId),
          (old = []) => old.map((t) => (t.groupId === id ? { ...t, groupId: null } : t)),
        );
      });
    },
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );
  const updateTakeoffGroup = useCallback(
    (id: number, updates: Partial<TakeoffGroup>) =>
      qc.setQueryData<TakeoffGroup[]>(key, (old = []) =>
        old.map((g) => (g.id === id ? { ...g, ...updates } : g)),
      ),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );

  return { takeoffGroups: data ?? [], addTakeoffGroup, removeTakeoffGroup, updateTakeoffGroup };
}
