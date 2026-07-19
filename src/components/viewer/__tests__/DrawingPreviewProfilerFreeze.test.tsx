// @vitest-environment jsdom

// [refactor jul13 P2.3 AT2] DrawingPreviewLayer exact primitive render-budget witnesses.

import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import {
  claimToolTailAuthority,
  invalidateToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientTakeoffItem } from "@/types";
import DrawingPreviewLayer from "../DrawingPreviewLayer";

const PUBLIC_ID = "drawing-preview-profiler";
let queryClient: QueryClient;
let clearRect: ReturnType<typeof vi.fn>;
let fillText: ReturnType<typeof vi.fn>;

function takeoffItem(
  over: Partial<ClientTakeoffItem> & { id: number; name: string },
): ClientTakeoffItem {
  return {
    shape: "circle",
    color: "#ef4444",
    size: 10,
    sortOrder: 0,
    groupId: null,
    ...over,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function noopContext(): CanvasRenderingContext2D {
  const target = { clearRect, fillText, measureText: () => ({ width: 0 }) };
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
  fillText = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("DrawingPreviewLayer active-tool render budget", () => {
  it("renders an owned pending Split as non-cancelable disabled work", () => {
    const readyPreview = {
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
    };
    act(() => useToolStore.setState({
      activeTool: { kind: "split" },
      splitLineA: readyPreview.lineA,
      splitLineB: readyPreview.lineB,
      splitPreview: {
        ...readyPreview,
        commitPending: true,
      },
    }));

    const view = render(
      <DrawingPreviewLayer width={100} height={100} cssScale={1} />,
      { wrapper },
    );

    const split = view.getByRole("button", { name: "Splitting…" });
    const cancel = view.getByRole("button", { name: "Cancel" });
    expect((split as HTMLButtonElement).disabled).toBe(true);
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
  });

  it("makes a ready Split button closure inert after a same-kind activation successor", () => {
    const readyPreview = {
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
    };
    act(() => useToolStore.setState({
      activeTool: { kind: "split" },
      splitLineA: readyPreview.lineA,
      splitLineB: readyPreview.lineB,
      splitPreview: readyPreview,
    }));
    const renderedActivation = useToolStore.getState().activeTool;
    const view = render(
      <DrawingPreviewLayer width={100} height={100} cssScale={1} />,
      { wrapper },
    );
    const split = view.getByRole("button", { name: "Split" });
    const cancel = view.getByRole("button", { name: "Cancel" });
    const dispatch = vi.spyOn(window, "dispatchEvent");

    act(() => useToolStore.setState({ activeTool: { kind: "split" } }));
    expect(useToolStore.getState().activeTool).not.toBe(renderedActivation);
    fireEvent.click(cancel);
    fireEvent.click(split);

    expect(useToolStore.getState().splitPreview).toBe(readyPreview);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("makes ready Split buttons inert when either endpoint no longer owns the preview", () => {
    const readyPreview = {
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
    };
    act(() => useToolStore.setState({
      activeTool: { kind: "split" },
      splitLineA: readyPreview.lineA,
      splitLineB: readyPreview.lineB,
      splitPreview: readyPreview,
    }));
    const view = render(
      <DrawingPreviewLayer width={100} height={100} cssScale={1} />,
      { wrapper },
    );
    const dispatch = vi.spyOn(window, "dispatchEvent");

    act(() => useToolStore.setState({ splitLineB: { x: 0.6, y: 0.9 } }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    fireEvent.click(view.getByRole("button", { name: "Split" }));

    expect(useToolStore.getState().splitPreview).toBe(readyPreview);
    expect(useToolStore.getState().splitLineB).not.toBe(readyPreview.lineB);
    expect(dispatch).not.toHaveBeenCalled();
  });

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

    act(() => useToolStore.setState({ _drawEnd: { x: 55, y: 66 } }));
    expect(commits).toBe(symbolBaseline + 1);
    expect(clearRect).toHaveBeenCalledTimes(dormantCanvasBaseline + 1);
  });

  it("keeps dormant polygon and linear takeoff drafts commit- and ghost-free under Bucket", async () => {
    queryClient.setQueryData(queryKeys.takeoff.items(PUBLIC_ID), [
      takeoffItem({ id: 51, name: "Dormant Area", shape: "polygon" }),
      takeoffItem({ id: 52, name: "Dormant Linear", shape: "linear" }),
    ]);

    let commits = 0;
    render(
      <Profiler id="drawing-preview-bucket" onRender={() => { commits += 1; }}>
        <DrawingPreviewLayer width={100} height={100} cssScale={1} />
      </Profiler>,
      { wrapper },
    );
    await act(async () => Promise.resolve());

    act(() => useToolStore.getState().setBucketFillActive(true));
    expect(useToolStore.getState().activeTool).toEqual({ kind: "bucketFill" });

    act(() => useToolStore.setState({
      activeTakeoffItemId: 51,
      polygonDrawingMode: "idle",
      polygonVertices: [],
    }));
    const polygonCommitBaseline = commits;
    const polygonCanvasBaseline = clearRect.mock.calls.length;
    const polygonTextBaseline = fillText.mock.calls.length;
    act(() => useToolStore.setState({
      polygonDrawingMode: "drawing",
      polygonVertices: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
    }));
    expect(commits).toBe(polygonCommitBaseline);
    expect(clearRect).toHaveBeenCalledTimes(polygonCanvasBaseline);
    expect(fillText).toHaveBeenCalledTimes(polygonTextBaseline);
    expect(fillText).not.toHaveBeenCalledWith(
      "Click first point or Enter to close",
      expect.anything(),
      expect.anything(),
    );

    act(() => useToolStore.setState({
      activeTakeoffItemId: 52,
      polygonDrawingMode: "idle",
      polygonVertices: [],
    }));
    const linearCommitBaseline = commits;
    const linearCanvasBaseline = clearRect.mock.calls.length;
    const linearTextBaseline = fillText.mock.calls.length;
    act(() => useToolStore.setState({
      polygonDrawingMode: "drawing",
      polygonVertices: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.8 },
      ],
    }));
    expect(commits).toBe(linearCommitBaseline);
    expect(clearRect).toHaveBeenCalledTimes(linearCanvasBaseline);
    expect(fillText).toHaveBeenCalledTimes(linearTextBaseline);
    expect(fillText).not.toHaveBeenCalledWith(
      "Double-click or Enter to finish",
      expect.anything(),
      expect.anything(),
    );
    expect(useToolStore.getState().activeTool).toEqual({ kind: "bucketFill" });
  });

  it("keeps Keynote, Notes, and Spec peer-flow publications commit- and ghost-free under Table", async () => {
    let commits = 0;
    render(
      <Profiler id="drawing-preview-table" onRender={() => { commits += 1; }}>
        <DrawingPreviewLayer width={100} height={100} cssScale={1} />
      </Profiler>,
      { wrapper },
    );
    await act(async () => Promise.resolve());

    act(() => {
      useToolStore.setState({
        _drawing: true,
        _drawStart: { x: 10, y: 20 },
        _drawEnd: { x: 70, y: 80 },
      });
      useToolStore.setState({ activeTool: { kind: "parseRect", flow: "table" } });
      useParseFlowStore.setState({ tableParseStep: "select-region" });
    });
    expect(useToolStore.getState().activeTool).toEqual({ kind: "parseRect", flow: "table" });
    expect(fillText).toHaveBeenCalledWith("Table Region", expect.anything(), expect.anything());
    const tableCommitBaseline = commits;
    const tableCanvasBaseline = clearRect.mock.calls.length;
    const tableTextBaseline = fillText.mock.calls.length;

    act(() => useParseFlowStore.setState({
      keynoteParseStep: "define-column",
      keynoteParseRegion: [0.1, 0.1, 0.4, 0.4],
      notesParseStep: "define-column",
      notesParseRegion: [0.2, 0.2, 0.5, 0.5],
      specParseStep: "select-region",
      specParseRegion: [0.3, 0.3, 0.6, 0.6],
    }));
    expect(commits).toBe(tableCommitBaseline);
    expect(clearRect).toHaveBeenCalledTimes(tableCanvasBaseline);
    expect(fillText).toHaveBeenCalledTimes(tableTextBaseline);
    expect(fillText).not.toHaveBeenCalledWith("Column", expect.anything(), expect.anything());
    expect(fillText).not.toHaveBeenCalledWith("Notes Column", expect.anything(), expect.anything());
    expect(fillText).not.toHaveBeenCalledWith("Spec Region", expect.anything(), expect.anything());
  });
});
