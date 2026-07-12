// @vitest-environment jsdom
// [refactor jul12 P2.4 A2c] Keynote proposal supersession, latest-input, and stale-finally witness.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import KeynotePanel from "@/components/viewer/KeynotePanel";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PUBLIC_ID = "keynote-proposal-project";
const PAGE = 3;

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

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

let queryClient: QueryClient;
let pending: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pending = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/table-parse/propose") {
      throw new Error(`unexpected Keynote proposal request: ${String(url)}`);
    }
    const request = deferred<Response>();
    pending.push(request);
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);

  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    keynoteParseTab: "guided",
    keynoteParseStep: "idle",
    keynoteParseRegion: [0.1, 0.2, 0.8, 0.9],
    guidedParseActive: false,
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

describe("A2c Guided Keynote proposal authority", () => {
  it("denies the request when its first shared seed synchronously hands authority to B", () => {
    render(<KeynotePanel embedded />, { wrapper });
    let armed = true;
    const replacementRegion = [0.2, 0.3, 0.9, 0.95] as [number, number, number, number];
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (!armed || state.guidedParseRegion === previous.guidedParseRegion) return;
      armed = false;
      state.invalidateParseOperation("keynote");
      const started = useParseFlowStore.getState().beginParseOperation("keynote");
      if (started.status !== "started") throw new Error("shared-seed subscriber could not start B");
      useParseFlowStore.setState({ guidedParseRegion: replacementRegion });
    });

    try {
      fireEvent.click(screen.getByRole("button", { name: "Propose Grid (2-col Keynote)" }));
      expect(pending).toHaveLength(0);
      expect(useParseFlowStore.getState().guidedParseRegion).toEqual(replacementRegion);
      expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(true);
      expect(screen.queryByText("Proposing grid...")).not.toBeInTheDocument();
    } finally {
      unsubscribe();
    }
  });

  it("revokes Table and Notes before its first shared-grid publication", () => {
    const table = useParseFlowStore.getState().beginParseOperation("table");
    const notes = useParseFlowStore.getState().beginParseOperation("notes");
    expect(table.status).toBe("started");
    expect(notes.status).toBe("started");
    const snapshots: Array<ReturnType<typeof useParseFlowStore.getState>> = [];
    const unsubscribe = useParseFlowStore.subscribe((state) => snapshots.push(state));

    try {
      render(<KeynotePanel embedded />, { wrapper });
      fireEvent.click(screen.getByRole("button", { name: "Propose Grid (2-col Keynote)" }));

      expect(pending).toHaveLength(1);
      const peersRevoked = snapshots.findIndex((state) =>
        state.parseOperations.keynote.busy &&
        !state.parseOperations.table.busy &&
        !state.parseOperations.notes.busy
      );
      const sharedSeed = snapshots.findIndex((state) => state.guidedParseRegion !== null);
      expect(peersRevoked).toBeGreaterThanOrEqual(0);
      expect(sharedSeed).toBeGreaterThan(peersRevoked);
      expect(snapshots[peersRevoked].guidedParseRegion).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it("rechecks between rows, columns, and active publications against a synchronous B", async () => {
    render(<KeynotePanel embedded />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Propose Grid (2-col Keynote)" }));
    expect(pending).toHaveLength(1);

    let armed = true;
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (armed && state.guidedParseRows !== previous.guidedParseRows) {
        armed = false;
        state.invalidateParseOperation("keynote");
        const started = useParseFlowStore.getState().beginParseOperation("keynote");
        if (started.status !== "started") throw new Error("rows subscriber could not start B");
        useParseFlowStore.setState({
          guidedParseCols: [0.2, 0.8],
          guidedParseActive: false,
        });
      }
    });

    try {
      await act(async () => {
        pending[0].resolve(proposalResponse(7));
        await flushCompletion();
      });

      expect(useParseFlowStore.getState().guidedParseRows).toEqual([7, 7.1, 7.2]);
      expect(useParseFlowStore.getState().guidedParseCols).toEqual([0.2, 0.8]);
      expect(useParseFlowStore.getState().guidedParseActive).toBe(false);
      expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("sends the new tuning value, supersedes A with B, and ignores reverse A settlement", async () => {
    const view = render(<KeynotePanel embedded />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Propose Grid (2-col Keynote)" }));
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0].resolve(proposalResponse(1));
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().guidedParseRows)
      .toEqual([1, 1.1, 1.2]));
    expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Tune Detection/ }));
    const rowTolerance = view.container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(rowTolerance).not.toBeNull();

    fireEvent.change(rowTolerance, { target: { value: "0.010" } });
    expect(pending).toHaveLength(2);
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)).gridOptions)
      .toMatchObject({ rowTolerance: 0.01 });
    const revisionA = useParseFlowStore.getState().parseOperations.keynote.revision;

    fireEvent.change(rowTolerance, { target: { value: "0.011" } });
    expect(pending).toHaveLength(3);
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body)).gridOptions)
      .toMatchObject({ rowTolerance: 0.011 });
    const tokenB = { ...useParseFlowStore.getState().parseOperations.keynote };
    expect(tokenB.revision).toBeGreaterThan(revisionA);
    expect(tokenB.busy).toBe(true);
    expect(screen.getByText("Proposing grid...")).toBeInTheDocument();

    await act(async () => {
      pending[1].resolve(proposalResponse(7));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().guidedParseRows).toEqual([1, 1.1, 1.2]);
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual(tokenB);
    expect(screen.getByText("Proposing grid...")).toBeInTheDocument();

    await act(async () => {
      pending[2].resolve(proposalResponse(9));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().guidedParseRows).toEqual([9, 9.1, 9.2]);
    expect(useParseFlowStore.getState().guidedParseCols).toEqual([9, 9.3, 9.6]);
    expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false);
    expect(screen.queryByText("Proposing grid...")).not.toBeInTheDocument();
  });
});
