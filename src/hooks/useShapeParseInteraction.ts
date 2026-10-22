"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/sessionStore";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useNavigation } from "@/stores/viewerCoreStore";
import { useUiStore } from "@/stores/uiStore";
import {
  consumeTableParseRegionForShape,
  setTableParseStepWithTool,
} from "@/stores/viewerCommands";
import {
  appendKeynotesForPage,
  mergeKeynotesByPage,
} from "@/queries/usePageWindow";
import { writeAnns } from "@/queries/useAnnotations";
import type { ClientAnnotation, KeynoteShapeData } from "@/types";
// [refactor jul5 S028] apiErrorMessage: shape-parse now serves {error:{code,message}} for
// cascade errors (demo-gate 403 stays flat — apiErrorMessage reads both shapes).
import { apiErrorMessage } from "@/lib/client-persist";
import { useProjectLifecycleGuard } from "@/hooks/useProjectLifecycleGuard";

export interface UseShapeParseInteractionOpts {
  detectionTab: "models" | "tags" | "shape";
}

/** [fix 2026-10-21] What /api/shape-parse stored (non-demo projects): mirror it exactly. */
interface ShapeParsePersisted {
  pages: Record<number, KeynoteShapeData[] | null>;
  annotations: ClientAnnotation[];
  removedAnnotationIds: number[];
}

/**
 * The server already swapped these pages in the DB, so the cache takes the stored state
 * verbatim — page keynotes REPLACED (not appended: a repeat run must not double them) and the
 * page's swapped shape-parse annotations replaced by the inserted rows.
 */
function adoptPersisted(qc: QueryClient, publicId: string, persisted: ShapeParsePersisted): void {
  const byPage: Record<number, KeynoteShapeData[]> = {};
  for (const [pn, keynotes] of Object.entries(persisted.pages)) byPage[Number(pn)] = keynotes ?? [];
  mergeKeynotesByPage(qc, publicId, byPage);
  const removed = new Set(persisted.removedAnnotationIds);
  writeAnns(qc, publicId, (current) => [
    ...current.filter((a) => !removed.has(a.id)),
    ...persisted.annotations,
  ]);
}

function pageFailureWarning(data: { failedPages?: unknown[] }): string[] {
  const n = Array.isArray(data.failedPages) ? data.failedPages.length : 0;
  return n > 0 ? [`${n} page(s) could not be scanned — their previous shapes were kept`] : [];
}

export function useShapeParseInteraction({ detectionTab }: UseShapeParseInteractionOpts) {
  const queryClient = useQueryClient();
  const { pageNumber } = useNavigation();

  const projectId = useSessionStore((s) => s.projectId);
  const publicId = useSessionStore((s) => s.publicId);
  const isDemo = useSessionStore((s) => s.isDemo);
  const isRenderedLifecycleCurrent = useProjectLifecycleGuard(publicId, isDemo);
  const tableParseRegion = useParseFlowStore((s) => s.tableParseRegion);
  const tableRevision = useParseFlowStore((s) => s.parseOperations.table.revision);
  const showKeynotes = useUiStore((s) => s.showKeynotes);
  const toggleKeynotes = useUiStore((s) => s.toggleKeynotes);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [region, setRegion] = useState<[number, number, number, number] | null>(null);
  const [drawing, setDrawing] = useState(false);
  const drawingAuthorityRef = useRef<(() => boolean) | null>(null);

  // Tear down local hook state when the user switches projects. The neutral resetProjectData
  // coordinator clears the shared leaf-store fields (tableParseStep,
  // activeTool discriminator, etc.) but cannot reach React useState owned by this
  // hook, so DetectionPanel staying mounted across a project switch caused the
  // prior project's drawn BB + drawing flag to bleed into the next project.
  // Comparing the previous projectId via a ref scopes the effect strictly to
  // project transitions (not initial mount) to avoid resetting while the user
  // is still mid-draw on first open.
  const prevProjectIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevProjectIdRef.current !== null && prevProjectIdRef.current !== projectId) {
      setRegion(null);
      setDrawing(false);
      setLoading(false);
      setError(null);
      setWarnings([]);
      drawingAuthorityRef.current = null;
    }
    prevProjectIdRef.current = projectId ?? null;
  }, [projectId]);

  // When the Shape tab is active and the user draws a region via the shared
  // select-region mode, consume the tableParseRegion so it doesn't bleed into
  // the Table tab. drawing stays true so the BB button stays green until the
  // user explicitly clears via startRegionDraw or the × button.
  useEffect(() => {
    if (detectionTab !== "shape" || !drawing || !tableParseRegion) return;
    const canPublish = drawingAuthorityRef.current;
    if (!canPublish?.()) return;
    if (!consumeTableParseRegionForShape(tableParseRegion, tableRevision)) return;
    if (!canPublish()) return;
    setRegion(tableParseRegion as [number, number, number, number]);
  }, [detectionTab, drawing, tableParseRegion, tableRevision]);

  // When the user leaves the Shape tab with draw-mode still engaged, release
  // the shared tableParseStep so the Table Parse tab doesn't inherit a
  // "select-region" step it never entered.
  useEffect(() => {
    if (detectionTab !== "shape" && drawing) {
      const canPublish = drawingAuthorityRef.current;
      setDrawing(false);
      setRegion(null);
      drawingAuthorityRef.current = null;
      if (canPublish?.()) setTableParseStepWithTool("idle", "move");
    }
  }, [detectionTab, drawing]);

  const startRegionDraw = useCallback(() => {
    // Click-to-toggle: if already engaged (drawing mode OR region already
    // drawn), this click cancels; otherwise enter draw mode.
    if (drawing || region !== null) {
      const canPublish = drawingAuthorityRef.current;
      setDrawing(false);
      setRegion(null);
      drawingAuthorityRef.current = null;
      if (canPublish?.()) setTableParseStepWithTool("idle", "move");
    } else {
      if (!isRenderedLifecycleCurrent()) return;
      drawingAuthorityRef.current = isRenderedLifecycleCurrent;
      setDrawing(true);
      if (!isRenderedLifecycleCurrent()) return;
      setTableParseStepWithTool("select-region", "pointer");
    }
  }, [drawing, region, isRenderedLifecycleCurrent]);

  const runOnPage = useCallback(async () => {
    if (!projectId || !publicId || loading || !isRenderedLifecycleCurrent()) return;
    const canAdoptLifecycle = isRenderedLifecycleCurrent;
    setLoading(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await fetch("/api/shape-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, pageNumber, regionBbox: region || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (canAdoptLifecycle()) {
          setError(apiErrorMessage(err) || `Failed (${res.status})`);
        }
        return;
      }
      const data = await res.json();
      if (!canAdoptLifecycle()) return;
      // [refactor jul11 P2.2⑦] Append against the response-time value under the request's captured
      // project identity. This preserves the old live post-await append without allowing a late A
      // response to write into whichever project happens to be globally open at settlement.
      if (data.persisted) adoptPersisted(queryClient, publicId, data.persisted);
      else appendKeynotesForPage(queryClient, publicId, pageNumber, data.keynotes || []);
      if (!canAdoptLifecycle()) return;
      if (data.warnings?.length) setWarnings(data.warnings);
      if (!canAdoptLifecycle()) return;
      if (!showKeynotes) toggleKeynotes();
    } catch (err) {
      if (canAdoptLifecycle()) {
        setError(err instanceof Error ? err.message : "Network error");
      }
    } finally {
      if (canAdoptLifecycle()) setLoading(false);
    }
  }, [
    projectId,
    publicId,
    loading,
    pageNumber,
    region,
    queryClient,
    showKeynotes,
    toggleKeynotes,
    isRenderedLifecycleCurrent,
  ]);

  const runOnAll = useCallback(async () => {
    if (!projectId || !publicId || loading || !isRenderedLifecycleCurrent()) return;
    const canAdoptLifecycle = isRenderedLifecycleCurrent;
    setLoading(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await fetch("/api/shape-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, scanAll: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (canAdoptLifecycle()) {
          setError(apiErrorMessage(err) || `Failed (${res.status})`);
        }
        return;
      }
      const data = await res.json();
      if (!canAdoptLifecycle()) return;
      if (data.persisted) adoptPersisted(queryClient, publicId, data.persisted);
      else if (data.byPage) mergeKeynotesByPage(queryClient, publicId, data.byPage);
      if (!canAdoptLifecycle()) return;
      const allWarnings = [...pageFailureWarning(data), ...(data.warnings ?? [])];
      if (allWarnings.length) setWarnings(allWarnings);
      if (!canAdoptLifecycle()) return;
      if (!showKeynotes) toggleKeynotes();
    } catch (err) {
      if (canAdoptLifecycle()) {
        setError(err instanceof Error ? err.message : "Network error");
      }
    } finally {
      if (canAdoptLifecycle()) setLoading(false);
    }
  }, [
    projectId,
    publicId,
    loading,
    queryClient,
    showKeynotes,
    toggleKeynotes,
    isRenderedLifecycleCurrent,
  ]);

  return {
    loading,
    error,
    warnings,
    region,
    drawing,
    setError,
    setRegion,
    setDrawing,
    startRegionDraw,
    runOnPage,
    runOnAll,
  };
}
