"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore } from "@/stores/viewerStore";

interface TableCompareModalProps {
  pdfDoc: PDFDocumentProxy;
}

/**
 * TableCompareModal — Fullscreen comparison view for parsed table data.
 *
 * Mode A (default): Side-by-side — cropped original image on left, editable grid on right.
 * Mode B: Overlay — parsed text overlaid on original image with adjustable opacity.
 */
export default function TableCompareModal({ pdfDoc }: TableCompareModalProps) {
  const toggleModal = useViewerStore((s) => s.toggleTableCompareModal);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const tableParseRegion = useViewerStore((s) => s.tableParseRegion);
  const tableParsedGrid = useViewerStore((s) => s.tableParsedGrid);
  const setTableParsedGrid = useViewerStore((s) => s.setTableParsedGrid);
  const textractData = useViewerStore((s) => s.textractData);
  const setPageIntelligence = useViewerStore((s) => s.setPageIntelligence);

  const [mode, setMode] = useState<"side-by-side" | "overlay">("side-by-side");
  const [overlayOpacity, setOverlayOpacity] = useState(0.55);
  const [croppedImageUrl, setCroppedImageUrl] = useState<string | null>(null);
  const [cropDimensions, setCropDimensions] = useState<{ w: number; h: number } | null>(null);
  const [loading, setLoading] = useState(true);

  // Active cell for editing + highlighting
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingHeader, setEditingHeader] = useState<number | null>(null);
  const [headerEditValue, setHeaderEditValue] = useState("");

  // Refs
  const highlightCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ─── Cell word bboxes (computed once on open) ────────────
  // Maps "r{row}c{col}" to [minX, minY, maxX, maxY] relative to the crop region
  const cellBboxes = useMemo(() => {
    const map: Record<string, [number, number, number, number]> = {};
    if (!tableParseRegion || !tableParsedGrid || !textractData[pageNumber]?.words) return map;

    const [rMinX, rMinY, rMaxX, rMaxY] = tableParseRegion;
    const rW = rMaxX - rMinX;
    const rH = rMaxY - rMinY;
    const words = textractData[pageNumber].words;

    // Get words inside region
    const regionWords = words.filter((w: any) => {
      const cx = w.bbox[0] + w.bbox[2] / 2;
      const cy = w.bbox[1] + w.bbox[3] / 2;
      return cx >= rMinX && cx <= rMaxX && cy >= rMinY && cy <= rMaxY;
    });

    // Cluster rows by Y
    const ROW_TOL = 0.006;
    const sorted = [...regionWords].sort((a: any, b: any) =>
      (a.bbox[1] + a.bbox[3] / 2) - (b.bbox[1] + b.bbox[3] / 2)
    );
    const rowClusters: { yCenter: number; words: any[] }[] = [];
    if (sorted.length > 0) {
      let cur: any[] = [sorted[0]];
      let curY = sorted[0].bbox[1] + sorted[0].bbox[3] / 2;
      for (let i = 1; i < sorted.length; i++) {
        const wy = sorted[i].bbox[1] + sorted[i].bbox[3] / 2;
        if (Math.abs(wy - curY) <= ROW_TOL) {
          cur.push(sorted[i]);
        } else {
          rowClusters.push({ yCenter: cur.reduce((s: number, w: any) => s + w.bbox[1] + w.bbox[3] / 2, 0) / cur.length, words: cur });
          cur = [sorted[i]];
          curY = wy;
        }
      }
      if (cur.length > 0) {
        rowClusters.push({ yCenter: cur.reduce((s: number, w: any) => s + w.bbox[1] + w.bbox[3] / 2, 0) / cur.length, words: cur });
      }
    }

    // For each row cluster, compute a merged bbox relative to the crop
    const headers = tableParsedGrid.headers;
    // Skip header row (index 0 in clusters), data rows start at 1
    const dataStartIdx = rowClusters.length > tableParsedGrid.rows.length ? 1 : 0;

    for (let ri = 0; ri < tableParsedGrid.rows.length; ri++) {
      const clusterIdx = ri + dataStartIdx;
      if (clusterIdx >= rowClusters.length) break;
      const rowWords = rowClusters[clusterIdx].words;

      // For each column, find words that likely belong to it by text matching
      for (let ci = 0; ci < headers.length; ci++) {
        const cellText = (tableParsedGrid.rows[ri][headers[ci]] || "").trim();
        if (!cellText) continue;

        // Find words whose text appears in the cell value
        const cellTokens = cellText.split(/\s+/);
        const matchingWords = rowWords.filter((w: any) =>
          cellTokens.some((t: string) => w.text === t || w.text.includes(t) || t.includes(w.text))
        );

        if (matchingWords.length > 0) {
          let wMinX = Infinity, wMinY = Infinity, wMaxX = -Infinity, wMaxY = -Infinity;
          for (const w of matchingWords) {
            wMinX = Math.min(wMinX, w.bbox[0]);
            wMinY = Math.min(wMinY, w.bbox[1]);
            wMaxX = Math.max(wMaxX, w.bbox[0] + w.bbox[2]);
            wMaxY = Math.max(wMaxY, w.bbox[1] + w.bbox[3]);
          }
          // Convert to crop-relative coords (0-1 within the crop)
          map[`r${ri}c${ci}`] = [
            (wMinX - rMinX) / rW,
            (wMinY - rMinY) / rH,
            (wMaxX - rMinX) / rW,
            (wMaxY - rMinY) / rH,
          ];
        }
      }
    }
    return map;
  }, [tableParseRegion, tableParsedGrid, textractData, pageNumber]);

  // ─── Crop page image on mount ────────────────────────────
  useEffect(() => {
    if (!tableParseRegion || !pdfDoc) return;
    let cancelled = false;

    async function crop() {
      setLoading(true);
      try {
        const page = await pdfDoc.getPage(pageNumber);
        const scale = 4; // 4x for hi-res comparison
        const viewport = page.getViewport({ scale });

        // Render full page to offscreen canvas
        const fullCanvas = document.createElement("canvas");
        fullCanvas.width = viewport.width;
        fullCanvas.height = viewport.height;
        const ctx = fullCanvas.getContext("2d")!;
        await page.render({ canvasContext: ctx, viewport }).promise;

        if (cancelled) return;

        // Crop to region
        const [rMinX, rMinY, rMaxX, rMaxY] = tableParseRegion!;
        const sx = rMinX * viewport.width;
        const sy = rMinY * viewport.height;
        const sw = (rMaxX - rMinX) * viewport.width;
        const sh = (rMaxY - rMinY) * viewport.height;

        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = Math.round(sw);
        cropCanvas.height = Math.round(sh);
        const cropCtx = cropCanvas.getContext("2d")!;
        cropCtx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);

        if (cancelled) return;

        setCroppedImageUrl(cropCanvas.toDataURL("image/png"));
        setCropDimensions({ w: cropCanvas.width, h: cropCanvas.height });
      } catch (err) {
        console.error("[TableCompareModal] crop failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    crop();
    return () => { cancelled = true; };
  }, [pdfDoc, pageNumber, tableParseRegion]);

  // ─── Draw cell highlight on source image ─────────────────
  useEffect(() => {
    const canvas = highlightCanvasRef.current;
    if (!canvas || !cropDimensions || mode !== "side-by-side") return;

    canvas.width = cropDimensions.w;
    canvas.height = cropDimensions.h;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!activeCell) return;
    const key = `r${activeCell.row}c${activeCell.col}`;
    const bbox = cellBboxes[key];
    if (!bbox) return;

    const [bMinX, bMinY, bMaxX, bMaxY] = bbox;
    const x = bMinX * canvas.width;
    const y = bMinY * canvas.height;
    const w = (bMaxX - bMinX) * canvas.width;
    const h = (bMaxY - bMinY) * canvas.height;

    // Magenta highlight
    ctx.fillStyle = "rgba(232, 121, 160, 0.25)";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.strokeStyle = "#e879a0";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
  }, [activeCell, cellBboxes, cropDimensions, mode]);

  // ─── Draw overlay canvas (Mode B) ────────────────────────
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !cropDimensions || mode !== "overlay" || !tableParsedGrid) return;

    canvas.width = cropDimensions.w;
    canvas.height = cropDimensions.h;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const headers = tableParsedGrid.headers;
    const rows = tableParsedGrid.rows;
    if (headers.length === 0 || rows.length === 0) return;

    // Render parsed text at cell positions
    ctx.font = "12px monospace";

    for (let ri = 0; ri < rows.length; ri++) {
      for (let ci = 0; ci < headers.length; ci++) {
        const key = `r${ri}c${ci}`;
        const bbox = cellBboxes[key];
        const text = rows[ri][headers[ci]] || "";
        if (!bbox || !text) continue;

        const x = bbox[0] * canvas.width;
        const y = bbox[1] * canvas.height;
        const w = (bbox[2] - bbox[0]) * canvas.width;
        const h = (bbox[3] - bbox[1]) * canvas.height;

        // Blue cell background
        ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
        ctx.fillRect(x, y, w, h);

        // Blue cell border
        ctx.strokeStyle = "rgba(59, 130, 246, 0.4)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);

        // Blue text
        ctx.fillStyle = "rgba(59, 130, 246, 0.9)";
        const fontSize = Math.max(9, Math.min(14, h * 0.7));
        ctx.font = `${fontSize}px monospace`;
        ctx.fillText(text, x + 2, y + h - 2, w - 4);
      }
    }
  }, [mode, tableParsedGrid, cellBboxes, cropDimensions, overlayOpacity]);

  // ─── Cell editing ─────────────────────────────────────────
  const startEdit = useCallback((row: number, col: number) => {
    if (!tableParsedGrid) return;
    const header = tableParsedGrid.headers[col];
    setActiveCell({ row, col });
    setEditValue(tableParsedGrid.rows[row][header] || "");
    setTimeout(() => editInputRef.current?.focus(), 30);
  }, [tableParsedGrid]);

  const commitEdit = useCallback(() => {
    if (!activeCell || !tableParsedGrid) return;
    const header = tableParsedGrid.headers[activeCell.col];
    const newRows = [...tableParsedGrid.rows];
    newRows[activeCell.row] = { ...newRows[activeCell.row], [header]: editValue };
    setTableParsedGrid({ ...tableParsedGrid, rows: newRows });
  }, [activeCell, editValue, tableParsedGrid, setTableParsedGrid]);

  const moveCell = useCallback((dRow: number, dCol: number) => {
    if (!activeCell || !tableParsedGrid) return;
    commitEdit();
    let { row, col } = activeCell;
    col += dCol;
    if (col >= tableParsedGrid.headers.length) { col = 0; row++; }
    if (col < 0) { col = tableParsedGrid.headers.length - 1; row--; }
    row += dRow;
    if (row >= tableParsedGrid.rows.length) row = 0;
    if (row < 0) row = tableParsedGrid.rows.length - 1;
    startEdit(row, col);
  }, [activeCell, tableParsedGrid, commitEdit, startEdit]);

  const handleCellKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      moveCell(0, e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      moveCell(1, 0);
    } else if (e.key === "Escape") {
      setActiveCell(null);
    }
  }, [moveCell]);

  // Header editing
  const commitHeaderEdit = useCallback(() => {
    if (editingHeader === null || !tableParsedGrid) return;
    const oldH = tableParsedGrid.headers[editingHeader];
    const newH = headerEditValue.trim() || `Column ${editingHeader + 1}`;
    const newHeaders = [...tableParsedGrid.headers];
    newHeaders[editingHeader] = newH;
    const newRows = tableParsedGrid.rows.map((row) => {
      const r: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) r[k === oldH ? newH : k] = v;
      return r;
    });
    setTableParsedGrid({ ...tableParsedGrid, headers: newHeaders, rows: newRows, tagColumn: tableParsedGrid.tagColumn === oldH ? newH : tableParsedGrid.tagColumn });
    setEditingHeader(null);
  }, [editingHeader, headerEditValue, tableParsedGrid, setTableParsedGrid]);

  // Escape key closes modal
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !activeCell && editingHeader === null) toggleModal();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [toggleModal, activeCell, editingHeader]);

  if (!tableParsedGrid || !tableParseRegion) return null;

  const headers = tableParsedGrid.headers;
  const rows = tableParsedGrid.rows;

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex flex-col" onClick={() => { if (!activeCell && editingHeader === null) toggleModal(); }}>
      <div
        className="flex-1 flex flex-col m-4 bg-[var(--bg)] border border-[var(--border)] rounded-xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-semibold text-[var(--fg)]">Table Compare — Page {pageNumber}</h2>
            <div className="flex items-center gap-1 border border-[var(--border)] rounded">
              <button
                onClick={() => setMode("side-by-side")}
                className={`px-3 py-1 text-xs rounded-l ${mode === "side-by-side" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--fg)]"}`}
              >
                Side-by-Side
              </button>
              <button
                onClick={() => setMode("overlay")}
                className={`px-3 py-1 text-xs rounded-r ${mode === "overlay" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--fg)]"}`}
              >
                Overlay
              </button>
            </div>
            {mode === "overlay" && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[var(--muted)]">Opacity</span>
                <input
                  type="range"
                  min="0.15"
                  max="0.85"
                  step="0.05"
                  value={overlayOpacity}
                  onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                  className="w-24 h-1 accent-blue-400"
                />
                <span className="text-[10px] text-[var(--muted)] w-8">{Math.round(overlayOpacity * 100)}%</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--muted)]">{headers.length} cols, {rows.length} rows</span>
            <button onClick={toggleModal} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none px-1">&times;</button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-[var(--muted)] text-sm">
              Rendering page image...
            </div>
          ) : mode === "side-by-side" ? (
            <>
              {/* Left: Cropped original image */}
              <div className="flex-1 overflow-auto bg-neutral-900 flex items-start justify-center p-4 relative">
                {croppedImageUrl && (
                  <div className="relative inline-block">
                    <img src={croppedImageUrl} alt="Original table region" className="max-w-full max-h-full" />
                    <canvas
                      ref={highlightCanvasRef}
                      className="absolute inset-0 pointer-events-none"
                      style={{ width: "100%", height: "100%" }}
                    />
                  </div>
                )}
              </div>

              {/* Divider */}
              <div className="w-px bg-[var(--border)]" />

              {/* Right: Editable grid */}
              <div className="flex-1 overflow-auto p-3">
                <div className="overflow-x-auto">
                  <table className="text-[11px] border-collapse w-full">
                    <thead>
                      <tr>
                        <th className="border border-[var(--border)] px-2 py-1.5 bg-[var(--surface)] text-[var(--muted)] w-8 text-center">#</th>
                        {headers.map((h, hi) => (
                          <th
                            key={hi}
                            className={`border border-[var(--border)] px-2 py-1.5 text-left font-semibold bg-[var(--surface)] cursor-pointer hover:bg-[var(--surface-hover)] ${
                              h === tableParsedGrid.tagColumn ? "text-green-400" : "text-[var(--fg)]"
                            }`}
                            onDoubleClick={() => { setEditingHeader(hi); setHeaderEditValue(h); }}
                          >
                            {editingHeader === hi ? (
                              <input
                                type="text"
                                value={headerEditValue}
                                onChange={(e) => setHeaderEditValue(e.target.value)}
                                onBlur={commitHeaderEdit}
                                onKeyDown={(e) => { if (e.key === "Enter") commitHeaderEdit(); if (e.key === "Escape") setEditingHeader(null); }}
                                className="w-full bg-transparent border-b border-[var(--accent)] outline-none text-[11px]"
                                autoFocus
                              />
                            ) : h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, ri) => (
                        <tr key={ri} className={activeCell?.row === ri ? "bg-pink-500/5" : "hover:bg-[var(--surface-hover)]"}>
                          <td className="border border-[var(--border)] px-2 py-1 text-[var(--muted)] text-center">{ri + 1}</td>
                          {headers.map((h, ci) => {
                            const isActive = activeCell?.row === ri && activeCell?.col === ci;
                            return (
                              <td
                                key={ci}
                                className={`border border-[var(--border)] px-2 py-1 cursor-pointer ${
                                  isActive ? "bg-pink-500/10 outline outline-1 outline-pink-400" :
                                  h === tableParsedGrid.tagColumn ? "text-green-300 font-mono" : "text-[var(--muted)]"
                                }`}
                                onClick={() => startEdit(ri, ci)}
                              >
                                {isActive ? (
                                  <input
                                    ref={editInputRef}
                                    type="text"
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onBlur={commitEdit}
                                    onKeyDown={handleCellKeyDown}
                                    className="w-full bg-transparent outline-none text-[11px] text-[var(--fg)]"
                                  />
                                ) : (
                                  <span className="truncate block max-w-[150px]" title={row[h] || ""}>{row[h] || ""}</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            /* Overlay mode */
            <div className="flex-1 overflow-auto bg-neutral-900 flex items-start justify-center p-4">
              {croppedImageUrl && (
                <div className="relative inline-block">
                  <img src={croppedImageUrl} alt="Original table region" className="max-w-full max-h-full" />
                  <canvas
                    ref={overlayCanvasRef}
                    className="absolute inset-0 pointer-events-none"
                    style={{ width: "100%", height: "100%", opacity: overlayOpacity }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center gap-3">
            <div className="text-[10px] text-[var(--muted)]">
              {mode === "side-by-side" ? "Click cell to edit. Double-click column header to rename." : "Blue overlay shows parsed text positions on original image."}
            </div>
            {mode === "side-by-side" && headers.some((h) => h.startsWith("Column ")) && (
              <button
                onClick={() => { setEditingHeader(0); setHeaderEditValue(headers[0]); }}
                className="text-[9px] px-2 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 whitespace-nowrap"
              >
                Edit Column Names
              </button>
            )}
          </div>
          <button
            onClick={() => {
              // Sync edited grid back to pageIntelligence before closing
              if (tableParsedGrid) {
                const store = useViewerStore.getState();
                const intel = store.pageIntelligence[pageNumber] || {};
                const regions = ((intel as any)?.parsedRegions || []).map((r: any) => {
                  if (r.type !== "schedule") return r;
                  // Match by comparing headers — update the first matching table on this page
                  if (JSON.stringify(r.data?.headers) === JSON.stringify(tableParsedGrid.headers) ||
                      r.data?.rows?.length === tableParsedGrid.rows.length) {
                    return {
                      ...r,
                      data: {
                        ...r.data,
                        headers: tableParsedGrid.headers,
                        rows: tableParsedGrid.rows,
                        tagColumn: tableParsedGrid.tagColumn,
                        tableName: tableParsedGrid.tableName,
                        rowCount: tableParsedGrid.rows.length,
                        columnCount: tableParsedGrid.headers.length,
                      },
                    };
                  }
                  return r;
                });
                store.setPageIntelligence(pageNumber, { ...intel, parsedRegions: regions });
              }
              toggleModal();
            }}
            className="px-4 py-1.5 text-xs rounded bg-[var(--accent)] text-white hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
