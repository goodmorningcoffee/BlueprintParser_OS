"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useViewerStore } from "@/stores/viewerStore";
import EditableGrid from "./EditableGrid";

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
  const tableParseMeta = useViewerStore((s) => s.tableParseMeta);
  const textractData = useViewerStore((s) => s.textractData);
  const setPageIntelligence = useViewerStore((s) => s.setPageIntelligence);

  // Source picker — "merged" (default) or a method name from tableParseMeta.methodResults.
  // Swapping rewrites tableParsedGrid's headers/rows so edits apply to the chosen source.
  // Only visible when tableParseMeta is populated (server returned debug methodResults).
  const [selectedSource, setSelectedSource] = useState<string>("merged");

  const [mode, setMode] = useState<"side-by-side" | "overlay">("side-by-side");
  const [overlayOpacity, setOverlayOpacity] = useState(0.55);
  const [croppedImageUrl, setCroppedImageUrl] = useState<string | null>(null);
  const [cropDimensions, setCropDimensions] = useState<{ w: number; h: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalSize, setModalSize] = useState({ w: 0, h: 0 });
  const [imageZoom, setImageZoom] = useState(1.0);

  // Active cell — owned by EditableGrid, mirrored here for image highlight rendering
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);

  // Initialize modal size on open
  useEffect(() => {
    if (tableParsedGrid && tableParseRegion) {
      setModalSize({ w: window.innerWidth - 64, h: window.innerHeight - 64 });
    }
  }, [!!tableParsedGrid, !!tableParseRegion]); // eslint-disable-line react-hooks/exhaustive-deps

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = modalSize.w;
    const startH = modalSize.h;
    function onMove(ev: MouseEvent) {
      setModalSize({
        w: Math.max(500, Math.min(window.innerWidth - 32, startW + ev.clientX - startX)),
        h: Math.max(350, Math.min(window.innerHeight - 32, startH + ev.clientY - startY)),
      });
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [modalSize]);

  // Refs
  const highlightCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageScrollRef = useRef<HTMLDivElement>(null);

  // ─── Zoom helpers ───────────────────────────────────────
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3.0;
  const ZOOM_STEP = 1.2;

  const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

  const handleZoomIn = useCallback(() => {
    setImageZoom((z) => clampZoom(z * ZOOM_STEP));
  }, []);

  const handleZoomOut = useCallback(() => {
    setImageZoom((z) => clampZoom(z / ZOOM_STEP));
  }, []);

  const handleZoomFit = useCallback(() => {
    setImageZoom(1.0);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setImageZoom((z) => clampZoom(z * factor));
    }
  }, []);

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

    // Canvas sized to the zoomed image so highlights stay aligned
    const cw = cropDimensions.w * imageZoom;
    const ch = cropDimensions.h * imageZoom;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, cw, ch);

    if (!activeCell) return;
    const key = `r${activeCell.row}c${activeCell.col}`;
    const bbox = cellBboxes[key];
    if (!bbox) return;

    const [bMinX, bMinY, bMaxX, bMaxY] = bbox;
    const x = bMinX * cw;
    const y = bMinY * ch;
    const w = (bMaxX - bMinX) * cw;
    const h = (bMaxY - bMinY) * ch;

    // Magenta highlight
    ctx.fillStyle = "rgba(232, 121, 160, 0.25)";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.strokeStyle = "#e879a0";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
  }, [activeCell, cellBboxes, cropDimensions, mode, imageZoom]);

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

  // Cell edit handlers — delegated to EditableGrid which owns its own edit state
  const handleCellChange = (rowIndex: number, column: string, value: string) => {
    if (!tableParsedGrid) return;
    const newRows = [...tableParsedGrid.rows];
    newRows[rowIndex] = { ...newRows[rowIndex], [column]: value };
    setTableParsedGrid({ ...tableParsedGrid, rows: newRows });
  };

  const handleHeaderRename = (colIndex: number, newName: string) => {
    if (!tableParsedGrid) return;
    const oldH = tableParsedGrid.headers[colIndex];
    const newHeaders = [...tableParsedGrid.headers];
    newHeaders[colIndex] = newName;
    const newRows = tableParsedGrid.rows.map((row) => {
      const r: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) r[k === oldH ? newName : k] = v;
      return r;
    });
    setTableParsedGrid({
      ...tableParsedGrid,
      headers: newHeaders,
      rows: newRows,
      tagColumn: tableParsedGrid.tagColumn === oldH ? newName : tableParsedGrid.tagColumn,
    });
  };

  // Escape key closes modal when no cell is being edited
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !activeCell) toggleModal();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [toggleModal, activeCell]);

  // Swap tableParsedGrid between the merged snapshot and any per-method raw grid.
  // Does NOT touch tableParseMeta — the dropdown stays populated so the user can
  // keep switching. Cell edits after a swap apply to the chosen source.
  const handleSourceChange = useCallback((source: string) => {
    if (!tableParsedGrid || !tableParseMeta) return;
    setSelectedSource(source);
    if (source === "merged") {
      const snap = tableParseMeta.mergedSnapshot;
      setTableParsedGrid({
        ...tableParsedGrid,
        headers: snap.headers,
        rows: snap.rows,
        tagColumn: snap.tagColumn,
        colBoundaries: snap.colBoundaries,
        rowBoundaries: snap.rowBoundaries,
      });
      return;
    }
    const method = tableParseMeta.methodResults.find((m) => m.method === source);
    if (!method) return;
    setTableParsedGrid({
      ...tableParsedGrid,
      headers: method.headers,
      rows: method.rows,
      tagColumn: method.tagColumn,
      colBoundaries: method.colBoundaries,
      rowBoundaries: method.rowBoundaries,
    });
  }, [tableParsedGrid, tableParseMeta, setTableParsedGrid]);

  if (!tableParsedGrid || !tableParseRegion) return null;

  const headers = tableParsedGrid.headers;
  const rows = tableParsedGrid.rows;

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center" onClick={() => { if (!activeCell) toggleModal(); }}>
      <div
        className="relative flex flex-col bg-[var(--bg)] border border-[var(--border)] rounded-xl overflow-hidden shadow-2xl"
        style={{ width: modalSize.w || "auto", height: modalSize.h || "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-semibold text-[var(--fg)]">Table Compare — Page {pageNumber}</h2>
            {tableParseMeta && tableParseMeta.methodResults.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-[var(--muted)] uppercase tracking-wide">Source</span>
                <select
                  value={selectedSource}
                  onChange={(e) => handleSourceChange(e.target.value)}
                  className="text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] hover:border-[var(--accent)]"
                  title="Swap between the auto-merged grid and any individual method's raw grid. Cell edits apply to the chosen source."
                >
                  <option value="merged">
                    Merged (base: {tableParseMeta.baseMethod})
                  </option>
                  {tableParseMeta.methodResults
                    .filter((m) => m.headers.length > 0 && m.rows.length > 0)
                    .map((m) => (
                      <option key={m.method} value={m.method}>
                        {m.method} — {m.rows.length}r × {m.headers.length}c · {Math.round(m.confidence * 100)}%
                      </option>
                    ))}
                </select>
              </div>
            )}
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
              {/* Left: Cropped original image with zoom controls */}
              <div className="flex-1 flex flex-col overflow-hidden bg-neutral-900 relative">
                {/* Zoom toolbar */}
                <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border)] bg-neutral-800/80">
                  <button
                    onClick={handleZoomOut}
                    className="px-2 py-0.5 text-xs rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:bg-neutral-700"
                    title="Zoom out"
                  >
                    &minus;
                  </button>
                  <span className="text-[10px] text-[var(--muted)] w-10 text-center select-none">
                    {Math.round(imageZoom * 100)}%
                  </span>
                  <button
                    onClick={handleZoomIn}
                    className="px-2 py-0.5 text-xs rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:bg-neutral-700"
                    title="Zoom in"
                  >
                    +
                  </button>
                  <button
                    onClick={handleZoomFit}
                    className="px-2 py-0.5 text-[10px] rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:bg-neutral-700 ml-1"
                    title="Reset zoom to fit"
                  >
                    Fit
                  </button>
                </div>

                {/* Scrollable + zoomable image container */}
                <div
                  ref={imageScrollRef}
                  className="flex-1 overflow-auto p-4"
                  onWheel={handleWheel}
                >
                  {croppedImageUrl && (
                    <div className="relative inline-block" style={{ transformOrigin: "top left", transform: `scale(${imageZoom})` }}>
                      <img src={croppedImageUrl} alt="Original table region" />
                      <canvas
                        ref={highlightCanvasRef}
                        className="absolute top-0 left-0 pointer-events-none"
                        style={{ width: "100%", height: "100%" }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Divider */}
              <div className="w-px bg-[var(--border)]" />

              {/* Right: Editable grid */}
              <div className="flex-1 overflow-auto p-3">
                <EditableGrid
                  headers={headers}
                  rows={rows}
                  tagColumn={tableParsedGrid.tagColumn}
                  onCellChange={handleCellChange}
                  onHeaderRename={handleHeaderRename}
                  onActiveCellChange={setActiveCell}
                  onCellDoubleClick={(_, __, header, value) => {
                    if (!tableParsedGrid?.tagColumn || header !== tableParsedGrid.tagColumn) return;
                    const store = useViewerStore.getState();
                    const tag = store.yoloTags.find(
                      (t) => t.tagText === value.trim() && t.source === "schedule"
                    );
                    if (tag && tag.instances.length > 0) {
                      store.tagBrowseNavigate(tag.id, 0);
                    }
                  }}
                />
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
          </div>
          <button
            onClick={() => {
              // Sync edited grid back to pageIntelligence before closing
              if (tableParsedGrid) {
                const store = useViewerStore.getState();
                const intel = store.pageIntelligence[pageNumber] || {};
                const regions = ((intel as any)?.parsedRegions || []).map((r: any) => {
                  if (r.type !== "schedule" && r.type !== "keynote") return r;
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
                const updatedIntel = { ...intel, parsedRegions: regions };
                store.setPageIntelligence(pageNumber, updatedIntel);

                // Sync back to parsedKeynoteData if this was a keynote edit
                const knData = store.parsedKeynoteData;
                if (knData && tableParsedGrid.tableName) {
                  const tagCol = tableParsedGrid.tagColumn || tableParsedGrid.headers[0];
                  const descCols = tableParsedGrid.headers.filter((h: string) => h !== tagCol);
                  const updated = knData.map((kn: any) => {
                    if (kn.pageNumber !== pageNumber) return kn;
                    if (kn.tableName !== tableParsedGrid.tableName) return kn;
                    return {
                      ...kn,
                      keys: tableParsedGrid.rows.map((row: Record<string, string>, ri: number) => {
                        const newKey = row[tagCol] || "";
                        const newDesc = descCols.map((h: string) => row[h] || "").join(" ").trim();
                        // Preserve existing metadata (csiCodes, note) if key matches
                        const existing = kn.keys?.find((k: any, ki: number) => ki === ri || k.key === newKey);
                        return {
                          key: newKey,
                          description: newDesc,
                          ...(existing?.csiCodes ? { csiCodes: existing.csiCodes } : {}),
                          ...(existing?.note ? { note: existing.note } : {}),
                        };
                      }),
                    };
                  });
                  store.setParsedKeynoteData(updated);
                }

                // Persist to DB (fire-and-forget)
                const { projectId, isDemo } = store;
                if (projectId && !isDemo) {
                  fetch("/api/pages/intelligence", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ projectId, pageNumber, intelligence: updatedIntel }),
                  }).catch(() => {});
                }
              }
              toggleModal();
            }}
            className="px-4 py-1.5 text-xs rounded bg-[var(--accent)] text-white hover:opacity-90"
          >
            Done
          </button>
        </div>

        {/* Resize handle — bottom-right corner */}
        <div
          onMouseDown={onResizeStart}
          className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize opacity-50 hover:opacity-100"
          title="Drag to resize"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" className="text-[var(--muted)]">
            <path d="M14 20L20 14M10 20L20 10M6 20L20 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>
      </div>
    </div>
  );
}
