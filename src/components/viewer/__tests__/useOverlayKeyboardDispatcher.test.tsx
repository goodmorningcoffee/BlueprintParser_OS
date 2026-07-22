// @vitest-environment jsdom

import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/sessionStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const queryCommands = vi.hoisted(() => ({
  navigateYoloTag: vi.fn(),
  takeoffRedo: vi.fn(),
  takeoffUndo: vi.fn(),
}));
const persistence = vi.hoisted(() => ({ persistFetch: vi.fn() }));

vi.mock("@/lib/client-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-persist")>();
  return { ...actual, persistFetch: persistence.persistFetch };
});

vi.mock("@/queries/useYoloTags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/queries/useYoloTags")>();
  return { ...actual, navigateYoloTag: queryCommands.navigateYoloTag };
});

vi.mock("@/queries/useAnnotations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/queries/useAnnotations")>();
  return {
    ...actual,
    takeoffRedo: queryCommands.takeoffRedo,
    takeoffUndo: queryCommands.takeoffUndo,
  };
});

import { useOverlayKeyboardDispatcher } from "../useOverlayKeyboardDispatcher";

type DispatcherOptions = Parameters<typeof useOverlayKeyboardDispatcher>[0];
type ActiveDrag = NonNullable<ReturnType<DispatcherOptions["readActiveAnnotationDrag"]>>;

let queryClient: QueryClient;

function Harness({ options }: { options: DispatcherOptions }) {
  useOverlayKeyboardDispatcher(options);
  return (
    <div>
      <input data-testid="input" />
      <textarea data-testid="textarea" />
      <div data-testid="editable-root" contentEditable suppressContentEditableWarning>
        editable
        <span data-testid="editable-child">child</span>
      </div>
      <button data-testid="button" type="button">noneditable</button>
    </div>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function makeOptions(overrides: Partial<DispatcherOptions> = {}): DispatcherOptions {
  return {
    canAdoptProjectLifecycle: vi.fn(() => true),
    cancelDeferredDrawing: vi.fn(),
    acceptSplit: vi.fn(),
    prepareBucketFillPolygon: vi.fn(),
    savePolygon: vi.fn(),
    saveLinearPolyline: vi.fn(),
    setMousePos: vi.fn(),
    selectedId: null,
    isDemo: false,
    removeAnnotation: vi.fn(),
    setSelectedId: vi.fn(),
    readActiveAnnotationDrag: vi.fn(() => null),
    finishAnnotationDrag: vi.fn(),
    publishTransientError: vi.fn(),
    ...overrides,
  };
}

function dispatchKey(
  target: EventTarget,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function readySplitPreview() {
  return {
    targetAnnotationId: 41,
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
}

function dragSession(kind: "vertex" | "bbox"): ActiveDrag {
  return {
    operation: kind === "vertex"
      ? { kind, vertexIndex: 2 }
      : { kind, resizeCorner: "se", dragOffset: { x: 0.1, y: 0.2 } },
  } as ActiveDrag;
}

function expectNoCapabilityAction(options: DispatcherOptions): void {
  expect(options.cancelDeferredDrawing).not.toHaveBeenCalled();
  expect(options.acceptSplit).not.toHaveBeenCalled();
  expect(options.prepareBucketFillPolygon).not.toHaveBeenCalled();
  expect(options.savePolygon).not.toHaveBeenCalled();
  expect(options.saveLinearPolyline).not.toHaveBeenCalled();
  expect(options.setMousePos).not.toHaveBeenCalled();
  expect(options.removeAnnotation).not.toHaveBeenCalled();
  expect(options.setSelectedId).not.toHaveBeenCalled();
  expect(options.readActiveAnnotationDrag).not.toHaveBeenCalled();
  expect(options.finishAnnotationDrag).not.toHaveBeenCalled();
  expect(options.publishTransientError).not.toHaveBeenCalled();
}

beforeEach(() => {
  queryClient = new QueryClient();
  resetProjectData();
  setViewerStoreStateForTest({
    publicId: "rendered-project",
    isDemo: false,
    activeTool: null,
    activeTakeoffItemId: null,
    polygonDrawingMode: "idle",
    polygonVertices: [],
    splitPreview: null,
    bucketFillPreview: null,
    bucketFillBarriers: [],
    tagBrowseId: null,
    tagBrowseIndex: 0,
    llmHighlight: null,
  });
  queryCommands.navigateYoloTag.mockReset();
  queryCommands.takeoffRedo.mockReset();
  queryCommands.takeoffUndo.mockReset();
  persistence.persistFetch.mockReset().mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("useOverlayKeyboardDispatcher editable and lifecycle admission", () => {
  it.each([
    ["input", "ArrowRight"],
    ["textarea", "Enter"],
    ["editable-root", "Delete"],
    ["editable-child", "Escape"],
  ])("returns from %s before lifecycle, owner reads, actions, or native prevention", (testId, key) => {
    const activeDrag = dragSession("vertex");
    const options = makeOptions({
      selectedId: 91,
      readActiveAnnotationDrag: vi.fn(() => activeDrag),
    });
    setViewerStoreStateForTest({
      activeTool: { kind: "split" },
      splitPreview: readySplitPreview(),
      tagBrowseId: "modal-tag",
      tagBrowseIndex: 4,
    });

    render(<Harness options={options} />, { wrapper: Providers });
    const root = screen.getByTestId("editable-root");
    const child = screen.getByTestId("editable-child");
    Object.defineProperty(root, "isContentEditable", { configurable: true, value: true });
    Object.defineProperty(child, "isContentEditable", { configurable: true, value: true });

    const sessionRead = vi.spyOn(useSessionStore, "getState");
    const uiRead = vi.spyOn(useUiStore, "getState");
    const toolRead = vi.spyOn(useToolStore, "getState");
    vi.mocked(options.canAdoptProjectLifecycle).mockClear();

    const event = dispatchKey(screen.getByTestId(testId), key);

    expect(event.defaultPrevented).toBe(false);
    expect(options.canAdoptProjectLifecycle).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
    expect(uiRead).not.toHaveBeenCalled();
    expect(toolRead).not.toHaveBeenCalled();
    expectNoCapabilityAction(options);
    expect(queryCommands.navigateYoloTag).not.toHaveBeenCalled();
    expect(queryCommands.takeoffUndo).not.toHaveBeenCalled();
    expect(queryCommands.takeoffRedo).not.toHaveBeenCalled();
  });

  it("treats a button and Window as safe noneditable targets", () => {
    const options = makeOptions();
    setViewerStoreStateForTest({
      activeTool: { kind: "split" },
      splitPreview: readySplitPreview(),
    });
    render(<Harness options={options} />, { wrapper: Providers });

    const buttonEvent = dispatchKey(screen.getByTestId("button"), "Enter");
    const windowEvent = dispatchKey(window, "Enter");

    expect(buttonEvent.defaultPrevented).toBe(true);
    expect(windowEvent.defaultPrevented).toBe(true);
    expect(options.acceptSplit).toHaveBeenCalledTimes(2);
  });

  it("returns on a false lifecycle fence before live owner reads or actions", () => {
    const options = makeOptions({ canAdoptProjectLifecycle: vi.fn(() => false) });
    setViewerStoreStateForTest({
      activeTool: { kind: "takeoffPlacement" },
      tagBrowseId: "blocked-tag",
      tagBrowseIndex: 8,
    });
    render(<Harness options={options} />, { wrapper: Providers });
    const sessionRead = vi.spyOn(useSessionStore, "getState");
    const uiRead = vi.spyOn(useUiStore, "getState");
    const toolRead = vi.spyOn(useToolStore, "getState");

    const event = dispatchKey(window, "ArrowRight");

    expect(event.defaultPrevented).toBe(false);
    expect(options.canAdoptProjectLifecycle).toHaveBeenCalledTimes(1);
    expect(sessionRead).not.toHaveBeenCalled();
    expect(uiRead).not.toHaveBeenCalled();
    expect(toolRead).not.toHaveBeenCalled();
    expectNoCapabilityAction(options);
    expect(queryCommands.navigateYoloTag).not.toHaveBeenCalled();
    expect(queryCommands.takeoffUndo).not.toHaveBeenCalled();
    expect(queryCommands.takeoffRedo).not.toHaveBeenCalled();
  });
});

describe("useOverlayKeyboardDispatcher deterministic priority", () => {
  it.each([
    ["ArrowLeft", -1],
    ["ArrowRight", 1],
  ])("routes modal %s once with the exact live project, tag, and index", (key, delta) => {
    const options = makeOptions();
    setViewerStoreStateForTest({
      publicId: "stale-render-project",
      tagBrowseId: "stale-tag",
      tagBrowseIndex: 1,
    });
    render(<Harness options={options} />, { wrapper: Providers });
    setViewerStoreStateForTest({
      publicId: "live-event-project",
      tagBrowseId: "live-tag",
      tagBrowseIndex: 12,
    });

    const event = dispatchKey(window, key);

    expect(event.defaultPrevented).toBe(true);
    expect(queryCommands.navigateYoloTag).toHaveBeenCalledTimes(1);
    expect(queryCommands.navigateYoloTag).toHaveBeenCalledWith(
      queryClient,
      "live-event-project",
      "live-tag",
      12 + delta,
    );
    expectNoCapabilityAction(options);
    expect(queryCommands.takeoffUndo).not.toHaveBeenCalled();
    expect(queryCommands.takeoffRedo).not.toHaveBeenCalled();
  });

  it("treats an empty-string browse id as inactive before any modal claim", () => {
    // [refactor jul22 P3.4 K3] Green-hole closure: admission is TRUTHY, not non-null.
    const options = makeOptions();
    setViewerStoreStateForTest({ tagBrowseId: "", tagBrowseIndex: 4 });
    render(<Harness options={options} />, { wrapper: Providers });

    const event = dispatchKey(window, "ArrowRight");

    expect(event.defaultPrevented).toBe(false);
    expect(queryCommands.navigateYoloTag).not.toHaveBeenCalled();
    expectNoCapabilityAction(options);
  });

  it("keeps neighboring window keyboard owners observable after a modal claim", () => {
    const options = makeOptions();
    setViewerStoreStateForTest({ tagBrowseId: "modal-tag", tagBrowseIndex: 2 });
    render(<Harness options={options} />, { wrapper: Providers });
    const neighbor = vi.fn();
    window.addEventListener("keydown", neighbor);
    try {
      const event = dispatchKey(window, "ArrowRight");
      expect(event.defaultPrevented).toBe(true);
      expect(queryCommands.navigateYoloTag).toHaveBeenCalledTimes(1);
      expect(neighbor).toHaveBeenCalledTimes(1);
      expect(neighbor).toHaveBeenCalledWith(event);
    } finally {
      window.removeEventListener("keydown", neighbor);
    }
  });

  it("lets modal Escape clear browse state without running active-tool Escape", () => {
    const options = makeOptions();
    setViewerStoreStateForTest({
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: 71,
      polygonDrawingMode: "drawing",
      polygonVertices: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.2 },
        { x: 0.3, y: 0.3 },
      ],
      tagBrowseId: "modal-tag",
      tagBrowseIndex: 7,
      llmHighlight: {
        pageNumber: 2,
        bbox: [0.1, 0.1, 0.2, 0.2],
        label: "modal tag",
      },
    });
    render(<Harness options={options} />, { wrapper: Providers });

    const event = dispatchKey(window, "Escape");

    expect(event.defaultPrevented).toBe(true);
    expect(options.canAdoptProjectLifecycle).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState()).toMatchObject({
      tagBrowseId: null,
      tagBrowseIndex: 0,
      llmHighlight: null,
    });
    expect(useToolStore.getState()).toMatchObject({
      activeTool: { kind: "takeoffPlacement" },
      polygonDrawingMode: "drawing",
    });
    expect(options.cancelDeferredDrawing).not.toHaveBeenCalled();
    expect(options.setMousePos).not.toHaveBeenCalled();
  });

  it("rechecks lifecycle after modal highlight publication and preserves a synchronous successor", () => {
    const canAdopt = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const options = makeOptions({ canAdoptProjectLifecycle: canAdopt });
    setViewerStoreStateForTest({
      activeTool: { kind: "bucketFill" },
      tagBrowseId: "retiring-tag",
      tagBrowseIndex: 3,
      llmHighlight: {
        pageNumber: 1,
        bbox: [0.1, 0.1, 0.2, 0.2],
        label: "retiring",
      },
    });
    let admittedSuccessor = false;
    const unsubscribe = useUiStore.subscribe((state, previous) => {
      if (admittedSuccessor || state.llmHighlight === previous.llmHighlight) return;
      admittedSuccessor = true;
      useUiStore.setState({ tagBrowseId: "successor-tag", tagBrowseIndex: 99 });
    });
    render(<Harness options={options} />, { wrapper: Providers });

    const event = dispatchKey(window, "Escape");
    unsubscribe();

    expect(event.defaultPrevented).toBe(true);
    expect(canAdopt).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState()).toMatchObject({
      tagBrowseId: "successor-tag",
      tagBrowseIndex: 99,
      llmHighlight: null,
    });
    expect(options.cancelDeferredDrawing).not.toHaveBeenCalled();
  });

  it.each(["split", "bucketFill", "takeoffPlacement"] as const)(
    "finishes the exact active drag before the %s Enter owner can commit",
    (kind) => {
      const activeDrag = dragSession(kind === "bucketFill" ? "bbox" : "vertex");
      const options = makeOptions({
        readActiveAnnotationDrag: vi.fn(() => activeDrag),
      });
      if (kind === "split") {
        setViewerStoreStateForTest({
          activeTool: { kind },
          splitPreview: readySplitPreview(),
        });
      } else if (kind === "bucketFill") {
        setViewerStoreStateForTest({
          activeTool: { kind },
          bucketFillPreview: {
            vertices: [
              { x: 0.1, y: 0.1 },
              { x: 0.9, y: 0.1 },
              { x: 0.9, y: 0.9 },
            ],
            method: "flood",
          },
        });
      } else {
        setViewerStoreStateForTest({
          activeTool: { kind },
          activeTakeoffItemId: 71,
          polygonDrawingMode: "drawing",
          polygonVertices: [
            { x: 0.1, y: 0.1 },
            { x: 0.9, y: 0.1 },
            { x: 0.9, y: 0.9 },
          ],
        });
      }
      render(<Harness options={options} />, { wrapper: Providers });

      const event = dispatchKey(window, "Enter");

      expect(event.defaultPrevented).toBe(true);
      expect(options.readActiveAnnotationDrag).toHaveBeenCalledTimes(1);
      expect(options.finishAnnotationDrag).toHaveBeenCalledTimes(1);
      expect(options.finishAnnotationDrag).toHaveBeenCalledWith(activeDrag, true);
      expect(options.acceptSplit).not.toHaveBeenCalled();
      expect(options.prepareBucketFillPolygon).not.toHaveBeenCalled();
      expect(options.savePolygon).not.toHaveBeenCalled();
      expect(options.saveLinearPolyline).not.toHaveBeenCalled();
    },
  );
});

describe("useOverlayKeyboardDispatcher selected deletion", () => {
  it("uses the live persistable project, removes locally, and clears selection", () => {
    const trace: string[] = [];
    const options = makeOptions({
      selectedId: 91,
      isDemo: false,
      removeAnnotation: vi.fn(() => trace.push("remove")),
      setSelectedId: vi.fn(() => trace.push("clear")),
    });
    setViewerStoreStateForTest({ publicId: "" });
    render(<Harness options={options} />, { wrapper: Providers });
    setViewerStoreStateForTest({ publicId: "live-project" });

    const event = dispatchKey(window, "Delete");

    expect(event.defaultPrevented).toBe(true);
    expect(persistence.persistFetch).toHaveBeenCalledTimes(1);
    expect(persistence.persistFetch).toHaveBeenCalledWith(
      "/api/annotations/91",
      undefined,
      "DELETE",
    );
    expect(options.removeAnnotation).toHaveBeenCalledWith(91);
    expect(options.setSelectedId).toHaveBeenCalledWith(null);
    expect(trace).toEqual(["remove", "clear"]);
  });

  it.each([
    ["demo", 91, true],
    ["temporary", -7, false],
  ] as const)("keeps a %s selection delete local-only", (_label, selectedId, isDemo) => {
    const options = makeOptions({ selectedId, isDemo });
    render(<Harness options={options} />, { wrapper: Providers });

    const event = dispatchKey(window, "Backspace");

    expect(event.defaultPrevented).toBe(true);
    expect(persistence.persistFetch).not.toHaveBeenCalled();
    expect(options.removeAnnotation).toHaveBeenCalledWith(selectedId);
    expect(options.setSelectedId).toHaveBeenCalledWith(null);
  });

  it("does not clear a successor selection when lifecycle retires during local removal", () => {
    const canAdopt = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const options = makeOptions({
      selectedId: 91,
      isDemo: true,
      canAdoptProjectLifecycle: canAdopt,
    });
    render(<Harness options={options} />, { wrapper: Providers });

    dispatchKey(window, "Delete");

    expect(options.removeAnnotation).toHaveBeenCalledWith(91);
    expect(options.setSelectedId).not.toHaveBeenCalled();
    expect(canAdopt).toHaveBeenCalledTimes(2);
  });

  it("publishes the exact persistence failure without rolling back the local removal", async () => {
    persistence.persistFetch.mockRejectedValueOnce(new Error("wire down"));
    const options = makeOptions({ selectedId: 91, isDemo: false });
    render(<Harness options={options} />, { wrapper: Providers });

    dispatchKey(window, "Delete");

    expect(options.removeAnnotation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(options.publishTransientError).toHaveBeenCalledWith(
      "Failed to delete: wire down",
    ));
    expect(options.removeAnnotation).toHaveBeenCalledTimes(1);
  });
});

describe("useOverlayKeyboardDispatcher freshness and takeoff command ownership", () => {
  it("replaces a dependency-bound listener so one key runs only the latest capability", () => {
    const firstAccept = vi.fn();
    const latestAccept = vi.fn();
    const first = makeOptions({ acceptSplit: firstAccept });
    const latest = makeOptions({ acceptSplit: latestAccept });
    setViewerStoreStateForTest({
      activeTool: { kind: "split" },
      splitPreview: readySplitPreview(),
    });
    const view = render(<Harness options={first} />, { wrapper: Providers });

    view.rerender(<Harness options={latest} />);
    const event = dispatchKey(window, "Enter");

    expect(event.defaultPrevented).toBe(true);
    expect(firstAccept).not.toHaveBeenCalled();
    expect(latestAccept).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["z", "undo", {}],
    ["Z", "undo", { shiftKey: true }],
    ["w", "redo", {}],
    ["W", "redo", { altKey: true }],
  ] as const)("routes plain %s only through the takeoff %s Query command", (key, command, init) => {
    const options = makeOptions();
    setViewerStoreStateForTest({ activeTool: { kind: "takeoffPlacement" } });
    render(<Harness options={options} />, { wrapper: Providers });

    const event = dispatchKey(window, key, init);

    expect(event.defaultPrevented).toBe(true);
    const expected = command === "undo" ? queryCommands.takeoffUndo : queryCommands.takeoffRedo;
    const other = command === "undo" ? queryCommands.takeoffRedo : queryCommands.takeoffUndo;
    expect(expected).toHaveBeenCalledTimes(1);
    expect(expected).toHaveBeenCalledWith(queryClient);
    expect(other).not.toHaveBeenCalled();
  });

  it.each([
    ["z", { ctrlKey: true }],
    ["w", { metaKey: true }],
  ] as const)("does not route modified %s through plain takeoff history", (key, init) => {
    const options = makeOptions();
    setViewerStoreStateForTest({
      activeTool: { kind: "takeoffPlacement" },
      polygonDrawingMode: "idle",
    });
    render(<Harness options={options} />, { wrapper: Providers });

    const event = dispatchKey(window, key, init);

    expect(event.defaultPrevented).toBe(false);
    expect(queryCommands.takeoffUndo).not.toHaveBeenCalled();
    expect(queryCommands.takeoffRedo).not.toHaveBeenCalled();
  });

  it("leaves plain Z unclaimed for every non-takeoff owner", () => {
    const options = makeOptions();
    setViewerStoreStateForTest({ activeTool: { kind: "bucketFill" } });
    render(<Harness options={options} />, { wrapper: Providers });

    const event = dispatchKey(window, "Z");

    expect(event.defaultPrevented).toBe(false);
    expect(queryCommands.takeoffUndo).not.toHaveBeenCalled();
    expect(queryCommands.takeoffRedo).not.toHaveBeenCalled();
  });
});
