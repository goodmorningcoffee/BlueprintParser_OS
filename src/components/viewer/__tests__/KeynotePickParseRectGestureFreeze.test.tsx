// @vitest-environment jsdom
//
// [refactor jul18 P3.2] PRE-MOVE executable freeze for the atomic keynotePick + parseRect
// extraction. The keynote branch is an eligible-decline picker: a YOLO hit claims, while a miss
// performs no picker-owned effect and falls through to the generic parseRect deferred rectangle.
// Both identities therefore move together after this test lands at parent c667506.
//
// The harness deliberately mounts with no active tool and activates keynote parsing AFTER mount.
// AnnotationOverlay's picking boolean and candidate list are render-derived from conditional
// subscriptions; pre-seeding an active gesture can accidentally test a stale/cleanup path instead
// of the production activation edge. The 200x100 canvas keeps x/width and y/height anisotropic.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
  registerToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "keynote-pick-parse-rect-fixture";
const WIDTH = 200;
const HEIGHT = 100;
const COL_A: [number, number, number, number] = [0.2, 0.1, 0.8, 0.9];
const PICK_BOX: [number, number, number, number] = [0.3, 0.2, 0.6, 0.7];

let queryClient: QueryClient;
let unsubscribers: Array<() => void> = [];
const parentMouseDown = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div onMouseDown={parentMouseDown}>{children}</div>
    </QueryClientProvider>
  );
}

function noopContext(): CanvasRenderingContext2D {
  const target = { measureText: () => ({ width: 0 }) };
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property as keyof typeof object];
      return () => {};
    },
    set(object, property, value) {
      Reflect.set(object, property, value);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function canvasRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: WIDTH,
    bottom: HEIGHT,
    width: WIDTH,
    height: HEIGHT,
    toJSON: () => ({}),
  } as DOMRect;
}

function yolo(
  id: number,
  name: string,
  bbox: [number, number, number, number] = PICK_BOX,
  over: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id,
    pageNumber: 1,
    name,
    bbox,
    note: null,
    source: "yolo",
    data: { modelName: "fixture", confidence: 0 },
    ...over,
  };
}

function seedOverlay(
  rows: ClientAnnotation[],
  options: { hiddenIds?: readonly number[] } = {},
): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unsubscribers = [];
  parentMouseDown.mockClear();
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 61,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: 1,
    numPages: 1,
    pageNames: { 1: "A-101", 2: "A-102" },
    mode: "pointer",
    activeTool: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
    keynoteParseStep: "idle",
    keynoteColumnBBs: [],
    keynoteYoloClass: null,
    tableParseStep: "idle",
    showDetections: false,
    activeModels: { fixture: false, blocked: false },
    confidenceThreshold: 0.99,
    confidenceThresholds: { fixture: 0.99, blocked: 0.99 },
    hiddenClasses: {
      "fixture:First": false,
      "blocked:Ordinary Filters Bypassed": false,
    },
    hiddenAnnotationIds: new Set(options.hiddenIds ?? []),
  });
  seedAnnotations(queryClient, rows);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
}

async function mountCanvas(): Promise<HTMLCanvasElement> {
  const { container } = render(
    <AnnotationOverlay width={WIDTH} height={HEIGHT} cssScale={1} />,
    { wrapper },
  );
  const canvas = await waitFor(() => {
    const candidate = container.querySelector("canvas");
    if (!(candidate instanceof HTMLCanvasElement)) {
      throw new Error("Expected AnnotationOverlay canvas");
    }
    return candidate;
  });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return canvas;
}

async function activateKeynotePicking(
  canvas: HTMLCanvasElement,
  options: {
    step?: "select-region" | "define-column" | "define-row";
    columns?: [number, number, number, number][];
  } = {},
): Promise<void> {
  act(() => {
    useToolStore.setState({ activeTool: { kind: "parseRect", flow: "keynote" } });
    useParseFlowStore.setState({
      keynoteParseStep: options.step ?? "define-column",
      keynoteColumnBBs: options.columns ?? [[...COL_A]],
      keynoteYoloClass: null,
    });
  });
  const expectedCursor = (options.step ?? "define-column") === "define-column" &&
    (options.columns ?? [COL_A]).length > 0
    ? "pointer"
    : "crosshair";
  await waitFor(() => expect(canvas.style.cursor).toBe(expectedCursor));
}

async function activateTableParse(canvas: HTMLCanvasElement): Promise<void> {
  act(() => {
    useParseFlowStore.setState({ tableParseStep: "select-region" });
    useToolStore.setState({ activeTool: { kind: "parseRect", flow: "table" } });
  });
  await waitFor(() => expect(canvas.style.cursor).toBe("crosshair"));
}

function press(canvas: HTMLCanvasElement, x: number, y: number): void {
  act(() => {
    fireEvent.mouseDown(canvas, { clientX: x, clientY: y, button: 0, detail: 1 });
  });
}

function move(canvas: HTMLCanvasElement, x: number, y: number): void {
  act(() => {
    fireEvent.mouseMove(canvas, { clientX: x, clientY: y });
  });
}

function release(canvas: HTMLCanvasElement): void {
  act(() => {
    fireEvent.mouseUp(canvas);
  });
}

function drawingState() {
  const { _drawing, _drawStart, _drawEnd } = useToolStore.getState();
  return { _drawing, _drawStart, _drawEnd };
}

describe("keynote pick + parseRect gesture freeze (real overlay)", () => {
  afterEach(() => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    cleanup();
    queryClient?.clear();
    vi.restoreAllMocks();
  });

  it.each([
    { label: "top-left", x: PICK_BOX[0] * WIDTH, y: PICK_BOX[1] * HEIGHT },
    { label: "bottom-right", x: PICK_BOX[2] * WIDTH, y: PICK_BOX[3] * HEIGHT },
  ])("hit bbox $label edge inclusively and never start drawing", async ({ x, y }) => {
    seedOverlay([yolo(1, "Boundary")]);
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas);

    press(canvas, x, y);

    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "fixture",
      className: "Boundary",
    });
    expect(drawingState()._drawing).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
  });

  it("accepts a candidate bbox exactly equal to Column A (all four containment edges inclusive)", async () => {
    seedOverlay([yolo(2, "Equal Column", [...COL_A])]);
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas);

    press(canvas, 100, 50);

    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "fixture",
      className: "Equal Column",
    });
    expect(drawingState()._drawing).toBe(false);
  });

  it("uses Column A specifically when multiple keynote columns exist", async () => {
    const columnA: typeof COL_A = [0.1, 0.1, 0.4, 0.9];
    const columnB: typeof COL_A = [0.6, 0.1, 0.9, 0.9];
    // The complementary pair proves both that a multi-column state remains active and that index
    // 0 — not the last/second column — owns filtering.
    seedOverlay([
      yolo(15, "Column A Only", [0.15, 0.2, 0.3, 0.7]),
      yolo(16, "Column B Only", [0.65, 0.2, 0.8, 0.7]),
    ]);
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas, { columns: [columnA, columnB] });

    press(canvas, 40, 30);
    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "fixture",
      className: "Column A Only",
    });
    expect(drawingState()._drawing).toBe(false);

    press(canvas, 140, 30);

    expect(useParseFlowStore.getState().keynoteYoloClass?.className).toBe("Column A Only");
    expect(drawingState()._drawing).toBe(true);
    expect(drawingState()._drawStart).toEqual({ x: 140, y: 30 });
  });

  it.each([
    { edge: "left", bbox: [0.19, 0.2, 0.4, 0.4] as const, point: [60, 30] as const },
    { edge: "top", bbox: [0.3, 0.09, 0.5, 0.3] as const, point: [80, 20] as const },
    { edge: "right", bbox: [0.6, 0.3, 0.81, 0.5] as const, point: [140, 40] as const },
    { edge: "bottom", bbox: [0.4, 0.7, 0.6, 0.91] as const, point: [100, 80] as const },
  ])("a candidate outside Column A on only the $edge edge is excluded and delegates to drawing", async ({ bbox, point }) => {
    seedOverlay([yolo(3, "Outside", [...bbox])]);
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas);

    press(canvas, point[0], point[1]);

    expect(useParseFlowStore.getState().keynoteYoloClass).toBeNull();
    expect(drawingState()).toEqual({
      _drawing: true,
      _drawStart: { x: point[0], y: point[1] },
      _drawEnd: { x: point[0], y: point[1] },
    });
    expect(parentMouseDown).not.toHaveBeenCalled();
  });

  it("an epsilon-outside click misses the retained YOLO and settles through real parse mouseup", async () => {
    seedOverlay([yolo(4, "Miss Me")]);
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas);

    press(canvas, 120.02, 30); // x=0.6001, just outside candidate maxX=0.6
    expect(useParseFlowStore.getState().keynoteYoloClass).toBeNull();
    expect(drawingState()._drawing).toBe(true);
    move(canvas, 160, 70);
    release(canvas);

    expect(drawingState()._drawing).toBe(false);
    expect(useParseFlowStore.getState().keynoteColumnBBs).toEqual([
      COL_A,
      [120.02 / WIDTH, 30 / HEIGHT, 160 / WIDTH, 70 / HEIGHT],
    ]);
  });

  it("another parse flow ignores the same YOLO and starts its own deferred rectangle", async () => {
    seedOverlay([yolo(5, "Not Keynote")]);
    const canvas = await mountCanvas();
    await activateTableParse(canvas);

    press(canvas, 80, 30);

    expect(useParseFlowStore.getState().keynoteYoloClass).toBeNull();
    expect(drawingState()._drawing).toBe(true);
    expect(drawingState()._drawStart).toEqual({ x: 80, y: 30 });
    expect(parentMouseDown).not.toHaveBeenCalled();
  });

  it("skips a non-YOLO bait and chooses the first overlapping YOLO in array order", async () => {
    const userBait: ClientAnnotation = {
      id: 6,
      pageNumber: 1,
      name: "User Bait",
      bbox: [...PICK_BOX],
      note: null,
      source: "user",
      data: { modelName: "bait" },
    };
    seedOverlay([
      userBait,
      yolo(7, "First", PICK_BOX, { data: { modelName: "first" } }),
      yolo(8, "Second", PICK_BOX, { data: { modelName: "second" } }),
    ]);
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas);

    press(canvas, 80, 30);

    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "first",
      className: "First",
    });
  });

  it.each([
    { label: "absent", data: undefined },
    { label: "empty", data: { modelName: "" } },
  ])("uses the unknown-model fallback when modelName is $label", async ({ data }) => {
    seedOverlay([yolo(9, "Fallback", PICK_BOX, { data })]);
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas);

    press(canvas, 80, 30);

    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "unknown",
      className: "Fallback",
    });
  });

  it.each([
    {
      label: "wrong step",
      step: "define-row" as const,
      columns: [[...COL_A] as typeof COL_A],
    },
    { label: "no column", step: "define-column" as const, columns: [] },
  ])("$label disables picking and lets parseRect draw", async ({ step, columns }) => {
    seedOverlay([yolo(10, "Inactive Picker")]);
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas, { step, columns });

    press(canvas, 80, 30);

    expect(useParseFlowStore.getState().keynoteYoloClass).toBeNull();
    expect(drawingState()._drawing).toBe(true);
    expect(drawingState()._drawStart).toEqual({ x: 80, y: 30 });
  });

  it("bypasses ordinary YOLO filters but still excludes hidden-id and other-page rows", async () => {
    seedOverlay([
      yolo(11, "Hidden First", PICK_BOX, { data: { modelName: "fixture" } }),
      yolo(12, "Wrong Page", PICK_BOX, { pageNumber: 2, data: { modelName: "fixture" } }),
      yolo(13, "Ordinary Filters Bypassed", PICK_BOX, {
        data: { modelName: "blocked", confidence: 0 },
      }),
    ], { hiddenIds: [11] });
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas);

    press(canvas, 80, 30);

    expect(useParseFlowStore.getState().keynoteYoloClass).toEqual({
      model: "blocked",
      className: "Ordinary Filters Bypassed",
    });
  });

  it("orders a hit as tail invalidation, stopPropagation, then synchronous command publication", async () => {
    seedOverlay([yolo(14, "Ordered", PICK_BOX, { data: { modelName: "ordered" } })]);
    const canvas = await mountCanvas();
    await activateKeynotePicking(canvas);

    const token = claimToolTailAuthority({});
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);
    const journal: string[] = [];
    const originalStop = Event.prototype.stopPropagation;
    vi.spyOn(Event.prototype, "stopPropagation").mockImplementation(function (this: Event) {
      journal.push(`stop:owns=${ownsToolTailAuthority(token)}`);
      originalStop.call(this);
    });
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (state.keynoteYoloClass === previous.keynoteYoloClass) return;
      journal.push(
        `publish:owns=${ownsToolTailAuthority(token)}:stopped=${journal[0] === "stop:owns=false"}`,
      );
    });
    unsubscribers.push(unsubscribe);

    press(canvas, 80, 30);

    expect(journal).toEqual([
      "stop:owns=false",
      "publish:owns=false:stopped=true",
    ]);
    expect(ownsToolTailAuthority(token)).toBe(false);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(drawingState()._drawing).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
describe("keynotePick + parseRect seam topology pins (post-move)", () => {
  const AO = readFileSync(
    join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
    "utf8",
  );
  const keynoteController = join(process.cwd(), "src/components/viewer/tools/keynotePick.ts");
  const parseController = join(process.cwd(), "src/components/viewer/tools/parseRect.ts");
  const KEYNOTE = readFileSync(keynoteController, "utf8");
  const PARSE = readFileSync(parseController, "utf8");
  const mouseDownStart = AO.indexOf("const handleMouseDown = useCallback(");
  const mouseMoveStart = AO.indexOf("const handleMouseMove = useCallback(");
  const MOUSEDOWN = AO.slice(mouseDownStart, mouseMoveStart);
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it("pins both legacy mousedown identities absent from the overlay after the atomic move", () => {
    expect(mouseDownStart).toBeGreaterThan(-1);
    expect(mouseMoveStart).toBeGreaterThan(mouseDownStart);
    expect(count(AO, "// Keynote YOLO picking")).toBe(0);
    expect(count(MOUSEDOWN, 'if (activeTool?.kind === "parseRect")')).toBe(0);
    expect(count(AO, "setKeynoteManualInputsForUser")).toBe(0);
    expect(count(AO, "keynotePick: { active: isKeynoteYoloPicking },")).toBe(1);
    expect(AO).toContain(
      "keynotePick + tagPick hit/miss routing, generic parseRect deferred",
    );
  });

  it("pins the two controllers as the sole homes of the exact claim/decline seam", () => {
    expect(existsSync(keynoteController)).toBe(true);
    expect(existsSync(parseController)).toBe(true);
    expect(KEYNOTE).toContain("if (!context.keynotePick?.active) return false;");
    expect(KEYNOTE).toContain('if (annotation.source !== "yolo") continue;');
    expect(KEYNOTE).toContain("invalidateToolTailAuthority();");
    expect(KEYNOTE).toContain("event.stopPropagation();");
    expect(KEYNOTE).toContain('annotation.data?.modelName || "unknown"');
    expect(KEYNOTE).toContain("setKeynoteManualInputsForUser({");
    expect(PARSE).toContain("event.stopPropagation();");
    expect(PARSE).toContain("deferredDrawing.start(context.press.position);");
    expect(PARSE).not.toContain("invalidateToolTailAuthority");
  });

  it("pins the render projection and deferred settlement homes retained in the overlay", () => {
    expect(count(AO, 'activeToolKey === "parseRect:keynote" ? s.keynoteParseStep : "idle"')).toBe(1);
    expect(count(AO, 'activeToolKey === "parseRect:keynote" ? s.keynoteColumnBBs')).toBe(1);
    expect(count(AO, "const isKeynoteYoloPicking =")).toBe(1);
    expect(count(AO, "const startDeferredDrawing = useCallback(")).toBe(1);
    expect(count(AO, "switch (owner.activation.flow)")).toBe(1);
  });
});
