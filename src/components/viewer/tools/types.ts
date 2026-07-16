import type { MouseEvent as ReactMouseEvent } from "react";

import type { UseAnnotationsResult } from "@/queries/useAnnotations";
import type { useYoloTagActions } from "@/queries/useYoloTags";
import type { ParseFlowState } from "@/stores/parseFlowStore";
import type { SessionState } from "@/stores/sessionStore";
import type { ToolStoreState } from "@/stores/toolStore";
import type { UiState } from "@/stores/uiStore";
import type { ViewerCoreState } from "@/stores/viewerCoreStore";

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
 * Shared controller boundary, materialized since P3.2 (calibration) under the canonical
 * proven-capabilities rule: a field is wired only when a concrete extraction proves it.
 *
 * [refactor jul16 P3.2] cssScale and mutations are OPTIONAL and deliberately unwired:
 * - cssScale: no mousedown path reads it file-wide; closing the factory over the prop would add
 *   a dependency to AnnotationOverlay's mousedown callback (physics contract pins the 37-entry
 *   array byte-identical). The sourcing decision (prop-in-deps / stale-closure / ref) RE-OPENS at
 *   the first controller whose method READS context.cssScale — expected count/markup drawPreview —
 *   and must be decided there on correctness grounds (DR010 Q4 / PERF-1).
 * - mutations: addAnnotation/removeAnnotation/updateAnnotation/updateYoloTag are hook-returned and
 *   absent from the mousedown dependency array; wiring them eagerly would churn the sacred handler
 *   identity. RE-OPENS at markup (first addAnnotation prover) with a dep-neutral sourcing.
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
