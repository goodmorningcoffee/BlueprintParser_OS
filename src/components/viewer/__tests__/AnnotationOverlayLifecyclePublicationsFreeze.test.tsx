// @vitest-environment jsdom

// [refactor jul14 P2.5 B1] RED witnesses for AnnotationOverlay's synchronous and rAF tails.
//
// Every case installs a real same-publicId successor lifecycle from inside the first publication
// (or before releasing a queued animation frame), then gives B unmistakable sentinel state. The
// assertions name only that successor state: current production is RED exactly when A resumes and
// mutates B. Network responses for B deliberately never settle so lifecycle authority, not route
// completion, is the boundary under test.

import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  openProject,
  type OpenProjectHandle,
  type ProjectResponse,
} from "@/lib/project-lifecycle";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useToolStore } from "@/stores/toolStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { readSeededAnnotations, seedAnnotations } from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import { useUiStore } from "@/stores/uiStore";
import type { ClientAnnotation, ClientTakeoffItem, YoloTag } from "@/types";

vi.mock("@/lib/bucket-fill-client", () => ({
  clientBucketFill: vi.fn(),
  findPageCanvas: vi.fn(() => null),
}));
vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "overlay-lifecycle-project";
const PROJECT_DB_ID = 901;
const PAGE = 1;
const ITEM_ID = 801;
const B_MOUSE = { x: 91, y: 92 };
const B_POINT = { x: 0.91, y: 0.92 };
const B_VERTICES = [{ x: 0.81, y: 0.82 }, { x: 0.83, y: 0.84 }];
const B_SEARCH = "successor B search";
const B_ANNOTATION_FILTER = "successor B annotation filter";
const B_TAKEOFF_FILTER = 9801;
const B_MARKUP_ID = 9802;
const B_YOLO_TAG_ID = "successor-b-tag";
const B_YOLO_FILTER = "successor-b-filter";
const HOLED_TARGET_MESSAGE = "Area polygons with holes cannot be split yet";

const SQUARE = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.8, y: 0.8 },
  { x: 0.2, y: 0.8 },
];

function takeoffItem(shape: "polygon" | "linear"): ClientTakeoffItem {
  return {
    id: ITEM_ID,
    groupId: null,
    name: `${shape} item`,
    shape,
    color: "#22c55e",
    size: 10,
    sortOrder: 0,
  };
}

function areaAnnotation(
  overrides: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id: 71,
    pageNumber: PAGE,
    name: "Area A",
    bbox: [0.2, 0.2, 0.8, 0.8],
    note: null,
    source: "takeoff",
    data: {
      type: "area-polygon",
      takeoffItemId: ITEM_ID,
      color: "#22c55e",
      vertices: SQUARE,
      areaSqUnits: 36,
      unit: "SF",
    },
    ...overrides,
  };
}

function userAnnotation(
  overrides: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id: 72,
    pageNumber: PAGE,
    name: "Markup A",
    bbox: [0.2, 0.2, 0.4, 0.4],
    note: null,
    source: "user",
    data: null,
    ...overrides,
  };
}

function yoloAnnotation(
  overrides: Partial<ClientAnnotation> = {},
): ClientAnnotation {
  return {
    id: 73,
    pageNumber: PAGE,
    name: "Door",
    bbox: [0.2, 0.2, 0.4, 0.4],
    note: null,
    source: "yolo",
    data: { modelName: "fixture-model" },
    ...overrides,
  };
}

function yoloTagFor(annotationId: number): YoloTag {
  return {
    id: "tag-a",
    name: "Door tag A",
    tagText: "D-01",
    yoloClass: "Door",
    yoloModel: "fixture-model",
    source: "schedule",
    scope: "project",
    instances: [{
      pageNumber: PAGE,
      annotationId,
      bbox: [0.2, 0.2, 0.4, 0.4],
      confidence: 1,
    }],
  };
}

function projectResponse(): ProjectResponse {
  return {
    id: PUBLIC_ID,
    dbId: PROJECT_DB_ID,
    name: "Overlay lifecycle fixture",
    assetBaseUrl: "s3://private/overlay.json",
    pdfUrl: "s3://private/overlay.pdf",
    numPages: 2,
    status: "ready",
    summaries: null,
    projectIntelligence: null,
    pages: [{ pageNumber: PAGE, name: "A-101", drawingNumber: null }],
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
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
let holdSuccessor: boolean;
let lifecycleHandles: OpenProjectHandle[];
let splitPuts: Deferred<Response>[];
let splitPosts: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderCanvas(beforeOverlay: ReactNode = null): HTMLCanvasElement {
  const { container } = render(
    <>
      {beforeOverlay}
      <AnnotationOverlay width={100} height={100} cssScale={1} />
    </>,
    { wrapper },
  );
  const canvas = container.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Expected AnnotationOverlay canvas");
  }
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(canvasRect());
  return canvas;
}

function InstallSuccessorBeforeOverlayEffects({ seedB }: { seedB: () => void }) {
  useEffect(() => {
    installSameIdSuccessor(seedB);
  }, [seedB]);
  return null;
}

function installSameIdSuccessor(
  seedB: () => void,
  demo = true,
): OpenProjectHandle {
  const handle = openProject(queryClient, PUBLIC_ID, { demo });
  lifecycleHandles.push(handle);
  // B owns the lifecycle before its held metadata resolves. Restore its same route tuple and then
  // publish the exact sentinel whose survival the caller asserts.
  setViewerStoreStateForTest({
    projectId: PROJECT_DB_ID,
    publicId: PUBLIC_ID,
    isDemo: demo,
    pageNumber: PAGE,
    numPages: 2,
  });
  seedB();
  return handle;
}

function installPolygonSuccessor(
  mode: "pointer" | "markup" = "pointer",
  activeTakeoffItemId: number | null = null,
): OpenProjectHandle {
  return installSameIdSuccessor(() => {
    useToolStore.setState({
      mode,
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId,
      polygonDrawingMode: "drawing",
      polygonVertices: B_VERTICES,
      _mousePos: B_MOUSE,
    });
  });
}

function installFrames(): FrameRequestCallback[] {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return frames;
}

beforeEach(async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lifecycleHandles = [];
  splitPuts = [];
  splitPosts = [];
  holdSuccessor = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path === `/api/annotations/${areaAnnotation().id}` && init?.method === "PUT") {
      const request = deferred<Response>();
      splitPuts.push(request);
      return request.promise;
    }
    if (path === "/api/annotations" && init?.method === "POST") {
      const request = deferred<Response>();
      splitPosts.push(request);
      return request.promise;
    }
    if (path === `/api/projects/${PUBLIC_ID}`) {
      return holdSuccessor ? never<Response>() : Promise.resolve(jsonResponse(projectResponse()));
    }
    if (path === `/api/projects/${PUBLIC_ID}/pages?from=1&to=15`) {
      return holdSuccessor
        ? never<Response>()
        : Promise.resolve(jsonResponse({ from: 1, to: 2, pages: [], annotations: [] }));
    }
    if (path === `/api/annotation-groups?projectId=${PUBLIC_ID}`) {
      return Promise.resolve(jsonResponse({ groups: [], memberships: [] }));
    }
    if (path === `/api/demo/projects/${PUBLIC_ID}`) {
      return holdSuccessor ? never<Response>() : Promise.resolve(jsonResponse(projectResponse()));
    }
    if (path === `/api/demo/projects/${PUBLIC_ID}/pages?from=1&to=15`) {
      return holdSuccessor
        ? never<Response>()
        : Promise.resolve(jsonResponse({ from: 1, to: 2, pages: [], annotations: [] }));
    }
    throw new Error(`Unexpected Overlay lifecycle request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());

  resetProjectData();
  // These presentation fields intentionally survive a production project reset. Pin them here so
  // parameterized lifecycle witnesses cannot inherit panel/detection preferences from one another.
  useUiStore.setState({
    showTextPanel: false,
    showTakeoffPanel: false,
    showDetections: false,
    textPanelTab: "annotations",
  });
  const lifecycleA = openProject(queryClient, PUBLIC_ID, { demo: true });
  lifecycleHandles.push(lifecycleA);
  expect((await lifecycleA.result).status).toBe("opened");
  holdSuccessor = true;

  setViewerStoreStateForTest({
    projectId: PROJECT_DB_ID,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE,
    numPages: 2,
    pageNames: { [PAGE]: "A-101" },
    mode: "pointer",
    activeTool: null,
    selectedAnnotationIds: new Set<number>(),
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
    _mousePos: null,
  });
  seedAnnotations(queryClient, []);
  seedAnnotationGroups(queryClient, [], []);
  seedTakeoff(queryClient, [], []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: PAGE, to: PAGE },
  });
});

afterEach(() => {
  for (const handle of lifecycleHandles.reverse()) handle.dispose();
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AnnotationOverlay paired project publications", () => {
  it.each([
    {
      label: "polygon",
      shape: "polygon" as const,
      vertices: [
        { x: 0.1, y: 0.1 },
        { x: 0.7, y: 0.1 },
        { x: 0.7, y: 0.7 },
      ],
    },
    {
      label: "linear",
      shape: "linear" as const,
      vertices: [{ x: 0.1, y: 0.1 }, { x: 0.7, y: 0.7 }],
    },
  ])("$label reset does not clear successor B's mouse position", ({ shape, vertices }) => {
    seedTakeoff(queryClient, [takeoffItem(shape)], []);
    act(() => useToolStore.getState().setActiveTakeoffItemId(ITEM_ID));
    const canvas = renderCanvas();
    act(() => {
      useToolStore.setState({
        polygonDrawingMode: "drawing",
        polygonVertices: vertices,
        _mousePos: { x: 20, y: 30 },
      });
    });

    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || previous.polygonDrawingMode !== "drawing" ||
          state.polygonDrawingMode !== "idle") return;
      admittedB = true;
      installSameIdSuccessor(() => {
        useToolStore.setState({
          activeTool: { kind: "takeoffPlacement" },
          activeTakeoffItemId: ITEM_ID,
          polygonDrawingMode: "drawing",
          polygonVertices: B_VERTICES,
          _mousePos: B_MOUSE,
        });
      });
    });

    expect(useToolStore.getState().activeTool?.kind).toBe("takeoffPlacement");
    expect(useToolStore.getState().polygonDrawingMode).toBe("drawing");
    expect(queryClient.getQueryData<ClientTakeoffItem[]>(
      queryKeys.takeoff.items(PUBLIC_ID),
    )).toHaveLength(1);
    fireEvent.doubleClick(canvas);
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useToolStore.getState()._mousePos).toEqual(B_MOUSE);
  });

  it("missing split target does not clear successor B's split endpoint", () => {
    const stalePreview = {
      targetAnnotationId: 999,
      original: SQUARE,
      left: SQUARE.slice(0, 3),
      right: SQUARE.slice(1),
      lineA: { x: 0.1, y: 0.5 },
      lineB: { x: 0.9, y: 0.5 },
    };
    renderCanvas();
    act(() => {
      useToolStore.getState().setSplitAreaActive(true);
      useToolStore.setState({ splitPreview: stalePreview });
    });

    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || previous.splitPreview !== stalePreview || state.splitPreview !== null) return;
      admittedB = true;
      installSameIdSuccessor(() => {
        useToolStore.setState({
          activeTool: { kind: "split" },
          splitLineA: B_POINT,
        });
      });
    });

    fireEvent.keyDown(window, { key: "Enter" });
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useToolStore.getState().splitLineA).toEqual(B_POINT);
  });

  async function assertHoledAcceptFailsClosed(
    authenticated: boolean,
  ): Promise<void> {
    if (authenticated) {
      holdSuccessor = false;
      const authenticatedA = openProject(queryClient, PUBLIC_ID, {
        demo: false,
      });
      lifecycleHandles.push(authenticatedA);
      expect((await authenticatedA.result).status).toBe("opened");
      holdSuccessor = true;
    }
    const holeSentinel = [
      { x: 0.35, y: 0.35 },
      { x: 0.45, y: 0.35 },
      { x: 0.45, y: 0.45 },
      { x: 0.35, y: 0.45 },
    ];
    const unholedSource = areaAnnotation();
    const holedSource = areaAnnotation({
      data: {
        type: "area-polygon",
        takeoffItemId: ITEM_ID,
        color: "#22c55e",
        vertices: SQUARE,
        holes: [{ vertices: holeSentinel }],
        areaSqUnits: 32,
        unit: "SF",
      },
    });
    const lineA = { x: 0.1, y: 0.5 };
    const lineB = { x: 0.9, y: 0.5 };
    const preview = {
      targetAnnotationId: unholedSource.id,
      original: SQUARE,
      left: [SQUARE[0], { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.8 }, SQUARE[3]],
      right: [{ x: 0.5, y: 0.2 }, SQUARE[1], SQUARE[2], { x: 0.5, y: 0.8 }],
      lineA,
      lineB,
    };
    seedAnnotations(queryClient, [unholedSource]);
    seedTakeoff(queryClient, [takeoffItem("polygon")], []);
    renderCanvas();
    act(() => {
      useToolStore.getState().setSplitAreaActive(true);
      useToolStore.setState({
        splitPreview: preview,
        splitLineA: lineA,
        splitLineB: lineB,
      });
    });
    expect(readSeededAnnotations(queryClient)[0]).toBe(unholedSource);
    const liveRows = [holedSource];
    const timeout = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(() => 1 as unknown as ReturnType<typeof setTimeout>);
    timeout.mockClear();
    fetchMock.mockClear();

    let rowsBeforeAccept: readonly ClientAnnotation[] = [];
    act(() => {
      // The preview's render capture remains unholed for this turn, while acceptSplit's
      // synchronous cache bridge must observe the same-ID concurrent holes update.
      seedAnnotations(queryClient, liveRows);
      rowsBeforeAccept = readSeededAnnotations(queryClient);
      timeout.mockClear();
      fireEvent.keyDown(window, { key: "Enter" });
    });

    const rowsAfter = readSeededAnnotations(queryClient);
    expect(rowsAfter).toBe(rowsBeforeAccept);
    expect(rowsAfter[0]).toBe(rowsBeforeAccept[0]);
    expect(
      (rowsAfter[0]?.data as { holes?: { vertices: unknown }[] }).holes?.[0]
        ?.vertices,
    ).toBe(holeSentinel);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useToolStore.getState().splitPreview).toBe(preview);
    expect(useToolStore.getState().splitLineA).toBe(lineA);
    expect(useToolStore.getState().splitLineB).toBe(lineB);
    expect(useToolStore.getState().splitError).toBe(HOLED_TARGET_MESSAGE);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 5000);
  }

  it.each([
    { label: "demo", authenticated: false },
    { label: "persistable auth", authenticated: true },
  ])(
    "$label live holed split target rejects Accept before cache mutation or network",
    ({ authenticated }) => assertHoledAcceptFailsClosed(authenticated),
  );

  it("an explicit empty holes array remains locally splittable on Accept", () => {
    const source = areaAnnotation({
      data: {
        type: "area-polygon",
        takeoffItemId: ITEM_ID,
        color: "#22c55e",
        vertices: SQUARE,
        holes: [],
        areaSqUnits: 36,
        unit: "SF",
      },
    });
    const lineA = { x: 0.1, y: 0.5 };
    const lineB = { x: 0.9, y: 0.5 };
    const left = [SQUARE[0], { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.8 }, SQUARE[3]];
    const right = [
      { x: 0.5, y: 0.2 },
      SQUARE[1],
      SQUARE[2],
      { x: 0.5, y: 0.8 },
    ];
    const preview = {
      targetAnnotationId: source.id,
      original: SQUARE,
      left,
      right,
      lineA,
      lineB,
    };
    seedAnnotations(queryClient, [source]);
    seedTakeoff(queryClient, [takeoffItem("polygon")], []);
    renderCanvas();
    act(() => {
      useToolStore.getState().setSplitAreaActive(true);
      useToolStore.setState({
        splitPreview: preview,
        splitLineA: lineA,
        splitLineB: lineB,
      });
    });
    fetchMock.mockClear();

    fireEvent.keyDown(window, { key: "Enter" });

    const rows = readSeededAnnotations(queryClient);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === source.id)?.data).toMatchObject({
      vertices: left,
    });
    expect(rows.find((row) => row.id < 0)?.data).toMatchObject({
      vertices: right,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useToolStore.getState()).toMatchObject({
      splitPreview: null,
      splitLineA: null,
      splitLineB: null,
      splitError: null,
    });
  });

  it("second split click does not publish A's preview into successor B", () => {
    const source = areaAnnotation();
    const bPreview = {
      targetAnnotationId: 700,
      original: B_VERTICES,
      left: [...B_VERTICES, { x: 0.85, y: 0.86 }],
      right: [...B_VERTICES, { x: 0.87, y: 0.88 }],
      lineA: B_POINT,
      lineB: { x: 0.95, y: 0.96 },
    };
    seedAnnotations(queryClient, [source]);
    const canvas = renderCanvas();
    act(() => {
      useToolStore.getState().setSplitAreaActive(true);
      useToolStore.getState().setSplitLineEndpoint("a", { x: 0.1, y: 0.5 });
    });

    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || state.splitLineB === previous.splitLineB ||
          state.splitLineB?.x !== 0.9 || state.splitLineB?.y !== 0.5) return;
      admittedB = true;
      installSameIdSuccessor(() => {
        useToolStore.setState({
          activeTool: { kind: "split" },
          splitPreview: bPreview,
        });
      });
    });

    fireEvent.mouseDown(canvas, { clientX: 90, clientY: 50, button: 0 });
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useToolStore.getState().splitPreview).toBe(bPreview);
  });

  it.each([
    { label: "auth→auth", successorDemo: false },
    { label: "auth→demo", successorDemo: true },
  ])(
    "$label retirement still completes the admitted split pair without adopting into B",
    async ({ successorDemo }) => {
      holdSuccessor = false;
      const authenticatedA = openProject(queryClient, PUBLIC_ID, { demo: false });
      lifecycleHandles.push(authenticatedA);
      expect((await authenticatedA.result).status).toBe("opened");
      holdSuccessor = true;

      const source = areaAnnotation();
      const right = [
        { x: 0.5, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.5, y: 0.8 },
      ];
      const preview = {
        targetAnnotationId: source.id,
        original: SQUARE,
        left: [
          { x: 0.2, y: 0.2 },
          { x: 0.5, y: 0.2 },
          { x: 0.5, y: 0.8 },
          { x: 0.2, y: 0.8 },
        ],
        right,
        lineA: { x: 0.5, y: 0.2 },
        lineB: { x: 0.5, y: 0.8 },
      };
      seedAnnotations(queryClient, [source]);
      seedTakeoff(queryClient, [takeoffItem("polygon")], []);
      renderCanvas();
      act(() => {
        useToolStore.getState().setSplitAreaActive(true);
        useToolStore.setState({ splitPreview: preview });
      });

      fireEvent.keyDown(window, { key: "Enter" });
      expect(splitPuts).toHaveLength(1);
      expect(splitPosts).toHaveLength(0);
      const optimisticRight = readSeededAnnotations(queryClient).find(
        (annotation) => annotation.id < 0,
      );
      if (!optimisticRight) throw new Error("Expected captured optimistic right half");

      const successorRows = [userAnnotation({
        // Deliberately collide with A's temp id so a missing saved-id guard rewrites B to 8801.
        id: optimisticRight.id,
        name: "successor B row",
      })];
      const successorPreview = {
        ...preview,
        targetAnnotationId: successorRows[0].id,
      };
      act(() => {
        installSameIdSuccessor(() => {
          seedAnnotations(queryClient, successorRows);
          useToolStore.setState({
            activeTool: { kind: "split" },
            splitPreview: successorPreview,
            splitLineA: B_POINT,
            splitLineB: { x: 0.95, y: 0.96 },
            splitError: "successor B split error",
          });
        }, successorDemo);
      });

      await act(async () => {
        splitPuts[0].resolve(jsonResponse({ id: source.id }));
        await Promise.resolve();
      });
      await waitFor(() => expect(splitPosts).toHaveLength(1));
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === "/api/annotations" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      if (!postCall) throw new Error("Expected captured right-half POST");
      expect(JSON.parse(String((postCall[1] as RequestInit).body))).toMatchObject({
        projectId: PUBLIC_ID,
        pageNumber: PAGE,
        bbox: [0.5, 0.2, 0.8, 0.8],
        data: { vertices: right },
      });

      await act(async () => {
        splitPosts[0].resolve(jsonResponse({ id: 8801 }));
        await Promise.resolve();
      });
      expect(readSeededAnnotations(queryClient)).toEqual(successorRows);
      expect(useToolStore.getState().splitPreview).toBe(successorPreview);
      expect(useToolStore.getState().splitLineA).toEqual(B_POINT);
      expect(useToolStore.getState().splitError).toBe(
        "successor B split error",
      );
    },
  );

  it("barrier completion does not clear successor B's pending point", () => {
    const bBarriers = [{ x1: 0.7, y1: 0.7, x2: 0.8, y2: 0.8 }];
    const canvas = renderCanvas();
    act(() => {
      useToolStore.getState().setBucketFillActive(true);
      useToolStore.getState().setBucketFillBarrierMode(true);
      useToolStore.getState().setBarrierPendingPoint({ x: 0.1, y: 0.2 });
    });

    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || state.bucketFillBarriers.length <= previous.bucketFillBarriers.length) return;
      admittedB = true;
      installSameIdSuccessor(() => {
        useToolStore.setState({
          activeTool: { kind: "bucketFill" },
          bucketFillBarrierMode: true,
          barrierPendingPoint: B_POINT,
          bucketFillBarriers: bBarriers,
        });
      });
    });

    fireEvent.mouseDown(canvas, { clientX: 70, clientY: 80, button: 0 });
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useToolStore.getState().barrierPendingPoint).toEqual(B_POINT);
  });

  it.each([
    { label: "polygon", shape: "polygon" as const },
    { label: "linear", shape: "linear" as const },
  ])("$label start does not append A's first vertex to successor B", ({ shape }) => {
    seedTakeoff(queryClient, [takeoffItem(shape)], []);
    const canvas = renderCanvas();
    act(() => useToolStore.getState().setActiveTakeoffItemId(ITEM_ID));

    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || previous.polygonDrawingMode !== "idle" ||
          state.polygonDrawingMode !== "drawing") return;
      admittedB = true;
      installSameIdSuccessor(() => {
        useToolStore.setState({
          activeTool: { kind: "takeoffPlacement" },
          activeTakeoffItemId: ITEM_ID,
          polygonDrawingMode: "drawing",
          polygonVertices: B_VERTICES,
        });
      });
    });

    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 50, button: 0 });
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useToolStore.getState().polygonVertices).toEqual(B_VERTICES);
  });
});

describe("AnnotationOverlay passive polygon cleanup ownership", () => {
  it("mode-change cleanup does not clear successor B's polygon cursor", () => {
    useUiStore.setState({ showTakeoffPanel: true });
    renderCanvas();
    act(() => useToolStore.setState({
      mode: "pointer",
      activeTool: null,
      activeTakeoffItemId: null,
      polygonDrawingMode: "drawing",
      polygonVertices: SQUARE,
      _mousePos: { x: 20, y: 30 },
    }));

    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || previous.polygonDrawingMode !== "drawing" ||
          state.polygonDrawingMode !== "idle") return;
      admittedB = true;
      installPolygonSuccessor("markup");
    });

    act(() => useToolStore.setState({ mode: "markup" }));
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useToolStore.getState()._mousePos).toEqual(B_MOUSE);
  });

  it("active-item cleanup does not clear successor B's polygon cursor", () => {
    useUiStore.setState({ showTakeoffPanel: true });
    renderCanvas();
    act(() => useToolStore.setState({
      mode: "pointer",
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: null,
      polygonDrawingMode: "drawing",
      polygonVertices: SQUARE,
      _mousePos: { x: 20, y: 30 },
    }));

    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || previous.polygonDrawingMode !== "drawing" ||
          state.polygonDrawingMode !== "idle") return;
      admittedB = true;
      installPolygonSuccessor("pointer", ITEM_ID);
    });

    act(() => useToolStore.setState({ activeTakeoffItemId: ITEM_ID }));
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useToolStore.getState()._mousePos).toEqual(B_MOUSE);
  });

  it("panel-close cleanup does not clear successor B's polygon cursor", () => {
    useUiStore.setState({ showTakeoffPanel: true });
    renderCanvas();
    act(() => useToolStore.setState({
      mode: "pointer",
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: null,
      polygonDrawingMode: "drawing",
      polygonVertices: SQUARE,
      _mousePos: { x: 20, y: 30 },
    }));

    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || previous.polygonDrawingMode !== "drawing" ||
          state.polygonDrawingMode !== "idle") return;
      admittedB = true;
      installPolygonSuccessor();
    });

    act(() => useUiStore.setState({ showTakeoffPanel: false }));
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useToolStore.getState()._mousePos).toEqual(B_MOUSE);
  });

  it("Escape cleanup does not clear successor B's polygon cursor", () => {
    useUiStore.setState({ showTakeoffPanel: true });
    const canvas = renderCanvas();
    act(() => useToolStore.setState({
      mode: "pointer",
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: null,
      polygonDrawingMode: "drawing",
      polygonVertices: SQUARE,
      _mousePos: { x: 20, y: 30 },
    }));

    let admittedB = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (admittedB || previous.polygonDrawingMode !== "drawing" ||
          state.polygonDrawingMode !== "idle") return;
      admittedB = true;
      installPolygonSuccessor();
    });

    fireEvent.keyDown(window, { key: "Escape" });
    unsubscribe();
    expect(canvas).toBeInTheDocument();
    expect(admittedB).toBe(true);
    expect(useToolStore.getState()._mousePos).toEqual(B_MOUSE);
  });
});

describe("AnnotationOverlay pointer UI publication ownership", () => {
  it.each([
    {
      label: "annotation filter",
      read: () => useUiStore.getState().activeAnnotationFilter,
      expected: B_ANNOTATION_FILTER,
    },
    {
      label: "active markup",
      read: () => useUiStore.getState().activeMarkupId,
      expected: B_MARKUP_ID,
    },
    {
      label: "text-panel tab",
      read: () => useUiStore.getState().textPanelTab,
      expected: "annotations",
    },
    {
      label: "text-panel visibility",
      read: () => useUiStore.getState().showTextPanel,
      expected: false,
    },
  ])("markup double-click preserves successor B's $label", ({ read, expected }) => {
    const annotation = userAnnotation();
    seedAnnotations(queryClient, [annotation]);
    const canvas = renderCanvas();

    let admittedB = false;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.searchQuery === annotation.name ||
          state.searchQuery !== annotation.name) return;
      admittedB = true;
      installSameIdSuccessor(() => {
        useUiStore.setState({
          searchQuery: B_SEARCH,
          activeAnnotationFilter: B_ANNOTATION_FILTER,
          activeMarkupId: B_MARKUP_ID,
          textPanelTab: "annotations",
          showTextPanel: false,
        });
      });
    });

    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 30, button: 0, detail: 2 });
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(read()).toEqual(expected);
  });

  it("takeoff double-click preserves successor B's takeoff filter", () => {
    const item = takeoffItem("polygon");
    const annotation = areaAnnotation();
    seedTakeoff(queryClient, [item], []);
    seedAnnotations(queryClient, [annotation]);
    const canvas = renderCanvas();

    let admittedB = false;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.searchQuery === item.name ||
          state.searchQuery !== item.name) return;
      admittedB = true;
      installSameIdSuccessor(() => {
        useUiStore.setState({
          searchQuery: B_SEARCH,
          activeTakeoffFilter: B_TAKEOFF_FILTER,
        });
      });
    });

    fireEvent.mouseDown(canvas, { clientX: 50, clientY: 50, button: 0, detail: 2 });
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useUiStore.getState().activeTakeoffFilter).toBe(B_TAKEOFF_FILTER);
  });

  it.each([
    {
      label: "search",
      read: () => useUiStore.getState().searchQuery,
      expected: B_SEARCH,
    },
    {
      label: "active YOLO tag",
      read: () => useUiStore.getState().activeYoloTagId,
      expected: B_YOLO_TAG_ID,
    },
    {
      label: "YOLO tag filter",
      read: () => useUiStore.getState().activeYoloTagFilter,
      expected: B_YOLO_FILTER,
    },
  ])("plain YOLO click preserves successor B's $label", ({ read, expected }) => {
    const annotation = yoloAnnotation();
    useUiStore.setState({ showDetections: true });
    seedAnnotations(queryClient, [annotation]);
    seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, {
      yoloTags: [yoloTagFor(annotation.id)],
    });
    const canvas = renderCanvas();

    let admittedB = false;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      const selectedA = state.selectedAnnotationIds.size === 1 &&
        state.selectedAnnotationIds.has(annotation.id);
      const previouslySelectedA = previous.selectedAnnotationIds.size === 1 &&
        previous.selectedAnnotationIds.has(annotation.id);
      if (admittedB || previouslySelectedA || !selectedA) return;
      admittedB = true;
      installSameIdSuccessor(() => {
        useUiStore.setState({
          selectedAnnotationIds: new Set([9901]),
          searchQuery: B_SEARCH,
          activeYoloTagId: B_YOLO_TAG_ID,
          activeYoloTagFilter: B_YOLO_FILTER,
        });
      });
    });

    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 30, button: 0, detail: 1 });
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(read()).toEqual(expected);
  });

  it("keynote click preserves successor B's search", () => {
    const keynote = {
      shape: "square",
      text: "Keynote A",
      bbox: [0.2, 0.2, 0.4, 0.4] as [number, number, number, number],
    };
    queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
      ...EMPTY_ACTIVE_PAGE_WINDOW,
      loadedRange: { from: PAGE, to: PAGE },
      keynotes: { [PAGE]: [keynote] },
    });
    const canvas = renderCanvas();

    let admittedB = false;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedB || previous.activeKeynoteFilter?.text === keynote.text ||
          state.activeKeynoteFilter?.text !== keynote.text) return;
      admittedB = true;
      installSameIdSuccessor(() => {
        useUiStore.setState({
          searchQuery: B_SEARCH,
          activeKeynoteFilter: { shape: "circle", text: "Successor B keynote" },
        });
      });
    });

    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 30, button: 0, detail: 1 });
    unsubscribe();

    expect(admittedB).toBe(true);
    expect(useUiStore.getState().searchQuery).toBe(B_SEARCH);
  });
});

describe("AnnotationOverlay focus passive-effect ownership", () => {
  it("clears A's settled selection on lifecycle replacement without an active drag", () => {
    const id = -70;
    const a = userAnnotation({ id, name: "Settled selection A" });
    const b = userAnnotation({ id, name: "Same-ID successor B", note: "must survive" });
    seedAnnotations(queryClient, [a]);
    useUiStore.setState({ focusAnnotationId: id });
    renderCanvas();

    act(() => installSameIdSuccessor(() => {
      useToolStore.setState({ mode: "pointer" });
      seedAnnotations(queryClient, [b]);
    }));
    fireEvent.keyDown(window, { key: "Delete" });

    expect(readSeededAnnotations(queryClient)).toEqual([b]);
  });

  it("does not transfer A's queued focus into same-ID successor B", () => {
    const aFocusId = -71;
    const bFocusId = -72;
    const rows = [
      userAnnotation({ id: aFocusId, name: "Focus A", bbox: [0.1, 0.1, 0.3, 0.3] }),
      userAnnotation({ id: bFocusId, name: "Focus B", bbox: [0.6, 0.6, 0.8, 0.8] }),
    ];
    seedAnnotations(queryClient, rows);
    useUiStore.setState({ focusAnnotationId: aFocusId });

    const seedB = () => {
      useToolStore.setState({ mode: "pointer" });
      seedAnnotations(queryClient, rows);
      useUiStore.setState({ focusAnnotationId: bFocusId });
    };
    renderCanvas(<InstallSuccessorBeforeOverlayEffects seedB={seedB} />);

    // The signal is intentionally one-shot, so probe the Overlay's transferred local selection via
    // its public Delete behavior. Correct B ownership removes B and leaves A; the stale effect does
    // the inverse. Negative fixture ids keep this entirely cache-local.
    fireEvent.keyDown(window, { key: "Delete" });

    expect(readSeededAnnotations(queryClient).map((row) => row.id)).toEqual([aFocusId]);
  });
});

describe("AnnotationOverlay queued mousemove frame ownership", () => {
  it("does not publish A's polygon cursor frame into successor B", () => {
    const frames = installFrames();
    const canvas = renderCanvas();
    act(() => useToolStore.setState({ polygonDrawingMode: "drawing", _mousePos: null }));

    fireEvent.mouseMove(canvas, { clientX: 30, clientY: 40 });
    expect(frames).toHaveLength(1);
    // Flush lifecycle B's mount/reset effects before publishing its sentinel so this witness
    // isolates the already-queued A frame rather than a passive drawing cleanup.
    act(() => installSameIdSuccessor(() => {}));
    act(() => {
      useToolStore.setState({ polygonDrawingMode: "drawing", _mousePos: B_MOUSE });
    });
    act(() => frames[0](16));

    expect(useToolStore.getState()._mousePos).toEqual(B_MOUSE);
  });

  it("does not publish A's vertex frame into successor B's annotation", () => {
    const frames = installFrames();
    const source = areaAnnotation();
    seedAnnotations(queryClient, [source]);
    const canvas = renderCanvas();

    fireEvent.mouseDown(canvas, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.mouseDown(canvas, { clientX: 20, clientY: 20, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 30, clientY: 35, buttons: 1 });
    expect(frames).toHaveLength(1);

    const bAnnotation = areaAnnotation({
      bbox: [0.6, 0.6, 0.9, 0.9],
      name: "Successor B area",
      data: {
        type: "area-polygon",
        takeoffItemId: ITEM_ID,
        color: "#0ea5e9",
        vertices: [
          { x: 0.6, y: 0.6 },
          { x: 0.9, y: 0.6 },
          { x: 0.9, y: 0.9 },
          { x: 0.6, y: 0.9 },
        ],
        areaSqUnits: 999,
        unit: "SF",
      },
    });
    act(() => installSameIdSuccessor(() => seedAnnotations(queryClient, [bAnnotation])));
    act(() => frames[0](16));

    expect(readSeededAnnotations(queryClient)).toEqual([bAnnotation]);
  });

  it("does not publish A's bbox frame into successor B's annotation", () => {
    const frames = installFrames();
    const source = userAnnotation();
    seedAnnotations(queryClient, [source]);
    const canvas = renderCanvas();

    fireEvent.mouseDown(canvas, { clientX: 30, clientY: 30, button: 0 });
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 60, buttons: 1 });
    expect(frames).toHaveLength(1);

    const bAnnotation = userAnnotation({
      name: "Successor B markup",
      bbox: [0.7, 0.7, 0.9, 0.9],
      note: "B sentinel",
    });
    act(() => installSameIdSuccessor(() => seedAnnotations(queryClient, [bAnnotation])));
    act(() => frames[0](16));

    expect(readSeededAnnotations(queryClient)).toEqual([bAnnotation]);
  });
});
