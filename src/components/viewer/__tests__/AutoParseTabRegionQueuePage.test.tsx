// @vitest-environment jsdom
// [classifier track 1 fix] The Auto region queue is page-scoped: /api/table-parse reads every region
// from the page it is sent with, so a box queued on another page must never be parsed here.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useTableParseHintStore } from "@/stores/tableParseHintStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { acceptTableParseRegion, navigateViewerPage, resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { DetectCsiAndPersist } from "../table-operation-types";
import AutoParseTab from "../AutoParseTab";

type Box = [number, number, number, number];
const ON_P3: Box = [0.1, 0.1, 0.4, 0.4];
const ON_P7: Box = [0.5, 0.5, 0.9, 0.9];

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderTab() {
  render(
    <AutoParseTab
      autoDetectedTables={[]}
      existingParsed={[]}
      loadExistingParsed={vi.fn()}
      detectCsiAndPersist={vi.fn<DetectCsiAndPersist>(async () => true)}
      invalidateTableOperation={() => useParseFlowStore.getState().invalidateParseOperation("table")}
      yoloInTableRegion={[]}
      tagYoloClass={null}
      setTagYoloClass={vi.fn()}
      handleMapTags={vi.fn()}
      tagMappingDone={false}
      tagMappingCount={0}
      setTagMappingDone={vi.fn()}
      mapTagsStrictness="balanced"
      setMapTagsStrictness={vi.fn()}
      drawingNumberPrefixes={[]}
      setDrawingNumberPrefixes={vi.fn()}
      availablePrefixes={[]}
      lastDropCounts={null}
      cellStructureOperation={{
        detect: vi.fn(async () => false),
        clear: vi.fn(),
        loadingKey: null,
        busy: false,
        errorKey: null,
        error: null,
      }}
    />,
    { wrapper },
  );
}

const regionRows = () => screen.queryAllByText(/%\) → \(/);

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ headers: [], rows: [], methods: [], methodResults: [], infraErrors: [] }),
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: "queue-project",
    isDemo: false,
    pageNumber: 3,
    tableParseTab: "auto",
  });
  useViewerCoreStore.setState({ numPages: 10 });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Auto region queue is page-scoped", () => {
  it("a box queued on p3 is neither shown nor parsed after jumping to p7 and queueing there", async () => {
    renderTab();
    act(() => acceptTableParseRegion([...ON_P3] as Box));
    await waitFor(() => expect(regionRows()).toHaveLength(1));

    // Same sequence as the Proposed tables "Parse this table" click: navigate, then accept.
    act(() => {
      navigateViewerPage(7);
      acceptTableParseRegion([...ON_P7] as Box);
    });
    await waitFor(() => expect(regionRows()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Process Region" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.pageNumber).toBe(7);
    expect(body.regionBbox).toEqual(ON_P7);
  });

  it("navigating away hides the queue without re-adding the stale region", async () => {
    renderTab();
    act(() => acceptTableParseRegion([...ON_P3] as Box));
    await waitFor(() => expect(regionRows()).toHaveLength(1));
    act(() => navigateViewerPage(7));
    await waitFor(() => expect(regionRows()).toHaveLength(0));
    expect(screen.queryByRole("button", { name: "Process Region" })).toBeNull();
  });

  it("[shape-tags fix round] a parse hint for THIS project's region rides in the request body once, then is consumed", async () => {
    renderTab();
    act(() => acceptTableParseRegion([...ON_P3] as Box));
    await waitFor(() => expect(regionRows()).toHaveLength(1));
    // another project's hint on the same page number is not ours
    useTableParseHintStore.setState({ hint: { publicId: "other-project", pageNumber: 3, bbox: [...ON_P3] as Box, rowSource: "shape-centres" } });
    fireEvent.click(screen.getByRole("button", { name: "Process Region" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect("rowSource" in JSON.parse(fetchMock.mock.calls[0][1].body as string)).toBe(false);
    expect(useTableParseHintStore.getState().hint).not.toBeNull();
    // ours: sent, and cleared by that request
    useTableParseHintStore.setState({ hint: { publicId: "queue-project", pageNumber: 3, bbox: [...ON_P3] as Box, rowSource: "shape-centres" } });
    act(() => acceptTableParseRegion([...ON_P3] as Box));
    await waitFor(() => expect(regionRows()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Process Region" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Process Region" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject({ pageNumber: 3, regionBbox: ON_P3, rowSource: "shape-centres" });
    expect(useTableParseHintStore.getState().hint).toBeNull();
    act(() => acceptTableParseRegion([...ON_P3] as Box));
    await waitFor(() => expect(regionRows()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Process Region" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Process Region" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect("rowSource" in JSON.parse(fetchMock.mock.calls[2][1].body as string)).toBe(false);
  });

  it("re-queues the same box after removal, and never duplicates it", async () => {
    renderTab();
    act(() => acceptTableParseRegion([...ON_P3] as Box));
    await waitFor(() => expect(regionRows()).toHaveLength(1));
    act(() => acceptTableParseRegion([...ON_P3] as Box));
    expect(regionRows()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "×" }));
    await waitFor(() => expect(regionRows()).toHaveLength(0));
    act(() => acceptTableParseRegion([...ON_P3] as Box));
    await waitFor(() => expect(regionRows()).toHaveLength(1));
  });
});
