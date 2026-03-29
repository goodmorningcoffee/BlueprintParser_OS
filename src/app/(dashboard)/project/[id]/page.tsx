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
  KeynoteData,
  CsiCode,
  TextractPageData,
} from "@/types";

interface ProjectResponse {
  id: string;
  dbId: number;
  name: string;
  dataUrl: string;
  pdfUrl: string;
  numPages: number;
  status: string;
  pages: Array<{
    pageNumber: number;
    name: string;
    drawingNumber: string | null;
    rawText: string | null;
    textractData: TextractPageData | null;
    keynotes: KeynoteData[] | null;
    csiCodes: CsiCode[] | null;
    textAnnotations: unknown | null;
  }>;
  annotations: ClientAnnotation[];
  takeoffItems?: ClientTakeoffItem[];
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

  const setProjectId = useViewerStore((s) => s.setProjectId);
  const setPublicId = useViewerStore((s) => s.setPublicId);
  const setDataUrl = useViewerStore((s) => s.setDataUrl);
  const setNumPages = useViewerStore((s) => s.setNumPages);
  const setAnnotations = useViewerStore((s) => s.setAnnotations);
  const initDetectionModels = useViewerStore((s) => s.initDetectionModels);
  const setPageNames = useViewerStore((s) => s.setPageNames);
  const setKeynotes = useViewerStore((s) => s.setKeynotes);
  const setCsiCodes = useViewerStore((s) => s.setCsiCodes);
  const setTextractData = useViewerStore((s) => s.setTextractData);
  const setTextAnnotations = useViewerStore((s) => s.setTextAnnotations);
  const setAllTrades = useViewerStore((s) => s.setAllTrades);
  const setAllCsiCodes = useViewerStore((s) => s.setAllCsiCodes);
  const setChatMessages = useViewerStore((s) => s.setChatMessages);
  const setTakeoffItems = useViewerStore((s) => s.setTakeoffItems);
  const setScaleCalibration = useViewerStore((s) => s.setScaleCalibration);
  const resetProjectData = useViewerStore((s) => s.resetProjectData);
  const setCsiFilter = useViewerStore((s) => s.setCsiFilter);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Clear stale data from any previously viewed project
      resetProjectData();

      const res = await fetch(`/api/projects/${id}`);
      if (!res.ok) throw new Error("Failed to load project");

      const data: ProjectResponse = await res.json();
      setProject(data);

      // Hydrate store
      setProjectId(data.dbId);
      setPublicId(data.id);
      setDataUrl(data.dataUrl);
      setNumPages(data.numPages || 0);
      if ((data as any).projectIntelligence) {
        useViewerStore.getState().setProjectIntelligenceData((data as any).projectIntelligence);
      }
      setAnnotations(data.annotations);
      const yoloModelNames = [...new Set(
        data.annotations
          .filter((a: any) => a.source === "yolo" && a.data?.modelName)
          .map((a: any) => a.data.modelName as string)
      )];
      if (yoloModelNames.length > 0) initDetectionModels(yoloModelNames);

      // Page names and data
      const names: Record<number, string> = {};
      const allTradeSet = new Set<string>();
      const allCsiMap = new Map<string, string>();

      // Batch all page data into maps, then update store ONCE (avoids N sequential re-renders)
      const keynoteMap: Record<number, KeynoteData[]> = {};
      const csiMap: Record<number, CsiCode[]> = {};
      const textractMap: Record<number, TextractPageData> = {};
      const textAnnMap: Record<number, any[]> = {};
      const intelMap: Record<number, any> = {};

      for (const page of data.pages) {
        names[page.pageNumber] = page.drawingNumber || page.name;

        if (page.keynotes) keynoteMap[page.pageNumber] = page.keynotes as KeynoteData[];
        if (page.csiCodes) {
          const codes = page.csiCodes as CsiCode[];
          csiMap[page.pageNumber] = codes;
          codes.forEach((c) => {
            allTradeSet.add(c.trade);
            allCsiMap.set(c.code, c.description);
          });
        }
        if (page.textractData) textractMap[page.pageNumber] = page.textractData as TextractPageData;
        if (page.textAnnotations) {
          const result = page.textAnnotations as any;
          textAnnMap[page.pageNumber] = result.annotations || [];
        }
        if ((page as any).pageIntelligence) intelMap[page.pageNumber] = (page as any).pageIntelligence;
      }

      // Single batched store update — triggers ONE re-render instead of 5×N
      useViewerStore.setState((s) => ({
        keynotes: { ...s.keynotes, ...keynoteMap },
        csiCodes: { ...s.csiCodes, ...csiMap },
        textractData: { ...s.textractData, ...textractMap },
        textAnnotations: { ...s.textAnnotations, ...textAnnMap },
        pageIntelligence: { ...s.pageIntelligence, ...intelMap },
      }));

      setPageNames(names);
      setAllTrades(Array.from(allTradeSet).sort());
      setAllCsiCodes(
        Array.from(allCsiMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, description]) => ({ code, description }))
      );

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

      // Hydrate scale calibrations from annotations
      for (const ann of data.annotations) {
        if (ann.source === "takeoff-scale" && (ann.data as any)?.type === "scale-calibration") {
          setScaleCalibration(ann.pageNumber, ann.data as any);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [
    id,
    setProjectId,
    setPublicId,
    setDataUrl,
    setNumPages,
    setAnnotations,
    initDetectionModels,
    setPageNames,
    setKeynotes,
    setCsiCodes,
    setTextractData,
    setTextAnnotations,
    setAllTrades,
    setAllCsiCodes,
    setChatMessages,
    setTakeoffItems,
    setScaleCalibration,
    resetProjectData,
    csiParam,
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
