// @vitest-environment jsdom

// [refactor jul13 P2.3 AT2] Adversarial canvas witnesses for exact activation ownership.
//
// Every gesture enters through AnnotationOverlay's real mouse handlers. Tool replacement and page
// boundaries enter through the named production commands. Deferred worker/server transports ignore
// cancellation on purpose: only the exact activation, gesture lease, and page guards can keep A's
// late tail from publishing into B.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";
import {
  navigateViewerPageUnclamped,
  resetProjectData,
} from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation, YoloTag } from "@/types";

const bucketClient = vi.hoisted(() => ({
  clientBucketFill: vi.fn(),
  findPageCanvas: vi.fn(),
}));

vi.mock("@/lib/bucket-fill-client", () => ({
  clientBucketFill: bucketClient.clientBucketFill,
  findPageCanvas: bucketClient.findPageCanvas,
}));
vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({
  default: () => <div data-testid="canvas-race-markup-dialog" />,
}));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "canvas-race-project";
const PROJECT_DB_ID = 401;
const TAG_ID = "canvas-race-tag";
const PAGE_A = 1;
const PAGE_B = 2;

const annotation: ClientAnnotation = {
  id: 71,
  pageNumber: PAGE_A,
  name: "Inside lasso",
  bbox: [0.4, 0.4, 0.6, 0.6],
  note: null,
  source: "user",
  data: null,
};

const tag: YoloTag = {
  id: TAG_ID,
  name: "T-101",
  tagText: "T-101",
  yoloClass: "Door",
  yoloModel: "Fixture Model",
  source: "manual",
  scope: "project",
  instances: [],
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
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

let queryClient: QueryClient;
let serverRequests: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderCanvas(): HTMLCanvasElement {
  const { container } = render(
    <AnnotationOverlay width={100} height={100} cssScale={1} />,
    { wrapper },
  );
  const canvas = container.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Expected AnnotationOverlay canvas");
  }
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return canvas;
}

function beginRectangle(canvas: HTMLCanvasElement): void {
  fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10, button: 0 });
  expect(useViewerStore.getState()._drawing).toBe(true);
  fireEvent.mouseMove(canvas, { clientX: 80, clientY: 80, buttons: 1 });
  expect(useViewerStore.getState()._drawEnd).toEqual({ x: 80, y: 80 });
}

function activateSymbol() {
  act(() => useToolStore.getState().setSymbolSearchActive(true));
  const activation = useToolStore.getState().activeTool;
  if (activation?.kind !== "symbolTemplate") {
    throw new Error("Expected symbolTemplate activation");
  }
  return activation;
}

function activateTagAdd() {
  act(() => useToolStore.getState().setTagAddingMode(TAG_ID));
  const activation = useToolStore.getState().activeTool;
  if (activation?.kind !== "tagAdd") throw new Error("Expected tagAdd activation");
  return activation;
}

function activateBucket() {
  act(() => useToolStore.getState().setBucketFillActive(true));
  const activation = useToolStore.getState().activeTool;
  if (activation?.kind !== "bucketFill") throw new Error("Expected bucketFill activation");
  return activation;
}

function installBucketB(afterPageBoundary = false) {
  act(() => {
    if (afterPageBoundary) {
      navigateViewerPageUnclamped(PAGE_B);
    } else {
      useToolStore.getState().setBucketFillActive(false);
    }
    useToolStore.getState().setBucketFillActive(true);
  });
  const activation = useToolStore.getState().activeTool;
  if (activation?.kind !== "bucketFill") throw new Error("Expected replacement bucketFill");

  const preview = {
    vertices: [{ x: 0.7, y: 0.7 }, { x: 0.8, y: 0.7 }, { x: 0.8, y: 0.8 }],
    method: "B-preview",
  };
  act(() => {
    const store = useToolStore.getState();
    store.setBucketFillPreview(preview);
    store.setBucketFillLoading(true);
    store.setBucketFillError("B-error");
  });
  return { activation, preview };
}

function expectBucketBIntact(
  activation: ReturnType<typeof installBucketB>["activation"],
  preview: ReturnType<typeof installBucketB>["preview"],
): void {
  const state = useToolStore.getState();
  expect(state.activeTool).toBe(activation);
  expect(state.bucketFillPreview).toBe(preview);
  expect(state.bucketFillLoading).toBe(true);
  expect(state.bucketFillError).toBe("B-error");
}

async function flushDeferredTail(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  serverRequests = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/bucket-fill") {
      throw new Error(`Unexpected canvas race request: ${String(url)}`);
    }
    const request = deferred<Response>();
    serverRequests.push(request);
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);

  bucketClient.clientBucketFill.mockReset();
  bucketClient.findPageCanvas.mockReset();
  bucketClient.findPageCanvas.mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());

  resetProjectData();
  setViewerStoreStateForTest({
    projectId: PROJECT_DB_ID,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE_A,
    numPages: PAGE_B,
    pageNames: { [PAGE_A]: "A-101", [PAGE_B]: "A-102" },
    mode: "pointer",
    activeTool: null,
    selectedAnnotationIds: new Set<number>(),
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
  });
  seedAnnotations(queryClient, [annotation]);
  seedAnnotationGroups(queryClient, [], []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [tag] });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: PAGE_A, to: PAGE_B },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AnnotationOverlay exact activation gesture ownership", () => {
  it("retires displaced rectangle geometry before the next paint", async () => {
    activateSymbol();
    const canvas = renderCanvas();
    beginRectangle(canvas);

    const tagB = activateTagAdd();
    await flushDeferredTail();

    expect(useToolStore.getState().activeTool).toBe(tagB);
    expect(useViewerStore.getState()._drawing).toBe(false);
    fireEvent.mouseUp(canvas);
    expect(queryClient.getQueryData<YoloTag[]>(
      queryKeys.yoloTags.all(PUBLIC_ID),
    )?.[0]?.instances).toEqual([]);
  });

  it("rolls A drawing back when a subscriber claims B during initial publication", async () => {
    const symbolA = activateSymbol();
    const canvas = renderCanvas();
    let admittedB = false;
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (admittedB || !state._drawing || previous._drawing) return;
      admittedB = true;
      useToolStore.getState().setSymbolSearchActive(true);
    });

    fireEvent.mouseDown(canvas, { clientX: 10, clientY: 10, button: 0 });
    unsubscribe();
    await flushDeferredTail();

    const symbolB = useToolStore.getState().activeTool;
    expect(admittedB).toBe(true);
    expect(symbolB?.kind).toBe("symbolTemplate");
    expect(symbolB).not.toBe(symbolA);
    expect(useViewerStore.getState()._drawing).toBe(false);
  });

  it("preserves reentrant gesture B admitted by A mouseup settlement", () => {
    activateSymbol();
    const canvas = renderCanvas();
    beginRectangle(canvas);
    let admittedB = false;
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (admittedB || state._drawing || !previous._drawing) return;
      admittedB = true;
      useToolStore.getState().setTagAddingMode(TAG_ID);
      fireEvent.mouseDown(canvas, { clientX: 20, clientY: 20, button: 0 });
    });

    fireEvent.mouseUp(canvas);
    unsubscribe();
    expect(admittedB).toBe(true);
    expect(useToolStore.getState().activeTool?.kind).toBe("tagAdd");
    expect(useViewerStore.getState()._drawing).toBe(true);

    fireEvent.mouseMove(canvas, { clientX: 70, clientY: 70, buttons: 1 });
    fireEvent.mouseUp(canvas);
    expect(queryClient.getQueryData<YoloTag[]>(
      queryKeys.yoloTags.all(PUBLIC_ID),
    )?.[0]?.instances).toHaveLength(1);
  });

  it("retires cleanup-subscriber old-page geometry at the second page boundary", async () => {
    activateSymbol();
    const canvas = renderCanvas();
    beginRectangle(canvas);
    let admittedB = false;
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (admittedB || state._drawing || !previous._drawing) return;
      admittedB = true;
      useToolStore.getState().setTagAddingMode(TAG_ID);
      fireEvent.mouseDown(canvas, { clientX: 20, clientY: 20, button: 0 });
      fireEvent.mouseMove(canvas, { clientX: 70, clientY: 70, buttons: 1 });
    });

    act(() => navigateViewerPageUnclamped(PAGE_B));
    unsubscribe();
    expect(admittedB).toBe(true);
    expect(useViewerCoreStore.getState().pageNumber).toBe(PAGE_B);
    expect(useToolStore.getState().activeTool?.kind).toBe("tagAdd");
    await flushDeferredTail();
    expect(useViewerStore.getState()._drawing).toBe(false);
    expect(queryClient.getQueryData<YoloTag[]>(
      queryKeys.yoloTags.all(PUBLIC_ID),
    )?.[0]?.instances).toEqual([]);
  });

  it.each([
    { name: "Symbol", activate: () => useToolStore.getState().setSymbolSearchActive(true) },
    { name: "Bucket", activate: () => useToolStore.getState().setBucketFillActive(true) },
  ])("preserves the dormant polygon draft across $name activation", async ({ activate }) => {
    act(() => useToolStore.setState({ mode: "markup" }));
    renderCanvas();
    const vertices = [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }];
    act(() => useToolStore.setState({
      polygonDrawingMode: "drawing",
      polygonVertices: vertices,
    }));

    act(() => activate());
    await flushDeferredTail();
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing");
    expect(useToolStore.getState().polygonVertices).toBe(vertices);
  });

  it("rejects Symbol A mouseup after a fresh same-kind B activation", () => {
    const symbolA = activateSymbol();
    const canvas = renderCanvas();
    beginRectangle(canvas);

    const symbolB = activateSymbol();
    expect(symbolB).not.toBe(symbolA);
    fireEvent.mouseUp(canvas);

    const state = useToolStore.getState();
    expect(state.activeTool).toBe(symbolB);
    expect(state.symbolSearchTemplateBbox).toBeNull();
    expect(state.symbolSearchSourcePage).toBeNull();
  });

  it("rejects TagAdd A mouseup after a fresh same-payload B activation", () => {
    const tagA = activateTagAdd();
    const canvas = renderCanvas();
    beginRectangle(canvas);
    const seededTag = queryClient.getQueryData<YoloTag[]>(
      queryKeys.yoloTags.all(PUBLIC_ID),
    )?.[0];

    const tagB = activateTagAdd();
    expect(tagB).not.toBe(tagA);
    expect(tagB).toEqual(tagA);
    fireEvent.mouseUp(canvas);

    expect(useToolStore.getState().activeTool).toBe(tagB);
    const currentTag = queryClient.getQueryData<YoloTag[]>(
      queryKeys.yoloTags.all(PUBLIC_ID),
    )?.[0];
    expect(currentTag).toBe(seededTag);
    expect(currentTag?.instances).toEqual([]);
  });

  it("rejects base markup A after specialized B and a base-null markup ABA", () => {
    act(() => useToolStore.getState().setMode("markup"));
    const canvas = renderCanvas();
    beginRectangle(canvas);

    const specializedB = activateSymbol();
    act(() => useToolStore.getState().setMode("markup"));
    expect(useToolStore.getState().activeTool).toBeNull();
    expect(specializedB.kind).toBe("symbolTemplate");
    fireEvent.mouseUp(canvas);

    expect(screen.queryByTestId("canvas-race-markup-dialog")).not.toBeInTheDocument();
  });

  it("rejects base group A after specialized B and a base-null group ABA", () => {
    act(() => useToolStore.getState().setMode("group"));
    const canvas = renderCanvas();
    beginRectangle(canvas);

    const specializedB = activateSymbol();
    act(() => useToolStore.getState().setMode("group"));
    expect(useToolStore.getState().activeTool).toBeNull();
    expect(specializedB.kind).toBe("symbolTemplate");
    fireEvent.mouseUp(canvas);

    expect(useUiStore.getState().selectedAnnotationIds).toEqual(new Set<number>());
  });

  it("rejects an old-page rectangle after the real page boundary while preserving TagAdd A", () => {
    const tagA = activateTagAdd();
    const canvas = renderCanvas();
    beginRectangle(canvas);
    const seededTag = queryClient.getQueryData<YoloTag[]>(
      queryKeys.yoloTags.all(PUBLIC_ID),
    )?.[0];

    act(() => navigateViewerPageUnclamped(PAGE_B));
    expect(useViewerCoreStore.getState().pageNumber).toBe(PAGE_B);
    expect(useToolStore.getState().activeTool).toBe(tagA);
    fireEvent.mouseUp(canvas);

    expect(useToolStore.getState().activeTool).toBe(tagA);
    expect(queryClient.getQueryData<YoloTag[]>(
      queryKeys.yoloTags.all(PUBLIC_ID),
    )?.[0]).toBe(seededTag);
    expect(seededTag?.instances).toEqual([]);
  });
});

describe("AnnotationOverlay bucket-fill continuation ownership", () => {
  it("eagerly clears A loading when a retaining intent defeats its tail", async () => {
    const bucketA = activateBucket();
    const canvas = renderCanvas();
    fireEvent.mouseDown(canvas, { clientX: 25, clientY: 35, button: 0 });
    expect(serverRequests).toHaveLength(1);
    expect(useToolStore.getState().bucketFillLoading).toBe(true);

    act(() => useToolStore.getState().setTempPanMode(true));
    await flushDeferredTail();
    expect(useToolStore.getState().activeTool).toBe(bucketA);
    expect(useToolStore.getState().bucketFillLoading).toBe(false);

    serverRequests[0].resolve({
      ok: true,
      status: 200,
      json: async () => ({
        type: "result",
        vertices: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }],
        method: "stale-A",
      }),
    } as unknown as Response);
    await flushDeferredTail();
    expect(useToolStore.getState().bucketFillPreview).toBeNull();
    expect(useToolStore.getState().bucketFillLoading).toBe(false);
  });

  it("clears stale error when a fresh Bucket retry begins", () => {
    activateBucket();
    const canvas = renderCanvas();
    act(() => useToolStore.setState({
      bucketFillError: "A-error",
      bucketFillLoading: false,
    }));

    fireEvent.mouseDown(canvas, { clientX: 25, clientY: 35, button: 0 });
    expect(useToolStore.getState().bucketFillLoading).toBe(true);
    expect(useToolStore.getState().bucketFillError).toBeNull();
  });

  it("keeps B intact when A's worker success settles after deactivate/reactivate", async () => {
    const worker = deferred<{
      vertices: { x: number; y: number }[];
      holes: never[];
      method: string;
    }>();
    bucketClient.findPageCanvas.mockReturnValue(document.createElement("canvas"));
    bucketClient.clientBucketFill.mockReturnValue(worker.promise);
    const bucketA = activateBucket();
    const canvas = renderCanvas();
    fireEvent.mouseDown(canvas, { clientX: 25, clientY: 35, button: 0 });
    expect(bucketClient.clientBucketFill).toHaveBeenCalledTimes(1);

    const bucketB = installBucketB();
    expect(bucketB.activation).not.toBe(bucketA);
    worker.resolve({
      vertices: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }],
      holes: [],
      method: "worker-A",
    });
    await flushDeferredTail();

    expect(fetchMock).not.toHaveBeenCalled();
    expectBucketBIntact(bucketB.activation, bucketB.preview);
  });

  it("does not start A's server fallback when A's worker rejects after B activation", async () => {
    const worker = deferred<never>();
    bucketClient.findPageCanvas.mockReturnValue(document.createElement("canvas"));
    bucketClient.clientBucketFill.mockReturnValue(worker.promise);
    const bucketA = activateBucket();
    const canvas = renderCanvas();
    fireEvent.mouseDown(canvas, { clientX: 25, clientY: 35, button: 0 });

    const bucketB = installBucketB();
    expect(bucketB.activation).not.toBe(bucketA);
    worker.reject(new Error("late worker A failure"));
    await flushDeferredTail();

    expect(fetchMock).not.toHaveBeenCalled();
    expectBucketBIntact(bucketB.activation, bucketB.preview);
  });

  it("keeps B intact when A's server result resumes after response.json", async () => {
    const bucketA = activateBucket();
    const canvas = renderCanvas();
    fireEvent.mouseDown(canvas, { clientX: 25, clientY: 35, button: 0 });
    expect(serverRequests).toHaveLength(1);

    const body = deferred<Record<string, unknown>>();
    const json = vi.fn(() => body.promise);
    serverRequests[0].resolve({ ok: true, status: 200, json } as unknown as Response);
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    const bucketB = installBucketB();
    expect(bucketB.activation).not.toBe(bucketA);

    body.resolve({
      type: "result",
      vertices: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }],
      method: "server-A",
    });
    await flushDeferredTail();

    expectBucketBIntact(bucketB.activation, bucketB.preview);
  });

  it("keeps new-page B intact when A's in-band server error resumes after response.json", async () => {
    const bucketA = activateBucket();
    const canvas = renderCanvas();
    fireEvent.mouseDown(canvas, { clientX: 25, clientY: 35, button: 0 });
    expect(serverRequests).toHaveLength(1);

    const body = deferred<Record<string, unknown>>();
    const json = vi.fn(() => body.promise);
    serverRequests[0].resolve({ ok: true, status: 200, json } as unknown as Response);
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    const bucketB = installBucketB(true);
    expect(bucketB.activation).not.toBe(bucketA);
    expect(useViewerCoreStore.getState().pageNumber).toBe(PAGE_B);

    body.resolve({ type: "error", error: "A-error" });
    await flushDeferredTail();

    expectBucketBIntact(bucketB.activation, bucketB.preview);
  });

  it("keeps B loading/error state intact when A's server rejection reaches catch cleanup", async () => {
    const bucketA = activateBucket();
    const canvas = renderCanvas();
    fireEvent.mouseDown(canvas, { clientX: 25, clientY: 35, button: 0 });
    expect(serverRequests).toHaveLength(1);

    const bucketB = installBucketB();
    expect(bucketB.activation).not.toBe(bucketA);
    serverRequests[0].reject(new Error("A-network-error"));
    await flushDeferredTail();

    expectBucketBIntact(bucketB.activation, bucketB.preview);
  });
});
