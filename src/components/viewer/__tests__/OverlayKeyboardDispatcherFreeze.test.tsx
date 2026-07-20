// @vitest-environment jsdom

// [refactor jul20 P3.4 K0] Parent behavior freeze for AnnotationOverlay's two window-keydown
// listeners. This deliberately records the editable-target holes and the registration-order
// fan-out that the dispatcher extraction must preserve or explicitly retire.

import { type ReactNode } from "react";
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
import {
  claimToolTailAuthority,
  invalidateToolTailAuthority,
  ownsToolTailAuthority,
  registerToolTailCancellation,
  releaseToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { resetProjectData } from "@/stores/viewerCommands";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import {
  readSeededAnnotations,
  seedAnnotations,
} from "@/test/seed-annotations";
import { seedTakeoff } from "@/test/seed-takeoff";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientAnnotation, ClientTakeoffItem } from "@/types";
import type { AnnotationDragSession } from "../useAnnotationDragMachine";

const dragHarness = vi.hoisted(() => ({
  begin: vi.fn(() => true),
  finish: vi.fn(() => true),
  readActive: vi.fn<() => unknown>(() => null),
  schedule: vi.fn(),
}));

vi.mock("../useAnnotationDragMachine", () => ({
  useAnnotationDragMachine: () => dragHarness,
}));
vi.mock("@/lib/bucket-fill-client", () => ({
  clientBucketFill: vi.fn(),
  findPageCanvas: vi.fn(() => null),
}));
vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "overlay-keyboard-parent";
const PAGE = 1;
const ITEM_ID = 41;
const SELECTED_ID = 71;
const VERTICES = [
  { x: 0.1, y: 0.2 },
  { x: 0.5, y: 0.6 },
  { x: 0.8, y: 0.3 },
];

const linearItem: ClientTakeoffItem = {
  id: ITEM_ID,
  groupId: null,
  name: "Keyboard conduit",
  shape: "linear",
  color: "#3b82f6",
  size: 10,
  sortOrder: 0,
};

function selectedAnnotation(): ClientAnnotation {
  return {
    id: SELECTED_ID,
    pageNumber: PAGE,
    name: "Selected markup",
    bbox: [0.2, 0.2, 0.4, 0.4],
    note: null,
    source: "user",
    data: null,
  };
}

function dragSession(): AnnotationDragSession {
  return {
    generation: 1,
    publicId: PUBLIC_ID,
    pageNumber: PAGE,
    annotationId: SELECTED_ID,
    isDemo: true,
    canAdopt: () => true,
    reportError: vi.fn(),
    pageEpoch: 0,
    origin: selectedAnnotation(),
    operation: {
      kind: "bbox",
      resizeCorner: null,
      dragOffset: { x: 0, y: 0 },
    },
    lastPublishedRow: null,
  };
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

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function Fixture({ width = 100 }: { width?: number }) {
  return (
    <>
      <input data-testid="input" />
      <textarea data-testid="textarea" />
      <div data-testid="contenteditable" contentEditable suppressContentEditableWarning>
        editable
      </div>
      <button data-testid="button" type="button">button</button>
      <AnnotationOverlay width={width} height={100} cssScale={1} />
    </>
  );
}

type TargetName = "input" | "textarea" | "contenteditable" | "button";
const ALL_TARGETS: TargetName[] = ["input", "textarea", "contenteditable", "button"];

function target(name: TargetName): HTMLElement {
  return screen.getByTestId(name);
}

function press(
  targetElement: Element | Node | Document | Window,
  key: string,
  init: Pick<KeyboardEventInit, "ctrlKey" | "metaKey"> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  fireEvent(targetElement, event);
  return event;
}

function setToolState(
  patch: Partial<ReturnType<typeof useToolStore.getState>>,
): void {
  act(() => useToolStore.setState(patch));
}

function claimTail() {
  const token = {};
  const cancel = vi.fn();
  claimToolTailAuthority(token);
  registerToolTailCancellation(token, cancel);
  return { token, cancel };
}

async function flushTail(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function discardRetainedTail(token: object): void {
  releaseToolTailCancellation(token);
  invalidateToolTailAuthority();
}

function mount(width = 100) {
  return render(<Fixture width={width} />, { wrapper });
}

async function selectRow(): Promise<void> {
  act(() => {
    seedAnnotations(queryClient, [selectedAnnotation()]);
    useUiStore.getState().setFocusAnnotationId(SELECTED_ID);
  });
  await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  dragHarness.begin.mockReset().mockReturnValue(true);
  dragHarness.finish.mockReset().mockReturnValue(true);
  dragHarness.readActive.mockReset().mockReturnValue(null);
  dragHarness.schedule.mockReset();
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 410,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: PAGE,
    numPages: 1,
    pageNames: { 1: "A-101" },
    mode: "pointer",
    activeTool: null,
    activeTakeoffItemId: null,
    polygonDrawingMode: "idle",
    polygonVertices: [],
    bucketFillPreview: null,
    bucketFillPendingPolygon: null,
    bucketFillBarriers: [],
    bucketFillBarrierMode: false,
    splitPreview: null,
    splitLineA: null,
    splitLineB: null,
    _mousePos: null,
    focusAnnotationId: null,
  });
  seedAnnotations(queryClient, []);
  seedTakeoff(queryClient, [linearItem], []);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
});

afterEach(async () => {
  cleanup();
  queryClient.clear();
  invalidateToolTailAuthority();
  await Promise.resolve();
  vi.restoreAllMocks();
});

describe("AnnotationOverlay parent keyboard behavior", () => {
  it("Escape currently consumes tool drawing from every editable kind and the button without preventing default", async () => {
    setToolState({
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: ITEM_ID,
    });
    mount();

    for (const targetName of ALL_TARGETS) {
      setToolState({
        polygonDrawingMode: "drawing",
        polygonVertices: VERTICES,
        _mousePos: { x: 0.4, y: 0.5 },
      });
      const tail = claimTail();

      const event = press(target(targetName), "Escape");

      expect(event.defaultPrevented, targetName).toBe(false);
      expect(useToolStore.getState().polygonDrawingMode, targetName).toBe("idle");
      expect(useToolStore.getState().polygonVertices, targetName).toEqual([]);
      expect(useToolStore.getState()._mousePos, targetName).toBeNull();
      expect(ownsToolTailAuthority(tail.token), targetName).toBe(false);
      await flushTail();
      expect(tail.cancel, targetName).toHaveBeenCalledTimes(1);
    }
  });

  it("tool Enter currently finishes a line from every editable kind and the button", async () => {
    setToolState({
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: ITEM_ID,
    });
    mount();

    for (const targetName of ALL_TARGETS) {
      act(() => seedAnnotations(queryClient, []));
      setToolState({ polygonDrawingMode: "drawing", polygonVertices: VERTICES });
      const tail = claimTail();

      const event = press(target(targetName), "Enter");

      expect(event.defaultPrevented, targetName).toBe(true);
      expect(readSeededAnnotations(queryClient), targetName).toHaveLength(1);
      expect(readSeededAnnotations(queryClient)[0].data, targetName).toMatchObject({
        type: "linear-polyline",
        takeoffItemId: ITEM_ID,
        vertices: VERTICES,
      });
      expect(useToolStore.getState().polygonDrawingMode, targetName).toBe("idle");
      expect(ownsToolTailAuthority(tail.token), targetName).toBe(false);
      await flushTail();
      expect(tail.cancel, targetName).toHaveBeenCalledTimes(1);
    }
  });

  it("B guards input and textarea, but currently toggles from contenteditable and the button", async () => {
    setToolState({ activeTool: { kind: "bucketFill" } });
    mount();

    for (const targetName of ALL_TARGETS) {
      setToolState({ bucketFillBarrierMode: false, bucketFillPreview: null });
      const tail = claimTail();
      const handled = targetName === "contenteditable" || targetName === "button";

      const event = press(target(targetName), "B");

      expect(event.defaultPrevented, targetName).toBe(handled);
      expect(useToolStore.getState().bucketFillBarrierMode, targetName).toBe(handled);
      expect(ownsToolTailAuthority(tail.token), targetName).toBe(!handled);
      if (handled) {
        await flushTail();
        expect(tail.cancel, targetName).toHaveBeenCalledTimes(1);
      } else {
        expect(tail.cancel, targetName).not.toHaveBeenCalled();
        discardRetainedTail(tail.token);
      }
    }
  });

  it("Ctrl+z currently removes a tool vertex from every editable kind and the button", async () => {
    setToolState({
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: ITEM_ID,
    });
    mount();

    for (const targetName of ALL_TARGETS) {
      setToolState({ polygonDrawingMode: "drawing", polygonVertices: VERTICES });
      const tail = claimTail();

      const event = press(target(targetName), "z", { ctrlKey: true });

      expect(event.defaultPrevented, targetName).toBe(true);
      expect(useToolStore.getState().polygonVertices, targetName).toEqual(VERTICES.slice(0, -1));
      expect(ownsToolTailAuthority(tail.token), targetName).toBe(false);
      await flushTail();
      expect(tail.cancel, targetName).toHaveBeenCalledTimes(1);
    }
  });

  it("selected Delete guards input and textarea, but currently deletes from contenteditable and the button", async () => {
    mount();

    for (const targetName of ALL_TARGETS) {
      await selectRow();
      const tail = claimTail();
      const handled = targetName === "contenteditable" || targetName === "button";

      const event = press(target(targetName), "Delete");

      expect(event.defaultPrevented, targetName).toBe(handled);
      expect(readSeededAnnotations(queryClient).some((row) => row.id === SELECTED_ID), targetName)
        .toBe(!handled);
      expect(ownsToolTailAuthority(tail.token), targetName).toBe(!handled);
      if (handled) {
        await flushTail();
        expect(tail.cancel, targetName).toHaveBeenCalledTimes(1);
      } else {
        expect(tail.cancel, targetName).not.toHaveBeenCalled();
        discardRetainedTail(tail.token);
      }
    }
  });

  it("selected Enter guards input and textarea, but currently finishes a drag from contenteditable and the button", async () => {
    const session = dragSession();
    dragHarness.readActive.mockReturnValue(session);
    mount();
    await selectRow();

    for (const targetName of ALL_TARGETS) {
      dragHarness.finish.mockClear();
      const tail = claimTail();
      const handled = targetName === "contenteditable" || targetName === "button";

      const event = press(target(targetName), "Enter");

      expect(event.defaultPrevented, targetName).toBe(handled);
      expect(dragHarness.finish, targetName).toHaveBeenCalledTimes(handled ? 1 : 0);
      if (handled) expect(dragHarness.finish).toHaveBeenCalledWith(session, true);
      expect(ownsToolTailAuthority(tail.token), targetName).toBe(!handled);
      if (handled) {
        await flushTail();
        expect(tail.cancel, targetName).toHaveBeenCalledTimes(1);
      } else {
        expect(tail.cancel, targetName).not.toHaveBeenCalled();
        discardRetainedTail(tail.token);
      }
    }
  });

  it("split commitPending makes Escape a silent no-op and Enter a default-prevented no-op without invalidating", () => {
    const preview = {
      targetAnnotationId: 901,
      original: VERTICES,
      left: VERTICES,
      right: VERTICES,
      lineA: VERTICES[0],
      lineB: VERTICES[1],
      commitPending: true as const,
    };
    setToolState({ activeTool: { kind: "split" }, splitPreview: preview });
    mount();
    const tail = claimTail();

    const escape = press(target("button"), "Escape");
    expect(escape.defaultPrevented).toBe(false);
    expect(useToolStore.getState().splitPreview).toBe(preview);
    expect(ownsToolTailAuthority(tail.token)).toBe(true);

    const enter = press(target("button"), "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(useToolStore.getState().splitPreview).toBe(preview);
    expect(ownsToolTailAuthority(tail.token)).toBe(true);
    expect(tail.cancel).not.toHaveBeenCalled();
    discardRetainedTail(tail.token);
  });

  it.each([
    { label: "initial registration", churnWidth: false, expected: ["tool", "drag"] },
    { label: "tool-listener dependency churn", churnWidth: true, expected: ["drag", "tool"] },
  ])("simultaneous tool Enter + active drag fans out in $label order", async ({ churnWidth, expected }) => {
    setToolState({
      activeTool: { kind: "takeoffPlacement" },
      activeTakeoffItemId: ITEM_ID,
    });
    act(() => {
      seedAnnotations(queryClient, [selectedAnnotation()]);
      useUiStore.getState().setFocusAnnotationId(SELECTED_ID);
    });
    const rendered = mount();
    await waitFor(() => expect(useUiStore.getState().focusAnnotationId).toBeNull());
    if (churnWidth) rendered.rerender(<Fixture width={101} />);

    const session = dragSession();
    const trace: string[] = [];
    dragHarness.readActive.mockReturnValue(session);
    dragHarness.finish.mockImplementation(() => {
      trace.push("drag");
      return true;
    });
    setToolState({ polygonDrawingMode: "drawing", polygonVertices: VERTICES });
    const unsubscribe = useToolStore.subscribe((state, previous) => {
      if (previous.polygonDrawingMode === "drawing" && state.polygonDrawingMode === "idle") {
        trace.push("tool");
      }
    });
    const tail = claimTail();

    const event = press(target("button"), "Enter");
    unsubscribe();

    expect(event.defaultPrevented).toBe(true);
    expect(trace).toEqual(expected);
    expect(dragHarness.finish).toHaveBeenCalledOnce();
    expect(dragHarness.finish).toHaveBeenCalledWith(session, true);
    expect(readSeededAnnotations(queryClient).filter(
      (row) => (row.data as { type?: string } | null)?.type === "linear-polyline",
    )).toHaveLength(1);
    expect(ownsToolTailAuthority(tail.token)).toBe(false);
    await flushTail();
    expect(tail.cancel).toHaveBeenCalledTimes(1);
  });
});
