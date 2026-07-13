// @vitest-environment jsdom
// [refactor jul12 P2.4 A2b] Table cell-structure page A/B authority witness.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import TableParsePanel from "@/components/viewer/TableParsePanel";
import ParsedTableItem from "@/components/viewer/ParsedTableItem";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { navigateViewerPage, resetProjectData } from "@/stores/viewerCommands";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
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

const SEEDED_STRUCTURE = {
  cells: [{
    bbox: BBOX,
    row: 0,
    col: 0,
    rowSpan: 1,
    colSpan: 1,
    type: "body",
    confidence: 0.9,
    text: "D1",
    highlighted: false,
  }],
  pageNumber: 1,
  regionBbox: BBOX,
};

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
  it("routes an off-page retained row through the shared controller with its stored target", () => {
    const detect = vi.fn().mockResolvedValue(true);
    const clear = vi.fn();
    render(<ParsedTableItem
      table={{
        pageNum: 2,
        region: {
          id: "retained-region-2",
          bbox: BBOX,
          data: { headers: ["Tag"], rows: [{ Tag: "D2" }], tagColumn: "Tag" },
        },
        name: "Retained Schedule",
        category: "schedule",
        rowCount: 1,
        colCount: 1,
        csiTags: [],
      }}
      pageNames={{ 2: "A-202" }}
      isCurrentPage={false}
      onNavigate={vi.fn()}
      yoloTags={[]}
      pageNumber={1}
      publicId={PUBLIC_ID}
      isDemo={false}
      cellStructureOperation={{
        detect,
        clear,
        loadingKey: null,
        busy: false,
        errorKey: null,
        error: null,
      }}
    />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "▶" }));
    fireEvent.click(screen.getByRole("button", { name: "Detect Cells" }));

    expect(useViewerCoreStore.getState().pageNumber).toBe(2);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledWith({
      projectId: PUBLIC_ID,
      pageNumber: 2,
      regionBbox: BBOX,
    }, "retained:2:retained-region-2");
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears structure, hides its overlay, and invalidates Table in one publication", async () => {
    useParseFlowStore.setState({
      tableParseStep: "review",
      tableParseRegion: BBOX,
      tableParsedGrid: {
        headers: ["Tag"],
        rows: [{ Tag: "D1" }],
        tagColumn: "Tag",
      },
      tableCellStructure: SEEDED_STRUCTURE,
      showTableCellStructure: true,
    });
    render(<TableParsePanel />, { wrapper });

    const before = useParseFlowStore.getState();
    const publications: typeof before[] = [];
    const unsubscribe = useParseFlowStore.subscribe((state) => publications.push(state));
    const clear = await screen.findByRole("button", { name: /Cell Structure \(1 cells\)/ });

    act(() => { (clear as HTMLButtonElement).click(); });

    expect(publications).toHaveLength(1);
    expect(publications[0].tableCellStructure).toBeNull();
    expect(publications[0].showTableCellStructure).toBe(false);
    expect(publications[0].parseOperations.table).toEqual({
      revision: before.parseOperations.table.revision + 1,
      busy: false,
    });
    expect(publications[0].parseOperations.keynote).toBe(before.parseOperations.keynote);
    expect(publications[0].parseOperations.notes).toBe(before.parseOperations.notes);
    expect(publications[0].parseOperations.spec).toBe(before.parseOperations.spec);
    unsubscribe();
  });

  it("releases current loading/busy and reports a synchronous transport throw after admission", async () => {
    fetchMock.mockImplementationOnce(() => {
      throw new Error("synchronous cell-structure failure");
    });
    render(<TableParsePanel />, { wrapper });

    // The region was already captured by Auto's passive proposal effect. Enter review with that
    // same crop; the throw happens synchronously inside fetch, after begin + local admission.
    act(() => useParseFlowStore.setState({
      tableParseStep: "review",
      tableParseRegion: BBOX,
      tableParsedGrid: {
        headers: ["Tag"],
        rows: [{ Tag: "D1" }],
        tagColumn: "Tag",
      },
    }));
    const detect = await screen.findByRole("button", { name: "Detect Cell Structure" });
    act(() => { (detect as HTMLButtonElement).click(); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText("synchronous cell-structure failure")).toBeInTheDocument();
      expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
      expect(screen.getByRole("button", { name: "Detect Cell Structure" })).toBeEnabled();
    });
    expect(useParseFlowStore.getState().tableCellStructure).toBeNull();
  }, 15_000);

  it("suppresses page-A completion/finally while page-B remains current", async () => {
    render(<TableParsePanel />, { wrapper });

    // Auto already captured the seeded region as its proposal. Enter review with that same crop.
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

    act(() => navigateViewerPage(2));
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false));
    // Full page navigation intentionally clears the review workspace. Seed page B's own review
    // crop before admitting B, instead of relying on the old raw-page-write retention behavior.
    act(() => useParseFlowStore.setState({
      tableParseStep: "review",
      tableParseRegion: BBOX,
      tableParsedGrid: {
        headers: ["Tag"],
        rows: [{ Tag: "D2" }],
        tagColumn: "Tag",
      },
    }));
    const detectB = await screen.findByRole("button", { name: "Detect Cell Structure" });
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
