"use client";

import { useEffect, useRef, memo } from "react";
import { useViewerStore } from "@/stores/viewerStore";

interface DrawingPreviewLayerProps {
  width: number;
  height: number;
  cssScale: number;
}

/**
 * Lightweight canvas layer that ONLY renders:
 * - In-progress bounding box rectangle (during drawing)
 * - Polygon drawing preview (vertices + cursor line)
 * - Calibration points and line
 *
 * Reads drawing state from Zustand store independently — AnnotationOverlay
 * does NOT subscribe to _drawEnd, so it doesn't re-render during drawing.
 */
export default memo(function DrawingPreviewLayer({
  width,
  height,
  cssScale,
}: DrawingPreviewLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Drawing state from store — ONLY this layer subscribes
  const drawing = useViewerStore((s) => s._drawing);
  const drawStart = useViewerStore((s) => s._drawStart);
  const drawEnd = useViewerStore((s) => s._drawEnd);
  const mousePos = useViewerStore((s) => s._mousePos);

  // Other store reads
  const symbolSearchActive = useViewerStore((s) => s.symbolSearchActive);
  const tableParseStep = useViewerStore((s) => s.tableParseStep);
  const keynoteParseStep = useViewerStore((s) => s.keynoteParseStep);
  const calibrationMode = useViewerStore((s) => s.calibrationMode);
  const calibrationPoints = useViewerStore((s) => s.calibrationPoints);
  const polygonDrawingMode = useViewerStore((s) => s.polygonDrawingMode);
  const polygonVertices = useViewerStore((s) => s.polygonVertices);
  const activeTakeoffItemId = useViewerStore((s) => s.activeTakeoffItemId);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const showParsedRegions = useViewerStore((s) => s.showParsedRegions);

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

    // ── Drawing preview rectangle ────────────────────────────
    if (drawing) {
      const isSymbolSearch = symbolSearchActive;
      const isTableParse = tableParseStep === "select-region" || tableParseStep === "define-column" || tableParseStep === "define-row";
      const isKeynoteParse = keynoteParseStep === "select-region" || keynoteParseStep === "define-column" || keynoteParseStep === "define-row";
      const isAnyTableDraw = isTableParse || isKeynoteParse;
      const isColumn = tableParseStep === "define-column";
      const isRow = tableParseStep === "define-row";
      const isKnColumn = keynoteParseStep === "define-column";
      const isKnRow = keynoteParseStep === "define-row";

      ctx.strokeStyle = isSymbolSearch
        ? "#22d3ee"
        : isKeynoteParse
          ? (isKnColumn ? "#d97706" : isKnRow ? "#c026d3" : "#f59e0b")
          : isTableParse
            ? (isColumn ? "#9f1239" : isRow ? "#c026d3" : "#e879a0")
            : "#00ff88";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      const dx = drawEnd.x - drawStart.x;
      const dy = drawEnd.y - drawStart.y;
      ctx.strokeRect(drawStart.x, drawStart.y, dx, dy);

      if (isSymbolSearch) {
        ctx.fillStyle = "rgba(34,211,238,0.08)";
        ctx.fillRect(drawStart.x, drawStart.y, dx, dy);
        ctx.setLineDash([]);
        ctx.font = "bold 11px sans-serif";
        ctx.fillStyle = "#22d3ee";
        ctx.fillText("Symbol Search Template", Math.min(drawStart.x, drawEnd.x) + 4, Math.min(drawStart.y, drawEnd.y) - 4);
      } else if (isAnyTableDraw) {
        ctx.fillStyle = isKeynoteParse
          ? (isKnColumn ? "rgba(217,119,6,0.06)" : isKnRow ? "rgba(192,38,211,0.06)" : "rgba(245,158,11,0.06)")
          : isColumn ? "rgba(159,18,57,0.06)" : isRow ? "rgba(192,38,211,0.06)" : "rgba(232,121,160,0.06)";
        ctx.fillRect(drawStart.x, drawStart.y, dx, dy);
        ctx.setLineDash([]);
        ctx.font = "bold 11px sans-serif";
        ctx.fillStyle = isKeynoteParse
          ? (isKnColumn ? "#d97706" : isKnRow ? "#c026d3" : "#f59e0b")
          : isColumn ? "#9f1239" : isRow ? "#c026d3" : "#e879a0";
        const label = isKeynoteParse
          ? (isKnColumn ? "Column" : isKnRow ? "Row" : "Keynote Region")
          : isColumn ? "Column" : isRow ? "Row" : "Table Region";
        ctx.fillText(label, Math.min(drawStart.x, drawEnd.x) + 4, Math.min(drawStart.y, drawEnd.y) - 4);
      }
      ctx.setLineDash([]);
    }

    // ── Calibration points and line ──────────────────────────
    if (calibrationMode !== "idle" && calibrationPoints.p1) {
      ctx.save();
      const p1x = calibrationPoints.p1.x * width;
      const p1y = calibrationPoints.p1.y * height;
      ctx.fillStyle = "#fbbf24";
      ctx.beginPath();
      ctx.arc(p1x, p1y, 5, 0, Math.PI * 2);
      ctx.fill();

      if (calibrationPoints.p2) {
        const p2x = calibrationPoints.p2.x * width;
        const p2y = calibrationPoints.p2.y * height;
        ctx.beginPath();
        ctx.arc(p2x, p2y, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(p1x, p1y);
        ctx.lineTo(p2x, p2y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // ── Polygon / Linear drawing preview ──────────────────────
    if (polygonDrawingMode === "drawing" && polygonVertices.length > 0) {
      const activeItem = takeoffItems.find((t) => t.id === activeTakeoffItemId);
      const polyColor = activeItem?.color || "#00ff88";
      const isLinear = activeItem?.shape === "linear";
      ctx.save();

      const verts = polygonVertices;
      const mp = mousePos;

      if (isLinear) {
        // ── Linear polyline preview (open path, no fill) ──
        // Lines between vertices + cursor
        ctx.strokeStyle = polyColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(verts[0].x * width, verts[0].y * height);
        for (let i = 1; i < verts.length; i++) {
          ctx.lineTo(verts[i].x * width, verts[i].y * height);
        }
        if (mp) ctx.lineTo(mp.x, mp.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Vertex dots (no snap-to-first indicator)
        for (let i = 0; i < verts.length; i++) {
          const vx = verts[i].x * width;
          const vy = verts[i].y * height;
          ctx.fillStyle = polyColor;
          ctx.beginPath();
          ctx.arc(vx, vy, i === 0 ? 5 : 4, 0, Math.PI * 2);
          ctx.fill();
          if (i === 0) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(vx, vy, 6, 0, Math.PI * 2);
            ctx.stroke();
          }
        }

        // Instruction text
        ctx.font = "12px sans-serif";
        const msg = verts.length < 2 ? "Click to add points" : "Double-click or Enter to finish";
        const tw = ctx.measureText(msg).width;
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(8, 8, tw + 12, 22);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(msg, 14, 23);
      } else {
        // ── Polygon preview (closed path with fill) ──
        // Preview fill
        if (verts.length >= 2 && mp) {
          ctx.fillStyle = polyColor + "20";
          ctx.beginPath();
          ctx.moveTo(verts[0].x * width, verts[0].y * height);
          for (let i = 1; i < verts.length; i++) {
            ctx.lineTo(verts[i].x * width, verts[i].y * height);
          }
          ctx.lineTo(mp.x, mp.y);
          ctx.closePath();
          ctx.fill();
        }

        // Lines between vertices
        ctx.strokeStyle = polyColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(verts[0].x * width, verts[0].y * height);
        for (let i = 1; i < verts.length; i++) {
          ctx.lineTo(verts[i].x * width, verts[i].y * height);
        }
        if (mp) ctx.lineTo(mp.x, mp.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Snap-to-first detection
        let nearFirst = false;
        if (mp && verts.length >= 3) {
          const firstX = verts[0].x * width;
          const firstY = verts[0].y * height;
          const dist = Math.sqrt((mp.x - firstX) ** 2 + (mp.y - firstY) ** 2);
          nearFirst = dist < 15;
        }

        // Vertex dots
        for (let i = 0; i < verts.length; i++) {
          const vx = verts[i].x * width;
          const vy = verts[i].y * height;
          if (i === 0) {
            ctx.fillStyle = nearFirst ? "#ffffff" : polyColor;
            ctx.beginPath();
            ctx.arc(vx, vy, nearFirst ? 8 : 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(vx, vy, nearFirst ? 10 : 8, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.fillStyle = polyColor;
            ctx.beginPath();
            ctx.arc(vx, vy, 4, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Instruction text
        ctx.font = "12px sans-serif";
        const msg = verts.length < 3 ? "Click to add points" : "Click first point or Enter to close";
        const tw = ctx.measureText(msg).width;
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(8, 8, tw + 12, 22);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(msg, 14, 23);
      }

      ctx.restore();
    }
  }, [drawing, drawStart, drawEnd, mousePos, width, height,
    symbolSearchActive, tableParseStep, keynoteParseStep,
    calibrationMode, calibrationPoints,
    polygonDrawingMode, polygonVertices, activeTakeoffItemId, takeoffItems]);

  // Don't render canvas at all when nothing to draw
  const hasContent = drawing
    || (calibrationMode !== "idle" && calibrationPoints.p1)
    || (polygonDrawingMode === "drawing" && polygonVertices.length > 0);

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
        zIndex: 15,
      }}
    />
  );
});
