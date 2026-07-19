// @vitest-environment jsdom
//
// [refactor jul19 P3.2] EXECUTABLE behavior freeze for the legacy Split mousedown branch,
// landed test-only BEFORE the controller extraction. The real AnnotationOverlay handler proves:
//   - a visible preview consumes without invalidating the global tail or preventing default;
//   - the first press accepts every mouse button, stops propagation, invalidates before publishing
//     A, and normalizes x/y against the distinct canvas width/height;
//   - the second press publishes B before detection, retains both endpoints on a miss, and emits
//     the exact transient message with the legacy 3500ms lifetime;
//   - multiple candidates are ordered by longest chord, and preview publication retains the exact
//     render-captured annotation vertices plus press-captured line-A identity even if the live
//     store is synchronously changed by the B publication.
//   - a holed longest candidate is rejected after ranking without falling through or clearing A/B.
//
// The behavior rows remain the parent oracle; the final describe is now POST-move topology and
// names the controller as the sole mousedown home in the exact 12-entry registry.

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
  claimToolTailAuthority,
  ownsToolTailAuthority,
  registerToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";
import { TOOLS } from "../tools/registry";

const PUBLIC_ID = "split-gesture-fixture";
const PAGE = 1;
const WIDTH = 200;
const HEIGHT = 100;
const MISS_MESSAGE = "Line does not cross any area polygon in exactly 2 places";
const HOLED_TARGET_MESSAGE = "Area polygons with holes cannot be split yet";

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

function canvasRect(width: number, height: number): DOMRect {
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

function areaAnnotation(
  id: number,
  vertices: { x: number; y: number }[],
  holes?: { vertices: { x: number; y: number }[] }[],
): ClientAnnotation {
  const xs = vertices.map((point) => point.x);
  const ys = vertices.map((point) => point.y);
  return {
    id,
    pageNumber: PAGE,
    name: `Area ${id}`,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    note: null,
    source: "takeoff",
    data: {
      type: "area-polygon",
      takeoffItemId: 31,
      color: "#22c55e",
      vertices,
      ...(holes === undefined ? {} : { holes }),
      areaSqUnits: 1,
      unit: "SF",
    },
  };
}

function seedSplitState(
  rows: ClientAnnotation[] = [],
  hiddenAnnotationIds = new Set<number>(),
): void {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  parentMouseDown.mockClear();
  fetchMock.mockReset();
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE,
    numPages: 1,
    pageNames: { [PAGE]: "A-101" },
    mode: "pointer",
    activeTool: { kind: "split" },
    splitLineA: null,
    splitLineB: null,
    splitPreview: null,
    splitError: null,
    hiddenAnnotationIds,
  });
  seedAnnotations(queryClient, rows);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    noopContext(),
  );
}

async function mountCanvas(
  width = WIDTH,
  height = HEIGHT,
): Promise<HTMLCanvasElement> {
  const { container } = render(
    <AnnotationOverlay width={width} height={height} cssScale={1} />,
    { wrapper },
  );
  const canvas = await waitFor(() => {
    const candidate = container.querySelector("canvas");
    if (!(candidate instanceof HTMLCanvasElement)) {
      throw new Error("Expected AnnotationOverlay canvas");
    }
    return candidate;
  });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    canvasRect(width, height),
  );
  return canvas;
}

function mouseDownEvent(
  clientX: number,
  clientY: number,
  button = 0,
): MouseEvent {
  return new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button,
  });
}

function press(canvas: HTMLCanvasElement, event: MouseEvent): void {
  act(() => {
    fireEvent(canvas, event);
  });
}

describe("split gesture freeze (real overlay, production mousedown)", () => {
  afterEach(async () => {
    cleanup();
    queryClient?.clear();
    resetProjectData();
    await Promise.resolve();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("W0: a non-Split press falls through without touching Split state", async () => {
    seedSplitState();
    const canvas = await mountCanvas();
    act(() => {
      useToolStore.setState({ activeTool: null });
    });
    const event = mouseDownEvent(180, 90);

    press(canvas, event);

    expect(parentMouseDown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(useToolStore.getState()).toMatchObject({
      splitLineA: null,
      splitLineB: null,
      splitPreview: null,
      splitError: null,
    });
  });

  it("W1: preview-present consumes terminally without invalidating the tail or preventing default", async () => {
    seedSplitState();
    const canvas = await mountCanvas();
    const preview = {
      targetAnnotationId: 88,
      original: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ],
      left: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.9 },
      ],
      right: [
        { x: 0.5, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ],
      lineA: { x: 0.5, y: 0.1 },
      lineB: { x: 0.5, y: 0.9 },
    };
    act(() => {
      useToolStore.setState({
        splitPreview: preview,
        splitLineA: preview.lineA,
        splitLineB: preview.lineB,
        splitError: "retained preview error",
      });
    });
    const token = claimToolTailAuthority({ witness: "preview" });
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);
    const event = mouseDownEvent(170, 80);
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    press(canvas, event);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(ownsToolTailAuthority(token)).toBe(true);
    expect(useToolStore.getState().splitPreview).toBe(preview);
    expect(useToolStore.getState().splitLineA).toBe(preview.lineA);
    expect(useToolStore.getState().splitLineB).toBe(preview.lineB);
    expect(useToolStore.getState().splitError).toBe("retained preview error");
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("W2: a non-primary first click stops, invalidates, then publishes anisotropically normalized A", async () => {
    seedSplitState();
    const canvas = await mountCanvas();
    const token = claimToolTailAuthority({ witness: "first-click" });
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);
    const event = mouseDownEvent(60, 70, 2);
    const originalStop = event.stopPropagation.bind(event);
    let tailOwnedAtStop: boolean | null = null;
    const stopPropagation = vi
      .spyOn(event, "stopPropagation")
      .mockImplementation(() => {
        tailOwnedAtStop = ownsToolTailAuthority(token);
        originalStop();
      });
    let publicationObservation: {
      stopCalls: number;
      tailOwned: boolean;
    } | null = null;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state.splitLineA === previous.splitLineA) return;
      publicationObservation = {
        stopCalls: stopPropagation.mock.calls.length,
        tailOwned: ownsToolTailAuthority(token),
      };
    });

    press(canvas, event);
    unsubscribe();

    expect(publicationObservation).toEqual({ stopCalls: 1, tailOwned: false });
    expect(tailOwnedAtStop).toBe(true);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(useToolStore.getState().splitLineA).toEqual({ x: 0.3, y: 0.7 });
    expect(useToolStore.getState().splitLineB).toBeNull();
    expect(useToolStore.getState().splitPreview).toBeNull();
    expect(useToolStore.getState().splitError).toBeNull();
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("W3: a second-click miss retains A and B and publishes the exact 3500ms transient error", async () => {
    seedSplitState();
    const canvas = await mountCanvas();
    const lineA = { x: 0.05, y: 0.05 };
    act(() => {
      useToolStore.getState().setSplitLineEndpoint("a", lineA);
    });
    const token = claimToolTailAuthority({ witness: "miss" });
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);
    const journal: string[] = [];
    const timeout = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((_callback, delay) => {
        journal.push(`timer:${String(delay)}`);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      });
    timeout.mockClear();
    const event = mouseDownEvent(190, 5);
    const originalStop = event.stopPropagation.bind(event);
    vi.spyOn(event, "stopPropagation").mockImplementation(() => {
      journal.push("stop");
      originalStop();
    });
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (state.splitLineB !== previous.splitLineB) {
        journal.push(
          `B:tail-${ownsToolTailAuthority(token) ? "owned" : "retired"}`,
        );
      }
      if (state.splitError !== previous.splitError) journal.push("error");
    });

    press(canvas, event);
    unsubscribe();

    expect(useToolStore.getState().splitLineA).toBe(lineA);
    expect(useToolStore.getState().splitLineB).toEqual({ x: 0.95, y: 0.05 });
    expect(useToolStore.getState().splitPreview).toBeNull();
    expect(useToolStore.getState().splitError).toBe(MISS_MESSAGE);
    expect(journal).toEqual(["stop", "B:tail-retired", "error", "timer:3500"]);
    expect(timeout.mock.calls.map((call) => call[1])).toEqual([3500]);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 3500);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(ownsToolTailAuthority(token)).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("W4: the longest later candidate wins with exact preview geometry and captured-A identity", async () => {
    const smallVertices = [
      { x: 0.1, y: 0.4 },
      { x: 0.3, y: 0.4 },
      { x: 0.3, y: 0.6 },
      { x: 0.1, y: 0.6 },
    ];
    const winningVertices = [
      { x: 0.4, y: 0.2 },
      { x: 0.9, y: 0.2 },
      { x: 0.9, y: 0.8 },
      { x: 0.4, y: 0.8 },
    ];
    const hiddenWidestVertices = [
      { x: 0.01, y: 0.1 },
      { x: 0.99, y: 0.1 },
      { x: 0.99, y: 0.9 },
      { x: 0.01, y: 0.9 },
    ];
    // The shorter polygon is deliberately first: annotation order must not beat chord length.
    // A still-wider hidden polygon proves the real render projection is honored before ranking.
    seedSplitState(
      [
        areaAnnotation(201, smallVertices),
        areaAnnotation(202, winningVertices),
        areaAnnotation(203, hiddenWidestVertices),
      ],
      new Set([203]),
    );
    const canvas = await mountCanvas();
    const capturedLineA = { x: 0.05, y: 0.5 };
    const replacementLineA = { x: 0.05, y: 0.95 };
    act(() => {
      useToolStore.getState().setSplitLineEndpoint("a", capturedLineA);
    });
    const token = claimToolTailAuthority({ witness: "success" });
    const cancelled = vi.fn();
    registerToolTailCancellation(token, cancelled);
    let replacedDuringB = false;
    let tailOwnedAtB: boolean | null = null;
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (
        replacedDuringB ||
        state.splitLineB === previous.splitLineB ||
        state.splitLineB === null
      )
        return;
      replacedDuringB = true;
      tailOwnedAtB = ownsToolTailAuthority(token);
      useToolStore.setState({ splitLineA: replacementLineA });
    });
    const event = mouseDownEvent(190, 50);
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    press(canvas, event);
    unsubscribe();

    const preview = useToolStore.getState().splitPreview;
    expect(replacedDuringB).toBe(true);
    expect(tailOwnedAtB).toBe(false);
    expect(useToolStore.getState().splitLineA).toBe(replacementLineA);
    expect(preview).not.toBeNull();
    expect(preview?.targetAnnotationId).toBe(202);
    expect(preview?.original).toBe(winningVertices);
    expect(preview?.lineA).toBe(capturedLineA);
    expect(preview?.lineB).toBe(useToolStore.getState().splitLineB);
    expect(preview).toEqual({
      targetAnnotationId: 202,
      original: winningVertices,
      left: [
        { x: 0.9, y: 0.5 },
        { x: 0.9, y: 0.8 },
        { x: 0.4, y: 0.8 },
        { x: 0.4, y: 0.5 },
      ],
      right: [
        { x: 0.4, y: 0.5 },
        { x: 0.4, y: 0.2 },
        { x: 0.9, y: 0.2 },
        { x: 0.9, y: 0.5 },
      ],
      lineA: capturedLineA,
      lineB: { x: 0.95, y: 0.5 },
    });
    expect(useToolStore.getState().splitError).toBeNull();
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(parentMouseDown).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("W5: a holed longest target fails closed without falling through or clearing A/B", async () => {
    const shorterVertices = [
      { x: 0.1, y: 0.4 },
      { x: 0.25, y: 0.4 },
      { x: 0.25, y: 0.6 },
      { x: 0.1, y: 0.6 },
    ];
    const holedWinnerVertices = [
      { x: 0.3, y: 0.2 },
      { x: 0.9, y: 0.2 },
      { x: 0.9, y: 0.8 },
      { x: 0.3, y: 0.8 },
    ];
    const holeSentinel = [
      { x: 0.5, y: 0.4 },
      { x: 0.7, y: 0.4 },
      { x: 0.7, y: 0.6 },
      { x: 0.5, y: 0.6 },
    ];
    seedSplitState([
      areaAnnotation(301, shorterVertices),
      areaAnnotation(302, holedWinnerVertices, [{ vertices: holeSentinel }]),
    ]);
    const canvas = await mountCanvas();
    const capturedA = { x: 0.05, y: 0.5 };
    act(() => {
      useToolStore.getState().setSplitLineEndpoint("a", capturedA);
    });
    const timeout = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(() => 1 as unknown as ReturnType<typeof setTimeout>);
    timeout.mockClear();

    press(canvas, mouseDownEvent(190, 50));

    expect(useToolStore.getState().splitLineA).toBe(capturedA);
    expect(useToolStore.getState().splitLineB).toEqual({ x: 0.95, y: 0.5 });
    expect(useToolStore.getState().splitPreview).toBeNull();
    expect(useToolStore.getState().splitError).toBe(HOLED_TARGET_MESSAGE);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 5000);
    expect(parentMouseDown).not.toHaveBeenCalled();
  });
});

describe("split seam topology pins (POST-move: controller is the sole mousedown home)", () => {
  const AO = readFileSync(
    join(process.cwd(), "src/components/viewer/AnnotationOverlay.tsx"),
    "utf8",
  );
  const REGISTRY = readFileSync(
    join(process.cwd(), "src/components/viewer/tools/registry.ts"),
    "utf8",
  );
  const splitControllerPath = join(
    process.cwd(),
    "src/components/viewer/tools/split.ts",
  );
  const CONTROLLER = readFileSync(splitControllerPath, "utf8");
  const mouseDownStart = AO.indexOf("  const handleMouseDown = useCallback(");
  const mouseMoveStart = AO.indexOf("  const handleMouseMove = useCallback(");
  const MOUSEDOWN = AO.slice(mouseDownStart, mouseMoveStart);
  const count = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;
  const sha256 = (value: string): string =>
    createHash("sha256").update(value).digest("hex");

  it("pins the legacy branch absent and the controller as the sole mousedown home", () => {
    expect(mouseDownStart).toBeGreaterThan(-1);
    expect(mouseMoveStart).toBeGreaterThan(mouseDownStart);
    expect(existsSync(splitControllerPath)).toBe(true);
    expect(count(MOUSEDOWN, "// Split Area mode")).toBe(0);
    expect(count(MOUSEDOWN, 'if (activeTool?.kind === "split")')).toBe(0);
    expect(count(MOUSEDOWN, "findSplittablePolygons(")).toBe(0);
    expect(count(CONTROLLER, 'kind: "split"')).toBe(1);
    expect(count(CONTROLLER, 'state.activeTool?.kind === "split"')).toBe(1);
    expect(
      count(CONTROLLER, 'press.toolAtDown.activeTool?.kind === "split"'),
    ).toBe(1);
    expect(count(CONTROLLER, "findSplittablePolygons(")).toBe(1);
    expect(count(CONTROLLER, "const best = candidates[0];")).toBe(1);
    expect(CONTROLLER).toContain(MISS_MESSAGE);
  });

  it("pins Split immediately before BucketFill in the exact 12-controller registry", () => {
    expect(REGISTRY).toContain('import { splitController } from "./split";');
    expect(REGISTRY).toContain(
      'import { bucketFillController } from "./bucketFill";',
    );
    expect(REGISTRY).toContain(
      "    calibrationController,\n    splitController,\n    bucketFillController,\n" +
        "    takeoffPolygonController,",
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
      "markup",
    ]);
    expect(TOOLS).toHaveLength(12);
  });

  it("pins the atomic acceptSplit terminal and sacred mousedown dependency block", () => {
    const acceptStart = AO.indexOf("  /** Accept a pending Split Area preview");
    const acceptEnd = AO.indexOf(
      "  /** Save the current in-progress polyline",
      acceptStart,
    );
    expect(acceptStart).toBeGreaterThan(-1);
    expect(acceptEnd).toBeGreaterThan(acceptStart);
    // Exclude only the blank separator immediately before the next owned callback docblock.
    const acceptSplit = AO.slice(acceptStart, acceptEnd - 1);
    expect(Buffer.byteLength(acceptSplit, "utf8")).toBe(856);
    expect(sha256(acceptSplit)).toBe(
      "6b8a5c88c395e32cea46009f6d5776cb22cf26ffbe4286b03af25654628cd1c0",
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
});
