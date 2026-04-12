"use client";

import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
import { useViewerStore, useNavigation, useProject, useTableParse, useKeynoteParse, useYoloTags, useSymbolSearch, useAnnotationFilters } from "@/stores/viewerStore";
import { TWENTY_COLORS, AREA_UNIT_MAP } from "@/types";
import type { ClientAnnotation, CountMarkerData, TakeoffShape, AreaPolygonData, LinearPolylineData } from "@/types";
import { polygonCentroid, pointInPolygon, computeRealArea, computePolylineLength, computePixelsPerUnit } from "@/lib/areaCalc";
import { splitPolygonByLine, findSplittablePolygons } from "@/lib/polygon-split";
import { getOcrTextInAnnotation, mapYoloToOcrText } from "@/lib/yolo-tag-engine";
import { clientBucketFill, findPageCanvas } from "@/lib/bucket-fill-client";
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
  markerSize?: number,
  cssScale?: number
) {
  const data = ann.data as unknown as CountMarkerData;
  if (!data?.color || !data?.shape) return;

  const [minX, minY, maxX, maxY] = ann.bbox;
  const cx = ((minX + maxX) / 2) * width;
  const cy = ((minY + maxY) / 2) * height;
  // Divide by cssScale so markers stay constant screen-size regardless of zoom
  const r = (markerSize || 10) / (cssScale || 1);

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
    ctx.arc(cx, cy, r + 4 / (cssScale || 1), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export default memo(function AnnotationOverlay({
  width,
  height,
  cssScale,
}: AnnotationOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { pageNumber, mode } = useNavigation();
  const { projectId: projectDbId, publicId, isDemo } = useProject();
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

  const activeTableTagViews = useViewerStore((s) => s.activeTableTagViews);
  const llmHighlight = useViewerStore((s) => s.llmHighlight);
  const tableCellStructure = useViewerStore((s) => s.tableCellStructure);
  const showTableCellStructure = useViewerStore((s) => s.showTableCellStructure);
  const toggleCellHighlight = useViewerStore((s) => s.toggleCellHighlight);
  const annotations = useViewerStore((s) => s.annotations);
  const addAnnotation = useViewerStore((s) => s.addAnnotation);
  const removeAnnotation = useViewerStore((s) => s.removeAnnotation);
  const updateAnnotation = useViewerStore((s) => s.updateAnnotation);
  const addTakeoffItem = useViewerStore((s) => s.addTakeoffItem);
  const keynotes = useViewerStore((s) => s.keynotes);
  const setKeynoteFilter = useViewerStore((s) => s.setKeynoteFilter);

  // Drawing state lives in Zustand store — AnnotationOverlay does NOT subscribe.
  // Use getState() for reads AND writes in event handlers. DrawingPreviewLayer subscribes independently.
  const { _setDrawing: setDrawing, _setDrawStart: setDrawStart, _setDrawEnd: setDrawEnd, _setMousePos: setMousePos } = useViewerStore.getState();
  const rafRef = useRef<number>(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragBboxRef = useRef<[number, number, number, number] | null>(null);

  // Markup name+notes modal state
  const [pendingMarkup, setPendingMarkup] = useState<[number, number, number, number] | null>(null);
  const [markupName, setMarkupName] = useState("");
  const [markupNote, setMarkupNote] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const {
    showDetections, confidenceThreshold, activeModels, hiddenClasses,
    confidenceThresholds, activeAnnotationFilter, activeCsiFilter, hiddenAnnotationIds,
  } = useAnnotationFilters();
  const setAnnotationFilter = useViewerStore((s) => s.setAnnotationFilter);
  const setTakeoffFilter = useViewerStore((s) => s.setTakeoffFilter);
  const setSearch = useViewerStore((s) => s.setSearch);
  const activeTakeoffItemId = useViewerStore((s) => s.activeTakeoffItemId);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const hiddenTakeoffItemIds = useViewerStore((s) => s.hiddenTakeoffItemIds);
  const setActiveTakeoffItemId = useViewerStore((s) => s.setActiveTakeoffItemId);
  const calibrationMode = useViewerStore((s) => s.calibrationMode);
  const setCalibrationMode = useViewerStore((s) => s.setCalibrationMode);
  const setCalibrationPoint = useViewerStore((s) => s.setCalibrationPoint);
  const resetCalibration = useViewerStore((s) => s.resetCalibration);
  const scaleCalibrations = useViewerStore((s) => s.scaleCalibrations);
  const polygonDrawingMode = useViewerStore((s) => s.polygonDrawingMode);
  const setPolygonDrawingMode = useViewerStore((s) => s.setPolygonDrawingMode);
  const polygonVertices = useViewerStore((s) => s.polygonVertices);
  const addPolygonVertex = useViewerStore((s) => s.addPolygonVertex);
  const resetPolygonDrawing = useViewerStore((s) => s.resetPolygonDrawing);
  const undoLastVertex = useViewerStore((s) => s.undoLastVertex);
  const bucketFillActive = useViewerStore((s) => s.bucketFillActive);
  const bucketFillPreview = useViewerStore((s) => s.bucketFillPreview);
  const bucketFillLoading = useViewerStore((s) => s.bucketFillLoading);
  const setBucketFillPreview = useViewerStore((s) => s.setBucketFillPreview);
  const setBucketFillLoading = useViewerStore((s) => s.setBucketFillLoading);
  const setBucketFillError = useViewerStore((s) => s.setBucketFillError);
  const bucketFillBarrierMode = useViewerStore((s) => s.bucketFillBarrierMode);
  const addBucketFillBarrier = useViewerStore((s) => s.addBucketFillBarrier);
  const setBucketFillActive = useViewerStore((s) => s.setBucketFillActive);
  const splitAreaActive = useViewerStore((s) => s.splitAreaActive);
  const setSplitAreaActive = useViewerStore((s) => s.setSplitAreaActive);
  const splitLineA = useViewerStore((s) => s.splitLineA);
  const splitLineB = useViewerStore((s) => s.splitLineB);
  const setSplitLineEndpoint = useViewerStore((s) => s.setSplitLineEndpoint);
  const splitPreview = useViewerStore((s) => s.splitPreview);
  const setSplitPreview = useViewerStore((s) => s.setSplitPreview);
  const setSplitError = useViewerStore((s) => s.setSplitError);
  const showTakeoffPanel = useViewerStore((s) => s.showTakeoffPanel);
  const tempPanMode = useViewerStore((s) => s.tempPanMode);
  const addYoloTag = useViewerStore((s) => s.addYoloTag);

  // During keynote Step 2 with Column A drawn: only show YOLO fully inside Column A
  const isKeynoteYoloPicking = keynoteParseStep === "define-column" && keynoteColumnBBs.length >= 1;
  const keynoteColA = keynoteColumnBBs.length >= 1 ? keynoteColumnBBs[0] : null;

  const pageAnnotationsRef = useRef<ClientAnnotation[]>([]);
  const pageAnnotations = useMemo(() => {
    const filtered = annotations.filter((a) => {
      if (a.pageNumber !== pageNumber) return false;
      // Individual annotation visibility toggle
      if (hiddenAnnotationIds.has(a.id)) return false;
      // During split mode: only show area polygons
      if (splitAreaActive) {
        if (a.source !== "takeoff") return false;
        const d = a.data as any;
        return d?.type === "area-polygon";
      }
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
        // Per-class visibility
        if (modelName && hiddenClasses[`${modelName}:${a.name}`] === false) return false;
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
    });
    // Return same reference if filtered content unchanged — prevents canvas redraw
    // when annotations change on OTHER pages
    const prev = pageAnnotationsRef.current;
    if (filtered.length === prev.length && filtered.every((a, i) => a === prev[i])) {
      return prev;
    }
    pageAnnotationsRef.current = filtered;
    return filtered;
  }, [annotations, pageNumber, showDetections, activeModels, hiddenClasses, confidenceThresholds, confidenceThreshold, activeCsiFilter, activeAnnotationFilter, isKeynoteYoloPicking, keynoteColA, hiddenAnnotationIds, splitAreaActive]);

  const pageKeynotes = keynotes[pageNumber] || [];

  // Pre-indexed tag lookups: O(1) instead of yoloTags.find() in nested loops
  const tagTextIndex = useMemo(() => {
    const map = new Map<string, typeof yoloTags[0]>();
    for (const tag of yoloTags) map.set(`${tag.tagText}:${tag.source}`, tag);
    return map;
  }, [yoloTags]);

  // Pre-filtered tag instances by page: avoids inner-loop pageNumber check
  const pageTagInstances = useMemo(() => {
    const map = new Map<string, Array<{ bbox: [number, number, number, number]; annotationId: number }>>();
    for (const tag of yoloTags) {
      const filtered = tag.instances.filter((i) => i.pageNumber === pageNumber);
      if (filtered.length) map.set(tag.id, filtered);
    }
    return map;
  }, [yoloTags, pageNumber]);

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

    // Early exit: nothing to draw on this page
    if (pageAnnotations.length === 0 && !activeYoloTagId && pageTagInstances.size === 0
        && Object.keys(activeTableTagViews).length === 0
        && !symbolSearchResults && !llmHighlight) {
      return;
    }

    // ─── YOLO Tag highlighting: compute which annotations are tag instances on this page ───
    const activeTag = activeYoloTagId ? yoloTags.find((t) => t.id === activeYoloTagId) : null;
    const activeTagAnnIds = new Set<number>();
    if (activeTag) {
      const activeTagPageInsts = pageTagInstances.get(activeTag.id) || [];
      for (const inst of activeTagPageInsts) {
        activeTagAnnIds.add(inst.annotationId);
      }
    }
    // Visible tags: collect all visible tag instances on this page (only if explicitly toggled on)
    // When an active tag is selected, hide all other tags' dots so the selected tag is easy to spot
    const visibleTagInstances: { bbox: [number, number, number, number]; color: string; name: string }[] = [];
    if (!activeTag) {
      for (const tag of yoloTags) {
        if (tag.id === activeYoloTagId) continue; // active tag drawn separately
        if (yoloTagVisibility[tag.id] === false) continue; // hidden if explicitly toggled off
        const tagPageInsts = pageTagInstances.get(tag.id) || [];
        for (const inst of tagPageInsts) {
          visibleTagInstances.push({ bbox: inst.bbox, color: tag.color || "#22d3ee", name: tag.tagText });
        }
      }
    }

    // Draw existing annotations
    for (const ann of pageAnnotations) {
      // Count markers: draw shape instead of rectangle
      if (ann.source === "takeoff" && (ann.data as any)?.type === "count-marker") {
        const itemId = (ann.data as any)?.takeoffItemId;
        if (hiddenTakeoffItemIds.has(itemId)) continue;
        const items = useViewerStore.getState().takeoffItems;
        const item = items.find((t) => t.id === itemId || String(t.id) === String(itemId));
        drawCountMarker(ctx, ann, width, height, ann.id === selectedId, item?.size, cssScale);
        continue;
      }

      const color = labelColor(ann.name);
      const [minX, minY, maxX, maxY] = ann.bbox;
      const x = minX * width;
      const y = minY * height;
      const w = (maxX - minX) * width;
      const h = (maxY - minY) * height;

      // If an active tag is set, hide non-matching YOLO annotations entirely
      // so the selected tag is easy to spot. Non-YOLO annotations just dim.
      const isTagMatch = activeTag && activeTagAnnIds.has(ann.id);
      if (activeTag && ann.source === "yolo" && !isTagMatch) continue;
      const dimmed = (activeTag && !isTagMatch) || (symbolSearchResults !== null);

      if (isTagMatch) {
        // Bright magenta fill + tag color stroke for active tag instances
        ctx.fillStyle = "#ff00ff40"; // magenta at 25% opacity
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = activeTag.color || "#22d3ee";
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);
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
      const activeTagPageInsts = pageTagInstances.get(activeTag.id) || [];
      for (const inst of activeTagPageInsts) {
        if (inst.annotationId !== -1) continue;
        const [bMinX, bMinY, bMaxX, bMaxY] = inst.bbox;
        const fx = bMinX * width;
        const fy = bMinY * height;
        const fw = (bMaxX - bMinX) * width;
        const fh = (bMaxY - bMinY) * height;
        ctx.fillStyle = "#ff00ff40"; // magenta fill
        ctx.fillRect(fx, fy, fw, fh);
        ctx.strokeStyle = activeTag.color || "#22d3ee";
        ctx.lineWidth = 3;
        ctx.strokeRect(fx, fy, fw, fh);
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

    // Draw TATR cell structure overlays
    // TATR-OVERLAY: gated on showTableCellStructure (toggle in AutoParseTab),
    // bumped visual style — solid 1px borders + 5% cyan tint on every cell so
    // they're actually visible against a busy architectural drawing background.
    // Previous styling (dashed 0.3-opacity cyan) was effectively invisible.
    if (tableCellStructure && tableCellStructure.pageNumber === pageNumber && showTableCellStructure) {
      for (const cell of tableCellStructure.cells) {
        const [cx0, cy0, cx1, cy1] = cell.bbox;
        const cellX = cx0 * width;
        const cellY = cy0 * height;
        const cellW = (cx1 - cx0) * width;
        const cellH = (cy1 - cy0) * height;

        if (cell.highlighted) {
          // Highlighted: thick cyan with bright fill (user clicked)
          ctx.fillStyle = "rgba(34,211,238,0.25)";
          ctx.fillRect(cellX, cellY, cellW, cellH);
          ctx.strokeStyle = "#22d3ee";
          ctx.lineWidth = 2.5;
        } else if (cell.type === "column-header" || cell.type === "row-header") {
          // Header cells: violet tint
          ctx.fillStyle = "rgba(168,85,247,0.15)";
          ctx.fillRect(cellX, cellY, cellW, cellH);
          ctx.strokeStyle = "rgba(168,85,247,0.7)";
          ctx.lineWidth = 1.25;
        } else {
          // Data cells: subtle cyan tint + visible solid border
          ctx.fillStyle = "rgba(34,211,238,0.05)";
          ctx.fillRect(cellX, cellY, cellW, cellH);
          ctx.strokeStyle = "rgba(34,211,238,0.7)";
          ctx.lineWidth = 1;
        }
        ctx.strokeRect(cellX, cellY, cellW, cellH);
      }
    }

    // Draw LLM tool use highlight (pulsing dashed cyan rectangle)
    if (llmHighlight && llmHighlight.pageNumber === pageNumber) {
      const [hMinX, hMinY, hMaxX, hMaxY] = llmHighlight.bbox;
      const hx = hMinX * width, hy = hMinY * height;
      const hw = (hMaxX - hMinX) * width, hh = (hMaxY - hMinY) * height;
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(hx, hy, hw, hh);
      ctx.setLineDash([]);
      ctx.fillStyle = "#22d3ee20";
      ctx.fillRect(hx, hy, hw, hh);
      if (llmHighlight.label) {
        ctx.font = "bold 12px sans-serif";
        const tw = ctx.measureText(llmHighlight.label).width;
        ctx.fillStyle = "#22d3eedd";
        ctx.fillRect(hx, hy - 18, tw + 8, 16);
        ctx.fillStyle = "#000";
        ctx.fillText(llmHighlight.label, hx + 4, hy - 5);
      }
    }

    // ─── Table/Keynote tag views (eye icon toggle) ───
    if (Object.keys(activeTableTagViews).length > 0) {
      const tableTagViews = activeTableTagViews;
      for (const view of Object.values(tableTagViews)) {
      // 1. Blue translucent highlight over the table/keynote region (on the region's page)
      if (view.pageNum === pageNumber) {
        const [bMinX, bMinY, bMaxX, bMaxY] = view.bbox;
        const bx = bMinX * width, by = bMinY * height;
        const bw = (bMaxX - bMinX) * width, bh = (bMaxY - bMinY) * height;
        ctx.fillStyle = "rgba(59, 130, 246, 0.08)";
        ctx.strokeStyle = "rgba(59, 130, 246, 0.3)";
        ctx.lineWidth = 1.5;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);
      }
      // 2. Magenta padded highlights for each mapped tag instance on this page
      const pad = 3; // padding in canvas pixels
      for (const tagText of view.tagTexts) {
        const matchingTag = tagTextIndex.get(`${tagText}:${view.source}`);
        if (!matchingTag) continue;
        const tagPageInsts = pageTagInstances.get(matchingTag.id) || [];
        for (const inst of tagPageInsts) {
          const [iMinX, iMinY, iMaxX, iMaxY] = inst.bbox;
          const ix = iMinX * width - pad, iy = iMinY * height - pad;
          const iw = (iMaxX - iMinX) * width + pad * 2, ih = (iMaxY - iMinY) * height + pad * 2;
          ctx.fillStyle = "#ff00ff25";
          ctx.strokeStyle = "#ff00ff";
          ctx.lineWidth = 1.5;
          ctx.fillRect(ix, iy, iw, ih);
          ctx.strokeRect(ix, iy, iw, ih);
          // Tag text label below the instance
          ctx.font = "bold 9px sans-serif";
          const label = tagText;
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = "#ff00ffcc";
          ctx.fillRect(ix, iy + ih + 1, tw + 6, 12);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, ix + 3, iy + ih + 10);
        }
      }
    }
    } // end activeTableTagViews guard

    // Draw completed area polygons
    for (const ann of pageAnnotations) {
      if (ann.source !== "takeoff" || (ann.data as any)?.type !== "area-polygon") continue;
      const data = ann.data as unknown as AreaPolygonData;
      if (hiddenTakeoffItemIds.has(data.takeoffItemId)) continue;
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

    // Draw completed linear polylines
    for (const ann of pageAnnotations) {
      if (ann.source !== "takeoff" || (ann.data as any)?.type !== "linear-polyline") continue;
      const data = ann.data as unknown as LinearPolylineData;
      if (hiddenTakeoffItemIds.has(data.takeoffItemId)) continue;
      if (!data.vertices || data.vertices.length < 2) continue;

      ctx.save();
      // Stroke connected line segments (no fill, no closePath)
      ctx.strokeStyle = data.color;
      ctx.lineWidth = ann.id === selectedId ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(data.vertices[0].x * width, data.vertices[0].y * height);
      for (let i = 1; i < data.vertices.length; i++) {
        ctx.lineTo(data.vertices[i].x * width, data.vertices[i].y * height);
      }
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

      // Total length label at last vertex
      const lastV = data.vertices[data.vertices.length - 1];
      const lx = lastV.x * width;
      const ly = lastV.y * height;
      const labelText = data.totalLength > 0
        ? `${data.totalLength.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${data.unit}`
        : `-- ${data.unit}`;
      ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(labelText).width;
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(lx + 6, ly - 7, tw + 8, 16);
      ctx.fillStyle = data.color;
      ctx.fillText(labelText, lx + 10, ly + 5);
      ctx.restore();
    }

    // Calibration + polygon preview — rendered by DrawingPreviewLayer
  }, [pageAnnotations, width, height, selectedId, activeYoloTagId, yoloTags, yoloTagVisibility, pageNumber, symbolSearchResults, symbolSearchConfidence, dismissedSymbolMatches, activeTableTagViews, llmHighlight, hiddenTakeoffItemIds, tableCellStructure, showTableCellStructure]);

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

  /** Prepare bucket fill preview for item assignment (doesn't create annotation yet) */
  const prepareBucketFillPolygon = useCallback(() => {
    const preview = useViewerStore.getState().bucketFillPreview;
    if (!preview || preview.vertices.length < 3) return;

    const verts = preview.vertices;
    const xs = verts.map((v) => v.x);
    const ys = verts.map((v) => v.y);
    const bbox: [number, number, number, number] = [
      Math.min(...xs), Math.min(...ys),
      Math.max(...xs), Math.max(...ys),
    ];

    const calibration = scaleCalibrations[pageNumber];
    let areaSqUnits = 0;
    let unit: import("@/types").AreaUnitSq = "SF";
    if (calibration) {
      areaSqUnits = computeRealArea(verts, width, height, calibration);
      unit = AREA_UNIT_MAP[calibration.unit] || "SF";
    }

    useViewerStore.getState().setBucketFillPendingPolygon({
      vertices: [...verts],
      method: preview.method,
      bbox,
      areaSqUnits,
      unit,
    });
    setBucketFillPreview(null);
  }, [scaleCalibrations, pageNumber, width, height, setBucketFillPreview]);

  /** Accept a pending Split Area preview: both halves stay under same takeoff item. */
  const acceptSplit = useCallback(() => {
    const preview = useViewerStore.getState().splitPreview;
    if (!preview) return;

    const currentAnnotations = useViewerStore.getState().annotations;
    const currentItems = useViewerStore.getState().takeoffItems;
    const target = currentAnnotations.find((a) => a.id === preview.targetAnnotationId);
    if (!target) {
      useViewerStore.getState().setSplitPreview(null);
      useViewerStore.getState().setSplitLineEndpoint("a", null as unknown as { x: number; y: number });
      return;
    }
    const parentItem = currentItems.find((t) => t.id === (target.data as AreaPolygonData).takeoffItemId);
    if (!parentItem) {
      useViewerStore.getState().setSplitPreview(null);
      return;
    }

    const calibration = scaleCalibrations[pageNumber];
    const computeData = (verts: { x: number; y: number }[], itemId: number) => {
      const xs = verts.map((v) => v.x);
      const ys = verts.map((v) => v.y);
      const bbox: [number, number, number, number] = [
        Math.min(...xs), Math.min(...ys),
        Math.max(...xs), Math.max(...ys),
      ];
      let areaSqUnits = 0;
      let unit: import("@/types").AreaUnitSq = "SF";
      if (calibration) {
        areaSqUnits = computeRealArea(verts, width, height, calibration);
        unit = AREA_UNIT_MAP[calibration.unit] || "SF";
      }
      const data: AreaPolygonData = {
        type: "area-polygon",
        takeoffItemId: itemId,
        color: parentItem.color,
        vertices: [...verts],
        areaSqUnits,
        unit,
      };
      return { data, bbox };
    };

    // Both halves stay under the SAME takeoff item — no new item creation.
    const leftResult = computeData(preview.left, parentItem.id);
    const rightResult = computeData(preview.right, parentItem.id);

    // 1. Create right-half annotation FIRST (safe ordering — if anything fails, original is intact)
    const tempAnnId = -Date.now() - 1;
    addAnnotation({
      id: tempAnnId,
      pageNumber,
      name: parentItem.name,
      bbox: rightResult.bbox,
      note: null,
      source: "takeoff",
      data: rightResult.data as unknown as Record<string, unknown>,
    });

    // 2. Update original annotation to left half
    updateAnnotation(target.id, {
      bbox: leftResult.bbox,
      data: leftResult.data as unknown as Record<string, unknown>,
    });

    // 3. Persist both to server (fire-and-forget with logging)
    if (!isDemo && target.id > 0) {
      fetch(`/api/annotations/${target.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox: leftResult.bbox, data: leftResult.data }),
      }).catch((err) => console.error("Failed to persist left-half annotation:", err));
    }

    if (!isDemo) {
      fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          pageNumber,
          name: parentItem.name,
          bbox: rightResult.bbox,
          source: "takeoff",
          data: rightResult.data,
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((saved) => { if (saved) updateAnnotation(tempAnnId, { id: saved.id }); })
        .catch((err) => console.error("Failed to persist right-half annotation:", err));
    }

    // 4. Stay in split mode — clear preview + line, ready for next split. Escape exits.
    const store = useViewerStore.getState();
    store.setSplitPreview(null);
    store.setSplitLineEndpoint("a", null);
    store.setSplitLineEndpoint("b", null);
  }, [scaleCalibrations, pageNumber, width, height, publicId, addAnnotation, updateAnnotation, isDemo]);

  /** Save the current in-progress polyline as a linear-polyline annotation */
  const saveLinearPolyline = useCallback(() => {
    const verts = useViewerStore.getState().polygonVertices;
    const items = useViewerStore.getState().takeoffItems;
    const activeId = useViewerStore.getState().activeTakeoffItemId;
    if (verts.length < 2) return;

    const activeItem = items.find((t) => t.id === activeId);
    if (!activeItem) return;

    // Compute bounding box from vertices
    const xs = verts.map((v) => v.x);
    const ys = verts.map((v) => v.y);
    const bbox: [number, number, number, number] = [
      Math.min(...xs), Math.min(...ys),
      Math.max(...xs), Math.max(...ys),
    ];

    // Compute length if calibrated
    const cal = scaleCalibrations[pageNumber];
    let length = { total: 0, segments: [] as number[] };
    if (cal) {
      const ppu = computePixelsPerUnit(cal.point1, cal.point2, width, height, cal.realDistance);
      length = computePolylineLength(verts, width, height, ppu);
    }

    const polylineData: LinearPolylineData = {
      type: "linear-polyline",
      takeoffItemId: activeItem.id,
      color: activeItem.color,
      vertices: [...verts],
      totalLength: length.total,
      unit: cal?.unit || "ft",
      segmentLengths: length.segments,
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
      data: polylineData as unknown as Record<string, unknown>,
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
          data: polylineData,
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

      // Split Area mode — 2-click auto-detect (line A, line B → auto-find polygon)
      if (splitAreaActive) {
        e.stopPropagation();
        const normX = pos.x / width;
        const normY = pos.y / height;

        if (splitPreview) return; // preview showing — commit via Accept/Cancel buttons

        if (!splitLineA) {
          setSplitLineEndpoint("a", { x: normX, y: normY });
          return;
        }

        // Second click: set B and immediately auto-detect which polygon to split
        const pointB = { x: normX, y: normY };
        setSplitLineEndpoint("b", pointB);

        const polyAnnotations = pageAnnotations.filter(
          (a) => a.source === "takeoff" && (a.data as AreaPolygonData)?.type === "area-polygon"
        );
        const candidates = findSplittablePolygons(
          splitLineA,
          pointB,
          polyAnnotations.map((a) => ({ id: a.id, vertices: (a.data as AreaPolygonData).vertices }))
        );

        if (candidates.length === 0) {
          setSplitError("Line does not cross any area polygon in exactly 2 places");
          setTimeout(() => setSplitError(null), 3500);
          return;
        }

        // Longest chord wins (most overlap = intended target)
        const best = candidates[0];
        const hitAnn = polyAnnotations.find((a) => a.id === best.id)!;
        setSplitPreview({
          targetAnnotationId: best.id,
          original: (hitAnn.data as AreaPolygonData).vertices,
          left: best.left,
          right: best.right,
          lineA: splitLineA,
          lineB: pointB,
        });
        return;
      }

      // Bucket fill mode — independent of item selection
      const bfState = useViewerStore.getState();
      if (bfState.bucketFillActive) {
        e.stopPropagation();
        const normX = pos.x / width;
        const normY = pos.y / height;

        if (bfState.bucketFillBarrierMode) {
          const pending = bfState.barrierPendingPoint;
          if (pending) {
            addBucketFillBarrier({ x1: pending.x, y1: pending.y, x2: normX, y2: normY });
            bfState.setBarrierPendingPoint(null);
          } else {
            bfState.setBarrierPendingPoint({ x: normX, y: normY });
          }
          return;
        }

        if (bfState.bucketFillLoading) return;
        if (bfState.bucketFillPreview || bfState.bucketFillPendingPolygon) return; // preview/dialog showing
        setBucketFillLoading(true);
        setBucketFillPreview(null);

        const existingPolygons = bfState.annotations
          .filter((a: any) => a.pageNumber === pageNumber && a.source === "takeoff"
            && a.data?.type === "area-polygon" && a.data?.vertices?.length >= 3)
          .map((a: any) => ({ vertices: a.data.vertices }));

        const handleFillSuccess = (data: { vertices: { x: number; y: number }[]; method: string }) => {
          useViewerStore.setState({
            bucketFillLoading: false,
            bucketFillPreview: { vertices: data.vertices, method: data.method },
          });
        };

        const serverFallback = () => {
          fetch("/api/bucket-fill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: projectDbId,
              pageNumber,
              seedPoint: { x: normX, y: normY },
              tolerance: bfState.bucketFillTolerance,
              dilate: bfState.bucketFillDilatePx,
              barriers: bfState.bucketFillBarriers,
              polygonBarriers: existingPolygons,
            }),
          })
            .then(async (res) => {
              if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err?.error || `HTTP ${res.status}`); }
              return res.json();
            })
            .then((data) => {
              if (data?.type === "result" && data.vertices?.length >= 3) {
                handleFillSuccess({ vertices: data.vertices, method: data.method || "server-raster" });
              } else if (data?.type === "error") {
                useViewerStore.getState().setBucketFillLoading(false);
                useViewerStore.getState().setBucketFillError(data.error || "Bucket fill failed");
                setTimeout(() => useViewerStore.getState().setBucketFillError(null), 4000);
              } else {
                useViewerStore.getState().setBucketFillLoading(false);
              }
            })
            .catch((err) => {
              useViewerStore.getState().setBucketFillLoading(false);
              useViewerStore.getState().setBucketFillError(err?.message || "Bucket fill failed");
              setTimeout(() => useViewerStore.getState().setBucketFillError(null), 4000);
            });
        };

        // Try client-side WebWorker first, fall back to server
        const pageCanvas = findPageCanvas();
        if (pageCanvas) {
          clientBucketFill(pageCanvas, { x: normX, y: normY }, {
            tolerance: bfState.bucketFillTolerance,
            dilation: bfState.bucketFillDilatePx,
            barriers: bfState.bucketFillBarriers,
            polygonBarriers: existingPolygons,
          })
            .then(handleFillSuccess)
            .catch(() => serverFallback());
        } else {
          serverFallback();
        }
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

        // Linear polyline drawing mode
        if (activeItem.shape === "linear") {
          const normX = pos.x / width;
          const normY = pos.y / height;

          if (polygonDrawingMode === "idle") {
            // Start new polyline
            setPolygonDrawingMode("drawing");
            addPolygonVertex({ x: normX, y: normY });
          } else if (polygonDrawingMode === "drawing") {
            // Finish line: click within 10px of last vertex
            if (polygonVertices.length >= 2) {
              const lastV = polygonVertices[polygonVertices.length - 1];
              const lastX = lastV.x * width;
              const lastY = lastV.y * height;
              const dist = Math.sqrt((pos.x - lastX) ** 2 + (pos.y - lastY) ** 2);
              if (dist < 10) {
                saveLinearPolyline();
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
            const model = (ann as any).data?.modelName as string || "unknown";
            const store = useViewerStore.getState();
            store.setYoloTagPickingMode(false);

            // Trigger class scan — fetch all unique texts inside this class
            const pid = store.publicId;
            fetch(`/api/projects/${pid}/map-tags-batch`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "scanClass", yoloClass: ann.name, yoloModel: model }),
            })
              .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
              .then(({ texts }) => {
                useViewerStore.getState().setTagScanResults({
                  yoloClass: ann.name,
                  yoloModel: model,
                  texts: texts || [],
                });
              })
              .catch((err) => console.error("[YOLO_TAG] Class scan failed:", err));
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
        // TATR cell click: single click = search by text, double click = toggle highlight.
        // Gated on showTableCellStructure so the user can disable cell-level
        // interaction without losing the underlying data.
        if (tableCellStructure && tableCellStructure.pageNumber === pageNumber && showTableCellStructure) {
          const normX = pos.x / width;
          const normY = pos.y / height;
          for (const cell of tableCellStructure.cells) {
            if (normX >= cell.bbox[0] && normX <= cell.bbox[2] && normY >= cell.bbox[1] && normY <= cell.bbox[3]) {
              if (e.detail === 2) {
                toggleCellHighlight(cell.row, cell.col);
              } else if (cell.text) {
                setSearch(cell.text);
              }
              return;
            }
          }
        }

        // Double-click: universal annotation filter — filter pages + search + highlights
        if (e.detail === 2) {
          for (const ann of pageAnnotations) {
            // Hit test — check area polygons with point-in-polygon, linear polylines with point-near-line, others with bbox
            let hit = false;
            if (ann.source === "takeoff" && (ann.data as any)?.type === "area-polygon") {
              const data = ann.data as unknown as AreaPolygonData;
              hit = pointInPolygon({ x: pos.x / width, y: pos.y / height }, data.vertices);
            } else if (ann.source === "takeoff" && (ann.data as any)?.type === "linear-polyline") {
              const data = ann.data as unknown as LinearPolylineData;
              for (let i = 0; i < data.vertices.length - 1; i++) {
                const ax2 = data.vertices[i].x * width, ay2 = data.vertices[i].y * height;
                const bx2 = data.vertices[i + 1].x * width, by2 = data.vertices[i + 1].y * height;
                const dx2 = bx2 - ax2, dy2 = by2 - ay2;
                const lenSq2 = dx2 * dx2 + dy2 * dy2;
                const t2 = lenSq2 === 0 ? 0 : Math.max(0, Math.min(1, ((pos.x - ax2) * dx2 + (pos.y - ay2) * dy2) / lenSq2));
                const dist2 = Math.sqrt((pos.x - (ax2 + t2 * dx2)) ** 2 + (pos.y - (ay2 + t2 * dy2)) ** 2);
                if (dist2 < 8) { hit = true; break; }
              }
            } else {
              const [minX, minY, maxX, maxY] = ann.bbox;
              const ax = minX * width, ay = minY * height;
              hit = pos.x >= ax && pos.x <= ax + (maxX - minX) * width && pos.y >= ay && pos.y <= ay + (maxY - minY) * height;
            }
            if (!hit) continue;
            e.stopPropagation();

            const store = useViewerStore.getState();
            const currentSearch = store.searchQuery;
            const isToggleOff = currentSearch.toLowerCase() === ann.name.toLowerCase();

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
              if (isToggleOff || currentSearch.toLowerCase() === itemName.toLowerCase()) {
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
          // No annotation hit — try parsed table region hit-test
          const pIntel = useViewerStore.getState().pageIntelligence[pageNumber] as any;
          if (pIntel?.parsedRegions) {
            const nrmX = pos.x / width;
            const nrmY = pos.y / height;
            for (const region of pIntel.parsedRegions) {
              if (!region.bbox || region.type !== "schedule") continue;
              const [rMinX, rMinY, rMaxX, rMaxY] = region.bbox;
              if (nrmX >= rMinX && nrmX <= rMaxX && nrmY >= rMinY && nrmY <= rMaxY) {
                e.stopPropagation();
                const st = useViewerStore.getState();
                if (!st.showTableParsePanel) st.toggleTableParsePanel();
                st.setTableParseTab("all");
                st.setFocusedParsedRegionId(region.id);
                return;
              }
            }
          }

          // No parsed region hit — try OCR word fallback
          const pageWords = useViewerStore.getState().textractData[pageNumber]?.words;
          if (pageWords) {
            const normX = pos.x / width;
            const normY = pos.y / height;
            for (const word of pageWords) {
              const [left, top, w, h] = word.bbox;
              if (normX >= left && normX <= left + w && normY >= top && normY <= top + h) {
                const sq = useViewerStore.getState().searchQuery;
                if (e.shiftKey && sq) {
                  // Shift+double-click: append word to search (multi-word selection)
                  const existing = sq.toLowerCase().split(/\s+/);
                  const newWord = word.text.toLowerCase();
                  if (existing.includes(newWord)) {
                    // Remove word if already in search
                    const filtered = existing.filter((w) => w !== newWord);
                    setSearch(filtered.join(" "));
                  } else {
                    setSearch(sq + " " + word.text);
                  }
                } else if (sq.toLowerCase() === word.text.toLowerCase()) {
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
        // Check linear polylines (point-near-line test)
        for (const ann of pageAnnotations) {
          if (ann.source !== "takeoff" || (ann.data as any)?.type !== "linear-polyline") continue;
          const data = ann.data as unknown as LinearPolylineData;
          const threshold = 8; // pixels
          let hit = false;
          for (let i = 0; i < data.vertices.length - 1; i++) {
            const ax = data.vertices[i].x * width;
            const ay = data.vertices[i].y * height;
            const bx = data.vertices[i + 1].x * width;
            const by = data.vertices[i + 1].y * height;
            // Point-to-segment distance
            const dx = bx - ax, dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            let t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((pos.x - ax) * dx + (pos.y - ay) * dy) / lenSq));
            const projX = ax + t * dx, projY = ay + t * dy;
            const dist = Math.sqrt((pos.x - projX) ** 2 + (pos.y - projY) ** 2);
            if (dist < threshold) { hit = true; break; }
          }
          if (hit) {
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

      // Start drawing in markup mode or tag-adding mode
      if (mode !== "markup" && !useViewerStore.getState().tagAddingMode) return;
      e.stopPropagation();
      setSelectedId(null);
      setDrawing(true);
      setDrawStart(pos);
      setDrawEnd(pos);
    },
    [mode, pageAnnotations, pageKeynotes, width, height, getPos, selectedId, setKeynoteFilter, activeTakeoffItemId, takeoffItems, publicId, projectDbId, pageNumber, addAnnotation, updateAnnotation, calibrationMode, setCalibrationPoint, setCalibrationMode, polygonDrawingMode, setPolygonDrawingMode, addPolygonVertex, polygonVertices, savePolygon, saveLinearPolyline, isDemo, yoloTagPickingMode, yoloTags, addYoloTag, setActiveYoloTagId, setYoloTagFilter, setYoloTagPickingMode, symbolSearchActive, tableParseStep, keynoteParseStep, setBucketFillError, splitAreaActive, splitLineA, splitPreview, setSplitLineEndpoint, setSplitPreview, setSplitError]
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

        let newBbox: [number, number, number, number];
        if (resizeCorner) {
          // Resize from corner
          const px = pos.x / width;
          const py = pos.y / height;
          newBbox = [minX, minY, maxX, maxY];
          if (resizeCorner === "tl") newBbox = [px, py, maxX, maxY];
          if (resizeCorner === "tr") newBbox = [minX, py, px, maxY];
          if (resizeCorner === "bl") newBbox = [px, minY, maxX, py];
          if (resizeCorner === "br") newBbox = [minX, minY, px, py];
          newBbox = [
            Math.max(0, Math.min(newBbox[0], newBbox[2] - 0.01)),
            Math.max(0, Math.min(newBbox[1], newBbox[3] - 0.01)),
            Math.min(1, Math.max(newBbox[2], newBbox[0] + 0.01)),
            Math.min(1, Math.max(newBbox[3], newBbox[1] + 0.01)),
          ];
        } else {
          // Move entire annotation
          const w = maxX - minX;
          const h = maxY - minY;
          const newMinX = (pos.x - dragOffset.x) / width;
          const newMinY = (pos.y - dragOffset.y) / height;
          newBbox = [
            Math.max(0, Math.min(newMinX, 1 - w)),
            Math.max(0, Math.min(newMinY, 1 - h)),
            Math.max(0, Math.min(newMinX + w, 1)),
            Math.max(0, Math.min(newMinY + h, 1)),
          ];
        }
        // Throttle store updates to screen refresh rate via rAF
        dragBboxRef.current = newBbox;
        cancelAnimationFrame(rafRef.current);
        const id = selectedId;
        rafRef.current = requestAnimationFrame(() => {
          if (dragBboxRef.current) updateAnnotation(id, { bbox: dragBboxRef.current });
        });
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

    // Symbol search: capture template BB — don't auto-fire, let panel show config first
    if (symbolSearchActive) {
      const store = useViewerStore.getState();
      store.setSymbolSearchActive(false);
      store.setSymbolSearchTemplateBbox([minX, minY, maxX, maxY]);
      store.setSymbolSearchSourcePage(pageNumber);
      return;
    }

    // Table parse: finalize BB as region or column
    if (tableParseStep === "select-region") {
      setTableParseRegion([minX, minY, maxX, maxY]);
      useViewerStore.getState().setTableParseStep("idle");
      useViewerStore.getState().setMode("move");
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
      useViewerStore.getState().setMode("move");
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

    // Tag adding mode: drawn BB becomes a new instance of the active tag
    const tagAddingId = useViewerStore.getState().tagAddingMode;
    if (tagAddingId) {
      const store = useViewerStore.getState();
      const tag = store.yoloTags.find((t) => t.id === tagAddingId);
      if (tag) {
        const newInstance = {
          pageNumber,
          annotationId: -1, // user-drawn, not a real YOLO annotation
          bbox: [minX, minY, maxX, maxY] as [number, number, number, number],
          confidence: 1.0,
        };
        store.updateYoloTag(tagAddingId, {
          instances: [...tag.instances, newInstance],
        });
      }
      store.setTagAddingMode(null);
      return;
    }

    // Show markup dialog instead of prompt()
    setPendingMarkup([minX, minY, maxX, maxY]);
    setMarkupName("");
    setMarkupNote("");
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, [dragging, selectedId, saveDragPosition, width, height, publicId, pageNumber, addAnnotation, updateAnnotation, isDemo, tableParseStep, keynoteParseStep, symbolSearchActive, setTableParseRegion, setDrawing]);

  const handleDoubleClick = useCallback(() => {
    // Close polygon or linear polyline on double-click
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

      // Determine whether active item is linear or polygon
      const store = useViewerStore.getState();
      const activeItem = store.takeoffItems.find((t) => t.id === store.activeTakeoffItemId);
      const isLinear = activeItem?.shape === "linear";

      const finalVerts = store.polygonVertices;
      if (isLinear) {
        if (finalVerts.length >= 2) {
          saveLinearPolyline();
        }
      } else {
        if (finalVerts.length >= 3) {
          savePolygon();
        }
      }
      return;
    }

    // Existing: finalize dragged annotation
    if (dragging && selectedId !== null) {
      setDragging(false);
      setResizeCorner(null);
      saveDragPosition();
    }
  }, [polygonDrawingMode, savePolygon, saveLinearPolyline, undoLastVertex, dragging, selectedId, saveDragPosition]);

  // Escape key: cancel polygon/calibration/deactivate takeoff
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        const store = useViewerStore.getState();
        if (store.splitPreview) {
          // Discard split preview, stay in split mode (line endpoints preserved)
          store.setSplitPreview(null);
        } else if (store.splitAreaActive) {
          // Exit split area mode entirely
          store.setSplitAreaActive(false);
        } else if (store.bucketFillPendingPolygon) {
          // Dismiss item assignment dialog
          store.setBucketFillPendingPolygon(null);
        } else if (store.bucketFillPreview) {
          // Cancel bucket fill preview
          store.setBucketFillPreview(null);
        } else if (store.bucketFillBarrierMode) {
          // Exit barrier mode back to fill mode
          store.setBucketFillBarrierMode(false);
          store.setBarrierPendingPoint(null);
        } else if (store.bucketFillActive) {
          // Deactivate bucket fill entirely
          store.setBucketFillActive(false);
        } else if (store.tableParseStep !== "idle") {
          store.setTableParseStep("idle");
          store.setMode("move");
        } else if (store.keynoteParseStep !== "idle") {
          store.setKeynoteParseStep("idle");
          store.setMode("move");
        } else if (polygonDrawingMode === "drawing") {
          resetPolygonDrawing();
          setMousePos(null);
        } else if (calibrationMode !== "idle") {
          resetCalibration();
        } else if (activeTakeoffItemId !== null) {
          setActiveTakeoffItemId(null);
        }
      }
      // Enter: accept bucket fill preview OR split preview OR close polygon/finish polyline
      if (e.key === "Enter") {
        const store = useViewerStore.getState();
        if (store.splitPreview) {
          e.preventDefault();
          acceptSplit();
        } else if (store.bucketFillPreview) {
          e.preventDefault();
          prepareBucketFillPolygon();
        } else if (polygonDrawingMode === "drawing") {
          e.preventDefault();
          const verts = store.polygonVertices;
          const activeItem = store.takeoffItems.find((t) => t.id === store.activeTakeoffItemId);
          if (activeItem?.shape === "linear") {
            if (verts.length >= 2) saveLinearPolyline();
          } else {
            if (verts.length >= 3) savePolygon();
          }
        }
      }
      // B: toggle barrier mode (when bucket fill is active)
      if (e.key === "b" || e.key === "B") {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        const store = useViewerStore.getState();
        if (store.bucketFillActive && !store.bucketFillPreview) {
          e.preventDefault();
          store.setBucketFillBarrierMode(!store.bucketFillBarrierMode);
        }
      }
      // Ctrl+Z: undo last barrier (in barrier mode) or last polygon vertex
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        const store = useViewerStore.getState();
        if (store.bucketFillActive && store.bucketFillBarriers.length > 0) {
          e.preventDefault();
          store.undoLastBarrier();
        } else if (polygonDrawingMode === "drawing") {
          e.preventDefault();
          undoLastVertex();
        }
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [activeTakeoffItemId, setActiveTakeoffItemId, polygonDrawingMode, resetPolygonDrawing, calibrationMode, resetCalibration, undoLastVertex, savePolygon, saveLinearPolyline, prepareBucketFillPolygon, acceptSplit]);

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
          pointerEvents: tempPanMode ? "none" : (activeTakeoffItemId !== null || bucketFillActive || calibrationMode !== "idle" || polygonDrawingMode === "drawing" || mode === "markup" || mode === "pointer" || tableParseStep !== "idle" || keynoteParseStep !== "idle" || symbolSearchActive || splitAreaActive ? "auto" : "none"),
          transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
          transformOrigin: "top left",
          willChange: "transform",
          cursor: splitAreaActive ? "crosshair" : bucketFillActive && bucketFillLoading ? "wait" : bucketFillActive && bucketFillBarrierMode ? "crosshair" : bucketFillActive ? "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24'><path d='M6 6 L18 6 L16 20 L8 20 Z' fill='%2322d3ee' stroke='%23ffffff' stroke-width='1.5' stroke-linejoin='round'/><path d='M6 6 Q12 1 18 6' fill='none' stroke='%2322d3ee' stroke-width='2' stroke-linecap='round'/><circle cx='12' cy='22' r='1' fill='%23ffffff'/></svg>\") 14 24, crosshair" : symbolSearchActive ? "crosshair" : calibrationMode !== "idle" ? "crosshair" : polygonDrawingMode === "drawing" ? "crosshair" : activeTakeoffItemId !== null ? "crosshair" : mode === "markup" ? "crosshair" : isKeynoteYoloPicking ? "pointer" : yoloTagPickingMode ? "pointer" : (tableParseStep !== "idle" || keynoteParseStep !== "idle") ? "crosshair" : mode === "pointer" ? "default" : "default",
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
})
