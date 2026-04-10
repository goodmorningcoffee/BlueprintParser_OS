"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useViewerStore, useTableParse, useNavigation, useProject } from "@/stores/viewerStore";
import { exportTableCsv } from "@/lib/table-parse-utils";
import HelpTooltip from "./HelpTooltip";
import MapTagsSection from "./MapTagsSection";

type ProposedRegion = [number, number, number, number]; // [minX, minY, maxX, maxY]

/**
 * Debug mode toggle for the table-parse pipeline. When ON, the API returns
 * per-method results so the drill-down UI can compare each parser's output.
 * When OFF (default), only the merged grid + infraErrors are returned —
 * production users see a clean simple UX.
 *
 * Two ways to enable (either):
 * 1. Build-time: set NEXT_PUBLIC_TABLE_PARSE_DEBUG=1 in .env.local or staging build
 * 2. Runtime: in the browser console, run `localStorage.setItem('bp2_debug_table_parse', '1')`
 *    Then refresh. Disable with `localStorage.removeItem('bp2_debug_table_parse')`.
 *
 * Future: an Admin Control "Table Parsing" tab will replace this with a
 * persisted server-side appSettings flag.
 */
function isTableParseDebugMode(): boolean {
  if (process.env.NEXT_PUBLIC_TABLE_PARSE_DEBUG === "1") return true;
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      return window.localStorage.getItem("bp2_debug_table_parse") === "1";
    } catch {
      return false;
    }
  }
  return false;
}

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
    tableParseOptions, setTableParseOptions,
  } = useTableParse();

  const [autoParsing, setAutoParsing] = useState(false);
  const [autoParseError, setAutoParseError] = useState<string | null>(null);
  const [autoParseMethodInfo, setAutoParseMethodInfo] = useState<any[] | null>(null);
  // Phase A.4: pipeline-level errors (PDF fetch, rasterize, etc.) — distinct
  // from per-method errors. These tell the user the parser never even ran.
  const [autoParseInfraErrors, setAutoParseInfraErrors] = useState<{ stage: string; error: string }[]>([]);
  // Phase D.1: full per-method grids for the drill-down UI. Live-only — not
  // persisted (pageIntelligence stays clean for the LLM).
  const [autoParseMethodResults, setAutoParseMethodResults] = useState<any[] | null>(null);

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
      setAutoParseInfraErrors([]);
      setAutoParseMethodResults(null);

      const debugMode = isTableParseDebugMode();

      try {
        // Parse each region independently then merge
        let mergedHeaders: string[] = [];
        let mergedRows: Record<string, string>[] = [];
        let lastMethodInfo: any[] | null = null;
        // Note: multi-region parses only show the LAST region's method drill-down
        // (UI space constraint — by design). Same constraint as colBoundaries/rowBoundaries below.
        let lastMethodResults: any[] | null = null;
        const collectedInfraErrors: { stage: string; error: string }[] = [];
        let tagColumn: string | undefined;
        let firstColBoundaries: number[] | undefined;
        let firstRowBoundaries: number[] | undefined;

        for (let i = 0; i < proposedRegions.length; i++) {
          const bbox = proposedRegions[i];
          const resp = await fetch("/api/table-parse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId, pageNumber, regionBbox: bbox, ...tableParseOptions, debugMode }),
          });

          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `Region ${i + 1}: API error ${resp.status}`);
          }

          const result = await resp.json();
          lastMethodInfo = result.methods || null;
          lastMethodResults = result.methodResults || null;
          if (Array.isArray(result.infraErrors) && result.infraErrors.length > 0) {
            // Tag with region index when multi-region so users can pinpoint
            const tagged = proposedRegions.length > 1
              ? result.infraErrors.map((e: any) => ({ ...e, stage: `region ${i + 1}: ${e.stage}` }))
              : result.infraErrors;
            collectedInfraErrors.push(...tagged);
          }

          if (i === 0) {
            // First region: use its headers and boundaries as canonical
            mergedHeaders = result.headers || [];
            tagColumn = result.tagColumn;
            firstColBoundaries = result.colBoundaries;
            firstRowBoundaries = result.rowBoundaries;
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
        setAutoParseMethodResults(lastMethodResults);
        setAutoParseInfraErrors(collectedInfraErrors);
        const grid = {
          headers: mergedHeaders,
          rows: mergedRows,
          tagColumn,
          csiTags: [],
          tableName: proposedRegions.length > 1 ? `Merged (${proposedRegions.length} regions)` : undefined,
          // Only include boundaries for single-region parse (multi-region merges invalidate positions)
          ...(proposedRegions.length === 1 && firstColBoundaries ? { colBoundaries: firstColBoundaries } : {}),
          ...(proposedRegions.length === 1 && firstRowBoundaries ? { rowBoundaries: firstRowBoundaries } : {}),
        };
        setTableParsedGrid(grid);
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

  const [reparseLoading, setReparseLoading] = useState(false);

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

          {/* ─── Parsing Options (always visible) ─────────────── */}
          <ParseOptionsPanel options={tableParseOptions} onChange={setTableParseOptions} />
        </>
      )}

      {autoParsing && (
        <div className="text-[11px] text-pink-300 px-2 py-3 text-center animate-pulse">
          Parsing table...
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

          {/* Phase A.4: pipeline-level errors (PDF fetch, rasterize) */}
          {autoParseInfraErrors.length > 0 && (
            <div className="text-[10px] text-red-300 px-2 py-2 border border-red-500/30 rounded bg-red-500/10 space-y-0.5">
              <div className="font-semibold uppercase tracking-wide text-[9px] text-red-400">
                Pipeline errors ({autoParseInfraErrors.length}) — methods below were skipped
              </div>
              {autoParseInfraErrors.map((e, i) => (
                <div key={i} className="font-mono">
                  <span className="text-red-400">{e.stage}:</span> {e.error}
                </div>
              ))}
            </div>
          )}

          {/* Phase A.4: amber for empty results, green for non-empty */}
          {tableParsedGrid.headers.length > 0 && tableParsedGrid.rows.length > 0 ? (
            <div className="text-[11px] text-green-400 px-2 py-2 border border-green-500/20 rounded bg-green-500/5">
              Parsed: {tableParsedGrid.headers.length} cols, {tableParsedGrid.rows.length} rows
              {tableParsedGrid.tagColumn && <span className="ml-1">(tag: {tableParsedGrid.tagColumn})</span>}
            </div>
          ) : (
            <div className="text-[11px] text-amber-400 px-2 py-2 border border-amber-500/30 rounded bg-amber-500/5">
              No table detected — see method details below for what each parser returned
            </div>
          )}
          {autoParseMethodInfo && (
            <div className="px-1 space-y-0.5">
              <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide">Methods (summary)</div>
              {autoParseMethodInfo.map((m: any, i: number) => (
                <div key={i} className="text-[10px] flex items-center justify-between gap-2">
                  <span className={m.confidence > 0 ? "text-[var(--fg)]" : "text-[var(--muted)]/50"}>
                    {m.name}
                  </span>
                  <span className={m.confidence > 0.5 ? "text-green-400" : m.confidence > 0 ? "text-yellow-400" : m.error ? "text-red-400/70" : "text-[var(--muted)]/30"}>
                    {m.confidence > 0
                      ? `${Math.round(m.confidence * 100)}% (${m.gridShape[0]}r×${m.gridShape[1]}c)`
                      : m.error
                      ? <span title={m.error}>error</span>
                      : "no result"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Phase D.2: per-method drill-down with grid view + manual override.
              Live-only — these results are not persisted (pageIntelligence is the
              LLM context blob and stays single-merged-grid). Reparse to compare. */}
          {autoParseMethodResults && autoParseMethodResults.length > 0 && (
            <div className="px-1 space-y-1">
              <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide pt-1">
                All Method Results — drill down to compare ({autoParseMethodResults.length})
              </div>
              {autoParseMethodResults.map((mr: any, i: number) => (
                <MethodDrillDown
                  key={`${mr.method}-${i}`}
                  result={mr}
                  onUseThis={(r) => {
                    // FOLLOWUP-2: clear tagColumn/csiTags on override. They were detected
                    // against the merged grid's headers and may not exist in the override's
                    // headers — leaving them stale would break Map Tags downstream.
                    // The next save flow will re-detect via detectCsiAndPersist.
                    setTableParsedGrid({
                      ...tableParsedGrid,
                      headers: r.headers,
                      rows: r.rows,
                      colBoundaries: r.colBoundaries,
                      rowBoundaries: r.rowBoundaries,
                      tagColumn: undefined,
                      csiTags: [],
                    });
                  }}
                />
              ))}
            </div>
          )}
          <MapTagsSection grid={tableParsedGrid} yoloInTableRegion={yoloInTableRegion} tagYoloClass={tagYoloClass}
            onTagYoloClassChange={setTagYoloClass} onMapTags={handleMapTags} tagMappingDone={tagMappingDone}
            tagMappingCount={tagMappingCount} showUniqueCount />

          {/* TATR Cell Structure Detection */}
          <DetectCellStructureButton />

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
          {/* Reparse with adjusted options */}
          <ParseOptionsPanel options={tableParseOptions} onChange={setTableParseOptions} />
          <button
            onClick={() => {
              // Go back to idle with the existing region so user can reparse
              if (tableParseRegion) {
                setProposedRegions([tableParseRegion]);
              }
              setTableParsedGrid(null);
              setAutoParseMethodInfo(null);
              setAutoParseMethodResults(null);
              setAutoParseError(null);
              setAutoParseInfraErrors([]);
              setTableParseStep("idle");
            }}
            className="w-full text-xs px-3 py-1.5 rounded border border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
          >
            Reparse Table
          </button>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                if (tableParsedGrid) await detectCsiAndPersist(tableParsedGrid);
                resetTableParse(); setTableParseStep("idle"); setTagMappingDone(false); setTagYoloClass(null);
              }}
              className="flex-1 text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-500"
            >
              Save
            </button>
            <button
              onClick={() => { resetTableParse(); setTableParseStep("idle"); setTagMappingDone(false); setTagYoloClass(null); }}
              className="flex-1 text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Per-method drill-down (Phase D.2) ───────────────────────
// Renders a single method's result as a collapsible row showing the method
// name, confidence/shape badge, and (when expanded) a small grid table with
// a "Use this result" override button.
function MethodDrillDown({
  result,
  onUseThis,
}: {
  result: any;
  onUseThis: (result: any) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const headers: string[] = result.headers || [];
  const rows: Record<string, string>[] = result.rows || [];
  const hasData = headers.length > 0 && rows.length > 0;

  return (
    <div className="border border-[var(--border)]/30 rounded">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-2 py-1 text-[10px] hover:bg-[var(--surface-hover)]"
      >
        <span className="flex items-center gap-1">
          <span className={`transition-transform inline-block text-[8px] ${expanded ? "rotate-90" : ""}`}>&#9654;</span>
          <span className={hasData ? "text-[var(--fg)] font-mono" : "text-[var(--muted)]/60 font-mono"}>
            {result.method}
          </span>
        </span>
        <span className={result.confidence > 0.5 ? "text-green-400" : result.confidence > 0 ? "text-yellow-400" : result.error ? "text-red-400/70" : "text-[var(--muted)]/30"}>
          {hasData
            ? `${Math.round(result.confidence * 100)}% — ${rows.length}r×${headers.length}c`
            : result.error
            ? <span title={result.error}>error</span>
            : "no result"}
        </span>
      </button>
      {expanded && (
        <div className="px-2 py-2 border-t border-[var(--border)]/30 space-y-1">
          {hasData ? (
            <>
              <div className="overflow-x-auto max-h-48 overflow-y-auto border border-[var(--border)]/20 rounded">
                <table className="text-[9px] font-mono border-collapse w-full">
                  <thead className="sticky top-0 bg-[var(--surface)]">
                    <tr>
                      {headers.map((h, hi) => (
                        <th key={hi} className="border border-[var(--border)]/30 px-1 py-0.5 text-left whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 30).map((row, ri) => (
                      <tr key={ri} className="hover:bg-[var(--surface-hover)]/30">
                        {headers.map((h, ci) => (
                          <td key={ci} className="border border-[var(--border)]/20 px-1 py-0.5 align-top">
                            <div className="max-w-[120px] truncate" title={(row[h] || "").replace(/\n/g, " · ")}>
                              {((row[h] || "").substring(0, 60)).replace(/\n/g, " ")}
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 30 && (
                <div className="text-[9px] text-[var(--muted)]/60 italic">
                  Showing first 30 of {rows.length} rows
                </div>
              )}
              <button
                onClick={() => onUseThis(result)}
                className="w-full text-[9px] px-2 py-1 rounded border border-pink-500/40 text-pink-300 hover:bg-pink-500/10"
              >
                Use this result instead of merged
              </button>
            </>
          ) : (
            <div className="text-[10px] text-[var(--muted)] italic px-1">
              {result.error || "Method returned no result"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Detect Cell Structure Button (TATR) ─────────────────────
function DetectCellStructureButton() {
  const { projectId } = useProject();
  const { pageNumber } = useNavigation();
  const { tableParseRegion } = useTableParse();
  const tableCellStructure = useViewerStore((s) => s.tableCellStructure);
  const setTableCellStructure = useViewerStore((s) => s.setTableCellStructure);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasStructure = tableCellStructure?.pageNumber === pageNumber;

  async function handleDetect() {
    if (!tableParseRegion || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/table-structure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, pageNumber, regionBbox: tableParseRegion }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        setError(data.error || `HTTP ${resp.status}`);
        return;
      }
      setTableCellStructure({
        cells: (data.cells || []).map((c: any) => ({ ...c, text: c.text || "", highlighted: false })),
        pageNumber,
        regionBbox: tableParseRegion,
      });
    } catch (err: any) {
      setError(err.message || "Failed to detect cell structure");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="px-1">
      <button
        onClick={hasStructure ? () => setTableCellStructure(null) : handleDetect}
        disabled={loading || !tableParseRegion}
        className={`w-full text-xs px-3 py-1.5 rounded border ${
          hasStructure
            ? "border-cyan-500/40 text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20"
            : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-cyan-500/30"
        } disabled:opacity-40`}
      >
        {loading ? "Detecting..." : hasStructure ? `Cell Structure (${tableCellStructure!.cells.length} cells) ✕` : "Detect Cell Structure"}
      </button>
      {error && <div className="text-[9px] text-red-400 mt-1 px-1">{error}</div>}
    </div>
  );
}

// ─── Parsing Options Panel ───────────────────────────────────
const DEFAULTS = {
  rowTolerance: 0.006, minColGap: 0.015, colHitRatio: 0.3, headerMode: "auto" as const,
  minHLineLengthRatio: 0.15, minVLineLengthRatio: 0.10, clusteringTolerance: 15,
  mergerEditDistance: 2,
};

type ParseOptions = {
  rowTolerance: number; minColGap: number; colHitRatio: number; headerMode: "auto" | "first" | "none";
  minHLineLengthRatio: number; minVLineLengthRatio: number; clusteringTolerance: number;
  mergerEditDistance: number;
};

function ParseOptionsPanel({
  options,
  onChange,
}: {
  options: ParseOptions;
  onChange: (patch: Partial<ParseOptions>) => void;
}) {
  const [open, setOpen] = useState(false);

  const slider = (
    label: string, key: keyof ParseOptions, min: number, max: number, step: number, fmt?: (v: number) => string
  ) => {
    const val = options[key] as number;
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[var(--muted)] w-24 shrink-0">{label}</span>
        <input type="range" min={min} max={max} step={step} value={val}
          onChange={(e) => onChange({ [key]: parseFloat(e.target.value) })}
          className="flex-1 h-1 bg-[var(--border)] rounded appearance-none cursor-pointer accent-pink-400" />
        <span className="text-[10px] text-pink-400 font-mono w-10 text-right">{fmt ? fmt(val) : val}</span>
      </div>
    );
  };

  return (
    <div className="border-t border-[var(--border)] pt-2 mt-2">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[10px] text-[var(--muted)] hover:text-[var(--fg)] w-full">
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>&#9654;</span>
        Parsing Options
        {JSON.stringify(options) !== JSON.stringify(DEFAULTS) && (
          <span className="text-amber-400 ml-1">(modified)</span>
        )}
      </button>
      {open && (
        <div className="space-y-2 mt-2">
          <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide">OCR Settings</div>
          {slider("Row tolerance", "rowTolerance", 0.002, 0.02, 0.001, (v) => v.toFixed(3))}
          {slider("Column gap", "minColGap", 0.005, 0.05, 0.001, (v) => v.toFixed(3))}
          {slider("Col consistency", "colHitRatio", 0.1, 0.6, 0.05, (v) => `${Math.round(v * 100)}%`)}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--muted)] w-24 shrink-0">Header row</span>
            <div className="flex gap-1">
              {(["auto", "first", "none"] as const).map((m) => (
                <button key={m} onClick={() => onChange({ headerMode: m })}
                  className={`px-2 py-0.5 text-[9px] rounded border ${
                    options.headerMode === m
                      ? "bg-pink-500/20 border-pink-500/40 text-pink-300"
                      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                  }`}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide mt-2">Line Detection</div>
          {slider("H-line min", "minHLineLengthRatio", 0.05, 0.5, 0.01, (v) => `${Math.round(v * 100)}%`)}
          {slider("V-line min", "minVLineLengthRatio", 0.05, 0.5, 0.01, (v) => `${Math.round(v * 100)}%`)}
          {slider("Clustering", "clusteringTolerance", 5, 50, 1, (v) => `${v}px`)}

          <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide mt-2">Merger</div>
          {slider("Edit distance", "mergerEditDistance", 0, 5, 1, (v) => String(v))}

          <button onClick={() => onChange(DEFAULTS)}
            className="text-[9px] text-[var(--muted)] hover:text-[var(--fg)] underline">
            Reset all to defaults
          </button>
        </div>
      )}
    </div>
  );
}
