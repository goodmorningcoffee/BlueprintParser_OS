"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useViewerStore, useTableParse, useNavigation, useProject } from "@/stores/viewerStore";
import { exportTableCsv } from "@/lib/table-parse-utils";
import HelpTooltip from "./HelpTooltip";
import MapTagsSection from "./MapTagsSection";

type ProposedRegion = [number, number, number, number]; // [minX, minY, maxX, maxY]

interface AutoParseTabProps {
  autoDetectedTables: any[];
  existingParsed: any[];
  yoloInTableRegion: { model: string; className: string; count: number }[];
  loadExistingParsed: (parsed: any) => void;
  detectCsiAndPersist: (grid: any) => Promise<void>;
  tagYoloClass: { model: string; className: string } | null;
  setTagYoloClass: (cls: { model: string; className: string } | null) => void;
  handleMapTags: () => void;
  tagMappingDone: boolean;
  tagMappingCount: number;
  setTagMappingDone: (done: boolean) => void;
}

export default function AutoParseTab({
  autoDetectedTables,
  existingParsed,
  yoloInTableRegion,
  loadExistingParsed,
  detectCsiAndPersist,
  tagYoloClass,
  setTagYoloClass,
  handleMapTags,
  tagMappingDone,
  tagMappingCount,
  setTagMappingDone,
}: AutoParseTabProps) {
  const { pageNumber } = useNavigation();
  const { projectId } = useProject();
  const {
    tableParseStep, setTableParseStep,
    tableParseRegion, setTableParseRegion,
    tableParsedGrid, setTableParsedGrid,
    resetTableParse, tableParseTab, setTableParseTab,
    toggleTableCompareModal,
  } = useTableParse();

  const [autoParsing, setAutoParsing] = useState(false);
  const [autoParseError, setAutoParseError] = useState<string | null>(null);
  const [autoParseMethodInfo, setAutoParseMethodInfo] = useState<any[] | null>(null);

  // Multi-BB: accumulate proposed regions before processing
  const [proposedRegions, setProposedRegions] = useState<ProposedRegion[]>([]);
  const lastRegionRef = useRef<string | null>(null);

  // Capture drawn region into proposed list (instead of auto-parsing)
  useEffect(() => {
    if (tableParseRegion && tableParseTab === "auto") {
      const key = tableParseRegion.join(",");
      if (key !== lastRegionRef.current) {
        lastRegionRef.current = key;
        setProposedRegions((prev) => [...prev, tableParseRegion as ProposedRegion]);
        // Reset store region so user can draw another
        setTableParseRegion(null);
      }
    }
  }, [tableParseRegion, tableParseTab, setTableParseRegion]);

  const removeProposedRegion = (index: number) => {
    setProposedRegions((prev) => prev.filter((_, i) => i !== index));
  };

  const processRegions = useCallback(
    async () => {
      if (proposedRegions.length === 0) return;
      setAutoParsing(true);
      setAutoParseError(null);
      setAutoParseMethodInfo(null);

      try {
        // Parse each region independently then merge
        let mergedHeaders: string[] = [];
        let mergedRows: Record<string, string>[] = [];
        let lastMethodInfo: any[] | null = null;
        let tagColumn: string | undefined;

        for (let i = 0; i < proposedRegions.length; i++) {
          const bbox = proposedRegions[i];
          const resp = await fetch("/api/table-parse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId, pageNumber, regionBbox: bbox }),
          });

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `Region ${i + 1}: API error ${resp.status}`);
          }

          const result = await resp.json();
          lastMethodInfo = result.methods || null;

          if (i === 0) {
            // First region: use its headers as canonical
            mergedHeaders = result.headers || [];
            tagColumn = result.tagColumn;
          } else if (mergedHeaders.length > 0 && result.headers?.length > 0) {
            // Validate subsequent regions have compatible headers
            const h1 = JSON.stringify(mergedHeaders);
            const h2 = JSON.stringify(result.headers);
            if (h1 !== h2) {
              throw new Error(`Region ${i + 1} has different columns than Region 1. All regions must have the same column structure to merge.`);
            }
          }
          // Append rows (top-to-bottom order)
          mergedRows = [...mergedRows, ...(result.rows || [])];
        }

        setAutoParseMethodInfo(lastMethodInfo);
        const grid = {
          headers: mergedHeaders,
          rows: mergedRows,
          tagColumn,
          csiTags: [],
          tableName: proposedRegions.length > 1 ? `Merged (${proposedRegions.length} regions)` : undefined,
        };
        setTableParsedGrid(grid);
        detectCsiAndPersist(grid);
        // Set tableParseRegion to merged bbox so TableCompareModal can crop the image
        const allRegions = proposedRegions;
        setTableParseRegion([
          Math.min(...allRegions.map((r) => r[0])),
          Math.min(...allRegions.map((r) => r[1])),
          Math.max(...allRegions.map((r) => r[2])),
          Math.max(...allRegions.map((r) => r[3])),
        ]);
        setTableParseStep("review");
        useViewerStore.getState().setMode("move");
        setProposedRegions([]);
      } catch (err: any) {
        console.error("[auto-parse] Failed:", err);
        setAutoParseError(err.message || "Auto-parse failed");
        setTableParsedGrid({ headers: [], rows: [] });
        setTableParseStep("review");
        useViewerStore.getState().setMode("move");
      } finally {
        setAutoParsing(false);
      }
    },
    [proposedRegions, projectId, pageNumber, setTableParsedGrid, setTableParseStep, detectCsiAndPersist]
  );

  const exportCsv = () => {
    if (tableParsedGrid) exportTableCsv(tableParsedGrid, pageNumber);
  };

  return (
    <>
      {/* ─── Step: Select Region ─────────────────────────── */}
      {(tableParseStep === "idle" || tableParseStep === "select-region") && (
        <>
          <div className="text-[11px] text-[var(--muted)] px-1">
            {tableParseStep === "select-region" ? (
              <span className="text-pink-300">Drawing — draw a BB around only the table grid. Do NOT include the title (e.g. "DOOR SCHEDULE") if it sits above the table.</span>
            ) : (
              "Draw a BB around only the table grid. Exclude any title text that floats above the table — it will break header detection."
            )}
          </div>

          <HelpTooltip id="table-auto-draw"><button
            onClick={() => {
              const next = tableParseStep === "select-region" ? "idle" : "select-region";
              setTableParseStep(next);
              useViewerStore.getState().setMode(next !== "idle" ? "pointer" : "move");
            }}
            className={`w-full text-xs px-3 py-2 rounded border ${
              tableParseStep === "select-region"
                ? "border-pink-500 bg-pink-500/10 text-pink-300"
                : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
            }`}
          >
            {tableParseStep === "select-region" ? "Cancel Drawing" : proposedRegions.length > 0 ? "Draw Another Region" : "Draw Table Region"}
          </button></HelpTooltip>

          {/* Proposed regions + process button */}
          {proposedRegions.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1">
                Regions ({proposedRegions.length})
                {proposedRegions.length > 1 && <span className="normal-case ml-1">— will merge top to bottom</span>}
              </div>
              {proposedRegions.map((r, i) => (
                <div key={i} className="flex items-center gap-1 px-2 py-1 rounded border border-pink-500/20 bg-pink-500/5 text-[10px]">
                  <span className="text-pink-300 font-mono w-4">{i + 1}</span>
                  <span className="text-[var(--muted)] flex-1 truncate">
                    ({(r[0] * 100).toFixed(0)}%, {(r[1] * 100).toFixed(0)}%) → ({(r[2] * 100).toFixed(0)}%, {(r[3] * 100).toFixed(0)}%)
                  </span>
                  <button
                    onClick={() => removeProposedRegion(i)}
                    className="text-red-400 hover:text-red-300 px-1"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button
                onClick={processRegions}
                disabled={autoParsing}
                className="w-full text-xs px-3 py-2 rounded bg-pink-600 text-white font-medium hover:bg-pink-500 disabled:opacity-50"
              >
                {autoParsing ? "Processing..." : proposedRegions.length > 1 ? "Process & Merge" : "Process Region"}
              </button>
            </div>
          )}

          {autoDetectedTables.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1">
                Detected on This Page (draw BB to parse)
              </div>
              {autoDetectedTables.map((t: any, i: number) => (
                <div
                  key={i}
                  className="text-[11px] px-2 py-1.5 rounded border border-[var(--border)]/50 text-[var(--muted)]"
                >
                  <span className="font-medium text-[var(--fg)]">{t.category}</span>
                  <span className="text-[var(--muted)]"> ({Math.round(t.confidence * 100)}%)</span>
                  {t.headerText && (
                    <div className="text-[10px] text-[var(--muted)]/70 truncate">"{t.headerText}"</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {existingParsed.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1">
                Previously Parsed
              </div>
              {existingParsed.map((p: any, i: number) => (
                <button
                  key={i}
                  onClick={() => loadExistingParsed(p)}
                  className="w-full text-left text-[11px] px-2 py-1.5 rounded border border-green-500/30 hover:bg-green-500/5"
                >
                  <span className="font-medium text-green-400">{p.category}</span>
                  <span className="text-[var(--muted)]"> — {p.data?.rowCount || 0} rows, {p.data?.columnCount || 0} cols</span>
                </button>
              ))}
            </div>
          )}

          {autoDetectedTables.length === 0 && existingParsed.length === 0 && (
            <div className="text-[10px] text-[var(--muted)] text-center py-4 px-2">
              No auto-detected tables on this page. Draw a BB around a table region to parse it manually.
            </div>
          )}
        </>
      )}

      {autoParsing && (
        <div className="text-[11px] text-pink-300 px-2 py-3 text-center animate-pulse">
          Running 3 parsing methods...
        </div>
      )}

      {autoParseError && (
        <div className="text-[11px] text-red-400 px-2 py-2 border border-red-500/20 rounded bg-red-500/5">
          {autoParseError}
        </div>
      )}

      {tableParseStep === "review" && tableParsedGrid && !autoParsing && (
        <div className="space-y-2">
          {/* Table name input */}
          <div className="px-1">
            <input
              type="text"
              value={tableParsedGrid.tableName || ""}
              onChange={(e) => setTableParsedGrid({ ...tableParsedGrid, tableName: e.target.value })}
              placeholder="Name this table (e.g. Door Schedule)..."
              className="w-full text-xs px-2 py-1.5 bg-[var(--bg)] border border-[var(--border)] rounded outline-none focus:border-pink-400/50 text-[var(--fg)] placeholder:text-[var(--muted)]/40"
            />
          </div>

          <div className="text-[11px] text-green-400 px-2 py-2 border border-green-500/20 rounded bg-green-500/5">
            Parsed: {tableParsedGrid.headers.length} cols, {tableParsedGrid.rows.length} rows
            {tableParsedGrid.tagColumn && <span className="ml-1">(tag: {tableParsedGrid.tagColumn})</span>}
          </div>
          {autoParseMethodInfo && (
            <div className="px-1 space-y-0.5">
              <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide">Methods</div>
              {autoParseMethodInfo.map((m: any, i: number) => (
                <div key={i} className="text-[10px] flex items-center justify-between">
                  <span className={m.confidence > 0 ? "text-[var(--fg)]" : "text-[var(--muted)]/50"}>
                    {m.name}
                  </span>
                  <span className={m.confidence > 0.5 ? "text-green-400" : m.confidence > 0 ? "text-yellow-400" : "text-[var(--muted)]/30"}>
                    {m.confidence > 0 ? `${Math.round(m.confidence * 100)}% (${m.gridShape[0]}r×${m.gridShape[1]}c)` : "no result"}
                  </span>
                </div>
              ))}
            </div>
          )}
          <MapTagsSection grid={tableParsedGrid} yoloInTableRegion={yoloInTableRegion} tagYoloClass={tagYoloClass}
            onTagYoloClassChange={setTagYoloClass} onMapTags={handleMapTags} tagMappingDone={tagMappingDone}
            tagMappingCount={tagMappingCount} showUniqueCount />

          <div className="flex gap-2 px-1">
            <button
              onClick={exportCsv}
              className="flex-1 text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-white hover:opacity-90"
            >
              Export CSV
            </button>
            <button
              onClick={() => toggleTableCompareModal()}
              className="flex-1 text-xs px-3 py-1.5 rounded border border-pink-500/30 text-pink-300 hover:bg-pink-500/10"
            >
              Compare/Edit Cells
            </button>
          </div>
          <button
            onClick={() => { resetTableParse(); setTableParseStep("idle"); setTagMappingDone(false); setTagYoloClass(null); }}
            className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Parse Another
          </button>
        </div>
      )}
    </>
  );
}
