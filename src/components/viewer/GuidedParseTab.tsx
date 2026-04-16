"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useViewerStore, useTableParse, useNavigation, useProject } from "@/stores/viewerStore";
import { extractCellsFromGrid } from "@/lib/ocr-grid-detect";
import MapTagsSection from "./MapTagsSection";

interface GuidedParseTabProps {
  detectCsiAndPersist: (grid: any) => Promise<void>;
  yoloInTableRegion: { model: string; className: string; count: number }[];
  tagYoloClass: { model: string; className: string } | null;
  setTagYoloClass: (cls: { model: string; className: string } | null) => void;
  handleMapTags: () => void;
  tagMappingDone: boolean;
  tagMappingCount: number;
  setTagMappingDone: (done: boolean) => void;
}

export default function GuidedParseTab({
  detectCsiAndPersist,
  yoloInTableRegion,
  tagYoloClass, setTagYoloClass,
  handleMapTags, tagMappingDone, tagMappingCount, setTagMappingDone,
}: GuidedParseTabProps) {
  const { pageNumber } = useNavigation();
  const { projectId } = useProject();
  const {
    tableParseRegion, setTableParseRegion,
    tableParsedGrid, setTableParsedGrid,
    setTableParseStep,
  } = useTableParse();

  // Guided parse store fields
  const guidedParseActive = useViewerStore((s) => s.guidedParseActive);
  const guidedParseRows = useViewerStore((s) => s.guidedParseRows);
  const guidedParseCols = useViewerStore((s) => s.guidedParseCols);
  const setGuidedParseActive = useViewerStore((s) => s.setGuidedParseActive);
  const setGuidedParseRegion = useViewerStore((s) => s.setGuidedParseRegion);
  const setGuidedParseRows = useViewerStore((s) => s.setGuidedParseRows);
  const setGuidedParseCols = useViewerStore((s) => s.setGuidedParseCols);
  const resetGuidedParse = useViewerStore((s) => s.resetGuidedParse);

  // Tuning sliders
  const [rowTolerance, setRowTolerance] = useState(0.006);
  const [colGap, setColGap] = useState(0.015);
  const [colConfidence, setColConfidence] = useState(0.3);
  const [expectedCols, setExpectedCols] = useState<number | null>(null);
  const [showTune, setShowTune] = useState(false);

  // Proposal state
  const [proposing, setProposing] = useState(false);
  const [proposalInfo, setProposalInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Propose grid ──────────────────────────────────────────
  const proposeGrid = useCallback(async (region?: [number, number, number, number]) => {
    const bbox = region || tableParseRegion;
    if (!bbox || !projectId) return;
    setGuidedParseRegion(bbox);
    setProposing(true);
    setError(null);
    try {
      const resp = await fetch("/api/table-parse/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          pageNumber,
          regionBbox: bbox,
          layoutHint: expectedCols ? { columns: expectedCols } : undefined,
          gridOptions: {
            rowTolerance,
            minColGap: colGap,
            minHitsRatio: colConfidence,
          },
        }),
      });
      if (!resp.ok) throw new Error("Proposal failed");
      const data = await resp.json();
      setGuidedParseRows(data.proposedRows || []);
      setGuidedParseCols(data.proposedCols || []);
      setGuidedParseActive(true);
      setProposalInfo(`${data.rowCount} rows × ${data.colCount} cols (conf: ${(data.confidence * 100).toFixed(0)}%)`);
    } catch (err: any) {
      setError(err.message || "Failed to propose grid");
      setProposalInfo(null);
    } finally {
      setProposing(false);
    }
  }, [projectId, pageNumber, tableParseRegion, rowTolerance, colGap, colConfidence, expectedCols,
    setGuidedParseRegion, setGuidedParseRows, setGuidedParseCols, setGuidedParseActive]);

  // ─── Debounced re-propose on slider change ─────────────────
  useEffect(() => {
    if (!guidedParseActive || !tableParseRegion) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      proposeGrid(tableParseRegion);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [rowTolerance, colGap, colConfidence, expectedCols]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Capture drawn region ──────────────────────────────────
  useEffect(() => {
    if (tableParseRegion && !guidedParseActive && !parsed) {
      proposeGrid(tableParseRegion);
    }
  }, [tableParseRegion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Parse from grid ───────────────────────────────────────
  const handleParse = useCallback(async () => {
    const pageTextract = useViewerStore.getState().textractData[pageNumber];
    if (!pageTextract?.words || guidedParseRows.length < 2 || guidedParseCols.length < 2) return;

    const result = extractCellsFromGrid(pageTextract.words, guidedParseRows, guidedParseCols);
    if (result.rows.length === 0) {
      setError("No cells found in grid");
      return;
    }

    // Set parsed grid for review/map tags
    setTableParsedGrid({ headers: result.headers, rows: result.rows });
    // Guided parse doesn't use the merger — clear source-picker meta so the
    // Compare/Edit modal doesn't show stale per-method results from a prior auto-parse.
    useViewerStore.getState().setTableParseMeta(null);
    setTableParseStep("review");

    // Save via shared detectCsiAndPersist — surface PATCH failures to the
    // user via the local error state so we don't silently lose the parse.
    try {
      await detectCsiAndPersist({
        headers: result.headers,
        rows: result.rows,
        tableName: `Table p.${pageNumber}`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      return;
    }

    resetGuidedParse();
    setParsed(true);
    useViewerStore.getState().setMode("move");
  }, [pageNumber, guidedParseRows, guidedParseCols, resetGuidedParse, detectCsiAndPersist,
    setTableParsedGrid, setTableParseStep]);

  // ─── Repeat row down ───────────────────────────────────────
  const repeatRowDown = useCallback(() => {
    if (guidedParseRows.length < 3 || !tableParseRegion) return;
    const lastRowH = guidedParseRows[guidedParseRows.length - 1] - guidedParseRows[guidedParseRows.length - 2];
    const bottom = tableParseRegion[3];
    let y = guidedParseRows[guidedParseRows.length - 1];
    const newRows = [...guidedParseRows];
    while (y + lastRowH * 0.5 < bottom) {
      y += lastRowH;
      newRows.push(Math.min(y, bottom));
    }
    setGuidedParseRows(newRows);
  }, [guidedParseRows, tableParseRegion, setGuidedParseRows]);

  // ─── Repeat column right ──────────────────────────────────
  const repeatColRight = useCallback(() => {
    if (guidedParseCols.length < 3 || !tableParseRegion) return;
    const lastColW = guidedParseCols[guidedParseCols.length - 1] - guidedParseCols[guidedParseCols.length - 2];
    const right = tableParseRegion[2];
    let x = guidedParseCols[guidedParseCols.length - 1];
    const newCols = [...guidedParseCols];
    while (x + lastColW * 0.5 < right) {
      x += lastColW;
      newCols.push(Math.min(x, right));
    }
    setGuidedParseCols(newCols);
  }, [guidedParseCols, tableParseRegion, setGuidedParseCols]);

  // ─── Cancel ────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    resetGuidedParse();
    setTableParseRegion(null);
    setProposalInfo(null);
    setError(null);
    setParsed(false);
    useViewerStore.getState().setMode("move");
  }, [resetGuidedParse, setTableParseRegion]);

  // ─── Set drawing mode on mount ─────────────────────────────
  useEffect(() => {
    if (!tableParseRegion && !guidedParseActive && !parsed) {
      setTableParseStep("select-region");
      useViewerStore.getState().setMode("pointer");
    }
    return () => {
      resetGuidedParse();
      setTableParseStep("idle");
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      {/* Instructions */}
      {!tableParseRegion && !guidedParseActive && !parsed && (
        <div className="text-[10px] text-[var(--muted)] text-center py-4 px-2">
          Draw a bounding box around the table you want to parse.
          <br />
          <span className="text-[9px]">The system will propose row/column boundaries that you can tune.</span>
        </div>
      )}

      {/* Proposing indicator */}
      {proposing && (
        <div className="text-[10px] text-[var(--accent)] text-center py-2">Proposing grid...</div>
      )}

      {/* Error */}
      {error && (
        <div className="text-[10px] text-red-400 px-2 py-1 rounded bg-red-500/10 border border-red-500/20">{error}</div>
      )}

      {/* Proposal info + controls */}
      {proposalInfo && guidedParseActive && (
        <>
          <div className="text-[10px] text-emerald-400 font-medium px-1">{proposalInfo}</div>

          {/* Tune section */}
          <button
            onClick={() => setShowTune(!showTune)}
            className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] px-1 flex items-center gap-1"
          >
            <span className={`transition-transform ${showTune ? "rotate-90" : ""}`}>&#9656;</span>
            Tune Detection
          </button>

          {showTune && (
            <div className="space-y-2 px-2 py-2 rounded border border-[var(--border)] bg-[var(--surface)]">
              {/* Row Sensitivity */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[9px] text-[var(--muted)]">Row Sensitivity</label>
                  <span className="text-[9px] text-[var(--fg)] tabular-nums">{rowTolerance.toFixed(3)}</span>
                </div>
                <input type="range" min={0.002} max={0.02} step={0.001} value={rowTolerance}
                  onChange={(e) => setRowTolerance(parseFloat(e.target.value))}
                  className="w-full h-1 accent-pink-400" />
                <div className="flex justify-between text-[8px] text-[var(--muted)]">
                  <span>Tight</span><span>Loose</span>
                </div>
              </div>

              {/* Column Sensitivity */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[9px] text-[var(--muted)]">Column Sensitivity</label>
                  <span className="text-[9px] text-[var(--fg)] tabular-nums">{colGap.toFixed(3)}</span>
                </div>
                <input type="range" min={0.005} max={0.05} step={0.005} value={colGap}
                  onChange={(e) => setColGap(parseFloat(e.target.value))}
                  className="w-full h-1 accent-pink-400" />
                <div className="flex justify-between text-[8px] text-[var(--muted)]">
                  <span>More cols</span><span>Fewer cols</span>
                </div>
              </div>

              {/* Column Confidence */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[9px] text-[var(--muted)]">Column Confidence</label>
                  <span className="text-[9px] text-[var(--fg)] tabular-nums">{(colConfidence * 100).toFixed(0)}%</span>
                </div>
                <input type="range" min={0.1} max={0.8} step={0.05} value={colConfidence}
                  onChange={(e) => setColConfidence(parseFloat(e.target.value))}
                  className="w-full h-1 accent-pink-400" />
                <div className="flex justify-between text-[8px] text-[var(--muted)]">
                  <span>Keep weak</span><span>Strict</span>
                </div>
              </div>

              {/* Expected Columns */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[9px] text-[var(--muted)]">Expected Columns</label>
                  <select
                    value={expectedCols ?? "auto"}
                    onChange={(e) => setExpectedCols(e.target.value === "auto" ? null : parseInt(e.target.value))}
                    className="text-[9px] px-1 py-0.5 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
                  >
                    <option value="auto">Auto</option>
                    {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Repeat buttons */}
          <div className="flex gap-2 px-1">
            <button
              onClick={repeatRowDown}
              disabled={guidedParseRows.length < 3}
              className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--muted)]/40 disabled:opacity-30"
            >
              Repeat ↓
            </button>
            <button
              onClick={repeatColRight}
              disabled={guidedParseCols.length < 3}
              className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--muted)]/40 disabled:opacity-30"
            >
              Repeat →
            </button>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 px-1 pt-1">
            <button
              onClick={handleCancel}
              className="flex-1 text-[10px] px-2 py-1.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
            >
              Cancel
            </button>
            <button
              onClick={handleParse}
              disabled={guidedParseRows.length < 2 || guidedParseCols.length < 2}
              className="flex-1 text-[10px] px-2 py-1.5 rounded border border-pink-400/40 bg-pink-500/10 text-pink-300 hover:bg-pink-500/20 disabled:opacity-30"
            >
              Parse Grid
            </button>
          </div>
        </>
      )}

      {/* Post-parse: review + map tags */}
      {parsed && tableParsedGrid && (
        <div className="space-y-2">
          <div className="text-[10px] text-emerald-400 font-medium px-1">
            Parsed: {tableParsedGrid.headers.length} columns, {tableParsedGrid.rows.length} rows
          </div>
          <button
            onClick={() => { setParsed(false); handleCancel(); }}
            className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Parse Another
          </button>
          <MapTagsSection
            grid={tableParsedGrid}
            yoloInTableRegion={yoloInTableRegion}
            tagYoloClass={tagYoloClass}
            onTagYoloClassChange={setTagYoloClass}
            onMapTags={handleMapTags}
            tagMappingDone={tagMappingDone}
            tagMappingCount={tagMappingCount}
          />
        </div>
      )}
    </div>
  );
}
