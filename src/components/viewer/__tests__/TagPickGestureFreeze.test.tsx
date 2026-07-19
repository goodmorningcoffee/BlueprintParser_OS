// @vitest-environment jsdom
//
// [refactor jul18 P3.2] Authored PRE-MOVE as the parent-green executable tagPick mousedown
// characterization; its topology block is rewritten POST-MOVE. This is a pure-lift freeze, not a
// parent-defect RED. In particular, both hit and miss already retire global tail authority through
// setYoloTagPickingMode(false); a second controller-local invalidator would be behavior drift.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  claimToolTailAuthority,
  ownsToolTailAuthority,
  registerToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useSessionStore } from "@/stores/sessionStore";
import type { ToolTagScanResults } from "@/stores/toolStore";
import { useToolStore } from "@/stores/toolStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotations } from "@/test/seed-annotations";
import {
  setViewerStoreStateForTest,
  type ViewerStoreTestPatch,
} from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "tag-pick-gesture-fixture";
const SUCCESSOR_ID = "tag-pick-reentrant-successor";
const PAGE_NUMBER = 2;
const WIDTH = 200;
const HEIGHT = 100;
const LIVE_MODEL = "Fixture Model";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}>;

type CapturedRequest = Readonly<{
  url: string;
  init: RequestInit;
  deferred: Deferred<Response>;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function annotation(
  id: number,
  name: string,
  bbox: [number, number, number, number],
  options: Readonly<{
    source?: ClientAnnotation["source"];
    pageNumber?: number;
    modelName?: string;
    includeModel?: boolean;
  }> = {},
): ClientAnnotation {
  const includeModel = options.includeModel ?? true;
  return {
    id,
    pageNumber: options.pageNumber ?? PAGE_NUMBER,
    name,
    bbox,
    note: null,
    source: options.source ?? "yolo",
    data: {
      confidence: 0.99,
      ...(includeModel ? { modelName: options.modelName ?? LIVE_MODEL } : {}),
    },
  };
}

const TARGET_BBOX = [0.25, 0.2, 0.75, 0.8] as const;
const TARGET = annotation(1, "Door", [...TARGET_BBOX]);

let queryClient: QueryClient;
let requests: CapturedRequest[];
const fetchMock = vi.fn();
const parentMouseDown = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div onMouseDown={(event) => parentMouseDown(event)}>{children}</div>
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

function requestBody(index = 0): Record<string, unknown> {
  return JSON.parse(String(requests[index].init.body));
}

function seedOverlay(
  rows: ClientAnnotation[] = [TARGET],
  patch: ViewerStoreTestPatch = {},
): void {
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 901,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE_NUMBER,
    numPages: 4,
    mode: "move",
    activeTool: null,
    _drawing: false,
    tagScanResults: null,
    showDetections: true,
    confidenceThreshold: 0.5,
    confidenceThresholds: {},
    activeModels: { [LIVE_MODEL]: true },
    hiddenClasses: {},
    hiddenAnnotationIds: new Set<number>(),
    activeAnnotationFilter: null,
    activeCsiFilter: null,
    ...patch,
  });
  seedAnnotations(queryClient, rows);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
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

async function activateTagPick(canvas: HTMLCanvasElement): Promise<void> {
  act(() => useToolStore.getState().setYoloTagPickingMode(true));
  await waitFor(() => expect(canvas.style.cursor).toBe("pointer"));
  expect(useToolStore.getState().activeTool).toEqual({ kind: "tagPick" });
}

function press(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  button = 0,
): boolean {
  let dispatched = false;
  act(() => {
    dispatched = fireEvent.mouseDown(canvas, {
      clientX: x,
      clientY: y,
      button,
      detail: 1,
    });
  });
  return dispatched;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requests = [];
  parentMouseDown.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown, init: RequestInit = {}) => {
    if (typeof url !== "string" || !url.endsWith("/map-tags-batch")) {
      throw new Error(`Unexpected tag-pick request: ${String(url)}`);
    }
    const request = deferred<Response>();
    requests.push({ url, init, deferred: request });
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  resetProjectData();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tagPick gesture freeze (real overlay, parent-green)", () => {
  it("leaves a non-tagPick press ungated and unclaimed by the picker", async () => {
    seedOverlay();
    const canvas = await mountCanvas();

    expect(press(canvas, 100, 50)).toBe(true);

    expect(requests).toHaveLength(0);
    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(useToolStore.getState().activeTool).toBeNull();
    expect(useToolStore.getState()._drawing).toBe(false);
  });

  it.each([
    { label: "left", point: [50, 50] as const, hit: true },
    { label: "top", point: [100, 20] as const, hit: true },
    { label: "right", point: [150, 50] as const, hit: true },
    { label: "bottom", point: [100, 80] as const, hit: true },
    { label: "left epsilon-out", point: [49.999, 50] as const, hit: false },
    { label: "top epsilon-out", point: [100, 19.999] as const, hit: false },
    { label: "right epsilon-out", point: [150.001, 50] as const, hit: false },
    { label: "bottom epsilon-out", point: [100, 80.001] as const, hit: false },
  ])("uses independent anisotropic inclusive geometry at $label", async ({ point, hit }) => {
    seedOverlay();
    const canvas = await mountCanvas();
    await activateTagPick(canvas);

    expect(press(canvas, point[0], point[1])).toBe(true);

    expect(requests).toHaveLength(hit ? 1 : 0);
    expect(parentMouseDown).toHaveBeenCalledTimes(hit ? 0 : 1);
    expect(useToolStore.getState().activeTool).toBeNull();
  });

  it("preserves the inline normalized max form at the shared helper's ULP discriminator", async () => {
    seedOverlay([annotation(2, "ULP edge", [0.01, 0, 0.15, 1])]);
    const canvas = await mountCanvas();
    await activateTagPick(canvas);

    press(canvas, 30, 50);

    expect(requests).toHaveLength(1);
    expect(requestBody()).toMatchObject({ yoloClass: "ULP edge" });
  });

  it("stops hit propagation before action-owned tail retirement and exact request", async () => {
    seedOverlay();
    const canvas = await mountCanvas();
    await activateTagPick(canvas);
    const token = claimToolTailAuthority(Object.freeze({ owner: "tag-hit" }));
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);
    const journal: string[] = [];
    const originalStop = Event.prototype.stopPropagation;
    vi.spyOn(Event.prototype, "stopPropagation").mockImplementation(function (this: Event) {
      journal.push(`stop:${ownsToolTailAuthority(token)}`);
      originalStop.call(this);
    });
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (previous.activeTool?.kind === "tagPick" && state.activeTool === null) {
        journal.push(`deactivate:${ownsToolTailAuthority(token)}`);
      }
    });
    fetchMock.mockImplementationOnce((url: unknown, init: RequestInit = {}) => {
      journal.push(`request:${ownsToolTailAuthority(token)}`);
      const request = deferred<Response>();
      requests.push({ url: String(url), init, deferred: request });
      return request.promise;
    });

    try {
      expect(press(canvas, 100, 50)).toBe(true);
    } finally {
      unsubscribe();
    }

    expect(journal).toEqual(["stop:true", "deactivate:false", "request:false"]);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(ownsToolTailAuthority(token)).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`/api/projects/${PUBLIC_ID}/map-tags-batch`);
    expect(requestBody()).toEqual({
      action: "scanClass",
      yoloClass: "Door",
      yoloModel: LIVE_MODEL,
    });
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
    expect((requests[0].init.signal as AbortSignal).aborted).toBe(false);
    expect(useToolStore.getState()._drawing).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("lets a miss bubble after one action-owned tail retirement without request/abort/clear", async () => {
    const oldResults: ToolTagScanResults = {
      yoloClass: "Old",
      yoloModel: "Old model",
      texts: [],
    };
    seedOverlay([TARGET], { tagScanResults: oldResults });
    const canvas = await mountCanvas();
    await activateTagPick(canvas);
    press(canvas, 100, 50);
    expect(requests).toHaveLength(1);
    const firstSignal = requests[0].init.signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);
    parentMouseDown.mockClear();
    await activateTagPick(canvas);
    const token = claimToolTailAuthority(Object.freeze({ owner: "tag-miss" }));
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);
    const journal: string[] = [];
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (previous.activeTool?.kind === "tagPick" && state.activeTool === null) {
        journal.push(`deactivate:${ownsToolTailAuthority(token)}`);
      }
    });
    parentMouseDown.mockImplementationOnce(() => {
      journal.push(`parent:${ownsToolTailAuthority(token)}`);
    });

    try {
      expect(press(canvas, 10, 90)).toBe(true);
    } finally {
      unsubscribe();
    }

    expect(journal).toEqual(["deactivate:false", "parent:false"]);
    expect(requests).toHaveLength(1);
    expect(firstSignal.aborted).toBe(false);
    expect(useToolStore.getState().tagScanResults).toBe(oldResults);
    expect(ownsToolTailAuthority(token)).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("skips non-YOLO bait and chooses the first overlapping visible YOLO", async () => {
    const rows = [
      annotation(10, "User bait", [0.2, 0.2, 0.8, 0.8], { source: "user" }),
      annotation(11, "First YOLO", [0.2, 0.2, 0.8, 0.8]),
      annotation(12, "Second YOLO", [0.2, 0.2, 0.8, 0.8]),
    ];
    seedOverlay(rows);
    const canvas = await mountCanvas();
    await activateTagPick(canvas);

    press(canvas, 100, 50);

    expect(requests).toHaveLength(1);
    expect(requestBody()).toMatchObject({ yoloClass: "First YOLO" });
  });

  it("uses the render-filtered current-page/visibility/model projection", async () => {
    const disabledModel = "Disabled model";
    const rows = [
      annotation(20, "Wrong page", [0.2, 0.2, 0.8, 0.8], { pageNumber: 3 }),
      annotation(21, "Hidden id", [0.2, 0.2, 0.8, 0.8]),
      annotation(22, "Disabled model", [0.2, 0.2, 0.8, 0.8], { modelName: disabledModel }),
      annotation(23, "Visible", [0.2, 0.2, 0.8, 0.8]),
    ];
    seedOverlay(rows, {
      hiddenAnnotationIds: new Set([21]),
      activeModels: { [LIVE_MODEL]: true, [disabledModel]: false },
    });
    const canvas = await mountCanvas();
    await activateTagPick(canvas);

    press(canvas, 100, 50);

    expect(requestBody()).toMatchObject({ yoloClass: "Visible" });
  });

  it.each([
    { label: "absent", modelName: undefined, includeModel: false },
    { label: "empty", modelName: "", includeModel: true },
  ])("uses truthy model fallback for $label modelName", async ({ modelName, includeModel }) => {
    seedOverlay([
      annotation(30, "Unknown model", [0.2, 0.2, 0.8, 0.8], {
        modelName,
        includeModel,
      }),
    ]);
    const canvas = await mountCanvas();
    await activateTagPick(canvas);

    press(canvas, 100, 50);

    expect(requestBody()).toMatchObject({ yoloModel: "unknown" });
  });

  it("keeps non-primary hits ungated and unprevented", async () => {
    seedOverlay();
    const canvas = await mountCanvas();
    await activateTagPick(canvas);

    expect(press(canvas, 100, 50, 2)).toBe(true);

    expect(requests).toHaveLength(1);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(useToolStore.getState().activeTool).toBeNull();
  });

  it("aborts the prior scan before installing a second request", async () => {
    const rows = [
      annotation(40, "Left", [0.1, 0.1, 0.4, 0.9]),
      annotation(41, "Right", [0.6, 0.1, 0.9, 0.9]),
    ];
    seedOverlay(rows);
    const canvas = await mountCanvas();
    await activateTagPick(canvas);

    press(canvas, 40, 50);
    const firstSignal = requests[0].init.signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);
    await activateTagPick(canvas);
    press(canvas, 160, 50);

    expect(requests).toHaveLength(2);
    expect(firstSignal.aborted).toBe(true);
    expect((requests[1].init.signal as AbortSignal).aborted).toBe(false);
    expect(requestBody(1)).toMatchObject({ yoloClass: "Right" });
  });

  it("deactivates a blank-project hit without aborting the prior scan or starting another", async () => {
    seedOverlay();
    const canvas = await mountCanvas();
    await activateTagPick(canvas);
    press(canvas, 100, 50);
    expect(requests).toHaveLength(1);
    const firstSignal = requests[0].init.signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    await activateTagPick(canvas);
    const readLiveSession = useSessionStore.getState;
    let sessionReads = 0;
    // Preserve #1 lifecycle guard + #2 current-session admission; blank only #3 tagPick lease.
    const sessionReadSpy = vi.spyOn(useSessionStore, "getState").mockImplementation(() => {
      sessionReads += 1;
      const session = readLiveSession();
      return sessionReads < 3 ? session : { ...session, publicId: "" };
    });
    parentMouseDown.mockClear();
    try {
      press(canvas, 100, 50);
    } finally {
      sessionReadSpy.mockRestore();
    }

    expect(sessionReads).toBeGreaterThanOrEqual(3);
    expect(useToolStore.getState().activeTool).toBeNull();
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(firstSignal.aborted).toBe(false);
  });

  it("leases the session snapshot read before reentrant deactivation publication", async () => {
    seedOverlay();
    const canvas = await mountCanvas();
    await activateTagPick(canvas);
    let changed = false;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (changed || previous.activeTool?.kind !== "tagPick" || state.activeTool !== null) return;
      changed = true;
      useSessionStore.setState({ publicId: SUCCESSOR_ID });
    });

    try {
      press(canvas, 100, 50);
    } finally {
      unsubscribe();
    }

    expect(changed).toBe(true);
    expect(useSessionStore.getState().publicId).toBe(SUCCESSOR_ID);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`/api/projects/${PUBLIC_ID}/map-tags-batch`);
  });
});

describe("tagPick seam topology pins (post-move)", () => {
  const root = process.cwd();
  const overlayPath = join(root, "src/components/viewer/AnnotationOverlay.tsx");
  const registryPath = join(root, "src/components/viewer/tools/registry.ts");
  const typesPath = join(root, "src/components/viewer/tools/types.ts");
  const controllerPath = join(root, "src/components/viewer/tools/tagPick.ts");
  const toolStorePath = join(root, "src/stores/toolStore.ts");
  const AO = readFileSync(overlayPath, "utf8");
  const REGISTRY = readFileSync(registryPath, "utf8");
  const TYPES = readFileSync(typesPath, "utf8");
  const CONTROLLER = readFileSync(controllerPath, "utf8");
  const TOOL_STORE = readFileSync(toolStorePath, "utf8");
  const mouseDownStart = AO.indexOf("const handleMouseDown = useCallback(");
  const mouseMoveStart = AO.indexOf("const handleMouseMove = useCallback(");
  const MOUSEDOWN = AO.slice(mouseDownStart, mouseMoveStart);
  const count = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;
  const sha256 = (value: string): string =>
    createHash("sha256").update(value).digest("hex");

  it("pins the legacy branch and transport absent, with the controller as their sole home", () => {
    expect(mouseDownStart).toBeGreaterThan(-1);
    expect(mouseMoveStart).toBeGreaterThan(mouseDownStart);
    expect(existsSync(controllerPath)).toBe(true);
    expect(count(MOUSEDOWN, "// YOLO Tag picking")).toBe(0);
    expect(count(MOUSEDOWN, 'if (activeTool?.kind === "tagPick")')).toBe(0);
    expect(AO).not.toContain(
      'import { requestMapTagsBatch } from "@/lib/client-map-tags";',
    );
    expect(count(AO, "requestMapTagsBatch")).toBe(0);
    expect(count(AO, "startTagScan")).toBe(0);

    expect(count(CONTROLLER, 'kind: "tagPick"')).toBe(1);
    expect(count(CONTROLLER, 'state.activeTool?.kind === "tagPick"')).toBe(1);
    expect(count(CONTROLLER, 'press.toolAtDown.activeTool?.kind === "tagPick"')).toBe(1);
    expect(count(CONTROLLER, "for (const annotation of pageAnnotations)")).toBe(1);
    expect(count(CONTROLLER, 'annotation.source !== "yolo"')).toBe(1);
    expect(CONTROLLER).toContain(
      "clickNormX >= minX && clickNormX <= maxX &&\n" +
      "        clickNormY >= minY && clickNormY <= maxY",
    );
    expect(count(CONTROLLER, "event.stopPropagation();")).toBe(1);
    expect(count(CONTROLLER, "startTagScan(annotation, yoloModel, context, tagPick);")).toBe(1);
    expect(count(CONTROLLER, "tagPick.setPickingMode(false);")).toBe(1);
    expect(count(CONTROLLER, "return true;")).toBe(2);
    expect(CONTROLLER).not.toContain("preventDefault");
    expect(CONTROLLER).not.toContain("event.button");

    expect(CONTROLLER).toContain(
      'import { requestMapTagsBatch } from "@/lib/client-map-tags";',
    );
    expect(count(CONTROLLER, "requestMapTagsBatch")).toBe(2); // import + sole call
    expect(count(CONTROLLER, "function startTagScan(")).toBe(1);

    const tagAddStart = MOUSEDOWN.indexOf(
      "      // Tag Add owns its exact tag payload",
    );
    const tagAddEnd = MOUSEDOWN.indexOf(
      "      // [refactor jul18 P3.2]",
      tagAddStart,
    );
    expect(tagAddEnd).toBeGreaterThan(tagAddStart);
    expect(sha256(MOUSEDOWN.slice(tagAddStart, tagAddEnd))).toBe(
      "8aa12bde214622075f634826e0eb221e649113fe53676a91bb94afc461cb9f8d",
    );
  });

  it("pins registry placement, raw component ref/setter wiring, and retained dependencies", () => {
    expect(REGISTRY).toContain('import { tagPickController } from "./tagPick";');
    expect(REGISTRY).toContain(
      "keynotePickController,\n    tagPickController,\n    symbolSearchController,\n    parseRectController,",
    );
    expect(TYPES).toContain(
      "  readonly tagPick?: Readonly<{\n" +
      "    scanControllerRef: { current: AbortController | null };\n" +
      '    setPickingMode: ToolStoreState["setYoloTagPickingMode"];\n' +
      "  }>;",
    );
    expect(AO).toContain(
      "          tagPick: {\n" +
      "            scanControllerRef: tagScanControllerRef,\n" +
      "            setPickingMode: setYoloTagPickingMode,\n" +
      "          },",
    );
    // Declaration + lifecycle cleanup/read/write + factory handoff: the journal stays mounted.
    expect(count(AO, "tagScanControllerRef")).toBe(4);

    const callbackStart = AO.indexOf("  const handleMouseDown = useCallback(");
    const callbackEnd = AO.indexOf("\n  );", callbackStart);
    const callback = AO.slice(callbackStart, callbackEnd + "\n  );".length);
    const relativeStart = callback.lastIndexOf("\n    [");
    const relativeEnd = callback.indexOf("]\n  );", relativeStart);
    const rawDependencies = callback.slice(relativeStart + 1, relativeEnd + 2);
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

  it("pins the one action-owned invalidation that already covers hit and miss", () => {
    const actionStart = TOOL_STORE.indexOf("  setYoloTagPickingMode: (active) => {");
    const actionEnd = TOOL_STORE.indexOf("  tagScanResults: null,", actionStart);
    expect(actionStart).toBeGreaterThan(-1);
    expect(actionEnd).toBeGreaterThan(actionStart);
    const action = TOOL_STORE.slice(actionStart, actionEnd);
    expect(count(action, "invalidateToolTailAuthority();")).toBe(1);
    expect(count(action, "set((state) =>")).toBe(1);
    expect(action.indexOf("invalidateToolTailAuthority();")).toBeLessThan(
      action.indexOf("set((state) =>"),
    );
    expect(CONTROLLER).not.toContain("invalidateToolTailAuthority");
    expect(CONTROLLER).not.toContain("@/lib/parse-tool-authority");
    expect(count(CONTROLLER, "store.setYoloTagPickingMode(false);")).toBe(1);
    expect(count(CONTROLLER, "tagPick.setPickingMode(false);")).toBe(1);
    expect(count(MOUSEDOWN, "setYoloTagPickingMode(false);")).toBe(0);
  });
});
