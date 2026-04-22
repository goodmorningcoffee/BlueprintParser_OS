"use client";

import { useCallback, useEffect, useState } from "react";
import { useViewerStore, useTableParse, useNavigation, usePageData } from "@/stores/viewerStore";
import MapTagsSection, { type MapTagsStrictness } from "./MapTagsSection";

interface ManualParseTabProps {
  yoloInTableRegion: { model: string; className: string; count: number }[];
  detectCsiAndPersist: (grid: any) => Promise<void>;
  tagYoloClass: { model: string; className: string } | null;
  setTagYoloClass: (cls: { model: string; className: string } | null) => void;
  handleMapTags: () => void;
  tagMappingDone: boolean;
  tagMappingCount: number;
  // Phase 3 — Map Tags strictness + drawing-number-prefix scope
  mapTagsStrictness: MapTagsStrictness;
  setMapTagsStrictness: (s: MapTagsStrictness) => void;
  drawingNumberPrefixes: string[];
  setDrawingNumberPrefixes: (prefixes: string[]) => void;
  availablePrefixes: string[];
}

export default function ManualParseTab({
  yoloInTableRegion,
  detectCsiAndPersist,
  tagYoloClass,
  setTagYoloClass,
  handleMapTags,
  tagMappingDone,
  tagMappingCount,
  mapTagsStrictness,
  setMapTagsStrictness,
  drawingNumberPrefixes,
  setDrawingNumberPrefixes,
  availablePrefixes,
}: ManualParseTabProps) {
  const { pageNumber } = useNavigation();
  const { textractData } = usePageData();
  const {
    tableParseStep, setTableParseStep,
    tableParseRegion,
    tableParsedGrid, setTableParsedGrid,
    tableParseColumnBBs, addTableParseColumnBB,
    tableParseRowBBs, addTableParseRowBB, setTableParseRowBBs,
    tableParseColumnNames, setTableParseColumnNames,
    resetTableParse,
  } = useTableParse();

  // Snapshot of tableParseRowBBs before a "Repeat Down" mass-add — lets the
  // user unwind the entire batch as one step (visible Undo button + Cmd-Z).
  // Cleared automatically on panel unmount; scoped to this component.
  const [rowBBsBackup, setRowBBsBackup] = useState<[number, number, number, number][] | null>(null);

  const restoreRowBBs = useCallback(() => {
    if (!rowBBsBackup) return;
    setTableParseRowBBs(rowBBsBackup);
    setRowBBsBackup(null);
  }, [rowBBsBackup, setTableParseRowBBs]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.key !== "z" || e.shiftKey) return;
      // Don't steal undo from text inputs.
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (!rowBBsBackup) return;
      e.preventDefault();
      restoreRowBBs();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rowBBsBackup, restoreRowBBs]);

  const pageTextract = textractData[pageNumber];

  // ─── Repeat BB: tile column BB rightward ──────────────────
  const repeatColumnRight = useCallback(
    (colBB: [number, number, number, number]) => {
      if (!tableParseRegion) return;
      const colWidth = colBB[2] - colBB[0];
      const regionRight = tableParseRegion[2];
      let x = colBB[2];
      while (x + colWidth * 0.5 < regionRight) {
        const right = Math.min(x + colWidth, regionRight);
        addTableParseColumnBB([x, colBB[1], right, colBB[3]]);
        x = right;
      }
    },
    [tableParseRegion, addTableParseColumnBB]
  );

  // ─── Repeat row BB downward ──────────────────────────────
  const repeatRowDown = useCallback(
    (rowBB: [number, number, number, number]) => {
      if (!tableParseRegion) return;
      // Snapshot before the batch append so Cmd-Z / Undo Repeat can unwind
      // the entire tiling as one step (not cell-by-cell).
      setRowBBsBackup(tableParseRowBBs);
      const rowHeight = rowBB[3] - rowBB[1];
      const regionBottom = tableParseRegion[3];
      let y = rowBB[3];
      while (y + rowHeight * 0.5 < regionBottom) {
        const bottom = Math.min(y + rowHeight, regionBottom);
        addTableParseRowBB([rowBB[0], y, rowBB[2], bottom]);
        y = bottom;
      }
    },
    [tableParseRegion, addTableParseRowBB, tableParseRowBBs]
  );

  // Add exactly one row below the last BB. Lets the user inspect each
  // addition and correct any drift before continuing — preferred over
  // Repeat Down on long tables where fixed-step tiling accumulates error.
  const repeatRowOnce = useCallback(
    (rowBB: [number, number, number, number]) => {
      if (!tableParseRegion) return;
      const rowHeight = rowBB[3] - rowBB[1];
      const regionBottom = tableParseRegion[3];
      const y = rowBB[3];
      if (y + rowHeight * 0.5 >= regionBottom) return;
      const bottom = Math.min(y + rowHeight, regionBottom);
      addTableParseRowBB([rowBB[0], y, rowBB[2], bottom]);
    },
    [tableParseRegion, addTableParseRowBB]
  );

  // ─── Parse from column × row intersections ────────────────
  const parseFromIntersections = useCallback(() => {
    if (!pageTextract || tableParseColumnBBs.length === 0 || tableParseRowBBs.length === 0) return;

    const words = pageTextract.words || [];
    const headers = tableParseColumnBBs.map((_: any, i: number) =>
      tableParseColumnNames[i]?.trim() || `Column ${String.fromCharCode(65 + i)}`
    );

    const rows: Record<string, string>[] = [];
    for (const rowBB of tableParseRowBBs) {
      const row: Record<string, string> = {};
      let hasContent = false;
      for (let ci = 0; ci < tableParseColumnBBs.length; ci++) {
        const colBB = tableParseColumnBBs[ci];
        // Cell = intersection of column and row bounding boxes
        const cellMinX = Math.max(colBB[0], rowBB[0]);
        const cellMaxX = Math.min(colBB[2], rowBB[2]);
        const cellMinY = Math.max(colBB[1], rowBB[1]);
        const cellMaxY = Math.min(colBB[3], rowBB[3]);

        // Find words whose center falls inside the cell
        const cellWords = words.filter((w: any) => {
          const cx = w.bbox[0] + w.bbox[2] / 2;
          const cy = w.bbox[1] + w.bbox[3] / 2;
          return cx >= cellMinX && cx <= cellMaxX && cy >= cellMinY && cy <= cellMaxY;
        });

        const text = cellWords
          .sort((a: any, b: any) => a.bbox[0] - b.bbox[0])
          .map((w: any) => w.text)
          .join(" ");

        row[headers[ci]] = text;
        if (text) hasContent = true;
      }
      if (hasContent) rows.push(row);
    }

    // Auto-detect tag column
    const RE_TAG = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$/i;
    let tagColumn: string | undefined;
    for (const h of headers) {
      let tagCount = 0, nonEmpty = 0;
      for (const row of rows) {
        const v = (row[h] || "").trim();
        if (v) { nonEmpty++; if (RE_TAG.test(v)) tagCount++; }
      }
      if (nonEmpty > 0 && tagCount / nonEmpty >= 0.5) { tagColumn = h; break; }
    }

    const grid = { headers, rows, tagColumn };
    setTableParsedGrid(grid);
    // Manual parse doesn't use the merger — clear source-picker meta so the
    // Compare/Edit modal doesn't show stale per-method results from a prior auto-parse.
    useViewerStore.getState().setTableParseMeta(null);
    detectCsiAndPersist(grid);
    setTableParseStep("review");
    useViewerStore.getState().setMode("move");
  }, [pageTextract, tableParseColumnBBs, tableParseRowBBs, tableParseColumnNames, setTableParsedGrid, setTableParseStep, detectCsiAndPersist]);

  return (
    <div className="space-y-2">
      {/* Step 1: Draw table region */}
      <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1">Step 1: Table Region</div>
      <div className="text-[9px] text-[var(--muted)] px-1">Draw around the table grid only. Do NOT include any title text above the table.</div>
      {!tableParseRegion ? (
        <button
          onClick={() => {
            const next = tableParseStep === "select-region" ? "idle" : "select-region";
            setTableParseStep(next);
            useViewerStore.getState().setMode(next !== "idle" ? "pointer" : "move");
          }}
          className={`w-full text-xs px-3 py-1.5 rounded border ${
            tableParseStep === "select-region"
              ? "border-pink-500 bg-pink-500/10 text-pink-300"
              : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
          }`}
        >
          {tableParseStep === "select-region" ? "Drawing... (click cancel)" : "Draw Table Region"}
        </button>
      ) : (
        <div className="flex items-center justify-between px-1">
          <span className="text-[10px] text-green-400">Region defined</span>
          <button
            onClick={() => {
              useViewerStore.getState().setTableParseRegion(null);
              useViewerStore.getState().setTableParseStep("idle");
              useViewerStore.getState().setMode("move");
            }}
            className="text-[9px] text-[var(--muted)] hover:text-red-400"
          >
            Clear
          </button>
        </div>
      )}

      {/* Step 2: Draw columns + name them */}
      {tableParseRegion && (
        <>
          <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1 mt-2">Step 2: Define Columns</div>
          <div className="text-[9px] text-[var(--muted)] px-1">
            Draw a BB around each column, left to right. First column should be the tag/key column.
          </div>
          <button
            onClick={() => {
              const next = tableParseStep === "define-column" ? "idle" : "define-column";
              setTableParseStep(next);
              useViewerStore.getState().setMode(next !== "idle" ? "pointer" : "move");
            }}
            className={`w-full text-xs px-3 py-1.5 rounded border ${
              tableParseStep === "define-column"
                ? "border-pink-500 bg-pink-500/10 text-pink-300"
                : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
            }`}
          >
            {tableParseStep === "define-column" ? "Stop Drawing Columns" : `Draw Columns (${tableParseColumnBBs.length} defined)`}
          </button>

          {tableParseColumnBBs.length > 0 && (
            <div className="space-y-1">
              {tableParseColumnBBs.map((cbb: any, i: number) => (
                <div key={i} className="flex items-center gap-1 px-1">
                  <input
                    type="text"
                    value={tableParseColumnNames[i] || ""}
                    placeholder={`Column ${String.fromCharCode(65 + i)}`}
                    onChange={(e) => {
                      const names = [...tableParseColumnNames];
                      while (names.length <= i) names.push("");
                      names[i] = e.target.value;
                      setTableParseColumnNames(names);
                    }}
                    className="flex-1 text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--fg)] placeholder:text-[var(--muted)]/40 focus:outline-none focus:border-pink-400/50"
                  />
                  {i === tableParseColumnBBs.length - 1 && (
                    <button
                      onClick={() => repeatColumnRight(cbb)}
                      className="text-[9px] text-pink-300 hover:text-pink-200 whitespace-nowrap"
                    >
                      Repeat &rarr;
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Step 3: Draw rows */}
      {tableParseRegion && tableParseColumnBBs.length > 0 && (
        <>
          <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1 mt-2">Step 3: Define Rows</div>
          <div className="text-[9px] text-[var(--muted)] px-1">
            Draw a BB around each row. Use "Repeat Down" after the first to auto-fill evenly spaced rows.
          </div>
          <button
            onClick={() => {
              const next = tableParseStep === "define-row" ? "idle" : "define-row";
              setTableParseStep(next);
              useViewerStore.getState().setMode(next !== "idle" ? "pointer" : "move");
            }}
            className={`w-full text-xs px-3 py-1.5 rounded border ${
              tableParseStep === "define-row"
                ? "border-purple-500 bg-purple-500/10 text-purple-300"
                : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
            }`}
          >
            {tableParseStep === "define-row" ? "Stop Drawing Rows" : `Draw Rows (${tableParseRowBBs.length} defined)`}
          </button>

          {tableParseRowBBs.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between px-1">
                <span className="text-[10px] text-[var(--muted)]">{tableParseRowBBs.length} rows</span>
                <div className="flex items-center gap-2">
                  {rowBBsBackup && (
                    <button
                      onClick={restoreRowBBs}
                      className="text-[9px] text-amber-300 hover:text-amber-200"
                      title="Undo the last Repeat Down batch (Cmd-Z)"
                    >
                      Undo Repeat
                    </button>
                  )}
                  <button
                    onClick={() => repeatRowOnce(tableParseRowBBs[tableParseRowBBs.length - 1])}
                    className="text-[9px] text-purple-300 hover:text-purple-200"
                    title="Add one row below the last — drift-free alternative to Repeat Down"
                  >
                    +1 Row &darr;
                  </button>
                  <button
                    onClick={() => repeatRowDown(tableParseRowBBs[tableParseRowBBs.length - 1])}
                    className="text-[9px] text-purple-300 hover:text-purple-200"
                    title="Tile rows down to the region bottom at the current row's height"
                  >
                    Repeat Down &darr;
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Step 4: Parse from intersections */}
      {tableParseColumnBBs.length > 0 && tableParseRowBBs.length > 0 && (
        <>
          <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1 mt-2">Step 4: Parse</div>
          <button
            onClick={parseFromIntersections}
            className="w-full text-xs px-3 py-2 rounded bg-pink-500/20 text-pink-300 border border-pink-500/30 hover:bg-pink-500/30 font-medium"
          >
            Parse Table ({tableParseColumnBBs.length} cols &times; {tableParseRowBBs.length} rows = {tableParseColumnBBs.length * tableParseRowBBs.length} cells)
          </button>
        </>
      )}

      {/* Reset */}
      <button
        onClick={() => { resetTableParse(); setRowBBsBackup(null); }}
        className="w-full text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)] mt-2"
      >
        Reset All
      </button>

      {/* Show result if parsed */}
      {tableParsedGrid && tableParsedGrid.headers.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-green-400 px-1 py-1 border border-green-500/20 rounded bg-green-500/5">
            Parsed: {tableParsedGrid.headers.length} cols, {tableParsedGrid.rows.length} rows — use Compare/Edit Cells tab to verify.
          </div>
          <MapTagsSection
            grid={tableParsedGrid}
            yoloInTableRegion={yoloInTableRegion}
            tagYoloClass={tagYoloClass}
            onTagYoloClassChange={setTagYoloClass}
            onMapTags={handleMapTags}
            tagMappingDone={tagMappingDone}
            tagMappingCount={tagMappingCount}
            strictness={mapTagsStrictness}
            onStrictnessChange={setMapTagsStrictness}
            drawingNumberPrefixes={drawingNumberPrefixes}
            onDrawingNumberPrefixesChange={setDrawingNumberPrefixes}
            availablePrefixes={availablePrefixes}
          />
        </div>
      )}
    </div>
  );
}
