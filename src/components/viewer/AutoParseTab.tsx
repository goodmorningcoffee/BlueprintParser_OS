"use client";

import { useState, useCallback, useEffect } from "react";
import { useViewerStore, useTableParse, useNavigation, useProject } from "@/stores/viewerStore";
import { exportTableCsv } from "@/lib/table-parse-utils";
import HelpTooltip from "./HelpTooltip";
import MapTagsSection from "./MapTagsSection";

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

  const autoParseRegion = useCallback(
    async (bbox: [number, number, number, number]) => {
      setAutoParsing(true);
      setAutoParseError(null);
      setAutoParseMethodInfo(null);

      try {
        const resp = await fetch("/api/table-parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, pageNumber, regionBbox: bbox }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || `API error ${resp.status}`);
        }

        const result = await resp.json();
        setAutoParseMethodInfo(result.methods || null);
        const grid = {
          headers: result.headers || [],
          rows: result.rows || [],
          tagColumn: result.tagColumn,
          csiTags: result.csiTags || [],
        };
        setTableParsedGrid(grid);
        detectCsiAndPersist(grid);
        setTableParseStep("review");
        useViewerStore.getState().setMode("move");
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
    [projectId, pageNumber, setTableParsedGrid, setTableParseStep, detectCsiAndPersist]
  );

  // Auto-parse when user draws region on canvas
  useEffect(() => {
    if (tableParseRegion && tableParseTab === "auto") {
      autoParseRegion(tableParseRegion);
    }
  }, [tableParseRegion]); // eslint-disable-line react-hooks/exhaustive-deps

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
            {tableParseStep === "select-region" ? "Cancel Drawing" : "Draw Table Region"}
          </button></HelpTooltip>

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
