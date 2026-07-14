// [refactor jul13 P2.3 AT2] Dependency-free causal model adopted atomically by toolStore,
// cross-store commands, and canvas consumers after its production-dead AT1 proof.

export type TableLikeParseStep =
  | "idle"
  | "select-region"
  | "define-column"
  | "define-row"
  | "review";
export type SpecParseStep = "idle" | "select-region" | "define-sections" | "review";
export type ParseStepByFlow = Readonly<{
  table: TableLikeParseStep;
  keynote: TableLikeParseStep;
  notes: TableLikeParseStep;
  spec: SpecParseStep;
}>;
export type ParseRectFlow = keyof ParseStepByFlow;
export type ParseDrawingStep = "select-region" | "define-column" | "define-row";
export type ParseDrawingStepByFlow = Readonly<{
  table: ParseDrawingStep;
  keynote: ParseDrawingStep;
  notes: ParseDrawingStep;
  spec: "select-region";
}>;
export type BaseInteractionMode = "move" | "pointer" | "markup" | "group";

export type ActiveTool =
  | { kind: "calibration" }
  | { kind: "takeoffPlacement" }
  | { kind: "bucketFill" }
  | { kind: "split" }
  | { kind: "symbolTemplate" }
  | { kind: "tagPick" }
  | { kind: "tagAdd"; tagId: string }
  | { kind: "parseRect"; flow: "table" | "keynote" | "notes" | "spec" }
  | null;

export type ActiveToolObject = Exclude<ActiveTool, null>;
export type ActiveToolKey =
  | "calibration"
  | "takeoffPlacement"
  | "bucketFill"
  | "split"
  | "symbolTemplate"
  | "tagPick"
  | "tagAdd"
  | `parseRect:${ParseRectFlow}`
  | null;

export type ActiveToolProjection = Readonly<{
  activeTool: ActiveTool;
  activeTakeoffItemId: number | null;
}>;

type ParseStepIntent = {
  [F in ParseRectFlow]: { type: "setParseStep"; flow: F; step: ParseStepByFlow[F] };
}[ParseRectFlow];

export type ActiveToolIntent =
  | { type: "setMode"; mode: BaseInteractionMode }
  | { type: "selectTakeoff"; itemId: number | null }
  | { type: "setCalibrationMode"; mode: "idle" | "point1" | "point2" | "input" }
  | { type: "setBucketFill"; active: boolean }
  | { type: "setSplit"; active: boolean }
  | { type: "setSymbolTemplate"; active: boolean }
  | { type: "setTagPick"; active: boolean }
  | { type: "setTagAdd"; tagId: string | null }
  | ParseStepIntent;

type SymbolActivation = Extract<ActiveToolObject, { kind: "symbolTemplate" }>;
type TagAddActivation = Extract<ActiveToolObject, { kind: "tagAdd" }>;
type ParseGestureOwner = {
  [F in ParseRectFlow]: {
    kind: "parseRect";
    activation: { kind: "parseRect"; flow: F };
    step: ParseDrawingStepByFlow[F];
  };
}[ParseRectFlow];

function hasParseRectFlow<F extends ParseRectFlow>(
  activation: Extract<ActiveToolObject, { kind: "parseRect" }>,
  flow: F,
): activation is { kind: "parseRect"; flow: F } {
  return activation.flow === flow;
}

export type CanvasGestureOwner =
  | { kind: "baseRect"; mode: "markup" | "group" }
  | { kind: "symbolTemplate"; activation: SymbolActivation }
  | { kind: "tagAdd"; activation: TagAddActivation }
  | ParseGestureOwner;

export type CanvasGestureSnapshot = Readonly<{
  activeTool: ActiveTool;
  mode: BaseInteractionMode;
  parseSteps: ParseStepByFlow;
  publicId: string;
  pageNumber: number;
}>;

export type CanvasGestureLease<T extends object = object> = Readonly<{
  token: T;
  owner: CanvasGestureOwner;
  publicId: string;
  pageNumber: number;
}>;

function assertNever(value: never): never {
  throw new Error(`Unhandled active tool value: ${JSON.stringify(value)}`);
}

export function selectActiveToolKey(state: { activeTool: ActiveTool }): ActiveToolKey {
  const activeTool = state.activeTool;
  if (activeTool === null) return null;
  switch (activeTool.kind) {
    case "calibration":
    case "takeoffPlacement":
    case "bucketFill":
    case "split":
    case "symbolTemplate":
    case "tagPick":
      return activeTool.kind;
    case "tagAdd":
      return "tagAdd";
    case "parseRect":
      return `parseRect:${activeTool.flow}`;
    default:
      return assertNever(activeTool);
  }
}

export function selectActiveTagId(state: { activeTool: ActiveTool }): string | null {
  return state.activeTool?.kind === "tagAdd" ? state.activeTool.tagId : null;
}

export function isDrawCapableParseStep<F extends ParseRectFlow>(
  flow: F,
  step: ParseStepByFlow[F],
): step is ParseDrawingStepByFlow[F] {
  return step === "select-region" ||
    (flow !== "spec" && (step === "define-column" || step === "define-row"));
}

export function takeoffPlacementFallback(activeTakeoffItemId: number | null): ActiveTool {
  return activeTakeoffItemId === null ? null : { kind: "takeoffPlacement" };
}

export function activeToolReleaseFallback(
  current: ActiveToolObject,
  activeTakeoffItemId: number | null,
): ActiveTool {
  switch (current.kind) {
    case "calibration":
    case "bucketFill":
    case "symbolTemplate":
      return takeoffPlacementFallback(activeTakeoffItemId);
    case "takeoffPlacement":
    case "split":
    case "tagPick":
    case "tagAdd":
    case "parseRect":
      return null;
    default:
      return assertNever(current);
  }
}

export function transitionActiveTool(
  state: ActiveToolProjection,
  intent: ActiveToolIntent,
): ActiveTool {
  const current = state.activeTool;
  switch (intent.type) {
    case "setMode":
      return null;
    case "selectTakeoff":
      if (intent.itemId !== null) return { kind: "takeoffPlacement" };
      return current?.kind === "takeoffPlacement" ? null : current;
    case "setCalibrationMode":
      if (intent.mode !== "idle") return { kind: "calibration" };
      return current?.kind === "calibration"
        ? activeToolReleaseFallback(current, state.activeTakeoffItemId)
        : current;
    case "setBucketFill":
      if (intent.active) return { kind: "bucketFill" };
      return current?.kind === "bucketFill"
        ? activeToolReleaseFallback(current, state.activeTakeoffItemId)
        : current;
    case "setSplit":
      if (intent.active) return { kind: "split" };
      return current?.kind === "split" ? null : current;
    case "setSymbolTemplate":
      if (intent.active) return { kind: "symbolTemplate" };
      return current?.kind === "symbolTemplate"
        ? activeToolReleaseFallback(current, state.activeTakeoffItemId)
        : current;
    case "setTagPick":
      if (intent.active) return { kind: "tagPick" };
      return current?.kind === "tagPick" ? null : current;
    case "setTagAdd":
      if (intent.tagId !== null) return { kind: "tagAdd", tagId: intent.tagId };
      return current?.kind === "tagAdd" ? null : current;
    case "setParseStep":
      if (isDrawCapableParseStep(intent.flow, intent.step)) {
        return { kind: "parseRect", flow: intent.flow };
      }
      return current?.kind === "parseRect" && current.flow === intent.flow ? null : current;
    default:
      return assertNever(intent);
  }
}

export function releaseActiveToolExact(
  current: ActiveTool,
  expected: ActiveToolObject,
  activeTakeoffItemId: number | null,
): ActiveTool {
  return current === expected
    ? activeToolReleaseFallback(expected, activeTakeoffItemId)
    : current;
}

export function activeToolAfterPageChange(state: ActiveToolProjection): ActiveTool {
  const current = state.activeTool;
  if (current === null) return null;
  switch (current.kind) {
    case "takeoffPlacement":
      return state.activeTakeoffItemId === null ? null : current;
    case "tagPick":
    case "tagAdd":
      return current;
    case "calibration":
    case "bucketFill":
    case "symbolTemplate":
      return takeoffPlacementFallback(state.activeTakeoffItemId);
    case "split":
      return null;
    case "parseRect":
      return current.flow === "notes" || current.flow === "spec" ? current : null;
    default:
      return assertNever(current);
  }
}

export function resolveCanvasGestureOwner(
  snapshot: CanvasGestureSnapshot,
): CanvasGestureOwner | null {
  const activeTool = snapshot.activeTool;
  if (activeTool === null) {
    return snapshot.mode === "markup" || snapshot.mode === "group"
      ? { kind: "baseRect", mode: snapshot.mode }
      : null;
  }
  switch (activeTool.kind) {
    case "symbolTemplate":
      return { kind: "symbolTemplate", activation: activeTool };
    case "tagAdd":
      return { kind: "tagAdd", activation: activeTool };
    case "parseRect": {
      if (hasParseRectFlow(activeTool, "table")) {
        const step = snapshot.parseSteps.table;
        return isDrawCapableParseStep("table", step)
          ? { kind: "parseRect", activation: activeTool, step }
          : null;
      }
      if (hasParseRectFlow(activeTool, "keynote")) {
        const step = snapshot.parseSteps.keynote;
        return isDrawCapableParseStep("keynote", step)
          ? { kind: "parseRect", activation: activeTool, step }
          : null;
      }
      if (hasParseRectFlow(activeTool, "notes")) {
        const step = snapshot.parseSteps.notes;
        return isDrawCapableParseStep("notes", step)
          ? { kind: "parseRect", activation: activeTool, step }
          : null;
      }
      if (hasParseRectFlow(activeTool, "spec")) {
        const step = snapshot.parseSteps.spec;
        return isDrawCapableParseStep("spec", step)
          ? { kind: "parseRect", activation: activeTool, step }
          : null;
      }
      return null;
    }
    case "calibration":
    case "takeoffPlacement":
    case "bucketFill":
    case "split":
    case "tagPick":
      return null;
    default:
      return assertNever(activeTool);
  }
}

export function captureCanvasGestureLease<T extends object>(
  token: T,
  snapshot: CanvasGestureSnapshot,
): CanvasGestureLease<T> | null {
  const owner = resolveCanvasGestureOwner(snapshot);
  return owner === null
    ? null
    : { token, owner, publicId: snapshot.publicId, pageNumber: snapshot.pageNumber };
}

function sameCanvasGestureOwner(
  left: CanvasGestureOwner,
  right: CanvasGestureOwner,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "baseRect":
      return right.kind === "baseRect" && left.mode === right.mode;
    case "symbolTemplate":
      return right.kind === "symbolTemplate" && left.activation === right.activation;
    case "tagAdd":
      return right.kind === "tagAdd" && left.activation === right.activation;
    case "parseRect":
      return right.kind === "parseRect" && left.activation === right.activation &&
        left.step === right.step;
    default:
      return assertNever(left);
  }
}

export function matchesCanvasGestureLease(
  lease: CanvasGestureLease,
  current: CanvasGestureSnapshot,
): boolean {
  if (current.publicId !== lease.publicId || current.pageNumber !== lease.pageNumber) return false;
  const owner = resolveCanvasGestureOwner(current);
  return owner !== null && sameCanvasGestureOwner(lease.owner, owner);
}
