// @vitest-environment jsdom
// [refactor jul12 P2.4 A2b] Table cell-structure page A/B authority witness.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import TableParsePanel from "@/components/viewer/TableParsePanel";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PUBLIC_ID = "cell-operation-project";
const BBOX = [0.1, 0.2, 0.8, 0.7] as [number, number, number, number];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function structureResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      cells: [{
        bbox: BBOX,
        row: 0,
        col: 0,
        rowSpan: 1,
        colSpan: 1,
        type: "body",
        confidence: 0.9,
        text,
      }],
    }),
  } as unknown as Response;
}

let queryClient: QueryClient;
let pending: Array<{ init: RequestInit; response: Deferred<Response> }>;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pending = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    if (url !== "/api/table-structure") {
      throw new Error(`unexpected cell-structure request: ${String(url)}`);
    }
    const response = deferred<Response>();
    pending.push({ init: init ?? {}, response });
    return response.promise;
  });
  vi.stubGlobal("fetch", fetchMock);

  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: 1,
    numPages: 2,
    pageDrawingNumbers: {},
    tableParseTab: "auto",
    tableParseStep: "idle",
    tableParseRegion: BBOX,
  });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
  });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2b Table cell-structure operation authority", () => {
  it("suppresses page-A completion/finally while page-B remains current", async () => {
    render(<TableParsePanel />, { wrapper });

    // Prime Auto's drawn-region identity, then enter review with that same region so its legacy
    // multi-BB capture effect retains the review crop instead of treating it as a new drawing.
    await waitFor(() => expect(useParseFlowStore.getState().tableParseRegion).toBeNull());
    act(() => useParseFlowStore.setState({
      tableParseStep: "review",
      tableParseRegion: BBOX,
      tableParsedGrid: {
        headers: ["Tag"],
        rows: [{ Tag: "D1" }],
        tagColumn: "Tag",
      },
    }));
    const detectA = await screen.findByRole("button", { name: "Detect Cell Structure" });
    act(() => { (detectA as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(1);
    expect(JSON.parse(String(pending[0].init.body))).toMatchObject({ pageNumber: 1 });

    act(() => useViewerCoreStore.getState().setPage(2));
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false));
    const detectB = screen.getByRole("button", { name: "Detect Cell Structure" });
    act(() => { (detectB as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(2);
    expect(JSON.parse(String(pending[1].init.body))).toMatchObject({ pageNumber: 2 });
    const tokenB = { ...useParseFlowStore.getState().parseOperations.table };

    await act(async () => {
      pending[0].response.resolve(structureResponse("stale-A"));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().tableCellStructure).toBeNull();
    expect(useParseFlowStore.getState().parseOperations.table).toEqual(tokenB);
    expect(screen.getByRole("button", { name: "Detecting..." })).toBeDisabled();

    await act(async () => {
      pending[1].response.resolve(structureResponse("current-B"));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().tableCellStructure).toMatchObject({
      pageNumber: 2,
      regionBbox: BBOX,
      cells: [{ text: "current-B", highlighted: false }],
    });
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
  });
});
