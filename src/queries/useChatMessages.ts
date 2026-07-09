"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query"; // v5.101 installed
import { useViewerStore } from "@/stores/viewerStore";
import { queryKeys } from "@/queries/queryKeys";
import type { ChatMsg } from "@/types";

// [refactor jul9 P2.2①] Loader-side hydration transform, extracted VERBATIM from the old inline
// map at project/[id]/page.tsx:147-153 (zero behavior change). Coerces the DB `model` null/"" ->
// undefined; `role` is a bare `as` cast with NO validation (frozen quirk — a stray role passes
// through and renders as an "AI" bubble). This is the canonical "DB rows -> domain type" unit the
// TEMPLATE reuses for ③summaries ④takeoff ⑨yoloTags.
export function mapChatRows(
  rows: Array<{ id: number; role: string; content: string; model: string | null }>,
): ChatMsg[] {
  return rows.map((c) => ({
    id: c.id,
    role: c.role as "user" | "assistant",
    content: c.content,
    model: c.model || undefined,
  }));
}

// [refactor jul9 P2.2①] chat: zustand viewerStore -> TanStack Query cache (FIRST of 9 domains;
// this is the reusable template for the bootstrap-seeded/no-GET domains ③④⑨). There is NO GET
// endpoint for chat — rows arrive in the project bootstrap payload and are seeded via setQueryData
// in the loader (project/[id]/page.tsx). This hook is a pure cache SUBSCRIPTION + two client-only
// mutations; the queryFn MUST NEVER run. It returns the SAME shape the old useChat() gave for chat
// data, so ChatPanel changes only its import + destructure. `chatScope`/`showChatPanel` stay in
// zustand (UI state) — only the server-backed message collection migrates.
export function useChatMessages() {
  const publicId = useViewerStore((s) => s.publicId);
  const qc = useQueryClient();
  const key = queryKeys.chatMessages.all(publicId); // ["project", publicId, "chatMessages"]

  const { data } = useQuery({
    queryKey: key,
    // THROWING queryFn (not a self-referential getQueryData): on a no-GET domain, any accidental
    // refetch/manual .refetch() that reaches the queryFn is a BUG — fail LOUD rather than silently
    // re-writing the cache. In practice it never fires: enabled:false + fresh initialData.
    queryFn: () => {
      throw new Error(
        "chatMessages is bootstrap-seeded (no GET endpoint); queryFn must never run",
      );
    },
    enabled: false, // never auto-fetch on mount/focus; invalidateQueries won't refetch a disabled query
    initialData: [] as ChatMsg[], // status:'success' immediately -> renders empty-state, never undefined
    staleTime: Infinity, // documents "never auto-refetch" (moot under enabled:false)
    // gcTime:Infinity — ChatPanel is the SOLE observer and is CONDITIONALLY mounted
    // ({showChatPanel && <ChatPanel/>}, PDFViewer.tsx:674). Client-sent messages live only in this
    // cache for the session — the loader re-seeds ONLY on a full project (re)load, NOT on a panel
    // toggle. A finite gcTime would GC them while the panel is closed > gcTime and reopen EMPTY =
    // a regression vs the old zustand field (which held them all session). Chat is text (KB-scale)
    // so retention is cheap. NOTE: per-domain override — the recipe DEFAULT for heavy per-page
    // siblings (⑥annotations ⑦pagesWindow ⑧textract) is FINITE gcTime + an in-hook LRU cap; they
    // must NOT copy Infinity.
    gcTime: Infinity,
  });

  // Functional updater is MANDATORY — mirrors the store's original set((s)=>({chatMessages:[...]})).
  // handleSend fires addChatMessage across awaits (:81 user, then EXACTLY ONE of :97 err / :168 done
  // / :173 catch); a captured-array spread would drop messages under a stale closure. `old = []`
  // guards the pre-seed undefined. Deps are [qc, publicId] — `key` is a fresh array each render
  // (do NOT list it); it is recomputed from publicId, so the closure always targets the right key.
  const addChatMessage = useCallback(
    (msg: ChatMsg) => qc.setQueryData<ChatMsg[]>(key, (old = []) => [...old, msg]),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );
  const clearChatMessages = useCallback(
    () => qc.setQueryData<ChatMsg[]>(key, []),
    [qc, publicId], // eslint-disable-line react-hooks/exhaustive-deps -- key derives from publicId
  );

  // data is always ChatMsg[] (initialData guarantees non-undefined); `?? []` is belt-and-suspenders.
  return { chatMessages: data ?? [], addChatMessage, clearChatMessages };
}
