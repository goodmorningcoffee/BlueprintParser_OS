"use client";

import { useEffect, useRef, memo } from "react";
import { useViewerStore } from "@/stores/viewerStore";

interface ParseRegionLayerProps {
  width: number;
  height: number;
  cssScale: number;
}

/**
 * Canvas layer that renders table/keynote parse region outlines,
 * user-drawn column BBs, and row BBs.
 *
 * Extracted from AnnotationOverlay so parse state changes don't
 * trigger a full annotation redraw.
 */
export default memo(function ParseRegionLayer({
  width,
  height,
  cssScale,
}: ParseRegionLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const showParsedRegions = useViewerStore((s) => s.showParsedRegions);
  const showTableParsePanel = useViewerStore((s) => s.showTableParsePanel);
  const tableParseRegion = useViewerStore((s) => s.tableParseRegion);
  const tableParseColumnBBs = useViewerStore((s) => s.tableParseColumnBBs);
  const tableParseRowBBs = useViewerStore((s) => s.tableParseRowBBs);
  // Keynote region overlay renders when the standalone KeynotePanel is open OR
  // when Specs/Notes is open on its Keynotes tab (D2 container embeds KeynotePanel).
  const showKeynoteParsePanel = useViewerStore(
    (s) => s.showKeynoteParsePanel || (s.showSpecsNotesPanel && s.specsNotesTab === "keynotes"),
  );
  const keynoteParseRegion = useViewerStore((s) => s.keynoteParseRegion);
  const keynoteColumnBBs = useViewerStore((s) => s.keynoteColumnBBs);
  const keynoteRowBBs = useViewerStore((s) => s.keynoteRowBBs);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const pageIntelligence = useViewerStore((s) => s.pageIntelligence);
  const hiddenParsedRegionIds = useViewerStore((s) => s.hiddenParsedRegionIds);
  const parsedRegionColorMode = useViewerStore((s) => s.parsedRegionColorMode);
  const parseDraftRegion = useViewerStore((s) => s.parseDraftRegion);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (!showParsedRegions) return;

    // ── Table parse region ───────────────────────────────────
    if (showTableParsePanel && tableParseRegion) {
      const [rMinX, rMinY, rMaxX, rMaxY] = tableParseRegion;
      ctx.strokeStyle = "#e879a0";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(rMinX * width, rMinY * height, (rMaxX - rMinX) * width, (rMaxY - rMinY) * height);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(232,121,160,0.03)";
      ctx.fillRect(rMinX * width, rMinY * height, (rMaxX - rMinX) * width, (rMaxY - rMinY) * height);
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "rgba(232,121,160,0.85)";
      ctx.fillText("Table Parse Region", rMinX * width + 4, rMinY * height - 4);
    }

    // ── Table column BBs ─────────────────────────────────────
    for (let ci = 0; showTableParsePanel && ci < tableParseColumnBBs.length; ci++) {
      const [cMinX, cMinY, cMaxX, cMaxY] = tableParseColumnBBs[ci];
      ctx.strokeStyle = "#9f1239";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(cMinX * width, cMinY * height, (cMaxX - cMinX) * width, (cMaxY - cMinY) * height);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(159,18,57,0.05)";
      ctx.fillRect(cMinX * width, cMinY * height, (cMaxX - cMinX) * width, (cMaxY - cMinY) * height);
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "rgba(159,18,57,0.85)";
      ctx.fillText(String.fromCharCode(65 + ci), cMinX * width + 3, cMinY * height - 3);
    }

    // ── Table row BBs ────────────────────────────────────────
    for (let ri = 0; showTableParsePanel && ri < tableParseRowBBs.length; ri++) {
      const [rMinX, rMinY, rMaxX, rMaxY] = tableParseRowBBs[ri];
      ctx.strokeStyle = "#c026d3";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rMinX * width, rMinY * height, (rMaxX - rMinX) * width, (rMaxY - rMinY) * height);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(192,38,211,0.05)";
      ctx.fillRect(rMinX * width, rMinY * height, (rMaxX - rMinX) * width, (rMaxY - rMinY) * height);
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "rgba(192,38,211,0.85)";
      ctx.fillText(String(ri + 1), rMinX * width - 12, rMinY * height + 12);
    }

    // ── Keynote parse region ─────────────────────────────────
    if (showKeynoteParsePanel && keynoteParseRegion) {
      const [rMinX, rMinY, rMaxX, rMaxY] = keynoteParseRegion;
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(rMinX * width, rMinY * height, (rMaxX - rMinX) * width, (rMaxY - rMinY) * height);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(245,158,11,0.03)";
      ctx.fillRect(rMinX * width, rMinY * height, (rMaxX - rMinX) * width, (rMaxY - rMinY) * height);
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "rgba(245,158,11,0.85)";
      ctx.fillText("Keynote Region", rMinX * width + 4, rMinY * height - 4);
    }

    // ── Keynote column BBs ───────────────────────────────────
    for (let ci = 0; showKeynoteParsePanel && ci < keynoteColumnBBs.length; ci++) {
      const [cMinX, cMinY, cMaxX, cMaxY] = keynoteColumnBBs[ci];
      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(cMinX * width, cMinY * height, (cMaxX - cMinX) * width, (cMaxY - cMinY) * height);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(217,119,6,0.05)";
      ctx.fillRect(cMinX * width, cMinY * height, (cMaxX - cMinX) * width, (cMaxY - cMinY) * height);
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "rgba(217,119,6,0.85)";
      ctx.fillText(String.fromCharCode(65 + ci), cMinX * width + 3, cMinY * height - 3);
    }

    // ── Keynote row BBs ──────────────────────────────────────
    for (let ri = 0; showKeynoteParsePanel && ri < keynoteRowBBs.length; ri++) {
      const [rMinX, rMinY, rMaxX, rMaxY] = keynoteRowBBs[ri];
      ctx.strokeStyle = "#c026d3";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rMinX * width, rMinY * height, (rMaxX - rMinX) * width, (rMaxY - rMinY) * height);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(192,38,211,0.05)";
      ctx.fillRect(rMinX * width, rMinY * height, (rMaxX - rMinX) * width, (rMaxY - rMinY) * height);
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "rgba(192,38,211,0.85)";
      ctx.fillText(String(ri + 1), rMinX * width - 12, rMinY * height + 12);
    }
    // ── Saved parsed regions (tables + keynotes) with stored color/opacity ─
    const intel = pageIntelligence[pageNumber] as any;
    if (intel?.parsedRegions) {
      for (const region of intel.parsedRegions) {
        if (!region.bbox) continue;
        if (region.id && hiddenParsedRegionIds.has(region.id)) continue;
        // Stage 3 color palette: keynote=amber, notes=blue, spec=violet,
        // legend/schedule/default=pink. Explicit region.data.color override still wins.
        const defaultColor = (
          region.type === "keynote" ? "#f59e0b" :
          region.type === "notes" ? "#60a5fa" :
          region.type === "spec" ? "#a78bfa" :
          "#e879a0"
        );
        const color = region.data?.color || defaultColor;
        const opacityPct = region.data?.opacity ?? 20;
        const [minX, minY, maxX, maxY] = region.bbox;
        const x = minX * width, y = minY * height;
        const w = (maxX - minX) * width, h = (maxY - minY) * height;

        // Fill with stored opacity
        const alphaHex = Math.round((opacityPct / 100) * 255).toString(16).padStart(2, "0");
        ctx.fillStyle = color + alphaHex;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);

        // Label
        const label = region.data?.tableName || region.category || region.type;
        if (label) {
          ctx.font = "bold 10px sans-serif";
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = color + "cc";
          ctx.fillRect(x, y - 14, tw + 8, 14);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, x + 4, y - 3);
        }

        // ── Cell grid overlay ─────────────────────────────────
        const headers = region.data?.headers as string[] | undefined;
        const dataRows = region.data?.rows as Record<string, string>[] | undefined;
        if (headers && headers.length > 0 && dataRows && dataRows.length > 0) {
          let colB = region.data?.colBoundaries as number[] | undefined;
          let rowB = region.data?.rowBoundaries as number[] | undefined;

          // Fallback: uniform grid if no stored boundaries
          if (!colB || colB.length !== headers.length + 1) {
            const step = (maxX - minX) / headers.length;
            colB = Array.from({ length: headers.length + 1 }, (_, i) => minX + step * i);
          }
          const hasHeaderRow = rowB ? rowB.length - 1 > dataRows.length : true;
          const totalRows = hasHeaderRow ? dataRows.length + 1 : dataRows.length;
          if (!rowB || rowB.length !== totalRows + 1) {
            const step = (maxY - minY) / (dataRows.length + 1);
            rowB = Array.from({ length: dataRows.length + 2 }, (_, i) => minY + step * i);
          }

          // Draw cell fills based on color mode
          if (parsedRegionColorMode !== "none") {
            for (let ri = 0; ri < totalRows; ri++) {
              for (let ci = 0; ci < headers.length; ci++) {
                const cx = colB[ci] * width;
                const cy = rowB[ri] * height;
                const cw = (colB[ci + 1] - colB[ci]) * width;
                const ch = (rowB[ri + 1] - rowB[ri]) * height;

                if (ri === 0 && hasHeaderRow) {
                  // Header row — subtle white tint
                  ctx.fillStyle = "rgba(255,255,255,0.04)";
                } else {
                  const dataRi = hasHeaderRow ? ri - 1 : ri;
                  const isEven = parsedRegionColorMode === "checkerboard"
                    ? (dataRi + ci) % 2 === 0
                    : dataRi % 2 === 0;
                  ctx.fillStyle = isEven
                    ? "rgba(245,158,11,0.06)"   // amber
                    : "rgba(139,92,246,0.06)";   // violet
                }
                ctx.fillRect(cx, cy, cw, ch);
              }
            }
          }

          // Draw grid lines
          ctx.strokeStyle = "rgba(255,255,255,0.12)";
          ctx.lineWidth = 0.5;
          ctx.setLineDash([]);
          // Vertical column dividers
          for (let ci = 1; ci < colB.length - 1; ci++) {
            const lx = colB[ci] * width;
            ctx.beginPath();
            ctx.moveTo(lx, y);
            ctx.lineTo(lx, y + h);
            ctx.stroke();
          }
          // Horizontal row dividers
          for (let ri = 1; ri < rowB.length - 1; ri++) {
            const ly = rowB[ri] * height;
            ctx.beginPath();
            ctx.moveTo(x, ly);
            ctx.lineTo(x + w, ly);
            ctx.stroke();
          }
        }
      }
    }

    // ── Draft region preview (Stage 4: in-flight Parser preview) ─────
    if (parseDraftRegion?.bbox) {
      const region = parseDraftRegion;
      const typeColor =
        region.type === "keynote" ? "#f59e0b" :
        region.type === "notes" ? "#60a5fa" :
        region.type === "spec" ? "#a78bfa" :
        "#e879a0";
      const [minX, minY, maxX, maxY] = region.bbox;
      const dx = minX * width, dy = minY * height;
      const dw = (maxX - minX) * width, dh = (maxY - minY) * height;

      ctx.fillStyle = typeColor + "1a";
      ctx.strokeStyle = typeColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.fillRect(dx, dy, dw, dh);
      ctx.strokeRect(dx, dy, dw, dh);
      ctx.setLineDash([]);

      const label = `${(region.data as { tableName?: string } | undefined)?.tableName ?? region.category ?? region.type} (draft)`;
      ctx.font = "bold 10px sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = typeColor + "cc";
      ctx.fillRect(dx, dy - 14, tw + 8, 14);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, dx + 4, dy - 3);

      // Grid-line preview if the draft grid is populated
      const data = region.data as {
        headers?: string[];
        rows?: Record<string, string>[];
        colBoundaries?: number[];
        rowBoundaries?: number[];
      } | undefined;
      const dColB = data?.colBoundaries;
      const dRowB = data?.rowBoundaries;
      if (data?.headers?.length && data.rows?.length && (dColB || dRowB)) {
        ctx.strokeStyle = typeColor + "80";
        ctx.lineWidth = 0.5;
        ctx.setLineDash([3, 2]);
        if (dColB) {
          for (let ci = 1; ci < dColB.length - 1; ci++) {
            const lx = dColB[ci] * width;
            ctx.beginPath();
            ctx.moveTo(lx, dy);
            ctx.lineTo(lx, dy + dh);
            ctx.stroke();
          }
        }
        if (dRowB) {
          for (const ry of dRowB) {
            const ly = ry * height;
            if (ly > dy && ly < dy + dh) {
              ctx.beginPath();
              ctx.moveTo(dx, ly);
              ctx.lineTo(dx + dw, ly);
              ctx.stroke();
            }
          }
        }
        ctx.setLineDash([]);
      }
    }
  }, [width, height, showParsedRegions,
    showTableParsePanel, tableParseRegion, tableParseColumnBBs, tableParseRowBBs,
    showKeynoteParsePanel, keynoteParseRegion, keynoteColumnBBs, keynoteRowBBs,
    pageNumber, pageIntelligence, hiddenParsedRegionIds, parsedRegionColorMode,
    parseDraftRegion]);

  const intel = pageIntelligence[pageNumber] as any;
  const hasSavedRegions = intel?.parsedRegions?.length > 0;
  const hasContent = showParsedRegions && (
    (showTableParsePanel && (tableParseRegion || tableParseColumnBBs.length > 0 || tableParseRowBBs.length > 0))
    || (showKeynoteParsePanel && (keynoteParseRegion || keynoteColumnBBs.length > 0 || keynoteRowBBs.length > 0))
    || hasSavedRegions
    || !!parseDraftRegion
  );

  if (!hasContent) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "none",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
        willChange: "transform",
        zIndex: 14,
      }}
    />
  );
});
