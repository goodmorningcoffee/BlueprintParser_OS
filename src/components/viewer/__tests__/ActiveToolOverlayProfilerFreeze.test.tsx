// @vitest-environment jsdom

// [refactor jul13 P2.3 AT2] Sacred Overlay render-budget witnesses for the discriminator flip.

import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import {
  claimToolTailAuthority,
  invalidateToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { seedAnnotationGroups } from "@/test/seed-annotation-groups";
import { seedAnnotations } from "@/test/seed-annotations";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { ClientTakeoffItem } from "@/types";

vi.mock("../DrawingPreviewLayer", () => ({ default: () => null }));
vi.mock("../MarkupDialog", () => ({ default: () => null }));

import AnnotationOverlay from "../AnnotationOverlay";

const PUBLIC_ID = "active-tool-profiler";
let queryClient: QueryClient;

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

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 71,
    publicId: PUBLIC_ID,
    isDemo: true,
    pageNumber: 1,
    numPages: 2,
    mode: "pointer",
    activeTool: null,
    _drawing: false,
    _drawStart: { x: 0, y: 0 },
    _drawEnd: { x: 0, y: 0 },
  });
  seedAnnotations(queryClient, []);
  seedAnnotationGroups(queryClient, [], []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  queryClient.setQueryData(queryKeys.takeoff.items(PUBLIC_ID), []);
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
    loadedRange: { from: 1, to: 2 },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(noopContext());
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("AnnotationOverlay active-tool render budget", () => {
  it("ignores authority, operation, same-key, dormant-peer, and drawing-coordinate publications", async () => {
    let commits = 0;
    render(
      <Profiler id="active-tool-overlay" onRender={() => { commits += 1; }}>
        <AnnotationOverlay width={100} height={100} cssScale={1} />
      </Profiler>,
      { wrapper },
    );
    await act(async () => Promise.resolve());
    const mounted = commits;

    act(() => {
      const token = claimToolTailAuthority({});
      expect(token).toBeTruthy();
      invalidateToolTailAuthority();
    });
    expect(commits).toBe(mounted);

    act(() => {
      const started = useParseFlowStore.getState().beginParseOperation("table");
      expect(started.status).toBe("started");
      if (started.status === "started") {
        expect(useParseFlowStore.getState().finishParseOperation(started.token)).toBe(true);
      }
    });
    expect(commits).toBe(mounted);

    act(() => useToolStore.getState().setSymbolSearchActive(true));
    expect(commits).toBe(mounted + 1);
    const firstSymbolActivation = useToolStore.getState().activeTool;
    expect(firstSymbolActivation).toEqual({ kind: "symbolTemplate" });
    const symbolBaseline = commits;
    act(() => useToolStore.getState().setSymbolSearchActive(true));
    expect(commits).toBe(symbolBaseline);
    const renewedSymbolActivation = useToolStore.getState().activeTool;
    expect(renewedSymbolActivation).toEqual({ kind: "symbolTemplate" });
    expect(renewedSymbolActivation).not.toBe(firstSymbolActivation);

    act(() => useToolStore.setState({
      polygonDrawingMode: "drawing",
      bucketFillLoading: true,
      bucketFillBarrierMode: true,
    }));
    expect(commits).toBe(symbolBaseline);

    act(() => useParseFlowStore.setState({
      keynoteParseStep: "define-column",
      keynoteColumnBBs: [[0.1, 0.2, 0.3, 0.4]],
      specParseRegion: [0.2, 0.3, 0.8, 0.9],
    }));
    expect(commits).toBe(symbolBaseline);

    act(() => useToolStore.setState({ _drawEnd: { x: 77, y: 88 } }));
    expect(commits).toBe(symbolBaseline);

    act(() => useToolStore.getState().setTagAddingMode("tag-A"));
    expect(commits).toBe(symbolBaseline + 1);
    const firstTagActivation = useToolStore.getState().activeTool;
    expect(firstTagActivation).toEqual({ kind: "tagAdd", tagId: "tag-A" });
    const tagBaseline = commits;
    act(() => useToolStore.getState().setTagAddingMode("tag-B"));
    expect(commits).toBe(tagBaseline);
    const renewedTagActivation = useToolStore.getState().activeTool;
    expect(renewedTagActivation).toEqual({ kind: "tagAdd", tagId: "tag-B" });
    expect(renewedTagActivation).not.toBe(firstTagActivation);
  });

  it("keeps dormant polygon and linear takeoff drafts out while Bucket owns the canvas", async () => {
    queryClient.setQueryData(queryKeys.takeoff.items(PUBLIC_ID), [
      takeoffItem({ id: 41, name: "Dormant Area", shape: "polygon" }),
      takeoffItem({ id: 42, name: "Dormant Linear", shape: "linear" }),
    ]);

    let commits = 0;
    render(
      <Profiler id="active-tool-overlay-bucket" onRender={() => { commits += 1; }}>
        <AnnotationOverlay width={100} height={100} cssScale={1} />
      </Profiler>,
      { wrapper },
    );
    await act(async () => Promise.resolve());

    act(() => useToolStore.getState().setBucketFillActive(true));
    expect(useToolStore.getState().activeTool).toEqual({ kind: "bucketFill" });

    // Establish each dormant takeoff item separately because activeTakeoffItemId is still a
    // legitimate AnnotationOverlay input while Bucket assigns its eventual result.
    act(() => useToolStore.setState({
      activeTakeoffItemId: 41,
      polygonDrawingMode: "idle",
      polygonVertices: [],
    }));
    const polygonBaseline = commits;
    act(() => useToolStore.setState({
      polygonDrawingMode: "drawing",
      polygonVertices: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
    }));
    expect(commits).toBe(polygonBaseline);

    act(() => useToolStore.setState({
      activeTakeoffItemId: 42,
      polygonDrawingMode: "idle",
      polygonVertices: [],
    }));
    const linearBaseline = commits;
    act(() => useToolStore.setState({
      polygonDrawingMode: "drawing",
      polygonVertices: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.8 },
      ],
    }));
    expect(commits).toBe(linearBaseline);
    expect(useToolStore.getState().activeTool).toEqual({ kind: "bucketFill" });
  });

  it("keeps Keynote, Notes, and Spec peer-flow publications out while Table owns the canvas", async () => {
    let commits = 0;
    render(
      <Profiler id="active-tool-overlay-table" onRender={() => { commits += 1; }}>
        <AnnotationOverlay width={100} height={100} cssScale={1} />
      </Profiler>,
      { wrapper },
    );
    await act(async () => Promise.resolve());

    act(() => {
      useToolStore.setState({ activeTool: { kind: "parseRect", flow: "table" } });
      useParseFlowStore.setState({ tableParseStep: "select-region" });
    });
    expect(useToolStore.getState().activeTool).toEqual({ kind: "parseRect", flow: "table" });
    const tableBaseline = commits;

    act(() => useParseFlowStore.setState({
      keynoteParseStep: "define-column",
      keynoteParseRegion: [0.1, 0.1, 0.4, 0.4],
      keynoteColumnBBs: [[0.1, 0.1, 0.2, 0.4]],
      notesParseStep: "define-column",
      notesParseRegion: [0.2, 0.2, 0.5, 0.5],
      specParseStep: "select-region",
      specParseRegion: [0.3, 0.3, 0.6, 0.6],
    }));
    expect(commits).toBe(tableBaseline);
  });
});
