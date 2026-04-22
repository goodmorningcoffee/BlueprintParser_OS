"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useViewerStore, useNavigation, usePageData } from "@/stores/viewerStore";

export interface UseShapeParseInteractionOpts {
  detectionTab: "models" | "tags" | "shape";
}

export function useShapeParseInteraction({ detectionTab }: UseShapeParseInteractionOpts) {
  const { pageNumber } = useNavigation();
  const { setKeynotes, setBatchKeynotes } = usePageData();

  const projectId = useViewerStore((s) => s.projectId);
  const tableParseRegion = useViewerStore((s) => s.tableParseRegion);
  const setTableParseRegion = useViewerStore((s) => s.setTableParseRegion);
  const setTableParseStep = useViewerStore((s) => s.setTableParseStep);
  const setMode = useViewerStore((s) => s.setMode);
  const showKeynotes = useViewerStore((s) => s.showKeynotes);
  const toggleKeynotes = useViewerStore((s) => s.toggleKeynotes);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [region, setRegion] = useState<[number, number, number, number] | null>(null);
  const [drawing, setDrawing] = useState(false);

  // Tear down local hook state when the user switches projects. resetProjectData
  // in viewerStore clears the shared store fields (tableParseStep,
  // symbolSearchActive, etc.) but cannot reach React useState owned by this
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
    }
    prevProjectIdRef.current = projectId ?? null;
  }, [projectId]);

  // When the Shape tab is active and the user draws a region via the shared
  // select-region mode, consume the tableParseRegion so it doesn't bleed into
  // the Table tab. drawing stays true so the BB button stays green until the
  // user explicitly clears via startRegionDraw or the × button.
  useEffect(() => {
    if (detectionTab !== "shape" || !drawing || !tableParseRegion) return;
    setRegion(tableParseRegion as [number, number, number, number]);
    setTableParseRegion(null);
  }, [detectionTab, drawing, tableParseRegion, setTableParseRegion]);

  // When the user leaves the Shape tab with draw-mode still engaged, release
  // the shared tableParseStep so the Table Parse tab doesn't inherit a
  // "select-region" step it never entered.
  useEffect(() => {
    if (detectionTab !== "shape" && drawing) {
      setDrawing(false);
      setRegion(null);
      setTableParseStep("idle");
      setMode("move");
    }
  }, [detectionTab, drawing, setTableParseStep, setMode]);

  const startRegionDraw = useCallback(() => {
    // Click-to-toggle: if already engaged (drawing mode OR region already
    // drawn), this click cancels; otherwise enter draw mode.
    if (drawing || region !== null) {
      setDrawing(false);
      setRegion(null);
      setMode("move");
      setTableParseStep("idle");
    } else {
      setDrawing(true);
      setTableParseStep("select-region");
      setMode("pointer");
    }
  }, [drawing, region, setMode, setTableParseStep]);

  const runOnPage = useCallback(async () => {
    if (!projectId || loading) return;
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
        setError(err.error || `Failed (${res.status})`);
        return;
      }
      const data = await res.json();
      // Append-only: multiple BB parses on the same page accumulate as pending
      // shapes. The Save button flushes them; re-parsing adds more on top.
      const existingPending = useViewerStore.getState().keynotes[pageNumber] ?? [];
      setKeynotes(pageNumber, [...existingPending, ...(data.keynotes || [])]);
      if (data.warnings?.length) setWarnings(data.warnings);
      if (!showKeynotes) toggleKeynotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [projectId, loading, pageNumber, region, setKeynotes, showKeynotes, toggleKeynotes]);

  const runOnAll = useCallback(async () => {
    if (!projectId || loading) return;
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
        setError(err.error || `Failed (${res.status})`);
        return;
      }
      const data = await res.json();
      if (data.byPage) setBatchKeynotes(data.byPage);
      if (data.warnings?.length) setWarnings(data.warnings);
      if (!showKeynotes) toggleKeynotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [projectId, loading, setBatchKeynotes, showKeynotes, toggleKeynotes]);

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
