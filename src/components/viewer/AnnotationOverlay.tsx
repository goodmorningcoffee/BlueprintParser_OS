"use client";

import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
// [refactor jul10 P2.2④] takeoff items: zustand → TanStack cache. This SACRED file gets (a) the
// useTakeoffItems hook (data only) replacing the raw selector, and (b) readTakeoffItems(qc,
// publicId) — a SYNCHRONOUS live-cache read — replacing the 7 handler/effect-time
// getState().takeoffItems reads. The draw effect's dep array deliberately EXCLUDES takeoffItems
// (item edits do not redraw the canvas today); the bridge preserves that — do NOT add the hook
// value or a dep there (TAKEOFF_IMPL/SPEC.md §3.3 :372 row).
import { useQueryClient } from "@tanstack/react-query";
import { commitAnnotationSplit } from "@/queries/annotationSplit";
import { useTakeoffItems, readTakeoffItems } from "@/queries/useTakeoff";
import { enrichMarkupEditFromResponse, isCurrentMarkupEdit, publishMarkupEdit, retireMarkupEdit, rollbackMarkupEdit, useAnnotations } from "@/queries/useAnnotations";
import { useKeynotesForPage } from "@/queries/usePageWindow";
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
  setKeynoteParseStepWithTool,
  setNotesParseStepWithTool,
  setSpecParseStepWithTool,
  setTableParseStepWithTool,
} from "@/stores/viewerCommands";
import { useProject, useSessionStore } from "@/stores/sessionStore";
import { AREA_UNIT_MAP } from "@/types";
import type { ClientAnnotation, TakeoffShape, AreaPolygonData, LinearPolylineData } from "@/types";
import { annotationLabelColor as labelColor } from "@/lib/annotation-label-color";
import type { ScoredMatch } from "@/lib/tag-mapping";
import { captureCanvasGestureLease, matchesCanvasGestureLease, selectActiveToolKey, type CanvasGestureLease, type CanvasGestureSnapshot } from "@/lib/active-tool-state";
import {
  cancelToolTailExact,
  claimToolTailAuthority,
  consumeToolTailAuthority,
  invalidateLatestToolOperation,
  invalidateToolTailAuthority,
  ownsToolTailAuthority,
  registerToolTailCancellation,
  releaseToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { computeRealArea, computePolylineLength, computePixelsPerUnit } from "@/lib/areaCalc";
import { getOcrTextInAnnotation, mapYoloToOcrText } from "@/lib/yolo-tag-engine";
import { persistFetch, canPersist } from "@/lib/client-persist";
import { captureProjectLifecycle } from "@/lib/project-lifecycle";
import DrawingPreviewLayer from "./DrawingPreviewLayer";
import MarkupDialog from "./MarkupDialog";
import { drawActiveTagInstances } from "./render/activeTagInstances";
import { drawAreaPolygons } from "./render/areaPolygons";
import { drawExistingAnnotations } from "./render/existingAnnotations";
import { drawGroupRings } from "./render/groupRings";
import { drawLinearPolylines } from "./render/linearPolylines";
import { drawLlmHighlight } from "./render/llmHighlight";
import { drawSymbolSearchResults } from "./render/symbolSearchResults";
import { drawTableCellStructure } from "./render/tableCellStructure";
import { drawTableTagViews } from "./render/tableTagViews";
import { drawVisibleTagInstances } from "./render/visibleTagInstances";
import { admitAnnotationSplit } from "./splitAcceptance";
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

const EMPTY_KEYNOTE_COLUMN_BBS: [number, number, number, number][] = [];

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
  // Durable Split admission must retain the lifecycle that owned this render. Capturing later in
  // the key handler could let an old callback borrow a same-publicId successor generation.
  const renderedProjectLifecycle = captureProjectLifecycle(qc);
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
  // C4 converges five one-row create paths onto persistCreate; Split retains the local facade
  // actions while durable work delegates to its atomic command. The subscription remains data-only.
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
    drawExistingAnnotations(ctx, {
      annotations: pageAnnotations,
      width,
      height,
      selectedId,
      hiddenTakeoffItemIds,
      selection: multiSelect,
      activeTag,
      activeTagAnnotationIds: activeTagAnnIds,
      symbolSearchResults,
      cssScale,
      getLabelColor: labelColor,
      getTakeoffItems: () => readTakeoffItems(qc, publicId),
    });

    // ─── Draw free-floating active tag instances (annotationId = -1, not in annotation loop) ───
    drawActiveTagInstances(ctx, {
      activeTag,
      pageTagInstances,
      width,
      height,
    });

    // ─── Draw visible tag instances (not the active tag) ───
    drawVisibleTagInstances(ctx, {
      visibleTagInstances,
      width,
      height,
    });

    // Draw in-progress rectangle (markup or table parse or symbol search)
    // Drawing preview (BB rectangle, polygon, calibration) — rendered by DrawingPreviewLayer

    // Draw symbol search results on current page
    drawSymbolSearchResults(ctx, {
      symbolSearchResults,
      pageNumber,
      symbolSearchConfidence,
      dismissedSymbolMatches,
      width,
      height,
    });

    // Draw TATR cell structure overlays
    drawTableCellStructure(ctx, {
      tableCellStructure,
      pageNumber,
      showTableCellStructure,
      width,
      height,
    });

    // Draw LLM tool use highlight (pulsing dashed cyan rectangle)
    drawLlmHighlight(ctx, {
      llmHighlight,
      pageNumber,
      width,
      height,
    });

    // Draw active table/keynote tag views
    drawTableTagViews(ctx, {
      activeTableTagViews,
      pageNumber,
      width,
      height,
      tagTextIndex,
      pageTagInstances,
    });

    // Draw completed area polygons
    drawAreaPolygons(ctx, {
      annotations: pageAnnotations,
      width,
      height,
      selectedId,
      hiddenTakeoffItemIds,
      selection: multiSelect,
    });

    // Draw completed linear polylines
    drawLinearPolylines(ctx, {
      annotations: pageAnnotations,
      width,
      height,
      selectedId,
      hiddenTakeoffItemIds,
      selection: multiSelect,
    });

    // Group-membership outlines — one pass after all shape-specific loops.
    drawGroupRings(ctx, {
      annotations: pageAnnotations,
      width,
      height,
      getGroupOutlineColor: multiSelect.getGroupOutlineColor,
    });

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
    if (!activeItem || activeItem.shape !== "polygon") return;

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

  /** Accept a pending Split Area preview through the exact server-first admission leaf. */
  const acceptSplit = useCallback(() => {
    const admitted = admitAnnotationSplit({
      queryClient: qc,
      publicId,
      isDemo,
      pageNumber,
      lifecycle: renderedProjectLifecycle,
      calibration: scaleCalibrations[pageNumber],
      width,
      height,
      canAdoptProjectLifecycle,
      publishError: publishTransientSplitError,
      addAnnotation,
      updateAnnotation,
    });
    if (!admitted) return;
    void commitAnnotationSplit(qc, admitted.target, admitted.request)
      .then(admitted.settle)
      .catch(admitted.reject);
  }, [addAnnotation, canAdoptProjectLifecycle, height, isDemo, pageNumber,
    publicId, publishTransientSplitError, qc, renderedProjectLifecycle,
    scaleCalibrations, updateAnnotation, width]);

  /** Save the current in-progress polyline as a linear-polyline annotation */
  const saveLinearPolyline = useCallback(() => {
    if (!canAdoptProjectLifecycle()) return;
    const verts = useToolStore.getState().polygonVertices;
    // [refactor jul10 P2.2④] handler-time sync read via the cache bridge (was getState).
    const items = readTakeoffItems(qc, publicId);
    const activeId = useToolStore.getState().activeTakeoffItemId;
    if (verts.length < 2) return;

    const activeItem = items.find((t) => t.id === activeId);
    if (!activeItem || activeItem.shape !== "linear") return;

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
      // this handler already captured for pointerGroupController's delete-x path.
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
            begin: beginAnnotationDrag,
            beginBBox: (annotation, corner) => beginAnnotationDrag(
              annotation, { kind: "bbox", resizeCorner: corner, dragOffset: { x: 0, y: 0 } },
            ),
          },
          pageAnnotations,
          pointerGroup: {
            queryClient: qc,
            tableCellStructure,
            showTableCellStructure,
            toggleCellHighlight,
            pageKeynotes,
            yoloTags,
            multiSelect: {
              handleAnnotationClick: multiSelect.handleAnnotationClick,
              expandSelectionViaGroups: multiSelect.expandSelectionViaGroups,
              clearSelection: multiSelect.clearSelection,
            },
            ui: {
              setSearch,
              setAnnotationFilter,
              setTakeoffFilter,
              setKeynoteFilter,
              setActiveYoloTagId,
              setYoloTagFilter,
            },
            dragUi: { setDraggingVertex, setDragOffset },
            markupEdit: {
              canvasRef,
              nameInputRef,
              setPendingMarkup,
              setMarkupName,
              setMarkupNote,
              setMarkupCsi,
              setEditingAnnotationId,
            },
          },
          deferredDrawing: { start: startDeferredDrawing },
          keynotePick: { active: isKeynoteYoloPicking },
          tagPick: {
            scanControllerRef: tagScanControllerRef,
            setPickingMode: setYoloTagPickingMode,
          },
          split: {
            setLineEndpoint: setSplitLineEndpoint,
            setPreview: setSplitPreview,
            publishError: publishTransientSplitError,
          },
          bucketFill: {
            queryClient: qc,
            projectDbId,
            addBarrier: addBucketFillBarrier,
          },
          mutations: { annotations: { persistCreate } },
          transientError: { publish: publishTransientBucketFillError },
          takeoffItems,
          takeoffDrawing: { setPolygonDrawingMode, addPolygonVertex, saveLinearPolyline, savePolygon },
        }))
      ) {
        return;
      }

      // ─── Specialized owners have already dispatched ───────────────
      // The shared non-null guard below prevents specialized-to-base fallthrough.

      // [refactor jul18 P3.2] keynotePick + tagPick hit/miss routing, generic parseRect deferred
      // starts, and symbolSearch + tagAdd starts are claimed at the registry seam. Conditional
      // subscriptions, filtering, request identity, and complete drawing settlement stay local.

      // Every non-null specialized owner suppresses base pointer/group/markup fallthrough.
      if (activeTool !== null) return;
      invalidateToolTailAuthority();

      // Pointer/Group mousedown is claimed by pointerGroupController at the registry seam.
      // Shared move/up, lasso finalization, keyboard, render, and dialog owners remain local.
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
        const splitAtEscape = useToolStore.getState();
        if (
          splitAtEscape.activeTool?.kind === "split" &&
          splitAtEscape.splitPreview?.commitPending === true
        ) return;
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
          if (store.splitPreview.commitPending === true) return;
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
