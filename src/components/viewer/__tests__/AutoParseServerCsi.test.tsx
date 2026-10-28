// @vitest-environment jsdom
// [table pipeline WP-3.I, K15] Classic Auto Parse keeps the route's CSI. `/api/table-parse` detects CSI with the
// company's CSI context (both legacy and engine legs); AutoParseTab used to drop it (`csiTags: []`), so the save ran
// the public `/api/csi/detect` with the builtin KB. The grid handed to the save now carries the route's codes (the
// union over every region of a merge, first occurrence kept); a response without codes still leaves the save's own
// detect as the fallback. All strings synthetic.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EMPTY_ACTIVE_PAGE_WINDOW, type ActivePageWindow } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useTableParseHintStore } from "@/stores/tableParseHintStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { acceptTableParseRegion, resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { DetectCsiAndPersist } from "../table-operation-types";
import AutoParseTab from "../AutoParseTab";

type Box = [number, number, number, number];
const PUBLIC_ID = "csi-k15-project";
const PAGE = 2;
const BOX: Box = [0.1, 0.1, 0.4, 0.4];
const BOX_2: Box = [0.1, 0.5, 0.4, 0.9];

let queryClient: QueryClient;
const fetchMock = vi.fn();
let responses: Record<string, unknown>[] = [];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  responses = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/table-parse") return json(responses.shift());
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  resetProjectData();
  useTableParseHintStore.setState({ hint: null });
  setViewerStoreStateForTest({ projectId: 41, publicId: PUBLIC_ID, isDemo: false, pageNumber: PAGE, tableParseTab: "auto", pageDrawingNumbers: {} });
  useViewerCoreStore.setState({ numPages: 10 });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  queryClient.setQueryData<ActivePageWindow>(queryKeys.pagesWindow.active(PUBLIC_ID), { ...EMPTY_ACTIVE_PAGE_WINDOW });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderAutoTab(detect: DetectCsiAndPersist) {
  render(
    <AutoParseTab
      autoDetectedTables={[]} existingParsed={[]} loadExistingParsed={vi.fn()} detectCsiAndPersist={detect}
      invalidateTableOperation={() => useParseFlowStore.getState().invalidateParseOperation("table")}
      yoloInTableRegion={[]} tagYoloClass={null} setTagYoloClass={vi.fn()} handleMapTags={vi.fn()} tagMappingDone={false}
      tagMappingCount={0} setTagMappingDone={vi.fn()} mapTagsStrictness="balanced" setMapTagsStrictness={vi.fn()}
      drawingNumberPrefixes={[]} setDrawingNumberPrefixes={vi.fn()} availablePrefixes={[]} lastDropCounts={null}
      cellStructureOperation={{ detect: vi.fn(async () => false), clear: vi.fn(), loadingKey: null, busy: false, errorKey: null, error: null }}
    />,
    { wrapper },
  );
}

const grid = (csiTags?: { code: string; description: string }[]) => ({
  headers: ["Mark", "Width"], rows: [{ Mark: "QX-1", Width: "10" }], methods: [], infraErrors: [], ...(csiTags ? { csiTags } : {}),
});

async function processAll(detect: ReturnType<typeof vi.fn<DetectCsiAndPersist>>) {
  await waitFor(() => expect(screen.getByRole("button", { name: /Process/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: /Process/ }));
  await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
}

describe("AutoParseTab keeps the route's company-context CSI (K15)", () => {
  it("one region: the saved grid carries the route's csiTags", async () => {
    const detect = vi.fn<DetectCsiAndPersist>(async () => true);
    renderAutoTab(detect);
    responses = [grid([{ code: "08 11 13", description: "QX openings" }])];
    act(() => acceptTableParseRegion([...BOX] as Box));
    await processAll(detect);
    expect(detect.mock.calls[0][0].csiTags).toEqual([{ code: "08 11 13", description: "QX openings" }]);
  });

  it("a two-region merge: the union of both regions' codes, the first occurrence of a code kept", async () => {
    const detect = vi.fn<DetectCsiAndPersist>(async () => true);
    renderAutoTab(detect);
    responses = [
      grid([{ code: "08 11 13", description: "QX openings" }]),
      grid([{ code: "08 11 13", description: "later copy" }, { code: "09 91 00", description: "QX finish" }]),
    ];
    act(() => acceptTableParseRegion([...BOX] as Box));
    act(() => acceptTableParseRegion([...BOX_2] as Box));
    await processAll(detect);
    expect(detect.mock.calls[0][0].csiTags).toEqual([
      { code: "08 11 13", description: "QX openings" },
      { code: "09 91 00", description: "QX finish" },
    ]);
  });

  it("no csiTags in the response (detect failed on the server): the grid carries none, so the save's own detect runs", async () => {
    const detect = vi.fn<DetectCsiAndPersist>(async () => true);
    renderAutoTab(detect);
    responses = [grid()];
    act(() => acceptTableParseRegion([...BOX] as Box));
    await processAll(detect);
    expect(detect.mock.calls[0][0].csiTags).toEqual([]);
  });
});
