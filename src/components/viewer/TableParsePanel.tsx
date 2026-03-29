"use client";

import { useMemo, useState, useCallback, useEffect } from "react";
import { useViewerStore } from "@/stores/viewerStore";

/**
 * TableParsePanel — Semi-manual table/schedule parsing tool.
 *
 * Step flow:
 *   1. "select-region" — user draws BB around table or clicks auto-detected region
 *   2. System auto-parses OCR words inside region → shows editable grid
 *   3. "define-column" — optional: user draws BB around a column to refine
 *   4. "review" — user edits cells, renames headers, exports CSV
 */
export default function TableParsePanel() {
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const pageIntelligence = useViewerStore((s) => s.pageIntelligence);
  const textractData = useViewerStore((s) => s.textractData);
  const toggleTableParsePanel = useViewerStore((s) => s.toggleTableParsePanel);
  const tableParseStep = useViewerStore((s) => s.tableParseStep);
  const setTableParseStep = useViewerStore((s) => s.setTableParseStep);
  const tableParseRegion = useViewerStore((s) => s.tableParseRegion);
  const setTableParseRegion = useViewerStore((s) => s.setTableParseRegion);
  const tableParsedGrid = useViewerStore((s) => s.tableParsedGrid);
  const setTableParsedGrid = useViewerStore((s) => s.setTableParsedGrid);
  const resetTableParse = useViewerStore((s) => s.resetTableParse);
  const tableParseColumnBBs = useViewerStore((s) => s.tableParseColumnBBs);
  const addTableParseColumnBB = useViewerStore((s) => s.addTableParseColumnBB);

  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingHeader, setEditingHeader] = useState<number | null>(null);
  const [headerEditValue, setHeaderEditValue] = useState("");

  const intel = pageIntelligence[pageNumber] as any;
  const pageTextract = textractData[pageNumber];

  // Auto-detected tables from classifiedTables
  const autoDetectedTables = useMemo(() => {
    if (!intel?.classifiedTables) return [];
    return intel.classifiedTables.filter((t: any) =>
      ["door-schedule", "finish-schedule", "material-schedule", "keynote-table", "unknown-table"].includes(t.category)
    );
  }, [intel]);

  // Already-parsed regions from automated pipeline
  const existingParsed = useMemo(() => {
    if (!intel?.parsedRegions) return [];
    return intel.parsedRegions.filter((r: any) => r.type === "schedule");
  }, [intel]);

  // ─── Auto-parse: run schedule parser on selected region ─────────
  const autoParseRegion = useCallback(
    (bbox: [number, number, number, number]) => {
      if (!pageTextract?.words) return;

      // Convert minmax bbox to ltwh for word intersection
      const regionLTWH: [number, number, number, number] = [
        bbox[0],
        bbox[1],
        bbox[2] - bbox[0],
        bbox[3] - bbox[1],
      ];

      // Get words inside region (center-in-bbox)
      const regionWords = pageTextract.words.filter((w: any) => {
        const cx = w.bbox[0] + w.bbox[2] / 2;
        const cy = w.bbox[1] + w.bbox[3] / 2;
        return cx >= bbox[0] && cx <= bbox[2] && cy >= bbox[1] && cy <= bbox[3];
      });

      if (regionWords.length < 4) {
        setTableParsedGrid({ headers: [], rows: [], tagColumn: undefined });
        setTableParseStep("review");
        return;
      }

      // Cluster rows by Y-center
      const ROW_TOL = 0.006;
      const sorted = [...regionWords].sort(
        (a: any, b: any) => a.bbox[1] + a.bbox[3] / 2 - (b.bbox[1] + b.bbox[3] / 2)
      );
      const rows: { yCenter: number; words: any[] }[] = [];
      let curRow: any[] = [sorted[0]];
      let curY = sorted[0].bbox[1] + sorted[0].bbox[3] / 2;

      for (let i = 1; i < sorted.length; i++) {
        const wy = sorted[i].bbox[1] + sorted[i].bbox[3] / 2;
        if (Math.abs(wy - curY) <= ROW_TOL) {
          curRow.push(sorted[i]);
        } else {
          const avgY = curRow.reduce((s: number, w: any) => s + w.bbox[1] + w.bbox[3] / 2, 0) / curRow.length;
          rows.push({ yCenter: avgY, words: curRow.sort((a: any, b: any) => a.bbox[0] - b.bbox[0]) });
          curRow = [sorted[i]];
          curY = wy;
        }
      }
      if (curRow.length > 0) {
        const avgY = curRow.reduce((s: number, w: any) => s + w.bbox[1] + w.bbox[3] / 2, 0) / curRow.length;
        rows.push({ yCenter: avgY, words: curRow.sort((a: any, b: any) => a.bbox[0] - b.bbox[0]) });
      }

      if (rows.length < 2) {
        setTableParsedGrid({ headers: [], rows: [], tagColumn: undefined });
        setTableParseStep("review");
        return;
      }

      // Detect columns from X-position clustering
      const MIN_COL_GAP = 0.015;
      const allLefts = regionWords.map((w: any) => w.bbox[0] as number).sort((a: number, b: number) => a - b);
      const clusters: number[][] = [[allLefts[0]]];
      for (let i = 1; i < allLefts.length; i++) {
        if (allLefts[i] - allLefts[i - 1] > MIN_COL_GAP) {
          clusters.push([allLefts[i]]);
        } else {
          clusters[clusters.length - 1].push(allLefts[i]);
        }
      }

      // Filter to stable columns (appear in 30%+ of rows)
      const minHits = Math.max(2, Math.floor(rows.length * 0.3));
      let stableClusters = clusters.filter((c) => c.length >= minHits);
      if (stableClusters.length < 2) stableClusters = clusters.length >= 2 ? clusters : [];

      if (stableClusters.length < 2) {
        setTableParsedGrid({ headers: [], rows: [], tagColumn: undefined });
        setTableParseStep("review");
        return;
      }

      // Build column boundaries
      const colCenters = stableClusters
        .map((c) => c.reduce((s, x) => s + x, 0) / c.length)
        .sort((a, b) => a - b);

      const maxRight = Math.max(...regionWords.map((w: any) => w.bbox[0] + w.bbox[2]));
      const colBounds = colCenters.map((center, i) => ({
        left: i === 0 ? bbox[0] - 0.005 : (colCenters[i - 1] + center) / 2,
        right: i === colCenters.length - 1 ? maxRight + 0.005 : (center + colCenters[i + 1]) / 2,
        center,
      }));

      // Extract cells
      const grid = rows.map((row) => {
        const cells = new Array(colBounds.length).fill("");
        for (const w of row.words) {
          const wx = w.bbox[0] + w.bbox[2] / 2;
          let colIdx = colBounds.findIndex((c) => wx >= c.left && wx < c.right);
          if (colIdx === -1) {
            // Nearest column
            let minDist = Infinity;
            colBounds.forEach((c, ci) => {
              const d = Math.abs(wx - c.center);
              if (d < minDist) { minDist = d; colIdx = ci; }
            });
          }
          if (colIdx >= 0) {
            cells[colIdx] = cells[colIdx] ? cells[colIdx] + " " + w.text : w.text;
          }
        }
        return cells;
      });

      // Detect header (first row with most keyword matches)
      const HEADER_KW = new Set([
        "NO", "NO.", "NUMBER", "TAG", "MARK", "TYPE", "SIZE", "WIDTH", "HEIGHT",
        "MATERIAL", "FINISH", "HARDWARE", "REMARKS", "DESCRIPTION", "LOCATION",
        "QTY", "QUANTITY", "RATING", "FRAME", "GLAZING", "NOTES", "ROOM",
        "FLOOR", "CEILING", "WALL", "BASE", "MANUFACTURER", "MODEL", "COLOR",
      ]);
      let headerIdx = 0;
      let bestScore = 0;
      for (let r = 0; r < Math.min(3, grid.length); r++) {
        const score = grid[r].filter((c: string) => HEADER_KW.has(c.toUpperCase().trim())).length;
        if (score > bestScore) { bestScore = score; headerIdx = r; }
      }

      const headers = grid[headerIdx].map((c: string, i: number) => c.trim() || `Column ${i + 1}`);
      const dataRows: Record<string, string>[] = [];
      for (let r = 0; r < grid.length; r++) {
        if (r === headerIdx) continue;
        const row: Record<string, string> = {};
        let hasContent = false;
        for (let c = 0; c < headers.length; c++) {
          const val = (grid[r][c] || "").trim();
          row[headers[c]] = val;
          if (val) hasContent = true;
        }
        if (hasContent) dataRows.push(row);
      }

      // Detect tag column
      const TAG_RE = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$/i;
      const TAG_HEADERS = ["TAG", "MARK", "NO", "NO.", "NUMBER", "NUM", "ITEM"];
      let tagColumn: string | undefined;
      for (const h of headers) {
        if (TAG_HEADERS.some((kw) => h.toUpperCase().trim() === kw)) { tagColumn = h; break; }
      }
      if (!tagColumn) {
        let bestRatio = 0;
        for (const h of headers) {
          let tags = 0, nonEmpty = 0;
          for (const row of dataRows) {
            const v = (row[h] || "").trim();
            if (v) { nonEmpty++; if (TAG_RE.test(v)) tags++; }
          }
          const ratio = nonEmpty > 0 ? tags / nonEmpty : 0;
          if (ratio > bestRatio && ratio >= 0.5) { bestRatio = ratio; tagColumn = h; }
        }
      }

      setTableParsedGrid({ headers, rows: dataRows, tagColumn });
      setTableParseStep("review");
    },
    [pageTextract, setTableParsedGrid, setTableParseStep]
  );

  // ─── Auto-parse when user draws region on canvas ─────────
  useEffect(() => {
    if (tableParseStep === "select-region" && tableParseRegion) {
      autoParseRegion(tableParseRegion);
    }
  }, [tableParseRegion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Use auto-detected region ───────────────────────────
  const selectAutoDetected = useCallback(
    (table: any) => {
      // ClassifiedTable bbox is LTWH, convert to MinMax
      const [l, t, w, h] = table.bbox;
      const bbox: [number, number, number, number] = [l, t, l + w, t + h];
      setTableParseRegion(bbox);
      autoParseRegion(bbox);
    },
    [setTableParseRegion, autoParseRegion]
  );

  // ─── Load existing parsed region ────────────────────────
  const loadExistingParsed = useCallback(
    (parsed: any) => {
      const d = parsed.data;
      setTableParseRegion(parsed.bbox ? [parsed.bbox[0], parsed.bbox[1], parsed.bbox[0] + parsed.bbox[2], parsed.bbox[1] + parsed.bbox[3]] : null);
      setTableParsedGrid({
        headers: d.headers || [],
        rows: d.rows || [],
        tagColumn: d.tagColumn,
      });
      setTableParseStep("review");
    },
    [setTableParseRegion, setTableParsedGrid, setTableParseStep]
  );

  // ─── Edit cell ──────────────────────────────────────────
  const startEditCell = (rowIdx: number, col: string, value: string) => {
    setEditingCell({ row: rowIdx, col });
    setEditValue(value);
  };

  const commitCellEdit = () => {
    if (!editingCell || !tableParsedGrid) return;
    const newRows = [...tableParsedGrid.rows];
    newRows[editingCell.row] = { ...newRows[editingCell.row], [editingCell.col]: editValue };
    setTableParsedGrid({ ...tableParsedGrid, rows: newRows });
    setEditingCell(null);
  };

  // ─── Edit header ────────────────────────────────────────
  const startEditHeader = (idx: number, value: string) => {
    setEditingHeader(idx);
    setHeaderEditValue(value);
  };

  const commitHeaderEdit = () => {
    if (editingHeader === null || !tableParsedGrid) return;
    const oldHeader = tableParsedGrid.headers[editingHeader];
    const newHeader = headerEditValue.trim() || `Column ${editingHeader + 1}`;
    const newHeaders = [...tableParsedGrid.headers];
    newHeaders[editingHeader] = newHeader;
    // Rename key in all rows
    const newRows = tableParsedGrid.rows.map((row) => {
      const newRow: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        newRow[k === oldHeader ? newHeader : k] = v;
      }
      return newRow;
    });
    const newTagColumn = tableParsedGrid.tagColumn === oldHeader ? newHeader : tableParsedGrid.tagColumn;
    setTableParsedGrid({ headers: newHeaders, rows: newRows, tagColumn: newTagColumn });
    setEditingHeader(null);
  };

  // ─── Delete row ─────────────────────────────────────────
  const deleteRow = (idx: number) => {
    if (!tableParsedGrid) return;
    const newRows = tableParsedGrid.rows.filter((_, i) => i !== idx);
    setTableParsedGrid({ ...tableParsedGrid, rows: newRows });
  };

  // ─── Repeat BB: tile a column BB rightward across the table region ──
  const repeatColumnRight = useCallback(
    (colBB: [number, number, number, number]) => {
      if (!tableParseRegion) return;
      const colWidth = colBB[2] - colBB[0];
      const regionRight = tableParseRegion[2];
      let x = colBB[2]; // start after the drawn column
      while (x + colWidth * 0.5 < regionRight) {
        const right = Math.min(x + colWidth, regionRight);
        addTableParseColumnBB([x, colBB[1], right, colBB[3]]);
        x = right;
      }
    },
    [tableParseRegion, addTableParseColumnBB]
  );

  // ─── Parse column BBs into grid: extract words inside each column, Y-cluster into rows ──
  const parseFromColumnBBs = useCallback(() => {
    if (!pageTextract?.words || tableParseColumnBBs.length === 0) return;
    const region = tableParseRegion;
    if (!region) return;

    // Sort columns left to right
    const sortedCols = [...tableParseColumnBBs].sort((a, b) => a[0] - b[0]);

    // For each column, get words and cluster into rows
    const ROW_TOL = 0.006;
    const colWordSets: { words: any[]; yCenter: number }[][] = sortedCols.map((cbb) => {
      const colWords = (pageTextract.words as any[]).filter((w: any) => {
        const cx = w.bbox[0] + w.bbox[2] / 2;
        const cy = w.bbox[1] + w.bbox[3] / 2;
        return cx >= cbb[0] && cx <= cbb[2] && cy >= cbb[1] && cy <= cbb[3];
      });
      // Cluster by Y
      const sorted = [...colWords].sort((a: any, b: any) => (a.bbox[1] + a.bbox[3] / 2) - (b.bbox[1] + b.bbox[3] / 2));
      const rows: { words: any[]; yCenter: number }[] = [];
      if (sorted.length === 0) return rows;
      let cur: any[] = [sorted[0]];
      let curY = sorted[0].bbox[1] + sorted[0].bbox[3] / 2;
      for (let i = 1; i < sorted.length; i++) {
        const wy = sorted[i].bbox[1] + sorted[i].bbox[3] / 2;
        if (Math.abs(wy - curY) <= ROW_TOL) {
          cur.push(sorted[i]);
        } else {
          rows.push({ words: cur, yCenter: cur.reduce((s: number, w: any) => s + w.bbox[1] + w.bbox[3] / 2, 0) / cur.length });
          cur = [sorted[i]];
          curY = wy;
        }
      }
      if (cur.length > 0) {
        rows.push({ words: cur, yCenter: cur.reduce((s: number, w: any) => s + w.bbox[1] + w.bbox[3] / 2, 0) / cur.length });
      }
      return rows;
    });

    // Merge row Y-positions across all columns to build a unified row index
    const allYs: number[] = [];
    for (const colRows of colWordSets) {
      for (const row of colRows) allYs.push(row.yCenter);
    }
    allYs.sort((a, b) => a - b);
    const uniqYs: number[] = [];
    for (const y of allYs) {
      if (uniqYs.length === 0 || Math.abs(y - uniqYs[uniqYs.length - 1]) > ROW_TOL) {
        uniqYs.push(y);
      }
    }

    // Assign column headers
    const headers = sortedCols.map((_, i) => `Column ${i + 1}`);
    // Try to use first row as header
    const headerRow: string[] = sortedCols.map((_, colIdx) => {
      if (colWordSets[colIdx].length === 0) return "";
      return colWordSets[colIdx][0].words.map((w: any) => w.text).join(" ");
    });
    const HEADER_KW = new Set(["NO", "TAG", "MARK", "TYPE", "SIZE", "WIDTH", "HEIGHT", "MATERIAL", "FINISH", "DESCRIPTION", "QTY"]);
    const hasHeaderKW = headerRow.some((v) => HEADER_KW.has(v.toUpperCase().trim()));

    if (hasHeaderKW) {
      for (let i = 0; i < headers.length; i++) {
        if (headerRow[i]) headers[i] = headerRow[i];
      }
    }

    // Build data rows
    const startRowIdx = hasHeaderKW ? 1 : 0;
    const dataRows: Record<string, string>[] = [];
    for (let ri = startRowIdx; ri < uniqYs.length; ri++) {
      const row: Record<string, string> = {};
      let hasContent = false;
      for (let ci = 0; ci < sortedCols.length; ci++) {
        // Find the cell in this column closest to this Y
        const match = colWordSets[ci].find((r) => Math.abs(r.yCenter - uniqYs[ri]) <= ROW_TOL * 2);
        const val = match ? match.words.map((w: any) => w.text).join(" ") : "";
        row[headers[ci]] = val;
        if (val) hasContent = true;
      }
      if (hasContent) dataRows.push(row);
    }

    setTableParsedGrid({ headers, rows: dataRows, tagColumn: undefined });
    setTableParseStep("review");
  }, [pageTextract, tableParseColumnBBs, tableParseRegion, setTableParsedGrid, setTableParseStep]);

  // ─── Export CSV ─────────────────────────────────────────
  const exportCsv = () => {
    if (!tableParsedGrid) return;
    const { headers, rows } = tableParsedGrid;
    const csvRows = [
      headers.map(escCsv).join(","),
      ...rows.map((row) => headers.map((h) => escCsv(row[h] || "")).join(",")),
    ];
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `table_page${pageNumber}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  function escCsv(val: string): string {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  }

  // ─── Render ─────────────────────────────────────────────
  return (
    <div className="w-80 flex flex-col h-full border-l border-[var(--border)] bg-[var(--bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Table Parser</h3>
        <button onClick={toggleTableParsePanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">
          &times;
        </button>
      </div>

      <div className="px-3 py-1.5 border-b border-[var(--border)] text-[10px] text-[var(--muted)]">
        Page {pageNumber}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
        {/* ─── Step: Select Region ─────────────────────────── */}
        {(tableParseStep === "idle" || tableParseStep === "select-region") && (
          <>
            {/* Instruction */}
            <div className="text-[11px] text-[var(--muted)] px-1">
              {tableParseStep === "select-region" ? (
                <span className="text-pink-300">Drawing mode active — draw a BB around a table on the canvas.</span>
              ) : (
                "Select a table to parse, or draw a bounding box around one."
              )}
            </div>

            {/* Draw BB button */}
            <button
              onClick={() => setTableParseStep(tableParseStep === "select-region" ? "idle" : "select-region")}
              className={`w-full text-xs px-3 py-2 rounded border ${
                tableParseStep === "select-region"
                  ? "border-pink-500 bg-pink-500/10 text-pink-300"
                  : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              {tableParseStep === "select-region" ? "Cancel Drawing" : "Draw Table Region"}
            </button>

            {/* Auto-detected tables */}
            {autoDetectedTables.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1">
                  Auto-Detected Tables
                </div>
                {autoDetectedTables.map((t: any, i: number) => (
                  <button
                    key={i}
                    onClick={() => selectAutoDetected(t)}
                    className="w-full text-left text-[11px] px-2 py-1.5 rounded border border-[var(--border)] hover:bg-[var(--surface-hover)]"
                  >
                    <span className="font-medium text-[var(--fg)]">{t.category}</span>
                    <span className="text-[var(--muted)]"> ({Math.round(t.confidence * 100)}%)</span>
                    {t.headerText && (
                      <div className="text-[10px] text-[var(--muted)] truncate">"{t.headerText}"</div>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Already-parsed regions */}
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

            {/* No tables found */}
            {autoDetectedTables.length === 0 && existingParsed.length === 0 && (
              <div className="text-[10px] text-[var(--muted)] text-center py-4 px-2">
                No auto-detected tables on this page. Draw a BB around a table region to parse it manually.
              </div>
            )}
          </>
        )}

        {/* ─── Step: Review / Edit Grid ───────────────────── */}
        {tableParseStep === "review" && tableParsedGrid && (
          <>
            {/* Summary bar */}
            <div className="flex items-center justify-between px-1">
              <div className="text-[11px] text-[var(--fg)]">
                <span className="font-medium">{tableParsedGrid.headers.length}</span>
                <span className="text-[var(--muted)]"> cols, </span>
                <span className="font-medium">{tableParsedGrid.rows.length}</span>
                <span className="text-[var(--muted)]"> rows</span>
                {tableParsedGrid.tagColumn && (
                  <span className="ml-1.5 text-green-400 text-[10px]">tag: {tableParsedGrid.tagColumn}</span>
                )}
              </div>
              <button
                onClick={() => { resetTableParse(); }}
                className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)]"
              >
                Reset
              </button>
            </div>

            {/* Define column button */}
            <button
              onClick={() => setTableParseStep("define-column")}
              className="w-full text-xs px-3 py-1.5 rounded border border-pink-500/30 text-pink-300 hover:bg-pink-500/10"
            >
              Define Columns Manually (BB)
            </button>

            {tableParsedGrid.headers.length === 0 ? (
              <div className="text-[10px] text-[var(--muted)] text-center py-4">
                Could not detect table structure. Try drawing a BB around a specific column.
              </div>
            ) : (
              <>
                {/* Editable table */}
                <div className="overflow-x-auto border border-[var(--border)] rounded">
                  <table className="text-[9px] border-collapse w-full">
                    <thead>
                      <tr>
                        <th className="border border-[var(--border)] px-1 py-1 bg-[var(--surface)] text-[var(--muted)] w-5">#</th>
                        {tableParsedGrid.headers.map((h, hi) => (
                          <th
                            key={hi}
                            className={`border border-[var(--border)] px-1 py-1 text-left font-semibold bg-[var(--surface)] cursor-pointer hover:bg-[var(--surface-hover)] ${
                              h === tableParsedGrid.tagColumn ? "text-green-400" : "text-[var(--fg)]"
                            }`}
                            onDoubleClick={() => startEditHeader(hi, h)}
                          >
                            {editingHeader === hi ? (
                              <input
                                type="text"
                                value={headerEditValue}
                                onChange={(e) => setHeaderEditValue(e.target.value)}
                                onBlur={commitHeaderEdit}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitHeaderEdit();
                                  if (e.key === "Escape") setEditingHeader(null);
                                }}
                                className="w-full bg-transparent border-b border-[var(--accent)] outline-none text-[9px]"
                                autoFocus
                              />
                            ) : (
                              h
                            )}
                          </th>
                        ))}
                        <th className="border border-[var(--border)] px-1 py-1 bg-[var(--surface)] w-4" />
                      </tr>
                    </thead>
                    <tbody>
                      {tableParsedGrid.rows.map((row, ri) => (
                        <tr key={ri} className="hover:bg-[var(--surface-hover)]">
                          <td className="border border-[var(--border)] px-1 py-0.5 text-[var(--muted)] text-center">
                            {ri + 1}
                          </td>
                          {tableParsedGrid.headers.map((h, ci) => (
                            <td
                              key={ci}
                              className={`border border-[var(--border)] px-1 py-0.5 max-w-[80px] cursor-pointer ${
                                h === tableParsedGrid.tagColumn ? "text-green-300 font-mono" : "text-[var(--muted)]"
                              }`}
                              onDoubleClick={() => startEditCell(ri, h, row[h] || "")}
                              title={row[h] || ""}
                            >
                              {editingCell?.row === ri && editingCell?.col === h ? (
                                <input
                                  type="text"
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onBlur={commitCellEdit}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") commitCellEdit();
                                    if (e.key === "Escape") setEditingCell(null);
                                  }}
                                  className="w-full bg-transparent border-b border-[var(--accent)] outline-none text-[9px]"
                                  autoFocus
                                />
                              ) : (
                                <span className="truncate block">{row[h] || ""}</span>
                              )}
                            </td>
                          ))}
                          <td className="border border-[var(--border)] px-0.5 py-0.5 text-center">
                            <button
                              onClick={() => deleteRow(ri)}
                              className="text-red-400/50 hover:text-red-400 text-[9px]"
                              title="Delete row"
                            >
                              x
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Actions */}
                <div className="flex gap-2 px-1">
                  <button
                    onClick={exportCsv}
                    className="flex-1 text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-white hover:opacity-90"
                  >
                    Export CSV
                  </button>
                  <button
                    onClick={() => {
                      // Re-parse from same region
                      if (tableParseRegion) autoParseRegion(tableParseRegion);
                    }}
                    className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                  >
                    Re-parse
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {/* ─── Step: Define Column ────────────────────────── */}
        {tableParseStep === "define-column" && (
          <div className="space-y-2">
            <div className="text-[11px] text-pink-300 px-1">
              Draw a BB around a column on the canvas. Words will be clustered into rows by Y-position.
            </div>

            {/* Show drawn column BBs */}
            {tableParseColumnBBs.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1">
                  Defined Columns ({tableParseColumnBBs.length})
                </div>
                {tableParseColumnBBs.map((cbb, i) => (
                  <div key={i} className="text-[10px] text-[var(--muted)] px-2 py-1 border border-[var(--border)] rounded flex items-center justify-between">
                    <span>Column {i + 1} <span className="text-[9px] opacity-60">({(cbb[2] - cbb[0]).toFixed(3)}w)</span></span>
                    {i === tableParseColumnBBs.length - 1 && tableParseRegion && (
                      <button
                        onClick={() => repeatColumnRight(cbb)}
                        className="text-[9px] text-pink-300 hover:text-pink-200"
                        title="Tile this column width rightward across the table"
                      >
                        Repeat Right
                      </button>
                    )}
                  </div>
                ))}

                {/* Parse from column BBs */}
                <button
                  onClick={parseFromColumnBBs}
                  className="w-full text-xs px-3 py-1.5 rounded bg-pink-500/20 text-pink-300 border border-pink-500/30 hover:bg-pink-500/30"
                >
                  Parse Grid from Columns
                </button>
              </div>
            )}

            <button
              onClick={() => setTableParseStep("review")}
              className="w-full text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
            >
              Back to Review
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
