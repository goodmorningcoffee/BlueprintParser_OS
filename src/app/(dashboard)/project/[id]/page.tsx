"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useViewerStore } from "@/stores/viewerStore";
import { useSearch } from "@/hooks/useSearch";
import PDFViewer from "@/components/viewer/PDFViewer";
import type {
  ClientAnnotation,
  ClientTakeoffItem,
  TakeoffGroup,
  KeynoteShapeData,
  CsiCode,
  TextractPageData,
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

interface ChunkResponse {
  from: number;
  to: number;
  pages: Array<{
    pageNumber: number;
    name: string;
    drawingNumber: string | null;
    keynotes: KeynoteShapeData[] | null;
    csiCodes: CsiCode[] | null;
    textAnnotations: { annotations?: any[]; summary?: any } | null;
    pageIntelligence: Record<string, any> | null;
  }>;
  annotations: ClientAnnotation[];
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
  const setAllTrades = useViewerStore((s) => s.setAllTrades);
  const setAllCsiCodes = useViewerStore((s) => s.setAllCsiCodes);
  const setChatMessages = useViewerStore((s) => s.setChatMessages);
  const setTakeoffItems = useViewerStore((s) => s.setTakeoffItems);
  const setTakeoffGroups = useViewerStore((s) => s.setTakeoffGroups);
  const setScaleCalibration = useViewerStore((s) => s.setScaleCalibration);
  const resetProjectData = useViewerStore((s) => s.resetProjectData);
  const setCsiFilter = useViewerStore((s) => s.setCsiFilter);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Clear stale data from any previously viewed project
      resetProjectData();

      // ─── Fetch metadata + initial chunk in parallel ───
      // Both APIs resolve publicId independently — no dependency between them
      const [res, chunkRes] = await Promise.all([
        fetch(`/api/projects/${id}`),
        fetch(`/api/projects/${id}/pages?from=1&to=15`),
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

      // Hydrate project intelligence (CSI graph, classCsiOverrides, etc.)
      if (data.projectIntelligence) {
        useViewerStore.getState().setProjectIntelligenceData(data.projectIntelligence);
        if ((data.projectIntelligence as any).yoloTags) {
          useViewerStore.getState().setYoloTags((data.projectIntelligence as any).yoloTags);
        }
      }

      // Hydrate summaries (powers sidebar filters, panel lists, annotation counts)
      if (data.summaries) {
        useViewerStore.getState().setSummaries(data.summaries);
        setAllTrades(data.summaries.allTrades);
        setAllCsiCodes(data.summaries.allCsiCodes);
        if (data.summaries.annotationSummary.modelNames.length > 0) {
          initDetectionModels(data.summaries.annotationSummary.modelNames);
        }
      }

      // Page names from lightweight page list
      const names: Record<number, string> = {};
      for (const page of data.pages) {
        names[page.pageNumber] = page.drawingNumber || page.name;
      }
      setPageNames(names);

      // Apply filters from URL query params
      if (csiParam) setCsiFilter(csiParam);
      if (qParam) useViewerStore.getState().setSearch(qParam);

      // Load chat history
      if (data.chatMessages) {
        setChatMessages(
          data.chatMessages.map((c) => ({
            id: c.id,
            role: c.role as "user" | "assistant",
            content: c.content,
            model: c.model || undefined,
          }))
        );
      }

      // Load takeoff items
      if (data.takeoffItems) {
        setTakeoffItems(data.takeoffItems);
      }
      if (data.takeoffGroups) {
        setTakeoffGroups(data.takeoffGroups);
      }

      // ─── Hydrate initial chunk (already fetched in parallel above) ───
      if (chunkRes.ok) {
        const chunk: ChunkResponse = await chunkRes.json();

        const keynoteMap: Record<number, KeynoteShapeData[]> = {};
        const csiMap: Record<number, CsiCode[]> = {};
        const textAnnMap: Record<number, any[]> = {};
        const intelMap: Record<number, any> = {};

        for (const page of chunk.pages) {
          if (page.keynotes) keynoteMap[page.pageNumber] = page.keynotes as KeynoteShapeData[];
          if (page.csiCodes) csiMap[page.pageNumber] = page.csiCodes as CsiCode[];
          if (page.textAnnotations) {
            textAnnMap[page.pageNumber] = page.textAnnotations.annotations || [];
          }
          if (page.pageIntelligence) intelMap[page.pageNumber] = page.pageIntelligence;
        }

        useViewerStore.setState(() => ({
          keynotes: keynoteMap,
          csiCodes: csiMap,
          textAnnotations: textAnnMap,
          pageIntelligence: intelMap,
          annotations: chunk.annotations,
          loadedPageRange: { from: 1, to: chunk.pages.length > 0 ? Math.max(...chunk.pages.map((p: any) => p.pageNumber)) : Math.min(data.numPages || 1, 15) },
        }));

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
    setAllTrades,
    setAllCsiCodes,
    setChatMessages,
    setTakeoffItems,
    setTakeoffGroups,
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
