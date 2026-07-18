"use client";

import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
// [refactor jul10 P2.2④] takeoff items: zustand → TanStack cache. This SACRED file gets (a) the
// useTakeoffItems hook (data only) replacing the raw selector, and (b) readTakeoffItems(qc,
// publicId) — a SYNCHRONOUS live-cache read — replacing the 7 handler/effect-time
// getState().takeoffItems reads. The draw effect's dep array deliberately EXCLUDES takeoffItems
// (item edits do not redraw the canvas today); the bridge preserves that — do NOT add the hook
// value or a dep there (TAKEOFF_IMPL/SPEC.md §3.3 :372 row).
import { useQueryClient } from "@tanstack/react-query";
import { useTakeoffItems, readTakeoffItems } from "@/queries/useTakeoff";
import { enrichMarkupEditFromResponse, isCurrentMarkupEdit, publishMarkupEdit, readAnnotations, retireMarkupEdit, rollbackMarkupEdit, useAnnotations } from "@/queries/useAnnotations";
import { readTextractForPage } from "@/queries/textractCache";
import {
  readPageIntelligence,
  useKeynotesForPage,
} from "@/queries/usePageWindow";
import {
  readYoloTags,
  useYoloTagActions,
  useYoloTagsForPage,
} from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import {
  publishSettledPolygonReset,
  publishSettledSymbolSearchDeactivate,
  useToolStore,
} from "@/stores/toolStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useUiStore, useAnnotationFiltersUi } from "@/stores/uiStore";
import {
  acceptKeynoteParseRegion,
  acceptNotesParseRegion,
  acceptSpecParseRegion,
  acceptTableParseRegion,
  addKeynoteColumnForUser,
  addKeynoteRowForUser,
  addGuidedNotesColumnForUser,
  addGuidedNotesRowForUser,
  addTableParseColumnForUser,
  addTableParseRowForUser,
  focusParsedTableRegionInCatalog,
  setKeynoteParseStepWithTool,
  setNotesParseStepWithTool,
  setSpecParseStepWithTool,
  setTableParseStepWithTool,
} from "@/stores/viewerCommands";
import { useProject, useSessionStore } from "@/stores/sessionStore";
import { TWENTY_COLORS, AREA_UNIT_MAP } from "@/types";
import type { ClientAnnotation, CountMarkerData, TakeoffShape, AreaPolygonData, LinearPolylineData } from "@/types";
import type { ScoredMatch } from "@/lib/tag-mapping";
import { requestMapTagsBatch } from "@/lib/client-map-tags";
import { captureCanvasGestureLease, matchesCanvasGestureLease, selectActiveToolKey, type CanvasGestureLease, type CanvasGestureSnapshot } from "@/lib/active-tool-state";
import {
  cancelToolTailExact,
  claimLatestToolOperation,
  claimToolTailAuthority,
  consumeToolTailAuthority,
  invalidateLatestToolOperation,
  invalidateToolTailAuthority,
  ownsLatestToolOperation,
  ownsToolTailAuthority,
  registerToolTailCancellation,
  releaseToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { polygonCentroid, computeRealArea, computePolylineLength, computePixelsPerUnit } from "@/lib/areaCalc";
// [refactor jul15 P3.1½] hit-test predicates extracted to the pure geometry leaf; math unchanged.
import { pointInPolygonWithHoles, pointNearPolyline, pointInNormalizedBbox, pointInHandle } from "./hitTest";
import { splitPolygonByLine, findSplittablePolygons } from "@/lib/polygon-split";
import { getOcrTextInAnnotation, mapYoloToOcrText } from "@/lib/yolo-tag-engine";
import { clientBucketFill, findPageCanvas } from "@/lib/bucket-fill-client";
import { persistFetch, canPersist , apiErrorMessage } from "@/lib/client-persist";
import DrawingPreviewLayer from "./DrawingPreviewLayer";
import MarkupDialog from "./MarkupDialog";
import { TOOL_STORE_CAPABILITIES } from "./tools/capabilities";
import { dispatchToolMouseDown, TOOLS } from "./tools/registry";
import { useMultiSelectInteraction } from "@/hooks/useMultiSelectInteraction";
import { useProjectLifecycleGuard } from "@/hooks/useProjectLifecycleGuard";
import { useAnnotationDragMachine } from "./useAnnotationDragMachine";

interface AnnotationOverlayProps {
  width: number;
  height: number;
  cssScale: number;
}

/** Assign colors by unique label order — each unique label gets next color in palette */
const labelColorMap = new Map<string, string>();
const EMPTY_KEYNOTE_COLUMN_BBS: [number, number, number, number][] = [];
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

function readCanvasGestureSnapshot(): CanvasGestureSnapshot {
  const tool = useToolStore.getState();
  const parse = useParseFlowStore.getState();
  return {
    activeTool: tool.activeTool,
    mode: tool.mode,
    parseSteps: {
      table: parse.tableParseStep,
      keynote: parse.keynoteParseStep,
      notes: parse.notesParseStep,
      spec: parse.specParseStep,
    },
    publicId: useSessionStore.getState().publicId,
    pageNumber: useViewerCoreStore.getState().pageNumber,
  };
}

export default memo(function AnnotationOverlay({
  width,
  height,
  cssScale,
}: AnnotationOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingLeaseRef = useRef<CanvasGestureLease<object> | null>(null);
  // scanClass writes project-agnostic tool preview state, so controller identity is its request
  // token. A newer scan or project lifecycle invalidates the old completion without subscribing
  // this sacred canvas to any additional store field.
  const tagScanControllerRef = useRef<AbortController | null>(null);
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);
  const mode = useToolStore((s) => s.mode);
  const activeToolKey = useToolStore(selectActiveToolKey);
  const { projectId: projectDbId, publicId, isDemo } = useProject();
  const canAdoptProjectLifecycle = useProjectLifecycleGuard(publicId, isDemo);
  const bucketFillErrorRevisionRef = useRef(0);
  const splitErrorRevisionRef = useRef(0);
  useEffect(() => {
    // A same-id generation change does not necessarily change this component's publicId prop.
    // The render-bound guard identity is therefore the exact retirement signal for request and
    // delayed-error ownership.
    bucketFillErrorRevisionRef.current += 1;
    splitErrorRevisionRef.current += 1;
    return () => {
      const controller = tagScanControllerRef.current;
      tagScanControllerRef.current = null;
      controller?.abort();
    };
  }, [canAdoptProjectLifecycle]);
  const publishTransientBucketFillError = useCallback((message: string) => {
    if (!canAdoptProjectLifecycle()) return;
    const revision = ++bucketFillErrorRevisionRef.current;
    useToolStore.getState().setBucketFillError(message);
    setTimeout(() => {
      const tool = useToolStore.getState();
      if (
        bucketFillErrorRevisionRef.current !== revision ||
        tool.bucketFillError !== message ||
        !canAdoptProjectLifecycle()
      ) return;
      bucketFillErrorRevisionRef.current += 1;
      tool.setBucketFillError(null);
    }, 5000);
  }, [canAdoptProjectLifecycle]);
  const publishTransientSplitError = useCallback((message: string, delay = 5000) => {
    if (!canAdoptProjectLifecycle()) return;
    const revision = ++splitErrorRevisionRef.current;
    useToolStore.getState().setSplitError(message);
    setTimeout(() => {
      const tool = useToolStore.getState();
      if (
        splitErrorRevisionRef.current !== revision ||
        tool.splitError !== message ||
        !canAdoptProjectLifecycle()
      ) return;
      splitErrorRevisionRef.current += 1;
      tool.setSplitError(null);
    }, delay);
  }, [canAdoptProjectLifecycle]);
  // [refactor jul10 P2.2④] qc for the readTakeoffItems bridge (handler-time sync reads).
  // useQueryClient is provider-stable; it adds ZERO subscriptions to this component.
  const qc = useQueryClient();
  const keynoteParseStep = useParseFlowStore((s) =>
    activeToolKey === "parseRect:keynote" ? s.keynoteParseStep : "idle"
  );
  const keynoteColumnBBs = useParseFlowStore((s) =>
    activeToolKey === "parseRect:keynote" ? s.keynoteColumnBBs : EMPTY_KEYNOTE_COLUMN_BBS
  );
  // [refactor jul11 P2.2⑨] Sacred canvas observes only the current-page instance projection.
  // Metadata for every tag is retained so the existing tag-text/active-tag semantics stay exact;
  // instance edits on another page no longer repaint this canvas.
  const yoloTags = useYoloTagsForPage(pageNumber);
  const { updateYoloTag } = useYoloTagActions();
  const activeYoloTagId = useUiStore((s) => s.activeYoloTagId);
  const setActiveYoloTagId = useUiStore((s) => s.setActiveYoloTagId);
  const setYoloTagFilter = useUiStore((s) => s.setYoloTagFilter);
  const yoloTagVisibility = useUiStore((s) => s.yoloTagVisibility);
  const setYoloTagPickingMode = useToolStore((s) => s.setYoloTagPickingMode);
  const symbolSearchResults = useToolStore((s) => s.symbolSearchResults);
  const symbolSearchConfidence = useToolStore((s) => s.symbolSearchConfidence);
  const dismissedSymbolMatches = useToolStore((s) => s.dismissedSymbolMatches);

  const activeTableTagViews = useUiStore((s) => s.activeTableTagViews);
  const llmHighlight = useUiStore((s) => s.llmHighlight);
  const tableCellStructure = useParseFlowStore((s) => s.tableCellStructure);
  const showTableCellStructure = useParseFlowStore((s) => s.showTableCellStructure);
  const toggleCellHighlight = useParseFlowStore((s) => s.toggleCellHighlight);
  // [refactor jul11 P2.2⑥] Annotation data/actions now share the one chunk-seeded cache facade.
  // C4 converges the five independent create paths onto persistCreate; split stays explicit because
  // its two-row PUT-before-POST order is load-bearing. The subscription remains data-only.
  const {
    annotations,
    addAnnotation,
    removeAnnotation,
    updateAnnotation,
    persistCreate,
  } = useAnnotations();
  // [refactor jul10 P2.2④ D7] dead `addTakeoffItem` binding deleted — declared, never called.
  // [refactor jul11 P2.2⑦] Sacred canvas subscription is current-page only. Handler-time PI below
  // remains an imperative read so parsed-region writes do not redraw this overlay unnecessarily.
  const pageKeynotes = useKeynotesForPage(pageNumber);
  const setKeynoteFilter = useUiStore((s) => s.setKeynoteFilter);

  // Drawing state lives in Zustand store — AnnotationOverlay does NOT subscribe.
  // Use getState() for reads AND writes in event handlers. DrawingPreviewLayer subscribes independently.
  const { _setDrawing: setDrawing, _setDrawStart: setDrawStart, _setDrawEnd: setDrawEnd, _setMousePos: setMousePos } = useToolStore.getState();
  const rafRef = useRef<number>(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Multi-select layer — owns the Group-tool lasso + shift-click accumulation.
  // See useMultiSelectInteraction for the interaction contract. Backward
  // compat: single-select paths (drag-to-move, pencil-edit) keep using the
  // local `selectedId` state; render code ORs with `multiSelect.isSelected`.
  const multiSelect = useMultiSelectInteraction();
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  // Vertex drag state (Bug 2). Lives outside the bbox drag path — polygon
  // vertex edits update data.vertices instead of the annotation bbox.
  const [draggingVertex, setDraggingVertex] = useState<{ annId: number; idx: number } | null>(null);
  // One-shot focus signal from external components (TakeoffPanel, AreaTab).
  // When set, we transfer the value to local selectedId and clear the field.
  const focusAnnotationId = useUiStore((s) => s.focusAnnotationId);
  useEffect(() => {
    if (focusAnnotationId === null || !canAdoptProjectLifecycle()) return;
    setSelectedId(focusAnnotationId);
    if (!canAdoptProjectLifecycle()) return;
    const ui = useUiStore.getState();
    if (ui.focusAnnotationId === focusAnnotationId) {
      ui.setFocusAnnotationId(null);
    }
  }, [canAdoptProjectLifecycle, focusAnnotationId]);

  // Markup modal: the first CSI entry is editable; save preserves its detected-code tail.
  const [pendingMarkup, setPendingMarkup] = useState<[number, number, number, number] | null>(null);
  const [markupName, setMarkupName] = useState("");
  const [markupNote, setMarkupNote] = useState("");
  const [markupCsi, setMarkupCsi] = useState("");
  const [editingAnnotationId, setEditingAnnotationId] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const clearMarkupDialog = useCallback(() => {
    setPendingMarkup(null); setMarkupName(""); setMarkupNote("");
    setMarkupCsi(""); setEditingAnnotationId(null);
  }, []);
  const markupDialogAuthorityRef = useRef({ pageNumber, canAdoptProjectLifecycle });
  useEffect(() => {
    const previous = markupDialogAuthorityRef.current;
    markupDialogAuthorityRef.current = { pageNumber, canAdoptProjectLifecycle };
    if (previous.pageNumber === pageNumber && previous.canAdoptProjectLifecycle === canAdoptProjectLifecycle) return;
    clearMarkupDialog();
  }, [canAdoptProjectLifecycle, clearMarkupDialog, pageNumber]);
  const {
    showDetections, confidenceThreshold, activeModels, hiddenClasses,
    confidenceThresholds, activeAnnotationFilter, activeCsiFilter, hiddenAnnotationIds,
  } = useAnnotationFiltersUi();
  const setAnnotationFilter = useUiStore((s) => s.setAnnotationFilter);
  const setTakeoffFilter = useUiStore((s) => s.setTakeoffFilter);
  const setSearch = useUiStore((s) => s.setSearch);
  const activeTakeoffItemId = useToolStore((s) => s.activeTakeoffItemId);
  // [refactor jul10 P2.2④] cache-backed items subscription (data ONLY — no actions destructured).
  // Re-render topology is a strict SUBSET of the old raw selector: items-key observers notify on
  // items CONTENT change only; group ops never reach this component (SPEC §7.3). The hook value
  // stays in the click-handler closures below (+ their dep arrays) exactly as before — D1-class
  // one-macrotask refresh lag, sanctioned.
  const { takeoffItems } = useTakeoffItems();
  const hiddenTakeoffItemIds = useUiStore((s) => s.hiddenTakeoffItemIds);
  const scaleCalibrations = useToolStore((s) => s.scaleCalibrations);
  const polygonDrawingMode = useToolStore((s) =>
    activeToolKey === null || activeToolKey === "takeoffPlacement"
      ? s.polygonDrawingMode
      : "idle"
  );
  const setPolygonDrawingMode = useToolStore((s) => s.setPolygonDrawingMode);
  const addPolygonVertex = useToolStore((s) => s.addPolygonVertex);
  const undoLastVertex = useToolStore((s) => s.undoLastVertex);
  const bucketFillLoading = useToolStore((s) =>
    activeToolKey === "bucketFill" ? s.bucketFillLoading : false
  );
  const setBucketFillPreview = useToolStore((s) => s.setBucketFillPreview);
  const bucketFillBarrierMode = useToolStore((s) =>
    activeToolKey === "bucketFill" ? s.bucketFillBarrierMode : false
  );
  const addBucketFillBarrier = useToolStore((s) => s.addBucketFillBarrier);
  const setSplitLineEndpoint = useToolStore((s) => s.setSplitLineEndpoint);
  const setSplitPreview = useToolStore((s) => s.setSplitPreview);
  const showTakeoffPanel = useUiStore((s) => s.showTakeoffPanel);
  const tempPanMode = useToolStore((s) => s.tempPanMode);
  const splitAreaActive = activeToolKey === "split";
  // During keynote Step 2 with Column A drawn: only show YOLO fully inside Column A
  const isKeynoteYoloPicking = activeToolKey === "parseRect:keynote" &&
    keynoteParseStep === "define-column" && keynoteColumnBBs.length >= 1;
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


  // Pre-indexed tag lookups: O(1) instead of yoloTags.find() in nested loops
  const tagTextIndex = useMemo(() => {
    const map = new Map<string, typeof yoloTags[0]>();
    for (const tag of yoloTags) map.set(`${tag.tagText}:${tag.source}`, tag);
    return map;
  }, [yoloTags]);

  // Pre-filtered tag instances by page: avoids inner-loop pageNumber check
  const pageTagInstances = useMemo(() => {
    // Preserve scoring fields (confidenceTier, signals, score, dropReason)
    // so the render + browse UI can surface them. Pre-Phase-2 data lacks
    // these fields but ScoredMatch is a structural superset so the typing
    // is compatible either way.
    const map = new Map<string, ScoredMatch[]>();
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
        && !symbolSearchResults && !llmHighlight && !(showTableCellStructure && tableCellStructure?.pageNumber === pageNumber)) {
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
    // When an active tag is selected, hide all other tags' dots so the selected tag is easy to spot.
    // Phase 2: each instance carries an optional confidenceTier. Low-tier → red dashed;
    // medium-tier → amber; high-tier (or absent for pre-Phase-2 data) → the tag's own color.
    const visibleTagInstances: {
      bbox: [number, number, number, number];
      color: string;
      name: string;
      tier: "high" | "medium" | "low";
    }[] = [];
    if (!activeTag) {
      for (const tag of yoloTags) {
        if (tag.id === activeYoloTagId) continue; // active tag drawn separately
        if (yoloTagVisibility[tag.id] === false) continue; // hidden if explicitly toggled off
        const tagPageInsts = pageTagInstances.get(tag.id) || [];
        for (const inst of tagPageInsts) {
          const tier = inst.confidenceTier ?? "high";
          const color =
            tier === "low"    ? "#ef4444" :
            tier === "medium" ? "#f59e0b" :
                                (tag.color || "#22d3ee");
          visibleTagInstances.push({ bbox: inst.bbox, color, name: tag.tagText, tier });
        }
      }
    }

    // Draw existing annotations
    for (const ann of pageAnnotations) {
      // Count markers: draw shape instead of rectangle
      if (ann.source === "takeoff" && (ann.data as any)?.type === "count-marker") {
        const itemId = (ann.data as any)?.takeoffItemId;
        if (hiddenTakeoffItemIds.has(itemId)) continue;
        // [refactor jul10 P2.2④] bridge read, NOT the hook value: this draw effect's dep array
        // (end of effect) deliberately EXCLUDES takeoffItems — item edits (size/color) do not
        // redraw the canvas today. Using the subscribed hook value here (or adding the dep)
        // would create a brand-new canvas-redraw trigger class on every item mutation on the
        // SACRED path. readTakeoffItems reads the live cache synchronously, same as the old
        // getState(). (TAKEOFF_IMPL/SPEC.md §3.3 :372 row — do not "clean up".)
        const items = readTakeoffItems(qc, publicId);
        const item = items.find((t) => t.id === itemId || String(t.id) === String(itemId));
        drawCountMarker(ctx, ann, width, height, ann.id === selectedId || multiSelect.isSelected(ann.id), item?.size, cssScale);
        continue;
      }

      // Area polygons have their own dedicated render pass below (Loop 2).
      // Skip the bbox-rectangle drawing here — it only adds visual clutter
      // overlapping adjacent rooms since the actual polygon shape is drawn
      // by the polygon loop. The label, delete "x", and click handlers
      // still use `ann.bbox` as an invisible-but-stable anchor.
      const isAreaPolygon = ann.source === "takeoff" && (ann.data as any)?.type === "area-polygon";

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

      if (isAreaPolygon) {
        // Bbox fill/stroke skipped — Loop 2 draws the actual polygon below.
        ctx.globalAlpha = dimmed ? 0.25 : 1;
      } else if (isTagMatch) {
        // Bright magenta fill + tag color stroke for active tag instances
        ctx.fillStyle = "#ff00ff40"; // magenta at 25% opacity
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = activeTag.color || "#22d3ee";
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);
      } else {
        ctx.globalAlpha = dimmed ? 0.25 : 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = (ann.id === selectedId || multiSelect.isSelected(ann.id)) ? 3 : 2;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = color + "15";
        ctx.fillRect(x, y, w, h);
      }

      // Label
      const fontSize = Math.max(10, Math.min(13, h * 0.3));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const labelText = ann.name;
      const textW = ctx.measureText(labelText).width;
      const isSelected = ann.id === selectedId || multiSelect.isSelected(ann.id);

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

        // Corner handles — skipped for area polygons. The resize handler only
        // updates ann.bbox, not data.vertices, so dragging a corner visually
        // shifts the (now-invisible) bbox without reshaping the polygon. The
        // handles would be dead decorations floating in space.
        if (!isAreaPolygon) {
          const hs = 6;
          ctx.fillStyle = color;
          ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
          ctx.fillRect(x + w - hs / 2, y - hs / 2, hs, hs);
          ctx.fillRect(x - hs / 2, y + h - hs / 2, hs, hs);
          ctx.fillRect(x + w - hs / 2, y + h - hs / 2, hs, hs);
        }
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
      ctx.lineWidth = vi.tier === "low" ? 1 : 1.5;
      // Low-tier instances get a tighter dash to visually distinguish audit-flagged
      // matches from normal hits. Medium + high share the standard dash.
      ctx.setLineDash(vi.tier === "low" ? [2, 4] : [4, 3]);
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

      // Holes (e.g., courtyards inside a U-shaped hallway). Rendered via
      // fill-rule="evenodd" as cutouts. Same pattern as DrawingPreviewLayer
      // so committed annotations match their pre-commit preview exactly.
      const holes = data.holes ?? [];

      ctx.save();
      // Fill — outer polygon + hole subpaths, evenodd rule for cutouts.
      // With no holes this is identical to the previous `fill()` behavior.
      ctx.fillStyle = data.color + "40";
      ctx.beginPath();
      ctx.moveTo(data.vertices[0].x * width, data.vertices[0].y * height);
      for (let i = 1; i < data.vertices.length; i++) {
        ctx.lineTo(data.vertices[i].x * width, data.vertices[i].y * height);
      }
      ctx.closePath();
      for (const hole of holes) {
        if (hole.vertices.length < 3) continue;
        ctx.moveTo(hole.vertices[0].x * width, hole.vertices[0].y * height);
        for (let i = 1; i < hole.vertices.length; i++) {
          ctx.lineTo(hole.vertices[i].x * width, hole.vertices[i].y * height);
        }
        ctx.closePath();
      }
      ctx.fill("evenodd");

      // Stroke outer polygon
      ctx.strokeStyle = data.color;
      ctx.lineWidth = ann.id === selectedId ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(data.vertices[0].x * width, data.vertices[0].y * height);
      for (let i = 1; i < data.vertices.length; i++) {
        ctx.lineTo(data.vertices[i].x * width, data.vertices[i].y * height);
      }
      ctx.closePath();
      ctx.stroke();
      // Stroke each hole so the user can see which regions are cutouts
      for (const hole of holes) {
        if (hole.vertices.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(hole.vertices[0].x * width, hole.vertices[0].y * height);
        for (let i = 1; i < hole.vertices.length; i++) {
          ctx.lineTo(hole.vertices[i].x * width, hole.vertices[i].y * height);
        }
        ctx.closePath();
        ctx.stroke();
      }

      // Vertices when selected (outer only — hole vertices aren't editable)
      if (ann.id === selectedId || multiSelect.isSelected(ann.id)) {
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
      if (ann.id === selectedId || multiSelect.isSelected(ann.id)) {
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

    // Group-membership outlines — one pass after all shape-specific loops.
    // Uses ann.bbox so every annotation type (bbox / polygon / polyline /
    // count-marker) gets a consistent ring. Inactive groups are filtered
    // upstream in useMultiSelectInteraction (getGroupOutlineColor returns
    // null for them).
    for (const ann of pageAnnotations) {
      const groupColor = multiSelect.getGroupOutlineColor(ann.id);
      if (!groupColor) continue;
      const [minX, minY, maxX, maxY] = ann.bbox;
      const x = minX * width;
      const y = minY * height;
      const w = (maxX - minX) * width;
      const h = (maxY - minY) * height;
      ctx.save();
      ctx.strokeStyle = groupColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 2]);
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
      ctx.restore();
    }

    // Calibration + polygon preview — rendered by DrawingPreviewLayer
  }, [pageAnnotations, width, height, selectedId, activeYoloTagId, yoloTags, yoloTagVisibility, pageNumber, symbolSearchResults, symbolSearchConfidence, dismissedSymbolMatches, activeTableTagViews, llmHighlight, hiddenTakeoffItemIds, tableCellStructure, showTableCellStructure, multiSelect]);

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

  const cancelDeferredDrawing = useCallback(() => {
    const lease = drawingLeaseRef.current;
    const cancelled = lease !== null && cancelToolTailExact(lease.token);
    if (!cancelled && drawingLeaseRef.current === lease) {
      drawingLeaseRef.current = null;
      if (useToolStore.getState()._drawing) setDrawing(false);
    }
    if (lease) consumeToolTailAuthority(lease.token, () => {});
  }, [setDrawing]);

  const startDeferredDrawing = useCallback((
    pos: { x: number; y: number },
    clearSelection = true,
  ): boolean => {
    const snapshot = readCanvasGestureSnapshot();
    if (snapshot.publicId !== publicId || snapshot.pageNumber !== pageNumber) return false;

    const token = {};
    const lease = captureCanvasGestureLease(token, snapshot);
    if (!lease) return false;

    claimToolTailAuthority(token);
    drawingLeaseRef.current = lease;
    registerToolTailCancellation(token, () => {
      if (drawingLeaseRef.current !== lease) return;
      drawingLeaseRef.current = null;
      if (useToolStore.getState()._drawing) setDrawing(false);
    });
    if (clearSelection) setSelectedId(null);

    const stillOwnsLease = () => drawingLeaseRef.current === lease &&
      ownsToolTailAuthority(token) &&
      matchesCanvasGestureLease(lease, readCanvasGestureSnapshot());
    const abandonLease = () => {
      if (drawingLeaseRef.current === lease) {
        drawingLeaseRef.current = null;
        releaseToolTailCancellation(token);
        if (useToolStore.getState()._drawing) setDrawing(false);
      }
      consumeToolTailAuthority(token, () => {});
    };

    setDrawing(true);
    if (!stillOwnsLease()) {
      abandonLease();
      return false;
    }
    setDrawStart(pos);
    if (!stillOwnsLease()) {
      abandonLease();
      return false;
    }
    setDrawEnd(pos);
    if (!stillOwnsLease()) {
      abandonLease();
      return false;
    }
    return true;
  }, [pageNumber, publicId, setDrawing, setDrawEnd, setDrawStart]);

  useEffect(() => () => cancelDeferredDrawing(), [cancelDeferredDrawing]);

  /** Save the current in-progress polygon as an area-polygon annotation */
  const savePolygon = useCallback(() => {
    if (!canAdoptProjectLifecycle()) return;
    const verts = useToolStore.getState().polygonVertices;
    // [refactor jul10 P2.2④] handler-time sync read via the cache bridge (was getState).
    const items = readTakeoffItems(qc, publicId);
    const activeId = useToolStore.getState().activeTakeoffItemId;
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

    // [refactor jul11 P2.2⑥ C4] The shared create seam keeps the exact old POST shape,
    // optimistic no-rollback behavior, ID-only reconcile, demo gate, and visible error channel.
    void persistCreate({
      pageNumber,
      name: activeItem.name,
      bbox,
      source: "takeoff",
      data: polygonData as unknown as Record<string, unknown>,
    }, {
      canAdopt: canAdoptProjectLifecycle,
      onError: (err) => {
        publishTransientBucketFillError(
          err instanceof Error ? `Failed to save area: ${err.message}` : "Failed to save area",
        );
      },
    });
    if (!canAdoptProjectLifecycle()) return;

    // persistCreate publishes optimistically before its first await; a cache listener can admit a
    // newer parse during that publication. This older save tail clears its own drawing without
    // revoking the newer parse's exact global Tool capability.
    publishSettledPolygonReset();
    if (!canAdoptProjectLifecycle()) return;
    setMousePos(null);
  }, [canAdoptProjectLifecycle, pageNumber, persistCreate, publicId,
    publishTransientBucketFillError, scaleCalibrations, width, height]);

  /** Prepare bucket fill preview for item assignment (doesn't create annotation yet) */
  const prepareBucketFillPolygon = useCallback(() => {
    if (!canAdoptProjectLifecycle()) return;
    const preview = useToolStore.getState().bucketFillPreview;
    if (!preview || preview.vertices.length < 3) return;

    const verts = preview.vertices;
    const holes = preview.holes ?? [];
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
      // Outer polygon area, then subtract each hole's area. Matches what the
      // preview renders via fill-rule="evenodd" so the number matches the
      // visual.
      const outer = computeRealArea(verts, width, height, calibration);
      let holesArea = 0;
      for (const hole of holes) {
        if (hole.vertices.length >= 3) {
          holesArea += computeRealArea(hole.vertices, width, height, calibration);
        }
      }
      areaSqUnits = Math.max(0, outer - holesArea);
      unit = AREA_UNIT_MAP[calibration.unit] || "SF";
    }

    // If the user already has an area item active, commit directly and skip
    // the assign-to-item dialog. The dialog exists to pick a target when
    // there's no context; pre-selecting the item IS that context. This matches
    // the free-polygon drawing flow at L780-820 which also commits directly
    // to the active item.
    const activeId = useToolStore.getState().activeTakeoffItemId;
    // [refactor jul10 P2.2④] handler-time sync read via the cache bridge (was getState).
    const activeItem = activeId
      ? readTakeoffItems(qc, publicId).find((t) => t.id === activeId)
      : null;
    if (activeItem && activeItem.shape === "polygon") {
      const polygonData: AreaPolygonData = {
        type: "area-polygon",
        takeoffItemId: activeItem.id,
        color: activeItem.color,
        vertices: [...verts],
        ...(holes.length > 0
          ? { holes: holes.map((h) => ({ vertices: [...h.vertices] })) }
          : {}),
        areaSqUnits,
        unit,
      };
      // [refactor jul11 P2.2⑥ C4] Same create recipe as freehand area; request omissions
      // remain byte-for-shape identical because persistCreate normalizes only the cache row.
      void persistCreate({
        pageNumber,
        name: activeItem.name,
        bbox,
        source: "takeoff",
        data: polygonData as unknown as Record<string, unknown>,
      }, {
        canAdopt: canAdoptProjectLifecycle,
        onError: (err) => {
          publishTransientBucketFillError(
            err instanceof Error ? `Failed to save area: ${err.message}` : "Failed to save area",
          );
        },
      });
      if (!canAdoptProjectLifecycle()) return;
      setBucketFillPreview(null);
      return;
    }

    // No active area item — fall through to the assign dialog flow.
    useToolStore.getState().setBucketFillPendingPolygon({
      vertices: [...verts],
      holes: holes.length > 0 ? holes.map((h) => ({ vertices: [...h.vertices] })) : undefined,
      method: preview.method,
      bbox,
      areaSqUnits,
      unit,
    });
    if (!canAdoptProjectLifecycle()) return;
    setBucketFillPreview(null);
  }, [canAdoptProjectLifecycle, pageNumber, persistCreate, publicId,
    publishTransientBucketFillError, scaleCalibrations, setBucketFillPreview, width, height]);

  /** Accept a pending Split Area preview: both halves stay under same takeoff item. */
  const acceptSplit = useCallback(() => {
    if (!canAdoptProjectLifecycle()) return;
    const preview = useToolStore.getState().splitPreview;
    if (!preview) return;

    // [refactor jul11 P2.2⑥] Accept runs after an arbitrary preview lifetime, so it must read
    // the live keyed cache here rather than closing over the render-captured annotations array.
    const currentAnnotations = readAnnotations(qc, publicId);
    // [refactor jul10 P2.2④] handler-time sync read via the cache bridge (was getState).
    const currentItems = readTakeoffItems(qc, publicId);
    const target = currentAnnotations.find((a) => a.id === preview.targetAnnotationId);
    if (!target) {
      useToolStore.getState().setSplitPreview(null);
      if (!canAdoptProjectLifecycle()) return;
      useToolStore.getState().setSplitLineEndpoint("a", null as unknown as { x: number; y: number });
      return;
    }
    const parentItem = currentItems.find((t) => t.id === (target.data as AreaPolygonData).takeoffItemId);
    if (!parentItem) {
      useToolStore.getState().setSplitPreview(null);
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

    // 1. Create right-half annotation FIRST (safe ordering — if anything fails, original is intact).
    // [refactor jul11 P2.2⑥ C4] INTENTIONAL exception to persistCreate: split is a two-row
    // transaction-shaped sequence (optimistic right -> optimistic left -> PUT left -> POST right).
    // The shared one-row seam would dispatch the POST before the left update/PUT and subtly reorder
    // failure behavior, so this load-bearing path stays explicit until it has a real transaction API.
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
    if (!canAdoptProjectLifecycle()) return;

    // 2. Update original annotation to left half
    updateAnnotation(target.id, {
      bbox: leftResult.bbox,
      data: leftResult.data as unknown as Record<string, unknown>,
    });
    if (!canAdoptProjectLifecycle()) return;

    // 3. Persist both to server. Surface failures via the visible split-error
    //    banner instead of console-only logging, so a dropped split is noticed.
    if (canPersist(publicId, isDemo)) {
      (async () => {
        try {
          if (target.id > 0) {
            await persistFetch(
              `/api/annotations/${target.id}`,
              { bbox: leftResult.bbox, data: leftResult.data },
              "PUT",
            );
          }
          const saved = await persistFetch("/api/annotations", {
            projectId: publicId,
            pageNumber,
            name: parentItem.name,
            bbox: rightResult.bbox,
            source: "takeoff",
            data: rightResult.data,
          }) as { id?: number } | null;
          if (saved?.id && canAdoptProjectLifecycle()) {
            updateAnnotation(tempAnnId, { id: saved.id });
          }
        } catch (err) {
          publishTransientSplitError(
            err instanceof Error ? `Failed to save split: ${err.message}` : "Failed to save split",
          );
        }
      })();
    }

    // 4. Stay in split mode — clear preview + line, ready for next split. Escape exits.
    const store = useToolStore.getState();
    store.setSplitPreview(null);
    if (!canAdoptProjectLifecycle()) return;
    store.setSplitLineEndpoint("a", null);
    if (!canAdoptProjectLifecycle()) return;
    store.setSplitLineEndpoint("b", null);
  }, [addAnnotation, canAdoptProjectLifecycle, height, isDemo, pageNumber,
    publicId, publishTransientSplitError, scaleCalibrations, updateAnnotation, width]);

  /** Save the current in-progress polyline as a linear-polyline annotation */
  const saveLinearPolyline = useCallback(() => {
    if (!canAdoptProjectLifecycle()) return;
    const verts = useToolStore.getState().polygonVertices;
    // [refactor jul10 P2.2④] handler-time sync read via the cache bridge (was getState).
    const items = readTakeoffItems(qc, publicId);
    const activeId = useToolStore.getState().activeTakeoffItemId;
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

    // [refactor jul11 P2.2⑥ C4] Shared optimistic-create recipe; failures remain local+visible.
    void persistCreate({
      pageNumber,
      name: activeItem.name,
      bbox,
      source: "takeoff",
      data: polylineData as unknown as Record<string, unknown>,
    }, {
      canAdopt: canAdoptProjectLifecycle,
      onError: (err) => {
        publishTransientBucketFillError(
          err instanceof Error ? `Failed to save line: ${err.message}` : "Failed to save line",
        );
      },
    });
    if (!canAdoptProjectLifecycle()) return;

    // Same synchronous optimistic-publication boundary as savePolygon above.
    publishSettledPolygonReset();
    if (!canAdoptProjectLifecycle()) return;
    setMousePos(null);
  }, [canAdoptProjectLifecycle, pageNumber, persistCreate, publicId,
    publishTransientBucketFillError, scaleCalibrations, width, height]);

  // Track which corner is being resized: null or "tl"|"tr"|"bl"|"br"
  const [resizeCorner, setResizeCorner] = useState<string | null>(null);

  function deleteSelected() {
    if (!canAdoptProjectLifecycle()) return;
    // Multi-selection path: batch-delete via the new endpoint when ≥2
    // annotations are selected. Single DELETE per annotation is still
    // used when only `selectedId` is set (the legacy single-select path).
    const multiIds = [...multiSelect.selectedAnnotationIds];
    if (multiIds.length > 1) {
      // Only persisted rows (positive ids) need a server delete; temp/optimistic
      // ids (<= 0) were never saved, so skip them to avoid spurious 404 errors.
      const persistedIds = multiIds.filter((id) => id > 0);
      if (canPersist(publicId, isDemo) && persistedIds.length > 0) {
        (async () => {
          try {
            await persistFetch(
              `/api/annotations/batch-delete`,
              { projectId: publicId, annotationIds: persistedIds },
            );
          } catch (err) {
            publishTransientBucketFillError(
              err instanceof Error ? `Failed to delete: ${err.message}` : "Failed to delete annotations",
            );
          }
        })();
      }
      for (const id of multiIds) {
        if (!canAdoptProjectLifecycle()) return;
        removeAnnotation(id);
      }
      if (!canAdoptProjectLifecycle()) return;
      multiSelect.clearSelection();
      if (!canAdoptProjectLifecycle()) return;
      setSelectedId(null);
      return;
    }
    if (selectedId === null) return;
    if (canPersist(publicId, isDemo) && selectedId > 0) {
      const deleteId = selectedId;
      (async () => {
        try {
          await persistFetch(`/api/annotations/${deleteId}`, undefined, "DELETE");
        } catch (err) {
          publishTransientBucketFillError(
            err instanceof Error ? `Failed to delete: ${err.message}` : "Failed to delete annotation",
          );
        }
      })();
    }
    removeAnnotation(selectedId);
    if (!canAdoptProjectLifecycle()) return;
    setSelectedId(null);
    if (!canAdoptProjectLifecycle()) return;
    multiSelect.clearSelection();
  }

  /** Save the current position of the selected annotation to the API */
  const saveDragPosition = useCallback(() => {
    if (!canAdoptProjectLifecycle()) return;
    if (selectedId === null) return;
    if (!canPersist(publicId, isDemo)) return;
    if (selectedId <= 0) return; // skip tempIds (optimistic local-only)
    const ann = annotations.find((a) => a.id === selectedId);
    if (ann) {
      const annId = selectedId;
      (async () => {
        try {
          await persistFetch(`/api/annotations/${annId}`, { bbox: ann.bbox }, "PUT");
        } catch (err) {
          publishTransientBucketFillError(
            err instanceof Error ? `Failed to save move: ${err.message}` : "Failed to save move",
          );
        }
      })();
    }
  }, [annotations, canAdoptProjectLifecycle, isDemo, publicId,
    publishTransientBucketFillError, selectedId]);

  const {
    begin: beginAnnotationDrag,
    finish: finishAnnotationDrag,
    readActive: readActiveAnnotationDrag,
    schedule: scheduleAnnotationDragPublish,
  } = useAnnotationDragMachine({
    queryClient: qc, publicId, pageNumber, canAdoptProjectLifecycle,
    publishTransientError: publishTransientBucketFillError,
    setDragging, setResizeCorner, setDraggingVertex, setSelectedId,
  });

  const HANDLE = 8; // corner handle size in pixels

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!canAdoptProjectLifecycle()) return;
      // Retire any earlier local rectangle. Each accepted branch below then either invalidates the
      // old global tail or replaces it with its own exact deferred/async token.
      cancelDeferredDrawing();
      if (useSessionStore.getState().publicId !== publicId ||
          useViewerCoreStore.getState().pageNumber !== pageNumber) return;
      const toolAtDown = useToolStore.getState();
      const activeTool = toolAtDown.activeTool;
      const pos = getPos(e);
      // [refactor jul16 P3.2] Non-empty registry: wire the already-captured press eagerly and the
      // shared context lazily. Every identifier here is already in this callback's dependency
      // array or module scope, so the 37-entry array stays byte-identical (physics contract).
      // The markup-proven capabilities (selection / pageAnnotations / deferredDrawing) are
      // dep-neutral too: selectedId, pageAnnotations, and startDeferredDrawing are already in the
      // dependency array; the setters are stable; deleteSelected is the same per-render closure
      // this handler already captured for the pointer block's delete-x.
      // [refactor jul17 P3.2] The takeoffCount-proven capabilities (mutations.persistCreate /
      // transientError / takeoffItems) are equally dep-neutral: all three identifiers were
      // already in the dependency array for the legacy count branch. The takeoffLinear-proven
      // takeoffDrawing capability follows the same rule: the two store action bindings and the
      // saveLinearPolyline composite were already dependencies of the legacy linear branch.
      const press = { toolAtDown, position: pos, publicId, pageNumber } as const;
      if (
        dispatchToolMouseDown(TOOLS, e, press, () => ({
          press,
          page: { publicId, number: pageNumber, width, height },
          stores: TOOL_STORE_CAPABILITIES,
          canAdoptProjectLifecycle,
          selection: { selectedId, setSelectedId, setResizeCorner, setDragging, deleteSelected },
          annotationDrag: {
            beginBBox: (annotation, corner) => beginAnnotationDrag(
              annotation, { kind: "bbox", resizeCorner: corner, dragOffset: { x: 0, y: 0 } },
            ),
          },
          pageAnnotations,
          deferredDrawing: { start: startDeferredDrawing },
          keynotePick: { active: isKeynoteYoloPicking },
          mutations: { annotations: { persistCreate } },
          transientError: { publish: publishTransientBucketFillError },
          takeoffItems,
          takeoffDrawing: { setPolygonDrawingMode, addPolygonVertex, saveLinearPolyline, savePolygon },
        }))
      ) {
        return;
      }

      // Split Area mode — 2-click auto-detect (line A, line B → auto-find polygon)
      if (activeTool?.kind === "split") {
        e.stopPropagation();
        const normX = pos.x / width;
        const normY = pos.y / height;

        if (toolAtDown.splitPreview) return; // preview showing — commit via Accept/Cancel buttons

        if (!toolAtDown.splitLineA) {
          invalidateToolTailAuthority();
          setSplitLineEndpoint("a", { x: normX, y: normY });
          return;
        }

        // Second click: set B and immediately auto-detect which polygon to split
        invalidateToolTailAuthority();
        const pointB = { x: normX, y: normY };
        setSplitLineEndpoint("b", pointB);
        if (!canAdoptProjectLifecycle()) return;

        const polyAnnotations = pageAnnotations.filter(
          (a) => a.source === "takeoff" && (a.data as AreaPolygonData)?.type === "area-polygon"
        );
        const candidates = findSplittablePolygons(
          toolAtDown.splitLineA,
          pointB,
          polyAnnotations.map((a) => ({ id: a.id, vertices: (a.data as AreaPolygonData).vertices }))
        );

        if (candidates.length === 0) {
          publishTransientSplitError(
            "Line does not cross any area polygon in exactly 2 places",
            3500,
          );
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
          lineA: toolAtDown.splitLineA,
          lineB: pointB,
        });
        return;
      }

      // Bucket fill mode — independent of item selection
      if (activeTool?.kind === "bucketFill") {
        const bfState = toolAtDown;
        e.stopPropagation();
        const normX = pos.x / width;
        const normY = pos.y / height;

        if (bfState.bucketFillBarrierMode) {
          invalidateToolTailAuthority();
          invalidateLatestToolOperation("bucketFill");
          const pending = bfState.barrierPendingPoint;
          if (pending) {
            addBucketFillBarrier({ x1: pending.x, y1: pending.y, x2: normX, y2: normY });
            if (!canAdoptProjectLifecycle()) return;
            bfState.setBarrierPendingPoint(null);
          } else {
            bfState.setBarrierPendingPoint({ x: normX, y: normY });
          }
          return;
        }

        if (bfState.bucketFillLoading) return;
        if (bfState.bucketFillPreview || bfState.bucketFillPendingPolygon) return; // preview/dialog showing

        const bucketToken = {};
        const bucketActivation = activeTool;
        const bucketProjectDbId = projectDbId;
        const bucketPublicId = publicId;
        const bucketPageNumber = pageNumber;
        claimToolTailAuthority(bucketToken);
        claimLatestToolOperation("bucketFill", bucketToken);
        // A competing global intent defeats this result tail. Its exact queued cancellation may
        // still clear A's spinner while preserving a newer Bucket B (which rotates the lane).
        registerToolTailCancellation(bucketToken, () => {
          if (
            !ownsLatestToolOperation("bucketFill", bucketToken) ||
            useSessionStore.getState().projectId !== bucketProjectDbId ||
            useSessionStore.getState().publicId !== bucketPublicId ||
            useViewerCoreStore.getState().pageNumber !== bucketPageNumber
          ) return;
          useToolStore.setState((state) =>
            state.activeTool === bucketActivation &&
              (state.bucketFillLoading || state.bucketFillError !== null)
              ? { bucketFillLoading: false, bucketFillError: null }
              : state
          );
        });
        useToolStore.setState({
          bucketFillLoading: true,
          bucketFillPreview: null,
          bucketFillError: null,
        });

        const ownsBucketFill = () => {
          const current = useToolStore.getState();
          return canAdoptProjectLifecycle() &&
            ownsToolTailAuthority(bucketToken) &&
            ownsLatestToolOperation("bucketFill", bucketToken) &&
            current.activeTool === bucketActivation &&
            useSessionStore.getState().projectId === bucketProjectDbId &&
            useSessionStore.getState().publicId === bucketPublicId &&
            useViewerCoreStore.getState().pageNumber === bucketPageNumber;
        };
        if (!ownsBucketFill()) return;

        const consumeBucketFill = (publish: () => void): boolean => {
          if (!ownsBucketFill()) return false;
          releaseToolTailCancellation(bucketToken);
          return consumeToolTailAuthority(bucketToken, publish);
        };

        // [refactor jul11 P2.2⑥] Bucket-fill collision input is invocation-time state. Reading
        // the cache bridge preserves getState freshness without resubscribing this handler.
        const existingPolygons = readAnnotations(qc, publicId)
          .filter((a: any) => a.pageNumber === pageNumber && a.source === "takeoff"
            && a.data?.type === "area-polygon" && a.data?.vertices?.length >= 3)
          .map((a: any) => ({ vertices: a.data.vertices }));

        // OCR text bboxes — staged for Tier 2 (enclosed-text area accounting).
        // The worker currently ignores these; pre-2026-04-22 it used them to
        // erase text-to-passable before flood, which punched holes through
        // walls when an OCR bbox straddled a thin wall. New paradigm: text
        // is a wall during flood (stops the fill at letter boundaries), and
        // a future feature will add the real-world area of fully-enclosed
        // text bboxes back to the reported sqft. Keep passing the payload so
        // Tier 2 is a one-line re-adoption; do not delete as "unused."
        // Invocation-time cache read only: bucket fill must not add a Textract observer/redraw source
        // to this sacred canvas surface.
        const textractWords = readTextractForPage(qc, publicId, pageNumber)?.words ?? [];
        const textBboxes = textractWords.map((w: { bbox: [number, number, number, number] }) => ({
          x: w.bbox[0], y: w.bbox[1], w: w.bbox[2], h: w.bbox[3],
        }));

        const handleFillSuccess = (data: {
          vertices: { x: number; y: number }[];
          holes?: { vertices: { x: number; y: number }[] }[];
          method: string;
        }) => {
          consumeBucketFill(() => useToolStore.setState({
            bucketFillLoading: false,
            bucketFillPreview: {
              vertices: data.vertices,
              holes: data.holes && data.holes.length > 0 ? data.holes : undefined,
              method: data.method,
            },
          }));
        };

        const handleFillError = (message: string) => {
          if (!ownsBucketFill()) return;
          useToolStore.setState({
            bucketFillLoading: false,
            bucketFillError: message,
          });
          setTimeout(() => {
            consumeBucketFill(() => useToolStore.getState().setBucketFillError(null));
          }, 4000);
        };

        const serverFallback = () => {
          if (!ownsBucketFill()) return;
          void fetch("/api/bucket-fill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: bucketProjectDbId,
              pageNumber,
              seedPoint: { x: normX, y: normY },
              tolerance: bfState.bucketFillTolerance,
              dilate: bfState.bucketFillDilatePx,
              barriers: bfState.bucketFillBarriers,
              polygonBarriers: existingPolygons,
              textBboxes,
            }),
          })
            .then(async (res) => {
              if (!ownsBucketFill()) return null;
              // [refactor jul6 S030] apiErrorMessage: non-OK now serves {error:{code,message}};
              // the engine's in-band {type:"error"}-at-200 protocol below is untouched.
              if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(apiErrorMessage(err) || `HTTP ${res.status}`);
              }
              const data = await res.json();
              return ownsBucketFill() ? data : null;
            })
            .then((data) => {
              if (!ownsBucketFill()) return;
              if (data?.type === "result" && data.vertices?.length >= 3) {
                handleFillSuccess({
                  vertices: data.vertices,
                  holes: data.holes,
                  method: data.method || "server-raster",
                });
              } else if (data?.type === "error") {
                handleFillError(data.error || "Bucket fill failed");
              } else {
                consumeBucketFill(() => {
                  useToolStore.setState({ bucketFillLoading: false });
                });
              }
            })
            .catch((err) => {
              handleFillError(err?.message || "Bucket fill failed");
            });
        };

        // Try client-side WebWorker first, fall back to server.
        // maxDimension is the worker's resolution knob — 1000 is near-instant
        // but averages thin walls out of existence on high-DPI CAD exports;
        // 4000 is near-native PDF.js canvas resolution with a ~150-250ms cost
        // on big fills. 2000 / 3000 are intermediate snaps on the slider.
        const pageCanvas = findPageCanvas();
        if (pageCanvas) {
          const maxDimension = bfState.bucketFillResolution;
          clientBucketFill(pageCanvas, { x: normX, y: normY }, {
            tolerance: bfState.bucketFillTolerance,
            dilation: bfState.bucketFillDilatePx,
            barriers: bfState.bucketFillBarriers,
            polygonBarriers: existingPolygons,
            textBboxes,
            maxDimension,
          })
            .then(handleFillSuccess)
            .catch(() => {
              if (ownsBucketFill()) serverFallback();
            });
        } else {
          serverFallback();
        }
        return;
      }

      // Takeoff placement mode
      if (activeTool?.kind === "takeoffPlacement") {
        const activeItem = takeoffItems.find((t) => t.id === toolAtDown.activeTakeoffItemId);
        if (!activeItem) return;
        invalidateToolTailAuthority();
        e.stopPropagation();

        // [refactor jul17 P3.2] All three takeoff identities live behind the registry seam now:
        // count (existing-marker select loop + clamped-bbox placement) in tools/takeoffCount.ts,
        // linear (strict-<10 last-vertex finish snap into saveLinearPolyline) in
        // tools/takeoffLinear.ts, and polygon (strict-<15 FIRST-vertex close snap into
        // savePolygon) in tools/takeoffPolygon.ts — every resolvable shape claims upstream, so
        // the only press that reaches this branch is !activeItem, which returned silently above
        // BEFORE the prelude. The prelude + this terminal return stay as the branch's
        // always-claims contract for any residual (currently unreachable) shape partition
        // (TAKEOFF_POLYGON_IMPL/RECON_CENSUS.md §2, option a; collapse is a P3-review candidate).
        return;
      }

      // ─── Drawing/picking modes: must come BEFORE pointer block ─────
      // The pointer block always returns, so these would be unreachable after it.

      // YOLO Tag picking
      if (activeTool?.kind === "tagPick") {
        const clickNormX = pos.x / width;
        const clickNormY = pos.y / height;
        for (const ann of pageAnnotations) {
          if (ann.source !== "yolo") continue;
          const [aMinX, aMinY, aMaxX, aMaxY] = ann.bbox;
          if (clickNormX >= aMinX && clickNormX <= aMaxX && clickNormY >= aMinY && clickNormY <= aMaxY) {
            e.stopPropagation();
            const model = (ann as any).data?.modelName as string || "unknown";
            const store = useToolStore.getState();
            const session = useSessionStore.getState();
            store.setYoloTagPickingMode(false);

            // Trigger class scan — request all unique texts inside this class.
            const pid = session.publicId;
            const yoloClass = ann.name;
            const yoloModel = model;
            if (!pid) return;
            tagScanControllerRef.current?.abort();
            const controller = new AbortController();
            tagScanControllerRef.current = controller;
            requestMapTagsBatch(
              pid,
              { action: "scanClass", yoloClass, yoloModel },
              { signal: controller.signal },
            )
              .then((result) => {
                if (!result.ok) throw new Error(`HTTP ${result.status}`);
                return result.data;
              })
              .then(({ texts }) => {
                if (tagScanControllerRef.current !== controller || controller.signal.aborted) return;
                if (useSessionStore.getState().publicId !== pid) return;
                if (!canAdoptProjectLifecycle()) return;
                useToolStore.getState().setTagScanResults({
                  yoloClass,
                  yoloModel,
                  texts: texts || [],
                });
              })
              .catch((err) => {
                if ((err as Error).name === "AbortError") return;
                if (tagScanControllerRef.current !== controller) return;
                if (!canAdoptProjectLifecycle()) return;
                console.error("[YOLO_TAG] Class scan failed:", err);
              });
            return;
          }
        }
        setYoloTagPickingMode(false);
        return;
      }

      // Tag Add owns its exact tag payload for the complete deferred rectangle.
      if (activeTool?.kind === "tagAdd") {
        e.stopPropagation();
        startDeferredDrawing(pos);
        return;
      }

      // [refactor jul18 P3.2] keynotePick hit/miss routing and generic parseRect deferred starts
      // plus symbolSearch starts are claimed at the registry seam. Conditional subscriptions,
      // filtering, and complete drawing settlement stay in this component.

      // Every non-null specialized owner suppresses base pointer/group/markup fallthrough.
      if (activeTool !== null) return;
      invalidateToolTailAuthority();

      // Pointer mode (and Group mode, which shares most interactions but adds
      // shift-click multi-select + empty-canvas lasso): select, delete, move,
      // resize annotations + click keynotes. The Group-specific branches are
      // (a) the multiSelect.handleAnnotationClick call inside the bbox-hit
      // loop below, and (b) the empty-canvas "mode === 'group'" lasso-start
      // at the bottom of this block.
      if (toolAtDown.mode === "pointer" || toolAtDown.mode === "group") {
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
              const clickNorm = { x: pos.x / width, y: pos.y / height };
              // Clicking inside a hole (courtyard) should NOT select the polygon
              hit = pointInPolygonWithHoles(clickNorm, data.vertices, data.holes);
            } else if (ann.source === "takeoff" && (ann.data as any)?.type === "linear-polyline") {
              const data = ann.data as unknown as LinearPolylineData;
              hit = pointNearPolyline(pos, data.vertices, width, height);
            } else {
              hit = pointInNormalizedBbox(pos, ann.bbox, width, height);
            }
            if (!hit) continue;
            e.stopPropagation();

            const store = useUiStore.getState();
            const currentSearch = store.searchQuery;
            const isToggleOff = currentSearch.toLowerCase() === ann.name.toLowerCase();

            if (ann.source === "user") {
              // User markup: filter + open TextPanel → Markups tab
              if (isToggleOff) {
                setSearch("");
                if (!canAdoptProjectLifecycle()) return;
                setAnnotationFilter(null);
                if (!canAdoptProjectLifecycle()) return;
                store.setActiveMarkupId(null);
              } else {
                setSearch(ann.name);
                if (!canAdoptProjectLifecycle()) return;
                setAnnotationFilter(ann.name);
                if (!canAdoptProjectLifecycle()) return;
                store.setActiveMarkupId(ann.id);
                if (!canAdoptProjectLifecycle()) return;
                store.setTextPanelTab("markups");
                if (!canAdoptProjectLifecycle()) return;
                if (!store.showTextPanel) store.toggleTextPanel();
              }
            } else if (ann.source === "takeoff") {
              // QTO marker: filter by takeoff item
              const itemId = (ann.data as any)?.takeoffItemId;
              const item = takeoffItems.find((t) => t.id === itemId);
              const itemName = item?.name || ann.name;
              if (isToggleOff || currentSearch.toLowerCase() === itemName.toLowerCase()) {
                setSearch("");
                if (!canAdoptProjectLifecycle()) return;
                setTakeoffFilter(null);
              } else {
                setSearch(itemName);
                if (!canAdoptProjectLifecycle()) return;
                setTakeoffFilter(itemId);
              }
            } else {
              // YOLO or other: annotation name filter
              if (isToggleOff) {
                setSearch("");
                if (!canAdoptProjectLifecycle()) return;
                setAnnotationFilter(null);
              } else {
                setSearch(ann.name);
                if (!canAdoptProjectLifecycle()) return;
                setAnnotationFilter(ann.name);
              }
            }
            return;
          }
          // No annotation hit — try parsed table region hit-test
          const pIntel = readPageIntelligence(qc, publicId, pageNumber) as any;
          if (pIntel?.parsedRegions) {
            const nrmX = pos.x / width;
            const nrmY = pos.y / height;
            for (const region of pIntel.parsedRegions) {
              if (!region.bbox || region.type !== "schedule") continue;
              const [rMinX, rMinY, rMaxX, rMaxY] = region.bbox;
              if (nrmX >= rMinX && nrmX <= rMaxX && nrmY >= rMinY && nrmY <= rMaxY) {
                e.stopPropagation();
                // Parsed-region navigation is a stored-tab/new-flow handoff. Keep the canvas hot
                // path subscription-free while publishing UI first and one terminal Parse patch.
                focusParsedTableRegionInCatalog(region.id);
                return;
              }
            }
          }

          // No parsed region hit — try OCR word fallback
          // Double-click OCR fallback is also action-only and must see the live replacement without
          // subscribing the canvas to Textract cache updates.
          const pageWords = readTextractForPage(qc, publicId, pageNumber)?.words;
          if (pageWords) {
            const normX = pos.x / width;
            const normY = pos.y / height;
            for (const word of pageWords) {
              const [left, top, w, h] = word.bbox;
              if (normX >= left && normX <= left + w && normY >= top && normY <= top + h) {
                const sq = useUiStore.getState().searchQuery;
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
            // Skip corner-resize detection for area polygons. The resize
            // handler only updates ann.bbox (not data.vertices), so dragging
            // a corner visually moves an invisible bbox without reshaping
            // the polygon — dead functionality. The label + delete "x" click
            // handler below still runs so delete/edit keep working.
            const selIsAreaPolygon = selAnn.source === "takeoff"
              && (selAnn.data as any)?.type === "area-polygon";

            // Vertex drag for selected area polygons (Bug 2). Runs BEFORE
            // any other click handling so pointer-down near a vertex claims
            // the click and enters drag mode. Uses the same HANDLE size as
            // bbox corner handles.
            if (selIsAreaPolygon) {
              const polyData = selAnn.data as unknown as AreaPolygonData;
              for (let i = 0; i < polyData.vertices.length; i++) {
                const vx = polyData.vertices[i].x * width;
                const vy = polyData.vertices[i].y * height;
                if (pointInHandle(pos, { x: vx, y: vy }, HANDLE)) {
                  e.stopPropagation();
                  if (!beginAnnotationDrag(selAnn, { kind: "vertex", vertexIndex: i })) return;
                  const handle = { annId: selAnn.id, idx: i };
                  setDraggingVertex(handle);
                  setDragging(true);
                  return;
                }
              }
            }

            if (!selIsAreaPolygon) {
              const corners = {
                tl: { x: minX * width, y: minY * height },
                tr: { x: maxX * width, y: minY * height },
                bl: { x: minX * width, y: maxY * height },
                br: { x: maxX * width, y: maxY * height },
              };

              // Check if clicking a corner handle for resize
              for (const [key, corner] of Object.entries(corners)) {
                if (pointInHandle(pos, corner, HANDLE)) {
                  e.stopPropagation();
                  if (!beginAnnotationDrag(selAnn, { kind: "bbox", resizeCorner: key,
                    dragOffset: { x: 0, y: 0 } })) return;
                  setResizeCorner(key);
                  setDragging(true);
                  return;
                }
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
                  const existingCsi = (selAnn.data as { csiCodes?: string[] } | null)?.csiCodes?.[0] ?? "";
                  setMarkupCsi(existingCsi);
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
        // Check area polygons first (point-in-polygon test).
        // A click inside a hole (courtyard cutout) falls through to whatever
        // is underneath — matches the visual since holes render as cutouts.
        for (const ann of pageAnnotations) {
          if (ann.source !== "takeoff" || (ann.data as any)?.type !== "area-polygon") continue;
          const data = ann.data as unknown as AreaPolygonData;
          const clickNorm = { x: pos.x / width, y: pos.y / height };
          if (pointInPolygonWithHoles(clickNorm, data.vertices, data.holes)) {
            e.stopPropagation();
            setSelectedId(ann.id);
            return;
          }
        }
        // Check linear polylines (point-near-line test)
        for (const ann of pageAnnotations) {
          if (ann.source !== "takeoff" || (ann.data as any)?.type !== "linear-polyline") continue;
          const data = ann.data as unknown as LinearPolylineData;
          if (pointNearPolyline(pos, data.vertices, width, height)) {
            e.stopPropagation();
            setSelectedId(ann.id);
            return;
          }
        }
        // Check annotations (bbox-based) — select and start drag
        for (const ann of pageAnnotations) {
          const [minX, minY] = ann.bbox;
          const ax = minX * width;
          const ay = minY * height;
          if (pointInNormalizedBbox(pos, ann.bbox, width, height)) {
            e.stopPropagation();
            // Multi-select layer decides first. In group mode OR pointer mode
            // with a modifier key, this toggles the annotation in the set and
            // skips the default drag/yolo-tag path. Otherwise we fall through
            // to single-select + drag-to-move as before.
            const { handled } = multiSelect.handleAnnotationClick(ann.id, e);
            if (!canAdoptProjectLifecycle()) return;
            if (handled) return;
            // Plain click on a grouped annotation → expand to group siblings.
            // Hook no-ops when ann isn't in any active group.
            multiSelect.expandSelectionViaGroups(ann.id);
            if (!canAdoptProjectLifecycle()) return;
            setSelectedId(ann.id);
            setSearch(ann.name);
            if (!canAdoptProjectLifecycle()) return;
            // If this YOLO annotation matches a known tag, activate it
            if (ann.source === "yolo") {
              const matchingTag = yoloTags.find((t) =>
                t.instances.some((inst) => inst.annotationId === ann.id && inst.pageNumber === pageNumber)
              );
              if (matchingTag) {
                setActiveYoloTagId(matchingTag.id);
                if (!canAdoptProjectLifecycle()) return;
                setYoloTagFilter(matchingTag.id);
                if (!canAdoptProjectLifecycle()) return;
              }
            }
            const nextDragOffset = { x: pos.x - ax, y: pos.y - ay };
            if (!beginAnnotationDrag(ann, { kind: "bbox", resizeCorner: null,
              dragOffset: nextDragOffset })) return;
            setDragging(true);
            setResizeCorner(null);
            setDragOffset(nextDragOffset);
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
            if (!canAdoptProjectLifecycle()) return;
            if (keynote.text) setSearch(keynote.text);
            return;
          }
        }
        // Clicked empty space — deselect, OR start a lasso in Group mode.
        if (toolAtDown.mode === "group") {
          startDeferredDrawing(pos, false);
          // Don't clear the selection here — the lasso is additive.
          return;
        }
        setSelectedId(null);
        multiSelect.clearSelection();
        return;
      }

      // [refactor jul16 P3.2] The markup mousedown blocks (selected corner-resize + label-bar
      // delete, annotation select, empty-canvas deferred-draw start) live in tools/markup.ts now,
      // claimed at the registry seam. Presses reaching this tail are mode "move"/non-markup
      // fallthroughs, which were always inert here.
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- render composites use this exact 37-entry capture.
    [addBucketFillBarrier, addPolygonVertex, canAdoptProjectLifecycle, cancelDeferredDrawing, getPos, height,
      isKeynoteYoloPicking, multiSelect, pageAnnotations, pageKeynotes, pageNumber, persistCreate,
      projectDbId, publicId, publishTransientBucketFillError, publishTransientSplitError, qc,
      saveLinearPolyline, savePolygon, selectedId,
      setActiveYoloTagId, setAnnotationFilter,
      setKeynoteFilter, setPolygonDrawingMode, setSearch, setSplitLineEndpoint,
      setSplitPreview, setTakeoffFilter, setYoloTagFilter, setYoloTagPickingMode,
      showTableCellStructure, startDeferredDrawing, tableCellStructure, takeoffItems,
      toggleCellHighlight, width, yoloTags]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!canAdoptProjectLifecycle()) return;
      // Track cursor for polygon preview (throttled via rAF)
      if (polygonDrawingMode === "drawing") {
        const p = getPos(e);
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          if (canAdoptProjectLifecycle()) setMousePos(p);
        });
      }
      // Read drawing state from store (not subscribed — avoids parent re-render)
      if (useToolStore.getState()._drawing) {
        setDrawEnd(getPos(e));
        return;
      }
      // Ref-owned operation prevents stale React state from lending physics to a successor.
      const annotationDrag = readActiveAnnotationDrag();
      if (!annotationDrag) return;
      if (annotationDrag.operation.kind === "vertex") {
        const pos = getPos(e);
        const ann = pageAnnotations.find((row) => row.id === annotationDrag.annotationId);
        if (!ann) return;
        const data = ann.data as unknown as AreaPolygonData;
        const vertexIndex = annotationDrag.operation.vertexIndex;
        if (!data.vertices || vertexIndex >= data.vertices.length) return;
        const newX = Math.max(0, Math.min(1, pos.x / width));
        const newY = Math.max(0, Math.min(1, pos.y / height));
        const newVertices = data.vertices.map((v, i) =>
          i === vertexIndex ? { x: newX, y: newY } : v,
        );
        // Recompute bbox from new vertices
        const xs = newVertices.map((v) => v.x);
        const ys = newVertices.map((v) => v.y);
        const newBboxVtx: [number, number, number, number] = [
          Math.min(...xs), Math.min(...ys),
          Math.max(...xs), Math.max(...ys),
        ];
        // Recompute net area if this page is calibrated. Subtracts holes.
        let newAreaSqUnits = data.areaSqUnits;
        const cal = scaleCalibrations[ann.pageNumber];
        if (cal) {
          const outerArea = computeRealArea(newVertices, width, height, cal);
          let holesArea = 0;
          for (const hole of data.holes ?? []) {
            if (hole.vertices && hole.vertices.length >= 3) {
              holesArea += computeRealArea(hole.vertices, width, height, cal);
            }
          }
          newAreaSqUnits = Math.max(0, outerArea - holesArea);
        }
        const updatedData = { ...data, vertices: newVertices, areaSqUnits: newAreaSqUnits };
        scheduleAnnotationDragPublish(annotationDrag, {
          kind: "vertex",
          payload: {
            bbox: newBboxVtx,
            data: updatedData as unknown as Record<string, unknown>,
          },
        });
        return;
      }

      if (annotationDrag.operation.kind === "bbox") {
        const pos = getPos(e);
        const ann = pageAnnotations.find((row) => row.id === annotationDrag.annotationId);
        if (!ann) return;
        const [minX, minY, maxX, maxY] = ann.bbox;

        let newBbox: [number, number, number, number];
        const operation = annotationDrag.operation;
        if (operation.resizeCorner) {
          // Resize from corner
          const px = pos.x / width;
          const py = pos.y / height;
          newBbox = [minX, minY, maxX, maxY];
          if (operation.resizeCorner === "tl") newBbox = [px, py, maxX, maxY];
          if (operation.resizeCorner === "tr") newBbox = [minX, py, px, maxY];
          if (operation.resizeCorner === "bl") newBbox = [px, minY, maxX, py];
          if (operation.resizeCorner === "br") newBbox = [minX, minY, px, py];
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
          const newMinX = (pos.x - operation.dragOffset.x) / width;
          const newMinY = (pos.y - operation.dragOffset.y) / height;
          newBbox = [
            Math.max(0, Math.min(newMinX, 1 - w)),
            Math.max(0, Math.min(newMinY, 1 - h)),
            Math.max(0, Math.min(newMinX + w, 1)),
            Math.max(0, Math.min(newMinY + h, 1)),
          ];
        }
        // Throttle store updates to screen refresh rate via rAF
        scheduleAnnotationDragPublish(annotationDrag, {
          kind: "bbox",
          payload: { bbox: newBbox },
        });
      }
    },
    [canAdoptProjectLifecycle, width, height, getPos, pageAnnotations, polygonDrawingMode,
      readActiveAnnotationDrag, scheduleAnnotationDragPublish, setDrawEnd, setMousePos,
      scaleCalibrations]
  );

  const handleMouseUp = useCallback(() => {
    // Exact terminal precedence remains vertex before bbox; both now consume the same generation-
    // owned journal while retaining their distinct `{bbox,data}` / `{bbox}` wire bodies.
    const annotationDrag = readActiveAnnotationDrag();
    if (annotationDrag?.operation.kind === "vertex") {
      finishAnnotationDrag(annotationDrag, true);
      return;
    }
    if (annotationDrag?.operation.kind === "bbox") {
      finishAnnotationDrag(annotationDrag, true);
      return;
    }

    // Read drawing state from store (not subscribed)
    const { _drawing, _drawStart, _drawEnd } = useToolStore.getState();
    const lease = drawingLeaseRef.current;
    if (!_drawing) {
      if (drawingLeaseRef.current === lease) drawingLeaseRef.current = null;
      if (lease) releaseToolTailCancellation(lease.token);
      return;
    }
    // Retire A's local lease before the publication. A subscriber may install B while drawing
    // settles; the exact conditional clear means A cannot erase B on return.
    if (drawingLeaseRef.current === lease) drawingLeaseRef.current = null;
    if (lease) releaseToolTailCancellation(lease.token);
    setDrawing(false);

    // `_drawing` settlement is itself a synchronous publication. A subscriber may admit B there;
    // only the still-current exact gesture token and semantic owner may commit the rectangle.
    if (!lease || !ownsToolTailAuthority(lease.token) ||
        !matchesCanvasGestureLease(lease, readCanvasGestureSnapshot())) return;

    const minX = Math.min(_drawStart.x, _drawEnd.x) / width;
    const minY = Math.min(_drawStart.y, _drawEnd.y) / height;
    const maxX = Math.max(_drawStart.x, _drawEnd.x) / width;
    const maxY = Math.max(_drawStart.y, _drawEnd.y) / height;

    // Minimum size check
    const bbox = [minX, minY, maxX, maxY] as [number, number, number, number];
    if (Math.abs(maxX - minX) < 0.01 || Math.abs(maxY - minY) < 0.01) {
      consumeToolTailAuthority(lease.token, () => {});
      return;
    }

    consumeToolTailAuthority(lease.token, () => {
      const owner = lease.owner;
      if (owner.kind === "baseRect") {
        if (owner.mode === "group") {
          multiSelect.finalizeLasso(pageAnnotations, bbox);
        } else {
          setPendingMarkup(bbox);
          setMarkupName("");
          setMarkupNote("");
          setTimeout(() => nameInputRef.current?.focus(), 50);
        }
        return;
      }

      if (owner.kind === "symbolTemplate") {
        invalidateLatestToolOperation("symbolSession");
        useToolStore.setState((state) => state.activeTool === owner.activation
          ? { symbolSearchTemplateBbox: bbox, symbolSearchSourcePage: lease.pageNumber }
          : state);
        publishSettledSymbolSearchDeactivate(owner.activation);
        return;
      }

      if (owner.kind === "tagAdd") {
        const store = useToolStore.getState();
        if (store.activeTool !== owner.activation) return;
        // Release A before the cache publication so a synchronous cache subscriber's B survives.
        store.setTagAddingMode(null);
        const tag = readYoloTags(qc, lease.publicId).find((item) => item.id === owner.activation.tagId);
        if (tag) {
          updateYoloTag(owner.activation.tagId, {
            instances: [...tag.instances, {
              pageNumber: lease.pageNumber,
              annotationId: -1,
              bbox,
              confidence: 1.0,
            }],
          });
        }
        return;
      }

      switch (owner.activation.flow) {
        case "table":
          if (owner.step === "select-region") acceptTableParseRegion(bbox);
          else if (owner.step === "define-column") addTableParseColumnForUser(bbox);
          else addTableParseRowForUser(bbox);
          return;
        case "keynote":
          if (owner.step === "select-region") acceptKeynoteParseRegion(bbox);
          else if (owner.step === "define-column") addKeynoteColumnForUser(bbox);
          else addKeynoteRowForUser(bbox);
          return;
        case "notes":
          if (owner.step === "select-region") acceptNotesParseRegion(bbox);
          else if (owner.step === "define-column") addGuidedNotesColumnForUser(bbox);
          else addGuidedNotesRowForUser(bbox);
          return;
        case "spec":
          acceptSpecParseRegion(bbox);
          return;
      }
    });
  }, [finishAnnotationDrag, width, height, setDrawing, pageAnnotations, multiSelect, qc,
    readActiveAnnotationDrag, updateYoloTag]);

  const handleDoubleClick = useCallback(() => {
    if (useSessionStore.getState().publicId !== publicId ||
        useViewerCoreStore.getState().pageNumber !== pageNumber) return;
    const initialTool = useToolStore.getState();
    // Close polygon or linear polyline on double-click
    if (initialTool.activeTool?.kind === "takeoffPlacement") {
      if (initialTool.polygonDrawingMode !== "drawing") return;
      invalidateToolTailAuthority();
      const verts = initialTool.polygonVertices;
      // Remove duplicate vertex from the first mousedown of the double-click
      if (verts.length >= 2) {
        const last = verts[verts.length - 1];
        const prev = verts[verts.length - 2];
        if (Math.abs(last.x - prev.x) < 0.005 && Math.abs(last.y - prev.y) < 0.005) {
          undoLastVertex();
        }
      }

      // Determine whether active item is linear or polygon
      const store = useToolStore.getState();
      // [refactor jul10 P2.2④] items via the cache bridge; every OTHER field read on `store`
      // (activeTakeoffItemId, polygonVertices) stays getState — those fields are still zustand.
      // [DETECTOR jul10 closer] publicId freshness rides this callback's savePolygon/
      // saveLinearPolyline deps (both re-create on publicId change), so the closure is never
      // stale across a project switch — same argument as the Enter-keydown bridge read below.
      const activeItem = readTakeoffItems(qc, publicId).find((t) => t.id === store.activeTakeoffItemId);
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

    if (initialTool.activeTool !== null) return;

    // Existing: finalize dragged annotation
    if (dragging && selectedId !== null) {
      invalidateToolTailAuthority();
      setDragging(false);
      setResizeCorner(null);
      saveDragPosition();
    }
  }, [dragging, pageNumber, publicId, qc, saveDragPosition, saveLinearPolyline, savePolygon,
    selectedId, undoLastVertex]);

  // Escape and tool-local keyboard commands always route through the exact live discriminator.
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (!canAdoptProjectLifecycle()) return;
      if (e.key === "Escape") {
        const expectedActiveTool = useToolStore.getState().activeTool;
        cancelDeferredDrawing();
        const tool = useToolStore.getState();
        if (tool.activeTool !== expectedActiveTool) return;
        const activeTool = expectedActiveTool;
        if (activeTool?.kind === "split") {
          if (tool.splitPreview) {
            invalidateToolTailAuthority();
            tool.setSplitPreview(null);
          } else {
            tool.setSplitAreaActive(false);
          }
        } else if (activeTool?.kind === "bucketFill") {
          if (tool.bucketFillPendingPolygon) {
            invalidateToolTailAuthority();
            invalidateLatestToolOperation("bucketFill");
            tool.setBucketFillPendingPolygon(null);
          } else if (tool.bucketFillPreview) {
            invalidateToolTailAuthority();
            invalidateLatestToolOperation("bucketFill");
            tool.setBucketFillPreview(null);
          } else if (tool.bucketFillBarrierMode) {
            invalidateLatestToolOperation("bucketFill");
            tool.setBucketFillBarrierMode(false);
          } else {
            tool.setBucketFillActive(false);
          }
        } else if (activeTool?.kind === "parseRect") {
          if (activeTool.flow === "table") setTableParseStepWithTool("idle", "move");
          else if (activeTool.flow === "keynote") setKeynoteParseStepWithTool("idle", "move");
          else if (activeTool.flow === "notes") setNotesParseStepWithTool("idle", "move");
          else setSpecParseStepWithTool("idle", "move");
        } else if (activeTool?.kind === "takeoffPlacement") {
          if (tool.polygonDrawingMode === "drawing") {
            tool.resetPolygonDrawing();
            if (!canAdoptProjectLifecycle()) return;
            setMousePos(null);
          } else {
            tool.setActiveTakeoffItemId(null);
          }
        } else if (activeTool?.kind === "calibration") {
          tool.resetCalibration();
        } else if (activeTool?.kind === "symbolTemplate") {
          tool.setSymbolSearchActive(false);
        } else if (activeTool?.kind === "tagPick") {
          tool.setYoloTagPickingMode(false);
        } else if (activeTool?.kind === "tagAdd") {
          tool.setTagAddingMode(null);
        }
      }
      // Enter: accept bucket fill preview OR split preview OR close polygon/finish polyline
      if (e.key === "Enter") {
        const store = useToolStore.getState();
        if (store.activeTool?.kind === "split" && store.splitPreview) {
          e.preventDefault();
          invalidateToolTailAuthority();
          acceptSplit();
        } else if (store.activeTool?.kind === "bucketFill" && store.bucketFillPreview) {
          e.preventDefault();
          invalidateToolTailAuthority();
          invalidateLatestToolOperation("bucketFill");
          prepareBucketFillPolygon();
        } else if (store.activeTool?.kind === "takeoffPlacement" &&
                   store.polygonDrawingMode === "drawing") {
          e.preventDefault();
          invalidateToolTailAuthority();
          const verts = store.polygonVertices;
          // [refactor jul10 P2.2④] items via the cache bridge (was store.takeoffItems). publicId
          // freshness rides this effect's savePolygon/saveLinearPolyline deps (both re-create on
          // publicId change), so the listener closure is never stale across a project switch.
          const activeItem = readTakeoffItems(qc, publicId).find((t) => t.id === store.activeTakeoffItemId);
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
        const store = useToolStore.getState();
        if (store.activeTool?.kind === "bucketFill" && !store.bucketFillPreview) {
          e.preventDefault();
          invalidateLatestToolOperation("bucketFill");
          store.setBucketFillBarrierMode(!store.bucketFillBarrierMode);
        }
      }
      // Ctrl+Z: undo last barrier (in barrier mode) or last polygon vertex
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        const store = useToolStore.getState();
        if (store.activeTool?.kind === "bucketFill" && store.bucketFillBarriers.length > 0) {
          e.preventDefault();
          invalidateToolTailAuthority();
          invalidateLatestToolOperation("bucketFill");
          store.undoLastBarrier();
        } else if (store.activeTool?.kind === "takeoffPlacement" &&
                   store.polygonDrawingMode === "drawing") {
          e.preventDefault();
          invalidateToolTailAuthority();
          store.undoLastVertex();
        }
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [acceptSplit, canAdoptProjectLifecycle, cancelDeferredDrawing, prepareBucketFillPolygon,
    publicId, qc, saveLinearPolyline, savePolygon, setMousePos]);

  // Keyboard: Delete/Backspace to delete, Enter to place dragged annotation
  useEffect(() => {
    if (selectedId === null) return;

    function handleKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (!canAdoptProjectLifecycle()) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        invalidateToolTailAuthority();
        if (canPersist(publicId, isDemo) && selectedId! > 0) {
          const deleteId = selectedId!;
          (async () => {
            try {
              await persistFetch(`/api/annotations/${deleteId}`, undefined, "DELETE");
            } catch (err) {
              publishTransientBucketFillError(
                err instanceof Error ? `Failed to delete: ${err.message}` : "Failed to delete annotation",
              );
            }
          })();
        }
        removeAnnotation(selectedId!);
        if (!canAdoptProjectLifecycle()) return;
        setSelectedId(null);
      }

      if (e.key === "Enter") {
        const annotationDrag = readActiveAnnotationDrag();
        if (annotationDrag?.operation.kind === "vertex" ||
            annotationDrag?.operation.kind === "bbox") {
          e.preventDefault();
          invalidateToolTailAuthority();
          finishAnnotationDrag(annotationDrag, true);
        }
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [canAdoptProjectLifecycle, finishAnnotationDrag, isDemo, publicId,
    publishTransientBucketFillError, readActiveAnnotationDrag, removeAnnotation, selectedId]);

  // Exit polygon drawing when switching interaction modes
  const modeCleanupLifecycleRef = useRef(canAdoptProjectLifecycle);
  useEffect(() => {
    const previousLifecycle = modeCleanupLifecycleRef.current;
    modeCleanupLifecycleRef.current = canAdoptProjectLifecycle;
    if (
      previousLifecycle !== canAdoptProjectLifecycle ||
      !canAdoptProjectLifecycle()
    ) return;
    // Atomic specialized entries may deliberately retain a dormant takeoff draft while changing
    // the base mode. Only a true base-mode destination owns this legacy passive cleanup.
    if (
      useToolStore.getState().activeTool === null &&
      useToolStore.getState().polygonDrawingMode === "drawing"
    ) {
      publishSettledPolygonReset();
      if (!canAdoptProjectLifecycle()) return;
      setMousePos(null);
    }
  }, [canAdoptProjectLifecycle, mode, setMousePos]);

  // Reset polygon drawing if active item changes
  const itemCleanupLifecycleRef = useRef(canAdoptProjectLifecycle);
  useEffect(() => {
    const previousLifecycle = itemCleanupLifecycleRef.current;
    itemCleanupLifecycleRef.current = canAdoptProjectLifecycle;
    if (
      previousLifecycle !== canAdoptProjectLifecycle ||
      !canAdoptProjectLifecycle()
    ) return;
    if (useToolStore.getState().polygonDrawingMode === "drawing") {
      publishSettledPolygonReset();
      if (!canAdoptProjectLifecycle()) return;
      setMousePos(null);
    }
  }, [activeTakeoffItemId, canAdoptProjectLifecycle, setMousePos]);

  // Exit polygon drawing when QTO panel closes
  const panelCleanupLifecycleRef = useRef(canAdoptProjectLifecycle);
  useEffect(() => {
    const previousLifecycle = panelCleanupLifecycleRef.current;
    panelCleanupLifecycleRef.current = canAdoptProjectLifecycle;
    if (
      previousLifecycle !== canAdoptProjectLifecycle ||
      !canAdoptProjectLifecycle()
    ) return;
    if (!showTakeoffPanel && useToolStore.getState().polygonDrawingMode === "drawing") {
      publishSettledPolygonReset();
      if (!canAdoptProjectLifecycle()) return;
      setMousePos(null);
    }
  }, [canAdoptProjectLifecycle, setMousePos, showTakeoffPanel]);

  // Create keeps the generic persistCreate policy; edit uses exact cache/wire terminals.
  const saveMarkup = useCallback(() => {
    if (!canAdoptProjectLifecycle()) return;
    if (!pendingMarkup || !markupName.trim()) return;
    if (useViewerCoreStore.getState().pageNumber !== pageNumber) { clearMarkupDialog(); return; }
    const [minX, minY, maxX, maxY] = pendingMarkup;
    const name = markupName.trim();
    const note = markupNote.trim() || null;
    const csi = markupCsi.trim();

    if (editingAnnotationId !== null) {
      const publication = publishMarkupEdit(qc, publicId, pageNumber, editingAnnotationId,
        { name, note, csiCode: csi });
      const ownsLifecycle = publication !== null && canAdoptProjectLifecycle();
      const ownsPage = publication !== null && useViewerCoreStore.getState().pageNumber === publication.pageNumber;
      const ownsWire = publication !== null && ownsLifecycle && ownsPage && isCurrentMarkupEdit(qc, publication);
      if (publication && ownsLifecycle && !ownsPage) rollbackMarkupEdit(qc, publication);
      if (publication && ownsWire && canPersist(publicId, isDemo)) {
        (async () => {
          let response: unknown;
          try {
            response = await persistFetch(
              `/api/annotations/${publication.annotationId}`,
              { name, note, ...(publication.dataForRequest
                ? { data: publication.dataForRequest } : {}) },
              "PUT",
            );
          } catch (err) {
            const rolledBack = canAdoptProjectLifecycle() && rollbackMarkupEdit(qc, publication);
            if (rolledBack && canAdoptProjectLifecycle()) {
              publishTransientBucketFillError(
                err instanceof Error ? `Failed to save markup: ${err.message}` : "Failed to save markup",
              );
            } else retireMarkupEdit(qc, publication);
            return;
          }
          if (canAdoptProjectLifecycle()) enrichMarkupEditFromResponse(qc, publication, response);
          else retireMarkupEdit(qc, publication);
        })();
      } else if (publication) retireMarkupEdit(qc, publication);
    } else {
      const annotationData = csi ? { csiCodes: [csi] } : undefined;
      // [P2.2⑥ C4] Optional draft fields preserve the sparse POST; cache still normalizes them.
      void persistCreate({
        pageNumber,
        name,
        note,
        bbox: [minX, minY, maxX, maxY],
        ...(annotationData ? { data: annotationData } : {}),
      }, {
        canAdopt: canAdoptProjectLifecycle,
        onError: (err) => {
          publishTransientBucketFillError(
            err instanceof Error ? `Failed to save markup: ${err.message}` : "Failed to save markup",
          );
        },
      });
    }

    clearMarkupDialog();
  }, [canAdoptProjectLifecycle, clearMarkupDialog, editingAnnotationId, isDemo, markupCsi, markupName,
    markupNote, pageNumber, pendingMarkup, persistCreate, publicId, publishTransientBucketFillError, qc]);

  // Canvas gates — single source of truth so render-null and pointer-events can't drift.
  // Drift here has caused lasso + markup disappear bugs before (see group-tool fix 2026-04-19).
  const canvasWantsEvents = activeToolKey !== null ||
    (activeToolKey === null && (mode === "markup" || mode === "pointer" || mode === "group"));
  const canvasShouldRender = (
    pageAnnotations.length > 0 ||
    polygonDrawingMode !== "idle" ||
    pendingMarkup !== null ||
    canvasWantsEvents || (showTableCellStructure && tableCellStructure?.pageNumber === pageNumber)
  );
  if (!canvasShouldRender) return null;

  let canvasCursor = "default";
  if (activeToolKey === "split" || activeToolKey === "symbolTemplate" ||
      activeToolKey === "calibration" || activeToolKey === "takeoffPlacement" ||
      activeToolKey === "tagAdd") {
    canvasCursor = "crosshair";
  } else if (activeToolKey === "bucketFill") {
    canvasCursor = bucketFillLoading
      ? "wait"
      : bucketFillBarrierMode
        ? "crosshair"
        : "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24'><path d='M6 6 L18 6 L16 20 L8 20 Z' fill='%2322d3ee' stroke='%23ffffff' stroke-width='1.5' stroke-linejoin='round'/><path d='M6 6 Q12 1 18 6' fill='none' stroke='%2322d3ee' stroke-width='2' stroke-linecap='round'/><circle cx='12' cy='22' r='1' fill='%23ffffff'/></svg>\") 14 24, crosshair";
  } else if (activeToolKey === "tagPick" || isKeynoteYoloPicking) {
    canvasCursor = "pointer";
  } else if (activeToolKey?.startsWith("parseRect:") ||
             (activeToolKey === null && (mode === "markup" || mode === "group"))) {
    canvasCursor = "crosshair";
  }

  function handleMouseLeave() {
    // Cancel the deferred lease before publishing; exact-session finish cannot clear admitted B.
    const expected = readActiveAnnotationDrag();
    cancelDeferredDrawing();
    if (expected) {
      finishAnnotationDrag(expected, false);
      return;
    }
    if (readActiveAnnotationDrag() === null && dragging) {
      setDragging(false);
      setResizeCorner(null);
      setDraggingVertex(null);
    }
  }
  return (
    <>
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onMouseLeave={handleMouseLeave}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: `${width}px`,
          height: `${height}px`,
          pointerEvents: tempPanMode ? "none" : canvasWantsEvents ? "auto" : "none",
          transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
          transformOrigin: "top left",
          willChange: "transform",
          cursor: canvasCursor,
        }}
      />

      {/* Drawing preview layer — reads drawing state from store independently */}
      <DrawingPreviewLayer
        width={width}
        height={height}
        cssScale={cssScale}
      />

      {/* Markup name + notes + CSI dialog */}
      {pendingMarkup && (
        <MarkupDialog
          isEditing={!!editingAnnotationId}
          name={markupName}
          note={markupNote}
          csiCode={markupCsi}
          onNameChange={setMarkupName}
          onNoteChange={setMarkupNote}
          onCsiChange={setMarkupCsi}
          onSave={saveMarkup}
          onCancel={clearMarkupDialog}
        />
      )}
    </>
  );
})
