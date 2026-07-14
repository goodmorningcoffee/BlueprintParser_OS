// @vitest-environment jsdom
// [refactor jul12 P2.4 A2b] Real review-save/inherited-persistence operation witnesses.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import TableParsePanel from "@/components/viewer/TableParsePanel";
import { commitParseOperation } from "@/hooks/useParseOperation";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import {
  clearYoloTagsProject,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useUiStore } from "@/stores/uiStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PUBLIC_ID = "table-operation-project";
const PAGE = 4;
const BBOX = [0.1, 0.2, 0.8, 0.7] as [number, number, number, number];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function successResponse(marker: string): Response {
  const parsedRegion = {
    id: `promoted-${marker}`,
    type: "schedule",
    category: `${marker} Schedule`,
    bbox: BBOX,
    confidence: 1,
    csiTags: [{ code: "08 10 00", description: "Doors" }],
    data: {
      headers: ["Tag", "Description"],
      rows: [{ Tag: marker, Description: `${marker} door` }],
      tagColumn: "Tag",
      tableName: `${marker} Schedule`,
      rowCount: 1,
      columnCount: 2,
    },
    source: "user",
  };
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ok: true,
      parsedRegion,
      updatedIntelligence: {
        rejectedTextRegionIds: [marker],
        parsedRegions: [parsedRegion],
      },
      summaries: null,
    }),
  } as unknown as Response;
}

function failureResponse(message: string): Response {
  return {
    ok: false,
    status: 500,
    json: vi.fn().mockResolvedValue({ error: { code: "FAIL", message } }),
  } as unknown as Response;
}

function grid(label: string) {
  return {
    headers: ["Tag", "Description"],
    rows: [{ Tag: label, Description: `${label} door` }],
    tagColumn: "Tag",
    tableName: `${label} Schedule`,
    // Skip best-effort CSI so each root has exactly one deferred persistence request.
    csiTags: [{ code: "08 10 00", description: "Doors" }],
  };
}

let queryClient: QueryClient;
let pending: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedReview(label: string): void {
  useParseFlowStore.setState({
    tableParseTab: "auto",
    tableParseStep: "review",
    tableParseRegion: BBOX,
    tableParsedGrid: grid(label),
  });
}

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pending = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/regions/promote") {
      throw new Error(`unexpected Table operation request: ${String(url)}`);
    }
    const request = deferred<Response>();
    pending.push(request);
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);

  resetProjectData();
  // [refactor jul14 P2.5] This presentation preference intentionally survives a project reset.
  // Establish the modal's closed starting state explicitly so later toggle assertions are isolated.
  useUiStore.setState({ showTableCompareModal: false });
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    numPages: PAGE,
    pageDrawingNumbers: {},
  });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
  });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  seedReview("A");
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2b Table review save operation authority", () => {
  it("admits one same-turn Save root and reuses that one token in the nested save", () => {
    const beforeRevision = useParseFlowStore.getState().parseOperations.table.revision;
    render(<TableParsePanel />, { wrapper });
    const save = screen.getByRole("button", { name: "Save" });

    act(() => {
      (save as HTMLButtonElement).click();
      (save as HTMLButtonElement).click();
    });

    expect(pending).toHaveLength(1);
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: beforeRevision + 1,
      busy: true,
    });
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("A");
  });

  it("lets captured A persistence settle without resetting pending B, then only B resets", async () => {
    render(<TableParsePanel />, { wrapper });
    act(() => { (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(1);
    const tokenA = { ...useParseFlowStore.getState().parseOperations.table };

    act(() => {
      useParseFlowStore.getState().resetTableParse();
      seedReview("B");
    });
    const saveB = await screen.findByRole("button", { name: "Save" });
    act(() => { (saveB as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(2);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.table };
    expect(tokenB.revision).toBeGreaterThan(tokenA.revision);
    expect(tokenB.busy).toBe(true);

    await act(async () => {
      pending[0].resolve(successResponse("server-A"));
      await flushCompletion();
    });

    expect(useParseFlowStore.getState().parseOperations.table).toEqual(tokenB);
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("B");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await act(async () => {
      pending[1].resolve(successResponse("server-B"));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" }))
      .not.toBeInTheDocument());
    expect(useParseFlowStore.getState().tableParseStep).toBe("idle");
    expect(useParseFlowStore.getState().tableParsedGrid).toBeNull();
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
  });

  it("suppresses stale A failure while B remains current and busy", async () => {
    render(<TableParsePanel />, { wrapper });
    act(() => { (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(1);

    act(() => {
      useParseFlowStore.getState().resetTableParse();
      seedReview("B");
    });
    const saveB = await screen.findByRole("button", { name: "Save" });
    act(() => { (saveB as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(2);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.table };

    await act(async () => {
      pending[0].resolve(failureResponse("stale A boom"));
      await flushCompletion();
    });
    expect(screen.queryByText("stale A boom")).not.toBeInTheDocument();
    expect(useParseFlowStore.getState().parseOperations.table).toEqual(tokenB);
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("B");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await act(async () => {
      pending[1].resolve(successResponse("server-B"));
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false));
  });

  it("retains current failure UI, releases busy, and admits a successful retry", async () => {
    render(<TableParsePanel />, { wrapper });
    act(() => { (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).click(); });

    await act(async () => {
      pending[0].resolve(failureResponse("save boom"));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.getByText("save boom")).toBeInTheDocument());
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");

    act(() => { (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(2);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(true);
    await act(async () => {
      pending[1].resolve(successResponse("retry"));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" }))
      .not.toBeInTheDocument());
  });

  it("revokes a pending save before a stored tab change and suppresses its late reset", async () => {
    render(<TableParsePanel />, { wrapper });
    act(() => { (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).click(); });
    expect(pending).toHaveLength(1);
    const revisionA = useParseFlowStore.getState().parseOperations.table.revision;

    act(() => { (screen.getByRole("button", { name: "All Tables" }) as HTMLButtonElement).click(); });
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: revisionA + 1,
      busy: false,
    });
    expect(useParseFlowStore.getState().tableParseTab).toBe("all");
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("A");

    await act(async () => {
      pending[0].resolve(successResponse("late-tab-A"));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("A");
  });

  it("revokes a pending review save before opening the Compare modal", async () => {
    render(<TableParsePanel />, { wrapper });
    act(() => { (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).click(); });
    const revisionA = useParseFlowStore.getState().parseOperations.table.revision;

    act(() => {
      const compareButtons = screen.getAllByRole("button", { name: "Compare/Edit Cells" });
      (compareButtons[compareButtons.length - 1] as HTMLButtonElement).click();
    });
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: revisionA + 1,
      busy: false,
    });
    expect(useUiStore.getState().showTableCompareModal).toBe(true);

    await act(async () => {
      pending[0].resolve(successResponse("late-modal-A"));
      await flushCompletion();
    });
    expect(useUiStore.getState().showTableCompareModal).toBe(true);
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("A");
  });

  it("revokes a current token before a retained row seeds the B modal workspace", async () => {
    queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
      ...EMPTY_ACTIVE_PAGE_WINDOW,
      pageIntelligence: {
        [PAGE]: {
          parsedRegions: [{
            id: "retained-B",
            type: "schedule",
            bbox: BBOX,
            csiTags: [],
            data: grid("B"),
          }],
        },
      },
    });
    act(() => {
      useParseFlowStore.setState({
        tableParseTab: "all",
        tableParseStep: "idle",
        tableParseRegion: null,
        tableParsedGrid: null,
      });
    });
    const started = useParseFlowStore.getState().beginParseOperation("table");
    if (started.status !== "started") throw new Error("could not seed retained-row token A");
    const tokenA = started.token;
    // P2.5 deliberately preserves this presentation preference across project switches. Opening a
    // retained row must be idempotent when the flag survived true but the reset cleared its grid.
    useUiStore.setState({ showTableCompareModal: true });

    render(<TableParsePanel />, { wrapper });
    const expander = await screen.findByRole("button", { name: "▶" });
    act(() => { (expander as HTMLButtonElement).click(); });
    const edit = await screen.findByRole("button", { name: "View / Edit" });
    act(() => { (edit as HTMLButtonElement).click(); });

    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: tokenA.revision + 1,
      busy: false,
    });
    expect(useParseFlowStore.getState().tableParseRegion).toEqual(BBOX);
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("B");
    expect(useUiStore.getState().showTableCompareModal).toBe(true);

    expect(commitParseOperation(tokenA, () => {
      useParseFlowStore.getState().setTableParsedGrid(grid("STALE-A"));
    })).toBe(false);
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("B");
  });
});
