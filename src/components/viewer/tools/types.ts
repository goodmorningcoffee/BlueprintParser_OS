import type { MouseEvent as ReactMouseEvent } from "react";
import type { QueryClient } from "@tanstack/react-query";

import type { UseAnnotationsResult } from "@/queries/useAnnotations";
import type {
  ClientAnnotation,
  ClientTakeoffItem,
  KeynoteShapeData,
  YoloTag,
} from "@/types";
import type { ParseFlowState } from "@/stores/parseFlowStore";
import type { SessionState } from "@/stores/sessionStore";
import type { ToolStoreState } from "@/stores/toolStore";
import type { UiState } from "@/stores/uiStore";
import type { ViewerCoreState } from "@/stores/viewerCoreStore";
import type { AnnotationDragOperation } from "../useAnnotationDragMachine";

// [refactor jul15 P3.1] Controller identity is deliberately separate from ActiveTool.kind.
// The activation union has eight owners; takeoff, the parseRect keynote-pick split, and base
// interaction expand into 13 ordered dispatch units as their legacy branches move behind this
// strangler boundary.
export type ToolControllerKind =
  | "calibration"
  | "split"
  | "bucketFill"
  | "takeoffPolygon"
  | "takeoffLinear"
  | "takeoffCount"
  | "keynotePick"
  | "tagPick"
  | "symbolSearch"
  | "tagAdd"
  | "parseRect"
  | "pointerGroup"
  | "markup";

/** One immutable view of the already-admitted canvas press. */
export interface ToolPressSnapshot {
  readonly toolAtDown: Readonly<ToolStoreState>;
  readonly position: Readonly<{ x: number; y: number }>;
  readonly publicId: string;
  readonly pageNumber: number;
}

/** Imperative reader only: controllers must never subscribe through ToolContext. */
export interface ToolStoreReader<State> {
  getState(): State;
}

export interface ToolStoreCapabilities {
  readonly session: ToolStoreReader<SessionState>;
  readonly viewerCore: ToolStoreReader<ViewerCoreState>;
  readonly tool: ToolStoreReader<ToolStoreState>;
  readonly parseFlow: ToolStoreReader<ParseFlowState>;
  readonly ui: ToolStoreReader<UiState>;
}

/**
 * [refactor jul17 P3.2 takeoffCount] NARROWED to the proven slice (proven-capabilities rule):
 * takeoffCount is the sole raw-mutation caller in the legacy mousedown and it calls ONLY
 * persistCreate — which is already in the 37-entry mousedown dependency array, so the wiring is
 * dep-neutral. The speculative P3.1 members are deliberately dropped, each with a re-open note:
 * - addAnnotation / removeAnnotation / updateAnnotation were RE-OPENED and resolved at
 *   pointerGroup without widening this capability: delete remains behind the captured
 *   deleteSelected composite and drag mutation remains behind the annotation-drag machine.
 * - updateYoloTag remains in shared TagAdd mouseup under ACCEPT-PARTIAL; its capability decision
 *   RE-OPENS only when that lifecycle axis moves (P3.4/BUILD-AXIS). TagPick needs no annotation
 *   mutation capability.
 */
export interface ToolMutationCapabilities {
  readonly annotations: Readonly<Pick<UseAnnotationsResult, "persistCreate">>;
}

/**
 * Shared controller boundary, materialized since P3.2 (calibration) under the canonical
 * proven-capabilities rule: a field is wired only when a concrete extraction proves it.
 *
 * [refactor jul16 P3.2] cssScale is OPTIONAL and deliberately unwired:
 * - cssScale: no mousedown path reads it file-wide; closing the factory over the prop would add
 *   a dependency to AnnotationOverlay's mousedown callback (physics contract pins the 37-entry
 *   array byte-identical). The sourcing decision (prop-in-deps / stale-closure / ref) RE-OPENS at
 *   the first controller whose method READS context.cssScale — expected count/markup drawPreview —
 *   and must be decided there on correctness grounds (DR010 Q4 / PERF-1).
 * - mutations: [refactor jul17 P3.2 takeoffCount] PROVEN and wired, narrowed to the persistCreate
 *   slice (see ToolMutationCapabilities note — the markup extraction established that composite
 *   component closures like deleteSelected ride their own capability instead). Optional-typed so
 *   synthetic contexts and pre-takeoffCount tests stay legal; the overlay factory always wires it.
 */
export interface ToolContext {
  readonly press: ToolPressSnapshot;
  readonly page: Readonly<{
    publicId: string;
    number: number;
    width: number;
    height: number;
  }>;
  readonly cssScale?: number;
  readonly stores: Readonly<ToolStoreCapabilities>;
  readonly mutations?: Readonly<ToolMutationCapabilities>;
  readonly canAdoptProjectLifecycle: () => boolean;
  /**
   * [refactor jul16 P3.2 markup] Capabilities PROVEN by the markup controller. Optional-typed
   * (like cssScale) so synthetic contexts and pre-markup tests stay legal; AnnotationOverlay's
   * factory always wires all three. Dep-neutral by construction: selectedId / pageAnnotations /
   * startDeferredDrawing were already in the 37-entry mousedown dependency array; the three
   * setters are stable useState setters; deleteSelected is the same per-render closure the legacy
   * handler already captured (its definition stays in the overlay; pointerGroupController calls it).
   */
  readonly selection?: Readonly<{
    selectedId: number | null;
    setSelectedId: (id: number | null) => void;
    setResizeCorner: (corner: string | null) => void;
    setDragging: (dragging: boolean) => void;
    deleteSelected: () => void;
  }>;
  /** Component-owned drag journal; proven by markup's selected-corner start path. */
  readonly annotationDrag?: Readonly<{
    begin: (
      annotation: ClientAnnotation,
      operation: AnnotationDragOperation,
    ) => boolean;
    beginBBox: (annotation: ClientAnnotation, resizeCorner: string) => boolean;
  }>;
  readonly pageAnnotations?: readonly ClientAnnotation[];
  readonly deferredDrawing?: Readonly<{
    start: (pos: { x: number; y: number }, clearSelection?: boolean) => boolean;
  }>;
  /**
   * [refactor jul18 P3.2 keynotePick] The exact AnnotationOverlay RENDER projection derived
   * from its conditional keynote subscriptions. This is deliberately not recomputed from
   * stores.parseFlow at invocation time: the render-captured timing and candidate projection are
   * part of the legacy picker contract. Optional so an inactive split guard can decline before
   * requiring picker-only context and existing synthetic contexts remain legal.
   */
  readonly keynotePick?: Readonly<{
    active: boolean;
  }>;
  /**
   * [refactor jul18 P3.2 tagPick] Component-owned scan request journal plus the exact subscribed
   * picker action. The ref object itself crosses the seam so request identity remains local to
   * this mounted overlay; only the outer capability properties are readonly (`current` must stay
   * mutable). Both members are already captured by the legacy handler, so wiring is dep-neutral.
   */
  readonly tagPick?: Readonly<{
    scanControllerRef: { current: AbortController | null };
    setPickingMode: ToolStoreState["setYoloTagPickingMode"];
  }>;
  /**
   * [refactor jul19 P3.2 Split] Exact subscribed endpoint/preview commands plus Split's own
   * two-argument transient-error publisher. Optional so the preview-open terminal can stay lean
   * and synthetic contexts for other controllers need not wire Split-only commands. Every member
   * was already captured by the legacy mousedown callback, so the factory remains dep-neutral.
   */
  readonly split?: Readonly<{
    setLineEndpoint: ToolStoreState["setSplitLineEndpoint"];
    setPreview: ToolStoreState["setSplitPreview"];
    publishError: (message: string, delayMs?: number) => void;
  }>;
  /**
   * [refactor jul19 P3.2 BucketFill] Observer-free cache authority, exact render DB identity, and
   * the captured barrier composite proven by the BucketFill mousedown controller. Optional so
   * first-point/busy/preview/pending terminals and synthetic peer contexts stay capability-cold.
   * All three identifiers already belong to the sacred 37-entry callback dependency block.
   */
  readonly bucketFill?: Readonly<{
    queryClient: QueryClient;
    projectDbId: number;
    addBarrier: ToolStoreState["addBucketFillBarrier"];
  }>;
  /**
   * [refactor jul17 P3.2 takeoffCount] Capabilities PROVEN by the takeoffCount controller,
   * optional-typed like the markup trio; the overlay factory always wires both. Dep-neutral by
   * construction: takeoffItems and publishTransientBucketFillError are already in the 37-entry
   * mousedown dependency array.
   * - takeoffItems is the COMPONENT render array (useTakeoffItems), byte-identical staleness to
   *   the legacy closure read (D1-class one-macrotask refresh lag, sanctioned) — NOT a fresh
   *   readTakeoffItems cache bridge, which would be a freshness behavior change.
   * - transientError.publish is the overlay's publishTransientBucketFillError: the bucket-fill
   *   error channel doubles as the viewer's generic transient toast; the marker-specific text
   *   lives in the controller.
   */
  readonly takeoffItems?: readonly ClientTakeoffItem[];
  readonly transientError?: Readonly<{
    publish: (message: string) => void;
  }>;
  /**
   * [refactor jul17 P3.2 takeoffLinear] Capability PROVEN by the takeoffLinear controller,
   * optional-typed like the markup/takeoffCount groups; the overlay factory always wires it.
   * Dep-neutral by construction: all members are already in the 37-entry mousedown
   * dependency array.
   * - setPolygonDrawingMode / addPolygonVertex are the overlay's SUBSCRIBED zustand action
   *   bindings — actions are defined once in the store's create(), so these are the SAME
   *   function objects `stores.tool.getState()` would return. They ride a capability instead of
   *   the store reader because contract §4.3 types `stores` as imperative getState() READERS;
   *   routing commands through the reader would widen that contract for every future reviewer.
   * - saveLinearPolyline is the per-render useCallback COMPOSITE (optimistic persistCreate +
   *   settled polygon reset + mouse-position clear); its definition STAYS in the overlay — the
   *   Enter-keydown and double-click finish paths still call it there (deleteSelected
   *   precedent: the moved call site rides the capability, the closure stays home).
   * - savePolygon [refactor jul17 P3.2 takeoffPolygon]: the recorded re-open, fulfilled — the
   *   polygon COMPOSITE twin of saveLinearPolyline under the exact same contract (definition
   *   stays in the overlay; Enter/dblclick close paths still call it there; only the mousedown
   *   close site moved into the controller).
   */
  readonly takeoffDrawing?: Readonly<{
    setPolygonDrawingMode: ToolStoreState["setPolygonDrawingMode"];
    addPolygonVertex: ToolStoreState["addPolygonVertex"];
    saveLinearPolyline: () => void;
    savePolygon: () => void;
  }>;
  /**
   * [refactor jul19 P3.2 PointerGroup] Exact render-captured projections and component-local
   * commands proven by the base Pointer/Group mousedown board. Query authority is included for
   * handler-time observer-free PI/Textract reads; it is deliberately distinct from BucketFill's
   * semantic cache capability. Every changing factory value was already represented by the
   * sacred 37-entry callback dependency block; setters and refs are stable.
   */
  readonly pointerGroup?: Readonly<{
    queryClient: QueryClient;
    tableCellStructure: ParseFlowState["tableCellStructure"];
    showTableCellStructure: boolean;
    toggleCellHighlight: ParseFlowState["toggleCellHighlight"];
    pageKeynotes: readonly KeynoteShapeData[];
    yoloTags: readonly YoloTag[];
    multiSelect: Readonly<{
      handleAnnotationClick: (
        id: number,
        event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
      ) => Readonly<{ handled: boolean }>;
      expandSelectionViaGroups: (id: number) => void;
      clearSelection: () => void;
    }>;
    ui: Readonly<Pick<UiState,
      | "setSearch"
      | "setAnnotationFilter"
      | "setTakeoffFilter"
      | "setKeynoteFilter"
      | "setActiveYoloTagId"
      | "setYoloTagFilter"
    >>;
    dragUi: Readonly<{
      setDraggingVertex: (
        handle: Readonly<{ annId: number; idx: number }> | null,
      ) => void;
      setDragOffset: (offset: Readonly<{ x: number; y: number }>) => void;
    }>;
    markupEdit: Readonly<{
      canvasRef: Readonly<{ current: HTMLCanvasElement | null }>;
      nameInputRef: Readonly<{ current: HTMLInputElement | null }>;
      setPendingMarkup: (
        bbox: [number, number, number, number] | null,
      ) => void;
      setMarkupName: (value: string) => void;
      setMarkupNote: (value: string) => void;
      setMarkupCsi: (value: string) => void;
      setEditingAnnotationId: (id: number | null) => void;
    }>;
  }>;
}

export interface ToolController {
  readonly kind: ToolControllerKind;
  /** Eligibility only. Returning true does not consume the event. */
  matches(press: ToolPressSnapshot): boolean;
  /** The explicit claim: true stops registry and legacy fallthrough. */
  onMouseDown(event: ReactMouseEvent, context: ToolContext): boolean;
  onMouseMove?(event: ReactMouseEvent, context: ToolContext): void;
  onMouseUp?(event: ReactMouseEvent, context: ToolContext): void;
  onDblClick?(event: ReactMouseEvent, context: ToolContext): boolean;
  onKey?(event: KeyboardEvent, context: ToolContext): boolean;
  onPageChange?(context: ToolContext): void;
  drawPreview?(canvas: CanvasRenderingContext2D, context: ToolContext): void;
  /** Render-time canvas gate; unlike event handlers, this cannot require a press position. */
  wantsEvents(state: Readonly<ToolStoreState>): boolean;
}
