// @vitest-environment jsdom
// [refactor jul12 P2.4 A2d] Real Notes Guided proposal supersession/ordering witnesses.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NotesParser from "@/components/viewer/NotesParser";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PUBLIC_ID = "notes-proposal-project";
const PAGE = 5;
const REGION = [0.1, 0.2, 0.8, 0.9] as [number, number, number, number];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type ProposalDispatchSnapshot = {
  operations: {
    table: { revision: number; busy: boolean };
    keynote: { revision: number; busy: boolean };
    notes: { revision: number; busy: boolean };
  };
  rows: number[];
  cols: number[];
};

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
    }),
  } as unknown as Response;
}

function failureResponse(): Response {
  return {
    ok: false,
    status: 500,
    json: vi.fn().mockResolvedValue({
      error: { code: "FAIL", message: "proposal transport failed" },
    }),
  } as unknown as Response;
}

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 14; index += 1) await Promise.resolve();
}

let queryClient: QueryClient;
let pending: Deferred<Response>[];
let dispatchSnapshots: ProposalDispatchSnapshot[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function proposalButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Propose Grid" }) as HTMLButtonElement;
}

function renderGuided(): HTMLButtonElement {
  render(<NotesParser />, { wrapper });
  fireEvent.click(screen.getByRole("button", { name: "Guided" }));
  return proposalButton();
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  pending = [];
  dispatchSnapshots = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url !== "/api/notes-parse/propose") {
      throw new Error(`unexpected Notes proposal request: ${String(url)}`);
    }
    const state = useParseFlowStore.getState();
    dispatchSnapshots.push({
      operations: {
        table: { ...state.parseOperations.table },
        keynote: { ...state.parseOperations.keynote },
        notes: { ...state.parseOperations.notes },
      },
      rows: [...state.guidedParseRows],
      cols: [...state.guidedParseCols],
    });
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
    numPages: PAGE,
  });
  useParseFlowStore.setState({
    notesParseStep: "idle",
    notesParseRegion: [...REGION],
  });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
  });
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), {
    lines: [],
    words: [],
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2d Notes Guided proposal authority", () => {
  it("supersedes same-turn A with B and keeps Proposing tied to B through stale A settlement", async () => {
    const propose = renderGuided();
    act(() => {
      useParseFlowStore.setState({
        guidedParseRows: [0.2, 0.8],
        guidedParseCols: [0.25, 0.75],
      });
    });
    const beforeRevision = useParseFlowStore.getState().parseOperations.notes.revision;

    act(() => {
      propose.click();
      propose.click();
    });

    expect(pending).toHaveLength(2);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.notes };
    expect(tokenB).toEqual({ revision: beforeRevision + 2, busy: true });
    expect(screen.getByText("Proposing…")).toBeInTheDocument();

    // A is now stale. Its response and finally cannot replace the pre-proposal grid or clear B's
    // revision-derived phase while the latest request is still pending.
    await act(async () => {
      pending[0].resolve(proposalResponse(7));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().guidedParseRows).toEqual([0.2, 0.8]);
    expect(useParseFlowStore.getState().guidedParseCols).toEqual([0.25, 0.75]);
    expect(useParseFlowStore.getState().parseOperations.notes).toEqual(tokenB);
    expect(screen.getByText("Proposing…")).toBeInTheDocument();

    await act(async () => {
      pending[1].resolve(proposalResponse(9));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().guidedParseRows).toEqual([9, 9.1, 9.2]);
    expect(useParseFlowStore.getState().guidedParseCols).toEqual([9, 9.3, 9.6]);
    expect(useParseFlowStore.getState().parseOperations.notes.busy).toBe(false);
    expect(screen.queryByText("Proposing…")).not.toBeInTheDocument();
  });

  it("revokes Table and Keynote before the Notes request and eventual shared-grid seed", () => {
    const propose = renderGuided();
    act(() => {
      useParseFlowStore.setState({
        guidedParseRows: [0.15, 0.85],
        guidedParseCols: [0.2, 0.8],
      });
      const table = useParseFlowStore.getState().beginParseOperation("table");
      const keynote = useParseFlowStore.getState().beginParseOperation("keynote");
      if (table.status !== "started" || keynote.status !== "started") {
        throw new Error("could not seed Notes proposal peer owners");
      }
    });

    act(() => { propose.click(); });

    expect(pending).toHaveLength(1);
    expect(dispatchSnapshots).toHaveLength(1);
    expect(dispatchSnapshots[0].operations.table.busy).toBe(false);
    expect(dispatchSnapshots[0].operations.keynote.busy).toBe(false);
    expect(dispatchSnapshots[0].operations.notes.busy).toBe(true);
    expect(dispatchSnapshots[0].rows).toEqual([0.15, 0.85]);
    expect(dispatchSnapshots[0].cols).toEqual([0.2, 0.8]);
  });

  it("rechecks after a rows subscriber starts Notes B and blocks stale A columns", async () => {
    const propose = renderGuided();
    act(() => { propose.click(); });
    expect(pending).toHaveLength(1);

    const bCols = [0.22, 0.78];
    let tokenB!: { kind: "notes"; revision: number };
    let armed = true;
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (!armed || state.guidedParseRows === previous.guidedParseRows) return;
      armed = false;
      state.invalidateParseOperation("notes");
      const started = useParseFlowStore.getState().beginParseOperation("notes");
      if (started.status !== "started") throw new Error("rows subscriber could not start Notes B");
      tokenB = started.token;
      useParseFlowStore.setState({ guidedParseCols: bCols });
    });

    try {
      await act(async () => {
        pending[0].resolve(proposalResponse(6));
        await flushCompletion();
      });

      expect(useParseFlowStore.getState().guidedParseRows).toEqual([6, 6.1, 6.2]);
      expect(useParseFlowStore.getState().guidedParseCols).toEqual(bCols);
      expect(useParseFlowStore.getState().parseOperations.notes).toEqual({
        revision: tokenB.revision,
        busy: true,
      });
    } finally {
      unsubscribe();
    }
  });

  it("surfaces current failure, releases authority, and admits a successful retry", async () => {
    const propose = renderGuided();
    act(() => { propose.click(); });
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0].resolve(failureResponse());
      await flushCompletion();
    });
    await waitFor(() => expect(screen.getByText("Propose failed")).toBeInTheDocument());
    expect(useParseFlowStore.getState().parseOperations.notes.busy).toBe(false);
    expect(proposalButton()).toBeEnabled();
    const failedRevision = useParseFlowStore.getState().parseOperations.notes.revision;

    act(() => { proposalButton().click(); });
    expect(pending).toHaveLength(2);
    expect(useParseFlowStore.getState().parseOperations.notes).toEqual({
      revision: failedRevision + 1,
      busy: true,
    });
    expect(screen.queryByText("Propose failed")).not.toBeInTheDocument();

    await act(async () => {
      pending[1].resolve(proposalResponse(4));
      await flushCompletion();
    });
    expect(useParseFlowStore.getState().guidedParseRows).toEqual([4, 4.1, 4.2]);
    expect(useParseFlowStore.getState().guidedParseCols).toEqual([4, 4.3, 4.6]);
    expect(useParseFlowStore.getState().parseOperations.notes.busy).toBe(false);
  });
});
