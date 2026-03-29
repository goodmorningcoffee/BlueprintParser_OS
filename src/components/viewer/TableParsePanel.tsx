"use client";

import { useMemo, useState, useCallback, useEffect } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { mapYoloToOcrText } from "@/lib/yolo-tag-engine";

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
  const toggleTableCompareModal = useViewerStore((s) => s.toggleTableCompareModal);
  const csiCodes = useViewerStore((s) => s.csiCodes);
  const tableParseColumnNames = useViewerStore((s) => s.tableParseColumnNames);
  const setTableParseColumnNames = useViewerStore((s) => s.setTableParseColumnNames);
  const tableParseRowBBs = useViewerStore((s) => s.tableParseRowBBs);
  const addTableParseRowBB = useViewerStore((s) => s.addTableParseRowBB);
  const setPage = useViewerStore((s) => s.setPage);
  const tableParseTab = useViewerStore((s) => s.tableParseTab);
  const setTableParseTab = useViewerStore((s) => s.setTableParseTab);
  const pageNames = useViewerStore((s) => s.pageNames);
  const annotations = useViewerStore((s) => s.annotations);
  const addYoloTag = useViewerStore((s) => s.addYoloTag);

  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingHeader, setEditingHeader] = useState<number | null>(null);
  const [headerEditValue, setHeaderEditValue] = useState("");
  const [tagYoloClass, setTagYoloClass] = useState<{ model: string; className: string } | null>(null);
  const [tagMappingDone, setTagMappingDone] = useState(false);
  const [tagMappingCount, setTagMappingCount] = useState(0);

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

  // ─── YOLO classes in table region (for tag column class picker) ───
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

  // ─── Map Tags: create YoloTags from parsed tag column ───
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
      // Get description from the first row with this tag
      const row = tableParsedGrid.rows.find((r) => r[tagCol]?.trim() === tagText);
      const desc = row
        ? tableParsedGrid.headers
            .filter((h) => h !== tagCol)
            .map((h) => row[h] || "")
            .join(" ")
            .trim()
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

  // ─── Auto-parse: call multi-method API endpoint ─────────
  const projectId = useViewerStore((s) => s.projectId);
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
        setTableParsedGrid({
          headers: result.headers || [],
          rows: result.rows || [],
          tagColumn: result.tagColumn,
        });
        setTableParseStep("review");
      } catch (err: any) {
        console.error("[auto-parse] Failed:", err);
        setAutoParseError(err.message || "Auto-parse failed");
        setTableParsedGrid({ headers: [], rows: [] });
        setTableParseStep("review");
      } finally {
        setAutoParsing(false);
      }
    },
    [projectId, pageNumber, setTableParsedGrid, setTableParseStep]
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

  // ─── Repeat row BB downward ──────────────────────────────
  const repeatRowDown = useCallback(
    (rowBB: [number, number, number, number]) => {
      if (!tableParseRegion) return;
      const rowHeight = rowBB[3] - rowBB[1];
      const regionBottom = tableParseRegion[3];
      let y = rowBB[3];
      while (y + rowHeight * 0.5 < regionBottom) {
        const bottom = Math.min(y + rowHeight, regionBottom);
        addTableParseRowBB([rowBB[0], y, rowBB[2], bottom]);
        y = bottom;
      }
    },
    [tableParseRegion, addTableParseRowBB]
  );

  // ─── Parse from intersections: columns × rows = cells, OCR fills each ──
  const parseFromIntersections = useCallback(() => {
    if (!pageTextract?.words || tableParseColumnBBs.length === 0 || tableParseRowBBs.length === 0) return;

    // Use draw order as canonical order (first drawn = Column A / Row 1)
    const sortedCols = tableParseColumnBBs;  // draw order = column order
    const sortedRows = tableParseRowBBs;     // draw order = row order

    // Column names (user-defined or default)
    const headers = sortedCols.map((_, i) =>
      tableParseColumnNames[i] || `Column ${String.fromCharCode(65 + i)}`
    );

    // For each row × column intersection, find OCR words
    const dataRows: Record<string, string>[] = [];
    for (const rowBB of sortedRows) {
      const row: Record<string, string> = {};
      let hasContent = false;
      for (let ci = 0; ci < sortedCols.length; ci++) {
        const colBB = sortedCols[ci];
        // Cell = intersection of column X-range and row Y-range
        const cellMinX = colBB[0];
        const cellMaxX = colBB[2];
        const cellMinY = rowBB[1];
        const cellMaxY = rowBB[3];

        // Find OCR words whose centers fall inside this cell
        const cellWords = (pageTextract.words as any[]).filter((w: any) => {
          const cx = w.bbox[0] + w.bbox[2] / 2;
          const cy = w.bbox[1] + w.bbox[3] / 2;
          return cx >= cellMinX && cx <= cellMaxX && cy >= cellMinY && cy <= cellMaxY;
        });

        // Sort left-to-right and join
        const text = cellWords
          .sort((a: any, b: any) => a.bbox[0] - b.bbox[0])
          .map((w: any) => w.text)
          .join(" ");

        row[headers[ci]] = text;
        if (text) hasContent = true;
      }
      if (hasContent) dataRows.push(row);
    }

    setTableParsedGrid({ headers, rows: dataRows, tagColumn: undefined });
    setTableParseStep("review");
    setTableParseTab("auto"); // Switch to auto tab to see the review grid
  }, [pageTextract, tableParseColumnBBs, tableParseRowBBs, tableParseColumnNames, setTableParsedGrid, setTableParseStep]);

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
    const headers = sortedCols.map((_, i) => `Column ${String.fromCharCode(65 + i)}`);
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

  // ─── Project-wide parsed tables (for "All Tables" tab) ───
  const allParsedTables = useMemo(() => {
    const tables: { pageNum: number; region: any; name: string; category: string; rowCount: number; colCount: number; csiTags: any[] }[] = [];
    for (const [pn, intel] of Object.entries(pageIntelligence)) {
      const pi = intel as any;
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
    return tables.sort((a, b) => a.pageNum - b.pageNum);
  }, [pageIntelligence]);

  // ─── Render ─────────────────────────────────────────────
  return (
    <div className="w-80 flex flex-col h-full border-l border-[var(--border)] bg-[var(--bg)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Schedules / Tables</h3>
        <button onClick={toggleTableParsePanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">
          &times;
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["all", "auto", "manual", "compare"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setTableParseTab(tab)}
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
                <div className="text-[10px] text-[var(--muted)] px-1 pb-1">{allParsedTables.length} table(s)</div>
                {allParsedTables.map((t, i) => (
                  <div
                    key={i}
                    onDoubleClick={() => setPage(t.pageNum)}
                    className={`px-2 py-1.5 rounded border cursor-pointer ${
                      t.pageNum === pageNumber
                        ? "border-pink-400/30 bg-pink-500/5"
                        : "border-[var(--border)] hover:bg-[var(--surface-hover)]"
                    }`}
                    title="Double-click to go to page"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-[var(--fg)] truncate">{t.name}</span>
                      <span className="text-[9px] text-[var(--muted)] whitespace-nowrap ml-1">
                        {pageNames[t.pageNum] || `p.${t.pageNum}`}
                      </span>
                    </div>
                    <div className="text-[10px] text-[var(--muted)]">
                      {t.colCount} cols, {t.rowCount} rows
                    </div>
                    {t.csiTags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {t.csiTags.slice(0, 4).map((c: any, j: number) => (
                          <span key={j} className="text-[8px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-300 font-mono">
                            {c.code}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* ════════ TAB: Auto Parse ════════ */}
        {tableParseTab === "auto" && (
          <>
        {/* ─── Step: Select Region ─────────────────────────── */}
        {(tableParseStep === "idle" || tableParseStep === "select-region") && (
          <>
            {/* Instruction */}
            <div className="text-[11px] text-[var(--muted)] px-1">
              {tableParseStep === "select-region" ? (
                <span className="text-pink-300">Drawing mode active — draw a BB around a table on the canvas.</span>
              ) : (
                "Draw a bounding box around the table you want to parse."
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

            {/* Auto-detected tables — informational only, not click-to-parse */}
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

        {/* Loading state */}
        {autoParsing && (
          <div className="text-[11px] text-pink-300 px-2 py-3 text-center animate-pulse">
            Running 3 parsing methods...
          </div>
        )}

        {/* Error state */}
        {autoParseError && (
          <div className="text-[11px] text-red-400 px-2 py-2 border border-red-500/20 rounded bg-red-500/5">
            {autoParseError}
          </div>
        )}

        {/* After auto-parse succeeds, show success + method breakdown */}
        {tableParseStep === "review" && tableParsedGrid && !autoParsing && (
          <div className="space-y-2">
            <div className="text-[11px] text-green-400 px-2 py-2 border border-green-500/20 rounded bg-green-500/5">
              Parsed: {tableParsedGrid.headers.length} cols, {tableParsedGrid.rows.length} rows
              {tableParsedGrid.tagColumn && <span className="ml-1">(tag: {tableParsedGrid.tagColumn})</span>}
            </div>
            {/* Method breakdown */}
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
            {/* ─── Map Tags section ─── */}
            {tableParsedGrid.tagColumn && (
              <div className="border border-cyan-500/30 rounded px-2 py-2 space-y-1.5 bg-cyan-500/5">
                <div className="text-[10px] text-cyan-400 font-medium">Map Tags to Drawings</div>
                <p className="text-[9px] text-[var(--muted)]">
                  Tag column: <span className="font-mono text-[var(--fg)]">{tableParsedGrid.tagColumn}</span> ({new Set(tableParsedGrid.rows.map((r) => r[tableParsedGrid.tagColumn!]?.trim()).filter(Boolean)).size} unique tags)
                </p>
                {/* YOLO class picker */}
                {yoloInTableRegion.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="text-[9px] text-[var(--muted)]">YOLO shapes in table region:</div>
                    {yoloInTableRegion.map((g, i) => (
                      <button key={i}
                        onClick={() => setTagYoloClass(tagYoloClass?.model === g.model && tagYoloClass?.className === g.className ? null : { model: g.model, className: g.className })}
                        className={`w-full text-left text-[10px] px-2 py-1 rounded border ${
                          tagYoloClass?.model === g.model && tagYoloClass?.className === g.className
                            ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                            : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
                        }`}>
                        <span className="font-medium">{g.className}</span>
                        <span className="text-[var(--muted)]"> ({g.model}) &mdash; {g.count} found</span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => setTagYoloClass(tagYoloClass?.className === "" ? null : { model: "", className: "" })}
                  className={`w-full text-left text-[10px] px-2 py-1 rounded border ${
                    tagYoloClass?.className === ""
                      ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                      : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
                  }`}>
                  No shape &mdash; free-floating tags
                </button>
                {!tagMappingDone ? (
                  <button
                    onClick={handleMapTags}
                    className="w-full text-xs px-3 py-1.5 rounded bg-cyan-600 text-white hover:bg-cyan-500"
                  >
                    Map Tags
                  </button>
                ) : (
                  <div className="text-[10px] text-green-400">
                    Mapped {tagMappingCount} tags to YOLO Tags panel
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2 px-1">
              <button
                onClick={exportCsv}
                className="flex-1 text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-white hover:opacity-90"
              >
                Export CSV
              </button>
              <button
                onClick={() => { setTableParseTab("all"); }}
                className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
              >
                View All Tables
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
        )}

        {/* ════════ TAB: Manual Parse ════════ */}
        {tableParseTab === "manual" && (
          <div className="space-y-2">
            {/* Step 1: Draw table region */}
            <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1">Step 1: Table Region</div>
            {!tableParseRegion ? (
              <button
                onClick={() => setTableParseStep(tableParseStep === "select-region" ? "idle" : "select-region")}
                className={`w-full text-xs px-3 py-1.5 rounded border ${
                  tableParseStep === "select-region"
                    ? "border-pink-500 bg-pink-500/10 text-pink-300"
                    : "border-[var(--border)] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                }`}
              >
                {tableParseStep === "select-region" ? "Drawing... (click cancel)" : "Draw Table Region"}
              </button>
            ) : (
              <div className="text-[10px] text-green-400 px-1">Region defined</div>
            )}

            {/* Step 2: Draw columns + name them */}
            {tableParseRegion && (
              <>
                <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide px-1 mt-2">Step 2: Define Columns</div>
                <button
                  onClick={() => setTableParseStep(tableParseStep === "define-column" ? "idle" : "define-column")}
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
                    {tableParseColumnBBs.map((cbb, i) => (
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
                            Repeat →
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
                <button
                  onClick={() => setTableParseStep(tableParseStep === "define-row" ? "idle" : "define-row")}
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
                      <button
                        onClick={() => repeatRowDown(tableParseRowBBs[tableParseRowBBs.length - 1])}
                        className="text-[9px] text-purple-300 hover:text-purple-200"
                      >
                        Repeat Down ↓
                      </button>
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
                  Parse Table ({tableParseColumnBBs.length} cols × {tableParseRowBBs.length} rows = {tableParseColumnBBs.length * tableParseRowBBs.length} cells)
                </button>
              </>
            )}

            {/* Reset */}
            <button
              onClick={() => resetTableParse()}
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
                {/* Map Tags (same as auto parse tab) */}
                {tableParsedGrid.tagColumn && (
                  <div className="border border-cyan-500/30 rounded px-2 py-2 space-y-1.5 bg-cyan-500/5">
                    <div className="text-[10px] text-cyan-400 font-medium">Map Tags to Drawings</div>
                    <p className="text-[9px] text-[var(--muted)]">
                      Tag column: <span className="font-mono text-[var(--fg)]">{tableParsedGrid.tagColumn}</span>
                    </p>
                    {yoloInTableRegion.length > 0 && (
                      <div className="space-y-0.5">
                        <div className="text-[9px] text-[var(--muted)]">YOLO shapes in table region:</div>
                        {yoloInTableRegion.map((g, i) => (
                          <button key={i}
                            onClick={() => setTagYoloClass(tagYoloClass?.model === g.model && tagYoloClass?.className === g.className ? null : { model: g.model, className: g.className })}
                            className={`w-full text-left text-[10px] px-2 py-1 rounded border ${
                              tagYoloClass?.model === g.model && tagYoloClass?.className === g.className
                                ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                                : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
                            }`}>
                            <span className="font-medium">{g.className}</span>
                            <span className="text-[var(--muted)]"> ({g.model}) &mdash; {g.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => setTagYoloClass(tagYoloClass?.className === "" ? null : { model: "", className: "" })}
                      className={`w-full text-left text-[10px] px-2 py-1 rounded border ${
                        tagYoloClass?.className === ""
                          ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                          : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
                      }`}>
                      No shape &mdash; free-floating tags
                    </button>
                    {!tagMappingDone ? (
                      <button onClick={handleMapTags}
                        className="w-full text-xs px-3 py-1.5 rounded bg-cyan-600 text-white hover:bg-cyan-500">
                        Map Tags
                      </button>
                    ) : (
                      <div className="text-[10px] text-green-400">
                        Mapped {tagMappingCount} tags to YOLO Tags panel
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ════════ TAB: Compare/Edit Cells ════════ */}
        {tableParseTab === "compare" && (
          <div className="space-y-1">
            <div className="text-[11px] text-[var(--muted)] px-1 pb-1">
              Select a table to compare with the original and edit cells.
            </div>

            {allParsedTables.length === 0 ? (
              <div className="text-[10px] text-[var(--muted)] text-center py-8 px-2">
                No parsed tables yet. Use Auto Parse or Manual tabs first.
              </div>
            ) : (
              <>
                {/* Current page tables first */}
                {(() => {
                  const currentPageTables = allParsedTables.filter((t) => t.pageNum === pageNumber);
                  const otherTables = allParsedTables.filter((t) => t.pageNum !== pageNumber);

                  return (
                    <>
                      {currentPageTables.length > 0 && (
                        <div className="text-[9px] text-pink-300 uppercase tracking-wide px-1 pt-1">
                          This Page ({pageNames[pageNumber] || `p.${pageNumber}`})
                        </div>
                      )}
                      {currentPageTables.map((t, i) => (
                        <button
                          key={`cur-${i}`}
                          onClick={() => {
                            loadExistingParsed(t.region);
                            toggleTableCompareModal();
                          }}
                          className="w-full text-left px-2 py-2 rounded border border-pink-400/30 bg-pink-500/5 hover:bg-pink-500/10 space-y-0.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-medium text-[var(--fg)] truncate">{t.name}</span>
                            <span className="text-[9px] text-pink-300">Compare</span>
                          </div>
                          <div className="text-[10px] text-[var(--muted)]">
                            {t.colCount} cols, {t.rowCount} rows
                          </div>
                        </button>
                      ))}

                      {otherTables.length > 0 && (
                        <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide px-1 pt-2">
                          Other Pages
                        </div>
                      )}
                      {otherTables.map((t, i) => (
                        <button
                          key={`other-${i}`}
                          onClick={() => {
                            setPage(t.pageNum);
                            loadExistingParsed(t.region);
                            toggleTableCompareModal();
                          }}
                          className="w-full text-left px-2 py-1.5 rounded border border-[var(--border)] hover:bg-[var(--surface-hover)] space-y-0.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-medium text-[var(--fg)] truncate">{t.name}</span>
                            <span className="text-[9px] text-[var(--muted)]">{pageNames[t.pageNum] || `p.${t.pageNum}`}</span>
                          </div>
                          <div className="text-[10px] text-[var(--muted)]">
                            {t.colCount} cols, {t.rowCount} rows
                          </div>
                        </button>
                      ))}
                    </>
                  );
                })()}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
