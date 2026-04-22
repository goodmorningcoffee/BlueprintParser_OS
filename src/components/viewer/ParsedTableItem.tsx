"use client";

import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { YoloTag } from "@/types";
import type { ScoredMatch } from "@/lib/tag-mapping";
import type { MapTagsStrictness } from "./MapTagsSection";

interface ParsedTableItemProps {
  table: { pageNum: number; region: any; name: string; category: string; rowCount: number; colCount: number; csiTags: any[] };
  pageNames: Record<number, string>;
  isCurrentPage: boolean;
  onNavigate: () => void;
  yoloTags: any[];
  pageNumber: number;
  publicId: string;
  onDelete: () => void;
  focusedParsedRegionId?: string | null;
}

/** Expandable parsed table item with tag sub-items */
export default memo(function ParsedTableItem({
  table,
  pageNames,
  isCurrentPage,
  onNavigate,
  yoloTags,
  pageNumber,
  publicId,
  onDelete,
  focusedParsedRegionId,
}: ParsedTableItemProps) {
  const itemRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(table.name);
  const [editingRowIdx, setEditingRowIdx] = useState<number | null>(null);
  const [editCsi, setEditCsi] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editingColIdx, setEditingColIdx] = useState<number | null>(null);
  const [colEditValue, setColEditValue] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsCsi, setSettingsCsi] = useState((table.region?.data?.manualCsi || ""));
  const [settingsNotes, setSettingsNotes] = useState((table.region?.data?.notes || ""));
  const [settingsColor, setSettingsColor] = useState((table.region?.data?.color || "#e879a0"));
  const [settingsOpacity, setSettingsOpacity] = useState((table.region?.data?.opacity ?? 30));
  const [showMapTags, setShowMapTags] = useState(false);
  const [mapTagColumn, setMapTagColumn] = useState<string>("");
  const [mapTagType, setMapTagType] = useState<"free-floating" | "yolo">("free-floating");
  const [mapYoloClass, setMapYoloClass] = useState<{ model: string; className: string } | null>(null);
  const [mapping, setMapping] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  // Phase 4 — inline strictness + drawing-number-prefix scope for the
  // per-table Map Tags panel. Mirror the TableParsePanel selector UX,
  // but condensed (stacked chip rows inside the existing panel).
  const [mapStrictness, setMapStrictness] = useState<MapTagsStrictness>("balanced");
  const [mapPrefixes, setMapPrefixes] = useState<string[]>([]);
  const pageDrawingNumbers = useViewerStore((s) => s.pageDrawingNumbers);
  const availablePrefixes = useMemo(() => {
    const set = new Set<string>();
    for (const num of Object.values(pageDrawingNumbers)) {
      const match = num ? num.match(/^[^\d]+/) : null;
      set.add((match?.[0] ?? "").toUpperCase());
    }
    return Array.from(set).sort();
  }, [pageDrawingNumbers]);
  const togglePrefix = useCallback((prefix: string) => {
    setMapPrefixes((prev) =>
      prev.includes(prefix) ? prev.filter((p) => p !== prefix) : [...prev, prefix],
    );
  }, []);

  // Reactive selectors for render-path (not getState)
  const activeYoloTagId = useViewerStore((s) => s.activeYoloTagId);
  const activeTableTagViews = useViewerStore((s) => s.activeTableTagViews);
  const isTagViewActive = table.region?.id ? !!activeTableTagViews[table.region.id] : false;
  const hiddenParsedRegionIds = useViewerStore((s) => s.hiddenParsedRegionIds);
  const isRegionHidden = table.region?.id ? hiddenParsedRegionIds.has(table.region.id) : false;
  const isFocused = focusedParsedRegionId != null && focusedParsedRegionId === table.region?.id;
  const tableCellStructure = useViewerStore((s) => s.tableCellStructure);
  const [detectingCells, setDetectingCells] = useState(false);
  const [detectCellsError, setDetectCellsError] = useState<string | null>(null);
  const cellsDetectedHere = tableCellStructure?.pageNumber === table.pageNum;

  const handleDetectCells = useCallback(async () => {
    const store = useViewerStore.getState();
    // Clicking while cells are visible on this page clears them — mirrors
    // AutoParseTab's DetectCellStructureButton toggle behavior.
    if (cellsDetectedHere) {
      store.setTableCellStructure(null);
      return;
    }
    if (!publicId || !table.region?.bbox) return;
    setDetectingCells(true);
    setDetectCellsError(null);
    store.setPage(table.pageNum);
    try {
      const resp = await fetch("/api/table-structure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          pageNumber: table.pageNum,
          regionBbox: table.region.bbox,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        setDetectCellsError(data.error || `HTTP ${resp.status}`);
        return;
      }
      // setTableCellStructure auto-enables showTableCellStructure
      store.setTableCellStructure({
        cells: (data.cells || []).map((c: any) => ({ ...c, text: c.text || "", highlighted: false })),
        pageNumber: table.pageNum,
        regionBbox: table.region.bbox,
      });
    } catch (err: any) {
      setDetectCellsError(err?.message || "Failed to detect cells");
    } finally {
      setDetectingCells(false);
    }
  }, [cellsDetectedHere, publicId, table.pageNum, table.region?.bbox]);

  // Auto-expand and scroll into view when focused from double-click on canvas
  useEffect(() => {
    if (isFocused) {
      setExpanded(true);
      itemRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      const timer = setTimeout(() => {
        useViewerStore.getState().setFocusedParsedRegionId(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [isFocused]);

  const rows = table.region?.data?.rows || [];
  const headers = table.region?.data?.headers || [];
  const tagColumn = table.region?.data?.tagColumn;
  const tagKey = tagColumn || headers[0] || "";

  const rowTags = useMemo(() =>
    rows.map((row: Record<string, string>) => {
      const tag = (row[tagKey] || "").trim();
      const descParts = headers.filter((h: string) => h !== tagKey).map((h: string) => row[h] || "");
      return { tag, description: descParts.join(" ").trim() };
    }),
    [rows, headers, tagKey]
  );

  const tagInstances = useCallback((tag: string) => {
    const yt = yoloTags.find((t: any) => t.tagText === tag && t.source === "schedule");
    return yt?.instances?.length || 0;
  }, [yoloTags]);

  const handleTagClick = (tag: string) => {
    const store = useViewerStore.getState();
    const existing = store.yoloTags.find((t) => t.tagText === tag && t.source === "schedule");
    if (existing) {
      if (store.activeYoloTagId === existing.id) {
        store.setActiveYoloTagId(null);
        store.setYoloTagFilter(null);
      } else {
        store.setActiveYoloTagId(existing.id);
        store.setYoloTagFilter(existing.id);
      }
    }
  };

  const saveName = () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== table.name) {
      const store = useViewerStore.getState();
      const intel = store.pageIntelligence[table.pageNum] || {};
      const regions = ((intel as any)?.parsedRegions || []).map((r: any) => {
        if (r.id !== table.region.id) return r;
        return { ...r, data: { ...r.data, tableName: trimmed }, category: trimmed };
      });
      const updatedIntel = { ...intel, parsedRegions: regions };
      store.setPageIntelligence(table.pageNum, updatedIntel);

      // Persist to DB and refresh summaries
      const { projectId, isDemo } = store;
      if (projectId && !isDemo) {
        fetch("/api/pages/intelligence", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, pageNumber: table.pageNum, intelligence: updatedIntel }),
        })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => { if (data?.summaries) useViewerStore.getState().setSummaries(data.summaries); })
          .catch(() => {});
      }
    }
    setEditingName(false);
  };

  const saveColumnName = () => {
    if (editingColIdx === null) return;
    const newName = colEditValue.trim() || `Column ${editingColIdx + 1}`;
    const oldName = headers[editingColIdx];
    if (newName === oldName) { setEditingColIdx(null); return; }

    const store = useViewerStore.getState();
    const intel = store.pageIntelligence[table.pageNum] || {};
    const regions = ((intel as any)?.parsedRegions || []).map((r: any) => {
      if (r.id !== table.region.id) return r;
      const newHeaders = [...(r.data?.headers || [])];
      newHeaders[editingColIdx] = newName;
      const newRows = (r.data?.rows || []).map((row: Record<string, string>) => {
        const updated: Record<string, string> = {};
        for (const [k, v] of Object.entries(row)) {
          updated[k === oldName ? newName : k] = v;
        }
        return updated;
      });
      const newTagCol = r.data?.tagColumn === oldName ? newName : r.data?.tagColumn;
      return { ...r, data: { ...r.data, headers: newHeaders, rows: newRows, tagColumn: newTagCol } };
    });
    store.setPageIntelligence(table.pageNum, { ...intel, parsedRegions: regions });
    setEditingColIdx(null);
  };

  const saveTableSettings = () => {
    const store = useViewerStore.getState();
    const intel = store.pageIntelligence[table.pageNum] || {};
    const regions = ((intel as any)?.parsedRegions || []).map((r: any) => {
      if (r.id !== table.region.id) return r;
      return {
        ...r,
        data: {
          ...r.data,
          manualCsi: settingsCsi,
          notes: settingsNotes,
          color: settingsColor,
          opacity: settingsOpacity,
        },
      };
    });
    const updatedIntel = { ...intel, parsedRegions: regions };
    store.setPageIntelligence(table.pageNum, updatedIntel);
    // Persist to DB
    const { projectId, isDemo } = store;
    if (projectId && !isDemo) {
      fetch("/api/pages/intelligence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, pageNumber: table.pageNum, intelligence: updatedIntel }),
      }).catch(() => {});
    }
    setShowSettings(false);
  };

  return (
    <div ref={itemRef} className={`rounded border ${isFocused ? "border-cyan-400/60 bg-cyan-500/10 ring-1 ring-cyan-400/30" : isCurrentPage ? "border-pink-400/30 bg-pink-500/5" : "border-[var(--border)]"}`}>
      {/* Parent header */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-[var(--muted)] shrink-0">
          {expanded ? "\u25BC" : "\u25B6"}
        </button>
        <div className="flex-1 min-w-0" onDoubleClick={onNavigate}>
          {editingName ? (
            <input
              autoFocus
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
              className="text-[11px] font-medium bg-transparent border-b border-pink-400 outline-none w-full text-[var(--fg)]"
            />
          ) : (
            <span
              onClick={() => setEditingName(true)}
              className="text-[11px] font-medium text-[var(--fg)] truncate block cursor-pointer hover:text-pink-300"
              title="Click to rename, double-click to navigate"
            >
              {table.name}
            </span>
          )}
          <span className="text-[9px] text-[var(--muted)]">
            {pageNames[table.pageNum] || `p.${table.pageNum}`} &middot; {rowTags.length} rows
          </span>
        </div>
        {/* Eye icon — toggle table region visibility on canvas */}
        {table.region?.id && (
          <button
            onClick={() => useViewerStore.getState().toggleParsedRegionVisibility(table.region.id)}
            className={`text-[10px] shrink-0 ${
              isRegionHidden
                ? "text-[var(--muted)]/30 hover:text-[var(--muted)]"
                : "text-pink-300 hover:text-pink-200"
            }`}
            title="Toggle table visibility on canvas"
          >
            {isRegionHidden ? "\u25CB" : "\u{1F441}"}
          </button>
        )}
        {/* Tag view toggle (only when tags mapped) */}
        {table.region && rowTags.some((rt: { tag: string }) => yoloTags.some((t: any) => t.tagText === rt.tag && t.source === "schedule")) && (
          <button
            onClick={() => {
              const store = useViewerStore.getState();
              const regionId = table.region.id;
              if (store.activeTableTagViews[regionId]) {
                store.setTableTagView(regionId, null);
              } else {
                const tagTexts = rowTags.map((rt: { tag: string }) => rt.tag).filter(Boolean);
                store.setTableTagView(regionId, {
                  regionId,
                  pageNum: table.pageNum,
                  bbox: table.region.bbox || [0, 0, 1, 1],
                  tagTexts,
                  source: "schedule",
                });
              }
            }}
            className={`text-[10px] shrink-0 ${isTagViewActive ? "text-cyan-300" : "text-[var(--muted)] hover:text-cyan-300"}`}
            title="Toggle mapped tag visibility"
          >
            {isTagViewActive ? "T" : "t"}
          </button>
        )}
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`text-[10px] shrink-0 ${showSettings ? "text-pink-300" : "text-[var(--muted)] hover:text-pink-300"}`}
          title="Table settings"
        >
          &#9998;
        </button>
        <button onClick={onDelete} className="text-[10px] text-[var(--muted)] hover:text-red-400 shrink-0" title="Delete table">x</button>
      </div>

      {/* Table settings panel (pencil toggle) */}
      {showSettings && (
        <div className="mx-2 mb-1 p-2 rounded border border-[var(--border)] bg-[var(--surface)] space-y-2" onClick={(e) => e.stopPropagation()}>
          {/* Color swatches */}
          <div>
            <label className="text-[9px] text-[var(--muted)] block mb-1">Color</label>
            <div className="flex flex-wrap gap-1">
              {["#e879a0", "#3cb44b", "#0082c8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#ffe119", "#e6194b", "#008080", "#aa6e28", "#800000", "#000080", "#808080"].map((c) => (
                <button
                  key={c}
                  onClick={() => setSettingsColor(c)}
                  className={`w-4 h-4 rounded-full border-2 ${settingsColor === c ? "border-white" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          {/* Opacity slider */}
          <div>
            <label className="text-[9px] text-[var(--muted)] block mb-0.5">Opacity</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="5"
                max="80"
                step="5"
                value={settingsOpacity}
                onChange={(e) => setSettingsOpacity(parseInt(e.target.value))}
                className="flex-1 h-1 accent-pink-400"
              />
              <span className="text-[10px] text-[var(--muted)] w-7 text-right">{settingsOpacity}%</span>
            </div>
          </div>
          {/* CSI codes */}
          <div>
            <label className="text-[9px] text-[var(--muted)] block mb-0.5">CSI Codes</label>
            <input
              type="text"
              value={settingsCsi}
              onChange={(e) => setSettingsCsi(e.target.value)}
              placeholder="e.g. 08 21 16, 09 29 00"
              className="w-full text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--fg)] placeholder:text-[var(--muted)]/30 focus:outline-none focus:border-pink-400/50"
            />
          </div>
          {/* Notes */}
          <div>
            <label className="text-[9px] text-[var(--muted)] block mb-0.5">Notes</label>
            <textarea
              value={settingsNotes}
              onChange={(e) => setSettingsNotes(e.target.value)}
              placeholder="Add notes about this table..."
              className="w-full text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--fg)] placeholder:text-[var(--muted)]/30 focus:outline-none focus:border-pink-400/50 resize-none"
              rows={2}
            />
          </div>
          {/* Save / Cancel */}
          <div className="flex justify-end gap-1">
            <button onClick={() => setShowSettings(false)} className="px-2 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--fg)]">Cancel</button>
            <button onClick={saveTableSettings} className="px-2 py-0.5 text-[10px] rounded border border-pink-500/30 text-pink-300 hover:bg-pink-500/10">Save</button>
          </div>
        </div>
      )}

      {/* CSI tags */}
      {table.csiTags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pb-1">
          {table.csiTags.slice(0, 4).map((c: any, j: number) => (
            <span key={j} className="text-[8px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-300 font-mono">{c.code}</span>
          ))}
        </div>
      )}

      {/* Expanded: tag sub-items */}
      {expanded && (
        <div className="px-2 pb-2 space-y-0.5 border-t border-[var(--border)] mt-0.5 pt-1">
          {/* Column names (click to edit) */}
          <div className="flex flex-wrap gap-1 py-1">
            <span className="text-[8px] text-[var(--muted)] uppercase tracking-wide">Columns:</span>
            {headers.map((h: string, hi: number) => (
              editingColIdx === hi ? (
                <input
                  key={hi}
                  autoFocus
                  value={colEditValue}
                  onChange={(e) => setColEditValue(e.target.value)}
                  onBlur={saveColumnName}
                  onKeyDown={(e) => { if (e.key === "Enter") saveColumnName(); if (e.key === "Escape") setEditingColIdx(null); }}
                  className="text-[9px] px-1 py-0 w-20 bg-transparent border-b border-[var(--accent)] outline-none text-[var(--fg)]"
                />
              ) : (
                <button
                  key={hi}
                  onClick={() => { setEditingColIdx(hi); setColEditValue(h); }}
                  className={`text-[9px] px-1.5 py-0.5 rounded border ${
                    h === tagColumn ? "border-green-500/40 text-green-300 bg-green-500/10" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                  }`}
                  title="Click to rename column"
                >
                  {h}
                </button>
              )
            ))}
          </div>
          {rowTags.length === 0 && (
            <div className="text-[9px] text-[var(--muted)] italic">No rows parsed</div>
          )}
          {/* Action buttons */}
          {!showMapTags && (
            <>
              <div className="flex gap-1 mt-1">
                <button
                  onClick={() => {
                    const store = useViewerStore.getState();
                    store.setTableParsedGrid({
                      headers: table.region.data?.headers || [],
                      rows: table.region.data?.rows || [],
                      tagColumn: table.region.data?.tagColumn,
                      tableName: table.name,
                    });
                    store.setTableParseRegion(table.region.bbox || null);
                    store.setPage(table.pageNum);
                    store.toggleTableCompareModal();
                  }}
                  className="flex-1 text-[9px] px-2 py-1 rounded border border-pink-500/30 text-pink-300 hover:bg-pink-500/10"
                >
                  View / Edit
                </button>
                <button
                  onClick={() => { setShowMapTags(true); setMapTagColumn(tagKey); }}
                  className="flex-1 text-[9px] px-2 py-1 rounded border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                >
                  {yoloTags.some((t: any) => t.source === "schedule" && rowTags.some((rt: any) => rt.tag === t.tagText))
                    ? "Re-Map Tags" : "Map Tags"}
                </button>
                <button
                  onClick={handleDetectCells}
                  disabled={detectingCells || !table.region?.bbox}
                  className={`flex-1 text-[9px] px-2 py-1 rounded border disabled:opacity-40 ${
                    cellsDetectedHere
                      ? "border-cyan-500/60 text-cyan-300 bg-cyan-500/15 hover:bg-cyan-500/25"
                      : "border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                  }`}
                  title={cellsDetectedHere
                    ? "Cells detected — click to clear"
                    : "Run TATR cell detection on this region (single-click a cell to search by its text)"}
                >
                  {detectingCells
                    ? "Detecting..."
                    : cellsDetectedHere
                      ? `Cells (${tableCellStructure!.cells.length}) ✕`
                      : "Detect Cells"}
                </button>
              </div>
              {detectCellsError && (
                <div className="text-[9px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1 mt-1">
                  {detectCellsError}
                </div>
              )}
            </>
          )}
          {showMapTags && (
            <div className="border border-cyan-500/30 rounded px-2 py-2 space-y-1.5 bg-cyan-500/5 mt-1">
              <div className="text-[10px] text-cyan-400 font-medium">Map Tags</div>
              <div>
                <label className="text-[9px] text-[var(--muted)] block">Tag Column</label>
                <select
                  value={mapTagColumn}
                  onChange={(e) => setMapTagColumn(e.target.value)}
                  className="w-full text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
                >
                  {headers.map((h: string) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[9px] text-[var(--muted)] block">Tag Type</label>
                <div className="flex gap-1">
                  <button
                    onClick={() => { setMapTagType("free-floating"); setMapYoloClass(null); }}
                    className={`flex-1 text-[9px] px-2 py-1 rounded border ${mapTagType === "free-floating" ? "border-cyan-400 bg-cyan-500/10 text-cyan-300" : "border-[var(--border)] text-[var(--muted)]"}`}
                  >Free-floating</button>
                  <button
                    onClick={() => setMapTagType("yolo")}
                    className={`flex-1 text-[9px] px-2 py-1 rounded border ${mapTagType === "yolo" ? "border-cyan-400 bg-cyan-500/10 text-cyan-300" : "border-[var(--border)] text-[var(--muted)]"}`}
                  >YOLO Shape</button>
                </div>
              </div>
              {mapTagType === "yolo" && (
                <div>
                  <label className="text-[9px] text-[var(--muted)] block">YOLO Class</label>
                  {(() => {
                    const store = useViewerStore.getState();
                    const yoloAnns = store.annotations.filter((a) => a.source === "yolo");
                    const groups: Record<string, { model: string; className: string; count: number }> = {};
                    for (const a of yoloAnns) {
                      const model = (a as any).data?.modelName || "unknown";
                      const cls = a.name;
                      const key = `${model}:${cls}`;
                      if (!groups[key]) groups[key] = { model, className: cls, count: 0 };
                      groups[key].count++;
                    }
                    const sorted = Object.values(groups).sort((a, b) => b.count - a.count);
                    return sorted.length > 0 ? (
                      <div className="space-y-0.5">
                        {sorted.slice(0, 8).map((g, gi) => (
                          <button key={gi}
                            onClick={() => setMapYoloClass(mapYoloClass?.className === g.className && mapYoloClass?.model === g.model ? null : g)}
                            className={`w-full text-left text-[9px] px-1.5 py-0.5 rounded border ${
                              mapYoloClass?.className === g.className && mapYoloClass?.model === g.model
                                ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                                : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
                            }`}
                          >
                            {g.className} <span className="text-[var(--muted)]">({g.model}) &mdash; {g.count}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[9px] text-[var(--muted)] italic">No YOLO annotations loaded</div>
                    );
                  })()}
                </div>
              )}
              {/* Phase 4 — scope + strictness selectors. Condensed for the inline panel. */}
              {availablePrefixes.length > 0 && (
                <div>
                  <label className="text-[9px] text-[var(--muted)] block">Scope</label>
                  <div className="flex flex-wrap gap-0.5">
                    <button
                      title="Search all pages in the project"
                      onClick={() => setMapPrefixes([])}
                      className={`text-[9px] px-1.5 py-0.5 rounded border ${
                        mapPrefixes.length === 0
                          ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                          : "border-[var(--border)] text-[var(--muted)]"
                      }`}
                    >All pages</button>
                    {availablePrefixes.map((prefix) => {
                      const active = mapPrefixes.includes(prefix);
                      const label = prefix === "" ? "Unnumbered" : `${prefix}*`;
                      return (
                        <button
                          key={prefix}
                          onClick={() => togglePrefix(prefix)}
                          className={`text-[9px] px-1.5 py-0.5 rounded border ${
                            active
                              ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                              : "border-[var(--border)] text-[var(--muted)]"
                          }`}
                        >{label}</button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div>
                <label className="text-[9px] text-[var(--muted)] block">Strictness</label>
                <div className="flex gap-0.5">
                  {(["strict", "balanced", "lenient"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setMapStrictness(s)}
                      className={`flex-1 text-[9px] px-1.5 py-0.5 rounded border capitalize ${
                        mapStrictness === s
                          ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                          : "border-[var(--border)] text-[var(--muted)]"
                      }`}
                    >{s}</button>
                  ))}
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  disabled={mapping}
                  onClick={async () => {
                    setMapping(true);
                    setMapError(null);
                    try {
                      const store = useViewerStore.getState();
                      // Collect unique tags from the selected column
                      const tags: string[] = [...new Set<string>(
                        rows.map((row: Record<string, string>) => (row[mapTagColumn] || "").trim()).filter(Boolean)
                      )].filter((tag) => !store.yoloTags.some((t) => t.tagText === tag && t.source === "schedule"));

                      if (tags.length === 0) { setShowMapTags(false); return; }

                      // Use batch API for full-project scanning (server loads ALL textractData from DB)
                      const res = await fetch(`/api/projects/${publicId}/map-tags-batch`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          tags,
                          yoloClass: mapTagType === "yolo" ? mapYoloClass?.className : undefined,
                          yoloModel: mapTagType === "yolo" ? mapYoloClass?.model : undefined,
                          itemType: mapTagType === "yolo" ? "yolo-with-inner-text" : "text-only",
                          strictnessMode: mapStrictness,
                          drawingNumberPrefixes: mapPrefixes,
                        }),
                      });
                      if (!res.ok) throw new Error(`Server error: ${res.status}`);
                      const { results }: { results: Record<string, ScoredMatch[]> } = await res.json();

                      // Build YoloTag[] from results and bulk-add in one store update.
                      const newTags: YoloTag[] = tags
                        .filter((t) => (results[t]?.length ?? 0) > 0)
                        .map((tag) => {
                          const row = rows.find((r: Record<string, string>) => (r[mapTagColumn] || "").trim() === tag);
                          const descParts = headers.filter((h: string) => h !== mapTagColumn).map((h: string) => row?.[h] || "");
                          const desc = descParts.join(" ").trim();
                          return {
                            id: `schedule-${table.pageNum}-${tag}-${Date.now()}`,
                            name: tag,
                            tagText: tag,
                            yoloClass: mapTagType === "yolo" ? (mapYoloClass?.className || "") : "",
                            yoloModel: mapTagType === "yolo" ? (mapYoloClass?.model || "") : "",
                            source: "schedule",
                            scope: "project",
                            description: desc.slice(0, 200),
                            instances: results[tag],
                          };
                        });
                      if (newTags.length > 0) store.addYoloTagsBulk(newTags);
                      setShowMapTags(false);
                    } catch (err) {
                      console.error("[MAP_TAGS] Batch mapping failed:", err);
                      setMapError(err instanceof Error ? err.message : "Mapping failed");
                    } finally {
                      setMapping(false);
                    }
                  }}
                  className="flex-1 text-[9px] px-2 py-1 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/30 font-medium"
                >
                  {mapping ? "Mapping..." : "Run Mapping"}
                </button>
                <button
                  onClick={() => setShowMapTags(false)}
                  className="text-[9px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)]"
                >Cancel</button>
              </div>
              {mapError && (
                <div className="text-[9px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1 mt-1">
                  {mapError}
                </div>
              )}
            </div>
          )}

          {rowTags.map((rt: { tag: string; description: string }, ri: number) => (
            <div key={ri}>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => rt.tag && handleTagClick(rt.tag)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!rt.tag) return;
                    const tag = yoloTags.find((t: any) => t.tagText === rt.tag && t.source === "schedule");
                    if (tag && tag.instances?.length > 0) {
                      useViewerStore.getState().tagBrowseNavigate(tag.id, 0);
                    }
                  }}
                  className={`flex-1 text-left text-[10px] px-1.5 py-0.5 rounded text-[var(--muted)] ${
                    activeYoloTagId && yoloTags.find((t: any) => t.tagText === rt.tag && t.source === "schedule")?.id === activeYoloTagId
                      ? "bg-pink-500/15 text-pink-300"
                      : tagInstances(rt.tag) > 0
                      ? "hover:bg-cyan-500/10 cursor-pointer"
                      : "opacity-60 hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  <span className="font-mono font-medium text-[var(--fg)]">{rt.tag || `Row ${ri + 1}`}</span>
                  <span className="text-[var(--muted)]"> &mdash; {rt.description.slice(0, 60) || "(no description)"}{rt.description.length > 60 ? "..." : ""}</span>
                  {tagInstances(rt.tag) > 0 && (
                    <span className="text-cyan-400/70 text-[9px] ml-1">({tagInstances(rt.tag)})</span>
                  )}
                </button>
                {tagInstances(rt.tag) > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const tag = yoloTags.find((t: any) => t.tagText === rt.tag && t.source === "schedule");
                      if (tag) useViewerStore.getState().tagBrowseNavigate(tag.id, 0);
                    }}
                    className="text-[9px] text-cyan-400/40 hover:text-cyan-300 shrink-0 px-0.5"
                    title="Browse all instances"
                  >
                    &#8594;
                  </button>
                )}
                <button
                  onClick={() => {
                    if (editingRowIdx === ri) { setEditingRowIdx(null); }
                    else { setEditingRowIdx(ri); setEditCsi(""); setEditNote(""); }
                  }}
                  className="text-[10px] text-[var(--muted)] hover:text-pink-300 shrink-0 px-0.5"
                  title="Edit metadata"
                >
                  {editingRowIdx === ri ? "x" : "\u270F"}
                </button>
              </div>
              {editingRowIdx === ri && (
                <div className="ml-2 mt-1 mb-1 space-y-1 p-1.5 rounded bg-[var(--surface)] border border-[var(--border)]">
                  <div>
                    <label className="text-[9px] text-[var(--muted)] block">CSI Codes</label>
                    <input type="text" value={editCsi} onChange={(e) => setEditCsi(e.target.value)} placeholder="e.g. 08 21 16"
                      className="w-full text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--fg)] placeholder:text-[var(--muted)]/30 focus:outline-none focus:border-pink-400/50" />
                  </div>
                  <div>
                    <label className="text-[9px] text-[var(--muted)] block">Notes</label>
                    <textarea value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="Add notes..." rows={2}
                      className="w-full text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--fg)] placeholder:text-[var(--muted)]/30 focus:outline-none focus:border-pink-400/50 resize-none" />
                  </div>
                  <button
                    onClick={() => setEditingRowIdx(null)}
                    className="text-[9px] px-2 py-0.5 rounded bg-pink-500/20 text-pink-300 border border-pink-500/30 hover:bg-pink-500/30"
                  >Save</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
})
