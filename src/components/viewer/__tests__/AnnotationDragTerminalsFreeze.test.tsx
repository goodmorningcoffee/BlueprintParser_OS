// @vitest-environment jsdom

// [refactor jul18 P3 HIGH] Desired drag-terminal contract, written against parent 10877a4.
// The parent is intentionally RED on exact pre-rAF persistence, local mouseleave flush, page CAS,
// lifecycle ref retirement, and polygon/drag rAF isolation. The no-PUT and selection halves also
// preserve the legacy policies while the broken terminal mechanics are repaired.

import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import { persistFetch } from "@/lib/client-persist";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readAnnotations } from "@/queries/useAnnotations";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

vi.mock("@/lib/bucket-fill-client", () => ({
  clientBucketFill: vi.fn(),
  findPageCanvas: vi.fn(() => null),
}));
vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));
vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, persistFetch: vi.fn().mockResolvedValue({ id: 1 }) };
});

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "drag-terminal-project";
const PROJECT_DB_ID = 1701;
const PAGE = 1;
const BBOX_ID = 171;
const VERTEX_ID = 172;
const PAGE_TWO_ID = 173;
const ORIGIN_BBOX = [0.2, 0.2, 0.4, 0.4] as const;
const MOVED_BBOX = [0.5, 0.6, 0.7, 0.8] as const;
const HALF_MOVE_BBOX = [0.4, 0.4, 0.6000000000000001, 0.6000000000000001] as const;
const SYNC_CANCEL_BBOX = [0.6, 0.7, 0.8, 0.8999999999999999] as const;
const TRIANGLE = [
  { x: 0.2, y: 0.2 },
  { x: 0.7, y: 0.25 },
  { x: 0.4, y: 0.8 },
];

function userAnnotation(overrides: Partial<ClientAnnotation> = {}): ClientAnnotation {
  return {
    id: BBOX_ID,
    pageNumber: PAGE,
    name: "Drag box",
    bbox: [...ORIGIN_BBOX],
    note: null,
    source: "user",
    data: null,
    ...overrides,
  };
}

function vertexAnnotation(overrides: Partial<ClientAnnotation> = {}): ClientAnnotation {
  return {
    id: VERTEX_ID,
    pageNumber: PAGE,
    name: "Asymmetric area",
    bbox: [0.2, 0.2, 0.7, 0.8],
    note: null,
    source: "takeoff",
    data: {
      type: "area-polygon",
      takeoffItemId: 88,
      color: "#22c55e",
      vertices: TRIANGLE,
      areaSqUnits: 37,
      unit: "SF",
    },
    ...overrides,
  };
}

function pageTwoAnnotation(): ClientAnnotation {
  return userAnnotation({
    id: PAGE_TWO_ID,
    pageNumber: 2,
    name: "Destination sentinel",
    bbox: [0.65, 0.65, 0.85, 0.85],
    note: "page two stays exact",
  });
}

function projectResponse(): ProjectResponse {
  return {
    id: PUBLIC_ID,
    dbId: PROJECT_DB_ID,
    name: "Drag terminal fixture",
    assetBaseUrl: "s3://private/drag.json",
    pdfUrl: "s3://private/drag.pdf",
    numPages: 2,
    status: "ready",
    summaries: null,
    projectIntelligence: null,
    pages: [
      { pageNumber: 1, name: "A-101", drawingNumber: null },
      { pageNumber: 2, name: "A-102", drawingNumber: null },
    ],
    demoConfig: {},
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
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

type RetainedFrame = {
  id: number;
  callback: FrameRequestCallback;
  cancelled: boolean;
};

function installRetainedFrames(options: {
  invokeOnCancel?: boolean;
  onCancel?: () => void;
} = {}): RetainedFrame[] {
  const frames: RetainedFrame[] = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = frames.length + 1;
    frames.push({ id, callback, cancelled: false });
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
    const frame = frames.find((candidate) => candidate.id === id);
    if (frame) {
      frame.cancelled = true;
      if (options.invokeOnCancel) frame.callback(16);
      options.onCancel?.();
    }
  }));
  return frames;
}

function runFrame(frame: RetainedFrame, time = 16): void {
  act(() => frame.callback(time));
}

let queryClient: QueryClient;
let lifecycleHandles: OpenProjectHandle[];
let holdProjects: boolean;
const fetchMock = vi.fn();
const persistFetchMock = vi.mocked(persistFetch);

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderCanvas(): HTMLCanvasElement {
  const { container } = render(
    <AnnotationOverlay width={100} height={100} cssScale={1} />,
    { wrapper },
  );
  const canvas = container.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Expected overlay canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return canvas;
}

function row(id: number): ClientAnnotation {
  const found = readAnnotations(queryClient, PUBLIC_ID).find((annotation) => annotation.id === id);
  if (!found) throw new Error(`Missing annotation ${id}`);
  return found;
}

function seedRows(rows: ClientAnnotation[]): void {
  seedAnnotations(queryClient, rows);
}

function startBBoxDrag(canvas: HTMLCanvasElement): void {
  fireEvent.mouseDown(canvas, { clientX: 30, clientY: 30, button: 0, detail: 1 });
}

function startVertexDrag(canvas: HTMLCanvasElement): void {
  fireEvent.mouseDown(canvas, { clientX: 40, clientY: 40, button: 0, detail: 1 });
  fireEvent.mouseDown(canvas, { clientX: 70, clientY: 25, button: 0, detail: 1 });
}

function exactVertexPayload(): { bbox: [number, number, number, number]; data: NonNullable<ClientAnnotation["data"]> } {
  const source = vertexAnnotation();
  const data = source.data!;
  return {
    bbox: [0.2, 0.1, 0.9, 0.8],
    data: {
      ...data,
      vertices: [TRIANGLE[0], { x: 0.9, y: 0.1 }, TRIANGLE[2]],
    },
  };
}

function expectOnlyPut(id: number, body: unknown): void {
  expect(persistFetchMock).toHaveBeenCalledTimes(1);
  expect(persistFetchMock).toHaveBeenCalledWith(`/api/annotations/${id}`, body, "PUT");
}

beforeEach(async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lifecycleHandles = [];
  holdProjects = false;
  persistFetchMock.mockReset();
  persistFetchMock.mockResolvedValue({ id: 1 });
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    const path = String(url);
    if (path === `/api/projects/${PUBLIC_ID}` || path === `/api/demo/projects/${PUBLIC_ID}`) {
      return holdProjects ? never<Response>() : Promise.resolve(jsonResponse(projectResponse()));
    }
    if (
      path === `/api/projects/${PUBLIC_ID}/pages?from=1&to=15` ||
      path === `/api/demo/projects/${PUBLIC_ID}/pages?from=1&to=15`
    ) {
      return holdProjects
        ? never<Response>()
        : Promise.resolve(jsonResponse({ from: 1, to: 2, pages: [], annotations: [] }));
    }
    if (path === `/api/annotation-groups?projectId=${PUBLIC_ID}`) {
      return Promise.resolve(jsonResponse({ groups: [], memberships: [] }));
    }
    throw new Error(`Unexpected drag-terminal request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());

  resetProjectData();
  useUiStore.setState({
    showTextPanel: false,
    showTakeoffPanel: false,
    showDetections: false,
    textPanelTab: "annotations",
  });
  const lifecycleA = openProject(queryClient, PUBLIC_ID, { demo: false });
  lifecycleHandles.push(lifecycleA);
  expect((await lifecycleA.result).status).toBe("opened");
  holdProjects = true;

  setViewerStoreStateForTest({
    projectId: PROJECT_DB_ID,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    numPages: 2,
    pageNames: { 1: "A-101", 2: "A-102" },
    mode: "pointer",
    activeTool: null,
    selectedAnnotationIds: new Set<number>(),
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
    _mousePos: null,
  });
  seedAnnotationGroups(queryClient, [], []);
  seedTakeoff(queryClient, [], []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: 1, to: 2 },
  });
  seedRows([]);
});

afterEach(() => {
  for (const handle of lifecycleHandles.reverse()) handle.dispose();
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AnnotationOverlay exact annotation-drag terminals", () => {
  it("flushes and PUTs the exact latest bbox on mouseup before rAF, retains selection, and retires the frame", () => {
    const frames = installRetainedFrames();
    seedRows([userAnnotation()]);
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
    expect(frames).toHaveLength(1);
    fireEvent.mouseUp(canvas);

    expect(row(BBOX_ID).bbox).toEqual(MOVED_BBOX);
    expectOnlyPut(BBOX_ID, { bbox: MOVED_BBOX });

    const successor = userAnnotation({ name: "newer target", note: "must survive", bbox: [0.1, 0.1, 0.2, 0.2] });
    act(() => seedRows([successor]));
    const installedSuccessor = row(BBOX_ID);
    runFrame(frames[0]);
    expect(row(BBOX_ID)).toBe(installedSuccessor);

    persistFetchMock.mockClear();
    fireEvent.keyDown(window, { key: "Delete" });
    expect(readAnnotations(queryClient, PUBLIC_ID)).toEqual([]);
  });

  it("flushes and PUTs exact full vertex data on mouseup before rAF and makes the closed callback inert", () => {
    const frames = installRetainedFrames();
    seedRows([vertexAnnotation()]);
    const canvas = renderCanvas();
    const expected = exactVertexPayload();

    startVertexDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 90, clientY: 10, buttons: 1 });
    expect(frames).toHaveLength(1);
    fireEvent.mouseUp(canvas);

    expect(row(VERTEX_ID)).toMatchObject(expected);
    expectOnlyPut(VERTEX_ID, expected);

    const successor = vertexAnnotation({ name: "newer vertex target", note: "B" });
    act(() => seedRows([successor]));
    const installedSuccessor = row(VERTEX_ID);
    runFrame(frames[0]);
    expect(row(VERTEX_ID)).toBe(installedSuccessor);

    persistFetchMock.mockClear();
    fireEvent.keyDown(window, { key: "Delete" });
    expect(readAnnotations(queryClient, PUBLIC_ID)).toEqual([]);
  });

  it("preserves the bbox terminal persistence error text", async () => {
    vi.useFakeTimers();
    try {
      persistFetchMock.mockRejectedValueOnce(new Error("bbox wire down"));
      installRetainedFrames();
      seedRows([userAnnotation()]);
      const canvas = renderCanvas();
      startBBoxDrag(canvas);
      fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
      fireEvent.mouseUp(canvas);
      await act(async () => { await Promise.resolve(); });

      expect(useToolStore.getState().bucketFillError).toBe(
        "Failed to save move: bbox wire down",
      );
      act(() => vi.runOnlyPendingTimers());
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the vertex terminal persistence error text", async () => {
    vi.useFakeTimers();
    try {
      persistFetchMock.mockRejectedValueOnce(new Error("vertex wire down"));
      installRetainedFrames();
      seedRows([vertexAnnotation()]);
      const canvas = renderCanvas();
      startVertexDrag(canvas);
      fireEvent.mouseMove(canvas, { clientX: 90, clientY: 10, buttons: 1 });
      fireEvent.mouseUp(canvas);
      await act(async () => { await Promise.resolve(); });

      expect(useToolStore.getState().bucketFillError).toBe(
        "Failed to save edit: vertex wire down",
      );
      act(() => vi.runOnlyPendingTimers());
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses a rejected terminal PUT after its lifecycle is superseded", async () => {
    let rejectPersist!: (reason: Error) => void;
    persistFetchMock.mockReturnValueOnce(new Promise((_, reject) => {
      rejectPersist = reject;
    }));
    installRetainedFrames();
    seedRows([userAnnotation()]);
    const canvas = renderCanvas();
    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
    fireEvent.mouseUp(canvas);
    expect(persistFetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      const lifecycleB = openProject(queryClient, PUBLIC_ID, { demo: false });
      lifecycleHandles.push(lifecycleB);
      seedRows([userAnnotation({ name: "successor" })]);
    });
    await act(async () => {
      rejectPersist(new Error("obsolete failure"));
      await Promise.resolve();
    });

    expect(useToolStore.getState().bucketFillError).toBeNull();
  });

  it("flushes markup-controller resize locally on mouseleave, sends no PUT, and retains selection", () => {
    const frames = installRetainedFrames();
    seedRows([userAnnotation()]);
    act(() => useToolStore.setState({ mode: "markup", activeTool: null }));
    const canvas = renderCanvas();

    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 30, button: 0 });
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 40, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 70, clientY: 80, buttons: 1 });
    expect(frames).toHaveLength(1);
    fireEvent.mouseLeave(canvas);

    expect(row(BBOX_ID).bbox).toEqual([0.2, 0.2, 0.7, 0.8]);
    expect(persistFetchMock).not.toHaveBeenCalled();
    const successor = userAnnotation({ name: "post-leave newer", bbox: [0.1, 0.1, 0.2, 0.2] });
    act(() => seedRows([successor]));
    const installedSuccessor = row(BBOX_ID);
    runFrame(frames[0]);
    expect(row(BBOX_ID)).toBe(installedSuccessor);

    fireEvent.keyDown(window, { key: "Delete" });
    expect(readAnnotations(queryClient, PUBLIC_ID)).toEqual([]);
  });

  it("clears a vertex mouseleave generation so the next bbox gesture is not hijacked", () => {
    const frames = installRetainedFrames();
    const boxB = userAnnotation({ id: BBOX_ID, bbox: [0.02, 0.02, 0.12, 0.12], name: "gesture B" });
    seedRows([vertexAnnotation(), boxB]);
    const canvas = renderCanvas();

    startVertexDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 90, clientY: 10, buttons: 1 });
    fireEvent.mouseLeave(canvas);
    expect(row(VERTEX_ID)).toMatchObject(exactVertexPayload());
    expect(persistFetchMock).not.toHaveBeenCalled();

    fireEvent.mouseDown(canvas, { clientX: 7, clientY: 7, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 27, clientY: 27, buttons: 1 });
    expect(frames).toHaveLength(2);
    runFrame(frames[0]);
    runFrame(frames[1]);

    expect(row(VERTEX_ID)).toMatchObject(exactVertexPayload());
    expect(row(BBOX_ID).bbox).toEqual([0.22, 0.22, 0.32, 0.32]);
  });

  it("rolls back the last published bbox rather than the newer pending bbox on page change", () => {
    const frames = installRetainedFrames();
    const origin = userAnnotation();
    const destination = pageTwoAnnotation();
    seedRows([origin, destination]);
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 50, clientY: 50, buttons: 1 });
    runFrame(frames[0]);
    expect(row(BBOX_ID).bbox).toEqual(HALF_MOVE_BBOX);

    fireEvent.mouseMove(canvas, { clientX: 70, clientY: 60, buttons: 1 });
    expect(frames).toHaveLength(2);
    act(() => setViewerStoreStateForTest({ pageNumber: 2 }));

    expect(row(BBOX_ID)).toMatchObject({ bbox: ORIGIN_BBOX, note: null });
    expect(row(PAGE_TWO_ID)).toBe(destination);
    expect(persistFetchMock).not.toHaveBeenCalled();
    runFrame(frames[1]);
    expect(row(BBOX_ID).bbox).toEqual(ORIGIN_BBOX);

    fireEvent.keyDown(window, { key: "Delete" });
    expect(readAnnotations(queryClient, PUBLIC_ID)).toEqual([origin, destination]);
  });

  it("refuses page rollback after a newer same-geometry target publication", () => {
    const frames = installRetainedFrames();
    seedRows([userAnnotation(), pageTwoAnnotation()]);
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 50, clientY: 50, buttons: 1 });
    runFrame(frames[0]);
    let newer!: ClientAnnotation;
    act(() => {
      const rows = queryClient.setQueryData<ClientAnnotation[]>(
        queryKeys.annotations.all(PUBLIC_ID),
        (old = []) => old.map((annotation) =>
          annotation.id === BBOX_ID
            ? { ...annotation, name: "newer name", note: "newer same-geometry publication" }
            : annotation,
        ),
      );
      newer = rows!.find((annotation) => annotation.id === BBOX_ID)!;
    });

    act(() => setViewerStoreStateForTest({ pageNumber: 2 }));

    expect(row(BBOX_ID)).toBe(newer);
    expect(row(BBOX_ID)).toMatchObject({
      bbox: HALF_MOVE_BBOX,
      name: "newer name",
      note: "newer same-geometry publication",
    });
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("clears selection and makes a before-rAF source-page callback inert after navigation", () => {
    const frames = installRetainedFrames();
    const origin = userAnnotation();
    const destination = pageTwoAnnotation();
    seedRows([origin, destination]);
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
    act(() => setViewerStoreStateForTest({ pageNumber: 2 }));

    expect(row(BBOX_ID)).toBe(origin);
    expect(persistFetchMock).not.toHaveBeenCalled();
    runFrame(frames[0]);
    expect(row(BBOX_ID)).toBe(origin);

    fireEvent.keyDown(window, { key: "Delete" });
    expect(readAnnotations(queryClient, PUBLIC_ID)).toEqual([origin, destination]);
  });

  it("retires a drag across a batched source→destination→source page ABA", () => {
    const frames = installRetainedFrames();
    const origin = userAnnotation();
    const destination = pageTwoAnnotation();
    seedRows([origin, destination]);
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
    act(() => {
      setViewerStoreStateForTest({ pageNumber: 2 });
      setViewerStoreStateForTest({ pageNumber: 1 });
    });

    expect(row(BBOX_ID)).toBe(origin);
    runFrame(frames[0]);
    expect(row(BBOX_ID)).toBe(origin);
    expect(persistFetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Delete" });
    expect(readAnnotations(queryClient, PUBLIC_ID)).toEqual([origin, destination]);
  });

  it("makes an unmounted drag frame inert without publishing or persisting", () => {
    const frames = installRetainedFrames();
    const origin = userAnnotation();
    seedRows([origin]);
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
    cleanup();
    runFrame(frames[0]);

    expect(row(BBOX_ID)).toBe(origin);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("does not recreate or PUT a row deleted during its active drag", () => {
    const frames = installRetainedFrames();
    seedRows([userAnnotation()]);
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(readAnnotations(queryClient, PUBLIC_ID)).toEqual([]);

    fireEvent.mouseUp(canvas);
    runFrame(frames[0]);
    expect(readAnnotations(queryClient, PUBLIC_ID)).toEqual([]);
    expect(persistFetchMock.mock.calls.filter((call) => call[2] === "PUT")).toEqual([]);
  });

  it("invalidates each replaced/terminal frame before synchronous cancellation callbacks", () => {
    const frames = installRetainedFrames({ invokeOnCancel: true });
    seedRows([userAnnotation()]);
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
    const annotationQuery = queryClient.getQueryCache().find({
      queryKey: queryKeys.annotations.all(PUBLIC_ID),
      exact: true,
    });
    let updateEvents = 0;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.query === annotationQuery) updateEvents += 1;
    });

    fireEvent.mouseMove(canvas, { clientX: 70, clientY: 80, buttons: 1 });
    fireEvent.mouseUp(canvas);
    unsubscribe();

    expect(frames).toHaveLength(2);
    expect(row(BBOX_ID).bbox).toEqual(SYNC_CANCEL_BBOX);
    expect(updateEvents).toBe(1);
    expectOnlyPut(BBOX_ID, { bbox: SYNC_CANCEL_BBOX });
  });

  it("clears A state before cancellation so a synchronously admitted B remains dragging", () => {
    let canvas!: HTMLCanvasElement;
    let admitB = false;
    installRetainedFrames({
      onCancel: () => {
        if (!admitB) return;
        admitB = false;
        fireEvent.mouseDown(canvas, { clientX: 80, clientY: 80, button: 0 });
      },
    });
    const dragA = userAnnotation({ bbox: [0.1, 0.1, 0.3, 0.3], name: "gesture A" });
    const dragB = userAnnotation({ id: 174, bbox: [0.7, 0.7, 0.9, 0.9], name: "gesture B" });
    seedRows([dragA, dragB]);
    canvas = renderCanvas();

    fireEvent.mouseDown(canvas, { clientX: 20, clientY: 20, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 40, clientY: 40, buttons: 1 });
    admitB = true;
    fireEvent.mouseUp(canvas);

    persistFetchMock.mockClear();
    fireEvent.keyDown(window, { key: "Enter" });
    expectOnlyPut(dragB.id, { bbox: dragB.bbox });
  });

  it("refuses a PUT when a synchronous cache subscriber replaces the flushed target", () => {
    installRetainedFrames();
    seedRows([userAnnotation()]);
    const canvas = renderCanvas();
    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });

    const annotationQuery = queryClient.getQueryCache().find({
      queryKey: queryKeys.annotations.all(PUBLIC_ID),
      exact: true,
    });
    let replacing = false;
    let replacement: ClientAnnotation | null = null;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (replacing || event.type !== "updated" || event.query !== annotationQuery) return;
      const target = row(BBOX_ID);
      if (target.note !== null || target.bbox.join(",") !== MOVED_BBOX.join(",")) return;
      replacing = true;
      queryClient.setQueryData<ClientAnnotation[]>(
        queryKeys.annotations.all(PUBLIC_ID),
        (old = []) => old.map((annotation) => annotation.id === BBOX_ID
          ? { ...annotation, note: "synchronous successor" }
          : annotation),
      );
      replacement = row(BBOX_ID);
    });

    fireEvent.mouseUp(canvas);
    unsubscribe();

    expect(replacement).not.toBeNull();
    expect(row(BBOX_ID)).toBe(replacement);
    expect(row(BBOX_ID)).toMatchObject({ bbox: MOVED_BBOX, note: "synchronous successor" });
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("rolls back and refuses PUT when terminal publication reentrantly crosses a page ABA", () => {
    const frames = installRetainedFrames();
    seedRows([userAnnotation(), pageTwoAnnotation()]);
    const canvas = renderCanvas();
    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });

    const annotationQuery = queryClient.getQueryCache().find({
      queryKey: queryKeys.annotations.all(PUBLIC_ID),
      exact: true,
    });
    let transitioned = false;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (transitioned || event.type !== "updated" || event.query !== annotationQuery) return;
      if (row(BBOX_ID).bbox.join(",") !== MOVED_BBOX.join(",")) return;
      transitioned = true;
      setViewerStoreStateForTest({ pageNumber: 2 });
      setViewerStoreStateForTest({ pageNumber: 1 });
    });

    fireEvent.mouseUp(canvas);
    unsubscribe();

    expect(transitioned).toBe(true);
    expect(row(BBOX_ID).bbox).toEqual(ORIGIN_BBOX);
    expect(persistFetchMock).not.toHaveBeenCalled();
    runFrame(frames[0]);
    expect(row(BBOX_ID).bbox).toEqual(ORIGIN_BBOX);
  });

  it("rolls back an rAF publication whose cache notification crosses a page ABA", () => {
    const frames = installRetainedFrames();
    seedRows([userAnnotation(), pageTwoAnnotation()]);
    const canvas = renderCanvas();
    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });

    const annotationQuery = queryClient.getQueryCache().find({
      queryKey: queryKeys.annotations.all(PUBLIC_ID),
      exact: true,
    });
    let transitioned = false;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (transitioned || event.type !== "updated" || event.query !== annotationQuery) return;
      if (row(BBOX_ID).bbox.join(",") !== MOVED_BBOX.join(",")) return;
      transitioned = true;
      setViewerStoreStateForTest({ pageNumber: 2 });
      setViewerStoreStateForTest({ pageNumber: 1 });
    });

    runFrame(frames[0]);
    unsubscribe();

    expect(transitioned).toBe(true);
    expect(row(BBOX_ID).bbox).toEqual(ORIGIN_BBOX);
    expect(persistFetchMock).not.toHaveBeenCalled();
    fireEvent.mouseUp(canvas);
    expect(row(BBOX_ID).bbox).toEqual(ORIGIN_BBOX);
  });

  it("keeps polygon-cursor and annotation-drag frames independently live", () => {
    const frames = installRetainedFrames();
    seedRows([userAnnotation()]);
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    act(() => useToolStore.setState({ polygonDrawingMode: "drawing", _mousePos: null }));
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });

    expect(frames).toHaveLength(2);
    expect(frames[0].cancelled).toBe(false);
    runFrame(frames[0]);
    runFrame(frames[1]);
    expect(useToolStore.getState()._mousePos).toEqual({ x: 60, y: 70 });
    expect(row(BBOX_ID).bbox).toEqual(MOVED_BBOX);
  });

  it("does not let a same-publicId lifecycle successor borrow the retired vertex ref", () => {
    const frames = installRetainedFrames();
    seedRows([vertexAnnotation()]);
    const canvas = renderCanvas();
    startVertexDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 90, clientY: 10, buttons: 1 });
    runFrame(frames[0]);

    const successorBox = userAnnotation({ bbox: [0.6, 0.6, 0.8, 0.8], name: "successor B box" });
    act(() => {
      const lifecycleB = openProject(queryClient, PUBLIC_ID, { demo: false });
      lifecycleHandles.push(lifecycleB);
      setViewerStoreStateForTest({
        projectId: PROJECT_DB_ID,
        publicId: PUBLIC_ID,
        isDemo: false,
        pageNumber: PAGE,
        numPages: 2,
      });
      seedRows([successorBox]);
    });
    act(() => useToolStore.setState({ mode: "move" }));
    act(() => useToolStore.setState({ mode: "pointer" }));

    fireEvent.mouseDown(canvas, { clientX: 70, clientY: 70, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 50, clientY: 50, buttons: 1 });
    expect(frames).toHaveLength(2);
    runFrame(frames[0]);
    runFrame(frames[1]);

    expect(row(BBOX_ID)).toMatchObject({
      name: "successor B box",
      bbox: HALF_MOVE_BBOX,
    });
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("refuses A physics in the same-publicId pre-passive-effect replacement window", () => {
    const frames = installRetainedFrames();
    seedRows([vertexAnnotation()]);
    const canvas = renderCanvas();
    startVertexDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 90, clientY: 10, buttons: 1 });
    expect(frames).toHaveLength(1);

    act(() => {
      const lifecycleB = openProject(queryClient, PUBLIC_ID, { demo: false });
      lifecycleHandles.push(lifecycleB);
      canvas.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        clientX: 50,
        clientY: 50,
        buttons: 1,
      }));
    });

    expect(frames).toHaveLength(1);
    const installed = readAnnotations(queryClient, PUBLIC_ID);
    runFrame(frames[0]);
    expect(readAnnotations(queryClient, PUBLIC_ID)).toBe(installed);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("keeps authenticated temporary-id mouseup local while still flushing exact geometry", () => {
    installRetainedFrames();
    const tempId = -BBOX_ID;
    seedRows([userAnnotation({ id: tempId })]);
    const canvas = renderCanvas();

    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 30, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
    fireEvent.mouseUp(canvas);

    expect(row(tempId).bbox).toEqual(MOVED_BBOX);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });

  it("keeps demo positive-id mouseup local while still flushing exact geometry", () => {
    installRetainedFrames();
    act(() => {
      const lifecycleB = openProject(queryClient, PUBLIC_ID, { demo: true });
      lifecycleHandles.push(lifecycleB);
      setViewerStoreStateForTest({
        projectId: PROJECT_DB_ID,
        publicId: PUBLIC_ID,
        isDemo: true,
        pageNumber: PAGE,
        numPages: 2,
      });
      seedRows([userAnnotation()]);
    });
    act(() => useToolStore.setState({ mode: "move" }));
    act(() => useToolStore.setState({ mode: "pointer" }));
    const canvas = renderCanvas();

    startBBoxDrag(canvas);
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 70, buttons: 1 });
    fireEvent.mouseUp(canvas);

    expect(row(BBOX_ID).bbox).toEqual(MOVED_BBOX);
    expect(persistFetchMock).not.toHaveBeenCalled();
  });
});
