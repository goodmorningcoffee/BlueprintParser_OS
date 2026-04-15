"use client";

import { useMemo, useState, useRef } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { AREA_UNIT_MAP } from "@/types";
import type { AreaPolygonData, AreaUnitSq, TakeoffTab } from "@/types";
import { computeRealArea } from "@/lib/areaCalc";
import CountTab from "./CountTab";
import AreaTab from "./AreaTab";
import LinearTab from "./LinearTab";
import AutoQtoTab from "./AutoQtoTab";
import { ColorDot } from "./TakeoffShared";
import CalibrationInput from "./CalibrationInput";
import TakeoffCsvModal from "./TakeoffCsvModal";

const TAB_LABELS: Record<TakeoffTab, string> = {
  all: "All",
  count: "Count",
  area: "Area",
  linear: "Linear",
  "auto-qto": "Auto-QTO",
};

export default function TakeoffPanel() {
  const takeoffTab = useViewerStore((s) => s.takeoffTab);
  const setTakeoffTab = useViewerStore((s) => s.setTakeoffTab);
  const annotations = useViewerStore((s) => s.annotations);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const updateTakeoffItem = useViewerStore((s) => s.updateTakeoffItem);
  const pageDimensions = useViewerStore((s) => s.pageDimensions);
  const scaleCalibrations = useViewerStore((s) => s.scaleCalibrations);
  const activeTakeoffItemId = useViewerStore((s) => s.activeTakeoffItemId);
  const takeoffUndoStack = useViewerStore((s) => s.takeoffUndoStack);
  const takeoffRedoStack = useViewerStore((s) => s.takeoffRedoStack);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const calibrationMode = useViewerStore((s) => s.calibrationMode);
  const setCalibrationMode = useViewerStore((s) => s.setCalibrationMode);
  const resetCalibration = useViewerStore((s) => s.resetCalibration);
  const isDemo = useViewerStore((s) => s.isDemo);

  const [csvModalOpen, setCsvModalOpen] = useState(false);
  const saveTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const activeItem = activeTakeoffItemId ? takeoffItems.find((t) => t.id === activeTakeoffItemId) : null;
  const hasScale = !!scaleCalibrations[pageNumber];

  // ─── All-Takeoffs grouped data ────────────────────────────
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (group: string) => setCollapsedGroups((s) => ({ ...s, [group]: !s[group] }));
  // Expanded-item state: which area items have their instance list open
  const [expandedAreaItems, setExpandedAreaItems] = useState<Set<number>>(new Set());
  const toggleAreaItem = (id: number) => setExpandedAreaItems((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const allSummary = useMemo(() => {
    const counts: Record<number, { count: number; pages: Set<number> }> = {};
    const areas: Record<number, { totalArea: number; polyCount: number; pages: Set<number> }> = {};
    const linears: Record<number, { totalLength: number; lineCount: number; pages: Set<number> }> = {};

    for (const ann of annotations) {
      if (ann.source !== "takeoff" || !ann.data) continue;
      const data = ann.data as any;
      const itemId = data.takeoffItemId as number;
      if (!itemId) continue;

      if (data.type === "count-marker") {
        if (!counts[itemId]) counts[itemId] = { count: 0, pages: new Set() };
        counts[itemId].count++;
        counts[itemId].pages.add(ann.pageNumber);
      } else if (data.type === "area-polygon") {
        if (!areas[itemId]) areas[itemId] = { totalArea: 0, polyCount: 0, pages: new Set() };
        areas[itemId].polyCount++;
        areas[itemId].pages.add(ann.pageNumber);
        const vertices = (data as AreaPolygonData).vertices;
        const dim = pageDimensions[ann.pageNumber];
        const cal = scaleCalibrations[ann.pageNumber];
        if (vertices && dim && cal) {
          // Subtract hole areas so courtyards inside U-shaped hallways don't
          // inflate the total. Matches what the preview/render loop produces
          // via fill-rule="evenodd".
          const outerArea = computeRealArea(vertices, dim.width, dim.height, cal);
          let holesArea = 0;
          for (const hole of (((data as any).holes ?? []) as { vertices: { x: number; y: number }[] }[])) {
            if (hole.vertices && hole.vertices.length >= 3) {
              holesArea += computeRealArea(hole.vertices, dim.width, dim.height, cal);
            }
          }
          areas[itemId].totalArea += Math.max(0, outerArea - holesArea);
        }
      } else if (data.type === "linear-polyline") {
        if (!linears[itemId]) linears[itemId] = { totalLength: 0, lineCount: 0, pages: new Set() };
        linears[itemId].lineCount++;
        linears[itemId].pages.add(ann.pageNumber);
        if (typeof data.totalLength === "number") linears[itemId].totalLength += data.totalLength;
      }
    }
    return { counts, areas, linears };
  }, [annotations, pageDimensions, scaleCalibrations]);

  // Per-item area instance list for the expand-on-click hierarchy (Bug 3).
  // Lists each polygon annotation with its page number and net area so the
  // user can click an instance to navigate to it.
  const areaInstances = useMemo(() => {
    const map: Record<number, Array<{ annId: number; pageNumber: number; area: number; hasCal: boolean }>> = {};
    for (const ann of annotations) {
      if (ann.source !== "takeoff" || !ann.data) continue;
      const data = ann.data as any;
      if (data.type !== "area-polygon") continue;
      const itemId = data.takeoffItemId as number;
      if (!itemId) continue;
      if (!map[itemId]) map[itemId] = [];
      const dim = pageDimensions[ann.pageNumber];
      const cal = scaleCalibrations[ann.pageNumber];
      let area = 0;
      let hasCal = false;
      if (cal && dim && data.vertices) {
        const outer = computeRealArea(data.vertices, dim.width, dim.height, cal);
        let holesArea = 0;
        for (const hole of ((data.holes ?? []) as { vertices: { x: number; y: number }[] }[])) {
          if (hole.vertices && hole.vertices.length >= 3) {
            holesArea += computeRealArea(hole.vertices, dim.width, dim.height, cal);
          }
        }
        area = Math.max(0, outer - holesArea);
        hasCal = true;
      }
      map[itemId].push({ annId: ann.id, pageNumber: ann.pageNumber, area, hasCal });
    }
    for (const key of Object.keys(map)) {
      map[Number(key)].sort((a, b) => a.pageNumber - b.pageNumber || b.area - a.area);
    }
    return map;
  }, [annotations, pageDimensions, scaleCalibrations]);

  const countItems = takeoffItems.filter((i) => i.shape !== "polygon" && i.shape !== "linear");
  const areaItems = takeoffItems.filter((i) => i.shape === "polygon");
  const linearItems = takeoffItems.filter((i) => i.shape === "linear");

  // ─── CSV Modal data (editable view) ──────────────────────
  const csvData = useMemo(() => {
    const cals = Object.values(scaleCalibrations);
    const areaUnit: AreaUnitSq = cals.length > 0 ? AREA_UNIT_MAP[cals[0].unit] : "SF";
    const linearUnit = cals.length > 0 ? cals[0].unit : "ft";

    const modalRows = takeoffItems.map((item) => {
      let type: string, qty: string, unit: string, pages: Set<number>;
      if (item.shape === "polygon") {
        type = "area";
        const s = allSummary.areas[item.id];
        qty = s ? s.totalArea.toFixed(1) : "0";
        unit = areaUnit;
        pages = s?.pages ?? new Set();
      } else if (item.shape === "linear") {
        type = "linear";
        const s = allSummary.linears[item.id];
        qty = s ? s.totalLength.toFixed(1) : "0";
        unit = linearUnit;
        pages = s?.pages ?? new Set();
      } else {
        type = "count";
        const s = allSummary.counts[item.id];
        qty = String(s?.count ?? 0);
        unit = "EA";
        pages = s?.pages ?? new Set();
      }
      return {
        "Item Name": item.name,
        Type: type,
        Shape: item.shape,
        Color: item.color,
        Quantity: qty,
        Unit: unit,
        Pages: Array.from(pages).sort((a, b) => a - b).join(", "),
        Notes: item.notes ?? "",
        __itemId: String(item.id),
      } as Record<string, string>;
    });
    return modalRows;
  }, [takeoffItems, allSummary, scaleCalibrations]);

  const csvHeaders = ["Item Name", "Type", "Shape", "Quantity", "Unit", "Pages", "Notes", "Color"];
  const csvReadOnly = new Set(["Type", "Shape", "Quantity", "Unit", "Pages"]);

  const handleCsvCellChange = (rowIndex: number, column: string, value: string) => {
    const itemId = Number(csvData[rowIndex]?.__itemId);
    if (!itemId) return;
    const updates: Partial<{ name: string; color: string; notes: string }> = {};
    if (column === "Item Name") updates.name = value;
    else if (column === "Color") updates.color = value;
    else if (column === "Notes") updates.notes = value;
    else return;
    updateTakeoffItem(itemId, updates);
    // Debounced PUT to server (500ms)
    if (!isDemo) {
      clearTimeout(saveTimers.current[itemId]);
      saveTimers.current[itemId] = setTimeout(() => {
        fetch(`/api/takeoff-items/${itemId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        }).catch((err) => console.error("[takeoff-csv] save failed:", err));
      }, 500);
    }
  };

  // ─── CSV Export ───────────────────────────────────────────
  function exportCSV() {
    const rows: string[] = [];
    for (const item of takeoffItems) {
      if (item.shape === "polygon") {
        let totalArea = 0;
        const pages = new Set<number>();
        let hasCal = true;
        for (const ann of annotations) {
          if (ann.source !== "takeoff" || !ann.data) continue;
          const data = ann.data as any;
          if (data.type !== "area-polygon" || data.takeoffItemId !== item.id) continue;
          pages.add(ann.pageNumber);
          const vertices = (data as AreaPolygonData).vertices;
          const dim = pageDimensions[ann.pageNumber];
          const cal = scaleCalibrations[ann.pageNumber];
          if (vertices && dim && cal) { totalArea += computeRealArea(vertices, dim.width, dim.height, cal); }
          else { hasCal = false; }
        }
        const cals = Object.values(scaleCalibrations);
        const unitSq: AreaUnitSq = cals.length > 0 ? AREA_UNIT_MAP[cals[0].unit] : "SF";
        rows.push(`"${item.name.replace(/"/g, '""')}",area,polygon,${hasCal ? totalArea.toFixed(1) : ""},${unitSq},"${Array.from(pages).sort((a, b) => a - b).join("; ")}","${(item.notes || "").replace(/"/g, '""')}",${item.color}`);
      } else if (item.shape === "linear") {
        let totalLength = 0;
        const pages = new Set<number>();
        for (const ann of annotations) {
          if (ann.source !== "takeoff" || !ann.data) continue;
          const data = ann.data as any;
          if (data.type !== "linear-polyline" || data.takeoffItemId !== item.id) continue;
          pages.add(ann.pageNumber);
          if (typeof data.totalLength === "number") totalLength += data.totalLength;
        }
        const cals = Object.values(scaleCalibrations);
        const unit = cals.length > 0 ? cals[0].unit : "ft";
        rows.push(`"${item.name.replace(/"/g, '""')}",linear,linear,${totalLength.toFixed(1)},${unit},"${Array.from(pages).sort((a, b) => a - b).join("; ")}","${(item.notes || "").replace(/"/g, '""')}",${item.color}`);
      } else {
        let count = 0;
        const pages = new Set<number>();
        for (const ann of annotations) {
          if (ann.source !== "takeoff" || !ann.data) continue;
          const data = ann.data as any;
          if (data.takeoffItemId !== item.id) continue;
          if (data.type === "area-polygon" || data.type === "linear-polyline") continue;
          count++;
          pages.add(ann.pageNumber);
        }
        rows.push(`"${item.name.replace(/"/g, '""')}",count,${item.shape},${count},EA,"${Array.from(pages).sort((a, b) => a - b).join("; ")}","${(item.notes || "").replace(/"/g, '""')}",${item.color}`);
      }
    }
    const csv = ["Item Name,Type,Shape,Quantity,Unit,Pages,Notes,Color", ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "takeoff.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="viewer-scalable w-80 shrink-0 border border-[var(--border)] bg-[var(--surface)] flex flex-col shadow-lg">
      {/* Header with calibrate button */}
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-sm font-medium">Quantity Takeoff</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              if (calibrationMode !== "idle") { resetCalibration(); }
              else { setCalibrationMode("point1"); }
            }}
            className={`text-xs px-1.5 py-0.5 rounded border ${hasScale ? "border-green-500/30 text-green-400" : "border-amber-500/30 text-amber-400"} hover:border-[var(--accent)]`}
            title={hasScale ? `Scale set for page ${pageNumber}. Click to recalibrate.` : "Set scale for this page (required for Area and Linear)"}
          >
            {calibrationMode !== "idle" ? "..." : hasScale ? "\u2713" : "\u{1F4CF}"}
          </button>
          <button onClick={() => setCsvModalOpen(true)} className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]" title="View as editable CSV">View</button>
          <button onClick={exportCSV} className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]" title="Export CSV">CSV</button>
        </div>
      </div>
      <TakeoffCsvModal
        open={csvModalOpen}
        onClose={() => setCsvModalOpen(false)}
        title="Takeoff Items"
        headers={csvHeaders}
        rows={csvData}
        readOnlyColumns={csvReadOnly}
        onCellChange={handleCsvCellChange}
        onExport={exportCSV}
      />

      {/* Calibration input (shows when in calibration mode from header button) */}
      {calibrationMode === "input" && takeoffTab !== "area" && takeoffTab !== "linear" && (
        <div className="px-2 py-2 border-b border-[var(--border)]">
          <div className="text-xs text-amber-400 mb-1">Enter the real-world distance:</div>
          <CalibrationInput />
        </div>
      )}

      {/* Active item status bar */}
      {activeItem && (
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2" style={{ backgroundColor: activeItem.color + "10" }}>
          <ColorDot color={activeItem.color} />
          <span className="text-xs font-medium flex-1 truncate">{activeItem.name}</span>
          <button
            onClick={() => useViewerStore.getState().takeoffUndo()}
            disabled={takeoffUndoStack.length === 0}
            className="text-xs px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-30"
            title="Undo last placement (Z)"
          >
            &#8630;
          </button>
          <button
            onClick={() => useViewerStore.getState().takeoffRedo()}
            disabled={takeoffRedoStack.length === 0}
            className="text-xs px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-30"
            title="Redo (W)"
          >
            &#8631;
          </button>
          <button
            onClick={() => {
              useViewerStore.getState().setActiveTakeoffItemId(null);
              useViewerStore.getState().resetPolygonDrawing();
              useViewerStore.getState().setMode("move");
            }}
            className="text-xs px-2 py-0.5 rounded border border-red-400/30 text-red-400/60 hover:text-red-400"
          >
            Stop
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["all", "count", "area", "linear", "auto-qto"] as const).map((tab) => (
          <button key={tab} onClick={() => setTakeoffTab(tab)}
            className={`flex-1 text-[10px] py-2 text-center transition-colors ${takeoffTab === tab ? "text-[var(--fg)] border-b-2 border-[var(--accent)]" : "text-[var(--muted)] hover:text-[var(--fg)]"}`}>
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {takeoffTab === "all" && (
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {takeoffItems.length === 0 ? (
            <div className="text-xs text-[var(--muted)] text-center py-8">No takeoff items yet.<br />Use Count, Area, or Linear tabs to create items.</div>
          ) : (
            <>
              {/* Counts group */}
              {countItems.length > 0 && (
                <div>
                  <button onClick={() => toggleGroup("count")} className="w-full flex items-center justify-between text-xs text-[var(--muted)] hover:text-[var(--fg)] py-1">
                    <span>{collapsedGroups.count ? "\u25B6" : "\u25BC"} Counts ({countItems.length} items, {countItems.reduce((s, i) => s + (allSummary.counts[i.id]?.count || 0), 0)} total)</span>
                  </button>
                  {!collapsedGroups.count && countItems.map((item) => {
                    const s = allSummary.counts[item.id];
                    return (
                      <div key={item.id} onClick={() => { useViewerStore.getState().setActiveTakeoffItemId(item.id); setTakeoffTab("count"); }}
                        className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-[var(--surface-hover)] text-xs">
                        <ColorDot color={item.color} />
                        <span className="flex-1 truncate">{item.name}</span>
                        <span className="text-[var(--muted)]">{s?.count || 0} EA</span>
                        {s && <span className="text-[10px] text-[var(--muted)]">{s.pages.size}pg</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Areas group */}
              {areaItems.length > 0 && (
                <div>
                  <button onClick={() => toggleGroup("area")} className="w-full flex items-center justify-between text-xs text-[var(--muted)] hover:text-[var(--fg)] py-1">
                    <span>{collapsedGroups.area ? "\u25B6" : "\u25BC"} Areas ({areaItems.length} items)</span>
                  </button>
                  {!collapsedGroups.area && areaItems.map((item) => {
                    const s = allSummary.areas[item.id];
                    const instances = areaInstances[item.id] ?? [];
                    const isExpanded = expandedAreaItems.has(item.id);
                    return (
                      <div key={item.id}>
                        <div
                          onClick={() => {
                            // Toggle expand + set as active item. Click on
                            // the chevron area or item row both expand.
                            toggleAreaItem(item.id);
                            useViewerStore.getState().setActiveTakeoffItemId(item.id);
                            setTakeoffTab("area");
                          }}
                          className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-[var(--surface-hover)] text-xs"
                        >
                          <span className="text-[var(--muted)] w-3 shrink-0">
                            {instances.length > 0 ? (isExpanded ? "\u25BE" : "\u25B8") : ""}
                          </span>
                          <ColorDot color={item.color} />
                          <span className="flex-1 truncate">{item.name}</span>
                          <span className="text-[var(--muted)]">{s ? `${s.totalArea.toFixed(1)}` : "0"}</span>
                          {s && <span className="text-[10px] text-[var(--muted)]">{s.pages.size}pg</span>}
                        </div>
                        {isExpanded && instances.length > 0 && (
                          <div className="ml-5 border-l border-[var(--border)] pl-2">
                            {instances.map((inst, idx) => (
                              <div
                                key={inst.annId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  useViewerStore.getState().setPage(inst.pageNumber);
                                  useViewerStore.getState().setFocusAnnotationId(inst.annId);
                                }}
                                className="flex items-center gap-2 px-2 py-0.5 text-[11px] rounded cursor-pointer hover:bg-[var(--surface-hover)]"
                              >
                                <span className="text-[var(--muted)] w-6 shrink-0">#{idx + 1}</span>
                                <span className="flex-1 text-[var(--muted)]">p{inst.pageNumber}</span>
                                <span className="text-[var(--muted)] tabular-nums">
                                  {inst.hasCal ? inst.area.toFixed(1) : "\u2014"}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Linear group */}
              {linearItems.length > 0 && (
                <div>
                  <button onClick={() => toggleGroup("linear")} className="w-full flex items-center justify-between text-xs text-[var(--muted)] hover:text-[var(--fg)] py-1">
                    <span>{collapsedGroups.linear ? "\u25B6" : "\u25BC"} Linear ({linearItems.length} items)</span>
                  </button>
                  {!collapsedGroups.linear && linearItems.map((item) => {
                    const s = allSummary.linears[item.id];
                    return (
                      <div key={item.id} onClick={() => { useViewerStore.getState().setActiveTakeoffItemId(item.id); setTakeoffTab("linear"); }}
                        className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-[var(--surface-hover)] text-xs">
                        <ColorDot color={item.color} />
                        <span className="flex-1 truncate">{item.name}</span>
                        <span className="text-[var(--muted)]">{s ? `${s.totalLength.toFixed(1)}` : "0"}</span>
                        {s && <span className="text-[10px] text-[var(--muted)]">{s.pages.size}pg</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {takeoffTab === "count" && <CountTab />}
      {takeoffTab === "area" && <AreaTab />}
      {takeoffTab === "linear" && <LinearTab />}
      {takeoffTab === "auto-qto" && <AutoQtoTab />}
    </div>
  );
}
