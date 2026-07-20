// @vitest-environment node
//
// [refactor jul19 P3.2] Direct contract for the extracted and separately repaired BucketFill
// mousedown controller. The real-overlay freeze owns browser integration; this net makes lifecycle
// entry, loading abandonment, literal claims, staged capability boundaries, transport asymmetry,
// continuation ownership, and post-move topology independently observable.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MouseEvent as ReactMouseEvent } from "react";
import { QueryClient } from "@tanstack/react-query";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { useSessionStore } from "@/stores/sessionStore";
import { useToolStore } from "@/stores/toolStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import type { ToolStoreState } from "@/stores/toolStore";
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

import { bucketFillController } from "../tools/bucketFill";
import { TOOL_STORE_CAPABILITIES } from "../tools/capabilities";
import { dispatchToolMouseDown, TOOLS } from "../tools/registry";
import type { ToolContext, ToolPressSnapshot } from "../tools/types";

type BucketCapability = NonNullable<ToolContext["bucketFill"]>;
type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}>;

const PUBLIC_ID = "bucket-fill-controller";
const PROJECT_DB_ID = 401;
const PAGE = 3;
const WIDTH = 200;
const HEIGHT = 100;
const BARRIERS = Object.freeze([
  Object.freeze({ x1: 0.12, y1: 0.23, x2: 0.78, y2: 0.84 }),
]);
const POLYGON = Object.freeze([
  Object.freeze({ x: 0.1, y: 0.1 }),
  Object.freeze({ x: 0.8, y: 0.1 }),
  Object.freeze({ x: 0.5, y: 0.8 }),
]);
const TEXT_BBOXES = Object.freeze([
  Object.freeze({ x: 0.11, y: 0.22, w: 0.33, h: 0.44 }),
  Object.freeze({ x: 0.51, y: 0.62, w: 0.13, h: 0.24 }),
]);

let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return Object.freeze({ promise, resolve, reject });
}

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function flushTail(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function eventFor(journal: string[] = []) {
  return {
    button: 2,
    detail: 3,
    stopPropagation: vi.fn(() => journal.push("stop")),
    preventDefault: vi.fn(() => journal.push("preventDefault")),
  } as unknown as ReactMouseEvent & {
    stopPropagation: ReturnType<typeof vi.fn>;
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

function syntheticState(
  overrides: Partial<ToolStoreState> = {},
  journal: string[] = [],
): Readonly<ToolStoreState> {
  return Object.freeze({
    activeTool: Object.freeze({ kind: "bucketFill" as const }),
    mode: "move",
    bucketFillLoading: false,
    bucketFillPreview: null,
    bucketFillPendingPolygon: null,
    bucketFillBarrierMode: false,
    barrierPendingPoint: null,
    bucketFillTolerance: 47,
    bucketFillDilatePx: 6,
    bucketFillResolution: 3000,
    bucketFillBarriers: BARRIERS,
    setBarrierPendingPoint: vi.fn((point) => {
      journal.push(`pending:${point ? `${point.x},${point.y}` : "null"}`);
    }),
    ...overrides,
  }) as unknown as Readonly<ToolStoreState>;
}

function pressFor(
  state: Readonly<ToolStoreState>,
  position: Readonly<{ x: number; y: number }> = Object.freeze({
    x: 60,
    y: 70,
  }),
): ToolPressSnapshot {
  return Object.freeze({
    toolAtDown: state,
    position,
    publicId: PUBLIC_ID,
    pageNumber: PAGE,
  });
}

function syntheticContext(options: {
  state: Readonly<ToolStoreState>;
  journal?: string[];
  includeBucket?: boolean;
  capability?: BucketCapability;
  canAdopt?: boolean;
}): ToolContext {
  const journal = options.journal ?? [];
  const forbiddenRead = vi.fn(() => {
    throw new Error("transport-cold BucketFill arm read a live store");
  });
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const capability = options.capability ?? ({
    queryClient: query,
    projectDbId: PROJECT_DB_ID,
    addBarrier: vi.fn((line) => {
      journal.push(`barrier:${line.x1},${line.y1},${line.x2},${line.y2}`);
    }),
  } satisfies BucketCapability);
  const press = pressFor(options.state);
  return Object.freeze({
    press,
    page: Object.freeze({
      publicId: PUBLIC_ID,
      number: PAGE,
      width: WIDTH,
      height: HEIGHT,
    }),
    stores: {
      session: { getState: forbiddenRead },
      viewerCore: { getState: forbiddenRead },
      tool: { getState: forbiddenRead },
      parseFlow: { getState: forbiddenRead },
      ui: { getState: forbiddenRead },
    },
    canAdoptProjectLifecycle: vi.fn(() => {
      journal.push("canAdopt");
      return options.canAdopt ?? true;
    }),
    ...(options.includeBucket === false ? {} : { bucketFill: capability }),
  }) as unknown as ToolContext;
}

function annotation(
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
    annotation(101, PAGE, "takeoff", {
      type: "area-polygon",
      vertices: POLYGON,
    }),
    annotation(102, PAGE + 1, "takeoff", {
      type: "area-polygon",
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    }),
    annotation(103, PAGE, "user", {
      type: "area-polygon",
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    }),
    annotation(104, PAGE, "takeoff", {
      type: "count-marker",
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    }),
    annotation(105, PAGE, "takeoff", {
      type: "area-polygon",
      vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    }),
  ];
}

function seedLiveController(options?: { canAdopt?: boolean }) {
  invalidateToolTailAuthority();
  invalidateLatestToolOperation("bucketFill");
  resetProjectData();
  const activation = Object.freeze({ kind: "bucketFill" as const });
  setViewerStoreStateForTest({
    projectId: PROJECT_DB_ID,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE,
    numPages: PAGE + 1,
    mode: "move",
    activeTool: activation,
    bucketFillPreview: null,
    bucketFillLoading: false,
    bucketFillError: null,
    bucketFillTolerance: 47,
    bucketFillDilatePx: 6,
    bucketFillResolution: 3000,
    bucketFillPendingPolygon: null,
    bucketFillBarriers: [...BARRIERS],
    bucketFillBarrierMode: false,
    barrierPendingPoint: null,
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seedAnnotations(queryClient, transportRows());
  seedTextract(queryClient, {
    [PAGE]: {
      lines: [],
      words: [
        { text: "W1", confidence: 99, bbox: [0.11, 0.22, 0.33, 0.44] },
        { text: "W2", confidence: 98, bbox: [0.51, 0.62, 0.13, 0.24] },
      ],
    },
  });
  let canAdopt = options?.canAdopt ?? true;
  const lifecycle = vi.fn(() => canAdopt);
  const state = useToolStore.getState();
  const context = Object.freeze({
    press: pressFor(state),
    page: Object.freeze({
      publicId: PUBLIC_ID,
      number: PAGE,
      width: WIDTH,
      height: HEIGHT,
    }),
    stores: TOOL_STORE_CAPABILITIES,
    canAdoptProjectLifecycle: lifecycle,
    bucketFill: Object.freeze({
      queryClient,
      projectDbId: PROJECT_DB_ID,
      addBarrier: state.addBucketFillBarrier,
    }),
  }) as ToolContext;
  return {
    activation,
    context,
    lifecycle,
    setCanAdopt(value: boolean) {
      canAdopt = value;
    },
  };
}

function exactServerBody() {
  return {
    projectId: PROJECT_DB_ID,
    pageNumber: PAGE,
    seedPoint: { x: 0.3, y: 0.7 },
    tolerance: 47,
    dilate: 6,
    barriers: BARRIERS,
    polygonBarriers: [{ vertices: POLYGON }],
    textBboxes: TEXT_BBOXES,
  };
}

function expectServerRequest(index = 0): void {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  expect(url).toBe("/api/bucket-fill");
  expect(init).toMatchObject({
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  expect(JSON.parse(String(init.body))).toEqual(exactServerBody());
  expect(JSON.parse(String(init.body))).not.toHaveProperty("resolution");
  expect(JSON.parse(String(init.body))).not.toHaveProperty("maxDimension");
  expect(JSON.parse(String(init.body))).not.toHaveProperty("dilation");
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  bucketClient.clientBucketFill.mockReset();
  bucketClient.findPageCanvas.mockReset();
  bucketClient.findPageCanvas.mockReturnValue(null);
});

afterEach(() => {
  queryClient?.clear();
  resetProjectData();
  invalidateToolTailAuthority();
  invalidateLatestToolOperation("bucketFill");
  invalidateLatestToolOperation("symbolSession");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bucketFillController identity, eligibility, and claim boundary", () => {
  it("is frozen and matches/wants events for exactly the BucketFill activation", () => {
    expect(Object.isFrozen(bucketFillController)).toBe(true);
    expect(bucketFillController.kind).toBe("bucketFill");
    for (const [activeTool, expected] of [
      [{ kind: "bucketFill" }, true],
      [{ kind: "split" }, false],
      [{ kind: "takeoffPlacement" }, false],
      [null, false],
    ] as const) {
      const state = syntheticState({ activeTool } as Partial<ToolStoreState>);
      expect(bucketFillController.matches(pressFor(state))).toBe(expected);
      expect(bucketFillController.wantsEvents(state)).toBe(expected);
    }
  });

  it("claims through the real registry and accepts a non-primary cold press", () => {
    const state = syntheticState({ bucketFillLoading: true });
    const context = syntheticContext({ state, includeBucket: false });
    const event = eventFor();

    expect(
      dispatchToolMouseDown(TOOLS, event, context.press, () => context),
    ).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("claims a stale matched press terminal before propagation, capability, authority, or transport", () => {
    const journal: string[] = [];
    const global = claimToolTailAuthority({ witness: "stale-entry-global" });
    const lane = claimLatestToolOperation("bucketFill", {
      witness: "stale-entry-lane",
    });
    const state = syntheticState();
    const context = syntheticContext({
      state,
      journal,
      includeBucket: false,
      canAdopt: false,
    });
    const event = eventFor(journal);

    expect(bucketFillController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual(["canAdopt"]);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(global)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", lane)).toBe(true);
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bucketFillController staged capability and barrier partitions", () => {
  it("first barrier point needs no Bucket capability and orders stop -> explicit retire -> point", () => {
    const journal: string[] = [];
    const global = claimToolTailAuthority({ witness: "barrier-global" });
    const lane = claimLatestToolOperation("bucketFill", {
      witness: "barrier-lane",
    });
    const state = syntheticState({ bucketFillBarrierMode: true }, journal);
    const pointWriter = state.setBarrierPendingPoint as ReturnType<typeof vi.fn>;
    pointWriter.mockImplementation((point) => {
      journal.push(
        `pending:${point?.x},${point?.y}:global-${
          ownsToolTailAuthority(global) ? "owned" : "retired"
        }:lane-${ownsLatestToolOperation("bucketFill", lane) ? "owned" : "retired"}`,
      );
    });
    const context = syntheticContext({ state, includeBucket: false, journal });
    const event = eventFor(journal);

    expect(bucketFillController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual([
      "canAdopt",
      "stop",
      "pending:0.3,0.7:global-retired:lane-retired",
    ]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(context.canAdoptProjectLifecycle).toHaveBeenCalledTimes(1);
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("barrier completion appends before the lifecycle fence and admitted-point clear", () => {
    const journal: string[] = [];
    const pending = Object.freeze({ x: 0.11, y: 0.22 });
    const state = syntheticState(
      { bucketFillBarrierMode: true, barrierPendingPoint: pending },
      journal,
    );
    const addBarrier = vi.fn((line) => {
      journal.push(`barrier:${line.x1},${line.y1},${line.x2},${line.y2}`);
    });
    const context = syntheticContext({
      state,
      journal,
      capability: {
        queryClient: new QueryClient(),
        projectDbId: PROJECT_DB_ID,
        addBarrier,
      },
    });
    const event = eventFor(journal);

    expect(bucketFillController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual([
      "canAdopt",
      "stop",
      "barrier:0.11,0.22,0.3,0.7",
      "canAdopt",
      "pending:null",
    ]);
    expect(addBarrier).toHaveBeenCalledExactlyOnceWith({
      x1: 0.11,
      y1: 0.22,
      x2: 0.3,
      y2: 0.7,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fences a stale barrier completion before invalidation, capability, append, or clear", () => {
    const journal: string[] = [];
    const global = claimToolTailAuthority({ witness: "stale-barrier-global" });
    const lane = claimLatestToolOperation("bucketFill", {
      witness: "stale-barrier-lane",
    });
    const pending = Object.freeze({ x: 0.11, y: 0.22 });
    const state = syntheticState({
      bucketFillBarrierMode: true,
      barrierPendingPoint: pending,
    }, journal);
    const context = syntheticContext({
      state,
      journal,
      includeBucket: false,
      canAdopt: false,
    });
    const event = eventFor(journal);

    expect(bucketFillController.onMouseDown(event, context)).toBe(true);

    expect(journal).toEqual(["canAdopt"]);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(state.setBarrierPendingPoint).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(global)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", lane)).toBe(true);
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a rejected post-append lifecycle still returns true and retains the pending point", () => {
    const journal: string[] = [];
    const state = syntheticState({
      bucketFillBarrierMode: true,
      barrierPendingPoint: Object.freeze({ x: 0.11, y: 0.22 }),
    }, journal);
    const context = syntheticContext({ state, journal });
    let checks = 0;
    vi.mocked(context.canAdoptProjectLifecycle).mockImplementation(() => {
      journal.push("canAdopt");
      checks += 1;
      return checks === 1;
    });

    expect(bucketFillController.onMouseDown(eventFor(journal), context)).toBe(
      true,
    );
    expect(journal).toEqual([
      "canAdopt",
      "stop",
      "barrier:0.11,0.22,0.3,0.7",
      "canAdopt",
    ]);
    expect(state.setBarrierPendingPoint).not.toHaveBeenCalled();
  });

  it("barrier completion fails loudly without its staged Bucket capability", () => {
    const global = claimToolTailAuthority({ witness: "completion-global" });
    const lane = claimLatestToolOperation("bucketFill", {
      witness: "completion-lane",
    });
    const state = syntheticState({
      bucketFillBarrierMode: true,
      barrierPendingPoint: Object.freeze({ x: 0.11, y: 0.22 }),
    });
    const context = syntheticContext({ state, includeBucket: false });
    const event = eventFor();

    expect(() => bucketFillController.onMouseDown(event, context)).toThrow(
      /bucketFill controller requires the bucketFill capability/i,
    );

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(global)).toBe(false);
    expect(ownsLatestToolOperation("bucketFill", lane)).toBe(false);
    expect(state.setBarrierPendingPoint).not.toHaveBeenCalled();
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["loading", { bucketFillLoading: true }],
    ["preview", { bucketFillPreview: { vertices: POLYGON, method: "open" } }],
    ["pending dialog", { bucketFillPendingPolygon: { vertices: POLYGON } }],
  ] as const)("%s is terminal and transport/capability/authority cold", (_label, patch) => {
    const global = claimToolTailAuthority({ witness: "cold-global" });
    const lane = claimLatestToolOperation("bucketFill", { witness: "cold-lane" });
    const state = syntheticState(patch as Partial<ToolStoreState>);
    const context = syntheticContext({ state, includeBucket: false });
    const event = eventFor();

    expect(bucketFillController.onMouseDown(event, context)).toBe(true);

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(global)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", lane)).toBe(true);
    expect(context.canAdoptProjectLifecycle).toHaveBeenCalledTimes(1);
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fresh fill requires the full Bucket capability before claims or loading", () => {
    const global = claimToolTailAuthority({ witness: "missing-global" });
    const lane = claimLatestToolOperation("bucketFill", { witness: "missing-lane" });
    const state = syntheticState();
    const context = syntheticContext({ state, includeBucket: false });
    const event = eventFor();

    expect(() => bucketFillController.onMouseDown(event, context)).toThrow(
      /bucketFill controller requires the bucketFill capability/i,
    );

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(ownsToolTailAuthority(global)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", lane)).toBe(true);
    expect(useToolStore.getState().bucketFillLoading).toBe(false);
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a live-context stale entry remains terminal and cache/transport cold", () => {
    const fixture = seedLiveController({ canAdopt: false });
    const cacheRead = vi.spyOn(queryClient, "getQueryData");
    const event = eventFor();

    expect(
      bucketFillController.onMouseDown(event, fixture.context),
    ).toBe(true);

    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(fixture.lifecycle).toHaveBeenCalledTimes(1);
    expect(useToolStore.getState().bucketFillLoading).toBe(false);
    expect(cacheRead).not.toHaveBeenCalled();
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bucketFillController exact worker/server transports and terminals", () => {
  it("uses the full invocation caches and exact direct-server request", async () => {
    const request = deferred<Response>();
    fetchMock.mockReturnValue(request.promise);
    const { context } = seedLiveController();
    const event = eventFor();

    expect(bucketFillController.onMouseDown(event, context)).toBe(true);

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(bucketClient.findPageCanvas).toHaveBeenCalledTimes(1);
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectServerRequest();
    expect(useToolStore.getState()).toMatchObject({
      bucketFillLoading: true,
      bucketFillPreview: null,
      bucketFillError: null,
    });

    request.resolve(response({ unexpected: true }));
    await flushTail();
    expect(useToolStore.getState()).toMatchObject({
      bucketFillLoading: false,
      bucketFillPreview: null,
      bucketFillError: null,
    });
  });

  it("attempts the worker first and normalizes empty holes to an own undefined property", async () => {
    const worker = deferred<{
      vertices: { x: number; y: number }[];
      holes: never[];
      method: string;
    }>();
    const pageCanvas = Object.freeze({ fixture: "canvas" });
    bucketClient.findPageCanvas.mockReturnValue(pageCanvas);
    bucketClient.clientBucketFill.mockReturnValue(worker.promise);
    const { context } = seedLiveController();

    expect(bucketFillController.onMouseDown(eventFor(), context)).toBe(true);

    expect(bucketClient.clientBucketFill).toHaveBeenCalledExactlyOnceWith(
      pageCanvas,
      { x: 0.3, y: 0.7 },
      {
        tolerance: 47,
        dilation: 6,
        barriers: BARRIERS,
        polygonBarriers: [{ vertices: POLYGON }],
        textBboxes: TEXT_BBOXES,
        maxDimension: 3000,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const vertices = [
      { x: 0.2, y: 0.2 },
      { x: 0.4, y: 0.2 },
      { x: 0.3, y: 0.4 },
    ];
    const successPublications: Array<{
      loading: boolean;
      preview: ToolStoreState["bucketFillPreview"];
    }> = [];
    const unsubscribe = useToolStore.subscribe((state) => {
      successPublications.push({
        loading: state.bucketFillLoading,
        preview: state.bucketFillPreview,
      });
    });
    worker.resolve({ vertices, holes: [], method: "client-raster" });
    await flushTail();
    unsubscribe();
    expect(useToolStore.getState().bucketFillPreview).toEqual({
      vertices,
      holes: undefined,
      method: "client-raster",
    });
    expect(useToolStore.getState().bucketFillLoading).toBe(false);
    expect(successPublications).toEqual([{
      loading: false,
      preview: {
        vertices,
        holes: undefined,
        method: "client-raster",
      },
    }]);
  });

  it("starts the exact server fallback only after an owned worker rejection", async () => {
    const worker = deferred<never>();
    const request = deferred<Response>();
    bucketClient.findPageCanvas.mockReturnValue(
      Object.freeze({ fixture: "canvas" }),
    );
    bucketClient.clientBucketFill.mockReturnValue(worker.promise);
    fetchMock.mockReturnValue(request.promise);
    const { context } = seedLiveController();

    expect(bucketFillController.onMouseDown(eventFor(), context)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    worker.reject(new Error("worker failed"));
    await flushTail();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectServerRequest();

    request.resolve(response({ type: "unknown" }));
    await flushTail();
  });

  it("retains nonempty holes and applies the exact server method fallback", async () => {
    const vertices = [
      { x: 0.2, y: 0.2 },
      { x: 0.4, y: 0.2 },
      { x: 0.3, y: 0.4 },
    ];
    const holes = [{
      vertices: [
        { x: 0.28, y: 0.26 },
        { x: 0.32, y: 0.26 },
        { x: 0.3, y: 0.3 },
      ],
    }];
    fetchMock.mockResolvedValue(response({ type: "result", vertices, holes }));
    const { context } = seedLiveController();

    expect(bucketFillController.onMouseDown(eventFor(), context)).toBe(true);
    await flushTail();

    expect(useToolStore.getState().bucketFillPreview).toEqual({
      vertices,
      holes,
      method: "server-raster",
    });
    expect(useToolStore.getState().bucketFillLoading).toBe(false);
  });

  it("publishes the exact in-band error and consumes it only at 4000ms", async () => {
    fetchMock.mockResolvedValue(
      response({ type: "error", error: "seed point on a wall" }),
    );
    const { context } = seedLiveController();
    let timer: (() => void) | undefined;
    const nativeSetTimeout = globalThis.setTimeout;
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 4000 && typeof callback === "function") {
          timer = callback as () => void;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        }
        return nativeSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout,
    );

    expect(bucketFillController.onMouseDown(eventFor(), context)).toBe(true);
    await flushTail();

    expect(useToolStore.getState()).toMatchObject({
      bucketFillLoading: false,
      bucketFillError: "seed point on a wall",
    });
    expect(timeout.mock.calls.some((call) => call[1] === 4000)).toBe(true);
    expect(timer).toBeTypeOf("function");
    timer?.();
    expect(useToolStore.getState().bucketFillError).toBeNull();
  });
});

describe("bucketFillController immediate loading abandonment", () => {
  it("retires lifecycle-lost A and clears its loading/error before cache or transport", () => {
    const fixture = seedLiveController();
    const journal: string[] = [];
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state.bucketFillLoading && !previous.bucketFillLoading) {
        journal.push("loading");
        fixture.setCanAdopt(false);
        useToolStore.setState({ bucketFillError: "retired-A" });
      } else if (previous.bucketFillLoading && !state.bucketFillLoading) {
        journal.push(`cleanup:${state.bucketFillError ?? "null"}`);
      }
    });

    expect(
      bucketFillController.onMouseDown(eventFor(), fixture.context),
    ).toBe(true);
    unsubscribe();

    expect(journal).toEqual(["loading", "cleanup:null"]);
    expect(fixture.lifecycle).toHaveBeenCalledTimes(2);
    expect(useToolStore.getState()).toMatchObject({
      bucketFillLoading: false,
      bucketFillError: null,
      bucketFillPreview: null,
    });
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears A directly while preserving an unrelated replacement global tail", async () => {
    const fixture = seedLiveController();
    const successorToken = { witness: "replacement-global" };
    const successorCancellation = vi.fn();
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (!state.bucketFillLoading || previous.bucketFillLoading) return;
      claimToolTailAuthority(successorToken);
      registerToolTailCancellation(successorToken, successorCancellation);
      useToolStore.setState({ bucketFillError: "retired-A" });
    });

    expect(
      bucketFillController.onMouseDown(eventFor(), fixture.context),
    ).toBe(true);
    unsubscribe();

    expect(ownsToolTailAuthority(successorToken)).toBe(true);
    expect(useToolStore.getState()).toMatchObject({
      bucketFillLoading: false,
      bucketFillError: null,
    });
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    invalidateToolTailAuthority();
    await flushTail();
    expect(successorCancellation).toHaveBeenCalledTimes(1);
  });

  it("preserves a full same-kind successor B installed during A's loading publication", async () => {
    const fixture = seedLiveController();
    const successorToken = { witness: "replacement-bucket" };
    const successorActivation = { kind: "bucketFill" as const };
    const successorPreview = {
      vertices: POLYGON.map((vertex) => ({ ...vertex })),
      method: "successor-B",
    };
    const successorCancellation = vi.fn();
    let installed = 0;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (!state.bucketFillLoading || previous.bucketFillLoading) return;
      installed += 1;
      claimToolTailAuthority(successorToken);
      claimLatestToolOperation("bucketFill", successorToken);
      registerToolTailCancellation(successorToken, successorCancellation);
      useToolStore.setState({
        activeTool: successorActivation,
        bucketFillLoading: true,
        bucketFillError: "successor-B",
        bucketFillPreview: successorPreview,
      });
    });

    expect(
      bucketFillController.onMouseDown(eventFor(), fixture.context),
    ).toBe(true);
    unsubscribe();
    await flushTail();

    const state = useToolStore.getState();
    expect(installed).toBe(1);
    expect(state.activeTool).toBe(successorActivation);
    expect(state.bucketFillLoading).toBe(true);
    expect(state.bucketFillError).toBe("successor-B");
    expect(state.bucketFillPreview).toBe(successorPreview);
    expect(ownsToolTailAuthority(successorToken)).toBe(true);
    expect(ownsLatestToolOperation("bucketFill", successorToken)).toBe(true);
    expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
    expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    invalidateToolTailAuthority();
    await flushTail();
    expect(successorCancellation).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "Bucket lane",
      () => claimLatestToolOperation("bucketFill", { witness: "replacement-lane" }),
    ],
    [
      "activation identity",
      () => useToolStore.setState({ activeTool: { kind: "bucketFill" } }),
    ],
    [
      "project DB id",
      () => useSessionStore.setState({ projectId: PROJECT_DB_ID + 1 }),
    ],
    [
      "public id",
      () => useSessionStore.setState({ publicId: `${PUBLIC_ID}-replacement` }),
    ],
    [
      "page",
      () => useViewerCoreStore.setState({ pageNumber: PAGE + 1 }),
    ],
  ] as const)(
    "does not clear successor state when only %s changes during loading",
    (_label, installSuccessorIdentity) => {
      const fixture = seedLiveController();
      let installedSuccessorIdentity: unknown;
      const unsubscribe = useToolStore.subscribe((state, previous) => {
        if (!state.bucketFillLoading || previous.bucketFillLoading) return;
        installedSuccessorIdentity = installSuccessorIdentity();
        useToolStore.setState({
          bucketFillLoading: true,
          bucketFillError: "successor-state",
        });
      });

      expect(
        bucketFillController.onMouseDown(eventFor(), fixture.context),
      ).toBe(true);
      unsubscribe();

      expect(useToolStore.getState()).toMatchObject({
        bucketFillLoading: true,
        bucketFillError: "successor-state",
      });
      if (_label === "Bucket lane") {
        expect(installedSuccessorIdentity).toBeTypeOf("object");
        expect(ownsLatestToolOperation(
          "bucketFill",
          installedSuccessorIdentity as object,
        )).toBe(true);
      }
      expect(bucketClient.findPageCanvas).not.toHaveBeenCalled();
      expect(bucketClient.clientBucketFill).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("bucketFillController continuation conjunction", () => {
  it("checks ownership before response parsing", async () => {
    const request = deferred<Response>();
    fetchMock.mockReturnValue(request.promise);
    const { context } = seedLiveController();
    const json = vi.fn().mockResolvedValue({ type: "result", vertices: POLYGON });

    expect(bucketFillController.onMouseDown(eventFor(), context)).toBe(true);
    invalidateToolTailAuthority();
    request.resolve({ ok: true, status: 200, json } as unknown as Response);
    await flushTail();

    expect(json).not.toHaveBeenCalled();
    expect(useToolStore.getState().bucketFillPreview).toBeNull();
  });

  it.each([
    ["lifecycle", (fixture: ReturnType<typeof seedLiveController>) => fixture.setCanAdopt(false)],
    ["global tail", () => invalidateToolTailAuthority()],
    ["Bucket lane", () => invalidateLatestToolOperation("bucketFill")],
    ["activation identity", () => useToolStore.setState({ activeTool: { kind: "bucketFill" } })],
    ["project DB id", () => useSessionStore.setState({ projectId: PROJECT_DB_ID + 1 })],
    ["public id", () => useSessionStore.setState({ publicId: `${PUBLIC_ID}-successor` })],
    ["page", () => useViewerCoreStore.setState({ pageNumber: PAGE + 1 })],
  ] as const)("rejects a post-JSON result when only %s is retired", async (_label, retire) => {
    const body = deferred<Record<string, unknown>>();
    const json = vi.fn(() => body.promise);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json } as unknown as Response);
    const fixture = seedLiveController();

    expect(
      bucketFillController.onMouseDown(eventFor(), fixture.context),
    ).toBe(true);
    await flushTail();
    expect(json).toHaveBeenCalledTimes(1);

    retire(fixture);
    body.resolve({ type: "result", vertices: POLYGON, method: "stale" });
    await flushTail();

    expect(useToolStore.getState().bucketFillPreview).toBeNull();
  });
});

describe("bucketFillController displaced-tail cancellation conjunction", () => {
  it.each([
    ["no peer guard", () => {}, false],
    [
      "Bucket lane",
      () => claimLatestToolOperation("bucketFill", { witness: "replacement-lane" }),
      true,
    ],
    [
      "activation identity",
      () => useToolStore.setState({ activeTool: { kind: "bucketFill" } }),
      true,
    ],
    [
      "project DB id",
      () => useSessionStore.setState({ projectId: PROJECT_DB_ID + 1 }),
      true,
    ],
    [
      "public id",
      () => useSessionStore.setState({ publicId: `${PUBLIC_ID}-replacement` }),
      true,
    ],
    [
      "page",
      () => useViewerCoreStore.setState({ pageNumber: PAGE + 1 }),
      true,
    ],
  ] as const)(
    "queued cancellation preserves loading when only %s changes",
    async (_label, retirePeerGuard, expectedLoading) => {
      const request = deferred<Response>();
      fetchMock.mockReturnValue(request.promise);
      const fixture = seedLiveController();

      expect(
        bucketFillController.onMouseDown(eventFor(), fixture.context),
      ).toBe(true);
      expect(useToolStore.getState().bucketFillLoading).toBe(true);

      claimToolTailAuthority({ witness: "replacement-global-tail" });
      retirePeerGuard();
      await flushTail();

      expect(useToolStore.getState().bucketFillLoading).toBe(expectedLoading);
    },
  );
});

describe("BucketFill controller POST-move source and topology", () => {
  const AO = readFileSync(
    "src/components/viewer/AnnotationOverlay.tsx",
    "utf8",
  );
  const CONTROLLER = readFileSync(
    "src/components/viewer/tools/bucketFill.ts",
    "utf8",
  );
  const POINTER = readFileSync(
    "src/components/viewer/tools/pointerGroup.ts",
    "utf8",
  );
  const REGISTRY = readFileSync(
    "src/components/viewer/tools/registry.ts",
    "utf8",
  );
  const TYPES = readFileSync("src/components/viewer/tools/types.ts", "utf8");
  const mouseDownStart = AO.indexOf("  const handleMouseDown = useCallback(");
  const mouseMoveStart = AO.indexOf("  const handleMouseMove = useCallback(");
  const MOUSEDOWN = AO.slice(mouseDownStart, mouseMoveStart);
  const compact = (value: string): string => value.replace(/\s+/g, "");
  const count = (value: string, needle: string): number =>
    value.split(needle).length - 1;

  it("makes the controller the sole BucketFill mousedown/transport home", () => {
    expect(mouseDownStart).toBeGreaterThan(-1);
    expect(mouseMoveStart).toBeGreaterThan(mouseDownStart);
    expect(MOUSEDOWN).not.toContain(
      "// Bucket fill mode — independent of item selection",
    );
    expect(MOUSEDOWN).not.toContain(
      'if (activeTool?.kind === "bucketFill")',
    );
    for (const token of [
      "clientBucketFill(",
      "findPageCanvas(",
      'fetch("/api/bucket-fill"',
      "readAnnotations(",
      'claimLatestToolOperation("bucketFill"',
      'ownsLatestToolOperation("bucketFill"',
    ]) {
      expect(MOUSEDOWN, token).not.toContain(token);
      expect(CONTROLLER, token).toContain(token);
    }
    expect(AO).not.toContain('from "@/lib/bucket-fill-client"');
    expect(AO).not.toContain("apiErrorMessage");
    expect(AO).not.toContain("readAnnotations");
    expect(AO).not.toContain("claimLatestToolOperation");
    expect(AO).not.toContain("ownsLatestToolOperation");
    expect(count(AO, "readTextractForPage")).toBe(0);
    expect(count(POINTER, "readTextractForPage")).toBe(2);
    expect(AO.split("\n").length - 1).toBe(1725);
  });

  it("pins BucketFill's exact registry slot immediately after Split", () => {
    expect(REGISTRY).toContain(
      'import { bucketFillController } from "./bucketFill";',
    );
    expect(REGISTRY).toContain(
      "    calibrationController,\n    splitController,\n    bucketFillController,\n    takeoffPolygonController,",
    );
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
      "pointerGroup",
      "markup",
    ]);
    expect(TOOLS).toHaveLength(13);
  });

  it("pins the narrow capability and dependency-neutral AO wiring", () => {
    const compactTypes = compact(TYPES);
    expect(compactTypes).toContain(
      'readonlybucketFill?:Readonly<{queryClient:QueryClient;projectDbId:number;addBarrier:ToolStoreState["addBucketFillBarrier"];}>'
    );
    expect(compact(AO)).toContain(
      "bucketFill:{queryClient:qc,projectDbId,addBarrier:addBucketFillBarrier,}",
    );

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

  it("pins entry, authority/publication/abandon order, and all seven continuation conjuncts", () => {
    const entryFence = CONTROLLER.indexOf(
      "if (!context.canAdoptProjectLifecycle()) return true;",
    );
    const pressSnapshot = CONTROLLER.indexOf(
      "const { toolAtDown: bfState, position } = context.press;",
    );
    const propagation = CONTROLLER.indexOf("event.stopPropagation();");
    const barrierInvalidation = CONTROLLER.indexOf(
      "invalidateToolTailAuthority();",
      propagation,
    );
    const token = CONTROLLER.indexOf("const bucketToken = {}");
    const cleanup = CONTROLLER.indexOf(
      "const clearCapturedBucketFillPublication = () => {",
      token,
    );
    const globalClaim = CONTROLLER.indexOf(
      "claimToolTailAuthority(bucketToken)",
      token,
    );
    const laneClaim = CONTROLLER.indexOf(
      'claimLatestToolOperation("bucketFill", bucketToken)',
      globalClaim,
    );
    const registration = CONTROLLER.indexOf(
      "registerToolTailCancellation(bucketToken",
      laneClaim,
    );
    const loading = CONTROLLER.indexOf("bucketFillLoading: true", registration);
    const immediateFence = CONTROLLER.indexOf(
      "if (!ownsBucketFill()) {",
      loading,
    );
    const consumeHelper = CONTROLLER.indexOf(
      "const consumeBucketFill = (publish: () => void): boolean => {",
      immediateFence,
    );
    const collisionRead = CONTROLLER.indexOf(
      "readAnnotations(queryClient, bucketPublicId)",
      loading,
    );
    expect(entryFence).toBeGreaterThan(-1);
    expect(entryFence).toBeLessThan(pressSnapshot);
    expect(pressSnapshot).toBeLessThan(propagation);
    expect(propagation).toBeLessThan(barrierInvalidation);
    expect(token).toBeGreaterThan(-1);
    expect(token).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(globalClaim);
    expect(token).toBeLessThan(globalClaim);
    expect(globalClaim).toBeLessThan(laneClaim);
    expect(laneClaim).toBeLessThan(registration);
    expect(registration).toBeLessThan(loading);
    expect(loading).toBeLessThan(immediateFence);
    expect(immediateFence).toBeLessThan(consumeHelper);
    expect(consumeHelper).toBeLessThan(collisionRead);
    expect(CONTROLLER).toContain(
      "invalidateToolTailAuthority();\n      invalidateLatestToolOperation(\"bucketFill\");",
    );
    expect(CONTROLLER).toContain(
      "useToolStore.setState({\n      bucketFillLoading: true,\n      bucketFillPreview: null,\n      bucketFillError: null,\n    });",
    );
    for (const guard of [
      "canAdoptProjectLifecycle()",
      "ownsToolTailAuthority(bucketToken)",
      'ownsLatestToolOperation("bucketFill", bucketToken)',
      "current.activeTool === bucketActivation",
      "stores.session.getState().projectId === bucketProjectDbId",
      "stores.session.getState().publicId === bucketPublicId",
      "stores.viewerCore.getState().pageNumber === bucketPageNumber",
    ]) {
      expect(CONTROLLER, guard).toContain(guard);
    }
    const abandon = CONTROLLER.slice(immediateFence, consumeHelper);
    const laneProbe = abandon.indexOf("const ownsBucketFillLane");
    const laneRetire = abandon.indexOf(
      'if (ownsBucketFillLane) invalidateLatestToolOperation("bucketFill");',
    );
    const cancellationRelease = abandon.indexOf(
      "releaseToolTailCancellation(bucketToken);",
    );
    const globalProbe = abandon.indexOf(
      "if (ownsToolTailAuthority(bucketToken))",
    );
    const globalConsume = abandon.indexOf("consumeToolTailAuthority(");
    const terminal = abandon.lastIndexOf("return true;");
    expect(laneProbe).toBeGreaterThan(-1);
    expect(laneProbe).toBeLessThan(laneRetire);
    expect(laneRetire).toBeLessThan(cancellationRelease);
    expect(cancellationRelease).toBeLessThan(globalProbe);
    expect(globalProbe).toBeLessThan(globalConsume);
    expect(globalConsume).toBeLessThan(terminal);
    expect(abandon).not.toContain("invalidateToolTailAuthority()");
    expect(abandon).toContain(
      "if (ownsToolTailAuthority(bucketToken)) {\n" +
        "        consumeToolTailAuthority(\n          bucketToken,\n" +
        "          ownsBucketFillLane ? clearCapturedBucketFillPublication : () => {},\n" +
        "        );\n      } else if (ownsBucketFillLane) {\n" +
        "        clearCapturedBucketFillPublication();\n      }",
    );

    const terminalRelease = CONTROLLER.indexOf(
      "releaseToolTailCancellation(bucketToken)",
      consumeHelper,
    );
    const terminalConsume = CONTROLLER.indexOf(
      "consumeToolTailAuthority(bucketToken, publish)",
      consumeHelper,
    );
    expect(terminalRelease).toBeLessThan(terminalConsume);
    expect(count(CONTROLLER, "useToolStore.setState(")).toBe(5);

    const cancellation = CONTROLLER.slice(registration, loading);
    expect(cancellation).toContain(
      'ownsLatestToolOperation("bucketFill", bucketToken)',
    );
    expect(cancellation).toContain("clearCapturedBucketFillPublication()");
    const cleanupBody = CONTROLLER.slice(cleanup, globalClaim);
    for (const guard of [
      "context.stores.session.getState().projectId !== bucketProjectDbId",
      "context.stores.session.getState().publicId !== bucketPublicId",
      "context.stores.viewerCore.getState().pageNumber !== bucketPageNumber",
      "state.activeTool === bucketActivation",
    ]) {
      expect(cleanupBody, guard).toContain(guard);
    }
    expect(CONTROLLER).toContain(
      "const bucketPublicId = context.page.publicId;",
    );
    expect(CONTROLLER).toContain(
      "const bucketPageNumber = context.page.number;",
    );
    expect(CONTROLLER).not.toContain("context.press.publicId");
    expect(CONTROLLER).not.toContain("context.press.pageNumber");
  });

  it("excludes hooks, subscriptions, cache writes, module journals, and other event owners", () => {
    for (const forbidden of [
      "useEffect(",
      "useState(",
      "useCallback(",
      "useMemo(",
      ".subscribe(",
      ".setQueryData(",
      ".invalidateQueries(",
      ".fetchQuery(",
      ".setQueriesData(",
      "onMouseMove:",
      "onMouseUp:",
      "onDblClick:",
      "onKey:",
      "onPageChange:",
      "drawPreview:",
    ]) {
      expect(CONTROLLER, forbidden).not.toContain(forbidden);
    }
    const sourceFile = ts.createSourceFile(
      "bucketFill.ts",
      CONTROLLER,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const mutableTopLevel = sourceFile.statements.filter(
      (statement): statement is ts.VariableStatement =>
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) === 0,
    );
    expect(mutableTopLevel).toEqual([]);
    const topLevelVariables = sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .map((declaration) => declaration.name.getText(sourceFile));
    expect(topLevelVariables).toEqual(["bucketFillController"]);
    expect(CONTROLLER).toContain(
      "export const bucketFillController: ToolController = Object.freeze({",
    );
    expect(CONTROLLER).toContain(
      "readAnnotations(queryClient, bucketPublicId)",
    );
    expect(CONTROLLER).toContain(
      "readTextractForPage(queryClient, bucketPublicId, bucketPageNumber)",
    );
    expect(CONTROLLER).not.toMatch(/\bqueryClient\s*\./);
  });
});
