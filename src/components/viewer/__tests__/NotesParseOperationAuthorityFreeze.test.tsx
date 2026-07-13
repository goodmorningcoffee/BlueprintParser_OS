// @vitest-environment jsdom
// [refactor jul12 P2.4 A2d] Real Notes Auto/inherited-save operation authority witnesses.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NotesParser from "@/components/viewer/NotesParser";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readPageIntelligence } from "@/queries/usePageWindow";
import {
  clearYoloTagsProject,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PUBLIC_ID = "notes-operation-project";
const PAGE = 4;
const BBOX_A = [0.1, 0.2, 0.7, 0.8] as [number, number, number, number];
const BBOX_B = [0.2, 0.25, 0.8, 0.85] as [number, number, number, number];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function autoResponse(marker: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      headers: ["Key", "Note"],
      rows: [{ Key: marker, Note: `${marker} note` }],
      csiTags: [],
    }),
  } as unknown as Response;
}

function promotionResponse(marker: string): Response {
  const parsedRegion = {
    id: `notes-${marker}`,
    type: "notes",
    category: `${marker} notes`,
    bbox: BBOX_A,
    confidence: 0.97,
    csiTags: [],
    data: {
      headers: ["Key", "Note"],
      rows: [{ Key: marker, Note: `${marker} note` }],
      tableName: `${marker} notes`,
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

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 18; index += 1) await Promise.resolve();
}

let queryClient: QueryClient;
let autoParses: Deferred<Response>[];
let promotions: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedRegion(region = BBOX_A): void {
  useParseFlowStore.setState({
    notesParseStep: "idle",
    notesParseRegion: [...region] as typeof region,
  });
}

function autoButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Run Auto-Parse" }) as HTMLButtonElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save Notes" }) as HTMLButtonElement;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  autoParses = [];
  promotions = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url === "/api/notes-parse") {
      const request = deferred<Response>();
      autoParses.push(request);
      return request.promise;
    }
    if (url === "/api/regions/promote") {
      const request = deferred<Response>();
      promotions.push(request);
      return request.promise;
    }
    throw new Error(`unexpected Notes operation request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  resetProjectData();
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
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), {
    lines: [],
    words: [
      { text: "Key", confidence: 99, bbox: [0.15, 0.25, 0.1, 0.05] },
      { text: "Note", confidence: 99, bbox: [0.5, 0.25, 0.15, 0.05] },
    ],
  });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  seedRegion();
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2d Notes Auto and inherited-save operation authority", () => {
  it("rejects a same-turn duplicate Auto root before a second request or revision", () => {
    const beforeRevision = useParseFlowStore.getState().parseOperations.notes.revision;
    render(<NotesParser />, { wrapper });
    const parse = autoButton();

    act(() => {
      parse.click();
      parse.click();
    });

    expect(autoParses).toHaveLength(1);
    expect(useParseFlowStore.getState().parseOperations.notes).toEqual({
      revision: beforeRevision + 1,
      busy: true,
    });
  });

  it("keeps one Auto revision busy through its inherited promotion without a child begin", async () => {
    const beforeRevision = useParseFlowStore.getState().parseOperations.notes.revision;
    render(<NotesParser />, { wrapper });
    act(() => { autoButton().click(); });
    const admitted = { revision: beforeRevision + 1, busy: true };
    expect(useParseFlowStore.getState().parseOperations.notes).toEqual(admitted);

    await act(async () => {
      autoParses[0].resolve(autoResponse("A"));
      await flushCompletion();
    });

    expect(promotions).toHaveLength(1);
    // A nested begin would either reject the save or advance the revision; an outer premature finish
    // would expose busy:false while the captured promotion is still pending.
    expect(useParseFlowStore.getState().parseOperations.notes).toEqual(admitted);

    await act(async () => {
      promotions[0].resolve(promotionResponse("server-A"));
      await flushCompletion();
    });

    await waitFor(() => expect(useParseFlowStore.getState().notesParseRegion).toBeNull());
    expect(useParseFlowStore.getState().parseOperations.notes.busy).toBe(false);
    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.rejectedTextRegionIds)
      .toEqual(["server-A"]);
  });

  it("drops stale A parse output before it can preview or dispatch a promotion behind B", async () => {
    render(<NotesParser />, { wrapper });
    act(() => { autoButton().click(); });
    expect(autoParses).toHaveLength(1);

    let tokenB!: { kind: "notes"; revision: number };
    act(() => {
      useParseFlowStore.getState().resetNotesParse();
      seedRegion(BBOX_B);
      const started = useParseFlowStore.getState().beginParseOperation("notes");
      if (started.status !== "started") throw new Error("could not admit Notes B");
      tokenB = started.token;
    });

    await act(async () => {
      autoParses[0].resolve(autoResponse("STALE-A"));
      await flushCompletion();
    });

    expect(promotions).toHaveLength(0);
    expect(useParseFlowStore.getState().parseOperations.notes).toEqual({
      revision: tokenB.revision,
      busy: true,
    });
    expect(useParseFlowStore.getState().notesParseRegion).toEqual(BBOX_B);
    expect(screen.queryByText("STALE-A")).not.toBeInTheDocument();
  });

  it("allows captured A promotion adoption but cannot reset B or erase B's live error", async () => {
    render(<NotesParser />, { wrapper });
    act(() => { autoButton().click(); });
    await act(async () => {
      autoParses[0].resolve(autoResponse("A"));
      await flushCompletion();
    });
    expect(promotions).toHaveLength(1);

    act(() => {
      useParseFlowStore.getState().resetNotesParse();
      seedRegion(BBOX_B);
    });
    await waitFor(() => expect(autoButton()).toBeEnabled());
    act(() => { autoButton().click(); });
    expect(autoParses).toHaveLength(2);

    await act(async () => {
      autoParses[1].resolve(failureResponse("B live error"));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.getByText("B live error")).toBeInTheDocument());
    const afterBFailure = { ...useParseFlowStore.getState().parseOperations.notes };
    expect(afterBFailure.busy).toBe(false);
    expect(useParseFlowStore.getState().notesParseRegion).toEqual(BBOX_B);

    await act(async () => {
      promotions[0].resolve(promotionResponse("captured-A"));
      await flushCompletion();
    });

    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.rejectedTextRegionIds)
      .toEqual(["captured-A"]);
    expect(useParseFlowStore.getState().parseOperations.notes).toEqual(afterBFailure);
    expect(useParseFlowStore.getState().notesParseRegion).toEqual(BBOX_B);
    expect(screen.getByText("B live error")).toBeInTheDocument();
  });

  it("releases a current inherited-save failure and admits a direct Save Notes retry", async () => {
    render(<NotesParser />, { wrapper });
    act(() => { autoButton().click(); });
    await act(async () => {
      autoParses[0].resolve(autoResponse("retryable"));
      await flushCompletion();
    });
    expect(promotions).toHaveLength(1);

    await act(async () => {
      promotions[0].resolve(failureResponse("current save boom"));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.getByText("current save boom")).toBeInTheDocument());
    expect(useParseFlowStore.getState().parseOperations.notes.busy).toBe(false);
    expect(useParseFlowStore.getState().notesParseRegion).toEqual(BBOX_A);
    expect(saveButton()).toBeEnabled();
    const failedRevision = useParseFlowStore.getState().parseOperations.notes.revision;

    act(() => { saveButton().click(); });
    expect(promotions).toHaveLength(2);
    expect(autoParses).toHaveLength(1);
    expect(useParseFlowStore.getState().parseOperations.notes).toEqual({
      revision: failedRevision + 1,
      busy: true,
    });

    await act(async () => {
      promotions[1].resolve(promotionResponse("retry-success"));
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().notesParseRegion).toBeNull());
    expect(useParseFlowStore.getState().parseOperations.notes.busy).toBe(false);
  });

  it("rechecks after a direct Guided draft publication before dispatching persistence", async () => {
    render(<NotesParser />, { wrapper });
    act(() => {
      (screen.getByRole("button", { name: "Guided" }) as HTMLButtonElement).click();
    });
    act(() => {
      useParseFlowStore.setState({
        guidedParseRows: [0.2, 0.5],
        guidedParseCols: [0.1, 0.4, 0.8],
      });
    });

    let tokenB!: { kind: "notes"; revision: number };
    let armed = true;
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (!armed || state.parseDraftRegion === previous.parseDraftRegion || !state.parseDraftRegion) {
        return;
      }
      armed = false;
      state.invalidateParseOperation("notes");
      seedRegion(BBOX_B);
      const started = useParseFlowStore.getState().beginParseOperation("notes");
      if (started.status !== "started") throw new Error("could not start Guided subscriber B");
      tokenB = started.token;
    });

    try {
      act(() => {
        (screen.getByRole("button", { name: "Extract Grid" }) as HTMLButtonElement).click();
      });
      expect(promotions).toHaveLength(0);
      expect(useParseFlowStore.getState().parseOperations.notes).toEqual({
        revision: tokenB.revision,
        busy: true,
      });
      expect(useParseFlowStore.getState().notesParseRegion).toEqual(BBOX_B);
    } finally {
      unsubscribe();
    }
  });
});
