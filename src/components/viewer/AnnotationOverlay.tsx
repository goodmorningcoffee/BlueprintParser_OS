"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { TWENTY_COLORS, AREA_UNIT_MAP } from "@/types";
import type { ClientAnnotation, CountMarkerData, TakeoffShape, AreaPolygonData } from "@/types";
import { polygonCentroid, pointInPolygon, computeRealArea } from "@/lib/areaCalc";

interface AnnotationOverlayProps {
  width: number;
  height: number;
  cssScale: number;
}

/** Assign colors by unique label order — each unique label gets next color in palette */
const labelColorMap = new Map<string, string>();
function labelColor(name: string): string {
  if (!labelColorMap.has(name)) {
    labelColorMap.set(name, TWENTY_COLORS[labelColorMap.size % TWENTY_COLORS.length]);
  }
  return labelColorMap.get(name)!;
}

function drawCountMarker(
  ctx: CanvasRenderingContext2D,
  ann: ClientAnnotation,
  width: number,
  height: number,
  isSelected: boolean
) {
  const data = ann.data as unknown as CountMarkerData;
  if (!data?.color || !data?.shape) return;

  const [minX, minY, maxX, maxY] = ann.bbox;
  const cx = ((minX + maxX) / 2) * width;
  const cy = ((minY + maxY) / 2) * height;
  const r = 10;

  ctx.save();
  ctx.fillStyle = data.color + "cc";
  const rgb = parseInt(data.color.slice(1), 16);
  ctx.strokeStyle = `rgb(${((rgb >> 16) & 0xff) * 0.7 | 0}, ${((rgb >> 8) & 0xff) * 0.7 | 0}, ${(rgb & 0xff) * 0.7 | 0})`;
  ctx.lineWidth = isSelected ? 3 : 1.5;

  ctx.beginPath();
  switch (data.shape) {
    case "circle":
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case "square":
      ctx.rect(cx - r, cy - r, r * 2, r * 2);
      break;
    case "diamond":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    case "triangle":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy + r);
      ctx.lineTo(cx - r, cy + r);
      ctx.closePath();
      break;
    case "cross": {
      const a = r * 0.35;
      ctx.moveTo(cx - a, cy - r); ctx.lineTo(cx + a, cy - r);
      ctx.lineTo(cx + a, cy - a); ctx.lineTo(cx + r, cy - a);
      ctx.lineTo(cx + r, cy + a); ctx.lineTo(cx + a, cy + a);
      ctx.lineTo(cx + a, cy + r); ctx.lineTo(cx - a, cy + r);
      ctx.lineTo(cx - a, cy + a); ctx.lineTo(cx - r, cy + a);
      ctx.lineTo(cx - r, cy - a); ctx.lineTo(cx - a, cy - a);
      ctx.closePath();
      break;
    }
  }
  ctx.fill();
  ctx.stroke();

  if (isSelected) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export default function AnnotationOverlay({
  width,
  height,
  cssScale,
}: AnnotationOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const annotations = useViewerStore((s) => s.annotations);
  const mode = useViewerStore((s) => s.mode);
  const addAnnotation = useViewerStore((s) => s.addAnnotation);
  const removeAnnotation = useViewerStore((s) => s.removeAnnotation);
  const updateAnnotation = useViewerStore((s) => s.updateAnnotation);
  const publicId = useViewerStore((s) => s.publicId);
  const isDemo = useViewerStore((s) => s.isDemo);
  const keynotes = useViewerStore((s) => s.keynotes);
  const setKeynoteFilter = useViewerStore((s) => s.setKeynoteFilter);

  const [drawing, setDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [drawEnd, setDrawEnd] = useState({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number>(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const showDetections = useViewerStore((s) => s.showDetections);
  const confidenceThreshold = useViewerStore((s) => s.confidenceThreshold);
  const activeModels = useViewerStore((s) => s.activeModels);
  const confidenceThresholds = useViewerStore((s) => s.confidenceThresholds);
  const activeAnnotationFilter = useViewerStore((s) => s.activeAnnotationFilter);
  const activeTakeoffItemId = useViewerStore((s) => s.activeTakeoffItemId);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const setActiveTakeoffItemId = useViewerStore((s) => s.setActiveTakeoffItemId);
  const calibrationMode = useViewerStore((s) => s.calibrationMode);
  const setCalibrationMode = useViewerStore((s) => s.setCalibrationMode);
  const calibrationPoints = useViewerStore((s) => s.calibrationPoints);
  const setCalibrationPoint = useViewerStore((s) => s.setCalibrationPoint);
  const resetCalibration = useViewerStore((s) => s.resetCalibration);
  const scaleCalibrations = useViewerStore((s) => s.scaleCalibrations);
  const polygonDrawingMode = useViewerStore((s) => s.polygonDrawingMode);
  const setPolygonDrawingMode = useViewerStore((s) => s.setPolygonDrawingMode);
  const polygonVertices = useViewerStore((s) => s.polygonVertices);
  const addPolygonVertex = useViewerStore((s) => s.addPolygonVertex);
  const resetPolygonDrawing = useViewerStore((s) => s.resetPolygonDrawing);
  const undoLastVertex = useViewerStore((s) => s.undoLastVertex);
  const showTakeoffPanel = useViewerStore((s) => s.showTakeoffPanel);

  const pageAnnotations = annotations.filter((a) => {
    if (a.pageNumber !== pageNumber) return false;
    // Filter YOLO annotations by toggle, per-model active state, and per-model confidence
    if (a.source === "yolo") {
      if (!showDetections) return false;
      const modelName = (a as any).data?.modelName as string | undefined;
      if (modelName && activeModels[modelName] === false) return false;
      const conf = (a as any).threshold || (a as any).data?.confidence || 0;
      const threshold = (modelName && confidenceThresholds[modelName] != null)
        ? confidenceThresholds[modelName]
        : confidenceThreshold;
      if (conf < threshold) return false;
    }
    // Takeoff markers are always visible
    if (a.source === "takeoff") return true;
    if (a.source === "takeoff-scale") return false;
    // Filter by active annotation label
    if (activeAnnotationFilter && a.name !== activeAnnotationFilter) return false;
    return true;
  });

  const pageKeynotes = keynotes[pageNumber] || [];

  // Draw annotations
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

    // Draw existing annotations
    for (const ann of pageAnnotations) {
      // Count markers: draw shape instead of rectangle
      if (ann.source === "takeoff" && (ann.data as any)?.type === "count-marker") {
        drawCountMarker(ctx, ann, width, height, ann.id === selectedId);
        continue;
      }

      const color = labelColor(ann.name);
      const [minX, minY, maxX, maxY] = ann.bbox;
      const x = minX * width;
      const y = minY * height;
      const w = (maxX - minX) * width;
      const h = (maxY - minY) * height;

      ctx.strokeStyle = color;
      ctx.lineWidth = ann.id === selectedId ? 3 : 2;
      ctx.strokeRect(x, y, w, h);

      ctx.fillStyle = color + "15";
      ctx.fillRect(x, y, w, h);

      // Label
      const fontSize = Math.max(10, Math.min(13, h * 0.3));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const labelText = ann.name;
      const textW = ctx.measureText(labelText).width;
      const isSelected = ann.id === selectedId;

      // Label background + text
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(x, y - fontSize - 4, textW + (isSelected ? 20 : 6), fontSize + 4);
      ctx.fillStyle = color;
      ctx.fillText(labelText, x + 3, y - 4);

      // Selected: show delete "x" and corner resize handles
      if (isSelected) {
        ctx.fillStyle = "#ff4444";
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillText("x", x + textW + 8, y - 4);

        // Corner handles
        const hs = 6;
        ctx.fillStyle = color;
        ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
        ctx.fillRect(x + w - hs / 2, y - hs / 2, hs, hs);
        ctx.fillRect(x - hs / 2, y + h - hs / 2, hs, hs);
        ctx.fillRect(x + w - hs / 2, y + h - hs / 2, hs, hs);
      }
    }

    // Draw in-progress rectangle
    if (drawing) {
      ctx.strokeStyle = "#00ff88";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      const dx = drawEnd.x - drawStart.x;
      const dy = drawEnd.y - drawStart.y;
      ctx.strokeRect(drawStart.x, drawStart.y, dx, dy);
      ctx.setLineDash([]);
    }

    // Draw completed area polygons
    for (const ann of pageAnnotations) {
      if (ann.source !== "takeoff" || (ann.data as any)?.type !== "area-polygon") continue;
      const data = ann.data as unknown as AreaPolygonData;
      if (!data.vertices || data.vertices.length < 3) continue;

      ctx.save();
      // Fill
      ctx.fillStyle = data.color + "40";
      ctx.beginPath();
      ctx.moveTo(data.vertices[0].x * width, data.vertices[0].y * height);
      for (let i = 1; i < data.vertices.length; i++) {
        ctx.lineTo(data.vertices[i].x * width, data.vertices[i].y * height);
      }
      ctx.closePath();
      ctx.fill();

      // Stroke
      ctx.strokeStyle = data.color;
      ctx.lineWidth = ann.id === selectedId ? 3 : 2;
      ctx.stroke();

      // Vertices when selected
      if (ann.id === selectedId) {
        for (const v of data.vertices) {
          ctx.fillStyle = data.color;
          ctx.beginPath();
          ctx.arc(v.x * width, v.y * height, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // Area label at centroid
      const centroid = polygonCentroid(data.vertices);
      const cx = centroid.x * width;
      const cy = centroid.y * height;
      const labelText = data.areaSqUnits > 0
        ? `${data.areaSqUnits.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${data.unit}`
        : `-- ${data.unit}`;
      ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(labelText).width;
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(cx - tw / 2 - 4, cy - 7, tw + 8, 16);
      ctx.fillStyle = data.color;
      ctx.fillText(labelText, cx - tw / 2, cy + 5);
      ctx.restore();
    }

    // Draw calibration points and line
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

    // Draw in-progress polygon
    if (polygonDrawingMode === "drawing" && polygonVertices.length > 0) {
      const activeItem = takeoffItems.find((t) => t.id === activeTakeoffItemId);
      const polyColor = activeItem?.color || "#00ff88";
      ctx.save();

      const verts = polygonVertices;
      const mp = mousePos;

      // Preview fill (connect vertices + cursor + back to first vertex)
      if (verts.length >= 2 && mp) {
        ctx.fillStyle = polyColor + "20"; // very light fill
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
      // Preview line to cursor
      if (mp) {
        ctx.lineTo(mp.x, mp.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Check if cursor is near first point (snap indicator)
      let nearFirst = false;
      if (mp && verts.length >= 3) {
        const firstX = verts[0].x * width;
        const firstY = verts[0].y * height;
        const dist = Math.sqrt((mp.x - firstX) ** 2 + (mp.y - firstY) ** 2);
        nearFirst = dist < 15;
      }

      // Vertex dots
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const vx = v.x * width;
        const vy = v.y * height;

        if (i === 0) {
          // First vertex — larger, with white ring, highlighted when cursor is near
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
          // Other vertices — normal dots
          ctx.fillStyle = polyColor;
          ctx.beginPath();
          ctx.arc(vx, vy, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Instruction text
      ctx.font = "12px sans-serif";
      const msg = verts.length < 3
        ? "Click to add points"
        : "Click first point or Enter to close";
      const tw = ctx.measureText(msg).width;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(8, 8, tw + 12, 22);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(msg, 14, 23);

      ctx.restore();
    }
  }, [pageAnnotations, width, height, drawing, drawStart, drawEnd, selectedId, calibrationMode, calibrationPoints, polygonDrawingMode, polygonVertices, activeTakeoffItemId, takeoffItems, mousePos]);

  const getPos = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    },
    []
  );

  /** Save the current in-progress polygon as an area-polygon annotation */
  const savePolygon = useCallback(() => {
    const verts = useViewerStore.getState().polygonVertices;
    const items = useViewerStore.getState().takeoffItems;
    const activeId = useViewerStore.getState().activeTakeoffItemId;
    if (verts.length < 3) return;

    const activeItem = items.find((t) => t.id === activeId);
    if (!activeItem) return;

    // Compute bounding box from vertices
    const xs = verts.map((v) => v.x);
    const ys = verts.map((v) => v.y);
    const bbox: [number, number, number, number] = [
      Math.min(...xs), Math.min(...ys),
      Math.max(...xs), Math.max(...ys),
    ];

    // Compute area if calibrated
    const calibration = scaleCalibrations[pageNumber];
    let areaSqUnits = 0;
    let unit: import("@/types").AreaUnitSq = "SF";
    if (calibration) {
      areaSqUnits = computeRealArea(verts, width, height, calibration);
      unit = AREA_UNIT_MAP[calibration.unit] || "SF";
    }

    const polygonData: AreaPolygonData = {
      type: "area-polygon",
      takeoffItemId: activeItem.id,
      color: activeItem.color,
      vertices: [...verts],
      areaSqUnits,
      unit,
    };

    // Optimistic add
    const tempId = -Date.now();
    addAnnotation({
      id: tempId,
      pageNumber,
      name: activeItem.name,
      bbox,
      note: null,
      source: "takeoff",
      data: polygonData as unknown as Record<string, unknown>,
    });

    // Persist
    if (!isDemo) {
      fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          pageNumber,
          name: activeItem.name,
          bbox,
          source: "takeoff",
          data: polygonData,
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((saved) => {
          if (saved) updateAnnotation(tempId, { id: saved.id });
        })
        .catch(() => {});
    }

    resetPolygonDrawing();
    setMousePos(null);
  }, [scaleCalibrations, pageNumber, width, height, publicId, addAnnotation, updateAnnotation, resetPolygonDrawing, isDemo]);

  // Track which corner is being resized: null or "tl"|"tr"|"bl"|"br"
  const [resizeCorner, setResizeCorner] = useState<string | null>(null);

  function deleteSelected() {
    if (selectedId === null) return;
    if (!isDemo) {
      fetch(`/api/annotations/${selectedId}`, { method: "DELETE" }).catch(() => {});
    }
    removeAnnotation(selectedId);
    setSelectedId(null);
  }

  /** Save the current position of the selected annotation to the API */
  const saveDragPosition = useCallback(() => {
    if (selectedId === null) return;
    if (isDemo) return;
    const ann = annotations.find((a) => a.id === selectedId);
    if (ann) {
      fetch(`/api/annotations/${selectedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox: ann.bbox }),
      }).catch(() => {});
    }
  }, [selectedId, annotations, isDemo]);

  const HANDLE = 8; // corner handle size in pixels

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const pos = getPos(e);

      // Scale calibration mode
      if (calibrationMode === "point1") {
        e.stopPropagation();
        const normX = pos.x / width;
        const normY = pos.y / height;
        setCalibrationPoint("p1", { x: normX, y: normY });
        setCalibrationMode("point2");
        return;
      }
      if (calibrationMode === "point2") {
        e.stopPropagation();
        const normX = pos.x / width;
        const normY = pos.y / height;
        setCalibrationPoint("p2", { x: normX, y: normY });
        setCalibrationMode("input");
        return;
      }

      // Takeoff placement mode
      if (activeTakeoffItemId !== null) {
        const activeItem = takeoffItems.find((t) => t.id === activeTakeoffItemId);
        if (!activeItem) return;
        e.stopPropagation();

        // Polygon drawing mode
        if (activeItem.shape === "polygon") {
          const normX = pos.x / width;
          const normY = pos.y / height;

          if (polygonDrawingMode === "idle") {
            // Start new polygon
            setPolygonDrawingMode("drawing");
            addPolygonVertex({ x: normX, y: normY });
          } else if (polygonDrawingMode === "drawing") {
            // Check snap-to-first-point to close (>= 3 vertices required)
            if (polygonVertices.length >= 3) {
              const firstV = polygonVertices[0];
              const firstX = firstV.x * width;
              const firstY = firstV.y * height;
              const dist = Math.sqrt((pos.x - firstX) ** 2 + (pos.y - firstY) ** 2);
              if (dist < 15) {
                savePolygon();
                return;
              }
            }
            // Add vertex (skip on double-click second click)
            if (e.detail < 2) {
              addPolygonVertex({ x: normX, y: normY });
            }
          }
          return;
        }

        // Count marker placement
        // Check if clicking existing count marker → select it
        for (const ann of pageAnnotations) {
          if (ann.source !== "takeoff") continue;
          const [minX, minY, maxX, maxY] = ann.bbox;
          const cx = ((minX + maxX) / 2) * width;
          const cy = ((minY + maxY) / 2) * height;
          const dist = Math.sqrt((pos.x - cx) ** 2 + (pos.y - cy) ** 2);
          if (dist < 14) {
            setSelectedId(ann.id);
            return;
          }
        }

        // Place new marker
        const normX = pos.x / width;
        const normY = pos.y / height;
        const hs = 0.005;
        const bbox: [number, number, number, number] = [
          Math.max(0, normX - hs),
          Math.max(0, normY - hs),
          Math.min(1, normX + hs),
          Math.min(1, normY + hs),
        ];

        const markerData: CountMarkerData = {
          type: "count-marker",
          shape: activeItem.shape,
          color: activeItem.color,
          takeoffItemId: activeItem.id,
        };

        // Optimistic add
        const tempId = -Date.now();
        addAnnotation({
          id: tempId,
          pageNumber,
          name: activeItem.name,
          bbox,
          note: null,
          source: "takeoff",
          data: markerData as unknown as Record<string, unknown>,
        });

        // Persist
        if (!isDemo) {
          fetch("/api/annotations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: publicId,
              pageNumber,
              name: activeItem.name,
              bbox,
              source: "takeoff",
              data: markerData,
            }),
          })
            .then((res) => res.ok ? res.json() : null)
            .then((saved) => {
              if (saved) updateAnnotation(tempId, { id: saved.id });
            })
            .catch(() => {});
        }

        return;
      }

      // Pointer mode: click to select annotation, delete via label "x", or click keynote to filter
      if (mode === "pointer") {
        // If an annotation is already selected, check if clicking its delete "x"
        if (selectedId !== null) {
          const selAnn = pageAnnotations.find((a) => a.id === selectedId);
          if (selAnn) {
            const [minX, minY] = selAnn.bbox;
            const ax = minX * width;
            const ay = minY * height;
            if (pos.y >= ay - 18 && pos.y <= ay && pos.x >= ax) {
              e.stopPropagation();
              deleteSelected();
              return;
            }
          }
        }
        // Check area polygons first (point-in-polygon test)
        for (const ann of pageAnnotations) {
          if (ann.source !== "takeoff" || (ann.data as any)?.type !== "area-polygon") continue;
          const data = ann.data as unknown as AreaPolygonData;
          const clickNorm = { x: pos.x / width, y: pos.y / height };
          if (pointInPolygon(clickNorm, data.vertices)) {
            e.stopPropagation();
            setSelectedId(ann.id);
            return;
          }
        }
        // Check annotations (bbox-based)
        for (const ann of pageAnnotations) {
          const [minX, minY, maxX, maxY] = ann.bbox;
          const ax = minX * width;
          const ay = minY * height;
          const aw = (maxX - minX) * width;
          const ah = (maxY - minY) * height;
          if (pos.x >= ax && pos.x <= ax + aw && pos.y >= ay && pos.y <= ay + ah) {
            e.stopPropagation();
            setSelectedId(ann.id);
            return;
          }
        }
        // Check keynotes
        const clickX = pos.x / width;
        const clickY = pos.y / height;
        for (const keynote of pageKeynotes) {
          const [left, top, right, bottom] = keynote.bbox;
          if (clickX >= left && clickX <= right && clickY >= top && clickY <= bottom) {
            e.stopPropagation();
            setKeynoteFilter({ shape: keynote.shape, text: keynote.text });
            return;
          }
        }
        // Clicked empty space — deselect
        setSelectedId(null);
        return;
      }

      // If selected, check corners for resize or label area for delete
      if (selectedId !== null && (mode === "moveMarkup" || mode === "markup")) {
        const selAnn = pageAnnotations.find((a) => a.id === selectedId);
        if (selAnn) {
          const [minX, minY, maxX, maxY] = selAnn.bbox;
          const corners = {
            tl: { x: minX * width, y: minY * height },
            tr: { x: maxX * width, y: minY * height },
            bl: { x: minX * width, y: maxY * height },
            br: { x: maxX * width, y: maxY * height },
          };

          // Check if clicking a corner handle
          for (const [key, corner] of Object.entries(corners)) {
            if (Math.abs(pos.x - corner.x) < HANDLE && Math.abs(pos.y - corner.y) < HANDLE) {
              e.stopPropagation();
              setResizeCorner(key);
              setDragging(true);
              return;
            }
          }

          // Check if clicking the label bar area (above the box) for delete
          const ax = minX * width;
          const ay = minY * height;
          if (pos.y >= ay - 18 && pos.y <= ay && pos.x >= ax) {
            e.stopPropagation();
            deleteSelected();
            return;
          }
        }
      }

      // Check if clicking on any annotation to select it
      for (const ann of pageAnnotations) {
        const [minX, minY, maxX, maxY] = ann.bbox;
        const ax = minX * width;
        const ay = minY * height;
        const aw = (maxX - minX) * width;
        const ah = (maxY - minY) * height;
        if (pos.x >= ax && pos.x <= ax + aw && pos.y >= ay && pos.y <= ay + ah) {
          e.stopPropagation();
          setSelectedId(ann.id);
          if (mode === "moveMarkup") {
            setDragging(true);
            setResizeCorner(null);
            setDragOffset({ x: pos.x - ax, y: pos.y - ay });
          }
          return;
        }
      }

      // Start drawing in markup mode
      if (mode !== "markup") return;
      e.stopPropagation();
      setSelectedId(null);
      setDrawing(true);
      setDrawStart(pos);
      setDrawEnd(pos);
    },
    [mode, pageAnnotations, pageKeynotes, width, height, getPos, selectedId, setKeynoteFilter, activeTakeoffItemId, takeoffItems, publicId, pageNumber, addAnnotation, updateAnnotation, calibrationMode, setCalibrationPoint, setCalibrationMode, polygonDrawingMode, setPolygonDrawingMode, addPolygonVertex, polygonVertices, savePolygon, isDemo]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Track cursor for polygon preview (throttled via rAF)
      if (polygonDrawingMode === "drawing") {
        const p = getPos(e);
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => setMousePos(p));
      }
      if (drawing) {
        setDrawEnd(getPos(e));
        return;
      }
      if (dragging && selectedId !== null) {
        const pos = getPos(e);
        const ann = pageAnnotations.find((a) => a.id === selectedId);
        if (!ann) return;
        const [minX, minY, maxX, maxY] = ann.bbox;

        if (resizeCorner) {
          // Resize from corner
          const px = pos.x / width;
          const py = pos.y / height;
          let newBbox: [number, number, number, number] = [minX, minY, maxX, maxY];
          if (resizeCorner === "tl") newBbox = [px, py, maxX, maxY];
          if (resizeCorner === "tr") newBbox = [minX, py, px, maxY];
          if (resizeCorner === "bl") newBbox = [px, minY, maxX, py];
          if (resizeCorner === "br") newBbox = [minX, minY, px, py];
          // Ensure min < max
          updateAnnotation(selectedId, {
            bbox: [
              Math.max(0, Math.min(newBbox[0], newBbox[2] - 0.01)),
              Math.max(0, Math.min(newBbox[1], newBbox[3] - 0.01)),
              Math.min(1, Math.max(newBbox[2], newBbox[0] + 0.01)),
              Math.min(1, Math.max(newBbox[3], newBbox[1] + 0.01)),
            ],
          });
        } else {
          // Move entire annotation
          const w = maxX - minX;
          const h = maxY - minY;
          const newMinX = (pos.x - dragOffset.x) / width;
          const newMinY = (pos.y - dragOffset.y) / height;
          updateAnnotation(selectedId, {
            bbox: [
              Math.max(0, Math.min(newMinX, 1 - w)),
              Math.max(0, Math.min(newMinY, 1 - h)),
              Math.max(0, Math.min(newMinX + w, 1)),
              Math.max(0, Math.min(newMinY + h, 1)),
            ],
          });
        }
      }
    },
    [drawing, dragging, selectedId, dragOffset, resizeCorner, pageAnnotations, width, height, getPos, updateAnnotation, polygonDrawingMode]
  );

  const handleMouseUp = useCallback(async () => {
    // Save dragged/resized position
    if (dragging && selectedId !== null) {
      setDragging(false);
      setResizeCorner(null);
      saveDragPosition();
      return;
    }

    if (!drawing) return;
    setDrawing(false);

    const minX = Math.min(drawStart.x, drawEnd.x) / width;
    const minY = Math.min(drawStart.y, drawEnd.y) / height;
    const maxX = Math.max(drawStart.x, drawEnd.x) / width;
    const maxY = Math.max(drawStart.y, drawEnd.y) / height;

    // Minimum size check
    if (Math.abs(maxX - minX) < 0.01 || Math.abs(maxY - minY) < 0.01) return;

    const name = prompt("Label name:");
    if (!name) return;

    // Optimistic add
    const tempId = -Date.now();
    addAnnotation({
      id: tempId,
      pageNumber,
      name,
      bbox: [minX, minY, maxX, maxY],
      note: null,
      source: "user",
    });

    // Persist
    if (!isDemo) {
      fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          pageNumber,
          name,
          bbox: [minX, minY, maxX, maxY],
        }),
      })
        .then((res) => res.ok ? res.json() : null)
        .then((saved) => {
          if (saved) updateAnnotation(tempId, { id: saved.id });
        })
        .catch(() => {});
    }
  }, [drawing, dragging, selectedId, saveDragPosition, drawStart, drawEnd, width, height, publicId, pageNumber, addAnnotation, updateAnnotation, isDemo]);

  const handleDoubleClick = useCallback(() => {
    // Close polygon on double-click
    if (polygonDrawingMode === "drawing") {
      const verts = useViewerStore.getState().polygonVertices;
      // Remove duplicate vertex from the first mousedown of the double-click
      if (verts.length >= 2) {
        const last = verts[verts.length - 1];
        const prev = verts[verts.length - 2];
        if (Math.abs(last.x - prev.x) < 0.005 && Math.abs(last.y - prev.y) < 0.005) {
          undoLastVertex();
        }
      }
      // Check we still have enough vertices
      const finalVerts = useViewerStore.getState().polygonVertices;
      if (finalVerts.length >= 3) {
        savePolygon();
      }
      return;
    }

    // Existing: finalize dragged annotation
    if (dragging && selectedId !== null) {
      setDragging(false);
      setResizeCorner(null);
      saveDragPosition();
    }
  }, [polygonDrawingMode, savePolygon, undoLastVertex, dragging, selectedId, saveDragPosition]);

  // Escape key: cancel polygon/calibration/deactivate takeoff
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (polygonDrawingMode === "drawing") {
          resetPolygonDrawing();
          setMousePos(null);
        } else if (calibrationMode !== "idle") {
          resetCalibration();
        } else if (activeTakeoffItemId !== null) {
          setActiveTakeoffItemId(null);
        }
      }
      // Enter: close polygon
      if (e.key === "Enter" && polygonDrawingMode === "drawing") {
        e.preventDefault();
        const verts = useViewerStore.getState().polygonVertices;
        if (verts.length >= 3) {
          savePolygon();
        }
      }
      // Ctrl+Z: undo last polygon vertex
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && polygonDrawingMode === "drawing") {
        e.preventDefault();
        undoLastVertex();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeTakeoffItemId, setActiveTakeoffItemId, polygonDrawingMode, resetPolygonDrawing, calibrationMode, resetCalibration, undoLastVertex, savePolygon]);

  // Keyboard: Delete/Backspace to delete, Enter to place dragged annotation
  useEffect(() => {
    if (selectedId === null) return;

    function handleKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (!isDemo) {
          fetch(`/api/annotations/${selectedId}`, { method: "DELETE" }).catch(() => {});
        }
        removeAnnotation(selectedId!);
        setSelectedId(null);
      }

      if (e.key === "Enter" && dragging) {
        e.preventDefault();
        setDragging(false);
        setResizeCorner(null);
        saveDragPosition();
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selectedId, dragging, removeAnnotation, saveDragPosition, isDemo]);

  // Cancel in-progress polygon/calibration on page change, deselect
  useEffect(() => {
    setSelectedId(null);
    if (polygonDrawingMode === "drawing") {
      resetPolygonDrawing();
      setMousePos(null);
    }
    if (calibrationMode !== "idle") {
      resetCalibration();
    }
  }, [pageNumber]);

  // Exit polygon drawing when switching interaction modes
  useEffect(() => {
    if (polygonDrawingMode === "drawing") {
      resetPolygonDrawing();
      setMousePos(null);
    }
    if (activeTakeoffItemId !== null) {
      // Don't deactivate here — let the user keep the item selected
      // Only reset the in-progress drawing
    }
  }, [mode]);

  // Reset polygon drawing if active item changes
  useEffect(() => {
    if (polygonDrawingMode === "drawing") {
      resetPolygonDrawing();
      setMousePos(null);
    }
  }, [activeTakeoffItemId]);

  // Exit polygon drawing when QTO panel closes
  useEffect(() => {
    if (!showTakeoffPanel && polygonDrawingMode === "drawing") {
      resetPolygonDrawing();
      setMousePos(null);
    }
  }, [showTakeoffPanel]);

  // Always render — annotations should be visible in all modes
  if (pageAnnotations.length === 0 && activeTakeoffItemId === null && calibrationMode === "idle" && polygonDrawingMode === "idle" && mode !== "markup" && mode !== "moveMarkup" && mode !== "pointer") return null;

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      onMouseLeave={() => {
        if (dragging) {
          setDragging(false);
          setResizeCorner(null);
        }
        if (drawing) setDrawing(false);
      }}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: activeTakeoffItemId !== null || calibrationMode !== "idle" || polygonDrawingMode === "drawing" || mode === "markup" || mode === "moveMarkup" || mode === "pointer" ? "auto" : "none",
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
        cursor: calibrationMode !== "idle" ? "crosshair" : polygonDrawingMode === "drawing" ? "crosshair" : activeTakeoffItemId !== null ? "crosshair" : mode === "markup" ? "crosshair" : mode === "moveMarkup" ? "grab" : mode === "pointer" ? "pointer" : "default",
      }}
    />
  );
}
