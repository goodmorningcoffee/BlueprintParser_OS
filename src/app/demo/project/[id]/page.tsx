"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useViewerStore } from "@/stores/viewerStore";
import { useSearch } from "@/hooks/useSearch";
import PDFViewer from "@/components/viewer/PDFViewer";
import type {
  ClientAnnotation,
  KeynoteData,
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
  demoConfig?: Record<string, boolean>;
  pages: Array<{
    pageNumber: number;
    name: string;
    drawingNumber: string | null;
  }>;
}

interface ChunkResponse {
  from: number;
  to: number;
  pages: Array<{
    pageNumber: number;
    name: string;
    drawingNumber: string | null;
    keynotes: KeynoteData[] | null;
    csiCodes: CsiCode[] | null;
    textAnnotations: unknown | null;
    pageIntelligence: unknown | null;
  }>;
  annotations: ClientAnnotation[];
}

export default function DemoProjectPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const csiParam = searchParams.get("csi");
  const qParam = searchParams.get("q");
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useSearch();

  const setProjectId = useViewerStore((s) => s.setProjectId);
  const setPublicId = useViewerStore((s) => s.setPublicId);
  const setDataUrl = useViewerStore((s) => s.setDataUrl);
  const setNumPages = useViewerStore((s) => s.setNumPages);
  const initDetectionModels = useViewerStore((s) => s.initDetectionModels);
  const setPageNames = useViewerStore((s) => s.setPageNames);
  const setAllTrades = useViewerStore((s) => s.setAllTrades);
  const setAllCsiCodes = useViewerStore((s) => s.setAllCsiCodes);
  const setIsDemo = useViewerStore((s) => s.setIsDemo);
  const resetProjectData = useViewerStore((s) => s.resetProjectData);
  const setCsiFilter = useViewerStore((s) => s.setCsiFilter);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      resetProjectData();
      setIsDemo(true);
      useViewerStore.getState().setConfidenceThreshold(0);
      useViewerStore.setState({ helpMode: false });

      // ─── Phase 1: Lightweight project metadata + summaries ───
      const res = await fetch(`/api/demo/projects/${id}`);
      if (!res.ok) throw new Error("Project not found");

      const data: ProjectResponse = await res.json();
      setProject(data);

      setProjectId(data.dbId);
      setPublicId(data.id);
      setDataUrl(data.dataUrl);
      setNumPages(data.numPages || 0);

      // Hydrate project intelligence (CSI graph)
      if (data.projectIntelligence) {
        useViewerStore.getState().setProjectIntelligenceData(data.projectIntelligence);
      }

      // Hydrate demo feature config
      if (data.demoConfig) {
        useViewerStore.getState().setDemoFeatureConfig(data.demoConfig);
      }

      // Hydrate summaries
      if (data.summaries) {
        useViewerStore.getState().setSummaries(data.summaries);
        setAllTrades(data.summaries.allTrades);
        setAllCsiCodes(data.summaries.allCsiCodes);
        if (data.summaries.annotationSummary.modelNames.length > 0) {
          initDetectionModels(data.summaries.annotationSummary.modelNames);
          for (const name of data.summaries.annotationSummary.modelNames) {
            useViewerStore.getState().setModelConfidence(name, 0);
          }
        }
      }

      // Page names
      const names: Record<number, string> = {};
      for (const page of data.pages) {
        names[page.pageNumber] = page.drawingNumber || page.name;
      }
      setPageNames(names);

      if (csiParam) setCsiFilter(csiParam);
      if (qParam) useViewerStore.getState().setSearch(qParam);

      // ─── Phase 2: Fetch initial chunk ───
      const chunkTo = Math.min(data.numPages || 1, 15);
      const chunkRes = await fetch(`/api/demo/projects/${id}/pages?from=1&to=${chunkTo}`);
      if (chunkRes.ok) {
        const chunk: ChunkResponse = await chunkRes.json();

        const keynoteMap: Record<number, any> = {};
        const csiMap: Record<number, any> = {};
        const textAnnMap: Record<number, any[]> = {};
        const intelMap: Record<number, any> = {};

        for (const page of chunk.pages) {
          if (page.keynotes) keynoteMap[page.pageNumber] = page.keynotes;
          if (page.csiCodes) csiMap[page.pageNumber] = page.csiCodes;
          if (page.textAnnotations) {
            const result = page.textAnnotations as any;
            textAnnMap[page.pageNumber] = result.annotations || [];
          }
          if (page.pageIntelligence) intelMap[page.pageNumber] = page.pageIntelligence;
        }

        useViewerStore.setState(() => ({
          keynotes: keynoteMap,
          csiCodes: csiMap,
          textAnnotations: textAnnMap,
          pageIntelligence: intelMap,
          annotations: chunk.annotations,
          loadedPageRange: { from: 1, to: chunkTo },
        }));

        // Fallback if no summaries (old demo project)
        if (!data.summaries) {
          const allTradeSet = new Set<string>();
          const allCsiMap = new Map<string, string>();
          for (const page of chunk.pages) {
            if (page.csiCodes) {
              for (const c of page.csiCodes as CsiCode[]) {
                allTradeSet.add(c.trade);
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
          if (yoloModelNames.length > 0) {
            initDetectionModels(yoloModelNames);
            for (const name of yoloModelNames) {
              useViewerStore.getState().setModelConfidence(name, 0);
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id, setProjectId, setPublicId, setDataUrl, setNumPages, initDetectionModels, setPageNames, setAllTrades, setAllCsiCodes, setIsDemo, resetProjectData, csiParam, qParam, setCsiFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const store = useViewerStore.getState();
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) return;

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
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--muted)]">
        Loading demo project...
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4">
        <span className="text-red-400">{error || "Project not found"}</span>
        <a href="/demo" className="text-sm text-[var(--accent)] hover:underline">
          Back to Demo
        </a>
      </div>
    );
  }

  return <PDFViewer pdfUrl={project.pdfUrl} projectName={project.name} backHref="/demo" />;
}
