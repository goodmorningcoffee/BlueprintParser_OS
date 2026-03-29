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
  const setAnnotations = useViewerStore((s) => s.setAnnotations);
  const initDetectionModels = useViewerStore((s) => s.initDetectionModels);
  const setPageNames = useViewerStore((s) => s.setPageNames);
  const setKeynotes = useViewerStore((s) => s.setKeynotes);
  const setCsiCodes = useViewerStore((s) => s.setCsiCodes);
  const setTextractData = useViewerStore((s) => s.setTextractData);
  const setTextAnnotations = useViewerStore((s) => s.setTextAnnotations);
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
      // Default YOLO on with threshold 0 in demo so users see all detections
      useViewerStore.getState().setConfidenceThreshold(0);
      // Annotations default off — user turns them on as needed

      const res = await fetch(`/api/demo/projects/${id}`);
      if (!res.ok) throw new Error("Project not found");

      const data: ProjectResponse = await res.json();
      setProject(data);

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
      if (yoloModelNames.length > 0) {
        initDetectionModels(yoloModelNames);
        // Demo mode: show all detections at 0% threshold
        for (const name of yoloModelNames) {
          useViewerStore.getState().setModelConfidence(name, 0);
        }
      }

      const names: Record<number, string> = {};
      const allTradeSet = new Set<string>();
      const allCsiMap = new Map<string, string>();

      // Batch all page data into maps, then update store ONCE
      const keynoteMap: Record<number, any> = {};
      const csiMap: Record<number, any> = {};
      const textractMap: Record<number, any> = {};
      const textAnnMap: Record<number, any[]> = {};
      const intelMap: Record<number, any> = {};

      for (const page of data.pages) {
        names[page.pageNumber] = page.drawingNumber || page.name;
        if (page.keynotes) keynoteMap[page.pageNumber] = page.keynotes;
        if (page.csiCodes) {
          csiMap[page.pageNumber] = page.csiCodes;
          page.csiCodes.forEach((c: any) => {
            allTradeSet.add(c.trade);
            allCsiMap.set(c.code, c.description);
          });
        }
        if (page.textractData) textractMap[page.pageNumber] = page.textractData;
        if ((page as any).textAnnotations) {
          const result = (page as any).textAnnotations;
          textAnnMap[page.pageNumber] = result.annotations || [];
        }
        if ((page as any).pageIntelligence) intelMap[page.pageNumber] = (page as any).pageIntelligence;
      }

      useViewerStore.setState((s: any) => ({
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id, setProjectId, setPublicId, setDataUrl, setNumPages, setAnnotations, initDetectionModels, setPageNames, setKeynotes, setCsiCodes, setTextractData, setTextAnnotations, setAllTrades, setAllCsiCodes, setIsDemo, resetProjectData, csiParam, qParam, setCsiFilter]);

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
