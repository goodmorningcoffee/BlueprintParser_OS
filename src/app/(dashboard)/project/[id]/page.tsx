"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { useViewerStore } from "@/stores/viewerStore";
import { useSearch } from "@/hooks/useSearch";
import { seedChatCache } from "@/queries/useChatMessages";
// [refactor jul10 P2.2③] summaries moved zustand → TanStack cache; loader seeds the cache.
import { seedSummariesCache } from "@/queries/useSummaries";
// [refactor jul10 P2.2④] takeoff items+groups moved zustand → TanStack cache; loader seeds both keys.
import { seedTakeoffFromBootstrap } from "@/queries/useTakeoff";
// [refactor jul10 P2.2⑤] annotation groups moved zustand → TanStack cache; loader seeds the one key.
import { seedAnnotationGroupsFromBootstrap } from "@/queries/useAnnotationGroups";
// [refactor jul11 P2.2⑦] One paired helper publishes annotations + the active page window.
import { publishBootstrapPageWindow } from "@/queries/usePageWindow";
import { clearTextractProject } from "@/queries/textractCache";
import {
  clearYoloTagsProject,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import PDFViewer from "@/components/viewer/PDFViewer";
import type { PageWindowResponse } from "@/queries/pageWindowCore";
import type {
  ClientTakeoffItem,
  TakeoffGroup,
  CsiCode,
  ProjectSummaries,
} from "@/types";

interface ProjectResponse {
  id: string;
  dbId: number;
  name: string;
  dataUrl: string;
  pdfUrl: string;
  numPages: number;
  status: string;
  summaries: ProjectSummaries | null;
  projectIntelligence: Record<string, unknown> | null;
  pages: Array<{
    pageNumber: number;
    name: string;
    drawingNumber: string | null;
  }>;
  takeoffItems?: ClientTakeoffItem[];
  takeoffGroups?: TakeoffGroup[];
  chatMessages?: Array<{
    id: number;
    role: string;
    content: string;
    model: string | null;
  }>;
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const csiParam = searchParams.get("csi");
  const qParam = searchParams.get("q");
  const { data: session } = useSession();
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search hook — reacts to searchQuery changes in the store
  useSearch();

  const initDetectionModels = useViewerStore((s) => s.initDetectionModels);
  const setPageNames = useViewerStore((s) => s.setPageNames);
  const setPageDrawingNumbers = useViewerStore((s) => s.setPageDrawingNumbers);
  const setAllTrades = useViewerStore((s) => s.setAllTrades);
  const setAllCsiCodes = useViewerStore((s) => s.setAllCsiCodes);
  const queryClient = useQueryClient();
  const setScaleCalibration = useViewerStore((s) => s.setScaleCalibration);
  const resetProjectData = useViewerStore((s) => s.resetProjectData);
  const setCsiFilter = useViewerStore((s) => s.setCsiFilter);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // [refactor jul11 P2.2⑧] The old store reset discarded every loaded OCR page. Preserve that
      // reopen/switch contract with a TEXTRACT-ONLY cache clear; removing the broad project prefix
      // here would also destroy unrelated annotation/takeoff/chat cache state.
      const previousPublicId = useViewerStore.getState().publicId;
      if (previousPublicId) {
        await clearTextractProject(queryClient, previousPublicId);
        // [refactor jul11 P2.2⑨] Exact-key teardown bounds the instance-heavy project array and
        // aborts/cancels its delayed save. Never broaden this to the whole project query prefix.
        clearYoloTagsProject(queryClient, previousPublicId);
      }

      // Clear stale UI/tool data from any previously viewed project.
      resetProjectData();

      // ─── Fetch metadata + initial chunk + annotation groups in parallel ───
      // All three APIs resolve publicId independently — no dependency between them
      const [res, chunkRes, groupsRes] = await Promise.all([
        // A delayed yolo PUT followed by a quick reopen must not hydrate the browser's cached
        // pre-save projectIntelligence snapshot (this endpoint otherwise advertises max-age=60).
        fetch(`/api/projects/${id}`, { cache: "no-store" }),
        fetch(`/api/projects/${id}/pages?from=1&to=15`),
        fetch(`/api/annotation-groups?projectId=${id}`),
      ]);
      if (!res.ok) throw new Error("Failed to load project");

      const data: ProjectResponse = await res.json();
      setProject(data);

      // Hydrate core project state (batched to avoid 4 separate re-renders)
      useViewerStore.setState({
        projectId: data.dbId,
        publicId: data.id,
        dataUrl: data.dataUrl,
        numPages: data.numPages || 0,
      });

      // [refactor jul11 P2.2⑨] Unconditional cache seed preserves reset-then-conditional-set net
      // behavior for omitted/null tags and prevents stale same-key resurrection. The helper also
      // strips yoloTags from the legacy PI blob so Zustand cannot remain a hidden second owner.
      const projectIntelligenceWithoutYoloTags = seedYoloTagsFromBootstrap(
        queryClient,
        data.id,
        data.projectIntelligence,
      );
      if (projectIntelligenceWithoutYoloTags) {
        useViewerStore.getState().setProjectIntelligenceData(projectIntelligenceWithoutYoloTags);
      }

      // Load summaries into the TanStack Query cache (facade — no longer a zustand field).
      // [refactor jul10 P2.2③] UNCONDITIONAL publicId-scoped seed with `?? null` inside the
      // helper: reproduces the old reset-then-conditional-set net behavior (resetProjectData
      // nulled the field above; a conditional seed would RETAIN a stale same-key entry when the
      // response omits summaries). Seed-before-reveal: runs before setLoading(false) and every
      // consumer is unmounted behind the `loading` gate, so no stale flash (mirrors seedChatCache).
      seedSummariesCache(queryClient, data.id, data.summaries);
      // Guard KEEPS its piggybacks — allTrades/allCsiCodes/detection models are separate,
      // non-migrating zustand fields hydrated only when summaries exist.
      if (data.summaries) {
        setAllTrades(data.summaries.allTrades);
        setAllCsiCodes(data.summaries.allCsiCodes);
        if (data.summaries.annotationSummary.modelNames.length > 0) {
          initDetectionModels(data.summaries.annotationSummary.modelNames);
        }
      }

      // Page names from lightweight page list
      const names: Record<number, string> = {};
      const drawingNumbers: Record<number, string | null> = {};
      for (const page of data.pages) {
        names[page.pageNumber] = page.drawingNumber || page.name;
        drawingNumbers[page.pageNumber] = page.drawingNumber;
      }
      setPageNames(names);
      setPageDrawingNumbers(drawingNumbers);

      // Apply filters from URL query params
      if (csiParam) setCsiFilter(csiParam);
      if (qParam) useViewerStore.getState().setSearch(qParam);

      // Load chat history into the TanStack Query cache (facade — no longer a zustand field).
      // [refactor jul9 P2.2①] Unconditional publicId-scoped seed (see seedChatCache). ChatPanel is
      // the sole observer and is unmounted while `loading` (page gates PDFViewer on !loading), so
      // this seed always lands before the panel remounts — no stale flash (D5).
      seedChatCache(queryClient, data.id, data.chatMessages);

      // Load takeoff items + groups into the TanStack Query cache (facade — no longer zustand).
      // [refactor jul10 P2.2④] ONE UNCONDITIONAL publicId-scoped seed for BOTH keys (`?? []`
      // inside the helper): reproduces the old reset-then-conditional-set net behavior
      // (resetProjectData cleared both arrays above; a conditional seed would RETAIN stale
      // same-key rows when the response omits a collection — SPEC §5-D3). Same sync block as
      // the setState({publicId}) hydration above, seed-before-reveal like chat/summaries.
      // [DETECTOR jul10 closer] The field mapping (takeoffItems→items key, takeoffGroups→groups
      // key) lives in seedTakeoffFromBootstrap and is unit-pinned there — this CALL is the one
      // remaining unpinned line; do not inline the mapping back.
      seedTakeoffFromBootstrap(queryClient, data.id, data);

      // Hydrate annotation groups + M:N membership pairs into the TanStack Query cache
      // (facade — no longer zustand). Both the flat group list and the junction rows come
      // from a single endpoint — see /api/annotation-groups GET handler. HTTP-non-ok stays
      // non-blocking (no groups this open; core viewer still works); a NETWORK-level failure
      // of the Promise.all fetch above stays FATAL (whole-project Retry screen) — preserved
      // deliberately, do not move the GET out of the Promise.all (SPEC §2.1).
      // [refactor jul10 P2.2⑤] UNCONDITIONAL atomic publicId-scoped seed (`?? []` inside the
      // helper, BOTH fields always written): a conditional seed would retain a stale-or-absent
      // same-key entry and reopen the post-reveal recovery-GET hole. Keyed on data.id
      // (server-canonical), NEVER the route param. Seed-before-reveal: runs before the
      // `finally setLoading(false)`, and every group observer is unmounted behind the loading
      // gate, so groups are painted at first reveal exactly as before (no pop-in). Failure
      // semantics deltas vs the old retain-on-fail store writes are the pinned E3 ledger
      // (ANNGROUPS_IMPL/SPEC.md §5-E3: clear-on-fail, leak-class elimination).
      // [DETECTOR jul10 closer] The ok→parse-or-null→unconditional-seed mapping lives in
      // seedAnnotationGroupsFromBootstrap and is unit-pinned there (M8 unconditional/empty,
      // M11 publicId keying) — this CALL is the one remaining unpinned line (④ precedent);
      // do not inline the mapping back. Awaited so the seed still lands before the
      // `finally setLoading(false)` (seed-before-reveal).
      await seedAnnotationGroupsFromBootstrap(queryClient, data.id, groupsRes);

      // ─── Hydrate initial chunk (already fetched in parallel above) ───
      if (!chunkRes.ok) {
        // Clear BOTH independently cached halves. A same-project reopen must not expose a stale
        // annotation/window pair when the optional initial chunk request fails.
        publishBootstrapPageWindow(queryClient, data.id, null, data.numPages);
      }
      if (chunkRes.ok) {
        let chunk: PageWindowResponse;
        try {
          chunk = await chunkRes.json();
        } catch (parseError) {
          // Preserve the fatal JSON-parse path, but clear the paired cache before the error screen.
          publishBootstrapPageWindow(queryClient, data.id, null, data.numPages);
          throw parseError;
        }

        // Annotation-first, no-await paired publication under the server-canonical project id.
        // Scale hydration and summaries-null fallbacks intentionally remain literal piggybacks.
        publishBootstrapPageWindow(queryClient, data.id, chunk, data.numPages);

        for (const ann of chunk.annotations) {
          if (ann.source === "takeoff-scale" && (ann.data as any)?.type === "scale-calibration") {
            setScaleCalibration(ann.pageNumber, ann.data as any);
          }
        }

        if (!data.summaries) {
          const allTradeSet = new Set<string>();
          const allCsiMap = new Map<string, string>();
          for (const page of chunk.pages) {
            if (page.csiCodes) {
              for (const c of page.csiCodes as CsiCode[]) {
                if (c.trade) allTradeSet.add(c.trade);
                allCsiMap.set(c.code, c.description);
              }
            }
          }
          setAllTrades(Array.from(allTradeSet).sort());
          setAllCsiCodes(
            Array.from(allCsiMap.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([code, description]) => ({ code, description }))
          );
          const yoloModelNames = [...new Set(
            chunk.annotations
              .filter((a: any) => a.source === "yolo" && a.data?.modelName)
              .map((a: any) => a.data.modelName as string)
          )];
          if (yoloModelNames.length > 0) initDetectionModels(yoloModelNames);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [
    id,
    initDetectionModels,
    setPageNames,
    setPageDrawingNumbers,
    setAllTrades,
    setAllCsiCodes,
    queryClient,
    setScaleCalibration,
    resetProjectData,
    csiParam,
    qParam,
    setCsiFilter,
  ]);

  // Track loaded project ID to prevent re-loading on tab focus.
  // NextAuth's useSession() refetches on window focus, creating a new session
  // object reference that would re-trigger load() and reset all viewer state.
  const loadedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!session) return;
    if (loadedIdRef.current === id) return;
    loadedIdRef.current = id;
    load();
  }, [session, id, load]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const store = useViewerStore.getState();

      // Don't capture if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        store.setPage(store.pageNumber - 1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        store.setPage(store.pageNumber + 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        store.setPage(1);
      } else if (e.key === "End") {
        e.preventDefault();
        store.setPage(store.numPages);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "=") {
        e.preventDefault();
        store.zoomIn();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        store.zoomOut();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        store.zoomFit();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--muted)]">
        Loading project...
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4">
        <span className="text-red-400">
          {error || "Project not found"}
        </span>
        <button
          onClick={load}
          className="px-4 py-2 text-sm bg-[var(--surface)] border border-[var(--border)] rounded hover:border-[var(--accent)] transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (project.status === "uploading" || project.status === "processing") {
    return (
      <ProcessingView
        projectName={project.name}
        status={project.status}
        numPages={project.numPages}
        pagesProcessed={project.pages.length}
        onRefresh={load}
      />
    );
  }

  return (
    <PDFViewer
      pdfUrl={project.pdfUrl}
      projectName={project.name}
      onRename={(newName) => setProject((prev) => prev ? { ...prev, name: newName } : prev)}
    />
  );
}

function ProcessingView({
  projectName,
  status,
  numPages,
  pagesProcessed,
  onRefresh,
}: {
  projectName: string;
  status: string;
  numPages: number | null;
  pagesProcessed: number;
  onRefresh: () => void;
}) {
  // Auto-poll every 3 seconds
  useEffect(() => {
    const interval = setInterval(onRefresh, 3000);
    return () => clearInterval(interval);
  }, [onRefresh]);

  return (
    <div className="h-screen flex flex-col items-center justify-center gap-6">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        <h2 className="text-lg font-medium">{projectName}</h2>
        <span className="text-[var(--muted)] text-sm capitalize">{status}...</span>
        {numPages != null && numPages > 0 && (
          <span className="text-[var(--muted)] text-xs">
            {pagesProcessed} of {numPages} pages processed
          </span>
        )}
      </div>
    </div>
  );
}
