// @vitest-environment jsdom
// [refactor jul12 P2.4 A2b] Debounced Guided proposal supersession and stale-finally witness.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import GuidedParseTab from "@/components/viewer/GuidedParseTab";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function proposalResponse(marker: number): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      proposedRows: [marker, marker + 0.1, marker + 0.2],
      proposedCols: [marker, marker + 0.3, marker + 0.6],
      rowCount: marker,
      colCount: marker + 1,
      confidence: 0.9,
    }),
  } as unknown as Response;
}

let queryClient: QueryClient;
let pending: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pending = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/table-parse/propose") {
      throw new Error(`unexpected Guided proposal request: ${String(url)}`);
    }
    const request = deferred<Response>();
    pending.push(request);
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);

  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: "guided-project",
    isDemo: false,
    pageNumber: 3,
    tableParseTab: "guided",
    tableParseRegion: [0.1, 0.2, 0.8, 0.9],
    guidedParseActive: false,
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("A2b Guided Table proposal authority", () => {
  it("invalidates A immediately on tuning, supersedes with B, and ignores reverse A settlement", async () => {
    const view = render(
      <GuidedParseTab
        detectCsiAndPersist={vi.fn(async () => true)}
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
      />,
      { wrapper },
    );

    expect(pending).toHaveLength(1);
    await act(async () => {
      pending[0].resolve(proposalResponse(1));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().guidedParseRows).toEqual([1, 1.1, 1.2]);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Tune Detection/ }));
    const rowTolerance = view.container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(rowTolerance).not.toBeNull();

    // First tuning change schedules proposal A.
    fireEvent.change(rowTolerance, { target: { value: "0.010" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(pending).toHaveLength(2);
    const revisionA = useParseFlowStore.getState().parseOperations.table.revision;
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(true);

    // Second tuning change revokes A synchronously, before B's debounce timer fires.
    fireEvent.change(rowTolerance, { target: { value: "0.011" } });
    expect(useParseFlowStore.getState().parseOperations.table).toMatchObject({
      revision: revisionA + 1,
      busy: false,
    });
    expect(screen.queryByText("Proposing grid...")).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(pending).toHaveLength(3);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.table };
    expect(tokenB.busy).toBe(true);
    expect(screen.getByText("Proposing grid...")).toBeInTheDocument();

    // Abort-ignoring A resolves while B owns the lane. It cannot replace the initial grid or clear
    // B's revision-derived proposing phase through its stale finally.
    await act(async () => {
      pending[1].resolve(proposalResponse(7));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().guidedParseRows).toEqual([1, 1.1, 1.2]);
    expect(useParseFlowStore.getState().parseOperations.table).toEqual(tokenB);
    expect(screen.getByText("Proposing grid...")).toBeInTheDocument();

    await act(async () => {
      pending[2].resolve(proposalResponse(9));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().guidedParseRows).toEqual([9, 9.1, 9.2]);
    expect(useParseFlowStore.getState().guidedParseCols).toEqual([9, 9.3, 9.6]);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
    expect(screen.queryByText("Proposing grid...")).not.toBeInTheDocument();
    expect(screen.getByText(/9 rows × 10 cols/)).toBeInTheDocument();
  });
});
