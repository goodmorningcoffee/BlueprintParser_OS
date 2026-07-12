// @vitest-environment jsdom
// [refactor jul12 P2.4 A2c] Real Keynote duplicate, stale, retry, reentrant, and handoff witnesses.

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import KeynotePanel from "@/components/viewer/KeynotePanel";
import { commitParseOperation, type ParseOperationToken } from "@/hooks/useParseOperation";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { clearYoloTagsProject, seedYoloTagsFromBootstrap } from "@/queries/useYoloTags";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PUBLIC_ID = "keynote-operation-project";
const PAGE = 4;
const BBOX_A = [0.1, 0.2, 0.7, 0.8] as [number, number, number, number];
const BBOX_B = [0.2, 0.25, 0.8, 0.85] as [number, number, number, number];
const COLS = [
  [0, 0, 0.4, 1],
  [0.4, 0, 1, 1],
] as [number, number, number, number][];
const ROWS = [[0, 0, 1, 1]] as [number, number, number, number][];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function successResponse(marker: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ok: true,
      parsedRegion: {},
      updatedIntelligence: { rejectedTextRegionIds: [marker] },
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

function mapResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      results: {},
      dropCounts: {},
      strictnessMode: "balanced",
    }),
  } as unknown as Response;
}

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

let queryClient: QueryClient;
let promotions: Deferred<Response>[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedManual(bbox = BBOX_A): void {
  useParseFlowStore.setState({
    keynoteParseTab: "manual",
    keynoteParseStep: "idle",
    keynoteParseRegion: bbox,
    keynoteColumnBBs: COLS.map((entry) => [...entry] as typeof entry),
    keynoteRowBBs: ROWS.map((entry) => [...entry] as typeof entry),
  });
}

function parseButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Parse Keynotes (1 entries)" }) as HTMLButtonElement;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  promotions = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown) => {
    if (url === "/api/regions/promote") {
      const request = deferred<Response>();
      promotions.push(request);
      return request.promise;
    }
    if (url === `/api/projects/${PUBLIC_ID}/map-tags-batch`) {
      return Promise.resolve(mapResponse());
    }
    throw new Error(`unexpected Keynote operation request: ${String(url)}`);
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
      { text: "K1", confidence: 99, bbox: [0.1, 0.1, 0.1, 0.1] },
      { text: "Door", confidence: 99, bbox: [0.55, 0.1, 0.1, 0.1] },
    ],
  });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
  seedManual();
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2c Keynote operation authority", () => {
  it("admits one same-turn Manual root and keeps nested save/map under that revision", () => {
    const before = useParseFlowStore.getState().parseOperations.keynote.revision;
    render(<KeynotePanel embedded />, { wrapper });
    const parse = parseButton();

    act(() => {
      parse.click();
      parse.click();
    });

    expect(promotions).toHaveLength(1);
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual({
      revision: before + 1,
      busy: true,
    });
    expect(useParseFlowStore.getState().parsedKeynoteData).toHaveLength(1);
  });

  it("suppresses stale A failure, exposes current B failure, and admits a successful B retry", async () => {
    render(<KeynotePanel embedded />, { wrapper });
    act(() => { parseButton().click(); });
    expect(promotions).toHaveLength(1);

    act(() => {
      useParseFlowStore.getState().resetKeynoteParse();
      seedManual(BBOX_B);
    });
    const parseB = await screen.findByRole("button", { name: "Parse Keynotes (1 entries)" });
    act(() => { (parseB as HTMLButtonElement).click(); });
    expect(promotions).toHaveLength(2);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.keynote };

    await act(async () => {
      promotions[0].resolve(failureResponse("stale A boom"));
      await flushCompletion();
    });
    expect(screen.queryByText("stale A boom")).not.toBeInTheDocument();
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual(tokenB);
    expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);

    await act(async () => {
      promotions[1].resolve(failureResponse("current B boom"));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.getByText("current B boom")).toBeInTheDocument());
    expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false);
    expect(parseButton()).toBeEnabled();

    act(() => { parseButton().click(); });
    expect(promotions).toHaveLength(3);
    await act(async () => {
      promotions[2].resolve(successResponse("retry-B"));
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().keynoteParseRegion).toBeNull());
    expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false);
  });

  it("rechecks after a synchronous parsed-keynote subscriber revokes the root", () => {
    render(<KeynotePanel embedded />, { wrapper });
    let armed = true;
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (!armed || state.parsedKeynoteData === previous.parsedKeynoteData) return;
      armed = false;
      state.invalidateParseOperation("keynote");
      seedManual(BBOX_B);
      useToolStore.getState().setMode("pointer");
    });

    try {
      act(() => { parseButton().click(); });
      expect(promotions).toHaveLength(0);
      expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);
      expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false);
      expect(useToolStore.getState().mode).toBe("pointer");
    } finally {
      unsubscribe();
    }
  });

  it("does not launch persistence after its optimistic Query write synchronously hands off", () => {
    render(<KeynotePanel embedded />, { wrapper });
    let armed = true;
    const activeKey = JSON.stringify(queryKeys.pagesWindow.active(PUBLIC_ID));
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        !armed ||
        event.type !== "updated" ||
        JSON.stringify(event.query.queryKey) !== activeKey
      ) return;
      const window = event.query.state.data as typeof EMPTY_ACTIVE_PAGE_WINDOW | undefined;
      if (!window?.pageIntelligence?.[PAGE]?.parsedRegions?.length) return;
      armed = false;
      useParseFlowStore.getState().invalidateParseOperation("keynote");
      seedManual(BBOX_B);
      useToolStore.getState().setMode("pointer");
    });

    try {
      act(() => { parseButton().click(); });
      expect(promotions).toHaveLength(0);
      expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);
      expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false);
      expect(useToolStore.getState().mode).toBe("pointer");
    } finally {
      unsubscribe();
    }
  });

  it("invalidates on unmount, admits B immediately, and blocks late A from launching map/reset", async () => {
    const view = render(<KeynotePanel embedded />, { wrapper });
    act(() => { parseButton().click(); });
    const tokenA = { ...useParseFlowStore.getState().parseOperations.keynote };
    expect(promotions).toHaveLength(1);

    view.unmount();
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual({
      revision: tokenA.revision + 1,
      busy: false,
    });
    seedManual(BBOX_B);
    render(<KeynotePanel embedded />, { wrapper });
    act(() => { parseButton().click(); });
    expect(promotions).toHaveLength(2);
    const tokenB = { ...useParseFlowStore.getState().parseOperations.keynote };

    await act(async () => {
      promotions[0].resolve(successResponse("late-A"));
      await flushCompletion();
    });
    expect(fetchMock.mock.calls.filter(([url]) =>
      url === `/api/projects/${PUBLIC_ID}/map-tags-batch`)).toHaveLength(0);
    expect(useParseFlowStore.getState().parseOperations.keynote).toEqual(tokenB);
    expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);

    await act(async () => {
      promotions[1].resolve(successResponse("current-B"));
      await flushCompletion();
    });
    await waitFor(() => expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false));
    expect(fetchMock.mock.calls.filter(([url]) =>
      url === `/api/projects/${PUBLIC_ID}/map-tags-batch`)).toHaveLength(1);
  });

  it("performs tool completion before the final reset so a reset subscriber's B is not moved by A", async () => {
    render(<KeynotePanel embedded />, { wrapper });
    act(() => { parseButton().click(); });
    expect(promotions).toHaveLength(1);

    let armed = true;
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (!armed || previous.keynoteParseRegion === null || state.keynoteParseRegion !== null) return;
      armed = false;
      seedManual(BBOX_B);
      const started = useParseFlowStore.getState().beginParseOperation("keynote");
      if (started.status !== "started") throw new Error("reset subscriber could not start B");
      useToolStore.getState().setMode("pointer");
    });

    try {
      await act(async () => {
        promotions[0].resolve(successResponse("A"));
        await flushCompletion();
      });
      expect(useParseFlowStore.getState().keynoteParseRegion).toEqual(BBOX_B);
      expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(true);
      expect(useToolStore.getState().mode).toBe("pointer");
    } finally {
      unsubscribe();
    }
  });

  it("revokes Keynote and Table owners before a retained Keynote seeds the modal workspace", async () => {
    queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
      ...EMPTY_ACTIVE_PAGE_WINDOW,
      pageIntelligence: {
        [PAGE]: {
          parsedRegions: [{
            id: "retained-keynote",
            type: "keynote",
            bbox: BBOX_B,
            data: {
              headers: ["Key", "Description"],
              rows: [{ Key: "B1", Description: "Retained B" }],
              tableName: "Retained B",
            },
          }],
        },
      },
    });
    useParseFlowStore.setState({
      keynoteParseTab: "all",
      parsedKeynoteData: [{
        pageNumber: PAGE,
        keys: [{ key: "B1", description: "Retained B" }],
        tableName: "Retained B",
      }],
    });
    render(<KeynotePanel embedded />, { wrapper });
    let keynoteToken!: ParseOperationToken<"keynote">;
    act(() => {
      const keynoteStarted = useParseFlowStore.getState().beginParseOperation("keynote");
      const tableStarted = useParseFlowStore.getState().beginParseOperation("table");
      if (keynoteStarted.status !== "started" || tableStarted.status !== "started") {
        throw new Error("could not seed retained-row operation owners");
      }
      keynoteToken = keynoteStarted.token;
    });

    act(() => { (screen.getByRole("button", { name: "▶" }) as HTMLButtonElement).click(); });
    const edit = await screen.findByRole("button", { name: "View / Edit" });
    act(() => { (edit as HTMLButtonElement).click(); });

    expect(useParseFlowStore.getState().parseOperations.keynote.busy).toBe(false);
    expect(useParseFlowStore.getState().parseOperations.table.busy).toBe(false);
    expect(useParseFlowStore.getState().tableParsedGrid?.rows[0].Key).toBe("B1");
    expect(commitParseOperation(keynoteToken, () => {
      useParseFlowStore.getState().setParsedKeynoteData(null);
    })).toBe(false);
  });
});
