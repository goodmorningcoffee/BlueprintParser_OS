"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
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
  const [project, setProject] = useState<ProjectResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useSearch();

  const setProjectId = useViewerStore((s) => s.setProjectId);
  const setPublicId = useViewerStore((s) => s.setPublicId);
  const setDataUrl = useViewerStore((s) => s.setDataUrl);
  const setNumPages = useViewerStore((s) => s.setNumPages);
  const setAnnotations = useViewerStore((s) => s.setAnnotations);
  const setPageNames = useViewerStore((s) => s.setPageNames);
  const setKeynotes = useViewerStore((s) => s.setKeynotes);
  const setCsiCodes = useViewerStore((s) => s.setCsiCodes);
  const setTextractData = useViewerStore((s) => s.setTextractData);
  const setAllTrades = useViewerStore((s) => s.setAllTrades);
  const setAllCsiCodes = useViewerStore((s) => s.setAllCsiCodes);
  const setIsDemo = useViewerStore((s) => s.setIsDemo);
  const resetProjectData = useViewerStore((s) => s.resetProjectData);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      resetProjectData();
      setIsDemo(true);

      const res = await fetch(`/api/demo/projects/${id}`);
      if (!res.ok) throw new Error("Project not found");

      const data: ProjectResponse = await res.json();
      setProject(data);

      setProjectId(data.dbId);
      setPublicId(data.id);
      setDataUrl(data.dataUrl);
      setNumPages(data.numPages || 0);
      setAnnotations(data.annotations);

      const names: Record<number, string> = {};
      const allTradeSet = new Set<string>();
      const allCsiMap = new Map<string, string>();

      for (const page of data.pages) {
        names[page.pageNumber] = page.drawingNumber || page.name;
        if (page.keynotes) setKeynotes(page.pageNumber, page.keynotes);
        if (page.csiCodes) {
          setCsiCodes(page.pageNumber, page.csiCodes);
          page.csiCodes.forEach((c) => {
            allTradeSet.add(c.trade);
            allCsiMap.set(c.code, c.description);
          });
        }
        if (page.textractData) setTextractData(page.pageNumber, page.textractData);
      }

      setPageNames(names);
      setAllTrades(Array.from(allTradeSet).sort());
      setAllCsiCodes(
        Array.from(allCsiMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, description]) => ({ code, description }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id, setProjectId, setPublicId, setDataUrl, setNumPages, setAnnotations, setPageNames, setKeynotes, setCsiCodes, setTextractData, setAllTrades, setAllCsiCodes, setIsDemo, resetProjectData]);

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
