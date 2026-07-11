"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
// [refactor jul10 P2.2③] FIRST-EVER queryClient plumbing in the demo loader (chat never seeded it —
// getDemoProject omits chatMessages). The root layout wraps /demo in <Providers>, so the
// QueryClient context is available here.
import { useQueryClient } from "@tanstack/react-query";
import { useViewerStore } from "@/stores/viewerStore";
import { seedSummariesCache } from "@/queries/useSummaries";
// [refactor jul10 P2.2④] takeoff items+groups moved zustand → TanStack cache; loader seeds both keys.
import { seedTakeoffCache } from "@/queries/useTakeoff";
// [refactor jul11 P2.2⑦] One paired helper publishes annotations + the active page window.
import { publishBootstrapPageWindow } from "@/queries/usePageWindow";
import { clearTextractProject } from "@/queries/textractCache";
import { useSearch } from "@/hooks/useSearch";
import PDFViewer from "@/components/viewer/PDFViewer";
import type { PageWindowResponse } from "@/queries/pageWindowCore";
import type {
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
  const setPageDrawingNumbers = useViewerStore((s) => s.setPageDrawingNumbers);
  const setAllTrades = useViewerStore((s) => s.setAllTrades);
  const setAllCsiCodes = useViewerStore((s) => s.setAllCsiCodes);
  const setIsDemo = useViewerStore((s) => s.setIsDemo);
  const resetProjectData = useViewerStore((s) => s.resetProjectData);
  const setCsiFilter = useViewerStore((s) => s.setCsiFilter);
  // [refactor jul10 P2.2③] summaries now live in the query cache; the loader seeds it below.
  const queryClient = useQueryClient();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      // [refactor jul11 P2.2⑧] Match the former reset-owned OCR lifetime with exact-prefix cleanup.
      // Never remove queryKeys.project(previousPublicId): other P2 domains have independent policy.
      const previousPublicId = useViewerStore.getState().publicId;
      if (previousPublicId) await clearTextractProject(queryClient, previousPublicId);
      resetProjectData();
      setIsDemo(true);
      useViewerStore.getState().setConfidenceThreshold(0);
      useViewerStore.setState({
        helpMode: false,
        showTips: false,
        showChatPanel: false,
        showTableParsePanel: true,
        tableParseTab: "auto",
      });

      // ─── Fetch metadata + initial chunk in parallel ───
      const [res, chunkRes] = await Promise.all([
        fetch(`/api/demo/projects/${id}`),
        fetch(`/api/demo/projects/${id}/pages?from=1&to=15`),
      ]);
      if (!res.ok) throw new Error("Project not found");

      const data: ProjectResponse = await res.json();
      setProject(data);

      setProjectId(data.dbId);
      setPublicId(data.id);
      setDataUrl(data.dataUrl);
      setNumPages(data.numPages || 0);

      // Hydrate project intelligence (CSI graph + YOLO tags)
      if (data.projectIntelligence) {
        useViewerStore.getState().setProjectIntelligenceData(data.projectIntelligence);
        if ((data.projectIntelligence as any).yoloTags) {
          useViewerStore.getState().setYoloTags((data.projectIntelligence as any).yoloTags);
        }
      }

      // Hydrate demo feature config
      if (data.demoConfig) {
        useViewerStore.getState().setDemoFeatureConfig(data.demoConfig);
      }

      // Load summaries into the TanStack Query cache (facade — no longer a zustand field).
      // [refactor jul10 P2.2③] UNCONDITIONAL publicId-scoped seed (`?? null` in the helper):
      // reproduces reset-then-conditional-set net behavior; a conditional seed would retain a
      // stale same-key entry when the demo response omits summaries. Seed-before-reveal: runs
      // before setLoading(false); consumers unmount behind the `loading` gate. This is a
      // read-side cache write of server-provided data, NOT a persistence mutation — the
      // demo-never-writes invariant is untouched (SPEC §7).
      seedSummariesCache(queryClient, data.id, data.summaries);
      // [refactor jul10 P2.2④] Takeoff seed: the demo ProjectResponse OMITS takeoffItems/
      // takeoffGroups entirely (the old loader never seeded takeoff at all), so this lands
      // []/[] under the demo publicId — exactly today's post-reset state (SPEC §5-D3) — and
      // OVERWRITES any temp rows a previous demo visit left cached under the same publicId
      // (demo temps were already lost on reload). Read-side cache write of (absent)
      // server-provided data — the demo-never-writes invariant is untouched.
      seedTakeoffCache(queryClient, data.id, undefined, undefined);
      // Guard KEEPS its 4 piggybacks — allTrades/allCsiCodes/detection models AND the demo-only
      // setModelConfidence(name, 0) loop are separate, non-migrating zustand fields.
      if (data.summaries) {
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
      const drawingNumbers: Record<number, string | null> = {};
      for (const page of data.pages) {
        names[page.pageNumber] = page.drawingNumber || page.name;
        drawingNumbers[page.pageNumber] = page.drawingNumber;
      }
      setPageNames(names);
      setPageDrawingNumbers(drawingNumbers);

      if (csiParam) setCsiFilter(csiParam);
      if (qParam) useViewerStore.getState().setSearch(qParam);

      // ─── Hydrate initial chunk (already fetched in parallel above) ───
      if (!chunkRes.ok) {
        // Demo reload clears both cached halves when its optional initial chunk request fails.
        publishBootstrapPageWindow(queryClient, data.id, null, data.numPages);
      }
      if (chunkRes.ok) {
        let chunk: PageWindowResponse;
        try {
          chunk = await chunkRes.json();
        } catch (parseError) {
          publishBootstrapPageWindow(queryClient, data.id, null, data.numPages);
          throw parseError;
        }

        // Annotation-first paired publication. Demo intentionally has no scale-hydration piggyback.
        publishBootstrapPageWindow(queryClient, data.id, chunk, data.numPages);

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
  }, [id, setProjectId, setPublicId, setDataUrl, setNumPages, initDetectionModels, setPageNames, setPageDrawingNumbers, setAllTrades, setAllCsiCodes, setIsDemo, resetProjectData, csiParam, qParam, setCsiFilter, queryClient]);

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
