// @vitest-environment jsdom

// [refactor jul13 P2.3 AT2] DrawingPreviewLayer exact primitive render-budget witnesses.

import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import {
  claimToolTailAuthority,
  invalidateToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useViewerStore } from "@/stores/viewerStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import DrawingPreviewLayer from "../DrawingPreviewLayer";

const PUBLIC_ID = "drawing-preview-profiler";
let queryClient: QueryClient;
let clearRect: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function noopContext(): CanvasRenderingContext2D {
  const target = { clearRect, measureText: () => ({ width: 0 }) };
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

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 72,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: 1,
    numPages: 1,
    mode: "pointer",
    activeTool: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
    _mousePos: null,
  });
  queryClient.setQueryData(queryKeys.takeoff.items(PUBLIC_ID), []);
  clearRect = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("DrawingPreviewLayer active-tool render budget", () => {
  it("ignores authority, operation, same-key, and dormant peers; draws one coordinate commit", async () => {
    let commits = 0;
    const view = render(
      <Profiler id="drawing-preview" onRender={() => { commits += 1; }}>
        <DrawingPreviewLayer width={100} height={100} cssScale={1} />
      </Profiler>,
      { wrapper },
    );
    await act(async () => Promise.resolve());
    const mounted = commits;

    act(() => {
      claimToolTailAuthority({});
      invalidateToolTailAuthority();
      const started = useParseFlowStore.getState().beginParseOperation("notes");
      if (started.status === "started") {
        useParseFlowStore.getState().finishParseOperation(started.token);
      }
    });
    expect(commits).toBe(mounted);

    act(() => useToolStore.getState().setSymbolSearchActive(true));
    expect(commits).toBe(mounted + 1);
    const symbolBaseline = commits;
    const firstSymbolActivation = useToolStore.getState().activeTool;
    act(() => useToolStore.getState().setSymbolSearchActive(true));
    const renewedSymbolActivation = useToolStore.getState().activeTool;
    expect(renewedSymbolActivation).not.toBe(firstSymbolActivation);
    expect(renewedSymbolActivation).toEqual({ kind: "symbolTemplate" });
    expect(commits).toBe(symbolBaseline);

    act(() => useParseFlowStore.setState({
      tableParseStep: "define-row",
      keynoteParseStep: "define-column",
      notesParseStep: "select-region",
      specParseStep: "select-region",
    }));
    expect(commits).toBe(symbolBaseline);

    const dormantCanvasBaseline = clearRect.mock.calls.length;
    act(() => useToolStore.setState({
      calibrationMode: "point2",
      calibrationPoints: {
        p1: { x: 0.1, y: 0.2 },
        p2: { x: 0.3, y: 0.4 },
      },
    }));
    expect(commits).toBe(symbolBaseline);
    expect(clearRect).toHaveBeenCalledTimes(dormantCanvasBaseline);

    act(() => useToolStore.setState({
      polygonDrawingMode: "drawing",
      polygonVertices: [{ x: 0.2, y: 0.3 }],
      activeTakeoffItemId: 55,
    }));
    expect(commits).toBe(symbolBaseline);
    expect(clearRect).toHaveBeenCalledTimes(dormantCanvasBaseline);

    act(() => useToolStore.setState({
      bucketFillPreview: {
        vertices: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.4, y: 0.4 },
        ],
        method: "dormant",
      },
      bucketFillLoading: true,
      bucketFillError: "dormant bucket error",
      bucketFillBarriers: [{ x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }],
      bucketFillBarrierMode: true,
      barrierPendingPoint: { x: 0.5, y: 0.6 },
      bucketFillPendingPolygon: {
        vertices: [
          { x: 0.1, y: 0.1 },
          { x: 0.4, y: 0.1 },
          { x: 0.4, y: 0.4 },
        ],
        method: "dormant",
        bbox: [0.1, 0.1, 0.4, 0.4],
        areaSqUnits: 9,
        unit: "sf",
      },
    }));
    expect(commits).toBe(symbolBaseline);
    expect(clearRect).toHaveBeenCalledTimes(dormantCanvasBaseline);

    act(() => useToolStore.setState({
      splitLineA: { x: 0.1, y: 0.2 },
      splitLineB: { x: 0.7, y: 0.8 },
      splitPreview: {
        targetAnnotationId: 44,
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
      },
      splitError: "dormant split error",
    }));
    expect(commits).toBe(symbolBaseline);
    expect(clearRect).toHaveBeenCalledTimes(dormantCanvasBaseline);
    expect(view.queryByText("dormant bucket error")).toBeNull();
    expect(view.queryByText("dormant split error")).toBeNull();
    expect(view.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(view.queryByRole("button", { name: "Split" })).toBeNull();

    act(() => useViewerStore.setState({ _drawEnd: { x: 55, y: 66 } }));
    expect(commits).toBe(symbolBaseline + 1);
    expect(clearRect).toHaveBeenCalledTimes(dormantCanvasBaseline + 1);
  });
});
