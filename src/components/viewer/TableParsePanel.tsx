"use client";

import { useMemo, useState, useCallback } from "react";
import { useViewerStore, useSummaries } from "@/stores/viewerStore";
import ParsedTableItem from "./ParsedTableItem";
import AutoParseTab from "./AutoParseTab";
import ManualParseTab from "./ManualParseTab";
import CompareEditTab from "./CompareEditTab";
import { mapYoloToOcrText } from "@/lib/yolo-tag-engine";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import ExportCsvModal from "./ExportCsvModal";

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
  const setTableParseStep = useViewerStore((s) => s.setTableParseStep);
  const toggleTableCompareModal = useViewerStore((s) => s.toggleTableCompareModal);
  const setPage = useViewerStore((s) => s.setPage);
  const tableParseTab = useViewerStore((s) => s.tableParseTab);
  const setTableParseTab = useViewerStore((s) => s.setTableParseTab);
  const pageNames = useViewerStore((s) => s.pageNames);
  const annotations = useViewerStore((s) => s.annotations);
  const addYoloTag = useViewerStore((s) => s.addYoloTag);
  const yoloTags = useViewerStore((s) => s.yoloTags);
  const showParsedRegions = useViewerStore((s) => s.showParsedRegions);
  const toggleParsedRegions = useViewerStore((s) => s.toggleParsedRegions);
  const setPageIntelligence = useViewerStore((s) => s.setPageIntelligence);

  const [showExportModal, setShowExportModal] = useState(false);

  // ─── Shared state for Map Tags (used by Auto + Manual tabs) ───
  const [tagYoloClass, setTagYoloClass] = useState<{ model: string; className: string } | null>(null);
  const [tagMappingDone, setTagMappingDone] = useState(false);
  const [tagMappingCount, setTagMappingCount] = useState(0);

  const intel = pageIntelligence[pageNumber] as any;

  // ─── Save parsed grid to pageIntelligence ─────────────────
  const saveParsedToIntelligence = useCallback((grid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string; tableName?: string; csiTags?: { code: string; description: string }[] }) => {
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
      },
    };
    setPageIntelligence(pageNumber, {
      ...currentIntel,
      parsedRegions: [...existingRegions, newRegion],
    });
  }, [pageNumber, setPageIntelligence]);

  // ─── CSI detect + persist to DB ───────────────────────────
  const detectCsiAndPersist = useCallback(async (grid: { headers: string[]; rows: Record<string, string>[]; tagColumn?: string; tableName?: string; csiTags?: { code: string; description: string }[] }) => {
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
      fetch("/api/pages/intelligence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: pid, pageNumber, intelligence: currentIntel }),
      }).catch(() => {});
    }
  }, [pageNumber, saveParsedToIntelligence]);

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
  const handleMapTags = useCallback(() => {
    if (!tableParsedGrid?.tagColumn || !tableParsedGrid.rows.length) return;
    const tagCol = tableParsedGrid.tagColumn;
    const uniqueTags = new Set<string>();
    for (const row of tableParsedGrid.rows) {
      const val = row[tagCol]?.trim();
      if (val) uniqueTags.add(val);
    }
    const allAnns = useViewerStore.getState().annotations;
    const td = useViewerStore.getState().textractData;
    let count = 0;
    for (const tagText of uniqueTags) {
      const row = tableParsedGrid.rows.find((r) => r[tagCol]?.trim() === tagText);
      const desc = row
        ? tableParsedGrid.headers.filter((h) => h !== tagCol).map((h) => row[h] || "").join(" ").trim()
        : "";
      const instances = mapYoloToOcrText({
        tagText,
        yoloClass: tagYoloClass?.className,
        yoloModel: tagYoloClass?.model,
        scope: "project",
        annotations: allAnns,
        textractData: td,
      });
      addYoloTag({
        id: `schedule-${pageNumber}-${tagText}-${Date.now()}`,
        name: tagText,
        tagText,
        yoloClass: tagYoloClass?.className || "",
        yoloModel: tagYoloClass?.model || "",
        source: "schedule",
        scope: "project",
        description: desc.slice(0, 200),
        instances,
      });
      count++;
    }
    setTagMappingDone(true);
    setTagMappingCount(count);
  }, [tableParsedGrid, tagYoloClass, pageNumber, addYoloTag]);

  // ─── Load existing parsed region ──────────────────────────
  const loadExistingParsed = useCallback(
    (parsed: any) => {
      const d = parsed.data;
      setTableParseRegion(parsed.bbox ? [parsed.bbox[0], parsed.bbox[1], parsed.bbox[2], parsed.bbox[3]] : null);
      setTableParsedGrid({
        headers: d.headers || [],
        rows: d.rows || [],
        tagColumn: d.tagColumn,
      });
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

  // ─── Shared Map Tags props ────────────────────────────────
  const mapTagsProps = {
    tagYoloClass, setTagYoloClass, handleMapTags,
    tagMappingDone, tagMappingCount, setTagMappingDone,
  };

  // ─── Render ───────────────────────────────────────────────
  return (
    <div className="w-80 flex flex-col h-full border-l border-[var(--border)] bg-[var(--bg)]">
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
          <button onClick={toggleTableParsePanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">
            &times;
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["all", "auto", "manual", "compare"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => {
              if (tab !== tableParseTab) {
                resetTableParse();
                useViewerStore.getState().setMode("move");
              }
              setTableParseTab(tab);
            }}
            className={`flex-1 px-1.5 py-1.5 text-[9px] font-medium ${
              tableParseTab === tab
                ? "text-pink-300 border-b-2 border-pink-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {tab === "all" ? "All Tables" : tab === "auto" ? "Auto Parse" : tab === "manual" ? "Manual" : "Compare/Edit Cells"}
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
