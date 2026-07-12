// @vitest-environment jsdom
// [refactor jul12 P2.4 A2b] Auto/Manual/Guided one-outer-token composition witnesses.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { commitParseOperation } from "@/hooks/useParseOperation";
import type { ParseOperationToken } from "@/lib/parse-operation-state";
import { queryKeys } from "@/queries/queryKeys";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";
import type { DetectCsiAndPersist, TablePersistOptions } from "../table-operation-types";

vi.mock("@/lib/ocr-grid-detect", () => ({
  extractCellsFromGrid: vi.fn(() => ({
    headers: ["Tag", "Description"],
    rows: [{ Tag: "G1", Description: "Guided door" }],
  })),
}));

import AutoParseTab from "../AutoParseTab";
import GuidedParseTab from "../GuidedParseTab";
import ManualParseTab from "../ManualParseTab";

const BBOX = [0.1, 0.1, 0.8, 0.8] as [number, number, number, number];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

let queryClient: QueryClient;
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function commonProps() {
  return {
    yoloInTableRegion: [],
    tagYoloClass: null,
    setTagYoloClass: vi.fn(),
    handleMapTags: vi.fn(),
    tagMappingDone: false,
    tagMappingCount: 0,
    setTagMappingDone: vi.fn(),
    mapTagsStrictness: "balanced" as const,
    setMapTagsStrictness: vi.fn(),
    drawingNumberPrefixes: [],
    setDrawingNumberPrefixes: vi.fn(),
    availablePrefixes: [],
    lastDropCounts: null,
  };
}

function inheritedSaveHarness(wait: Deferred<void>) {
  return vi.fn<DetectCsiAndPersist>(async (
    _grid,
    options?: TablePersistOptions,
    token?: ParseOperationToken<"table">,
  ) => {
    if (!token) throw new Error("composed Table save did not inherit its root token");
    await wait.promise;
    return commitParseOperation(token, () => {
      if (options?.resetAfter !== false) useParseFlowStore.getState().resetTableParse();
      options?.onAuthorizedSuccess?.();
    });
  });
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: "composition-project",
    isDemo: false,
    pageNumber: 1,
    tableParseTab: "auto",
  });
  queryClient.setQueryData(queryKeys.textract.page("composition-project", 1), {
    lines: [],
    words: [{ text: "D1", confidence: 99, bbox: [0.1, 0.1, 0.1, 0.1] }],
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2b composed Table roots reuse one outer token", () => {
  it("Auto publishes review under its root token and passes that token through nested save", async () => {
    const save = deferred<void>();
    const detectCsiAndPersist = inheritedSaveHarness(save);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        headers: ["Tag", "Description"],
        rows: [{ Tag: "A1", Description: "Auto door" }],
        tagColumn: "Tag",
        methods: [],
        methodResults: [],
        infraErrors: [],
      }),
    } as unknown as Response);
    useParseFlowStore.setState({ tableParseRegion: BBOX, tableParseTab: "auto" });
    const before = useParseFlowStore.getState().parseOperations.table.revision;

    render(
      <AutoParseTab
        autoDetectedTables={[]}
        existingParsed={[]}
        loadExistingParsed={vi.fn()}
        detectCsiAndPersist={detectCsiAndPersist}
        invalidateTableOperation={() => useParseFlowStore.getState().invalidateParseOperation("table")}
        {...commonProps()}
      />,
      { wrapper },
    );
    const process = await screen.findByRole("button", { name: "Process Region" });
    fireEvent.click(process);

    await waitFor(() => expect(detectCsiAndPersist).toHaveBeenCalledTimes(1));
    const token = detectCsiAndPersist.mock.calls[0][2] as ParseOperationToken<"table">;
    expect(token.revision).toBe(before + 1);
    expect(useParseFlowStore.getState().parseOperations.table).toEqual({
      revision: token.revision,
      busy: true,
    });
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Tag).toBe("A1");

    await act(async () => { save.resolve(); });
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false));
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
  });

  it("Auto stops before nested persistence when tool-first review entry revokes its token", async () => {
    const detectCsiAndPersist = vi.fn<DetectCsiAndPersist>(async () => true);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        headers: ["Tag"],
        rows: [{ Tag: "A1" }],
        tagColumn: "Tag",
        methods: [],
        methodResults: [],
        infraErrors: [],
      }),
    } as unknown as Response);
    useParseFlowStore.setState({ tableParseRegion: BBOX, tableParseTab: "auto" });
    const unsubscribeTool = useToolStore.subscribe(() => {
      useParseFlowStore.getState().invalidateParseOperation("table");
    });

    try {
      render(
        <AutoParseTab
          autoDetectedTables={[]}
          existingParsed={[]}
          loadExistingParsed={vi.fn()}
          detectCsiAndPersist={detectCsiAndPersist}
          invalidateTableOperation={() => useParseFlowStore.getState().invalidateParseOperation("table")}
          {...commonProps()}
        />,
        { wrapper },
      );
      fireEvent.click(await screen.findByRole("button", { name: "Process Region" }));

      await waitFor(() => expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false));
      expect(detectCsiAndPersist).not.toHaveBeenCalled();
      expect(useParseFlowStore.getState().tableParseStep).toBe("idle");
    } finally {
      unsubscribeTool();
    }
  });

  it("Manual publishes its exact grid and nested save under one root revision", async () => {
    const save = deferred<void>();
    const detectCsiAndPersist = inheritedSaveHarness(save);
    useParseFlowStore.setState({
      tableParseTab: "manual",
      tableParseRegion: BBOX,
      tableParseColumnBBs: [[0, 0, 0.5, 1]],
      tableParseColumnNames: ["Tag"],
      tableParseRowBBs: [[0, 0, 1, 0.5]],
    });
    const before = useParseFlowStore.getState().parseOperations.table.revision;

    render(
      <ManualParseTab detectCsiAndPersist={detectCsiAndPersist} {...commonProps()} />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: /Parse Table/ }));
    await waitFor(() => expect(detectCsiAndPersist).toHaveBeenCalledTimes(1));

    const token = detectCsiAndPersist.mock.calls[0][2] as ParseOperationToken<"table">;
    expect(token.revision).toBe(before + 1);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(true);
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");
    expect(useParseFlowStore.getState().tableParsedGrid).toMatchObject({
      headers: ["Tag"],
      rows: [{ Tag: "D1" }],
    });

    await act(async () => { save.resolve(); });
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false));
  });

  it("Guided proposal finishes, then parse reuses one fresh token through its success tail", async () => {
    const save = deferred<void>();
    const detectCsiAndPersist = inheritedSaveHarness(save);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        proposedRows: [0.1, 0.4, 0.8],
        proposedCols: [0.1, 0.4, 0.8],
        rowCount: 2,
        colCount: 2,
        confidence: 0.9,
      }),
    } as unknown as Response);
    useParseFlowStore.setState({
      tableParseTab: "guided",
      tableParseRegion: BBOX,
      guidedParseActive: false,
    });

    render(
      <GuidedParseTab detectCsiAndPersist={detectCsiAndPersist} {...commonProps()} />,
      { wrapper },
    );
    const parse = await screen.findByRole("button", { name: "Parse Grid" });
    const before = useParseFlowStore.getState().parseOperations.table.revision;
    fireEvent.click(parse);
    await waitFor(() => expect(detectCsiAndPersist).toHaveBeenCalledTimes(1));

    const token = detectCsiAndPersist.mock.calls[0][2] as ParseOperationToken<"table">;
    expect(token.revision).toBe(before + 1);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(true);
    expect(useParseFlowStore.getState().tableParseStep).toBe("review");

    await act(async () => { save.resolve(); });
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false));
    expect(useParseFlowStore.getState().guidedParseActive).toBe(false);
    expect(useToolStore.getState().mode).toBe("move");
  });
});
