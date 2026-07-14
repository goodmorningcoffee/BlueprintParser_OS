// [refactor jul10 P2.2②] qtoWorkflows domain — TanStack Query facade (variant b, INDEPENDENT-FETCH).
//
// Replaces the viewerStore qtoWorkflows collection + AutoQtoTab's fetch-on-mount useEffect
// (P2_DESIGN/QTO_IMPL/SPEC.md; recipe: P2_DESIGN/RECIPE.md step 3b). Facade parity: returns the
// exact 4-field shape the old useQtoWorkflow() zustand selector returned, so the sole consumer
// (AutoQtoTab) changes only its import + hook name.
//
// What migrates: the qtoWorkflows COLLECTION (server rows, GET-backed). What stays in zustand:
// activeQtoWorkflow + setActiveQtoWorkflow — a UI-selection pointer / working draft, not a server
// collection (SPEC §3; moving it would be a behavior change, out of scope for a characterization
// refactor).
//
// Faithfulness ledger vs the old useEffect (SPEC §2 — every config field is load-bearing):
//   queryFn non-ok → []      == old `r.ok ? r.json() : []` (a 500 CLEARS the list, frozen Q-2)
//   enabled !!publicId&&!isDemo == old `if (!publicId || isDemo) return` (demo NEVER GETs, Q-3)
//   initialData []           == old zustand init `qtoWorkflows: []` (never undefined; also means
//                               a demo project reads [] without fetching)
//   staleTime 0              == old fetch-on-every-mount (AutoQtoTab is conditionally mounted at
//                               TakeoffPanel; each sub-tab open refetched)
//   gcTime Infinity          == old zustand persistence across unmount. REQUIRED: demo temp
//                               workflows (id:-Date.now()) are CLIENT-ONLY and must survive
//                               auto-qto sub-tab toggles (frozen Q-7). qto lists are small —
//                               do NOT copy this blindly: ⑥/⑦ each own one project key and use
//                               Infinity deliberately; ⑧ textract is per-page and bounded.
//   retry false              == old single attempt
//   refetchOnWindowFocus/Reconnect false == old effect never refired on focus/reconnect
//   NO row mapper            == old `setQtoWorkflows(await r.json())` stored RAW server rows
//                               (incl. createdAt/updatedAt) — modeling them would drop fields.

"use client";

import { useCallback } from "react";
import type { SetStateAction } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore } from "@/stores/uiStore";
import { queryKeys } from "@/queries/queryKeys";
import type { QtoWorkflow } from "@/types";

export function useQtoWorkflows() {
  const publicId = useSessionStore((s) => s.publicId);
  const isDemo = useSessionStore((s) => s.isDemo);
  const activeQtoWorkflow = useUiStore((s) => s.activeQtoWorkflow);
  const setActiveQtoWorkflow = useUiStore((s) => s.setActiveQtoWorkflow);
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: queryKeys.qtoWorkflows.all(publicId),
    queryFn: async ({ signal }) => {
      // == the old AutoQtoTab effect verbatim: non-ok clears to [], network error throws (RQ
      // keeps the previous cache entry / initialData — same rendered result as the old
      // console.error-and-keep path; retry:false = the old single attempt).
      const r = await fetch(`/api/qto-workflows?projectId=${publicId}`, { signal });
      return r.ok ? ((await r.json()) as QtoWorkflow[]) : [];
    },
    enabled: !!publicId && !isDemo,
    initialData: [] as QtoWorkflow[],
    // staleTime:0 + refetchOnMount:true are v5 defaults but pinned EXPLICITLY: together they ARE
    // the fetch-on-every-mount contract (AutoQtoTab is conditionally mounted), and a future
    // app-wide defaultOptions (e.g. a global staleTime) must not silently break it (SPEC §2).
    staleTime: 0,
    refetchOnMount: true,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // v5 default networkMode 'online' would PAUSE the fetch while offline; the old effect fired
    // and failed immediately (console.error, list unchanged). 'always' preserves fire-and-fail.
    networkMode: "always",
  });

  // REPLACE remains compatible with the old zustand `set({ qtoWorkflows })`; the functional form
  // is also accepted so async workflow reconciliation can update one row without overwriting rows
  // added while its request was pending.
  const setQtoWorkflows = useCallback(
    (next: SetStateAction<QtoWorkflow[]>) => {
      qc.setQueryData<QtoWorkflow[]>(
        queryKeys.qtoWorkflows.all(publicId),
        (current) => typeof next === "function" ? next(current ?? []) : next,
      );
    },
    [qc, publicId],
  );

  return { activeQtoWorkflow, setActiveQtoWorkflow, qtoWorkflows: data ?? [], setQtoWorkflows };
}
