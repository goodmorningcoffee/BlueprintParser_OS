// @vitest-environment jsdom
//
// [refactor jul19 P3.2] Parent-green executable freeze for the legacy BucketFill mousedown
// branch. This file lands before the controller lift and exercises AnnotationOverlay's real event
// path. The final describe is deliberately PRE-move topology and must be transformed to POST-move
// ownership in the pure-lift commit.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  claimLatestToolOperation,
  claimToolTailAuthority,
  invalidateLatestToolOperation,
  invalidateToolTailAuthority,
  ownsLatestToolOperation,
  ownsToolTailAuthority,
  registerToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTextract } from "@/test/seed-textract";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

const bucketClient = vi.hoisted(() => ({
  clientBucketFill: vi.fn(),
  findPageCanvas: vi.fn(),
}));

vi.mock("@/lib/bucket-fill-client", () => ({
  clientBucketFill: bucketClient.clientBucketFill,
  findPageCanvas: bucketClient.findPageCanvas,
}));
vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";
import { TOOLS } from "../tools/registry";

const PUBLIC_ID = "bucket-fill-gesture-fixture";
const PROJECT_DB_ID = 401;
const PAGE = 1;
const WIDTH = 200;
const HEIGHT = 100;

const eligibleVertices = [
  { x: 0.1, y: 0.1 },
  { x: 0.8, y: 0.1 },
  { x: 0.5, y: 0.8 },
];
const barriers = [{ x1: 0.12, y1: 0.23, x2: 0.78, y2: 0.84 }];
const textBboxes = [
  { x: 0.11, y: 0.22, w: 0.33, h: 0.44 },
  { x: 0.51, y: 0.62, w: 0.13, h: 0.24 },
];
const preview = {
  vertices: [
    { x: 0.2, y: 0.2 },
    { x: 0.4, y: 0.2 },
    { x: 0.3, y: 0.4 },
  ],
  method: "existing-preview",
};
const pendingPolygon = {
  vertices: preview.vertices,
  method: "pending-assignment",
  bbox: [0.2, 0.2, 0.4, 0.4] as [number, number, number, number],
  areaSqUnits: 42,
  unit: "sq ft",
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let queryClient: QueryClient;
const parentMouseDown = vi.fn();
const fetchMock = vi.fn();

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

function canvasRect(width = WIDTH, height = HEIGHT): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function row(
  id: number,
  pageNumber: number,
  source: ClientAnnotation["source"],
  data: unknown,
): ClientAnnotation {
  return {
    id,
    pageNumber,
    name: `fixture-${id}`,
    bbox: [0.1, 0.1, 0.8, 0.8],
    note: null,
    source,
    data,
  } as ClientAnnotation;
}

function transportRows(): ClientAnnotation[] {
  return [
    row(101, PAGE, "takeoff", {
      type: "area-polygon",
      takeoffItemId: 31,
      color: "#22c55e",
      vertices: eligibleVertices,
      areaSqUnits: 1,
      unit: "sq ft",
    }),
    row(102, PAGE + 1, "takeoff", {
      type: "area-polygon",
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    }),
    row(103, PAGE, "user", {
      type: "area-polygon",
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    }),
    row(104, PAGE, "takeoff", {
      type: "count-marker",
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    }),
    row(105, PAGE, "takeoff", {
      type: "area-polygon",
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    }),
  ];
}

function seedBucketState(rows: ClientAnnotation[] = []): void {
  invalidateToolTailAuthority();
  invalidateLatestToolOperation("bucketFill");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  parentMouseDown.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => {
    throw new Error("Unexpected BucketFill server request");
  });
  bucketClient.clientBucketFill.mockReset();
  bucketClient.findPageCanvas.mockReset();
  bucketClient.findPageCanvas.mockReturnValue(null);
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: PROJECT_DB_ID,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE,
    numPages: PAGE + 1,
    pageNames: { [PAGE]: "A-101", [PAGE + 1]: "A-102" },
    mode: "pointer",
    activeTool: { kind: "bucketFill" },
    bucketFillPreview: null,
    bucketFillLoading: false,
    bucketFillError: null,
    bucketFillTolerance: 47,
    bucketFillDilatePx: 6,
    bucketFillResolution: 3000,
    bucketFillPendingPolygon: null,
    bucketFillBarriers: barriers,
    bucketFillBarrierMode: false,
    barrierPendingPoint: null,
    hiddenAnnotationIds: new Set([101]),
  });
  seedAnnotations(queryClient, rows);
  seedTextract(queryClient, {
    [PAGE]: {
      lines: [],
      words: [
        { text: "W1", confidence: 99, bbox: [0.11, 0.22, 0.33, 0.44] },
        { text: "W2", confidence: 98, bbox: [0.51, 0.62, 0.13, 0.24] },
      ],
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    noopContext(),
  );
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

function mouseDownEvent(button = 0): MouseEvent {
  return new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    clientX: 60,
    clientY: 70,
    button,
  });
}

function press(canvas: HTMLCanvasElement, event = mouseDownEvent()): void {
  act(() => {
    fireEvent(canvas, event);
  });
}

async function flushTail(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function exactServerBody() {
  return {
    projectId: PROJECT_DB_ID,
    pageNumber: PAGE,
    seedPoint: { x: 0.3, y: 0.7 },
    tolerance: 47,
    dilate: 6,
    barriers,
    polygonBarriers: [{ vertices: eligibleVertices }],
    textBboxes,
  };
}

describe("BucketFill gesture freeze (real overlay, production mousedown)", () => {
  afterEach(async () => {
    cleanup();
    queryClient?.clear();
    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    resetProjectData();
    await Promise.resolve();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("W0: a non-Bucket press falls through without touching Bucket state or transport", async () => {
    seedBucketState();
    const canvas = await mountCanvas();
    act(() => useToolStore.setState({ activeTool: null }));
    const event = mouseDownEvent();

    press(canvas, event);

    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useToolStore.getState()).toMatchObject({
      bucketFillLoading: false,
      bucketFillPreview: null,
      bucketFillError: null,
      barrierPendingPoint: null,
      bucketFillBarriers: barriers,
    });
  });

  it("W1: a non-primary first barrier point stops, invalidates, then normalizes width and height independently", async () => {
    seedBucketState();
    act(() => useToolStore.setState({ bucketFillBarrierMode: true }));
    const canvas = await mountCanvas();
    const globalToken = claimToolTailAuthority({ witness: "global" });
    const laneToken = claimLatestToolOperation("bucketFill", { witness: "lane" });
    const cancelled = vi.fn();
    registerToolTailCancellation(globalToken, cancelled);
    const event = mouseDownEvent(2);
    const nativeStop = event.stopPropagation.bind(event);
    let authorityAtStop: [boolean, boolean] | null = null;
    const stopPropagation = vi
      .spyOn(event, "stopPropagation")
      .mockImplementation(() => {
        authorityAtStop = [
          ownsToolTailAuthority(globalToken),
          ownsLatestToolOperation("bucketFill", laneToken),
        ];
        nativeStop();
      });
    let authorityAtPublication: [boolean, boolean] | null = null;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state.barrierPendingPoint === previous.barrierPendingPoint) return;
      authorityAtPublication = [
        ownsToolTailAuthority(globalToken),
        ownsLatestToolOperation("bucketFill", laneToken),
      ];
    });

    press(canvas, event);
    unsubscribe();

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(authorityAtStop).toEqual([true, true]);
    expect(authorityAtPublication).toEqual([false, false]);
    expect(useToolStore.getState().barrierPendingPoint).toEqual({ x: 0.3, y: 0.7 });
    expect(useToolStore.getState().bucketFillBarriers).toBe(barriers);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await flushTail();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("W2: barrier completion appends the captured endpoint before clearing it", async () => {
    seedBucketState();
    const pending = { x: 0.15, y: 0.25 };
    act(() => useToolStore.setState({
      bucketFillBarrierMode: true,
      barrierPendingPoint: pending,
    }));
    const canvas = await mountCanvas();
    const journal: string[] = [];
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state.bucketFillBarriers !== previous.bucketFillBarriers) {
        journal.push(`barrier:pending-${state.barrierPendingPoint === pending ? "captured" : "changed"}`);
      }
      if (state.barrierPendingPoint !== previous.barrierPendingPoint) {
        journal.push("pending-clear");
      }
    });

    press(canvas);
    unsubscribe();

    expect(journal).toEqual(["barrier:pending-captured", "pending-clear"]);
    expect(useToolStore.getState().bucketFillBarriers).toEqual([
      ...barriers,
      { x1: 0.15, y1: 0.25, x2: 0.3, y2: 0.7 },
    ]);
    expect(useToolStore.getState().barrierPendingPoint).toBeNull();
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parentMouseDown).not.toHaveBeenCalled();
  });

  it.each([
    ["loading", { bucketFillLoading: true }],
    ["preview", { bucketFillPreview: preview }],
    ["pending assignment", { bucketFillPendingPolygon: pendingPolygon }],
  ] as const)("W3: %s is a transport-cold terminal partition", async (_name, patch) => {
    seedBucketState();
    act(() => useToolStore.setState(patch));
    const before = useToolStore.getState();
    const canvas = await mountCanvas();
    const globalToken = claimToolTailAuthority({ witness: `terminal-${_name}` });
    const laneToken = claimLatestToolOperation("bucketFill", { witness: `terminal-${_name}` });
    const event = mouseDownEvent();
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    press(canvas, event);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(ownsToolTailAuthority(globalToken)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", laneToken)).toBe(true);
    expect(useToolStore.getState().bucketFillLoading).toBe(before.bucketFillLoading);
    expect(useToolStore.getState().bucketFillPreview).toBe(before.bucketFillPreview);
    expect(useToolStore.getState().bucketFillPendingPolygon).toBe(
      before.bucketFillPendingPolygon,
    );
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("W3b: barrier mode outranks loading, preview, and the pending dialog", async () => {
    seedBucketState();
    act(() => useToolStore.setState({
      bucketFillBarrierMode: true,
      bucketFillLoading: true,
      bucketFillPreview: preview,
      bucketFillPendingPolygon: pendingPolygon,
    }));
    const canvas = await mountCanvas();

    press(canvas);

    expect(useToolStore.getState().barrierPendingPoint).toEqual({ x: 0.3, y: 0.7 });
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parentMouseDown).not.toHaveBeenCalled();
  });

  it("W4: worker-first uses the captured tuning/barriers and exact cache projections", async () => {
    seedBucketState(transportRows());
    const pageCanvas = document.createElement("canvas");
    const worker = deferred<never>();
    bucketClient.findPageCanvas.mockReturnValue(pageCanvas);
    bucketClient.clientBucketFill.mockReturnValue(worker.promise);
    const canvas = await mountCanvas();
    const replacementBarriers = [{ x1: 0, y1: 0, x2: 1, y2: 1 }];
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (!state.bucketFillLoading || previous.bucketFillLoading) return;
      useToolStore.setState({
        bucketFillTolerance: 9,
        bucketFillDilatePx: 1,
        bucketFillResolution: 1000,
        bucketFillBarriers: replacementBarriers,
      });
    });

    press(canvas);
    unsubscribe();

    expect(bucketClient.findPageCanvas).toHaveBeenCalledTimes(1);
    expect(bucketClient.clientBucketFill).toHaveBeenCalledExactlyOnceWith(
      pageCanvas,
      { x: 0.3, y: 0.7 },
      {
        tolerance: 47,
        dilation: 6,
        barriers,
        polygonBarriers: [{ vertices: eligibleVertices }],
        textBboxes,
        maxDimension: 3000,
      },
    );
    const workerOptions = bucketClient.clientBucketFill.mock.calls[0]?.[2];
    expect(workerOptions.barriers).toBe(barriers);
    expect(workerOptions.polygonBarriers[0]?.vertices).toBe(eligibleVertices);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useToolStore.getState().bucketFillLoading).toBe(true);
    expect(parentMouseDown).not.toHaveBeenCalled();

    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    worker.reject(new Error("retired worker"));
    await flushTail();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("W5: owned worker success consumes before publishing and normalizes empty holes to undefined", async () => {
    seedBucketState();
    const pageCanvas = document.createElement("canvas");
    const worker = deferred<{
      vertices: { x: number; y: number }[];
      holes: never[];
      method: string;
    }>();
    bucketClient.findPageCanvas.mockReturnValue(pageCanvas);
    bucketClient.clientBucketFill.mockReturnValue(worker.promise);
    const canvas = await mountCanvas();
    press(canvas);
    const vertices = [
      { x: 0.2, y: 0.3 },
      { x: 0.7, y: 0.3 },
      { x: 0.5, y: 0.9 },
    ];
    const subscriberToken = { witness: "success-subscriber" };
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state.bucketFillPreview && !previous.bucketFillPreview) {
        claimToolTailAuthority(subscriberToken);
      }
    });

    worker.resolve({ vertices, holes: [], method: "client-raster" });
    await flushTail();
    unsubscribe();

    expect(useToolStore.getState().bucketFillLoading).toBe(false);
    expect(useToolStore.getState().bucketFillPreview).toEqual({
      vertices,
      method: "client-raster",
    });
    expect(useToolStore.getState().bucketFillPreview).toHaveProperty(
      "holes",
      undefined,
    );
    expect(ownsToolTailAuthority(subscriberToken)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("W6: owned worker rejection falls back once with the exact server-only body", async () => {
    seedBucketState(transportRows());
    const pageCanvas = document.createElement("canvas");
    const worker = deferred<never>();
    const server = deferred<Response>();
    bucketClient.findPageCanvas.mockReturnValue(pageCanvas);
    bucketClient.clientBucketFill.mockReturnValue(worker.promise);
    fetchMock.mockReturnValue(server.promise);
    const canvas = await mountCanvas();

    press(canvas);
    worker.reject(new Error("worker domain failure"));
    await flushTail();

    expect(bucketClient.clientBucketFill).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/bucket-fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exactServerBody()),
    });
    const sent = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(sent).toEqual(exactServerBody());
    expect(sent).toHaveProperty("dilate", 6);
    expect(sent).not.toHaveProperty("dilation");
    expect(sent).not.toHaveProperty("maxDimension");

    invalidateToolTailAuthority();
    invalidateLatestToolOperation("bucketFill");
    server.resolve(response({ type: "unused" }));
    await flushTail();
  });

  it("W7: no-canvas server success retains holes and supplies the method fallback", async () => {
    seedBucketState(transportRows());
    const vertices = [
      { x: 0.1, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.5, y: 0.9 },
    ];
    const holes = [{
      vertices: [{ x: 0.3, y: 0.4 }, { x: 0.5, y: 0.4 }, { x: 0.4, y: 0.6 }],
    }];
    fetchMock.mockResolvedValue(response({ type: "result", vertices, holes }));
    const canvas = await mountCanvas();

    press(canvas);
    await flushTail();

    expect(bucketClient.findPageCanvas).toHaveBeenCalledTimes(1);
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/bucket-fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exactServerBody()),
    });
    expect(useToolStore.getState().bucketFillPreview).toEqual({
      vertices,
      holes,
      method: "server-raster",
    });
    expect(useToolStore.getState().bucketFillPreview?.holes).toBe(holes);
    expect(useToolStore.getState().bucketFillLoading).toBe(false);
  });

  it("W8: an in-band string error retains authority until the exact 4000ms consuming clear", async () => {
    seedBucketState();
    fetchMock.mockResolvedValue(response({
      type: "error",
      error: "Seed point is on a wall",
    }));
    const canvas = await mountCanvas();
    let timerCallback: (() => void) | undefined;
    const timeout = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay) => {
        if (delay === 4000) timerCallback = callback as () => void;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      });
    timeout.mockClear();

    press(canvas);
    await flushTail();

    expect(useToolStore.getState().bucketFillLoading).toBe(false);
    expect(useToolStore.getState().bucketFillError).toBe("Seed point is on a wall");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 4000);
    expect(timerCallback).toBeTypeOf("function");

    const clearSubscriberToken = { witness: "error-clear-subscriber" };
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (previous.bucketFillError !== null && state.bucketFillError === null) {
        claimToolTailAuthority(clearSubscriberToken);
      }
    });
    act(() => timerCallback?.());
    unsubscribe();

    expect(useToolStore.getState().bucketFillError).toBeNull();
    expect(ownsToolTailAuthority(clearSubscriberToken)).toBe(true);
  });

  it("W9: an unknown 2xx body consumes and clears loading without preview or error", async () => {
    seedBucketState();
    fetchMock.mockResolvedValue(response({
      type: "result",
      vertices: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
    }));
    const canvas = await mountCanvas();
    const clearSubscriberToken = { witness: "unknown-clear-subscriber" };
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (previous.bucketFillLoading && !state.bucketFillLoading) {
        claimToolTailAuthority(clearSubscriberToken);
      }
    });

    press(canvas);
    await flushTail();
    unsubscribe();

    expect(useToolStore.getState()).toMatchObject({
      bucketFillLoading: false,
      bucketFillPreview: null,
      bucketFillError: null,
    });
    expect(ownsToolTailAuthority(clearSubscriberToken)).toBe(true);
  });

  it("W10: a non-OK modern envelope publishes its exact message", async () => {
    seedBucketState();
    fetchMock.mockResolvedValue(response(
      { error: { code: "BUCKET_FILL_FAILED", message: "Gateway rejected seed" } },
      false,
      422,
    ));
    const canvas = await mountCanvas();
    const timeout = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(() => 1 as unknown as ReturnType<typeof setTimeout>);
    timeout.mockClear();

    press(canvas);
    await flushTail();

    expect(useToolStore.getState().bucketFillLoading).toBe(false);
    expect(useToolStore.getState().bucketFillError).toBe("Gateway rejected seed");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 4000);
  });
});

describe("BucketFill seam topology pins (POST-move: controller is sole mousedown home)", () => {
  const AO = readFileSync(
    join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
    "utf8",
  );
  const REGISTRY = readFileSync(
    join(process.cwd(), "src/components/viewer/tools/registry.ts"),
    "utf8",
  );
  const TYPES = readFileSync(
    join(process.cwd(), "src/components/viewer/tools/types.ts"),
    "utf8",
  );
  const controllerPath = join(
    process.cwd(),
    "src/components/viewer/tools/bucketFill.ts",
  );
  const CONTROLLER = readFileSync(controllerPath, "utf8");
  const mouseDownStart = AO.indexOf("  const handleMouseDown = useCallback(");
  const mouseMoveStart = AO.indexOf("  const handleMouseMove = useCallback(");
  const MOUSEDOWN = AO.slice(mouseDownStart, mouseMoveStart);
  const count = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  it("pins the legacy branch absent and the controller as the sole transport home", () => {
    expect(mouseDownStart).toBeGreaterThan(-1);
    expect(mouseMoveStart).toBeGreaterThan(mouseDownStart);
    expect(existsSync(controllerPath)).toBe(true);
    expect(count(MOUSEDOWN, "// Bucket fill mode — independent of item selection")).toBe(0);
    expect(count(MOUSEDOWN, 'if (activeTool?.kind === "bucketFill")')).toBe(0);
    expect(count(MOUSEDOWN, "clientBucketFill(")).toBe(0);
    expect(count(MOUSEDOWN, 'fetch("/api/bucket-fill"')).toBe(0);
    expect(count(CONTROLLER, 'kind: "bucketFill"')).toBe(1);
    expect(count(CONTROLLER, 'state.activeTool?.kind === "bucketFill"')).toBe(1);
    expect(
      count(CONTROLLER, 'press.toolAtDown.activeTool?.kind === "bucketFill"'),
    ).toBe(1);
    expect(count(CONTROLLER, "clientBucketFill(")).toBe(1);
    expect(count(CONTROLLER, 'fetch("/api/bucket-fill"')).toBe(1);
    expect(count(CONTROLLER, "return true;")).toBe(6);
    expect(CONTROLLER.match(/\n/g)).toHaveLength(253);
    expect(AO.match(/\n/g)).toHaveLength(2455);
  });

  it("pins explicit barrier invalidation and fresh-operation publication order", () => {
    expect(CONTROLLER).toContain(
      "invalidateToolTailAuthority();\n      " +
        'invalidateLatestToolOperation("bucketFill");\n      const pending',
    );
    const freshStart = CONTROLLER.indexOf("    const bucketToken = {};");
    const globalClaim = CONTROLLER.indexOf(
      "    claimToolTailAuthority(bucketToken);",
      freshStart,
    );
    const laneClaim = CONTROLLER.indexOf(
      '    claimLatestToolOperation("bucketFill", bucketToken);',
      freshStart,
    );
    const registration = CONTROLLER.indexOf(
      "    registerToolTailCancellation(bucketToken, () => {",
      freshStart,
    );
    const loading = CONTROLLER.indexOf(
      "    useToolStore.setState({\n      bucketFillLoading: true,\n" +
        "      bucketFillPreview: null,\n      bucketFillError: null,\n    });",
      freshStart,
    );
    expect(freshStart).toBeGreaterThan(-1);
    expect(globalClaim).toBeGreaterThan(freshStart);
    expect(laneClaim).toBeGreaterThan(globalClaim);
    expect(registration).toBeGreaterThan(laneClaim);
    expect(loading).toBeGreaterThan(registration);
    expect(count(CONTROLLER, "if (bfState.bucketFillLoading) return true;")).toBe(1);
    expect(CONTROLLER).toContain(
      "if (bfState.bucketFillPreview || bfState.bucketFillPendingPolygon) {\n" +
        "      return true;\n    }",
    );
  });

  it("pins the exact 12-controller registry and Bucket destination slot", () => {
    expect(REGISTRY).toContain('import { bucketFillController } from "./bucketFill";');
    expect(TOOLS.map((controller) => controller.kind)).toEqual([
      "calibration",
      "split",
      "bucketFill",
      "takeoffPolygon",
      "takeoffLinear",
      "takeoffCount",
      "keynotePick",
      "tagPick",
      "symbolSearch",
      "tagAdd",
      "parseRect",
      "markup",
    ]);
    expect(TOOLS).toHaveLength(12);
    expect(REGISTRY).toContain(
      "    calibrationController,\n    splitController,\n    bucketFillController,\n" +
        "    takeoffPolygonController,",
    );
  });

  it("pins Bucket import/authority homes and the sacred mousedown dependency block", () => {
    expect(AO).not.toContain(
      'import { clientBucketFill, findPageCanvas } from "@/lib/bucket-fill-client";',
    );
    expect(CONTROLLER).toContain("readAnnotations(queryClient, bucketPublicId)");
    expect(CONTROLLER).toContain(
      "readTextractForPage(queryClient, bucketPublicId, bucketPageNumber)",
    );
    expect(CONTROLLER).toContain("apiErrorMessage(error)");
    expect(CONTROLLER).toContain(
      'ownsLatestToolOperation("bucketFill", bucketToken)',
    );
    expect(count(AO, "readTextractForPage(")).toBe(1);
    expect(count(CONTROLLER, "readTextractForPage(")).toBe(1);
    expect(AO).not.toContain("claimLatestToolOperation,");
    expect(AO).not.toContain("ownsLatestToolOperation,");
    expect(AO).toContain(
      "bucketFill: {\n            queryClient: qc,\n            projectDbId,\n" +
        "            addBarrier: addBucketFillBarrier,\n          },",
    );
    expect(TYPES).toContain("readonly bucketFill?: Readonly<{");
    expect(CONTROLLER).not.toMatch(/queryClient\.(?:setQueryData|setQueriesData|invalidateQueries|fetchQuery|ensureQueryData)/);
    expect(CONTROLLER).not.toContain("useToolStore((");

    const callbackStart = AO.indexOf("  const handleMouseDown = useCallback(");
    const callbackEnd = AO.indexOf("\n  );", callbackStart);
    const callback = AO.slice(callbackStart, callbackEnd + "\n  );".length);
    const dependencyStart = callback.lastIndexOf("\n    [") + 1;
    const dependencyEnd = callback.indexOf("]\n  );", dependencyStart) + 2;
    const rawDependencies = callback.slice(dependencyStart, dependencyEnd);
    const members = rawDependencies
      .trim()
      .slice(1, -1)
      .split(",")
      .map((member) => member.trim())
      .filter(Boolean);
    expect(members).toHaveLength(37);
    expect(createHash("md5").update(rawDependencies).digest("hex")).toBe(
      "dada8bf65ea7834550cc1e5fc221d5ee",
    );
  });
});
