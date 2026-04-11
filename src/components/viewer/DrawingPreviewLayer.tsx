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
  const bucketFillActive = useViewerStore((s) => s.bucketFillActive);
  const bucketFillPreview = useViewerStore((s) => s.bucketFillPreview);
  const bucketFillLoading = useViewerStore((s) => s.bucketFillLoading);
  const bucketFillError = useViewerStore((s) => s.bucketFillError);
  const bucketFillBarriers = useViewerStore((s) => s.bucketFillBarriers);
  const bucketFillBarrierMode = useViewerStore((s) => s.bucketFillBarrierMode);
  const barrierPendingPoint = useViewerStore((s) => s.barrierPendingPoint);

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

    // ── Bucket fill barrier lines ────────────────────────────
    if (bucketFillBarriers.length > 0 || barrierPendingPoint) {
      ctx.save();
      // Draw completed barrier lines
      for (const b of bucketFillBarriers) {
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(b.x1 * width, b.y1 * height);
        ctx.lineTo(b.x2 * width, b.y2 * height);
        ctx.stroke();

        // Endpoint dots
        ctx.fillStyle = "#ef4444";
        for (const [px, py] of [[b.x1, b.y1], [b.x2, b.y2]]) {
          ctx.beginPath();
          ctx.arc(px * width, py * height, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // In-progress barrier: pending point to cursor
      if (barrierPendingPoint && mousePos) {
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(barrierPendingPoint.x * width, barrierPendingPoint.y * height);
        ctx.lineTo(mousePos.x, mousePos.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Pending point dot
        ctx.fillStyle = "#ef4444";
        ctx.beginPath();
        ctx.arc(barrierPendingPoint.x * width, barrierPendingPoint.y * height, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // ── Bucket fill preview polygon ──────────────────────────
    if (bucketFillPreview) {
      const activeItem = takeoffItems.find((t) => t.id === activeTakeoffItemId);
      const fillColor = activeItem?.color || "#22d3ee";
      const verts = bucketFillPreview.vertices;
      ctx.save();

      // Semi-transparent fill
      ctx.fillStyle = fillColor + "33";
      ctx.beginPath();
      ctx.moveTo(verts[0].x * width, verts[0].y * height);
      for (let i = 1; i < verts.length; i++) {
        ctx.lineTo(verts[i].x * width, verts[i].y * height);
      }
      ctx.closePath();
      ctx.fill();

      // Dashed outline
      ctx.strokeStyle = fillColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Method label near centroid
      const cx = verts.reduce((s, v) => s + v.x, 0) / verts.length * width;
      const cy = verts.reduce((s, v) => s + v.y, 0) / verts.length * height;
      ctx.font = "bold 11px sans-serif";
      const label = bucketFillPreview.method === "vector" ? "Vector" : "Raster";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(cx - tw / 2 - 4, cy - 16, tw + 8, 18);
      ctx.fillStyle = fillColor;
      ctx.fillText(label, cx - tw / 2, cy - 3);

      ctx.restore();
    }

    // ── Bucket fill loading indicator ────────────────────────
    if (bucketFillLoading) {
      ctx.save();
      ctx.font = "12px sans-serif";
      const msg = "Detecting room...";
      const tw = ctx.measureText(msg).width;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(8, 8, tw + 12, 22);
      ctx.fillStyle = "#22d3ee";
      ctx.fillText(msg, 14, 23);
      ctx.restore();
    }
  }, [drawing, drawStart, drawEnd, mousePos, width, height,
    symbolSearchActive, tableParseStep, keynoteParseStep,
    calibrationMode, calibrationPoints,
    polygonDrawingMode, polygonVertices, activeTakeoffItemId, takeoffItems,
    bucketFillPreview, bucketFillLoading, bucketFillBarriers, bucketFillBarrierMode, barrierPendingPoint]);

  // Don't render canvas at all when nothing to draw
  const hasContent = drawing
    || (calibrationMode !== "idle" && calibrationPoints.p1)
    || (polygonDrawingMode === "drawing" && polygonVertices.length > 0)
    || bucketFillPreview
    || bucketFillLoading
    || bucketFillBarriers.length > 0
    || barrierPendingPoint
    || bucketFillActive
    || bucketFillError;

  // Compute centroid for accept/cancel buttons
  const previewCentroid = bucketFillPreview ? (() => {
    const verts = bucketFillPreview.vertices;
    const cx = verts.reduce((s, v) => s + v.x, 0) / verts.length * width;
    const cy = verts.reduce((s, v) => s + v.y, 0) / verts.length * height;
    return { x: cx, y: cy };
  })() : null;

  if (!hasContent) return null;

  return (
    <>
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
          zIndex: 15,
        }}
      />
      {/* Bucket fill accept / cancel buttons */}
      {bucketFillPreview && previewCentroid && (
        <div
          style={{
            position: "absolute",
            left: `${previewCentroid.x - 52}px`,
            top: `${previewCentroid.y + 14}px`,
            display: "flex",
            gap: "6px",
            zIndex: 16,
            transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
            transformOrigin: "top left",
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              // Dispatch accept via keyboard event handler (Enter)
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            }}
            style={{
              padding: "4px 12px",
              borderRadius: "4px",
              border: "none",
              background: "#22c55e",
              color: "#fff",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Accept
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              useViewerStore.getState().setBucketFillPreview(null);
            }}
            style={{
              padding: "4px 12px",
              borderRadius: "4px",
              border: "none",
              background: "#ef4444",
              color: "#fff",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {/* Bucket fill error banner — takes priority over HUDs */}
      {bucketFillError && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "12px",
            transform: `translateX(-50%)${cssScale !== 1 ? ` scale(${cssScale})` : ""}`,
            transformOrigin: "top center",
            padding: "8px 14px",
            borderRadius: "6px",
            background: "rgba(127, 29, 29, 0.92)",
            border: "1px solid #ef4444",
            color: "#fff",
            fontSize: "12px",
            fontWeight: 500,
            zIndex: 17,
            pointerEvents: "none",
            maxWidth: "420px",
            textAlign: "center",
          }}
        >
          {bucketFillError}
        </div>
      )}
      {/* Barrier drawing HUD — red, with Done button */}
      {bucketFillActive && bucketFillBarrierMode && !bucketFillPreview && !bucketFillError && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "12px",
            transform: `translateX(-50%)${cssScale !== 1 ? ` scale(${cssScale})` : ""}`,
            transformOrigin: "top center",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "6px 12px",
            borderRadius: "6px",
            background: "rgba(0,0,0,0.82)",
            border: "1px solid #ef4444",
            color: "#fff",
            fontSize: "12px",
            zIndex: 16,
            pointerEvents: "auto",
          }}
        >
          <span style={{ color: "#fca5a5" }}>
            Drawing barriers — click two points per line
            {bucketFillBarriers.length > 0 ? ` (${bucketFillBarriers.length} drawn)` : ""}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              useViewerStore.getState().setBucketFillBarrierMode(false);
            }}
            style={{
              padding: "3px 10px",
              borderRadius: "4px",
              border: "none",
              background: "#22c55e",
              color: "#fff",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Done
          </button>
        </div>
      )}
      {/* Bucket fill active HUD — cyan, with Exit button */}
      {bucketFillActive && !bucketFillBarrierMode && !bucketFillPreview && !bucketFillLoading && !bucketFillError && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "12px",
            transform: `translateX(-50%)${cssScale !== 1 ? ` scale(${cssScale})` : ""}`,
            transformOrigin: "top center",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "6px 12px",
            borderRadius: "6px",
            background: "rgba(0,0,0,0.82)",
            border: "1px solid #22d3ee",
            color: "#fff",
            fontSize: "12px",
            zIndex: 16,
            pointerEvents: "auto",
          }}
        >
          <span style={{ color: "#67e8f9" }}>Click inside a room to detect</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              useViewerStore.getState().setBucketFillActive(false);
            }}
            style={{
              padding: "3px 10px",
              borderRadius: "4px",
              border: "none",
              background: "#475569",
              color: "#fff",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Exit
          </button>
        </div>
      )}
    </>
  );
});
