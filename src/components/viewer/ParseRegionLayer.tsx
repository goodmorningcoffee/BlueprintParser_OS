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
  const showKeynoteParsePanel = useViewerStore((s) => s.showKeynoteParsePanel);
  const keynoteParseRegion = useViewerStore((s) => s.keynoteParseRegion);
  const keynoteColumnBBs = useViewerStore((s) => s.keynoteColumnBBs);
  const keynoteRowBBs = useViewerStore((s) => s.keynoteRowBBs);

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
  }, [width, height, showParsedRegions,
    showTableParsePanel, tableParseRegion, tableParseColumnBBs, tableParseRowBBs,
    showKeynoteParsePanel, keynoteParseRegion, keynoteColumnBBs, keynoteRowBBs]);

  const hasContent = showParsedRegions && (
    (showTableParsePanel && (tableParseRegion || tableParseColumnBBs.length > 0 || tableParseRowBBs.length > 0))
    || (showKeynoteParsePanel && (keynoteParseRegion || keynoteColumnBBs.length > 0 || keynoteRowBBs.length > 0))
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
        zIndex: 14,
      }}
    />
  );
});
