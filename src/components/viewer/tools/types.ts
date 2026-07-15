import type { MouseEvent as ReactMouseEvent } from "react";

import type { UseAnnotationsResult } from "@/queries/useAnnotations";
import type { useYoloTagActions } from "@/queries/useYoloTags";
import type { ParseFlowState } from "@/stores/parseFlowStore";
import type { SessionState } from "@/stores/sessionStore";
import type { ToolStoreState } from "@/stores/toolStore";
import type { UiState } from "@/stores/uiStore";
import type { ViewerCoreState } from "@/stores/viewerCoreStore";

// [refactor jul15 P3.1] Controller identity is deliberately separate from ActiveTool.kind.
// The activation union has eight owners; takeoff and base interaction expand into 13 ordered
// dispatch units as their legacy branches move behind this strangler boundary.
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

export interface ToolMutationCapabilities {
  readonly annotations: Readonly<
    Pick<
      UseAnnotationsResult,
      | "addAnnotation"
      | "removeAnnotation"
      | "updateAnnotation"
      | "persistCreate"
    >
  >;
  readonly yolo: Readonly<
    Pick<ReturnType<typeof useYoloTagActions>, "updateYoloTag">
  >;
}

/**
 * Shared controller boundary. It is typed in P3.1 but intentionally not materialized until the
 * first controller lands, so the empty registry cannot add cssScale or mutation dependencies to
 * AnnotationOverlay's current mousedown callback.
 */
export interface ToolContext {
  readonly press: ToolPressSnapshot;
  readonly page: Readonly<{
    publicId: string;
    number: number;
    width: number;
    height: number;
  }>;
  readonly cssScale: number;
  readonly stores: Readonly<ToolStoreCapabilities>;
  readonly mutations: Readonly<ToolMutationCapabilities>;
  readonly canAdoptProjectLifecycle: () => boolean;
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
