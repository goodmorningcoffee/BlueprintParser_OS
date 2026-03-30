"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useViewerStore, useNavigation, useProject, useTableParse, useKeynoteParse, useYoloTags, useSymbolSearch } from "@/stores/viewerStore";
import { TWENTY_COLORS, AREA_UNIT_MAP } from "@/types";
import type { ClientAnnotation, CountMarkerData, TakeoffShape, AreaPolygonData } from "@/types";
import { polygonCentroid, pointInPolygon, computeRealArea } from "@/lib/areaCalc";
import { getOcrTextInAnnotation, mapYoloToOcrText } from "@/lib/yolo-tag-engine";
import DrawingPreviewLayer from "./DrawingPreviewLayer";
import MarkupDialog from "./MarkupDialog";

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
  isSelected: boolean,
  markerSize?: number
) {
  const data = ann.data as unknown as CountMarkerData;
  if (!data?.color || !data?.shape) return;

  const [minX, minY, maxX, maxY] = ann.bbox;
  const cx = ((minX + maxX) / 2) * width;
  const cy = ((minY + maxY) / 2) * height;
  const r = markerSize || 10;

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
  const { pageNumber, mode } = useNavigation();
  const { publicId, isDemo } = useProject();
  const {
    tableParseStep, setTableParseStep, tableParseRegion, setTableParseRegion,
    tableParseColumnBBs, tableParseRowBBs, showParsedRegions,
  } = useTableParse();
  const {
    keynoteParseStep, keynoteParseRegion, keynoteColumnBBs, keynoteRowBBs,
    setKeynoteYoloClass,
  } = useKeynoteParse();
  const {
    yoloTags, activeYoloTagId, setActiveYoloTagId, setYoloTagFilter,
    yoloTagVisibility, yoloTagPickingMode, setYoloTagPickingMode,
  } = useYoloTags();
  const {
    symbolSearchActive, symbolSearchResults, symbolSearchConfidence, dismissedSymbolMatches,
  } = useSymbolSearch();

  const annotations = useViewerStore((s) => s.annotations);
  const addAnnotation = useViewerStore((s) => s.addAnnotation);
  const removeAnnotation = useViewerStore((s) => s.removeAnnotation);
  const updateAnnotation = useViewerStore((s) => s.updateAnnotation);
  const keynotes = useViewerStore((s) => s.keynotes);
  const setKeynoteFilter = useViewerStore((s) => s.setKeynoteFilter);

  // Drawing state lives in Zustand store — AnnotationOverlay does NOT subscribe.
  // Use getState() for reads in event handlers. DrawingPreviewLayer subscribes independently.
  const setDrawing = useViewerStore((s) => s._setDrawing);
  const setDrawStart = useViewerStore((s) => s._setDrawStart);
  const setDrawEnd = useViewerStore((s) => s._setDrawEnd);
  const setMousePos = useViewerStore((s) => s._setMousePos);
  const rafRef = useRef<number>(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Markup name+notes modal state
  const [pendingMarkup, setPendingMarkup] = useState<[number, number, number, number] | null>(null);
  const [markupName, setMarkupName] = useState("");
  const [markupNote, setMarkupNote] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const showDetections = useViewerStore((s) => s.showDetections);
  const confidenceThreshold = useViewerStore((s) => s.confidenceThreshold);
  const activeModels = useViewerStore((s) => s.activeModels);
  const confidenceThresholds = useViewerStore((s) => s.confidenceThresholds);
  const activeAnnotationFilter = useViewerStore((s) => s.activeAnnotationFilter);
  const activeCsiFilter = useViewerStore((s) => s.activeCsiFilter);
  const setAnnotationFilter = useViewerStore((s) => s.setAnnotationFilter);
  const setTakeoffFilter = useViewerStore((s) => s.setTakeoffFilter);
  const textractData = useViewerStore((s) => s.textractData);
  const setSearch = useViewerStore((s) => s.setSearch);
  const searchQuery = useViewerStore((s) => s.searchQuery);
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
  const addYoloTag = useViewerStore((s) => s.addYoloTag);
  const showTableParsePanel = useViewerStore((s) => s.showTableParsePanel);
  const showKeynoteParsePanel = useViewerStore((s) => s.showKeynoteParsePanel);

  // During keynote Step 2 with Column A drawn: only show YOLO fully inside Column A
  const isKeynoteYoloPicking = keynoteParseStep === "define-column" && keynoteColumnBBs.length >= 1;
  const keynoteColA = keynoteColumnBBs.length >= 1 ? keynoteColumnBBs[0] : null;

  const hiddenAnnotationIds = useViewerStore((s) => s.hiddenAnnotationIds);

  const pageAnnotations = useMemo(() => annotations.filter((a) => {
    if (a.pageNumber !== pageNumber) return false;
    // Individual annotation visibility toggle
    if (hiddenAnnotationIds.has(a.id)) return false;
    // Filter YOLO annotations by toggle, per-model active state, and per-model confidence
    if (a.source === "yolo") {
      // During keynote YOLO picking: ONLY show annotations fully inside Column A
      if (isKeynoteYoloPicking && keynoteColA) {
        const [aMinX, aMinY, aMaxX, aMaxY] = a.bbox;
        const fullyInside = aMinX >= keynoteColA[0] && aMaxX <= keynoteColA[2]
          && aMinY >= keynoteColA[1] && aMaxY <= keynoteColA[3];
        if (!fullyInside) return false;
        return true; // skip other YOLO filters during picking mode
      }
      if (!showDetections) return false;
      const modelName = (a as any).data?.modelName as string | undefined;
      if (modelName && activeModels[modelName] === false) return false;
      const conf = (a as any).threshold || (a as any).data?.confidence || 0;
      const threshold = (modelName && confidenceThresholds[modelName] != null)
        ? confidenceThresholds[modelName]
        : confidenceThreshold;
      if (conf < threshold) return false;
      // Filter by CSI code when CSI filter is active — only show YOLO annotations matching the division
      if (activeCsiFilter) {
        const annCsi = ((a as any).data?.csiCodes as string[] | undefined) || [];
        const filterDiv = activeCsiFilter.substring(0, 2).replace(/\s/g, "");
        const matches = annCsi.some(c => c.substring(0, 2).replace(/\s/g, "") === filterDiv);
        if (!matches) return false;
      }
    }
    // Takeoff markers are always visible
    if (a.source === "takeoff") return true;
    if (a.source === "takeoff-scale") return false;
    // When CSI filter active, only show user markups that have matching CSI tags
    if (activeCsiFilter && a.source === "user") {
      const annCsi = ((a as any).data?.csiCodes as string[] | undefined) || [];
      if (annCsi.length === 0) return false;
      const filterDiv = activeCsiFilter.substring(0, 2).replace(/\s/g, "");
      if (!annCsi.some(c => c.substring(0, 2).replace(/\s/g, "") === filterDiv)) return false;
    }
    // Filter by active annotation label
    if (activeAnnotationFilter && a.name !== activeAnnotationFilter) return false;
    return true;
  }), [annotations, pageNumber, showDetections, activeModels, confidenceThresholds, confidenceThreshold, activeCsiFilter, activeAnnotationFilter, isKeynoteYoloPicking, keynoteColA, hiddenAnnotationIds]);

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

    // ─── YOLO Tag highlighting: compute which annotations are tag instances on this page ───
    const activeTag = activeYoloTagId ? yoloTags.find((t) => t.id === activeYoloTagId) : null;
    const activeTagAnnIds = new Set<number>();
    if (activeTag) {
      for (const inst of activeTag.instances) {
        if (inst.pageNumber === pageNumber) activeTagAnnIds.add(inst.annotationId);
      }
    }
    // Visible tags: collect all visible tag instances on this page (only if explicitly toggled on)
    const visibleTagInstances: { bbox: [number, number, number, number]; color: string; name: string }[] = [];
    for (const tag of yoloTags) {
      if (tag.id === activeYoloTagId) continue; // active tag drawn separately
      if (yoloTagVisibility[tag.id] === false) continue; // hidden if explicitly toggled off
      for (const inst of tag.instances) {
        if (inst.pageNumber === pageNumber) {
          visibleTagInstances.push({ bbox: inst.bbox, color: tag.color || "#22d3ee", name: tag.tagText });
        }
      }
    }

    // Draw existing annotations
    for (const ann of pageAnnotations) {
      // Count markers: draw shape instead of rectangle
      if (ann.source === "takeoff" && (ann.data as any)?.type === "count-marker") {
        const itemId = (ann.data as any)?.takeoffItemId;
        const item = takeoffItems.find((t) => t.id === itemId || String(t.id) === String(itemId));
        drawCountMarker(ctx, ann, width, height, ann.id === selectedId, item?.size);
        continue;
      }

      const color = labelColor(ann.name);
      const [minX, minY, maxX, maxY] = ann.bbox;
      const x = minX * width;
      const y = minY * height;
      const w = (maxX - minX) * width;
      const h = (maxY - minY) * height;

      // If an active tag is set, dim non-matching annotations
      // Also dim all annotations when symbol search results are showing
      const isTagMatch = activeTag && activeTagAnnIds.has(ann.id);
      const dimmed = (activeTag && !isTagMatch) || (symbolSearchResults !== null);

      if (isTagMatch) {
        // Bright highlight for active tag instances
        ctx.strokeStyle = activeTag.color || "#22d3ee";
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = (activeTag.color || "#22d3ee") + "30";
        ctx.fillRect(x, y, w, h);
      } else {
        ctx.globalAlpha = dimmed ? 0.25 : 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = ann.id === selectedId ? 3 : 2;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = color + "15";
        ctx.fillRect(x, y, w, h);
      }

      // Label
      const fontSize = Math.max(10, Math.min(13, h * 0.3));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const labelText = ann.name;
      const textW = ctx.measureText(labelText).width;
      const isSelected = ann.id === selectedId;

      // Label background + text
      const isUserSource = ann.source === "user";
      const extraW = isSelected ? (isUserSource ? 36 : 20) : 6;
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(x, y - fontSize - 4, textW + extraW, fontSize + 4);
      ctx.fillStyle = color;
      ctx.fillText(labelText, x + 3, y - 4);

      // Selected: show edit pencil (user markups) + delete "x" + corner resize handles
      if (isSelected) {
        let iconX = x + textW + 8;
        if (isUserSource) {
          ctx.fillStyle = "#60a5fa"; // blue pencil
          ctx.font = `${fontSize}px sans-serif`;
          ctx.fillText("\u270E", iconX, y - 4);
          iconX += 16;
        }
        ctx.fillStyle = "#ff4444";
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillText("x", iconX, y - 4);

        // Corner handles
        const hs = 6;
        ctx.fillStyle = color;
        ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
        ctx.fillRect(x + w - hs / 2, y - hs / 2, hs, hs);
        ctx.fillRect(x - hs / 2, y + h - hs / 2, hs, hs);
        ctx.fillRect(x + w - hs / 2, y + h - hs / 2, hs, hs);
      }

      // Tag name label for active tag match
      if (isTagMatch && activeTag) {
        const tagLabel = activeTag.name || activeTag.tagText;
        ctx.globalAlpha = 1;
        ctx.font = "bold 11px sans-serif";
        const tlw = ctx.measureText(tagLabel).width;
        ctx.fillStyle = (activeTag.color || "#22d3ee") + "dd";
        ctx.fillRect(x, y + h + 1, tlw + 6, 14);
        ctx.fillStyle = "#000";
        ctx.fillText(tagLabel, x + 3, y + h + 12);
      }

      ctx.globalAlpha = 1;
    }

    // ─── Draw free-floating active tag instances (annotationId = -1, not in annotation loop) ───
    if (activeTag) {
      for (const inst of activeTag.instances) {
        if (inst.pageNumber !== pageNumber || inst.annotationId !== -1) continue;
        const [bMinX, bMinY, bMaxX, bMaxY] = inst.bbox;
        const fx = bMinX * width;
        const fy = bMinY * height;
        const fw = (bMaxX - bMinX) * width;
        const fh = (bMaxY - bMinY) * height;
        ctx.strokeStyle = activeTag.color || "#22d3ee";
        ctx.lineWidth = 3;
        ctx.strokeRect(fx, fy, fw, fh);
        ctx.fillStyle = (activeTag.color || "#22d3ee") + "30";
        ctx.fillRect(fx, fy, fw, fh);
        // Label
        const tagLabel = activeTag.name || activeTag.tagText;
        ctx.font = "bold 11px sans-serif";
        const tlw = ctx.measureText(tagLabel).width;
        ctx.fillStyle = (activeTag.color || "#22d3ee") + "dd";
        ctx.fillRect(fx, fy + fh + 1, tlw + 6, 14);
        ctx.fillStyle = "#000";
        ctx.fillText(tagLabel, fx + 3, fy + fh + 12);
      }
    }

    // ─── Draw visible tag instances (not the active tag) ───
    for (const vi of visibleTagInstances) {
      const [bMinX, bMinY, bMaxX, bMaxY] = vi.bbox;
      const vx = bMinX * width;
      const vy = bMinY * height;
      const vw = (bMaxX - bMinX) * width;
      const vh = (bMaxY - bMinY) * height;
      ctx.strokeStyle = vi.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(vx, vy, vw, vh);
      ctx.setLineDash([]);
    }

    // Draw in-progress rectangle (markup or table parse or symbol search)
    // Drawing preview (BB rectangle, polygon, calibration) — rendered by DrawingPreviewLayer

    // Draw symbol search results on current page
    if (symbolSearchResults) {
      const pageMatches = symbolSearchResults.matches.filter(
        (m) => m.pageNumber === pageNumber
          && m.confidence >= symbolSearchConfidence
          && !dismissedSymbolMatches.has(m.id)
      );
      for (const match of pageMatches) {
        const [mx, my, mw, mh] = match.bbox;
        const px = mx * width;
        const py = my * height;
        const pw = mw * width;
        const ph = mh * height;

        // Bright cyan fill + border
        ctx.fillStyle = "rgba(34,211,238,0.15)";
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 2.5;
        ctx.setLineDash([]);
        ctx.strokeRect(px, py, pw, ph);

        // Confidence label
        ctx.font = "bold 10px sans-serif";
        ctx.fillStyle = "#22d3ee";
        const confLabel = `${Math.round(match.confidence * 100)}%`;
        ctx.fillText(confLabel, px + 2, py - 3);
      }
    }

    // Draw table parse region overlay (only when panel is open)
    // Parse region overlays (table/keynote BBs) — rendered by ParseRegionLayer

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

    // Calibration + polygon preview — rendered by DrawingPreviewLayer
  }, [pageAnnotations, width, height, selectedId, activeYoloTagId, yoloTags, yoloTagVisibility, pageNumber, symbolSearchActive, symbolSearchResults, symbolSearchConfidence, dismissedSymbolMatches]);

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

      // ─── Drawing/picking modes: must come BEFORE pointer block ─────
      // The pointer block always returns, so these would be unreachable after it.

      // Keynote YOLO picking: click a YOLO annotation to assign its class
      if (isKeynoteYoloPicking) {
        const clickNormX = pos.x / width;
        const clickNormY = pos.y / height;
        for (const ann of pageAnnotations) {
          if (ann.source !== "yolo") continue;
          const [aMinX, aMinY, aMaxX, aMaxY] = ann.bbox;
          if (clickNormX >= aMinX && clickNormX <= aMaxX && clickNormY >= aMinY && clickNormY <= aMaxY) {
            e.stopPropagation();
            const model = (ann as any).data?.modelName || "unknown";
            setKeynoteYoloClass({ model, className: ann.name });
            return;
          }
        }
        // If click didn't hit a YOLO annotation, fall through to drawing mode
      }

      // YOLO Tag picking
      if (yoloTagPickingMode) {
        const clickNormX = pos.x / width;
        const clickNormY = pos.y / height;
        for (const ann of pageAnnotations) {
          if (ann.source !== "yolo") continue;
          const [aMinX, aMinY, aMaxX, aMaxY] = ann.bbox;
          if (clickNormX >= aMinX && clickNormX <= aMaxX && clickNormY >= aMinY && clickNormY <= aMaxY) {
            e.stopPropagation();
            const ocrText = getOcrTextInAnnotation(ann, textractData);
            if (!ocrText) {
              setYoloTagPickingMode(false);
              return;
            }
            const model = (ann as any).data?.modelName as string || "unknown";
            const tagName = prompt(`Create tag from "${ocrText}"?\n\nEnter display name:`, ocrText);
            if (!tagName) { setYoloTagPickingMode(false); return; }
            const instances = mapYoloToOcrText({
              tagText: ocrText,
              yoloClass: ann.name,
              yoloModel: model,
              scope: "project",
              annotations: useViewerStore.getState().annotations,
              textractData,
            });
            const newTag = {
              id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name: tagName,
              tagText: ocrText,
              yoloClass: ann.name,
              yoloModel: model,
              source: "manual" as const,
              scope: "project" as const,
              instances,
            };
            addYoloTag(newTag);
            setActiveYoloTagId(newTag.id);
            setYoloTagFilter(newTag.id);
            setYoloTagPickingMode(false);
            return;
          }
        }
        setYoloTagPickingMode(false);
        return;
      }

      // Symbol search draw mode
      if (symbolSearchActive) {
        e.stopPropagation();
        setSelectedId(null);
        setDrawing(true);
        setDrawStart(pos);
        setDrawEnd(pos);
        return;
      }

      // Table or keynote parse drawing mode
      if (tableParseStep === "select-region" || tableParseStep === "define-column" || tableParseStep === "define-row"
          || keynoteParseStep === "select-region" || keynoteParseStep === "define-column" || keynoteParseStep === "define-row") {
        e.stopPropagation();
        setSelectedId(null);
        setDrawing(true);
        setDrawStart(pos);
        setDrawEnd(pos);
        return;
      }

      // Pointer mode: select, delete, move, resize annotations + click keynotes
      if (mode === "pointer") {
        // Double-click: universal annotation filter — filter pages + search + highlights
        if (e.detail === 2) {
          for (const ann of pageAnnotations) {
            // Hit test — check area polygons with point-in-polygon, others with bbox
            let hit = false;
            if (ann.source === "takeoff" && (ann.data as any)?.type === "area-polygon") {
              const data = ann.data as unknown as AreaPolygonData;
              hit = pointInPolygon({ x: pos.x / width, y: pos.y / height }, data.vertices);
            } else {
              const [minX, minY, maxX, maxY] = ann.bbox;
              const ax = minX * width, ay = minY * height;
              hit = pos.x >= ax && pos.x <= ax + (maxX - minX) * width && pos.y >= ay && pos.y <= ay + (maxY - minY) * height;
            }
            if (!hit) continue;
            e.stopPropagation();

            const store = useViewerStore.getState();
            const isToggleOff = searchQuery.toLowerCase() === ann.name.toLowerCase();

            if (ann.source === "user") {
              // User markup: filter + open TextPanel → Markups tab
              if (isToggleOff) {
                setSearch(""); setAnnotationFilter(null);
                store.setActiveMarkupId(null);
              } else {
                setSearch(ann.name); setAnnotationFilter(ann.name);
                store.setActiveMarkupId(ann.id);
                store.setTextPanelTab("markups");
                if (!store.showTextPanel) store.toggleTextPanel();
              }
            } else if (ann.source === "takeoff") {
              // QTO marker: filter by takeoff item
              const itemId = (ann.data as any)?.takeoffItemId;
              const item = takeoffItems.find((t) => t.id === itemId);
              const itemName = item?.name || ann.name;
              if (isToggleOff || searchQuery.toLowerCase() === itemName.toLowerCase()) {
                setSearch(""); setTakeoffFilter(null);
              } else {
                setSearch(itemName); setTakeoffFilter(itemId);
              }
            } else {
              // YOLO or other: annotation name filter
              if (isToggleOff) {
                setSearch(""); setAnnotationFilter(null);
              } else {
                setSearch(ann.name); setAnnotationFilter(ann.name);
              }
            }
            return;
          }
          // No annotation hit — try OCR word fallback
          const pageWords = textractData[pageNumber]?.words;
          if (pageWords) {
            const normX = pos.x / width;
            const normY = pos.y / height;
            for (const word of pageWords) {
              const [left, top, w, h] = word.bbox;
              if (normX >= left && normX <= left + w && normY >= top && normY <= top + h) {
                if (e.shiftKey && searchQuery) {
                  // Shift+double-click: append word to search (multi-word selection)
                  const existing = searchQuery.toLowerCase().split(/\s+/);
                  const newWord = word.text.toLowerCase();
                  if (existing.includes(newWord)) {
                    // Remove word if already in search
                    const filtered = existing.filter((w) => w !== newWord);
                    setSearch(filtered.join(" "));
                  } else {
                    setSearch(searchQuery + " " + word.text);
                  }
                } else if (searchQuery.toLowerCase() === word.text.toLowerCase()) {
                  setSearch("");
                } else {
                  setSearch(word.text);
                }
                e.stopPropagation();
                return;
              }
            }
          }
          return;
        }

        // If an annotation is already selected, check corners for resize
        if (selectedId !== null) {
          const selAnn = pageAnnotations.find((a) => a.id === selectedId);
          if (selAnn) {
            const [minX, minY, maxX, maxY] = selAnn.bbox;
            const corners = {
              tl: { x: minX * width, y: minY * height },
              tr: { x: maxX * width, y: minY * height },
              bl: { x: minX * width, y: maxY * height },
              br: { x: maxX * width, y: maxY * height },
            };

            // Check if clicking a corner handle for resize
            for (const [key, corner] of Object.entries(corners)) {
              if (Math.abs(pos.x - corner.x) < HANDLE && Math.abs(pos.y - corner.y) < HANDLE) {
                e.stopPropagation();
                setResizeCorner(key);
                setDragging(true);
                return;
              }
            }

            // Check label bar area for pencil (edit) or x (delete) click
            const ax = minX * width;
            const ay = minY * height;
            if (pos.y >= ay - 18 && pos.y <= ay && pos.x >= ax) {
              const fontSize = Math.max(10, Math.min(13, (maxY - minY) * height * 0.3));
              const tempCanvas = canvasRef.current;
              const tempCtx = tempCanvas?.getContext("2d");
              if (tempCtx) {
                tempCtx.font = `bold ${fontSize}px sans-serif`;
                const textW = tempCtx.measureText(selAnn.name).width;
                const iconStart = ax + textW + 8;
                const isUserSource = selAnn.source === "user";

                if (isUserSource && pos.x >= iconStart && pos.x < iconStart + 16) {
                  // Pencil icon clicked — edit markup
                  e.stopPropagation();
                  setPendingMarkup(selAnn.bbox as [number, number, number, number]);
                  setMarkupName(selAnn.name);
                  setMarkupNote(selAnn.note || "");
                  setEditingAnnotationId(selAnn.id);
                  setTimeout(() => nameInputRef.current?.focus(), 50);
                  return;
                }
                const xStart = isUserSource ? iconStart + 16 : iconStart;
                if (pos.x >= xStart) {
                  // Delete "x" clicked
                  e.stopPropagation();
                  deleteSelected();
                  return;
                }
              }
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
        // Check annotations (bbox-based) — select and start drag
        for (const ann of pageAnnotations) {
          const [minX, minY, maxX, maxY] = ann.bbox;
          const ax = minX * width;
          const ay = minY * height;
          const aw = (maxX - minX) * width;
          const ah = (maxY - minY) * height;
          if (pos.x >= ax && pos.x <= ax + aw && pos.y >= ay && pos.y <= ay + ah) {
            e.stopPropagation();
            setSelectedId(ann.id);
            setSearch(ann.name);
            // If this YOLO annotation matches a known tag, activate it
            if (ann.source === "yolo") {
              const matchingTag = yoloTags.find((t) =>
                t.instances.some((inst) => inst.annotationId === ann.id && inst.pageNumber === pageNumber)
              );
              if (matchingTag) {
                setActiveYoloTagId(matchingTag.id);
                setYoloTagFilter(matchingTag.id);
              }
            }
            setDragging(true);
            setResizeCorner(null);
            setDragOffset({ x: pos.x - ax, y: pos.y - ay });
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
            if (keynote.text) setSearch(keynote.text);
            return;
          }
        }
        // Clicked empty space — deselect
        setSelectedId(null);
        return;
      }

      // (Drawing/picking mode handlers moved before the pointer block above)

      // Markup mode: check corners for resize or label for delete on selected
      if (selectedId !== null && mode === "markup") {
        const selAnn = pageAnnotations.find((a) => a.id === selectedId);
        if (selAnn) {
          const [minX, minY, maxX, maxY] = selAnn.bbox;
          const corners = {
            tl: { x: minX * width, y: minY * height },
            tr: { x: maxX * width, y: minY * height },
            bl: { x: minX * width, y: maxY * height },
            br: { x: maxX * width, y: maxY * height },
          };

          for (const [key, corner] of Object.entries(corners)) {
            if (Math.abs(pos.x - corner.x) < HANDLE && Math.abs(pos.y - corner.y) < HANDLE) {
              e.stopPropagation();
              setResizeCorner(key);
              setDragging(true);
              return;
            }
          }

          const ax = minX * width;
          const ay = minY * height;
          if (pos.y >= ay - 18 && pos.y <= ay && pos.x >= ax) {
            e.stopPropagation();
            deleteSelected();
            return;
          }
        }
      }

      // Markup mode: check if clicking annotation to select
      if (mode === "markup") {
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
      }

      // Start drawing in markup mode
      if (mode !== "markup") return;
      e.stopPropagation();
      setSelectedId(null);
      setDrawing(true);
      setDrawStart(pos);
      setDrawEnd(pos);
    },
    [mode, pageAnnotations, pageKeynotes, width, height, getPos, selectedId, setKeynoteFilter, activeTakeoffItemId, takeoffItems, publicId, pageNumber, addAnnotation, updateAnnotation, calibrationMode, setCalibrationPoint, setCalibrationMode, polygonDrawingMode, setPolygonDrawingMode, addPolygonVertex, polygonVertices, savePolygon, isDemo, yoloTagPickingMode, textractData, yoloTags, addYoloTag, setActiveYoloTagId, setYoloTagFilter, setYoloTagPickingMode, symbolSearchActive, tableParseStep, keynoteParseStep]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Track cursor for polygon preview (throttled via rAF)
      if (polygonDrawingMode === "drawing") {
        const p = getPos(e);
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => setMousePos(p));
      }
      // Read drawing state from store (not subscribed — avoids parent re-render)
      if (useViewerStore.getState()._drawing) {
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
    [dragging, selectedId, dragOffset, resizeCorner, pageAnnotations, width, height, getPos, updateAnnotation, polygonDrawingMode, setDrawEnd, setMousePos]
  );

  const handleMouseUp = useCallback(async () => {
    // Save dragged/resized position
    if (dragging && selectedId !== null) {
      setDragging(false);
      setResizeCorner(null);
      saveDragPosition();
      return;
    }

    // Read drawing state from store (not subscribed)
    const { _drawing, _drawStart, _drawEnd } = useViewerStore.getState();
    if (!_drawing) return;
    setDrawing(false);

    const minX = Math.min(_drawStart.x, _drawEnd.x) / width;
    const minY = Math.min(_drawStart.y, _drawEnd.y) / height;
    const maxX = Math.max(_drawStart.x, _drawEnd.x) / width;
    const maxY = Math.max(_drawStart.y, _drawEnd.y) / height;

    // Minimum size check
    if (Math.abs(maxX - minX) < 0.01 || Math.abs(maxY - minY) < 0.01) return;

    // Symbol search: capture template BB and trigger search API
    if (symbolSearchActive) {
      const store = useViewerStore.getState();
      store.setSymbolSearchActive(false);
      store.setSymbolSearchLoading(true);
      store.setSymbolSearchError(null);
      store.setSymbolSearchTemplateBbox([minX, minY, maxX, maxY]);
      store.setSymbolSearchSourcePage(pageNumber);

      // Fire the search API (async, non-blocking)
      (async () => {
        try {
          const resp = await fetch("/api/symbol-search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: store.projectId,
              sourcePageNumber: pageNumber,
              templateBbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
              confidenceThreshold: store.symbolSearchConfidence,
            }),
          });

          if (!resp.ok || !resp.body) {
            const errorText = resp.ok ? "No response body" : await resp.text().catch(() => `HTTP ${resp.status}`);
            throw new Error(errorText);
          }

          // Read NDJSON stream
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                if (msg.type === "progress") {
                  useViewerStore.getState().setSymbolSearchProgress({
                    page: msg.page,
                    pageIndex: msg.pageIndex,
                    totalPages: msg.totalPages,
                    matches: msg.matches,
                  });
                } else if (msg.type === "done") {
                  useViewerStore.getState().setSymbolSearchResults({
                    templateBbox: msg.templateBbox,
                    sourcePageNumber: msg.sourcePageNumber,
                    totalMatches: msg.totalMatches,
                    pagesWithMatches: msg.pagesWithMatches,
                    matches: msg.matches,
                    searchedAt: msg.searchedAt,
                  });
                }
              } catch { /* skip malformed lines */ }
            }
          }
        } catch (err) {
          console.error("[SYMBOL_SEARCH] Failed:", err);
          useViewerStore.getState().setSymbolSearchError(
            err instanceof Error ? err.message : "Symbol search failed"
          );
        } finally {
          useViewerStore.getState().setSymbolSearchLoading(false);
          useViewerStore.getState().setSymbolSearchProgress(null);
        }
      })();
      return;
    }

    // Table parse: finalize BB as region or column
    if (tableParseStep === "select-region") {
      setTableParseRegion([minX, minY, maxX, maxY]);
      useViewerStore.getState().setTableParseStep("idle");
      // Auto-parse is triggered by the panel watching tableParseRegion
      return;
    }
    if (tableParseStep === "define-column") {
      useViewerStore.getState().addTableParseColumnBB([minX, minY, maxX, maxY]);
      return;
    }
    if (tableParseStep === "define-row") {
      useViewerStore.getState().addTableParseRowBB([minX, minY, maxX, maxY]);
      return;
    }

    // Keynote parse BBs
    if (keynoteParseStep === "select-region") {
      useViewerStore.getState().setKeynoteParseRegion([minX, minY, maxX, maxY]);
      useViewerStore.getState().setKeynoteParseStep("idle");
      return;
    }
    if (keynoteParseStep === "define-column") {
      useViewerStore.getState().addKeynoteColumnBB([minX, minY, maxX, maxY]);
      return;
    }
    if (keynoteParseStep === "define-row") {
      useViewerStore.getState().addKeynoteRowBB([minX, minY, maxX, maxY]);
      return;
    }

    // Show markup dialog instead of prompt()
    setPendingMarkup([minX, minY, maxX, maxY]);
    setMarkupName("");
    setMarkupNote("");
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, [dragging, selectedId, saveDragPosition, width, height, publicId, pageNumber, addAnnotation, updateAnnotation, isDemo, tableParseStep, keynoteParseStep, symbolSearchActive, setTableParseRegion, setDrawing]);

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

  // Cancel in-progress drawing modes on page change, deselect
  useEffect(() => {
    setSelectedId(null);
    if (polygonDrawingMode === "drawing") {
      resetPolygonDrawing();
      setMousePos(null);
    }
    if (calibrationMode !== "idle") {
      resetCalibration();
    }
    // Reset table/keynote parse drawing state on page change
    const store = useViewerStore.getState();
    if (store.tableParseStep !== "idle") {
      store.resetTableParse();
      store.setMode("move");
    }
    if (store.keynoteParseStep !== "idle") {
      store.resetKeynoteParse();
      store.setKeynoteParseRegion(null);
      store.setMode("move");
    }
    if (store.symbolSearchActive) {
      store.setSymbolSearchActive(false);
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

  // Save markup from dialog (handles both create and edit)
  const saveMarkup = useCallback(() => {
    if (!pendingMarkup || !markupName.trim()) return;
    const [minX, minY, maxX, maxY] = pendingMarkup;
    const name = markupName.trim();
    const note = markupNote.trim() || null;

    if (editingAnnotationId !== null) {
      // Edit existing annotation
      updateAnnotation(editingAnnotationId, { name, note });
      if (!isDemo) {
        fetch(`/api/annotations/${editingAnnotationId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, note }),
        }).catch(() => {});
      }
    } else {
      // Create new annotation
      const tempId = -Date.now();
      addAnnotation({
        id: tempId,
        pageNumber,
        name,
        bbox: [minX, minY, maxX, maxY],
        note,
        source: "user",
      });

      if (!isDemo) {
        fetch("/api/annotations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: publicId,
            pageNumber,
            name,
            note,
            bbox: [minX, minY, maxX, maxY],
          }),
        })
          .then((res) => res.ok ? res.json() : null)
          .then((saved) => {
            if (saved) updateAnnotation(tempId, { id: saved.id });
          })
          .catch(() => {});
      }
    }

    setPendingMarkup(null);
    setMarkupName("");
    setMarkupNote("");
    setEditingAnnotationId(null);
  }, [pendingMarkup, markupName, markupNote, editingAnnotationId, pageNumber, publicId, addAnnotation, updateAnnotation, isDemo]);

  // Always render — annotations should be visible in all modes
  if (pageAnnotations.length === 0 && activeTakeoffItemId === null && calibrationMode === "idle" && polygonDrawingMode === "idle" && mode !== "markup" && mode !== "pointer" && !pendingMarkup) return null;

  return (
    <>
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
          if (useViewerStore.getState()._drawing) setDrawing(false);
        }}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: `${width}px`,
          height: `${height}px`,
          pointerEvents: activeTakeoffItemId !== null || calibrationMode !== "idle" || polygonDrawingMode === "drawing" || mode === "markup" || mode === "pointer" || tableParseStep !== "idle" || keynoteParseStep !== "idle" || symbolSearchActive ? "auto" : "none",
          transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
          transformOrigin: "top left",
          cursor: symbolSearchActive ? "crosshair" : calibrationMode !== "idle" ? "crosshair" : polygonDrawingMode === "drawing" ? "crosshair" : activeTakeoffItemId !== null ? "crosshair" : mode === "markup" ? "crosshair" : isKeynoteYoloPicking ? "pointer" : yoloTagPickingMode ? "pointer" : (tableParseStep !== "idle" || keynoteParseStep !== "idle") ? "crosshair" : mode === "pointer" ? "default" : "default",
        }}
      />

      {/* Drawing preview layer — reads drawing state from store independently */}
      <DrawingPreviewLayer
        width={width}
        height={height}
        cssScale={cssScale}
      />

      {/* Markup name + notes dialog */}
      {pendingMarkup && (
        <MarkupDialog
          isEditing={!!editingAnnotationId}
          name={markupName}
          note={markupNote}
          onNameChange={setMarkupName}
          onNoteChange={setMarkupNote}
          onSave={saveMarkup}
          onCancel={() => { setPendingMarkup(null); setEditingAnnotationId(null); }}
        />
      )}
    </>
  );
}
