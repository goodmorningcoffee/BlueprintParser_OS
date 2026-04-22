"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useViewerStore, useSummaries, useProject } from "@/stores/viewerStore";
import ParsedTableItem from "./ParsedTableItem";
import AutoParseTab from "./AutoParseTab";
import GuidedParseTab from "./GuidedParseTab";
import ManualParseTab from "./ManualParseTab";
import CompareEditTab from "./CompareEditTab";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import ExportCsvModal from "./ExportCsvModal";
import type { MapTagsStrictness } from "./MapTagsSection";
import type { YoloTag, QtoItemType } from "@/types";
import type { ScoredMatch } from "@/lib/tag-mapping";

/**
 * TableParsePanel — Orchestrator for table/schedule parsing.
 * Delegates to tab components: AutoParseTab, ManualParseTab, CompareEditTab.
 * All Tables tab is rendered inline (small).
 */
export default function TableParsePanel() {
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const pageIntelligence = useViewerStore((s) => s.pageIntelligence);
  const toggleTableParsePanel = useViewerStore((s) => s.toggleTableParsePanel);
  const tableParseRegion = useViewerStore((s) => s.tableParseRegion);
  const setTableParseRegion = useViewerStore((s) => s.setTableParseRegion);
  const tableParsedGrid = useViewerStore((s) => s.tableParsedGrid);
  const setTableParsedGrid = useViewerStore((s) => s.setTableParsedGrid);
  const resetTableParse = useViewerStore((s) => s.resetTableParse);
  const resetAllTools = useViewerStore((s) => s.resetAllTools);
  const tableParseStep = useViewerStore((s) => s.tableParseStep);
  const setTableParseStep = useViewerStore((s) => s.setTableParseStep);
  const toggleTableCompareModal = useViewerStore((s) => s.toggleTableCompareModal);
  const setPage = useViewerStore((s) => s.setPage);
  const tableParseTab = useViewerStore((s) => s.tableParseTab);
  const setTableParseTab = useViewerStore((s) => s.setTableParseTab);
  const pageNames = useViewerStore((s) => s.pageNames);
  const pageDrawingNumbers = useViewerStore((s) => s.pageDrawingNumbers);
  const annotations = useViewerStore((s) => s.annotations);
  const addYoloTagsBulk = useViewerStore((s) => s.addYoloTagsBulk);
  const yoloTags = useViewerStore((s) => s.yoloTags);
  const showParsedRegions = useViewerStore((s) => s.showParsedRegions);
  const toggleParsedRegions = useViewerStore((s) => s.toggleParsedRegions);
  const parsedRegionColorMode = useViewerStore((s) => s.parsedRegionColorMode);
  const setParsedRegionColorMode = useViewerStore((s) => s.setParsedRegionColorMode);
  const focusedParsedRegionId = useViewerStore((s) => s.focusedParsedRegionId);
  const { publicId } = useProject();
  const setPageIntelligence = useViewerStore((s) => s.setPageIntelligence);

  const [showExportModal, setShowExportModal] = useState(false);
  // Guards against double-click save stacking duplicates. Ref (not state) so
  // the guard doesn't trigger renders but still blocks re-entry during the
  // async /api/csi/detect + /api/pages/intelligence round-trip. The visible
  // "Save button vanishes after success" UX is handled by resetTableParse()
  // at the end of the happy path — tableParsedGrid goes null, which unmounts
  // the review-step Save button.
  const isSavingRef = useRef(false);

  // ─── Shared state for Map Tags (used by Auto + Manual tabs) ───
  const [tagYoloClass, setTagYoloClass] = useState<{ model: string; className: string } | null>(null);
  const [tagMappingDone, setTagMappingDone] = useState(false);
  const [tagMappingCount, setTagMappingCount] = useState(0);
  // Phase 3: strictness + scope UI for the server-side Map Tags route.
  const [mapTagsStrictness, setMapTagsStrictness] = useState<MapTagsStrictness>("balanced");
  const [drawingNumberPrefixes, setDrawingNumberPrefixes] = useState<string[]>([]);
  const [lastDropCounts, setLastDropCounts] = useState<Record<string, number> | null>(null);
  const mapTagsAbortRef = useRef<AbortController | null>(null);
  // Cleanup any in-flight fetch if the panel unmounts mid-request.
  useEffect(() => () => { mapTagsAbortRef.current?.abort(); }, []);
  // Derive available drawing-number prefixes from loaded pages. Leading
  // non-digit chars up to the first digit, uppercased. `""` represents
  // pages without a drawingNumber (or ones starting with a digit) —
  // rendered as an "Unnumbered" chip.
  const availablePrefixes = useMemo(() => {
    const set = new Set<string>();
    for (const num of Object.values(pageDrawingNumbers)) {
      const match = num ? num.match(/^[^\d]+/) : null;
      set.add((match?.[0] ?? "").toUpperCase());
    }
    return Array.from(set).sort();
  }, [pageDrawingNumbers]);

  const intel = pageIntelligence[pageNumber] as any;

  // ─── Save parsed grid to pageIntelligence ─────────────────
  const saveParsedToIntelligence = useCallback((grid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string; tableName?: string; csiTags?: { code: string; description: string }[]; colBoundaries?: number[]; rowBoundaries?: number[] }) => {
    const currentRegion = useViewerStore.getState().tableParseRegion;
    const currentIntel = useViewerStore.getState().pageIntelligence[pageNumber] || {};
    const existingRegions = (currentIntel as any)?.parsedRegions || [];
    const newRegion = {
      id: `parsed-${Date.now()}`,
      type: "schedule" as const,
      category: grid.tableName || "unknown-table",
      bbox: currentRegion || [0, 0, 1, 1],
      confidence: 0.9,
      csiTags: grid.csiTags || [],
      data: {
        headers: grid.headers,
        rows: grid.rows,
        tagColumn: grid.tagColumn,
        tableName: grid.tableName,
        rowCount: grid.rows.length,
        columnCount: grid.headers.length,
        ...(grid.colBoundaries ? { colBoundaries: grid.colBoundaries } : {}),
        ...(grid.rowBoundaries ? { rowBoundaries: grid.rowBoundaries } : {}),
      },
    };
    setPageIntelligence(pageNumber, {
      ...currentIntel,
      parsedRegions: [...existingRegions, newRegion],
    });
  }, [pageNumber, setPageIntelligence]);

  // ─── CSI detect + persist to DB ───────────────────────────
  // Throws on DB PATCH failure so callers can surface the error to the user
  // instead of showing a successful-looking in-memory save that won't survive
  // project re-entry. The previous silent-catch variant was the root cause
  // of the "parsed tables disappear on re-entry" bug: when PATCH returned an
  // error (stale session, payload too large, etc.), local state had the
  // region but the DB never did, so next load hydrated without it.
  //
  // Post-success: resets all parse + Map Tags state and reverts the tab to
  // its idle step, so double-click saves can't stack N identical rows and the
  // user lands back at "pick a parse mode" ready to start the next one.
  const detectCsiAndPersist = useCallback(async (grid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string; tableName?: string; csiTags?: { code: string; description: string }[]; colBoundaries?: number[]; rowBoundaries?: number[] }) => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    try {
      if (!grid.csiTags || grid.csiTags.length === 0) {
        try {
          const resp = await fetch("/api/csi/detect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ headers: grid.headers, rows: grid.rows }),
          });
          if (resp.ok) {
            const data = await resp.json();
            grid.csiTags = data.csiTags || [];
          }
        } catch { /* CSI detection is best-effort */ }
      }
      saveParsedToIntelligence(grid);
      refreshPageCsiSpatialMap(pageNumber);
      const { projectId: pid, isDemo } = useViewerStore.getState();
      if (pid && !isDemo) {
        const currentIntel = useViewerStore.getState().pageIntelligence[pageNumber];
        let resp: Response;
        try {
          resp = await fetch("/api/pages/intelligence", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: pid, pageNumber, intelligence: currentIntel }),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Network error";
          console.error("[save-intelligence] Network error:", err);
          throw new Error(`Could not save parsed table: ${msg}`);
        }

        if (!resp.ok) {
          let detail = `HTTP ${resp.status}`;
          try {
            const errBody = await resp.json();
            if (errBody?.error) detail = errBody.error;
          } catch { /* non-json body */ }
          console.error("[save-intelligence] Failed:", resp.status, detail);
          throw new Error(`Could not save parsed table: ${detail}`);
        }

        try {
          const data = await resp.json();
          if (data?.summaries) useViewerStore.getState().setSummaries(data.summaries);
        } catch { /* response parse is best-effort — save succeeded */ }
      }

      // Success: revert the tab to its idle step so another parse can start
      // fresh. Without this, the user sees the same post-parse review UI and
      // clicking Save again inserts a second identical parsedRegion.
      resetTableParse();
      setTagMappingDone(false);
      setTagMappingCount(0);
      setLastDropCounts(null);
      setTagYoloClass(null);
    } finally {
      isSavingRef.current = false;
    }
  }, [pageNumber, saveParsedToIntelligence, resetTableParse]);

  // ─── Shared memos ─────────────────────────────────────────
  const autoDetectedTables = useMemo(() => {
    if (!intel?.classifiedTables) return [];
    return intel.classifiedTables.filter((t: any) =>
      ["door-schedule", "finish-schedule", "material-schedule", "keynote-table", "unknown-table"].includes(t.category)
    );
  }, [intel]);

  const existingParsed = useMemo(() => {
    if (!intel?.parsedRegions) return [];
    return intel.parsedRegions.filter((r: any) => r.type === "schedule");
  }, [intel]);

  const yoloInTableRegion = useMemo(() => {
    if (!tableParseRegion) return [];
    const region = tableParseRegion;
    const pageYolo = annotations.filter(
      (a) => a.source === "yolo" && a.pageNumber === pageNumber
    );
    const inside = pageYolo.filter((a) => {
      const [minX, minY, maxX, maxY] = a.bbox;
      return minX >= region[0] && maxX <= region[2] && minY >= region[1] && maxY <= region[3];
    });
    const groups: Record<string, { model: string; className: string; count: number }> = {};
    for (const a of inside) {
      const model = (a as any).data?.modelName || "unknown";
      const cls = a.name;
      const key = `${model}:${cls}`;
      if (!groups[key]) groups[key] = { model, className: cls, count: 0 };
      groups[key].count++;
    }
    return Object.values(groups).sort((a, b) => b.count - a.count);
  }, [tableParseRegion, annotations, pageNumber]);

  // ─── Map Tags: create YoloTags from parsed tag column ─────
  // Phase 3: fetch the server-side /api/map-tags-batch route so scoring
  // (pattern inference + scope + strictness) applies to the manual flow.
  // AbortController cancels the in-flight request on rapid re-clicks or
  // unmount. All results flow through addYoloTagsBulk as a single store
  // update to avoid N-rerenders from a batch.
  const handleMapTags = useCallback(async () => {
    if (!tableParsedGrid?.tagColumn || !tableParsedGrid.rows.length) return;
    if (!publicId) return;
    const tagCol = tableParsedGrid.tagColumn;
    const uniqueTags = [...new Set(
      tableParsedGrid.rows
        .map((r) => r[tagCol]?.trim())
        .filter((v): v is string => Boolean(v)),
    )];
    if (uniqueTags.length === 0) return;

    // Build a description map from the non-tag columns.
    const descByTag = new Map<string, string>();
    for (const t of uniqueTags) {
      const row = tableParsedGrid.rows.find((r) => r[tagCol]?.trim() === t);
      const desc = row
        ? tableParsedGrid.headers.filter((h) => h !== tagCol).map((h) => row[h] || "").join(" ").trim()
        : "";
      descByTag.set(t, desc.slice(0, 200));
    }

    // Explicit itemType — decouples the call from route defaults so future
    // route-default changes don't silently alter the manual Map Tags path.
    const itemType: QtoItemType = tagYoloClass?.className
      ? "yolo-with-inner-text"
      : "text-only";

    mapTagsAbortRef.current?.abort();
    const controller = new AbortController();
    mapTagsAbortRef.current = controller;

    try {
      const res = await fetch(`/api/projects/${publicId}/map-tags-batch`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tags: uniqueTags,
          yoloClass: tagYoloClass?.className || undefined,
          yoloModel: tagYoloClass?.model || undefined,
          itemType,
          strictnessMode: mapTagsStrictness,
          drawingNumberPrefixes,
        }),
      });
      if (!res.ok) {
        console.error(`[TableParsePanel] Map Tags failed: HTTP ${res.status}`);
        return; // leave tagMappingDone as-is so user can retry
      }
      const { results, dropCounts } = (await res.json()) as {
        results: Record<string, ScoredMatch[]>;
        dropCounts: Record<string, number>;
      };
      const newTags: YoloTag[] = uniqueTags
        .filter((t) => results[t]?.length > 0)
        .map((t) => ({
          id: `schedule-${pageNumber}-${t}-${Date.now()}`,
          name: t,
          tagText: t,
          yoloClass: tagYoloClass?.className || "",
          yoloModel: tagYoloClass?.model || "",
          source: "schedule",
          scope: "project",
          description: descByTag.get(t) || "",
          instances: results[t],
          // Snapshot scope + strictness so the browse UI can explain why
          // some mapped tags have fewer instances than the user expected.
          mapScope: {
            ...(drawingNumberPrefixes.length > 0 ? { drawingNumberPrefixes: [...drawingNumberPrefixes] } : {}),
            strictness: mapTagsStrictness,
          },
        }));
      addYoloTagsBulk(newTags);
      setTagMappingCount(newTags.length);
      setLastDropCounts(dropCounts);
      setTagMappingDone(true);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error("[TableParsePanel] Map Tags error", e);
    }
  }, [tableParsedGrid, tagYoloClass, pageNumber, publicId,
      mapTagsStrictness, drawingNumberPrefixes, addYoloTagsBulk]);

  // ─── Load existing parsed region ──────────────────────────
  const loadExistingParsed = useCallback(
    (parsed: any) => {
      const d = parsed.data;
      setTableParseRegion(parsed.bbox ? [parsed.bbox[0], parsed.bbox[1], parsed.bbox[2], parsed.bbox[3]] : null);
      setTableParsedGrid({
        headers: d.headers || [],
        rows: d.rows || [],
        tagColumn: d.tagColumn,
        tableName: d.tableName,
      });
      // Clear source-picker meta — this grid didn't come from the auto-parse
      // merger, so the per-method results from a prior parse are stale.
      useViewerStore.getState().setTableParseMeta(null);
      setTableParseStep("review");
      useViewerStore.getState().setMode("move");
    },
    [setTableParseRegion, setTableParsedGrid, setTableParseStep]
  );

  const { summaries } = useSummaries();

  // ─── Project-wide parsed tables ───────────────────────────
  // Combines summary catalog (all pages) with loaded pageIntelligence (chunk detail)
  const allParsedTables = useMemo(() => {
    const tables: { pageNum: number; region: any; name: string; category: string; rowCount: number; colCount: number; csiTags: any[] }[] = [];

    // Build set of pages we have detail data for (from loaded chunk)
    const loadedPages = new Set<number>();
    for (const [pn, intelEntry] of Object.entries(pageIntelligence)) {
      const pi = intelEntry as any;
      loadedPages.add(Number(pn));
      if (pi?.parsedRegions) {
        for (const pr of pi.parsedRegions) {
          if (pr.type === "schedule") {
            tables.push({
              pageNum: Number(pn),
              region: pr,
              name: pr.data?.tableName || pr.category || "Unnamed Table",
              category: pr.category,
              rowCount: pr.data?.rowCount || pr.data?.rows?.length || 0,
              colCount: pr.data?.columnCount || pr.data?.headers?.length || 0,
              csiTags: pr.csiTags || [],
            });
          }
        }
      }
    }

    // Add tables from summary that aren't in loaded chunk (lightweight entries)
    if (summaries?.parsedTables) {
      for (const pt of summaries.parsedTables) {
        if (!loadedPages.has(pt.pageNum)) {
          tables.push({
            pageNum: pt.pageNum,
            region: null, // No detail data — will load when user navigates to this page
            name: pt.name,
            category: pt.category,
            rowCount: pt.rowCount,
            colCount: pt.colCount,
            csiTags: [],
          });
        }
      }
    }

    return tables.sort((a, b) => {
      if (a.pageNum === pageNumber && b.pageNum !== pageNumber) return -1;
      if (b.pageNum === pageNumber && a.pageNum !== pageNumber) return 1;
      return a.pageNum - b.pageNum;
    });
  }, [summaries, pageIntelligence, pageNumber]);

  // Update the active parsed grid's tagColumn. Used by MapTagsSection's new
  // tag-column picker — auto-detection is a heuristic that misses when the
  // description column happens to match the tag regex. Letting the user
  // override is a prerequisite for any downstream tooling that expects
  // tag-authoritative data (Discrepancy Engine, find-occurrences, etc.).
  const handleTagColumnChange = useCallback((col: string) => {
    if (!tableParsedGrid) return;
    setTableParsedGrid({ ...tableParsedGrid, tagColumn: col });
  }, [tableParsedGrid, setTableParsedGrid]);

  // ─── Shared Map Tags props ────────────────────────────────
  const mapTagsProps = {
    tagYoloClass, setTagYoloClass, handleMapTags,
    tagMappingDone, tagMappingCount, setTagMappingDone,
    // Phase 3 — strictness + drawing-number-prefix scope + audit signal
    mapTagsStrictness, setMapTagsStrictness,
    drawingNumberPrefixes, setDrawingNumberPrefixes,
    availablePrefixes, lastDropCounts,
    // 2026-04-22 — user-overridable tag column picker
    onTagColumnChange: handleTagColumnChange,
  };

  // ─── Render ───────────────────────────────────────────────
  return (
    <div className="w-80 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Schedules / Tables</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleParsedRegions}
            className={`text-sm px-1 ${showParsedRegions ? "text-pink-300" : "text-[var(--muted)]/30"}`}
            title={showParsedRegions ? "Hide region outlines" : "Show region outlines"}
          >
            {showParsedRegions ? "\u25CF" : "\u25CB"}
          </button>
          {showParsedRegions && (
            <div className="flex items-center border border-[var(--border)] rounded">
              {(["none", "striped", "checkerboard"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setParsedRegionColorMode(mode)}
                  className={`px-1.5 py-0.5 text-[9px] ${
                    parsedRegionColorMode === mode
                      ? "bg-[var(--accent)] text-white"
                      : "text-[var(--muted)] hover:text-[var(--fg)]"
                  } ${mode === "none" ? "rounded-l" : mode === "checkerboard" ? "rounded-r" : ""}`}
                  title={mode === "none" ? "No cell shading" : mode === "striped" ? "Alternating row colors" : "Checkerboard cells"}
                >
                  {mode === "none" ? "Off" : mode === "striped" ? "Rows" : "Grid"}
                </button>
              ))}
            </div>
          )}
          {tableParseStep !== "idle" && (
            <button
              onClick={resetAllTools}
              className="text-[10px] px-2 py-0.5 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
              title="Cancel the current parse (clears BBs + region, stays on this tab)"
            >
              Cancel
            </button>
          )}
          <button onClick={toggleTableParsePanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">
            &times;
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["all", "auto", "guided", "manual", "compare"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => {
              setTableParseTab(tab);
              useViewerStore.getState().setMode("move");
            }}
            className={`flex-1 px-1.5 py-1.5 text-[9px] font-medium ${
              tableParseTab === tab
                ? "text-pink-300 border-b-2 border-pink-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {tab === "all" ? "All Tables" : tab === "auto" ? "Auto Parse" : tab === "guided" ? "Guided" : tab === "manual" ? "Manual" : "Compare/Edit Cells"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
        {/* ════════ TAB: All Tables ════════ */}
        {tableParseTab === "all" && (
          <div className="space-y-1">
            {allParsedTables.length === 0 ? (
              <div className="text-[10px] text-[var(--muted)] text-center py-8 px-2">
                No parsed tables found.
                <br />
                <span className="text-[9px]">Tables are auto-parsed at upload, or use Auto Parse / Manual tabs.</span>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-1 pb-1">
                  <span className="text-[10px] text-[var(--muted)]">{allParsedTables.length} table(s)</span>
                  <button
                    onClick={() => setShowExportModal(true)}
                    className="text-[10px] px-2 py-0.5 rounded border border-[var(--accent)]/40 text-[var(--accent)] hover:bg-[var(--accent)]/10"
                  >
                    Export CSV
                  </button>
                </div>
                {showExportModal && (
                  <ExportCsvModal
                    tables={allParsedTables.map((t) => ({
                      name: t.name,
                      headers: t.region.data?.headers || [],
                      rows: t.region.data?.rows || [],
                      pageNumber: t.pageNum,
                    }))}
                    onClose={() => setShowExportModal(false)}
                    filenamePrefix="schedules"
                  />
                )}
                {allParsedTables.map((t, i) => (
                  <ParsedTableItem
                    key={i}
                    table={t}
                    pageNames={pageNames}
                    isCurrentPage={t.pageNum === pageNumber}
                    onNavigate={() => setPage(t.pageNum)}
                    yoloTags={yoloTags}
                    pageNumber={pageNumber}
                    publicId={publicId}
                    focusedParsedRegionId={focusedParsedRegionId}
                    onDelete={() => {
                      const pi = useViewerStore.getState().pageIntelligence[t.pageNum] || {};
                      const regions = ((pi as any)?.parsedRegions || []).filter((r: any) => r.id !== t.region.id);
                      useViewerStore.getState().setPageIntelligence(t.pageNum, { ...pi, parsedRegions: regions });
                    }}
                  />
                ))}
              </>
            )}
          </div>
        )}

        {/* ════════ TAB: Auto Parse ════════ */}
        {tableParseTab === "auto" && (
          <AutoParseTab
            autoDetectedTables={autoDetectedTables}
            existingParsed={existingParsed}
            yoloInTableRegion={yoloInTableRegion}
            loadExistingParsed={loadExistingParsed}
            detectCsiAndPersist={detectCsiAndPersist}
            {...mapTagsProps}
          />
        )}

        {/* ════════ TAB: Guided Parse ════════ */}
        {tableParseTab === "guided" && (
          <GuidedParseTab
            detectCsiAndPersist={detectCsiAndPersist}
            yoloInTableRegion={yoloInTableRegion}
            {...mapTagsProps}
          />
        )}

        {/* ════════ TAB: Manual Parse ════════ */}
        {tableParseTab === "manual" && (
          <ManualParseTab
            yoloInTableRegion={yoloInTableRegion}
            detectCsiAndPersist={detectCsiAndPersist}
            {...mapTagsProps}
          />
        )}

        {/* ════════ TAB: Compare/Edit Cells ════════ */}
        {tableParseTab === "compare" && (
          <CompareEditTab
            allParsedTables={allParsedTables}
            loadExistingParsed={loadExistingParsed}
            toggleTableCompareModal={toggleTableCompareModal}
          />
        )}
      </div>
    </div>
  );
}
