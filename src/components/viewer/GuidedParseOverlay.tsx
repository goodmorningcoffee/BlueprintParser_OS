"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useViewerStore } from "@/stores/viewerStore";

interface GuidedParseOverlayProps {
  width: number;
  height: number;
  cssScale: number;
}

/** Hit-test threshold in CSS pixels */
const GRAB_RADIUS = 8;
/** Drag handle half-size in CSS pixels */
const HANDLE_SIZE = 3;

type DragTarget =
  | { kind: "row"; index: number }
  | { kind: "col"; index: number }
  | null;

/**
 * Canvas overlay that renders draggable row/column grid lines
 * for the guided keynote parsing flow. The user draws a bounding box,
 * OCR word clustering proposes row/col boundaries, and this overlay
 * lets the user drag them to adjust (or double-click to add new ones).
 */
export default function GuidedParseOverlay({
  width,
  height,
  cssScale,
}: GuidedParseOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const active = useViewerStore((s) => s.guidedParseActive);
  const region = useViewerStore((s) => s.guidedParseRegion);
  const rows = useViewerStore((s) => s.guidedParseRows);
  const cols = useViewerStore((s) => s.guidedParseCols);
  const setRows = useViewerStore((s) => s.setGuidedParseRows);
  const setCols = useViewerStore((s) => s.setGuidedParseCols);

  // Local drag state -- not in the store because it's transient
  const [dragging, setDragging] = useState<DragTarget>(null);
  const dragRef = useRef<DragTarget>(null); // mirror for event handlers

  // ── Drawing ──────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0 || !region) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const [minX, minY, maxX, maxY] = region;
    const rx = minX * width;
    const ry = minY * height;
    const rw = (maxX - minX) * width;
    const rh = (maxY - minY) * height;

    // --- Outer region bounding box (dashed white/gray) ---
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.strokeStyle = "rgba(128, 128, 128, 0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(rx - 1, ry - 1, rw + 2, rh + 2);
    ctx.restore();

    // --- Column boundary lines (cyan, vertical) ---
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = "rgba(0, 220, 255, 0.85)";
    ctx.lineWidth = 2;
    for (let i = 0; i < cols.length; i++) {
      const px = cols[i] * width;
      ctx.beginPath();
      ctx.moveTo(px, ry);
      ctx.lineTo(px, ry + rh);
      ctx.stroke();
    }
    ctx.restore();

    // Column drag handles (top and bottom edges)
    ctx.save();
    ctx.fillStyle = "rgba(0, 220, 255, 1)";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 1;
    for (let i = 0; i < cols.length; i++) {
      const px = cols[i] * width;
      // Top handle
      ctx.fillRect(px - HANDLE_SIZE, ry - HANDLE_SIZE, HANDLE_SIZE * 2, HANDLE_SIZE * 2);
      ctx.strokeRect(px - HANDLE_SIZE, ry - HANDLE_SIZE, HANDLE_SIZE * 2, HANDLE_SIZE * 2);
      // Bottom handle
      ctx.fillRect(px - HANDLE_SIZE, ry + rh - HANDLE_SIZE, HANDLE_SIZE * 2, HANDLE_SIZE * 2);
      ctx.strokeRect(px - HANDLE_SIZE, ry + rh - HANDLE_SIZE, HANDLE_SIZE * 2, HANDLE_SIZE * 2);
    }
    ctx.restore();

    // --- Row boundary lines (magenta/pink, horizontal) ---
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(255, 80, 200, 0.8)";
    ctx.lineWidth = 1;
    for (let i = 0; i < rows.length; i++) {
      const py = rows[i] * height;
      ctx.beginPath();
      ctx.moveTo(rx, py);
      ctx.lineTo(rx + rw, py);
      ctx.stroke();
    }
    ctx.restore();

    // Row drag handles (left and right edges)
    ctx.save();
    ctx.fillStyle = "rgba(255, 80, 200, 1)";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 1;
    for (let i = 0; i < rows.length; i++) {
      const py = rows[i] * height;
      // Left handle
      ctx.fillRect(rx - HANDLE_SIZE, py - HANDLE_SIZE, HANDLE_SIZE * 2, HANDLE_SIZE * 2);
      ctx.strokeRect(rx - HANDLE_SIZE, py - HANDLE_SIZE, HANDLE_SIZE * 2, HANDLE_SIZE * 2);
      // Right handle
      ctx.fillRect(rx + rw - HANDLE_SIZE, py - HANDLE_SIZE, HANDLE_SIZE * 2, HANDLE_SIZE * 2);
      ctx.strokeRect(rx + rw - HANDLE_SIZE, py - HANDLE_SIZE, HANDLE_SIZE * 2, HANDLE_SIZE * 2);
    }
    ctx.restore();
  }, [width, height, region, rows, cols]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ── Hit testing ──────────────────────────────────────────
  const hitTest = useCallback(
    (cx: number, cy: number): DragTarget => {
      if (!region) return null;
      // Check column lines
      for (let i = 0; i < cols.length; i++) {
        const px = cols[i] * width;
        if (Math.abs(cx - px) < GRAB_RADIUS) {
          return { kind: "col", index: i };
        }
      }
      // Check row lines
      for (let i = 0; i < rows.length; i++) {
        const py = rows[i] * height;
        if (Math.abs(cy - py) < GRAB_RADIUS) {
          return { kind: "row", index: i };
        }
      }
      return null;
    },
    [region, rows, cols, width, height]
  );

  // ── Mouse position from event ───────────────────────────
  const getCanvasPos = useCallback(
    (e: React.MouseEvent | MouseEvent): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      // Account for cssScale -- the canvas CSS size is `width x height` but it may be
      // rendered inside a scaled container. BoundingClientRect gives the actual screen
      // size, so divide to get canvas-space coordinates.
      const x = (e.clientX - rect.left) * (width / rect.width);
      const y = (e.clientY - rect.top) * (height / rect.height);
      return { x, y };
    },
    [width, height]
  );

  // ── Mouse handlers ──────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!region) return;
      const { x, y } = getCanvasPos(e);
      const target = hitTest(x, y);
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = target;
        setDragging(target);
      }
    },
    [region, getCanvasPos, hitTest]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const target = dragRef.current;
      if (!target || !region) return;
      e.preventDefault();

      const { x, y } = getCanvasPos(e);
      const [minX, minY, maxX, maxY] = region;

      if (target.kind === "col") {
        // Constrain between adjacent column boundaries (or region edges)
        const sorted = [...cols].map((v, i) => ({ v, i }));
        sorted.sort((a, b) => a.v - b.v);
        const sortedIdx = sorted.findIndex((s) => s.i === target.index);
        const lo = sortedIdx > 0 ? sorted[sortedIdx - 1].v : minX;
        const hi = sortedIdx < sorted.length - 1 ? sorted[sortedIdx + 1].v : maxX;
        const normalized = Math.max(lo + 0.001, Math.min(hi - 0.001, x / width));
        const next = [...cols];
        next[target.index] = normalized;
        setCols(next);
      } else if (target.kind === "row") {
        const sorted = [...rows].map((v, i) => ({ v, i }));
        sorted.sort((a, b) => a.v - b.v);
        const sortedIdx = sorted.findIndex((s) => s.i === target.index);
        const lo = sortedIdx > 0 ? sorted[sortedIdx - 1].v : minY;
        const hi = sortedIdx < sorted.length - 1 ? sorted[sortedIdx + 1].v : maxY;
        const normalized = Math.max(lo + 0.001, Math.min(hi - 0.001, y / height));
        const next = [...rows];
        next[target.index] = normalized;
        setRows(next);
      }
    },
    [region, rows, cols, width, height, setRows, setCols, getCanvasPos]
  );

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    setDragging(null);
  }, []);

  // Attach global listeners while dragging so we don't lose the drag
  // if the mouse leaves the canvas.
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, handleMouseMove, handleMouseUp]);

  // ── Double-click to add a new boundary ──────────────────
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!region) return;
      const { x, y } = getCanvasPos(e);
      const [minX, minY, maxX, maxY] = region;

      const nx = x / width;
      const ny = y / height;

      // Only add if inside the region
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) return;

      // Already on an existing line? Skip.
      if (hitTest(x, y)) return;

      // Determine whether to add a row or column based on which edge
      // the click is closer to (proportionally within the region).
      const relX = (nx - minX) / (maxX - minX); // 0..1 within region
      const relY = (ny - minY) / (maxY - minY);
      const distToVertEdge = Math.min(relX, 1 - relX);
      const distToHorzEdge = Math.min(relY, 1 - relY);

      if (distToVertEdge > distToHorzEdge) {
        // Closer to top/bottom edge -> add a row line
        setRows([...rows, ny]);
      } else {
        // Closer to left/right edge -> add a column line
        setCols([...cols, nx]);
      }
    },
    [region, rows, cols, width, height, getCanvasPos, hitTest, setRows, setCols]
  );

  // ── Cursor style ────────────────────────────────────────
  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (dragRef.current) return; // already dragging, cursor set
      const canvas = canvasRef.current;
      if (!canvas || !region) return;
      const { x, y } = getCanvasPos(e);
      const target = hitTest(x, y);
      if (target) {
        canvas.style.cursor = target.kind === "col" ? "ew-resize" : "ns-resize";
      } else {
        canvas.style.cursor = "crosshair";
      }
    },
    [region, getCanvasPos, hitTest]
  );

  // Don't render if not active
  if (!active || !region) return null;

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleCanvasMouseMove}
      onDoubleClick={handleDoubleClick}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: "auto",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
        zIndex: 30,
      }}
    />
  );
}
