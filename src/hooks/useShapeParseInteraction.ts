"use client";

import { useCallback, useEffect, useState } from "react";
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

  // When the Shape tab is active and the user draws a region via the shared
  // select-region mode, consume the tableParseRegion so it doesn't bleed into
  // the Table tab. drawing stays true so the BB button stays green until the
  // user explicitly clears via startRegionDraw or the × button.
  useEffect(() => {
    if (detectionTab !== "shape" || !drawing || !tableParseRegion) return;
    setRegion(tableParseRegion as [number, number, number, number]);
    setTableParseRegion(null);
  }, [detectionTab, drawing, tableParseRegion, setTableParseRegion]);

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
